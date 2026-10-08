import type { InstancedBufferGeometry, Vector2 } from 'three'
import { MeshBasicNodeMaterial, type Node, type UniformNode } from 'three/webgpu'
import { attribute, varying, vec2, vec3, vec4, float, dot, fwidth, smoothstep, abs, max, min, length, select } from 'three/tsl'
import { sdfNode } from './sdf'

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

/**
 * Solid panels (`bg` colour and/or border): unlit (the Surface's content quad is the lit, shadow-receiving surface,
 * Task 15), alpha-blended, antialiased against the superellipse SDF over about a pixel (`fwidth`). The border is an
 * inset band of its width at the edge, composited over the fill (premultiplied); opacity is coverage × colour alpha ×
 * instance opacity. The quad extends `AA_MARGIN_PT` beyond the rect so the outer half of the ramp is rasterised.
 *
 * Varyings: `flatVertex`'s three + `iShape`, `iColor`, `iBorder` = 6.
 */
export function createPanelMaterial(geometry: InstancedBufferGeometry, surface: SurfaceUniforms): MeshBasicNodeMaterial {
  const fv = flatVertex(geometry, surface, { marginPt: AA_MARGIN_PT })
  const shape = fv.pack('iShape'), fill = fv.pack('iColor'), border = fv.pack('iBorder')
  const radius = shape.x, borderWidth = shape.y, n = shape.z, opacity = shape.w

  const m = new MeshBasicNodeMaterial()
  m.transparent = true; m.depthWrite = false; m.toneMapped = false
  // unlit outright, as three's own background mesh: `MeshBasicNodeMaterial` otherwise runs a lighting context (for env
  // and light maps, unused here) whose geometry normal is a flat derivative normal costing a `v_positionView` varying
  m.lights = false
  m.positionNode = fv.position
  m.maskNode = fv.mask   // the material discards where the mask is false

  const d = sdfNode(fv.q, fv.size.mul(0.5), radius, n)
  // floored so edge0 < edge1 where d is flat across a pixel (smoothstep is undefined otherwise)
  const aa = max(fwidth(d), 1e-6).mul(0.75)
  const cover = float(1).sub(smoothstep(aa.negate(), aa, d))
  const borderMix = smoothstep(aa.negate(), aa, d.add(borderWidth)).mul(select(borderWidth.greaterThan(0), float(1), float(0)))
  // the border is drawn over the fill (as CSS and SwiftUI do), premultiplied: border·t + fill·(1 − border.a·t). A
  // translucent border (the separator token) tints the fill instead of replacing it, and over a transparent fill (a
  // border-only panel's) the inner edge fades the border out instead of pulling it toward the fill's invisible rgb
  const fillP = vec4(fill.rgb.mul(fill.a), fill.a), borderP = vec4(border.rgb.mul(border.a), border.a)
  const col = borderP.mul(borderMix).add(fillP.mul(float(1).sub(border.a.mul(borderMix))))
  m.colorNode = col.rgb.div(max(col.a, 1e-6))
  m.opacityNode = cover.mul(col.a).mul(opacity)
  return m
}
