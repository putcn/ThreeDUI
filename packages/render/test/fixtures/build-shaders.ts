import { Mesh, Scene, PerspectiveCamera, DirectionalLight, HemisphereLight, type BufferGeometry } from 'three'
import { WebGPURenderer, NodeMaterial } from 'three/webgpu'

/**
 * Builds a material's real shaders under Node with three's own node builder, the way the renderer does for a mesh
 * (lights, and for `shadowPass` its shadow-map material carrying this material's cast-shadow nodes). The backend never
 * initialises without a GPU, so its two init-time lookups are stubbed. Internal r186 API; the GPU compile itself is
 * the Task 21 browser checkpoint. `varyings`: the interpolated inter-stage variables, by name.
 */
export function buildShaders(material: NodeMaterial, geometry: BufferGeometry, forceWebGL: boolean, shadowPass = false) {
  const canvas = { width: 300, height: 150, style: {}, addEventListener() {}, removeEventListener() {}, getContext: () => null }
  const renderer = new WebGPURenderer({ canvas: canvas as never, forceWebGL }) as any
  renderer.hasFeature = () => false
  renderer.backend.renderer ??= renderer
  renderer.shadowMap.enabled = true; renderer.shadowMap.transmitted = true   // as UIRoot sets it up (Task 20)
  const mesh = new Mesh(geometry, material), sun = new DirectionalLight(0xffffff, 2), hemi = new HemisphereLight()
  const scene = new Scene().add(mesh, sun, hemi)
  const camera = new PerspectiveCamera(40, 1, 0.1, 100); camera.position.z = 5
  let m = material
  if (shadowPass) {
    const nodes = renderer._getShadowNodes(material)
    m = new NodeMaterial(); (m as any).isShadowPassMaterial = true; m.colorNode = nodes.colorNode; m.positionNode = nodes.positionNode
  }
  const b = renderer.backend.createNodeBuilder(mesh, renderer)
  b.scene = scene; b.material = m; b.camera = camera; b.context.material = m
  if (!shadowPass) { const lights = renderer.lighting.getNode(scene, camera); lights.setLights([sun, hemi]); b.lightsNode = lights }
  b.build()
  const varyings = (b.varyings as { name: string; needsInterpolation: boolean }[]).filter(v => v.needsInterpolation)
  return { vertex: b.vertexShader as string, fragment: b.fragmentShader as string, varyings: varyings.map(v => v.name) }
}
