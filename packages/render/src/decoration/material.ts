import { CustomBlending, AddEquation, SrcAlphaFactor, OneFactor, OneMinusSrcAlphaFactor, type InstancedBufferGeometry, type Vector2 } from 'three'
import { MeshBasicNodeMaterial, type Node, type UniformNode } from 'three/webgpu'
import { float, abs, max, min, exp, smoothstep, fwidth, length, clamp, vec2, vec3, attribute } from 'three/tsl'
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
 * alpha = min(1, outline · 0.75 + lower + top) · coverage · strength · opacity · the Surface's opacity (`su.opacity`),
 * colour `iColor`. The outline is a `RIM_OUTLINE_PT` band just inside the edge, fading over aa + ¼ of its width;
 * coverage is antialiased over ±0.75 px (`fwidth`), the quad extending `AA_MARGIN_PT` beyond the rect so its outer half
 * is rasterised.
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
  m.opacityNode = min(float(1), outline.mul(RIM_OUTLINE_ALPHA).add(lower).add(top)).mul(cover).mul(strength).mul(opacity).mul(su.opacity ?? float(1))
  return m
}

/**
 * Additive light pool under a glass element (the spike's `glow`): a linear falloff over the elliptical radius of the
 * inflated rect, alpha = max(0, 1 − ‖q / half‖) · strength · opacity, colour `iColor`. The falloff reaches 0 on the
 * ellipse inscribed in the rect, so the quad needs no AA margin.
 *
 * Additive light with coverage: colour adds (`dst.rgb + rgb · α`) and alpha accumulates "over" (`α + dst.a · (1 − α)`).
 * The content RT is premultiplied by construction (panels and glyphs blend into a transparent clear) and the content
 * quad composites it premultiplied, so over a transparent region the halo lands as (rgb·α, α), visible and correctly
 * weighted, while over opaque content alpha stays 1 and the light only adds: alpha is bounded by 1 either way.
 *
 * Varyings: `flatVertex`'s three + `iShape`, `iColor` = 5.
 */
export function createPoolMaterial(g: InstancedBufferGeometry, su: SurfaceUniforms): MeshBasicNodeMaterial {
  const fv = flatVertex(g, su)
  const shape = fv.pack('iShape'), color = fv.pack('iColor')
  const strength = shape.y, opacity = shape.w
  const m = decal(fv)
  m.blending = CustomBlending   // premultipliedAlpha stays false: the source factor applies α to the colour
  m.blendEquation = AddEquation; m.blendSrc = SrcAlphaFactor; m.blendDst = OneFactor
  m.blendEquationAlpha = AddEquation; m.blendSrcAlpha = OneFactor; m.blendDstAlpha = OneMinusSrcAlphaFactor

  const r01 = length(fv.q.div(fv.size.mul(0.5)))
  m.colorNode = color.rgb
  m.opacityNode = max(float(1).sub(r01), 0).mul(strength).mul(opacity)
  return m
}

/**
 * The drop shadow of raised glass (spatial spec §11.7): its alpha in the light and dark schemes; its blur, `blurBase +
 * blurPerPt × elevation` pt either side of the offset outline; its offset along the light, at most `maxOffset ×
 * elevation` pt per component.
 */
export const SHADOW_DECAL = { alphaLight: 0.22, alphaDark: 0.35, blurBase: 4, blurPerPt: 0.5, maxOffset: 1.5 } as const

/**
 * A raised glass element's soft drop shadow, drawn into the content RT (spatial spec §11.7), so it shows on the plate
 * around the element and refracted through it. The caster's superellipse offset by `elevation × dir` pt (each component
 * clamped to ±`maxOffset × elevation`) and blurred, coverage `1 − smoothstep(−blur, blur, d)`, times `1 − the caster's
 * own coverage` (antialiased over ±0.75 px: no shadow under the caster, where it would only darken the caster's own
 * content), times `alpha × opacity`; black, blended "over" (normal blending: the premultiplied RT darkens, and a
 * transparent texel takes (0, α), which the content quad composites as black at α).
 *
 * `dir` is pt of offset per pt of elevation, y down (`Surface.setLightDirection`), and `alpha` the scheme's
 * (`SHADOW_DECAL`): the Surface's, shared by all its shadows. The quad grows by `maxOffset × elevation + blur` pt on every
 * side (`flatVertex`'s per-instance margin) so that the blur's outer edge is rasterised wherever the offset puts it;
 * `q` and `size` stay the caster's.
 *
 * Packing (`DecorationBatch('shadow')`): `iShape` = (radius; units, elevation; pt, corner exponent, strength × opacity).
 * Varyings: `flatVertex`'s three + `iShape` = 4.
 */
export function createShadowMaterial(g: InstancedBufferGeometry, su: SurfaceUniforms, dir: UniformNode<'vec2', Vector2>, alpha: UniformNode<'float', number>): MeshBasicNodeMaterial {
  const { blurBase, blurPerPt, maxOffset } = SHADOW_DECAL
  const blurPt = (e: Node<'float'>) => e.mul(blurPerPt).add(blurBase)
  // vertex stage: the reach from the instance attribute itself (a varying is a fragment-stage value)
  const e0 = attribute('iShape', 'vec4').y
  const fv = flatVertex(g, su, { marginPt: e0.mul(maxOffset).add(blurPt(e0)) })
  const shape = fv.pack('iShape')
  const radius = shape.x, elevation = shape.y, n = shape.z, opacity = shape.w
  const m = decal(fv)

  const half = fv.size.mul(0.5), lim = elevation.mul(maxOffset)
  const along = (c: Node<'float'>) => clamp(c.mul(elevation), lim.negate(), lim)          // pt, clamped per component
  const offset = vec2(along(dir.x), along(dir.y).negate()).div(su.ptPerUnit)              // y down, pt → q's frame: y up, units
  const blur = blurPt(elevation).div(su.ptPerUnit)   // ≥ blurBase pt: edge0 < edge1
  const cover = float(1).sub(smoothstep(blur.negate(), blur, sdfNode(fv.q.sub(offset), half, radius, n)))
  const d = sdfNode(fv.q, half, radius, n)
  const aa = max(fwidth(d), 1e-6).mul(0.75)   // floored as the rim's: smoothstep needs edge0 < edge1
  m.colorNode = vec3(0)
  m.opacityNode = cover.mul(smoothstep(aa.negate(), aa, d)).mul(alpha).mul(opacity)   // smoothstep(−aa, aa, d) = 1 − inside
  return m
}
