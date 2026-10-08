import { describe, it, expect } from 'vitest'
import { BackSide, Box3, Mesh, MeshBasicMaterial, Vector3 } from 'three'
import { createStudioScene, createUILights, fitShadowCamera, UI_KEY } from '../src/lighting/lights'

describe('studio scene', () => {
  it('has a back-side room and four emitters', () => {
    const scene = createStudioScene()
    const meshes = scene.children.filter((c): c is Mesh => c instanceof Mesh)
    expect(meshes).toHaveLength(5)
    expect((meshes[0]!.material as MeshBasicMaterial).side).toBe(BackSide)
    expect(meshes.slice(1).every(m => (m.material as MeshBasicMaterial).color.r >= 1)).toBe(true)   // emitters are > 1 (HDR)
  })
})

describe('UI lights', () => {
  it('builds hemi + VSM key light with the spike budget', () => {
    const { group, hemi, key } = createUILights()
    expect(hemi.intensity).toBe(0.65); expect(key.intensity).toBe(UI_KEY.intensity)
    expect(key.castShadow).toBe(true); expect(key.shadow.mapSize.x).toBe(2048); expect(key.shadow.autoUpdate).toBe(false)
    expect(key.shadow.intensity).toBe(0.55); expect(group.children).toContain(key); expect(group.children).toContain(key.target)
    expect(createUILights({ shadowMap: 1024 }).key.shadow.mapSize.x).toBe(1024)
  })
  it('fits the shadow camera to the given world boxes', () => {
    const { group, key } = createUILights()
    group.updateMatrixWorld(true)
    const box = new Box3(new Vector3(-2, -1.5, 0), new Vector3(2, 1.5, 0.2))
    expect(fitShadowCamera(key, [box])).toBe(true)
    const cam = key.shadow.camera
    cam.updateMatrixWorld(true)
    for (const x of [-2, 2]) for (const y of [-1.5, 1.5]) for (const z of [0, 0.2]) {
      const p = new Vector3(x, y, z).applyMatrix4(cam.matrixWorldInverse)
      expect(p.x).toBeGreaterThanOrEqual(cam.left); expect(p.x).toBeLessThanOrEqual(cam.right)
      expect(p.y).toBeGreaterThanOrEqual(cam.bottom); expect(p.y).toBeLessThanOrEqual(cam.top)
      expect(-p.z).toBeGreaterThanOrEqual(cam.near); expect(-p.z).toBeLessThanOrEqual(cam.far)
    }
    expect(key.shadow.needsUpdate).toBe(true)
    expect(cam.right - cam.left).toBeLessThan(8)   // tight: not the spike's fixed ±4
  })
  it('agrees with three’s per-frame shadow update (same orientation, extents untouched)', () => {
    const { group, key } = createUILights()
    group.position.set(0.5, -0.3, 0.1)
    group.updateMatrixWorld(true)
    fitShadowCamera(key, [new Box3(new Vector3(-1, -1, 0), new Vector3(1, 1, 0.1))])
    const cam = key.shadow.camera
    const fitted = { left: cam.left, right: cam.right, top: cam.top, bottom: cam.bottom, near: cam.near, far: cam.far }
    const view = cam.matrixWorld.clone()
    key.shadow.updateMatrices(key)   // what the shadow pass runs before rendering the map
    expect({ left: cam.left, right: cam.right, top: cam.top, bottom: cam.bottom, near: cam.near, far: cam.far }).toEqual(fitted)
    cam.matrixWorld.elements.forEach((v, i) => expect(v).toBeCloseTo(view.elements[i]!, 12))
  })
  it('ignores empty input', () => {
    const { key } = createUILights()
    const before = key.shadow.camera.left, at = key.shadow.camera.position.clone()
    expect(fitShadowCamera(key, [])).toBe(false); expect(fitShadowCamera(key, [new Box3()])).toBe(false)
    expect(key.shadow.camera.left).toBe(before); expect(key.shadow.camera.position.equals(at)).toBe(true)
    expect(key.shadow.needsUpdate).toBe(false)
  })
})
