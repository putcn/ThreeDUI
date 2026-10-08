import { AdditiveBlending, type InstancedBufferGeometry } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { float, abs, max, min, exp, smoothstep, fwidth, length } from 'three/tsl'
import { flatVertex, AA_MARGIN_PT, type FlatVertex, type SurfaceUniforms } from '../flat'
import { sdfNode } from '../panel/sdf'

/** The rim's outline: its width in pt (the instance's frame) and its alpha. */
export const RIM_OUTLINE_PT = 1.25
export const RIM_OUTLINE_ALPHA = 0.75

const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }

/**
 * The rim's lower band (light caught by the bottom round-over) and top band, by height fraction `y01` (0 = the bottom
 * edge, 1 = the top). CPU reference of the rim material's bands; below the bottom edge (the AA margin) both hold their
 * edge values, as the shader floors `y01` at 0.
 */
export function rimProfile(y01: number): { lower: number; top: number } {
  const y = Math.max(y01, 0)
  return { lower: 0.42 * Math.exp(-21 * y) * (1 - smooth(0.30, 0.45, y)), top: 0.22 * smooth(0.65, 1, y) }
}

/** A flat decoration material: unlit, transparent, no depth write, masked by the instance clip. */
function decal(fv: FlatVertex): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial()
  m.transparent = true; m.depthWrite = false; m.toneMapped = false
  m.lights = false   // unlit outright, as the panel material: a lit basic material costs a `v_positionView` varying
  m.positionNode = fv.position
  m.maskNode = fv.mask   // the material discards where the mask is false
  return m
}

/**
 * Thin bright outline + lower/top bands inside the superellipse (the spike's `rimDecal`), drawn over its glass:
 * alpha = min(1, outline · 0.75 + lower + top) · coverage · strength · opacity, colour `iColor`. The outline is a
 * `RIM_OUTLINE_PT` band just inside the edge, fading over aa + ¼ of its width; coverage is antialiased over ±0.75 px
 * (`fwidth`), the quad extending `AA_MARGIN_PT` beyond the rect so its outer half is rasterised.
 *
 * Varyings: `flatVertex`'s three + `iShape`, `iColor` = 5.
 */
export function createRimMaterial(g: InstancedBufferGeometry, su: SurfaceUniforms): MeshBasicNodeMaterial {
  const fv = flatVertex(g, su, { marginPt: AA_MARGIN_PT })
  const shape = fv.pack('iShape'), color = fv.pack('iColor')
  const radius = shape.x, strength = shape.y, n = shape.z, opacity = shape.w
  const m = decal(fv)

  const d = sdfNode(fv.q, fv.size.mul(0.5), radius, n)
  // floored so edge0 < edge1 where d is flat across a pixel (smoothstep is undefined otherwise)
  const aa = max(fwidth(d), 1e-6).mul(0.75)
  const cover = float(1).sub(smoothstep(aa.negate(), aa, d))
  const ow = float(RIM_OUTLINE_PT).div(su.ptPerUnit)
  const outline = float(1).sub(smoothstep(float(0), aa.add(ow.mul(0.25)), abs(d.add(ow.mul(0.5))).sub(ow.mul(0.5))))
  // floored: in the margin below the bottom edge the lower band would otherwise keep growing (rimProfile agrees)
  const y01 = max(fv.q.y.div(fv.size.y).add(0.5), 0)
  const lower = float(0.42).mul(exp(y01.mul(-21))).mul(float(1).sub(smoothstep(0.30, 0.45, y01)))   // edge0 < edge1 (GLSL rule)
  const top = float(0.22).mul(smoothstep(0.65, 1.0, y01))
  m.colorNode = color.rgb
  m.opacityNode = min(float(1), outline.mul(RIM_OUTLINE_ALPHA).add(lower).add(top)).mul(cover).mul(strength).mul(opacity)
  return m
}

/**
 * Additive light pool under a glass element (the spike's `glow`): a linear falloff over the elliptical radius of the
 * inflated rect, alpha = max(0, 1 − ‖q / half‖) · strength · opacity, colour `iColor`. The falloff reaches 0 on the
 * ellipse inscribed in the rect, so the quad needs no AA margin.
 *
 * Varyings: `flatVertex`'s three + `iShape`, `iColor` = 5.
 */
export function createPoolMaterial(g: InstancedBufferGeometry, su: SurfaceUniforms): MeshBasicNodeMaterial {
  const fv = flatVertex(g, su)
  const shape = fv.pack('iShape'), color = fv.pack('iColor')
  const strength = shape.y, opacity = shape.w
  const m = decal(fv)
  m.blending = AdditiveBlending

  const r01 = length(fv.q.div(fv.size.mul(0.5)))
  m.colorNode = color.rgb
  m.opacityNode = max(float(1).sub(r01), 0).mul(strength).mul(opacity)
  return m
}
