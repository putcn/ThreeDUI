import { Matrix4 } from 'three'
import type { PanelInstance } from '@glassui/core'
import { InstanceBuffer } from '../instances'
import { instanceMatrix, writeClip, writeMatrixRows } from '../transform'
import { createQuadGeometry } from '../quad'
import { surfaceToLocal, type SurfaceDims } from '../units'
import { srgbToLinear } from '../color'

/**
 * Per-instance vec4 attributes of a panel: `iRect` (cx, cy, w, h; units), `iShape` (radius, border width; units,
 * cornerExponent, opacity), `iColor` and `iBorder` (linear rgb, a), then the matrix rows and the clip (transform.ts).
 */
export const PANEL_ATTRS = ['iRect', 'iShape', 'iColor', 'iBorder', 'iMat0', 'iMat1', 'iMat2', 'iClipRect', 'iClipInv', 'iClipT'] as const

/** `cornerExponent` for a flat shape: a capsule (radius = half the short side) is circular, otherwise Apple-continuous. */
export function cornerExponentFor(rect: { width: number; height: number }, radius: number): number {
  return radius >= Math.min(rect.width, rect.height) / 2 - 1e-6 ? 2 : 4.5
}

/** All solid panels (`bg` colour and/or border) of one Surface as instances of a unit quad, sorted far→near by `z`. */
export class PanelBatch {
  readonly geometry = createQuadGeometry()
  readonly buffer = new InstanceBuffer(this.geometry, PANEL_ATTRS)
  private m = new Matrix4()

  update(instances: readonly PanelInstance[], s: SurfaceDims): void {
    const sorted = [...instances].sort((a, b) => a.z - b.z)
    const b = this.buffer, ppu = s.ptPerUnit
    b.begin(sorted.length)
    sorted.forEach((p, i) => {
      const [cx, cy] = surfaceToLocal(p.rect.x + p.rect.width / 2, p.rect.y + p.rect.height / 2, s)
      b.set(i, 'iRect', cx, cy, p.rect.width / ppu, p.rect.height / ppu)
      b.set(i, 'iShape', p.radius / ppu, (p.border?.width ?? 0) / ppu, cornerExponentFor(p.rect, p.radius), p.opacity)
      b.set(i, 'iColor', srgbToLinear(p.color[0]), srgbToLinear(p.color[1]), srgbToLinear(p.color[2]), p.color[3])
      const bc = p.border?.color ?? [0, 0, 0, 0]
      b.set(i, 'iBorder', srgbToLinear(bc[0]), srgbToLinear(bc[1]), srgbToLinear(bc[2]), bc[3])
      writeMatrixRows(b, i, instanceMatrix(p, s, this.m))
      writeClip(b, i, p.clip)
    })
    b.commit()
  }

  dispose(): void { this.buffer.dispose() }
}
