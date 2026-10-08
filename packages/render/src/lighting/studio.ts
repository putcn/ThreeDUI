// Procedural studio environment for glass highlights (ported from spikes/glass3d/studio.ts).
// A dim gradient room + a large softbox top-left + a thin strip light below,
// so bevels pick up a crisp bright rim line (top) and a faint lower rim.

import { Scene, Mesh, BoxGeometry, PlaneGeometry, MeshBasicMaterial, BackSide, Color, type Texture } from 'three'
import { PMREMGenerator } from 'three/webgpu'

export function createStudioScene(): Scene {
  const scene = new Scene()
  const room = new Mesh(new BoxGeometry(20, 20, 20), new MeshBasicMaterial({ color: new Color(0.22, 0.23, 0.26), side: BackSide }))
  scene.add(room)
  const light = (w: number, h: number, intensity: number, pos: [number, number, number], look: [number, number, number], color = new Color(1, 1, 1)): void => {
    const m = new Mesh(new PlaneGeometry(w, h), new MeshBasicMaterial({ color: color.clone().multiplyScalar(intensity) }))
    m.position.set(...pos)
    m.lookAt(...look)
    scene.add(m)
  }
  // key softbox: top-left-front
  light(7, 4, 7, [-5, 6, 5], [0, 0, 0], new Color(1, 0.98, 0.95))
  // fill: right-front, cooler and weaker
  light(4, 6, 2.2, [7, 2, 4], [0, 0, 0], new Color(0.9, 0.95, 1))
  // thin strip below: gives the lower rim a faint line
  light(10, 0.6, 3, [0, -6, 3], [0, 0, 0])
  // small hot spot top for a sharp glint
  light(1.2, 0.5, 18, [-1, 7, 2], [0, 0, 0])
  return scene
}

/**
 * The PMREM of the studio scene for `scene.environment` (spec §5.3: a uniform room cannot produce the top glint).
 * Browser only: needs an initialised WebGPURenderer (`await renderer.init()` first — r186's `fromScene` throws otherwise).
 * The returned texture outlives the generator; the caller disposes it.
 */
export function createStudioEnvironment(renderer: { isWebGPURenderer?: boolean }): Texture {
  const pmrem = new PMREMGenerator(renderer as never)
  const tex = pmrem.fromScene(createStudioScene(), 0.02).texture
  pmrem.dispose()
  return tex
}
