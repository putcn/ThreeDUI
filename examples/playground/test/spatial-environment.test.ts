import { describe, expect, it } from 'vitest'
import { DoubleSide, Mesh, MeshStandardMaterial, PlaneGeometry } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { createAuroraVolume, createSpatialFloor } from '../src/spatial-environment'

describe('the spatial scene environment', () => {
  it('adds a real horizontal floor beneath the views', () => {
    const floor = createSpatialFloor([0, -4, 24])
    expect(floor).toBeInstanceOf(Mesh)
    expect(floor.name).toBe('spatial-floor')
    expect(floor.position.toArray()).toEqual([0, -4, 24])
    expect(floor.rotation.x).toBeCloseTo(-Math.PI / 2)
    expect((floor.geometry as PlaneGeometry).parameters).toMatchObject({ width: 80, height: 64 })
    expect((floor.material as MeshStandardMaterial).roughness).toBeGreaterThan(0.7)
    expect(floor.children).toHaveLength(0)
    expect((floor.material as MeshStandardNodeMaterial).opacityNode).toBeDefined()
    floor.geometry.dispose(); (floor.material as MeshStandardMaterial).dispose()
  })

  it('builds layered, curved, translucent aurora sheets that drift together in space', () => {
    const volume = createAuroraVolume([0, 0, 24])
    expect(volume.group.name).toBe('aurora-volume')
    expect(volume.group.children).toHaveLength(3)
    for (const child of volume.group.children) {
      expect(child).toBeInstanceOf(Mesh)
      const mesh = child as Mesh
      const position = mesh.geometry.getAttribute('position')
      const texcoords = mesh.geometry.getAttribute('uv')
      const material = mesh.material as MeshStandardNodeMaterial
      expect(new Set(Array.from({ length: position.count }, (_, i) => position.getZ(i))).size).toBeGreaterThan(4)
      expect(texcoords.count).toBe(position.count)
      expect(material).toBeInstanceOf(MeshStandardNodeMaterial)
      expect(material.transparent).toBe(true)
      expect(material.opacity).toBeGreaterThanOrEqual(0.07)
      expect(material.opacityNode).toBeDefined()
      expect(material.side).toBe(DoubleSide)
      expect(material.depthWrite).toBe(false)
    }
    const before = volume.group.position.x
    volume.update(10, false)
    expect(volume.group.position.x).not.toBe(before)
    const frozen = volume.group.position.clone()
    volume.update(20, true)
    expect(volume.group.position.toArray()).toEqual(frozen.toArray())
    volume.dispose()
    expect(volume.group.children).toHaveLength(0)
  })
})
