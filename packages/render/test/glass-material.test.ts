import { describe, it, expect, vi } from 'vitest'
import { uniform, vec2, vec4 } from 'three/tsl'
import { Vector2, Texture, DataTexture, BackSide, Color, FrontSide } from 'three'
import { Node, IDENTITY, scaleAbout, GlassUIError, type GlassInstance, type ResolvedGlass } from '@glassui/core'
import { GlassBatch, GLASS_ATTRS } from '../src/glass/batch'
import { createGlassMaterial, pyramidMix, DepthCapture, ScreenCapture } from '../src/glass/material'
import { evalSlabVertex, type SlabInstanceParams } from '../src/glass/slab9'
import { extrudeSlab, fusedOutline } from '../src/glass/fused'
import { evalNode } from './fixtures/tsl-eval'
import { buildShaders } from './fixtures/build-shaders'
import { FILL, FROST } from '../src/glass/frost'
import type { SurfaceUniforms } from '../src/flat'

const s = { width: 400, height: 300, ptPerUnit: 100 }
const params: ResolvedGlass = { thickness: 8, fillet: 2.4, filletBottom: 1.6, profile: 'fillet', scatter: 0.05, lift: 0.1, edgeGlow: 0.8, ior: 1.5, dispersion: 0.8, roughness: 0.06, tint: null, absorption: 0, glow: null, cornerExponent: 2, envIntensity: 1, specularIntensity: 1, innerGlow: 0, adaptive: true, variant: 'regular' }
const inst: GlassInstance = { node: new Node('glass'), rect: { x: 10, y: 10, width: 100, height: 40 }, radius: 20, z: 1, params, elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1 }
const surface = { size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(100) }
/** A fused-glass batch (`userData.vertex = 'mesh'`): two capsules 8 pt apart, in units (1 / 100), packed with `inst`. */
function fusedBatch(): GlassBatch {
  const shapes = [{ x: 0, y: 0, width: 80, height: 40, radius: 20 }, { x: 88, y: 0, width: 80, height: 40, radius: 20 }]
  const m = extrudeSlab(fusedOutline(shapes, 16), shapes, 16, { thickness: 8, fillet: 2.4, filletBottom: 1.6, minSide: 40 }, 4)
  const b = new GlassBatch({ mesh: { ...m, positions: m.positions.map(v => v / 100) } })
  b.update([inst], s)
  return b
}

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
  it('places a fused mesh (userData.vertex = \'mesh\') by its own positions and the matrix rows, whatever K; never in fill mode', () => {
    const b = fusedBatch()
    const opts = { geometry: b.geometry, K: 99, backdrop: 'panel', side: 'front', surface, content: new Texture() } as const
    const m = createGlassMaterial(opts).material
    // no slab attribute in the vertex stage: the mesh position itself, through the rows
    const attrs = { position: [0.5, -0.1, 0.04], iMat0: [2, 0, 0, 1], iMat1: [0, 2, 0, -1], iMat2: [0, 0, 2, 0.5] }
    expect(evalNode(m.positionNode, attrs)).toEqual([2, -1.2, 0.58])
    expect(() => createGlassMaterial({ ...opts, mode: 'fill' })).toThrow(GlassUIError)
    expect(() => createGlassMaterial({ ...opts, mode: 'fill' })).toThrow('fill 模式不画融合玻璃（应拆回单个玻璃实例）')
    const slab = new GlassBatch(); slab.update([inst], s)
    expect(() => createGlassMaterial({ ...opts, geometry: slab.geometry })).toThrow(/K = 99/)   // the 9-slice still checks K
  })
  it('the press glow: element glass\'s spans its slab uv; a fused slab\'s takes the pressed member\'s extent round the touch (not the whole slab)', () => {
    const glowOf = (material: { emissiveNode: unknown }) => nodesOf(material.emissiveNode).find(n => n.constructor.type === 'VarNode' && n.name === 'glassPressGlow')!
    const gauss = (dx: number, dy: number) => Math.exp(-(dx * dx + dy * dy) / 0.36)
    // a 290 × 52 pt slab (units: / 100) pressed a fifth of its width left of its centre, over a 52 pt member
    const W = 2.9, H = 0.52, u = -0.2, ext = [52 / 290, 1]
    const fused = createGlassMaterial({ geometry: fusedBatch().geometry, K: 0, backdrop: 'panel', side: 'front', surface, content: new Texture() }).material
    const at = (x: number, y: number) => evalNode(glowOf(fused), { position: [x, y, 0.04], iRect: [0, 0, W, H], iTouch: [u, 0, 1, 0.2], iCorner: [ext[0]!, ext[1]!, 0.1, 0.8] })[0]!
    const tx = u * W
    expect(at(tx, 0)).toBeCloseTo(1, 12)                                              // full at the touch
    expect(at(tx + 0.26, 0)).toBeCloseTo(gauss(0.5, 0), 12)                           // half a member away
    expect(at(tx + 0.52, 0)).toBeCloseTo(gauss(1, 0), 12)                             // a member away: ≈ 0.06
    expect(at(tx + 0.52, 0)).toBeLessThan(0.07)
    expect(at(W / 2, 0)).toBeLessThan(1e-6)                                           // the far end stays dark
    expect(at(tx, H / 2)).toBeCloseTo(gauss(0, 0.5), 12)                              // across: the member's own height
    // with the slab's own extent (1, 1: no member known) it spans the slab, as element glass's does
    const whole = evalNode(glowOf(fused), { position: [tx + 0.52, 0, 0.04], iRect: [0, 0, W, H], iTouch: [u, 0, 1, 0.2], iCorner: [1, 1, 0.1, 0.8] })[0]!
    expect(whole).toBeCloseTo(gauss(0.52 / W, 0), 12); expect(whole).toBeGreaterThan(0.9)
    // element glass: in its slab uv from the touch (vGlassGeom pinned: the 9-slice vertex stage is tested on its own)
    const b = new GlassBatch(); b.update([inst], s)
    const slab = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface, content: new Texture() }).material
    const el = (su: number, sv: number) => evalNode(glowOf(slab), { vGlassGeom: [0.04, 0.08, su, sv], iTouch: [0.1, -0.2, 0.5, 0.2] })[0]!
    expect(el(0.6, 0.3)).toBeCloseTo(0.5, 12)
    expect(el(0.9, 0.3)).toBeCloseTo(0.5 * gauss(0.3, 0), 12); expect(el(0.6, 0.8)).toBeCloseTo(0.5 * gauss(0, 0.5), 12)
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

describe('ScreenCapture.latest', () => {
  it('a sampled clone\'s copy is recorded on the base: the canvas target\'s clone (with mips), never the template; null after dispose', () => {
    const capture = new ScreenCapture()
    const tap = capture.sample(vec2(0.5, 0.5)) as unknown as ScreenCapture       // what a material holds
    const canvasTarget = { getDrawingBufferSize: (v: Vector2) => v.set(64, 32) }, copied: { texture: Texture; mips: boolean }[] = []
    const renderer = {
      getRenderTarget: () => null, getCanvasTarget: () => canvasTarget,
      copyFramebufferToTexture: (t: Texture) => { copied.push({ texture: t, mips: t.generateMipmaps }) },
    }
    const frame = { renderer } as never
    expect(capture.latest).toBeNull()
    tap.updateReference(frame); tap.updateBefore(frame)                         // as NodeFrame.updateBeforeNode does
    expect(copied).toHaveLength(1)
    const copy = copied[0]!.texture
    expect(capture.latest).toBe(copy); expect(tap.latest).toBeNull()
    expect(copy).toBe(capture.getTextureForReference(canvasTarget as never))
    expect(copy).not.toBe(capture.getTextureForReference(null))                // r186 renders the canvas as its CanvasTarget
    const image = copy.image as { width: number; height: number }
    expect([image.width, image.height]).toEqual([64, 32]); expect(copied[0]!.mips).toBe(true)
    capture.dispose()
    expect(capture.latest).toBeNull()
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

/** Every node any of `m`'s node slots (`backdropNode`, `castShadowNode`, `maskShadowNode`…) reaches. */
function materialGraph(m: object): GraphNode[] {
  return Object.entries(m).filter(([k, v]) => k.endsWith('Node') && typeof (v as { getChildren?: unknown } | null)?.getChildren === 'function').flatMap(([, v]) => nodesOf(v))
}
const refractions = (m: object) => materialGraph(m).filter(n => n.constructor.type === 'MathNode' && n.method === 'refract').length
/** The fragment-stage varyings pinned for one instance: what the fill, the shadow and its mask read. */
const pins = (o: { opacity?: number; tint?: [number, number, number]; absorption?: number; glow?: [number, number, number, number]; roughness?: number; lift?: number } = {}) => ({
  vGlassMisc: [o.opacity ?? 1, -1, -1, 1],                         // opacity, luma index, clip radius (−1: none), slab → view
  vGlassTint: [...(o.tint ?? [1, 1, 1]), o.absorption ?? 0],
  vGlassGlow: o.glow ?? [0, 0, 0, 0],
  vGlassOptics: [1.5, 0.8, o.roughness ?? 0.06, 0.05],
  vGlassGlow2: [-1, 0.04, o.lift ?? 0.1, 0.8],
  vGlassClip: [0, 0, 10, 10],                                       // well inside a (here absent) clip
  vGlassGeom: [0.08, 0.08, 0.5, 0.5],                               // on the top face of a 0.08-unit slab, at its centre
})

describe('createGlassMaterial: quality modes (spec §5.6)', () => {
  const panel = () => { const b = new GlassBatch(); b.update([inst], s); return { geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface, content: new Texture() } as const }
  const screenOpts = () => { const b = new GlassBatch(); b.update([inst], s); return { geometry: b.geometry, K: b.K, backdrop: 'screen', side: 'front', surface } as const }
  it('fades with the whole Surface: the front face\'s alpha × su.opacity', () => {
    const full = evalNode(createGlassMaterial(panel()).material.opacityNode, pins({ opacity: 0.8 }))[0]!
    const half = evalNode(createGlassMaterial({ ...panel(), surface: { ...surface, opacity: uniform(0.5) } }).material.opacityNode, pins({ opacity: 0.8 }))[0]!
    expect(full).toBeCloseTo(0.8, 6); expect(half).toBeCloseTo(full / 2, 12)
  })
  it('refract (default) bends the ray per colour channel; without dispersion once', () => {
    expect(refractions(createGlassMaterial(panel()).material)).toBe(3)
    expect(refractions(createGlassMaterial({ ...panel(), mode: 'refract' }).material)).toBe(3)
    expect(refractions(createGlassMaterial({ ...panel(), dispersion: false }).material)).toBe(1)
    expect(refractions(createGlassMaterial({ ...screenOpts(), dispersion: false }).material)).toBe(1)
  })
  it('straight (low) never refracts: the content RT (and a glass Surface\'s capture) straight behind the fragment; no depth copy', () => {
    const content = new Texture(), capture = new ScreenCapture()
    const g = createGlassMaterial({ ...panel(), content, mode: 'straight', screen: capture, depthReject: true, depth: new DepthCapture() })
    const graph = materialGraph(g.material)
    expect(refractions(g.material)).toBe(0)
    expect(graph.filter(n => n.isTextureNode).map(n => n.value)).toContain(content)
    expect(new Set(graph.filter(n => n.constructor.type === 'ViewportTextureNode').map(n => (n as unknown as Capture).getBase()))).toEqual(new Set([capture]))
    expect(graph.some(n => n.constructor.type === 'ViewportDepthTextureNode')).toBe(false)   // straight through is what the reject falls back to
    const scr = createGlassMaterial({ ...screenOpts(), mode: 'straight', depthReject: true })
    expect(refractions(scr.material)).toBe(0)
    expect(materialGraph(scr.material).some(n => n.constructor.type === 'ViewportTextureNode')).toBe(true)
    expect(materialGraph(scr.material).some(n => n.constructor.type === 'ViewportDepthTextureNode')).toBe(false)
  })
  it('fill (minimal) samples nothing — no content, pyramid, screen, depth or luma — and owns no capture', () => {
    const content = new Texture(), levels = [new Texture(), new Texture()]
    const variants = [
      createGlassMaterial({ ...panel(), content, pyramid: levels, mode: 'fill', screen: new ScreenCapture(), depthReject: true, depth: new DepthCapture(), luma: new Texture() }),
      createGlassMaterial({ ...screenOpts(), mode: 'fill', depthReject: true }),
    ]
    for (const g of variants) {
      const graph = materialGraph(g.material)
      expect(graph.filter(n => n.isTextureNode)).toEqual([])
      expect(refractions(g.material)).toBe(0)
      g.setContent(new Texture()); g.setLuma(new Texture(), 4); g.setPyramid([])   // no-ops
      expect(materialGraph(g.material).filter(n => n.isTextureNode)).toEqual([])
      g.dispose()
    }
  })
  it('fill: the glow colour, else the tint, else the given fill — as is, not frosted or absorbed — near-opaque, the lit shell the same', () => {
    const fill = new Color(0.9, 0.8, 0.7)
    const m = createGlassMaterial({ ...panel(), mode: 'fill', fill }).material
    expect(evalNode(m.backdropAlphaNode, pins())[0]).toBeCloseTo(FILL.alpha, 12)
    const at = (p: Parameters<typeof pins>[0]) => evalNode(m.backdropNode, pins(p))
    const close = (got: number[], want: readonly number[]) => got.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 12))
    close(at({}), [0.9, 0.8, 0.7])                                          // plain glass: the fill
    close(at({ roughness: 0.5, lift: 0.3, absorption: 2 }), [0.9, 0.8, 0.7]) // its frost and absorption do not wash it out
    close(at({ tint: [0.2, 0.5, 0.9], absorption: 0 }), [0.2, 0.5, 0.9])     // tinted: the tint
    close(at({ tint: [0.2, 0.5, 0.9], glow: [0.15, 0.12, 0.9, 1.1] }), [0.15, 0.12, 0.9])   // glowing: the glow colour, tint or not
    close(at({ glow: [0.15, 0.12, 0.9, 0] }), [0.9, 0.8, 0.7])                // a glow of strength 0 is none
    close(evalNode(m.colorNode, pins({ glow: [0.15, 0.12, 0.9, 1.1] })), [0.15, 0.12, 0.9])   // the 8 % lit shell under it: the same colour
    close(evalNode(createGlassMaterial({ ...panel(), mode: 'fill' }).material.backdropNode, pins()), [1, 1, 1])   // default: white
  })
  it('fill border: a FILL.borderPt band inside the outline in the border colour, the fill inside it; none without a border', () => {
    const fill = new Color(0.96, 0.96, 0.96), border = new Color(0.25, 0.25, 0.3)
    const m = createGlassMaterial({ ...panel(), mode: 'fill', fill, border }).material
    // a 100 × 40 pt capsule-ish slab (radius 20 pt) at 100 pt per unit; the slab uv u = 1 − x/100 is x pt in from its right edge
    const outline = { vGlassOutline: [0.5, 0.2, 0.2, 2] }
    const at = (u: number, v = 0.5, p: Parameters<typeof pins>[0] = {}) =>
      evalNode(m.backdropNode, { ...pins(p), vGlassGeom: [0.08, 0.08, u, v], ...outline }, undefined, 0.2)   // fwidth: 0.2 pt per pixel
    const close = (got: number[], want: Color) => got.forEach((x, i) => expect(x).toBeCloseTo([want.r, want.g, want.b][i]!, 9))
    close(at(1), border)                                                    // on the outline (the side wall)
    close(at(1 - 0.5 / 100), border)                                        // ½ pt in: the band
    close(at(1 - 2 / 100), fill)                                            // 2 pt in: past it
    close(at(0.5), fill)                                                    // the centre
    close(at(0.5, 1 - 0.5 / 40), border)                                    // ½ pt below the top edge
    // the band's inner edge, 1 pt in, is its antialiasing midpoint
    at(1 - FILL.borderPt / 100).forEach((x, i) => expect(x).toBeCloseTo(([fill.r, fill.g, fill.b][i]! + [border.r, border.g, border.b][i]!) / 2, 9))
    close(at(1 - 0.5 / 100, 0.5, { glow: [0.15, 0.12, 0.9, 1.1] }), border)  // a glowing control keeps it
    // ½ pt in from the rounded corner's diagonal: the band follows the corner
    const r = 0.2, c = [0.5 - r + (r - 0.005) * Math.SQRT1_2, 0.2 - r + (r - 0.005) * Math.SQRT1_2]
    close(at(c[0]! + 0.5, c[1]! / 0.4 + 0.5), border)
    // the slab (no border): fill to the edge
    const plain = createGlassMaterial({ ...panel(), mode: 'fill', fill }).material
    close(evalNode(plain.backdropNode, { ...pins(), vGlassGeom: [0.08, 0.08, 1, 0.5] }), fill)
  })
  it('fill border is the last word on its band: the border colour, opaque, with no specular, env or glow over it', () => {
    const fill = new Color(0.96, 0.96, 0.96), border = new Color(0.25, 0.25, 0.3)
    const m = createGlassMaterial({ ...panel(), mode: 'fill', fill, border }).material
    const at = (u: number, p: Parameters<typeof pins>[0] = {}) => ({ ...pins(p), vGlassGeom: [0.08, 0.08, u, 0.5], vGlassOutline: [0.5, 0.2, 0.2, 2] })
    const ev = (n: unknown, u: number, p: Parameters<typeof pins>[0] = {}) => evalNode(n, at(u, p), undefined, 0.2)
    // the output is totalDiffuse (the backdrop, at backdrop alpha 1) + specular (× specularIntensity) + emissive: so with
    // alpha 1, intensity 0 and the emissive scaled to 0 the band is exactly its colour, glowing control or not
    const emissive = unwrap(m.emissiveNode as unknown as GraphNode) as GraphNode & { op?: string }
    expect(emissive.op).toBe('*')                                           // the whole emissive, scaled by what the band keeps
    for (const glow of [[0, 0, 0, 0], [0.15, 0.12, 0.9, 1.1]] as const) {
      const p = { glow: [...glow] as [number, number, number, number], tint: [0.6, 0.6, 1] as [number, number, number] }
      for (const u of [1, 1 - 0.5 / 100]) {                                 // on the outline, ½ pt in
        ev(m.backdropNode, u, p).forEach((x, i) => expect(x).toBeCloseTo([border.r, border.g, border.b][i]!, 12))
        expect(ev(m.backdropAlphaNode, u, p)[0]).toBe(1)
        expect(ev(m.specularIntensityNode, u, p)[0]).toBe(0)
        expect(ev(emissive.bNode, u, p)[0]).toBe(0)
      }
      // inside: the fill as before, near-opaque, with its specular and glow
      expect(ev(m.backdropAlphaNode, 0.5, p)[0]).toBeCloseTo(FILL.alpha, 12)
      expect(ev(m.specularIntensityNode, 0.5, p)[0]).toBe(1); expect(ev(emissive.bNode, 0.5, p)[0]).toBe(1)
    }
    // the slab (no border) keeps the material's own specular intensity and an unscaled emissive
    const plain = createGlassMaterial({ ...panel(), mode: 'fill', fill }).material
    expect(plain.specularIntensityNode).toBeNull()
    expect(evalNode(plain.backdropAlphaNode, pins())[0]).toBeCloseTo(FILL.alpha, 12)
  })
  it('fill border is 1 pt on a screen Surface (1 pt per unit) and a world one (244), and never under FILL.borderMinPx pixels', () => {
    const border = new Color(0.25, 0.25, 0.3), fill = new Color(1, 1, 1)
    const b = new GlassBatch(); b.update([inst], s)
    for (const ppu of [1, 244]) {
      const m = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface: { size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(ppu) }, content: new Texture(), mode: 'fill', fill, border }).material
      // a 100 × 40 pt slab, radius 20 pt, in this Surface's units; u = 1 − x/100 is x pt in from its right edge
      const outline = [50 / ppu, 20 / ppu, 20 / ppu, 2]
      const band = (xPt: number, ptPerPx: number) => evalNode(m.backdropNode, { ...pins(), vGlassGeom: [0.08, 0.08, 1 - xPt / 100, 0.5], vGlassOutline: outline }, undefined, ptPerPx)[0]!
      const t = (x: number) => (1 - x) / (1 - border.r)                      // the red channel → band coverage
      // a sharp view (5 px per pt): exactly 1 pt
      expect(t(band(0.5, 0.2))).toBeCloseTo(1, 9); expect(t(band(1, 0.2))).toBeCloseTo(0.5, 9); expect(t(band(1.5, 0.2))).toBeCloseTo(0, 9)
      // a Surface drawn at 0.8 px per pt (1.25 pt per px): 2 px = 2.5 pt, so one pixel is solid border whatever its phase
      expect(t(band(2, 1.25))).toBeCloseTo(1, 9); expect(t(band(2.5, 1.25))).toBeCloseTo(0.5, 9); expect(t(band(3, 1.25))).toBeCloseTo(0, 9)
    }
  })
  it('keeps the edge glow, the glow layer and the clip in every mode', () => {
    for (const mode of ['refract', 'straight', 'fill'] as const) {
      const m = createGlassMaterial({ ...panel(), mode }).material
      expect(m.emissiveNode).toBeTruthy(); expect(m.maskNode).toBeTruthy(); expect(m.castShadowNode).toBeTruthy()
    }
  })
})

describe('createGlassMaterial: the transmitted shadow fades with the glass (I5)', () => {
  const make = (su: SurfaceUniforms = surface) => { const b = new GlassBatch(); b.update([inst], s); return createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface: su, content: new Texture() }).material }
  it('casts its colour by opacity: white (nothing) at 0, the full transmitted colour at 1', () => {
    const m = make()
    const shadow = (p: Parameters<typeof pins>[0]) => evalNode(m.castShadowNode, pins(p))
    const neutral = [0.78, 0.78, 0.84]
    shadow({ opacity: 1 }).forEach((v, i) => expect(v).toBeCloseTo([...neutral, 1][i]!, 6))
    shadow({ opacity: 0 }).forEach(v => expect(v).toBeCloseTo(1, 12))
    shadow({ opacity: 0.5 }).forEach((v, i) => expect(v).toBeCloseTo([...neutral.map(c => (1 + c) / 2), 1][i]!, 6))
    // a glowing slab: its glow colour, faded the same way
    const glow = [0.2, 0.4, 1] as const
    shadow({ opacity: 0.5, glow: [...glow, 1] }).slice(0, 3).forEach((v, i) => expect(v).toBeCloseTo((1 + (neutral[i]! * 0.4 + glow[i]! * 0.6)) / 2, 6))
  })
  it('a glass faded to (almost) nothing writes no shadow: the shadow mask drops opacity ≤ 0.01, and still clips', () => {
    const m = make()
    expect(m.maskShadowNode).toBeTruthy()
    const mask = (p: Parameters<typeof pins>[0], clip?: number[]) => evalNode(m.maskShadowNode, { ...pins(p), ...(clip ? { vGlassClip: clip } : {}) })[0]
    expect(mask({ opacity: 1 })).toBe(1); expect(mask({ opacity: 0.02 })).toBe(1)
    expect(mask({ opacity: 0.01 })).toBe(0); expect(mask({ opacity: 0 })).toBe(0)
    // a clip (radius 2 here, via the pinned misc) outside of which nothing casts either
    const clipped = (inside: boolean) => evalNode(m.maskShadowNode, { ...pins(), vGlassMisc: [1, -1, 2, 1], vGlassClip: [inside ? 0 : 50, 0, 10, 10] })[0]
    expect(clipped(true)).toBe(1); expect(clipped(false)).toBe(0)
  })
  it('fades with the whole Surface too (su.opacity): a stacked Block\'s glass shadows other Surfaces\' content', () => {
    const full = make(), faded = make({ ...surface, opacity: uniform(0.5) })
    // the darkening (1 − colour) is what the opacity scales
    const dark = (m: ReturnType<typeof make>) => evalNode(m.castShadowNode, pins({ opacity: 0.8 })).slice(0, 3).map(v => 1 - v)
    const f = dark(full), h = dark(faded)
    f.forEach((v, i) => { expect(v).toBeGreaterThan(0); expect(h[i]).toBeCloseTo(v / 2, 12) })
    const mask = (m: ReturnType<typeof make>, opacity: number) => evalNode(m.maskShadowNode, pins({ opacity }))[0]
    expect(mask(full, 0.015)).toBe(1); expect(mask(faded, 0.015)).toBe(0)   // 0.0075 ≤ 0.01: nothing cast
  })
})

describe('glass material shaders (generated under Node)', () => {
  for (const forceWebGL of [false, true]) {
    it(`${forceWebGL ? 'GLSL' : 'WGSL'}: every variant and the shadow pass build within the inter-stage varying budget`, () => {
      // the slab geometry has no `position` attribute on purpose (positionNode replaces it); three warns once per build
      const warnings: string[] = []
      const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')) })
      try {
        const slab = new GlassBatch(); slab.update([inst], s)
        const fused = fusedBatch()
        // behind: a glass Surface's element glass (the slab's capture under the content), `reject` with its depth too
        // `pyramid`: the high tier's blur pyramid (4 levels) in place of the content's mips
        type Mode = 'refract' | 'straight' | 'fill'
        const make = (b: GlassBatch, backdrop: 'panel' | 'screen', side: 'front' | 'back', behind = false, reject = false, pyramid = false, mode: Mode = 'refract', dispersion = true) =>
          createGlassMaterial({
            geometry: b.geometry, K: b.K, backdrop, side, surface, mode, dispersion, fill: new Color(0.9, 0.9, 0.92), ...(backdrop === 'panel' ? { border: new Color(0.27, 0.27, 0.31) } : {}),
            ...(backdrop === 'panel'
              ? { content: new Texture(), ...(pyramid ? { pyramid: [1, 2, 3, 4].map(() => new Texture()) } : {}), ...(behind ? { screen: new ScreenCapture(), screenLevel: 3.2, screenLift: 0.1, ...(reject ? { depthReject: true, depth: new DepthCapture() } : {}) } : {}) }
              : { depthReject: true }),
          }).material
        const variants: [backdrop: 'panel' | 'screen', side: 'front' | 'back', behind: boolean, reject: boolean, pyramid: boolean, mode?: Mode, dispersion?: boolean][] = [
          ['panel', 'front', false, false, false], ['panel', 'back', false, false, false], ['screen', 'front', false, false, false],
          ['panel', 'front', true, false, false], ['panel', 'back', true, false, false], ['panel', 'front', true, true, false], ['panel', 'back', true, true, false],
          ['panel', 'front', false, false, true], ['panel', 'back', true, true, true],
          // medium without dispersion, low (straight) and minimal (fill), with and without what lies behind the plane
          ['panel', 'front', true, false, false, 'refract', false], ['screen', 'front', false, false, false, 'refract', false],
          ['panel', 'front', false, false, false, 'straight'], ['panel', 'front', true, true, false, 'straight'], ['panel', 'back', true, false, false, 'straight'], ['screen', 'front', false, false, false, 'straight'],
          ['panel', 'front', false, false, false, 'fill'], ['panel', 'front', true, true, true, 'fill'], ['panel', 'back', true, false, false, 'fill'], ['screen', 'front', false, false, false, 'fill'], ['screen', 'back', false, false, false, 'fill'],
        ]
        let slabVaryings = 0
        for (const [backdrop, side, behind, reject, pyramid, mode = 'refract', dispersion = true] of variants) for (const b of [slab, fused]) {
          // fused glass draws in every mode but 'fill' (there a cluster's members draw singly, with their rims)
          if (b === fused && mode === 'fill') continue
          const label = `${b === fused ? 'fused ' : ''}${backdrop} ${side} ${mode}${behind ? ' behind' : ''}${reject ? ' reject' : ''}${pyramid ? ' pyramid' : ''}${dispersion ? '' : ' no-dispersion'}`
          const out = buildShaders(make(b, backdrop, side, behind, reject, pyramid, mode, dispersion), b.geometry, forceWebGL)
          // 8 packs, the slab normal, three's view position and direction; WebGPU guarantees 16 inter-stage variables and
          // WebGL2 15 varying vectors, and three's runtime extras (fog, log depth…) need room
          expect(out.varyings.length, `${label}: ${out.varyings.join(' ')}`).toBeLessThanOrEqual(11)
          // the fused mesh costs no varying the same variant's 9-slice slab does not (three lights a geometry with a
          // `normal` attribute differently, spending one on it: createFusedGeometry)
          if (b === slab) slabVaryings = out.varyings.length
          else expect(out.varyings.length, label).toBe(slabVaryings)
          expect(out.fragment, label).toContain('discard')   // the clip mask
          // element glass on minimal: its outline's shape for the border band, in the varying the view position left
          expect(out.varyings.includes('vGlassOutline'), label).toBe(mode === 'fill' && backdrop === 'panel')
          // the refraction offset (slab units) is scaled to view units by the packed slab-z-to-view factor
          if (side === 'front' && mode === 'refract') expect(out.fragment, label).toContain('vGlassMisc.w')
          // what the renderer copies before the draw: the framebuffer with a capture (never on fill), the depth buffer
          // with the reject (refract only: straight through is what the reject falls back to)
          const copies = out.updateBefore.map(n => n.constructor.type)
          expect(copies.includes('ViewportTextureNode'), label).toBe(mode !== 'fill' && (backdrop === 'screen' || behind))
          expect(copies.includes('ViewportDepthTextureNode'), label).toBe(mode === 'refract' && (backdrop === 'screen' || reject))
        }
        for (const [behind, reject, mode] of [[false, false, 'refract'], [true, false, 'refract'], [true, true, 'refract'], [true, false, 'straight'], [false, false, 'fill']] as const) for (const b of [slab, fused]) {
          if (b === fused && mode === 'fill') continue
          const shadow = buildShaders(make(b, 'panel', 'front', behind, reject, false, mode), b.geometry, forceWebGL, true)
          expect(shadow.fragment).toContain('discard')  // clipped (or faded-out) glass casts no shadow
          expect(shadow.varyings.length).toBeLessThanOrEqual(11)
        }
      } finally { spy.mockRestore() }
      expect(warnings.filter(w => !w.includes('Vertex attribute "position" not found'))).toEqual([])
    })
  }
})
