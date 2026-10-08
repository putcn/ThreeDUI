// SPIKE: real-3D liquid glass material.
// Built on MeshPhysicalNodeMaterial: lights, env reflections, Fresnel and shadows
// come from the scene. Only the transmitted term is ours: a refracted backdrop
// sample (Snell on the real normal, through the real thickness).

import { Color } from 'three'
import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import {
  Fn, uniform, vec2, vec3, vec4, float, positionView, positionViewDirection, normalView,
  positionLocal, modelViewMatrix, cameraProjectionMatrix, viewportMipTexture, refract,
  normalize, dot, max, min, clamp, exp, mix, uv,
} from 'three/tsl'

export interface Glass3DOptions {
  thickness: number          // local units (matches the slab geometry)
  ior?: number
  dispersion?: number        // 0..1
  roughness?: number         // frost
  tint?: Color
  absorption?: number        // Beer-Lambert strength per unit thickness
  envIntensity?: number
  backdrop?: ReturnType<typeof viewportMipTexture>
}

export function createGlass3DMaterial(o: Glass3DOptions) {
  const u = {
    thickness: uniform(o.thickness),
    ior: uniform(o.ior ?? 1.6),
    dispersion: uniform(o.dispersion ?? 0.3),
    frost: uniform(o.roughness ?? 0.3),
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
  m.roughness = 0.22           // specular lobe size (highlights); frost is separate
  m.metalness = 0
  m.clearcoat = 1               // polished top layer: second specular lobe (sharper)
  m.clearcoatRoughness = 0.12
  m.envMapIntensity = o.envIntensity ?? 1.6
  m.specularIntensity = 1
  m.colorNode = u.tint.mul(u.tint).mul(0.9)  // diffuse part = frosted scattering (tinted), lit & shadowed

  // refracted backdrop
  m.backdropNode = Fn(() => {
    const V = positionViewDirection            // surface → camera
    const N = normalView
    const nb = normalize(modelViewMatrix.mul(vec4(0, 0, 1, 0)).xyz)   // slab +z in view space
    const depth = positionLocal.z              // height above the back plane
    const lod = u.frost.mul(5.0)

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

    // Beer-Lambert absorption: thicker path → deeper tint
    const sigma = float(1).sub(u.tint).mul(u.absorption)
    c = c.mul(exp(sigma.mul(g.t.div(u.thickness)).negate()))
    // slight brightening typical of frosted glass
    c = mix(c, vec3(1), u.frost.mul(0.12))
    return c
  })()

  // how much of the diffuse term is transmitted backdrop vs. scattered (lit) white
  m.backdropAlphaNode = float(1).sub(u.frost.mul(0.3))

  // press: inner glow from the touch point
  m.emissiveNode = Fn(() => {
    const p = uv().sub(0.5)
    const d = p.sub(u.touch)
    const glow = exp(dot(d, d).negate().div(u.glowRadius.mul(u.glowRadius))).mul(u.press)
    return vec3(glow.mul(0.45)).add(u.tint.mul(glow.mul(0.25)))
  })()

  m.iorNode = u.ior
  return { material: m, uniforms: u }
}

export const clampUnit = (x: number) => clamp(float(x), 0, 1)
