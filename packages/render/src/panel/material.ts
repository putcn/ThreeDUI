import type { InstancedBufferGeometry } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { vec4, float, fwidth, smoothstep, max, select } from 'three/tsl'
import { flatVertex, AA_MARGIN_PT, type SurfaceUniforms } from '../flat'
import { sdfNode } from './sdf'

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
