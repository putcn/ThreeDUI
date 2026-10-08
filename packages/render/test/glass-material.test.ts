import { describe, it, expect, vi } from 'vitest'
import { uniform } from 'three/tsl'
import { Vector2, Texture, DataTexture, BackSide, FrontSide, Mesh, Scene, PerspectiveCamera, DirectionalLight, HemisphereLight, type BufferGeometry } from 'three'
import { WebGPURenderer, NodeMaterial } from 'three/webgpu'
import { Node, IDENTITY, type GlassInstance, type ResolvedGlass } from '@glassui/core'
import { GlassBatch } from '../src/glass/batch'
import { createGlassMaterial } from '../src/glass/material'

const s = { width: 400, height: 300, ptPerUnit: 100 }
const params: ResolvedGlass = { thickness: 8, fillet: 2.4, filletBottom: 1.6, profile: 'fillet', scatter: 0.05, lift: 0.1, edgeGlow: 0.8, ior: 1.5, dispersion: 0.8, roughness: 0.06, tint: null, absorption: 0, glow: null, cornerExponent: 2, envIntensity: 1, specularIntensity: 1, innerGlow: 0, adaptive: true, variant: 'regular' }
const inst: GlassInstance = { node: new Node('glass'), rect: { x: 10, y: 10, width: 100, height: 40 }, radius: 20, z: 1, params, elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1 }
const surface = { size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(100) }

interface GraphNode { value?: unknown; isTextureNode?: boolean; getChildren(): Iterable<GraphNode> }
/** Every node reachable from `root`, once each (`Node.traverse` revisits shared subgraphs). */
function nodesOf(root: unknown): GraphNode[] {
  const seen = new Set<GraphNode>(), stack = [root as GraphNode]
  while (stack.length) {
    const n = stack.pop()!
    if (seen.has(n)) continue
    seen.add(n)
    for (const c of n.getChildren()) stack.push(c)
  }
  return [...seen]
}

describe('createGlassMaterial', () => {
  it('builds the panel-backdrop variant with the spec flags', () => {
    const b = new GlassBatch(); b.update([inst], s)
    const g = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface, content: new Texture() })
    const m = g.material
    expect(m.transparent).toBe(true); expect(m.depthWrite).toBe(false); expect(m.depthTest).toBe(true)
    expect(m.side).toBe(FrontSide); expect(m.toneMapped).toBe(false)
    expect(m.backdropNode).toBeTruthy(); expect(m.backdropAlphaNode).toBeTruthy(); expect(m.emissiveNode).toBeTruthy()
    expect(m.positionNode).toBeTruthy(); expect(m.normalNode).toBeTruthy(); expect(m.castShadowNode).toBeTruthy()
    expect(m.opacityNode).toBeTruthy()
  })
  it('back side variant and screen backdrop variant build too', () => {
    const b = new GlassBatch(); b.update([inst], s)
    expect(createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'back', surface, content: new Texture() }).material.side).toBe(BackSide)
    const scr = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'screen', side: 'front', surface, depthReject: true })
    expect(scr.material.backdropNode).toBeTruthy()
  })
  it('setContent swaps the sampled texture without rebuilding the material', () => {
    const b = new GlassBatch(); b.update([inst], s)
    const t1 = new Texture(), t2 = new Texture()
    const g = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface, content: t1 })
    const before = g.material.backdropNode
    g.setContent(t2)
    expect(g.material.backdropNode).toBe(before)
    g.setLuma(new Texture(), 8)
    expect(g.material.backdropNode).toBe(before)
  })
  it('requires content for the panel variant', () => {
    const b = new GlassBatch(); b.update([inst], s)
    expect(() => createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface })).toThrow(/content/)
  })

  it('every texture the backdrop samples follows setContent / setLuma (the sampled clones share one base node)', () => {
    const b = new GlassBatch(); b.update([inst], s)
    const t1 = new Texture(), t2 = new Texture(), luma = new Texture()
    const g = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface, content: t1 })
    const sampled = () => nodesOf(g.material.backdropNode).filter(n => n.isTextureNode).map(n => n.value)
    expect(sampled()).toContain(t1)
    g.setContent(t2); g.setLuma(luma, 8)
    expect(sampled()).not.toContain(t1)
    expect(sampled()).toContain(t2); expect(sampled()).toContain(luma)
  })
  it('a screen backdrop never samples a content texture, even when one is passed', () => {
    const b = new GlassBatch(); b.update([inst], s)
    const t = new Texture()
    const g = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'screen', side: 'front', surface, content: t })
    expect(nodesOf(g.material.backdropNode).filter(n => n.isTextureNode).map(n => n.value)).not.toContain(t)
    g.setContent(new Texture())   // a no-op, not an error
  })
  it('fails fast on a geometry missing an instance attribute the fragment needs (three would read zeros)', () => {
    const b = new GlassBatch(); b.update([inst], s)
    b.geometry.deleteAttribute('iTouch')
    expect(() => createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface, content: new Texture() })).toThrow(/iTouch/)
  })
  it('clips through maskNode, so the shadow pass (which reuses it) clips too', () => {
    const b = new GlassBatch(); b.update([inst], s)
    const g = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface, content: new Texture() })
    expect(g.material.maskNode).toBeTruthy()
  })
  it('owns and disposes the default black luma texture, not a caller-supplied one', () => {
    const b = new GlassBatch(); b.update([inst], s)
    const g = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface, content: new Texture() })
    const black = nodesOf(g.material.backdropNode).find(n => n.isTextureNode && n.value instanceof DataTexture)?.value as Texture | undefined
    expect(black).toBeTruthy()
    let disposed = 0
    black!.addEventListener('dispose', () => { disposed++ })
    const mine = new Texture(); let mineDisposed = 0
    mine.addEventListener('dispose', () => { mineDisposed++ })
    g.setLuma(mine, 4)
    g.dispose()
    expect(disposed).toBe(1); expect(mineDisposed).toBe(0)
  })
})

/**
 * Builds a material's real shaders under Node with three's own node builder, the way the renderer does for a mesh
 * (lights, and for `shadowPass` its shadow-map material carrying this material's cast-shadow nodes). The backend never
 * initialises without a GPU, so its two init-time lookups are stubbed. Internal r186 API; the GPU compile itself is
 * the Task 21 browser checkpoint.
 */
function buildShaders(material: NodeMaterial, geometry: BufferGeometry, forceWebGL: boolean, shadowPass = false) {
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
  return { fragment: b.fragmentShader as string, varyings: varyings.map(v => v.name) }
}

describe('glass material shaders (generated under Node)', () => {
  for (const forceWebGL of [false, true]) {
    it(`${forceWebGL ? 'GLSL' : 'WGSL'}: every variant and the shadow pass build within the inter-stage varying budget`, () => {
      // the slab geometry has no `position` attribute on purpose (positionNode replaces it); three warns once per build
      const warnings: string[] = []
      const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')) })
      try {
        const b = new GlassBatch(); b.update([inst], s)
        const make = (backdrop: 'panel' | 'screen', side: 'front' | 'back') =>
          createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop, side, surface, ...(backdrop === 'panel' ? { content: new Texture() } : { depthReject: true }) }).material
        for (const [backdrop, side] of [['panel', 'front'], ['panel', 'back'], ['screen', 'front']] as const) {
          const out = buildShaders(make(backdrop, side), b.geometry, forceWebGL)
          // 11 today (8 packs, the slab normal, three's view position and direction); WebGPU guarantees 16 inter-stage
          // variables and WebGL2 15 varying vectors, and three's runtime extras (fog, log depth…) need room
          expect(out.varyings.length, out.varyings.join(' ')).toBeLessThanOrEqual(12)
          expect(out.fragment).toContain('discard')   // the clip mask
        }
        const shadow = buildShaders(make('panel', 'front'), b.geometry, forceWebGL, true)
        expect(shadow.fragment).toContain('discard')  // clipped glass casts no shadow
      } finally { spy.mockRestore() }
      expect(warnings.filter(w => !w.includes('Vertex attribute "position" not found'))).toEqual([])
    })
  }
})
