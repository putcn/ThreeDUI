import { describe, it, expect, vi } from 'vitest'
import { uniform, vec4 } from 'three/tsl'
import { Vector2, Texture, DataTexture, BackSide, FrontSide } from 'three'
import { Node, IDENTITY, scaleAbout, GlassUIError, type GlassInstance, type ResolvedGlass } from '@glassui/core'
import { GlassBatch, GLASS_ATTRS } from '../src/glass/batch'
import { createGlassMaterial, pyramidMix, DepthCapture, ScreenCapture } from '../src/glass/material'
import { evalSlabVertex, type SlabInstanceParams } from '../src/glass/slab9'
import { evalNode } from './fixtures/tsl-eval'
import { buildShaders } from './fixtures/build-shaders'

const s = { width: 400, height: 300, ptPerUnit: 100 }
const params: ResolvedGlass = { thickness: 8, fillet: 2.4, filletBottom: 1.6, profile: 'fillet', scatter: 0.05, lift: 0.1, edgeGlow: 0.8, ior: 1.5, dispersion: 0.8, roughness: 0.06, tint: null, absorption: 0, glow: null, cornerExponent: 2, envIntensity: 1, specularIntensity: 1, innerGlow: 0, adaptive: true, variant: 'regular' }
const inst: GlassInstance = { node: new Node('glass'), rect: { x: 10, y: 10, width: 100, height: 40 }, radius: 20, z: 1, params, elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1 }
const surface = { size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(100) }

interface GraphNode {
  constructor: { type?: string }; name?: string; node?: GraphNode; method?: string; aNode?: GraphNode; bNode?: GraphNode
  value?: unknown; isTextureNode?: boolean; getChildren(): Iterable<GraphNode>
}
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
/** A viewport capture node (and the clones a material samples, which resolve through their base). */
interface Capture { getBase(): Capture; getTextureForReference(reference: object | null): Texture }
/** Math arguments arrive wrapped in `VarNode`s; the node behind them. */
const unwrap = (n: GraphNode): GraphNode => n.constructor.type === 'VarNode' ? unwrap(n.node!) : n

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
  it('measures the refraction depth in the slab\'s own frame, whatever its tilt, scale and elevation', () => {
    // a 320 pt capsule under a 3° hover tilt: measured against the mesh plane, its ends would differ by ±8 pt (thickness 8)
    const b = new GlassBatch(8, 8)
    b.update([{ ...inst, rect: { x: 40, y: 100, width: 320, height: 44 }, radius: 22, elevation: 12, transform: scaleAbout(200, 122, 0.8), tilt: { x: 0.0524, y: 0.0524 } }], s)
    const g = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface, content: new Texture() })
    const geom = nodesOf(g.material.backdropNode).find(n => n.constructor.type === 'VaryingNode' && n.name === 'vGlassGeom')!
    const packed = Object.fromEntries(GLASS_ATTRS.map(name => [name, b.buffer.get(0, name)]))
    const [, , width, height] = packed.iRect!, [radius, thickness, fillet, filletBottom] = packed.iShape!
    const p: SlabInstanceParams = { width: width!, height: height!, radius: radius!, thickness: thickness!, fillet: fillet!, filletBottom: filletBottom!, cornerExponent: 2, profile: 0 }
    const slab = b.geometry.getAttribute('slab')
    let worst = 0
    for (let i = 0; i < slab.count; i++) {
      const vert = { ax: slab.getX(i), ay: slab.getY(i), angle: slab.getZ(i), ring: slab.getW(i) }
      const [depth, thick] = evalNode(geom, { ...packed, slab: [vert.ax, vert.ay, vert.angle, vert.ring] })
      worst = Math.max(worst, Math.abs(depth! - evalSlabVertex(vert, p, b.K).position[2]), Math.abs(thick! - thickness))
    }
    expect(worst).toBeLessThan(1e-12)   // slab units: the same units as the thickness Beer–Lambert divides by
  })
  it('a clip collapsed to zero width still clips (only the packed −1 means none)', () => {
    const clipFlag = (clip: GlassInstance['clip']) => {
      const b = new GlassBatch(); b.update([{ ...inst, ...(clip ? { clip } : {}) }], s)
      const g = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface, content: new Texture() })
      const misc = nodesOf(g.material.backdropNode).find(n => n.constructor.type === 'VaryingNode' && n.name === 'vGlassMisc')!
      const flag = nodesOf(misc.node).find(n => n.constructor.type === 'ConditionalNode')!
      return evalNode(flag, Object.fromEntries(GLASS_ATTRS.map(name => [name, b.buffer.get(0, name)])))[0]
    }
    expect(clipFlag(undefined)).toBe(-1)
    expect(clipFlag({ x: 0, y: 0, width: 0, height: 100, radius: 12, transform: IDENTITY })).toBe(0)
    expect(clipFlag({ x: 0, y: 0, width: 200, height: 100, radius: 12, transform: IDENTITY })).toBe(12)
  })
  it('never feeds pow a base that can reach 0 (WGSL pow is exp2(y·log2 x))', () => {
    const b = new GlassBatch(); b.update([inst], s)
    for (const backdrop of ['panel', 'screen'] as const) {
      const m = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop, side: 'front', surface, content: new Texture() }).material
      const pows = [m.backdropNode, m.emissiveNode, m.castShadowNode].flatMap(r => nodesOf(r)).filter(n => n.constructor.type === 'MathNode' && n.method === 'pow')
      expect(pows.length).toBeGreaterThan(0)
      for (const p of pows) {
        const base = unwrap(p.aNode!)
        expect(base.method).toBe('max')
        expect(unwrap(base.bNode!).value as number).toBeGreaterThan(0)
      }
    }
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
  it('disposes the depth copies three made per target for the depth reject, never three\'s shared depth template', () => {
    const b = new GlassBatch(); b.update([inst], s)
    const g = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'screen', side: 'front', surface, depthReject: true })
    const depth = nodesOf(g.material.backdropNode).filter(n => n.constructor.type === 'ViewportDepthTextureNode') as unknown as Capture[]
    expect(depth.length).toBeGreaterThan(0)
    const base = depth[0]!.getBase()
    expect(depth.every(n => n.getBase() === base)).toBe(true)   // one base: one captured depth copy per target
    const sampled = depth.find(n => n !== base)!
    const copies = [sampled.getTextureForReference({}), sampled.getTextureForReference({})]   // two targets drawn into
    const template = base.getTextureForReference(null)
    expect(copies[0]).not.toBe(template)
    const freed: Texture[] = []
    for (const t of [...copies, template]) t.addEventListener('dispose', () => freed.push(t))
    g.dispose()
    expect(new Set(freed)).toEqual(new Set(copies))   // the template is three's, shared by every depth node
  })
  it('reads a given depth capture for the depth reject and never frees it', () => {
    const b = new GlassBatch(); b.update([inst], s)
    const depth = new DepthCapture()
    const g = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'screen', side: 'front', surface, depthReject: true, depth })
    const bases = new Set(nodesOf(g.material.backdropNode).filter(n => n.constructor.type === 'ViewportDepthTextureNode').map(n => (n as unknown as Capture).getBase()))
    expect(bases).toEqual(new Set([depth]))
    const copy = depth.getTextureForReference({} as never)
    let freed = 0
    copy.addEventListener('dispose', () => { freed++ })
    g.dispose()
    expect(freed).toBe(0)
  })
  it('owns and disposes the screen capture it made itself, not one it was given', () => {
    const b = new GlassBatch(); b.update([inst], s)
    const captureOf = (g: ReturnType<typeof createGlassMaterial>) =>
      (nodesOf(g.material.backdropNode).find(n => n.constructor.type === 'ViewportTextureNode') as unknown as Capture).getBase()
    const own = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'screen', side: 'front', surface })
    const copy = captureOf(own).getTextureForReference({})
    let freed = 0
    copy.addEventListener('dispose', () => { freed++ })
    own.dispose()
    expect(freed).toBe(1)
    const shared = new ScreenCapture()
    const given = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'screen', side: 'front', surface, screen: shared })
    expect(captureOf(given)).toBe(shared)
    const sharedCopy = shared.getTextureForReference({} as never)
    let sharedFreed = 0
    sharedCopy.addEventListener('dispose', () => { sharedFreed++ })
    given.dispose()
    expect(sharedFreed).toBe(0)
  })
})

describe('createGlassMaterial: the blur pyramid (high tier)', () => {
  it('blends [sharp, …levels] by roughness: level ⌊k⌋ to ⌈k⌉ at k = roughness · levels, so roughness 1 reaches the last', () => {
    const roughness = uniform(0)
    const blended = pyramidMix(vec4(0), [vec4(1), vec4(2), vec4(3), vec4(4)], roughness)
    const at = (r: number) => { roughness.value = r; return evalNode(blended, {})[0]! }
    for (const [r, k] of [[0, 0], [0.06, 0.24], [0.25, 1], [0.4, 1.6], [0.9, 3.6], [1, 4], [1.5, 4], [-0.2, 0]] as const) expect(at(r)).toBeCloseTo(k, 12)
  })
  it('the panel backdrop samples the content and every pyramid level; setPyramid swaps them in place (same count only)', () => {
    const b = new GlassBatch(); b.update([inst], s)
    const content = new Texture(), levels = [new Texture(), new Texture(), new Texture(), new Texture()]
    const g = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface, content, pyramid: levels })
    const sampled = () => new Set(nodesOf(g.material.backdropNode).filter(n => n.isTextureNode).map(n => n.value))
    for (const t of [content, ...levels]) expect(sampled()).toContain(t)
    const before = g.material.backdropNode, next = levels.map(() => new Texture())
    g.setPyramid(next)
    expect(g.material.backdropNode).toBe(before)
    for (const t of next) expect(sampled()).toContain(t)
    for (const t of levels) expect(sampled()).not.toContain(t)
    expect(() => g.setPyramid(next.slice(1))).toThrow(GlassUIError)
    expect(() => g.setPyramid(next.slice(1))).toThrow(/层数/)
  })
  it('a screen backdrop ignores a pyramid, as it does a content texture', () => {
    const b = new GlassBatch(); b.update([inst], s)
    const levels = [new Texture(), new Texture()]
    const g = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'screen', side: 'front', surface, pyramid: levels })
    const sampled = nodesOf(g.material.backdropNode).filter(n => n.isTextureNode).map(n => n.value)
    for (const t of levels) expect(sampled).not.toContain(t)
    g.setPyramid([])   // it has none: an empty swap is a no-op
  })
})

describe('createGlassMaterial: what lies behind the content plane (panel)', () => {
  it('samples a given screen capture under the content, never owns or frees it, and samples none without one', () => {
    const b = new GlassBatch(); b.update([inst], s)
    const viewports = (g: ReturnType<typeof createGlassMaterial>) => nodesOf(g.material.backdropNode).filter(n => n.constructor.type === 'ViewportTextureNode')
    const plain = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface, content: new Texture() })
    expect(viewports(plain)).toHaveLength(0)
    const shared = new ScreenCapture()
    const g = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface, content: new Texture(), screen: shared, screenLevel: 3.2 })
    expect(new Set(viewports(g).map(n => (n as unknown as Capture).getBase()))).toEqual(new Set([shared]))
    const copy = shared.getTextureForReference({} as never)
    let freed = 0
    copy.addEventListener('dispose', () => { freed++ })
    g.dispose()
    expect(freed).toBe(0)
  })
  it('with the depth reject, the behind sample reads a given depth capture (never freed), else its own; no capture, no depth', () => {
    const b = new GlassBatch(); b.update([inst], s)
    const depthBases = (g: ReturnType<typeof createGlassMaterial>) =>
      new Set(nodesOf(g.material.backdropNode).filter(n => n.constructor.type === 'ViewportDepthTextureNode').map(n => (n as unknown as Capture).getBase()))
    const panel = { geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface, content: new Texture() } as const
    expect(depthBases(createGlassMaterial({ ...panel, depthReject: true })).size).toBe(0)   // nothing behind the plane to reject
    const depth = new DepthCapture()
    const given = createGlassMaterial({ ...panel, screen: new ScreenCapture(), depthReject: true, depth })
    expect(depthBases(given)).toEqual(new Set([depth]))
    const copy = depth.getTextureForReference({} as never)
    let freed = 0
    copy.addEventListener('dispose', () => { freed++ })
    given.dispose()
    expect(freed).toBe(0)
    const own = createGlassMaterial({ ...panel, screen: new ScreenCapture(), depthReject: true })
    const [base] = [...depthBases(own)] as Capture[]
    expect(depthBases(own).size).toBe(1)
    const ownCopy = base!.getTextureForReference({})
    let ownFreed = 0
    ownCopy.addEventListener('dispose', () => { ownFreed++ })
    own.dispose()
    expect(ownFreed).toBe(1)
  })
})

describe('glass material shaders (generated under Node)', () => {
  for (const forceWebGL of [false, true]) {
    it(`${forceWebGL ? 'GLSL' : 'WGSL'}: every variant and the shadow pass build within the inter-stage varying budget`, () => {
      // the slab geometry has no `position` attribute on purpose (positionNode replaces it); three warns once per build
      const warnings: string[] = []
      const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')) })
      try {
        const b = new GlassBatch(); b.update([inst], s)
        // behind: a glass Surface's element glass (the slab's capture under the content), `reject` with its depth too
        // `pyramid`: the high tier's blur pyramid (4 levels) in place of the content's mips
        const make = (backdrop: 'panel' | 'screen', side: 'front' | 'back', behind = false, reject = false, pyramid = false) =>
          createGlassMaterial({
            geometry: b.geometry, K: b.K, backdrop, side, surface,
            ...(backdrop === 'panel'
              ? { content: new Texture(), ...(pyramid ? { pyramid: [1, 2, 3, 4].map(() => new Texture()) } : {}), ...(behind ? { screen: new ScreenCapture(), screenLevel: 3.2, screenLift: 0.1, ...(reject ? { depthReject: true, depth: new DepthCapture() } : {}) } : {}) }
              : { depthReject: true }),
          }).material
        const variants = [
          ['panel', 'front', false, false, false], ['panel', 'back', false, false, false], ['screen', 'front', false, false, false],
          ['panel', 'front', true, false, false], ['panel', 'back', true, false, false], ['panel', 'front', true, true, false], ['panel', 'back', true, true, false],
          ['panel', 'front', false, false, true], ['panel', 'back', true, true, true],
        ] as const
        for (const [backdrop, side, behind, reject, pyramid] of variants) {
          const out = buildShaders(make(backdrop, side, behind, reject, pyramid), b.geometry, forceWebGL)
          // 8 packs, the slab normal, three's view position and direction; WebGPU guarantees 16 inter-stage variables and
          // WebGL2 15 varying vectors, and three's runtime extras (fog, log depth…) need room
          expect(out.varyings.length, out.varyings.join(' ')).toBeLessThanOrEqual(11)
          expect(out.fragment).toContain('discard')   // the clip mask
          // the refraction offset (slab units) is scaled to view units by the packed slab-z-to-view factor
          if (side === 'front') expect(out.fragment).toContain('vGlassMisc.w')
          // what the renderer copies before the draw: the framebuffer with a capture, the depth buffer with the reject
          const copies = out.updateBefore.map(n => n.constructor.type)
          expect(copies.includes('ViewportTextureNode')).toBe(backdrop === 'screen' || behind)
          expect(copies.includes('ViewportDepthTextureNode')).toBe(backdrop === 'screen' || reject)
        }
        for (const [behind, reject] of [[false, false], [true, false], [true, true]] as const) {
          const shadow = buildShaders(make('panel', 'front', behind, reject), b.geometry, forceWebGL, true)
          expect(shadow.fragment).toContain('discard')  // clipped glass casts no shadow
        }
      } finally { spy.mockRestore() }
      expect(warnings.filter(w => !w.includes('Vertex attribute "position" not found'))).toEqual([])
    })
  }
})
