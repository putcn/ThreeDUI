import { Matrix4, type InstancedBufferGeometry } from 'three'
import type { GlassInstance, Node } from '@glassui/core'
import { InstanceBuffer } from '../instances'
import { instanceMatrix, writeClip, writeMatrixRows } from '../transform'
import { createSlabBaseGeometry } from './slab9'
import { createFusedGeometry, type SlabMesh } from './fused'
import { surfaceToLocal, type SurfaceDims } from '../units'
import { srgbToLinear } from '../color'

/** Per-instance vec4 attributes of the glass slab (packing in the Task 8 table; all lengths in units, colours linear). */
export const GLASS_ATTRS = ['iRect', 'iShape', 'iCorner', 'iMat0', 'iMat1', 'iMat2', 'iOptics', 'iTint', 'iGlow', 'iGlow2', 'iTouch', 'iClipRect', 'iClipInv', 'iClipT'] as const
export const GLOW_SOFTNESS = 0.04
export const REFLECTION_STRENGTH = 0.2

export interface TouchState { u: number; v: number; press: number }

/**
 * The thinnest slab packed (pt). The refraction and the Beer–Lambert tint divide by the thickness, so a slab of 0 — a
 * style's `thickness: 0`, or a spring overshooting below it — would draw NaN (black) glass.
 */
export const MIN_THICKNESS = 0.01
/** `v` clamped to [lo, hi]; a non-finite `v` is `lo`. */
const clampPt = (v: number, lo: number, hi: number): number => Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo

/**
 * All glass elements of one Surface as instances of the shared slab geometry, sorted far→near by `z` — or, built from
 * `{ mesh }`, a fused slab (`extrudeSlab`, scaled to units and centred on its instance's rect) as the base geometry
 * instead of the 9-slice: `position`, `slabNormal` and an index in place of `slab`, `userData.vertex = 'mesh'`, the same
 * instance attributes and `update`.
 */
export class GlassBatch {
  readonly geometry: InstancedBufferGeometry
  readonly buffer: InstanceBuffer
  private sorted: Node[] = []
  private m = new Matrix4()

  constructor(K?: number, S?: number)
  constructor(base: { mesh: SlabMesh })
  constructor(base?: number | { mesh: SlabMesh }, S?: number) {
    this.geometry = typeof base === 'object' ? createFusedGeometry(base.mesh) : createSlabBaseGeometry(base, S)
    this.buffer = new InstanceBuffer(this.geometry, GLASS_ATTRS)
  }

  /** Profile segments of the base geometry (the TSL vertex stage needs it to classify rings); 0 for a mesh. */
  get K(): number { return this.geometry.userData.K as number }
  /** The packed nodes in instance order. */
  get nodes(): readonly Node[] { return this.sorted }

  /**
   * Packs `instances` (stable-sorted by `z`); `touch` gives a node its press glow. The luma index (`iGlow2.w`) of clear +
   * adaptive glass is its instance index (`SurfaceLuma` packs its rects in this order); with `opts.luma === false` every
   * instance's is −1, so none darkens (nested glass, spatial spec §2.4: its index would collide with the outer batch's).
   */
  update(instances: readonly GlassInstance[], s: SurfaceDims, touch?: Map<Node, TouchState>, opts: { luma?: boolean } = {}): void {
    const luma = opts.luma !== false
    const sorted = [...instances].sort((a, b) => a.z - b.z)
    this.sorted = sorted.map(i => i.node)
    const b = this.buffer
    b.begin(sorted.length)
    const ppu = s.ptPerUnit
    sorted.forEach((inst, i) => {
      const p = inst.params
      const [cx, cy] = surfaceToLocal(inst.rect.x + inst.rect.width / 2, inst.rect.y + inst.rect.height / 2, s)
      b.set(i, 'iRect', cx, cy, inst.rect.width / ppu, inst.rect.height / ppu)
      // never 0 thick, fillets within [0, thickness] (the slab profile then fits them into it)
      const thickness = clampPt(p.thickness, MIN_THICKNESS, Infinity)
      b.set(i, 'iShape', inst.radius / ppu, thickness / ppu, clampPt(p.fillet, 0, thickness) / ppu, clampPt(p.filletBottom, 0, thickness) / ppu)
      b.set(i, 'iCorner', p.cornerExponent, p.profile === 'lens' ? 1 : 0, p.lift, p.edgeGlow)
      writeMatrixRows(b, i, instanceMatrix(inst, s, this.m))
      b.set(i, 'iOptics', p.ior, p.dispersion, p.roughness, p.scatter)
      if (p.tint) b.set(i, 'iTint', srgbToLinear(p.tint[0]), srgbToLinear(p.tint[1]), srgbToLinear(p.tint[2]), p.absorption)
      else b.set(i, 'iTint', 1, 1, 1, p.absorption)
      if (p.glow) b.set(i, 'iGlow', srgbToLinear(p.glow.color[0]), srgbToLinear(p.glow.color[1]), srgbToLinear(p.glow.color[2]), p.glow.strength)
      else b.set(i, 'iGlow', 0, 0, 0, 0)
      // luma index: only clear + adaptive glass samples the backdrop luma pass (adaptive darkening)
      b.set(i, 'iGlow2', p.glow?.split ?? -1, GLOW_SOFTNESS, inst.opacity, luma && p.variant === 'clear' && p.adaptive ? i : -1)
      const t = touch?.get(inst.node)
      b.set(i, 'iTouch', t?.u ?? 0, t?.v ?? 0, t?.press ?? 0, REFLECTION_STRENGTH)
      writeClip(b, i, inst.clip)
    })
    b.commit()
  }

  indexOf(node: Node): number { return this.sorted.indexOf(node) }
  /** Frees the geometry's buffers, the base mesh's and the instances' alike (the geometry dispatches `dispose`). */
  dispose(): void { this.buffer.dispose() }
}
