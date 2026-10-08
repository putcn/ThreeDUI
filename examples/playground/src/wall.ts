import { DirectionalLight, HemisphereLight, Mesh, PlaneGeometry, type Object3D } from 'three'
import { MeshStandardNodeMaterial, type Node } from 'three/webgpu'
import { Fn, float, length, mix, smoothstep, uv, vec2, vec3 } from 'three/tsl'

type ColorNode = Node<'vec3'>

/**
 * The backdrop wall (ported from `spikes/glass3d/main.ts`): a soft pastel gradient with colour blobs, a diagonal light
 * beam (so refraction has gradients to bend) and a vignette. 16 × 11 units at z = −2.5; it neither casts nor receives
 * shadows. It lives in the host scene, so it is lit by `createHostLights`, not by the UI's lights.
 */
export function createWall(): Mesh {
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
  const wall = new Mesh(new PlaneGeometry(16, 11), material)
  wall.name = 'wall'
  wall.position.z = -2.5
  wall.castShadow = false
  wall.receiveShadow = false
  return wall
}

/**
 * The host scene's own lights (the UI scene has its lights and environment): a sky/ground hemisphere and a soft,
 * non-shadowing key from the top-left front. The key's target is returned too, so it sits in the scene graph.
 */
export function createHostLights(): Object3D[] {
  const hemi = new HemisphereLight(0xffffff, 0x8899bb, 0.65)
  const key = new DirectionalLight(0xffffff, 1.2)
  key.position.set(-0.9, 3, 5)
  key.castShadow = false
  return [hemi, key, key.target]
}
