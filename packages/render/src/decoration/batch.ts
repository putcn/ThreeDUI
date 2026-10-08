import { Matrix4 } from 'three'
import type { DecorationInstance } from '@glassui/core'
import { InstanceBuffer } from '../instances'
import { instanceMatrix, writeClip, writeMatrixRows } from '../transform'
import { createQuadGeometry } from '../quad'
import { surfaceToLocal, type SurfaceDims } from '../units'
import { srgbToLinear } from '../color'

/**
 * Per-instance vec4 attributes of a decoration: `iRect` (cx, cy, w, h; units), `iShape` (radius; units, strength, the
 * glass's cornerExponent, opacity), `iColor` (linear rgb, 1), then the matrix rows and the clip (transform.ts).
 */
export const DECOR_ATTRS = ['iRect', 'iShape', 'iColor', 'iMat0', 'iMat1', 'iMat2', 'iClipRect', 'iClipInv', 'iClipT'] as const
/** Pool inflation relative to the element height (the spike's +24 / +28 / 9 px at h = 84). */
export const POOL_INFLATE_X = 0.29, POOL_INFLATE_Y = 0.33, POOL_DROP = 0.11

const lifted = new Matrix4()

/**
 * One kind of glass decoration (`rim` or `pool`) of one Surface as instances of a unit quad, sorted far→near by `z`.
 * Rims are lifted by `lift(d)` pt along the instance's own z axis, so they lie on the glass's top face (the slab's top
 * is `iMat · (x, y, thickness)`) however the glass is tilted or scaled. Pools lie on the Surface plane (elevation 0,
 * no lift) under an inflated, lowered rect. Decorations with no area (a zero-height rect would still rasterise its AA
 * margin, with q.y / size.y = 0/0 on its centre line) or no strength × opacity are skipped.
 */
export class DecorationBatch {
  readonly geometry = createQuadGeometry()
  readonly buffer = new InstanceBuffer(this.geometry, DECOR_ATTRS)
  private m = new Matrix4()
  constructor(readonly kind: 'rim' | 'pool') {}

  update(instances: readonly DecorationInstance[], s: SurfaceDims, lift: (d: DecorationInstance) => number = () => 0): void {
    const visible = (d: DecorationInstance) => d.rect.width > 0 && d.rect.height > 0 && d.strength * d.opacity > 0
    const mine = instances.filter(d => d.kind === this.kind && visible(d)).sort((a, b) => a.z - b.z)
    const b = this.buffer, ppu = s.ptPerUnit
    b.begin(mine.length)
    mine.forEach((d, i) => {
      let rect = d.rect
      if (this.kind === 'pool') {
        const h = d.rect.height
        rect = { x: d.rect.x - POOL_INFLATE_X * h / 2, y: d.rect.y - POOL_INFLATE_Y * h / 2 + POOL_DROP * h, width: d.rect.width + POOL_INFLATE_X * h, height: d.rect.height + POOL_INFLATE_Y * h }
      }
      const [cx, cy] = surfaceToLocal(rect.x + rect.width / 2, rect.y + rect.height / 2, s)
      b.set(i, 'iRect', cx, cy, rect.width / ppu, rect.height / ppu)
      b.set(i, 'iShape', d.radius / ppu, d.strength, d.cornerExponent, d.opacity)
      b.set(i, 'iColor', srgbToLinear(d.color[0]), srgbToLinear(d.color[1]), srgbToLinear(d.color[2]), 1)
      const m = instanceMatrix({ ...d, rect, elevation: this.kind === 'pool' ? 0 : d.elevation }, s, this.m)
      if (this.kind === 'rim') m.multiply(lifted.makeTranslation(0, 0, lift(d) / ppu))
      writeMatrixRows(b, i, m)
      writeClip(b, i, d.clip)
    })
    b.commit()
  }

  dispose(): void { this.buffer.dispose() }
}
