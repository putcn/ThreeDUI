import { describe, it, expect } from 'vitest'
import { MeshPhysicalNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu'
import { float, vec3, Fn, uniform } from 'three/tsl'
import { InstancedBufferGeometry, InstancedBufferAttribute, Matrix4 } from 'three'

describe('three/webgpu and three/tsl under Node', () => {
  it('builds node materials and TSL graphs without a GPU', () => {
    const m = new MeshPhysicalNodeMaterial()
    m.backdropNode = Fn(() => vec3(0.5))()
    m.backdropAlphaNode = float(1)
    const u = uniform(0.3)
    m.roughnessNode = u
    expect(m.backdropNode).toBeTruthy()
    expect(new MeshBasicNodeMaterial().isNodeMaterial).toBe(true)
    const g = new InstancedBufferGeometry()
    g.setAttribute('iRect', new InstancedBufferAttribute(new Float32Array(8), 4))
    g.instanceCount = 2
    expect(g.instanceCount).toBe(2)
    expect(new Matrix4().identity().elements[0]).toBe(1)
  })
})
