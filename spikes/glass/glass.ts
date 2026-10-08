// SPIKE (throwaway): single-quad Liquid Glass material in TSL.
// Validates: superellipse SDF + bezel refraction + dispersion + frosted backdrop
// + Fresnel + two-wall glint, correct under arbitrary 3D transforms, on both
// the WebGPU and the WebGL2 backend of WebGPURenderer.

import { Color, DoubleSide } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import {
  Fn, uniform, vec2, vec3, vec4, float, uv, positionLocal, modelViewMatrix,
  cameraProjectionMatrix, screenUV, viewportMipTexture, abs, max, min, pow,
  clamp, smoothstep, mix, normalize, dot, fwidth, select, sin, cos, asin, atan,
  tan, normalView, positionViewDirection, exp, cross,
} from 'three/tsl'

export interface GlassOptions {
  width: number            // local units
  height: number
  radius: number           // corner radius; 'capsule' => height/2
  bezel?: number           // refraction band width
  thickness?: number       // virtual glass thickness (drives refraction amount)
  ior?: number
  dispersion?: number      // per-channel scale spread
  frost?: number           // 0..1 → mip lod
  tint?: Color
  tintStrength?: number
  lightAngle?: number      // radians, 2D light direction in panel space
  cornerExponent?: number  // 2 = circle, 4–5 ≈ Apple continuous corner
  brightness?: number      // lift toward white (regular glass)
  saturation?: number
  /** shared backdrop node; pass the same node to glass that should NOT see each other */
  backdrop?: ReturnType<typeof viewportMipTexture>
}

export function createGlassMaterial(o: GlassOptions) {
  const u = {
    size: uniform(vec2(o.width, o.height)),
    radius: uniform(o.radius),
    bezel: uniform(o.bezel ?? Math.min(o.width, o.height) * 0.18),
    thickness: uniform(o.thickness ?? 0.06),
    ior: uniform(o.ior ?? 1.5),
    dispersion: uniform(o.dispersion ?? 0.03),
    frost: uniform(o.frost ?? 0.35),
    tint: uniform(o.tint ?? new Color(1, 1, 1)),
    tintStrength: uniform(o.tintStrength ?? 0.0),
    lightAngle: uniform(o.lightAngle ?? Math.PI * 0.5),
    cornerN: uniform(o.cornerExponent ?? 4.5),
    brightness: uniform(o.brightness ?? 0.10),
    saturation: uniform(o.saturation ?? 1.25),
    press: uniform(0),            // 0..1 press amount (inner glow)
    touch: uniform(vec2(0, 0)),   // panel-local touch point
    hover: uniform(0),
  }

  const backdrop = o.backdrop ?? viewportMipTexture()

  // superellipse rounded rect SDF, p in local units, b = half size
  const sdRect = Fn(([p, b, r, n]: any[]) => {
    const q = abs(p).sub(b).add(r)
    const m = max(q, 0)
    const outer = pow(pow(m.x, n).add(pow(m.y, n)), float(1).div(n))
    return min(max(q.x, q.y), 0).add(outer).sub(r)
  })

  const material = new MeshBasicNodeMaterial()
  material.transparent = true
  material.depthWrite = false
  material.side = DoubleSide

  const shade = Fn(() => {
    const half = u.size.mul(0.5)
    const p = uv().sub(0.5).mul(u.size)
    const r = min(u.radius, min(half.x, half.y))
    const sd = sdRect(p, half, r, u.cornerN)

    // gradient (outward normal in panel space) by finite difference
    const eps = float(0.002)
    const gx = sdRect(p.add(vec2(eps, 0)), half, r, u.cornerN).sub(sdRect(p.sub(vec2(eps, 0)), half, r, u.cornerN))
    const gy = sdRect(p.add(vec2(0, eps)), half, r, u.cornerN).sub(sdRect(p.sub(vec2(0, eps)), half, r, u.cornerN))
    const g = normalize(vec2(gx, gy))

    // analytic AA coverage
    const aa = fwidth(sd)
    const cover = clamp(float(0.5).sub(sd.div(aa)), 0, 1)

    // bezel profile: convex squircle h = T * (1-(1-x)^4)^(1/4)
    const x = clamp(sd.negate().div(u.bezel), 0, 1)     // 0 at rim, 1 at plateau
    const t = float(1).sub(x)
    const t4 = pow(t, 4)
    const fp = pow(t, 3).div(pow(max(float(1).sub(t4), 1e-4), 0.75))   // f'(x)
    const thetaI = atan(u.thickness.div(u.bezel).mul(fp))
    const thetaT = asin(sin(thetaI).div(u.ior))
    const mag = u.thickness.mul(tan(thetaI.sub(thetaT)))           // local units, along +g (outward)

    // project the panel-space offset to screen space → exact under any transform
    const proj = (pl: any) => {
      const c = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(pl, 1))
      return c.xy.div(c.w).mul(0.5).add(0.5)
    }
    const base = proj(positionLocal)
    const sampleAt = (scale: any) => {
      const d = proj(positionLocal.add(vec3(g.mul(mag).mul(scale), 0))).sub(base)
      return screenUV.add(d.mul(vec2(1, -1)))   // screenUV is y-down in three
    }
    const lod = u.frost.mul(6.0)
    const cr = backdrop.sample(sampleAt(float(1).sub(u.dispersion))).level(lod).r
    const cg = backdrop.sample(sampleAt(float(1))).level(lod).g
    const cb = backdrop.sample(sampleAt(float(1).add(u.dispersion))).level(lod).b
    let c: any = vec3(cr, cg, cb)

    // saturation + brightness lift + tint
    const luma = dot(c, vec3(0.2126, 0.7152, 0.0722))
    c = mix(vec3(luma), c, u.saturation)
    c = mix(c, vec3(1), u.brightness)
    c = mix(c, c.mul(u.tint).add(u.tint.mul(0.35)), u.tintStrength)

    // perturbed normal for Fresnel
    const slope = tan(thetaI)
    const tV = normalize(modelViewMatrix.mul(vec4(1, 0, 0, 0)).xyz)
    const bV = normalize(modelViewMatrix.mul(vec4(0, 1, 0, 0)).xyz)
    const N = normalize(normalView.add(tV.mul(g.x.mul(slope))).add(bV.mul(g.y.mul(slope))))
    const NdotV = clamp(dot(N, positionViewDirection), 0, 1)
    const F = float(0.04).add(float(0.96).mul(pow(float(1).sub(NdotV), 5)))
    c = c.add(vec3(F.mul(0.35)))

    // two-wall glint along the light axis
    const L = vec2(cos(u.lightAngle), sin(u.lightAngle))
    const along = dot(g, L)
    const lobe = pow(abs(along), 1.5)
    const side = select(along.greaterThan(0), float(1), float(0.45))
    const w = aa.mul(1.6)
    const rimLine = smoothstep(0, w, sd.negate()).mul(float(1).sub(smoothstep(w, w.mul(3.0), sd.negate())))
    const bezelGlow = x.mul(float(1).sub(x)).mul(4).mul(0.28)
    const glint = lobe.mul(side).mul(rimLine.add(bezelGlow))
    c = mix(c, c.mul(0.4).add(0.65), clamp(glint, 0, 1))

    // soft inner edge (helps separate glass from backdrop)
    const innerEdge = smoothstep(0, u.bezel, sd.negate())
    c = c.add(vec3(float(0.06).mul(float(1).sub(innerEdge))))

    // inner glow from the touch point when pressed
    const dt = p.sub(u.touch)
    const glowR = min(half.x, half.y).mul(1.2)
    const glow = exp(dot(dt, dt).negate().div(glowR.mul(glowR))).mul(u.press)
    c = c.add(vec3(glow.mul(0.35)))
    c = c.add(vec3(u.hover.mul(0.04)))

    return vec4(c, cover)
  })

  const out = shade()
  material.colorNode = out.xyz
  material.opacityNode = out.w

  return { material, uniforms: u }
}

/** Analytic soft shadow quad (approximate Gaussian of the rounded rect). */
export function createShadowMaterial(o: { width: number; height: number; radius: number; sigma: number; alpha: number; cornerExponent?: number; pad: number; color?: Color }) {
  const u = {
    size: uniform(vec2(o.width, o.height)),
    radius: uniform(o.radius),
    sigma: uniform(o.sigma),
    alpha: uniform(o.alpha),
    pad: uniform(o.pad),
    color: uniform(o.color ?? new Color(0.1, 0.1, 0.2)),
    cornerN: uniform(o.cornerExponent ?? 4.5),
  }
  const sdRect = Fn(([p, b, r, n]: any[]) => {
    const q = abs(p).sub(b).add(r)
    const m = max(q, 0)
    const outer = pow(pow(m.x, n).add(pow(m.y, n)), float(1).div(n))
    return min(max(q.x, q.y), 0).add(outer).sub(r)
  })
  const material = new MeshBasicNodeMaterial()
  material.transparent = true
  material.depthWrite = false
  const quad = u.size.add(u.pad.mul(2))
  const p = uv().sub(0.5).mul(quad)
  const half = u.size.mul(0.5)
  const sd = sdRect(p, half, min(u.radius, min(half.x, half.y)), u.cornerN)
  // erf-free gaussian falloff approximation
  const a = exp(max(sd, 0).div(u.sigma).pow(2).negate()).mul(u.alpha)
  material.colorNode = u.color
  material.opacityNode = a
  return { material, uniforms: u, quadSize: [o.width + o.pad * 2, o.height + o.pad * 2] as const }
}
