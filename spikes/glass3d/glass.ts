// SPIKE: real-3D liquid glass material.
// Built on MeshPhysicalNodeMaterial: lights, env reflections, Fresnel, iridescence
// and (coloured, transmitted) shadows come from the engine. Ours is only the
// transmitted term: the refracted backdrop sampled through the real thickness,
// optionally mixed with a planar reflection of what sits on top (for the panel).

import { Color, FrontSide, type Side } from 'three'
import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import {
  Fn, uniform, vec2, vec3, vec4, float, positionView, positionViewDirection, normalView,
  positionLocal, modelViewMatrix, cameraProjectionMatrix, viewportMipTexture, refract,
  normalize, dot, max, min, exp, mix, uv, clamp, pow, smoothstep,
} from 'three/tsl'

export interface Glass3DOptions {
  thickness: number
  ior?: number
  dispersion?: number
  roughness?: number         // frost (blur of what's behind)
  scatter?: number           // 0..1 how much of the frost becomes lit white scattering
  diffuse?: number           // brightness of the scattering term
  lift?: number              // whitening of the transmitted term
  tint?: Color
  absorption?: number
  envIntensity?: number
  iridescence?: number
  specularRoughness?: number // highlight sharpness of the top surface
  shadowOpacity?: number     // alpha of the transmitted shadow this glass casts
  backdrop?: ReturnType<typeof viewportMipTexture>
  reflection?: { node: any; strength: number }   // planar reflection node (TSL reflector)
  side?: Side
  edgeGlow?: number          // fake internal reflection: brighten steep (edge) normals
  innerGlow?: { color: Color; strength: number; split?: number }   // light inside the glass; split = only left of this uv.x
}

export function createGlass3DMaterial(o: Glass3DOptions) {
  const u = {
    thickness: uniform(o.thickness),
    ior: uniform(o.ior ?? 1.5),
    dispersion: uniform(o.dispersion ?? 0.3),
    frost: uniform(o.roughness ?? 0.3),
    scatter: uniform(o.scatter ?? 0.2),
    tint: uniform(o.tint ?? new Color(1, 1, 1)),
    absorption: uniform(o.absorption ?? 0),
    press: uniform(0),
    touch: uniform(vec2(0, 0)),
    glowRadius: uniform(0.6),
  }
  const backdrop = o.backdrop ?? viewportMipTexture()

  const m = new MeshPhysicalNodeMaterial()
  m.transparent = true
  m.depthWrite = true
  m.side = o.side ?? FrontSide
  m.roughness = o.specularRoughness ?? 0.07
  m.metalness = 0
  m.envMapIntensity = o.envIntensity ?? 1.0
  m.specularIntensity = 1
  m.iridescence = o.iridescence ?? 0
  m.iridescenceIOR = 1.3
  m.iridescenceThicknessRange = [120, 420]
  m.iorNode = u.ior

  m.colorNode = u.tint.mul(u.tint).mul(o.diffuse ?? 0.6)

  m.backdropNode = Fn(() => {
    const V = positionViewDirection
    const N = normalView
    const nb = normalize(modelViewMatrix.mul(vec4(0, 0, 1, 0)).xyz)
    const depth = positionLocal.z
    const lod = u.frost.mul(8.0)

    const sampleChannel = (iorScale: any) => {
      const eta = float(1).div(u.ior.mul(iorScale))
      const R = refract(V.negate(), N, eta)
      const cosb = max(dot(R.negate(), nb), 0.15)
      const t = min(depth.div(cosb), u.thickness.mul(4))
      const exit = positionView.add(R.mul(t))
      const clip = cameraProjectionMatrix.mul(vec4(exit, 1))
      const ndc = clip.xy.div(clip.w)
      const suv = vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)))
      return { c: backdrop.sample(suv).level(lod).rgb, t }
    }
    const k = u.dispersion.mul(0.03)
    const r = sampleChannel(float(1).sub(k))
    const g = sampleChannel(float(1))
    const b = sampleChannel(float(1).add(k))
    let c: any = vec3(r.c.r, g.c.g, b.c.b)
    const sigma = float(1).sub(u.tint).mul(u.absorption)
    c = c.mul(exp(sigma.mul(g.t.div(u.thickness)).negate()))
    c = mix(c, vec3(1), u.frost.mul(0.08).add(o.lift ?? 0))
    if (o.reflection) { const R = o.reflection.node; c = mix(c, R.rgb, R.a.mul(o.reflection.strength)) }
    return c
  })()
  m.backdropAlphaNode = float(1).sub(u.frost.mul(u.scatter))

  m.emissiveNode = Fn(() => {
    const p = uv().sub(0.5)
    const d = p.sub(u.touch)
    const glow = exp(dot(d, d).negate().div(u.glowRadius.mul(u.glowRadius))).mul(u.press)
    // edge glow: light trapped in the slab leaks out at the steep round-overs
    const NdotV = clamp(dot(normalView, positionViewDirection), 0, 1)
    const fres = pow(float(1).sub(NdotV), 2.5)
    const rim = fres.mul(o.edgeGlow ?? 0)
    let e: any = vec3(glow.mul(0.45)).add(u.tint.mul(glow.mul(0.25))).add(mix(vec3(1), u.tint, 0.5).mul(rim))
    if (o.innerGlow) {
      // light trapped inside the slab: soft fill, stronger where the glass is thick/steep, optional left-only mask
      const gc = vec3(o.innerGlow.color.r, o.innerGlow.color.g, o.innerGlow.color.b)
      const mask = o.innerGlow.split !== undefined ? smoothstep(float(o.innerGlow.split).add(0.04), float(o.innerGlow.split).sub(0.04), uv().x) : float(1)
      const body = float(0.55).add(fres.mul(1.2))
      e = e.add(gc.mul(body).mul(o.innerGlow.strength).mul(mask))
    }
    return e
  })()

  // transmitted (coloured) shadow: the light that passes through this glass
  const transmit = (o.tint ?? new Color(1, 1, 1)).clone()
  const absorb = o.absorption ?? 0
  const sc = new Color(
    Math.exp(-(1 - transmit.r) * absorb * 0.9),
    Math.exp(-(1 - transmit.g) * absorb * 0.9),
    Math.exp(-(1 - transmit.b) * absorb * 0.9),
  )
  const shadowColor = absorb === 0 ? new Color(0.78, 0.78, 0.84) : sc.multiplyScalar(0.9)
  m.castShadowNode = vec4(shadowColor.r, shadowColor.g, shadowColor.b, o.shadowOpacity ?? 1)

  return { material: m, uniforms: u }
}
