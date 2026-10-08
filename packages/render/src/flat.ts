import type { InstancedBufferGeometry, Vector2 } from 'three'
import type { Node, UniformNode } from 'three/webgpu'
import { attribute, varying, vec2, vec3, vec4, float, dot, abs, max, min, length, select } from 'three/tsl'

/** The Surface's size in units (W, H) and its pt per unit, as uniforms the Surface owns. */
export interface SurfaceUniforms { size: UniformNode<'vec2', Vector2>; ptPerUnit: UniformNode<'float', number> }

/** The instance attributes `flatVertex` itself reads: the rect, the matrix rows and the clip (transform.ts). */
const FLAT_ATTRS = ['iRect', 'iMat0', 'iMat1', 'iMat2', 'iClipRect', 'iClipInv', 'iClipT'] as const

/**
 * pt rasterised beyond an antialiased SDF edge (`flatVertex`'s `marginPt`): without it the quad ends at the rect, the
 * outer half of the ramp (0 < d ≤ aa) never reaches a fragment, and coverage jumps from ½ to 0 as an edge crosses a
 * pixel centre. 2 pt holds the ramp down to ~0.4 px per pt.
 */
export const AA_MARGIN_PT = 2

export interface FlatVertexOptions {
  /** pt the rasterised quad extends beyond the rect on every side, in the instance's own frame (default 0). */
  marginPt?: number
}

/** What a flat instanced material builds on (`flatVertex`). */
export interface FlatVertex {
  /** Vertex stage: the vertex in Surface-local units (`material.positionNode`). */
  position: Node<'vec3'>
  /** Fragment: the quad-local position in units, centred (the instance's frame before its matrix); with a margin it
   *  reaches past the rect's half size by the margin. */
  q: Node<'vec2'>
  /** Fragment: the rect's size in units (`iRect.zw`). */
  size: Node<'vec2'>
  /** Fragment: false outside the instance's clip (`material.maskNode`). */
  mask: Node<'bool'>
  /** Fragment: the named per-instance vec4 attribute through its own varying `v_<name>` (one per name, made once). */
  pack(name: string): Node<'vec4'>
}

/**
 * The shared vertex stage of every flat instanced material (panel, decorations, glyphs, images) on the unit quad
 * (`createQuadGeometry`): the quad scaled by `iRect.zw` and placed by the `iMat` rows, plus the varyings a fragment
 * needs. As in the glass material, the fragment stage never reads an instance attribute (each would cost an
 * inter-stage variable of its own, see `createGlassMaterial`): what it needs comes through packed varyings, and
 * attributes are read by name since `InstanceBuffer` replaces them when it grows.
 *
 * `marginPt` grows the rasterised quad on every side (see `AA_MARGIN_PT`) while `q` and `size` stay in rect units, so
 * SDF, border and clip maths are unchanged and an SDF's coverage falls to 0 outside the rect. The geometry's `uv` then
 * spans the grown quad: a material sampling a rect-sized texture derives its uv from `q / size + 0.5` instead.
 *
 * Varyings: `vFlatQ` (q, size), `vFlatClip` (the clip-local pt relative to the clip centre, clip half size − radius) and
 * `vFlatClipR` (clip radius, −1 = no clip); three only emits the ones a material's fragment uses. q and the clip point
 * are affine in the quad position, so their interpolation is exact; the rest is constant per instance. A material adds
 * one `pack(name)` per vec4 of its own.
 */
export function flatVertex(g: InstancedBufferGeometry, su: SurfaceUniforms, { marginPt = 0 }: FlatVertexOptions = {}): FlatVertex {
  // three compiles a missing attribute to zeros (zero size, no matrix: an invisible element), so fail here instead
  const need = (name: string) => { if (!g.hasAttribute(name)) throw new Error(`[render] flatVertex: geometry has no "${name}" attribute`) }
  for (const name of FLAT_ATTRS) need(name)
  const A = (name: string) => attribute(name, 'vec4')
  const iRect = A('iRect'), iMat0 = A('iMat0'), iMat1 = A('iMat1'), iMat2 = A('iMat2')
  const iClipRect = A('iClipRect'), iClipInv = A('iClipInv'), iClipT = A('iClipT')

  const pos = attribute('position', 'vec3')
  const extent = marginPt > 0 ? iRect.zw.add(float(2 * marginPt).div(su.ptPerUnit)) : iRect.zw   // the rasterised quad
  const q = pos.xy.mul(extent)                                                     // quad-local units, centred
  const p4 = vec4(q, 0, 1)
  const local = vec3(dot(iMat0, p4), dot(iMat1, p4), dot(iMat2, p4))

  // rounded-rect clip: the vertex's surface pt (origin top-left, y down) through the clip's inverse transform, taken
  // relative to the clip rect's centre; the fragment only measures the signed distance
  const pt = vec2(local.x.add(su.size.x.mul(0.5)).mul(su.ptPerUnit), su.size.y.mul(0.5).sub(local.y).mul(su.ptPerUnit))
  const clipPt = vec2(iClipInv.x.mul(pt.x).add(iClipInv.z.mul(pt.y)).add(iClipT.x), iClipInv.y.mul(pt.x).add(iClipInv.w.mul(pt.y)).add(iClipT.y))
  const half = iClipRect.zw.mul(0.5)
  const clipRadius = max(min(iClipT.z, min(half.x, half.y)), 0)
  const vQ = varying(vec4(q, iRect.zw), 'vFlatQ')
  const vClip = varying(vec4(clipPt.sub(iClipRect.xy.add(half)), half.sub(clipRadius)), 'vFlatClip')
  // writeClip packs width −1 for "no clip" (a clip collapsed to width 0 still clips everything); its half width −0.5
  // forces the radius to 0, so the flag is exactly −1. The select's branches are constants on purpose: a branch whose
  // root node is also used outside it can be emitted inside the branch only, its variable then read after the branch
  const vClipR = varying(clipRadius.add(select(iClipRect.z.greaterThanEqual(0), float(0), float(-1))), 'vFlatClipR')

  const cq = abs(vClip.xy).sub(vClip.zw)
  const clipDist = length(max(cq, 0)).add(min(max(cq.x, cq.y), 0)).sub(vClipR)
  const mask = vClipR.lessThan(0).or(clipDist.lessThanEqual(0))

  const packs = new Map<string, Node<'vec4'>>()
  const pack = (name: string) => {
    let v = packs.get(name)
    if (!v) { need(name); v = varying(A(name), `v_${name}`); packs.set(name, v) }
    return v
  }
  return { position: local, q: vQ.xy, size: vQ.zw, mask, pack }
}
