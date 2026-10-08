import { InstancedBufferGeometry, Float32BufferAttribute, Sphere, Vector3 } from 'three'

/** A unit quad (x, y ∈ [−0.5, 0.5]) every instanced flat element scales by its own size in the vertex stage. */
export function createQuadGeometry(): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3))
  g.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
  g.setIndex([0, 1, 2, 0, 2, 3])
  // the instances place the quad anywhere on the Surface: never cull the mesh by the unit quad's own extent
  g.boundingSphere = new Sphere(new Vector3(), 1e6)
  return g
}
