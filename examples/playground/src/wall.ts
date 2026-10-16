import { BackSide, CylinderGeometry, DirectionalLight, HemisphereLight, Mesh, PlaneGeometry, type Object3D } from 'three'
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu'
import { Fn, float, length, mix, smoothstep, uv, vec2, vec3 } from 'three/tsl'

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

/**
 * The backdrop for a camera that swings round an arc (the spatial scene): the pastel material on the inside of an
 * open cylinder segment about the vertical axis through `center`, `radius` from it and `height` tall. `from` / `to` are
 * angles in radians as a Space's arc measures them: 0 straight back from `center` (towards −z), rightwards positive.
 * u runs along the segment, left to right as seen from inside, and v up it, as on the plane; keep the arc length,
 * `radius × (to − from)`, near the plane's 16 units (at most about 32) for the blobs to keep their density.
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
  for (let i = 0; i < uvs.count; i++) { uvs.setX(i, 1 - uvs.getX(i)); normals.setXYZ(i, 0, 0, -1) }
  const material = pastelMaterial()
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
