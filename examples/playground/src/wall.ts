import { BackSide, CylinderGeometry, DirectionalLight, HemisphereLight, Mesh, PlaneGeometry, type Object3D } from 'three'
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu'
import { abs, Fn, float, floor, fract, length, max, mix, smoothstep, uv, vec2, vec3 } from 'three/tsl'

type ColorNode = Node<'vec3'>

/**
 * The backdrop's material (ported from `spikes/glass3d/main.ts`): a soft pastel gradient with colour blobs, a diagonal
 * light beam (so refraction has gradients to bend) and a vignette, over uv (u across, v up).
 */
function pastelMaterial(): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 })
  material.colorNode = Fn(() => {
    const q = uv()
    let c: ColorNode = mix(vec3(0.90, 0.86, 0.84), vec3(0.80, 0.84, 0.92), q.y)
    const blob = (cx: number, cy: number, radius: number, col: [number, number, number], a = 0.85): void => {
      const d = length(q.sub(vec2(cx, cy)))
      c = mix(c, vec3(...col), float(1).sub(smoothstep(0, radius, d)).mul(a))
    }
    blob(0.18, 0.90, 0.45, [0.98, 0.95, 0.90])
    blob(0.86, 0.80, 0.40, [0.72, 0.88, 0.92])
    blob(0.78, 0.12, 0.45, [0.96, 0.78, 0.86])
    blob(0.18, 0.18, 0.42, [0.42, 0.40, 0.62])
    blob(0.55, 0.55, 0.30, [0.84, 0.80, 0.95], 0.5)
    // the diagonal beam across the wall, as in the reference
    const beam = q.x.mul(0.55).add(q.y.mul(0.85))
    c = mix(c, vec3(1.0, 0.98, 0.95), smoothstep(0.55, 0.75, beam).mul(float(1).sub(smoothstep(0.95, 1.2, beam))).mul(0.8))
    c = mix(c, vec3(0.30, 0.28, 0.36), smoothstep(0.45, 0.2, beam).mul(0.6))
    const vignette = float(1).sub(smoothstep(0.4, 1.0, length(q.sub(vec2(0.45, 0.62))).mul(0.9)))
    return c.mul(0.95).mul(float(0.8).add(vignette.mul(0.25)))
  })()
  return material
}

/**
 * The backdrop wall: the pastel material on a 16 × 11 unit plane at z = −2.5; it neither casts nor receives shadows. It
 * lives in the host scene, so it is lit by `createHostLights`, not by the UI's lights.
 */
export function createWall(): Mesh {
  const wall = new Mesh(new PlaneGeometry(16, 11), pastelMaterial())
  wall.name = 'wall'
  wall.position.z = -2.5
  wall.castShadow = false
  wall.receiveShadow = false
  return wall
}

/** World units of curved wall one unit of u spans (see `createCurvedWall`): the plane's 16 at twice its size. */
export const MAX_U_LENGTH = 32

type RGB = readonly [number, number, number]
/**
 * The arc's pastel (`arcPastelMaterial`, and its JS twin `arcPastel`): the plane's gradient and colour blobs, made to
 * repeat seamlessly in u (period 1), so an arc of any length is covered at one density. The blobs' u distance wraps
 * (their radii are under 0.5, so each fades out before the wrap); the diagonal light beam repeats once a period; the
 * plane's dark side of the beam (a grey veil low on the left) is left out, its darkest blob lightened to a periwinkle,
 * and the vignette is vertical only (no darkening toward the arc's ends).
 */
export const ARC_PASTEL = {
  base: { low: [0.90, 0.86, 0.84] as RGB, high: [0.80, 0.84, 0.92] as RGB },
  blobs: [
    { at: [0.18, 0.90], radius: 0.45, color: [0.98, 0.95, 0.90] as RGB, alpha: 0.85 },
    { at: [0.86, 0.80], radius: 0.40, color: [0.72, 0.88, 0.92] as RGB, alpha: 0.85 },
    { at: [0.78, 0.12], radius: 0.45, color: [0.96, 0.78, 0.86] as RGB, alpha: 0.85 },
    { at: [0.18, 0.18], radius: 0.42, color: [0.58, 0.56, 0.82] as RGB, alpha: 0.75 },
    { at: [0.55, 0.55], radius: 0.30, color: [0.84, 0.80, 0.95] as RGB, alpha: 0.5 },
  ],
  /**
   * The beam: bright where the phase fract(u + slope · v) is between the ramps' ends (the plane's beam, at its place,
   * once a period, narrower); the shade: a soft periwinkle (not the plane's grey) across from it, for the glass to bend.
   */
  beam: { slope: 0.85 / 0.55, ramps: [0.2, 0.38, 0.55, 0.75], color: [1.0, 0.98, 0.95] as RGB, strength: 0.6 },
  shade: { ramps: [0.75, 0.92, 0.04, 0.2], color: [0.72, 0.70, 0.88] as RGB, strength: 0.45 },
  vignette: { centre: 0.62, scale: 0.9, edges: [0.4, 1.0] },
} as const

const smooth = (e0: number, e1: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t) }
const mixRGB = (a: RGB, b: RGB, t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** The arc's pastel at (u, v), linear RGB before lighting: the JS twin of `arcPastelMaterial`'s colour (for tests and tools). */
export function arcPastel(u: number, v: number): [number, number, number] {
  const P = ARC_PASTEL
  let c = mixRGB(P.base.low, P.base.high, v)
  for (const b of P.blobs) {
    const du = u - b.at[0], w = du - Math.floor(du + 0.5)
    c = mixRGB(c, b.color, (1 - smooth(0, b.radius, Math.hypot(w, v - b.at[1]))) * b.alpha)
  }
  const ph = (((u + P.beam.slope * v) % 1) + 1) % 1, [r0, r1, r2, r3] = P.beam.ramps, [s0, s1, s2, s3] = P.shade.ramps
  c = mixRGB(c, P.beam.color, smooth(r0, r1, ph) * (1 - smooth(r2, r3, ph)) * P.beam.strength)
  // the shade straddles the period's wrap: rising up to it, falling after it
  c = mixRGB(c, P.shade.color, Math.max(smooth(s0, s1, ph), 1 - smooth(s2, s3, ph)) * P.shade.strength)
  const vig = 1 - smooth(P.vignette.edges[0], P.vignette.edges[1], Math.abs(v - P.vignette.centre) * P.vignette.scale)
  const k = 0.95 * (0.8 + vig * 0.25)
  return [c[0] * k, c[1] * k, c[2] * k]
}

/** The curved wall's material: `ARC_PASTEL` in TSL (`arcPastel` is its twin), `userData.periodicU` true. */
function arcPastelMaterial(): MeshStandardNodeMaterial {
  const P = ARC_PASTEL, material = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 })
  material.colorNode = Fn(() => {
    const q = uv()
    let c: ColorNode = mix(vec3(...P.base.low), vec3(...P.base.high), q.y)
    for (const b of P.blobs) {
      const du = q.x.sub(b.at[0]), w = du.sub(floor(du.add(0.5)))
      c = mix(c, vec3(...b.color), float(1).sub(smoothstep(0, b.radius, length(vec2(w, q.y.sub(b.at[1]))))).mul(b.alpha))
    }
    const ph = fract(q.x.add(q.y.mul(P.beam.slope))), [r0, r1, r2, r3] = P.beam.ramps, [s0, s1, s2, s3] = P.shade.ramps
    c = mix(c, vec3(...P.beam.color), smoothstep(r0, r1, ph).mul(float(1).sub(smoothstep(r2, r3, ph))).mul(P.beam.strength))
    c = mix(c, vec3(...P.shade.color), max(smoothstep(s0, s1, ph), float(1).sub(smoothstep(s2, s3, ph))).mul(P.shade.strength))
    const vig = float(1).sub(smoothstep(P.vignette.edges[0], P.vignette.edges[1], abs(q.y.sub(P.vignette.centre)).mul(P.vignette.scale)))
    return c.mul(0.95).mul(float(0.8).add(vig.mul(0.25)))
  })()
  material.userData.periodicU = true
  return material
}

/**
 * The backdrop for a camera that swings round an arc (the spatial scene): the pastel material on the inside of an
 * open cylinder segment about the vertical axis through `center`, `radius` from it and `height` tall. `from` / `to` are
 * angles in radians as a Space's arc measures them: 0 straight back from `center` (towards −z), rightwards positive.
 * u runs along the segment, left to right as seen from inside, one unit every `MAX_U_LENGTH` (32 units, the plane's
 * pastel at twice its size), centred on 0.5 at the segment's middle; v runs up it. The material is the arc's pastel
 * (`ARC_PASTEL`), which repeats seamlessly in u: a segment of any length is covered at that one density, with no end
 * where the colour runs out.
 *
 * Every normal is the plane's (towards +z once `BackSide` turns it): lit by the host key from the front-left, the true
 * inward normals would darken the wall to about a third of its brightness round the curve, while the same light as the
 * plane keeps the pastel as bright all the way round. Neither casts nor receives shadows.
 */
export function createCurvedWall(opts: { center: [number, number, number]; radius: number; from: number; to: number; height: number }): Mesh {
  const { center, radius, from, to, height } = opts
  // three's cylinder puts angle φ at (sin φ, ·, cos φ): the arc's θ (towards (sin θ, ·, −cos θ)) is φ = π − θ, so the
  // segment starts at the right end (θ = to) and u runs right to left: flipped below
  const geometry = new CylinderGeometry(radius, radius, height, Math.max(8, Math.ceil((to - from) / (Math.PI / 96))), 1, true, Math.PI - to, to - from)
  const uvs = geometry.getAttribute('uv'), normals = geometry.getAttribute('normal')
  const span = radius * (to - from) / MAX_U_LENGTH
  for (let i = 0; i < uvs.count; i++) { uvs.setX(i, 0.5 + (0.5 - uvs.getX(i)) * span); normals.setXYZ(i, 0, 0, -1) }
  const material = arcPastelMaterial()
  material.side = BackSide
  const wall = new Mesh(geometry, material)
  wall.name = 'wall'
  wall.position.set(...center)
  wall.castShadow = false
  wall.receiveShadow = false
  return wall
}

/**
 * The host scene's own lights (the UI scene has its lights and environment): a sky/ground hemisphere and a soft,
 * non-shadowing key (1.8, as in `spikes/glass3d/main.ts`) from the top-left front. The key's target is returned too, so
 * it sits in the scene graph. The spike's other light, the studio environment at 0.45, is set by `main.ts` once the
 * renderer is initialised; with both the wall reads as the spike's bright pastel gradient.
 */
export function createHostLights(): Object3D[] {
  const hemi = new HemisphereLight(0xffffff, 0x8899bb, 0.65)
  const key = new DirectionalLight(0xffffff, 1.8)
  key.position.set(-0.9, 3, 5)
  key.castShadow = false
  return [hemi, key, key.target]
}
