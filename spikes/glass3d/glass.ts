// SPIKE: real-3D liquid glass material.
// Built on MeshPhysicalNodeMaterial: lights, env reflections, Fresnel, iridescence
// and (coloured, transmitted) shadows come from the engine. Ours is only the
// transmitted term: the refracted backdrop sampled through the real thickness.

import { Color } from 'three'
import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import {
  Fn, uniform, vec2, vec3, vec4, float, positionView, positionViewDirection, normalView,
  positionLocal, modelViewMatrix, cameraProjectionMatrix, viewportMipTexture, refract,
  normalize, dot, max, min, exp, mix, uv,
} from 'three/tsl'

export interface Glass3DOptions {
  thickness: number
  ior?: number
  dispersion?: number
  roughness?: number         // frost (blur of what's behind)
  scatter?: number           // 0..1 how much of the frost becomes lit white scattering
  diffuse?: number           // brightness of the scattering term
  lift?: number              // whitening of the transmitted term (sky reflection in the frosted layer)
  tint?: Color
  absorption?: number
  envIntensity?: number
  iridescence?: number
  shadowOpacity?: number     // alpha of the transmitted shadow this glass casts
  backdrop?: ReturnType<typeof viewportMipTexture>
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
  m.roughness = 0.07
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
    const lod = u.frost.mul(6.0)

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
    return c
  })()
  m.backdropAlphaNode = float(1).sub(u.frost.mul(u.scatter))

  m.emissiveNode = Fn(() => {
    const p = uv().sub(0.5)
    const d = p.sub(u.touch)
    const glow = exp(dot(d, d).negate().div(u.glowRadius.mul(u.glowRadius))).mul(u.press)
    return vec3(glow.mul(0.45)).add(u.tint.mul(glow.mul(0.25)))
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
