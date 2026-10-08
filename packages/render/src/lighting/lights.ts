import { Box3, DirectionalLight, Group, HemisphereLight, Vector3 } from 'three'
export { createStudioScene, createStudioEnvironment } from './studio'

export const UI_ENV_INTENSITY = 0.45
export const UI_HEMI = { sky: 0xffffff, ground: 0x8899bb, intensity: 0.65 } as const
export const UI_KEY = { intensity: 1.8, position: [-0.9, 3.0, 5.0] as const, shadowIntensity: 0.55, radius: 7, blurSamples: 16, bias: -0.0005 } as const

/** Spec §5.3/§5.4 light budget (≈1 without tone mapping) and the VSM key light that casts the UI's shadows. */
export function createUILights(opts: { shadowMap?: number } = {}): { group: Group; hemi: HemisphereLight; key: DirectionalLight } {
  const group = new Group(); group.name = 'ui-lights'
  const hemi = new HemisphereLight(UI_HEMI.sky, UI_HEMI.ground, UI_HEMI.intensity)
  const key = new DirectionalLight(0xffffff, UI_KEY.intensity)
  key.position.set(...UI_KEY.position)
  key.castShadow = true
  const size = opts.shadowMap ?? 2048
  key.shadow.mapSize.set(size, size)
  key.shadow.radius = UI_KEY.radius; key.shadow.blurSamples = UI_KEY.blurSamples; key.shadow.bias = UI_KEY.bias
  key.shadow.intensity = UI_KEY.shadowIntensity
  key.shadow.camera.near = 0.05; key.shadow.camera.far = 20
  key.shadow.autoUpdate = false
  group.add(hemi, key, key.target)
  return { group, hemi, key }
}

const corners = Array.from({ length: 8 }, () => new Vector3())
const lightSpace = new Box3()
const targetWorld = new Vector3()

/**
 * Fits the ortho shadow camera to `boxes` (world space); returns false when there is nothing to fit.
 * Only the extents (left/right/top/bottom/near/far) are ours: the shadow pass re-runs `shadow.updateMatrices(key)`
 * before each map render, which re-aims the camera from the light to its target exactly as done here and never
 * touches the extents, so the fit holds until the next call. Boxes must cover receivers as well as casters —
 * anything past `far` (or outside the sides) samples as unshadowed.
 */
export function fitShadowCamera(key: DirectionalLight, boxes: readonly Box3[], margin = 0.2): boolean {
  if (boxes.every(b => b.isEmpty())) return false
  const cam = key.shadow.camera
  key.updateWorldMatrix(true, false); key.target.updateWorldMatrix(true, false)
  cam.position.setFromMatrixPosition(key.matrixWorld)
  cam.lookAt(targetWorld.setFromMatrixPosition(key.target.matrixWorld))
  cam.updateMatrixWorld(true)
  lightSpace.makeEmpty()
  for (const b of boxes) {
    if (b.isEmpty()) continue
    let i = 0
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) lightSpace.expandByPoint(corners[i++]!.set(x, y, z).applyMatrix4(cam.matrixWorldInverse))
  }
  cam.left = lightSpace.min.x - margin; cam.right = lightSpace.max.x + margin
  cam.bottom = lightSpace.min.y - margin; cam.top = lightSpace.max.y + margin
  cam.near = Math.max(0.05, -lightSpace.max.z - margin); cam.far = -lightSpace.min.z + margin
  cam.updateProjectionMatrix()
  key.shadow.needsUpdate = true
  return true
}
