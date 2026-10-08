import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { CustomBlending, Group, Mesh, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, Texture } from 'three'
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import { Node, createYogaLayout, AnimationRuntime, defaultTheme as theme } from '@glassui/core'
import { SystemFontEngine } from '@glassui/text'
import { Surface, createContentMaterial, type SurfaceContext } from '../src/surface/surface'
import { AtlasPages } from '../src/text/pages'
import { createMeasureFn } from '../src/text/measure'
import { REFLECTION_STRENGTH } from '../src/glass/batch'
import { srgbToLinear } from '../src/color'
import { buildShaders } from './fixtures/build-shaders'

let ctx: SurfaceContext
beforeAll(async () => {
  const text = new SystemFontEngine({ createCanvas: ((w: number, h: number) => createCanvas(w, h)) as never, pageSize: 512, maxPages: 2 })
  ctx = { theme, scheme: 'light', layout: await createYogaLayout(), measure: createMeasureFn(text, theme, 'light'), anim: new AnimationRuntime(theme, 'light'), text, pages: new AtlasPages(text.atlas), quality: { contentType: 'byte', contentScale: 1, backFaces: true, depthReject: true } }
})

function signup(c: SurfaceContext = ctx) {
  const s = new Surface({ id: 'f', width: 400, height: 300, ptPerUnit: 100 }, c)
  const card = new Node('box', 'card'); card.setStyle({ position: 'absolute', left: 20, top: 20, width: 360, height: 260, bg: 'fill', radius: 'xl' })
  const title = new Node('text', 'title'); title.setProp('value', '创建账号'); title.setStyle({ position: 'absolute', left: 20, top: 20, fontSize: 'xl' })
  const btn = new Node('glass', 'btn'); btn.setStyle({ position: 'absolute', left: 20, top: 180, width: 320, height: 48, radius: 'capsule', glass: { glow: { color: 'accent', strength: 1.1 } }, transition: { scale: 'snappy' }, pressed: { scale: 0.96 } })
  const label = new Node('text', 'label'); label.setProp('value', 'Create account'); label.setStyle({ width: '100%', height: '100%', textAlign: 'center', color: 'fill' })
  s.root.appendChild(card); card.appendChild(title); card.appendChild(btn); btn.appendChild(label)
  return { s, btn, label }
}

const stubRenderer = () => ({ setRenderTarget: vi.fn(), render: vi.fn(), setClearColor: vi.fn(), getClearColor: vi.fn(c => c), getClearAlpha: vi.fn(() => 1) })
const meshes = (o: { children: unknown[] }) => o.children.filter((c): c is Mesh => c instanceof Mesh)

interface GraphNode { value?: unknown; isTextureNode?: boolean; constructor: { type?: string }; getBase?(): unknown; getChildren(): Iterable<GraphNode> }
/** Every node reachable from `root`, once each. */
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

describe('Surface', () => {
  it('builds the object graph and fills batches on tick', () => {
    const { s } = signup()
    s.tick(1 / 60)
    expect(s.error).toBeNull()
    expect(s.contentMesh.scale.x).toBeCloseTo(4); expect(s.contentMesh.scale.y).toBeCloseTo(3)
    expect(s.glass.buffer.count).toBe(1)
    expect(s.rims.buffer.count).toBe(1); expect(s.pools.buffer.count).toBe(1); expect(s.panels.buffer.count).toBe(1)
    expect(s.foregroundText.glyphCount).toBe('Create account'.replace(/ /g, '').length)
    expect(s.contentText.glyphCount).toBe(4)
    const order = meshes(s).map(c => c.renderOrder)
    expect(order).toContain(0); expect(order).toContain(2)
    expect(s.contentDirty).toBe(true)
  })
  it('tick is idempotent when nothing changed, and animation keeps needsFrame', () => {
    const { s, btn } = signup()
    s.tick(1 / 60); s.contentDirty = false
    s.tick(1 / 60)
    expect(s.contentDirty).toBe(false); expect(s.needsFrame).toBe(false)
    btn.setState({ pressed: true }); s.tick(1 / 60)
    expect(s.needsFrame).toBe(true); expect(s.contentDirty).toBe(true)
  })
  it('prepare sizes the RT in steps and renders the content pass when dirty', () => {
    const { s } = signup()
    s.tick(1 / 60)
    const renderer = stubRenderer()
    s.prepare(renderer, { width: 400, height: 300 }, 2)
    expect(s.contentPass.target.width).toBe(832); expect(s.contentPass.target.height).toBe(640)
    expect(renderer.render).toHaveBeenCalledTimes(1); expect(s.contentDirty).toBe(false)
    s.prepare(renderer, { width: 400, height: 300 }, 2)
    expect(renderer.render).toHaveBeenCalledTimes(1)
    s.prepare(renderer, { width: 800, height: 300 }, 2)   // a resize re-renders though nothing else changed
    expect(renderer.render).toHaveBeenCalledTimes(2)
  })
  it('scales the RT by the quality and the Surface content scale', () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, contentScale: 0.5 }, { ...ctx, quality: { ...ctx.quality, contentScale: 0.5 } })
    s.tick(1 / 60); s.prepare(stubRenderer(), { width: 400, height: 300 }, 2)
    expect(s.contentPass.target.width).toBe(256); expect(s.contentPass.target.height).toBe(192)   // 400·2·¼ = 200 → 256, 150 → 192
  })
  it('clears the content RT transparent black, or opaque to a colour background', () => {
    const none = new Surface({ width: 40, height: 30 }, ctx), r1 = stubRenderer()
    none.tick(1 / 60); none.prepare(r1, { width: 40, height: 30 }, 1)
    expect(r1.setClearColor).toHaveBeenNthCalledWith(1, expect.objectContaining({ r: 0, g: 0, b: 0 }), 0)
    const grey = new Surface({ width: 40, height: 30, background: '#80808080' }, ctx), r2 = stubRenderer()
    grey.tick(1 / 60); grey.prepare(r2, { width: 40, height: 30 }, 1)
    const g = srgbToLinear(128 / 255)
    // linear, and opaque whatever the token's alpha: the clear must be (0,0,0)@0 or opaque to stay premultiplied on both backends
    const [color, alpha] = r2.setClearColor.mock.calls[0]!
    expect(color.r).toBeCloseTo(g); expect(color.g).toBeCloseTo(g); expect(color.b).toBeCloseTo(g); expect(alpha).toBe(1)
  })
  it('maps content-quad uv to surface pt', () => {
    const { s } = signup()
    expect(s.pointFromUV(0, 1)).toEqual([0, 0]); expect(s.pointFromUV(1, 0)).toEqual([400, 300]); expect(s.pointFromUV(0.5, 0.5)).toEqual([200, 150])
  })
  it('the content quad leads a raycast hit back to its Surface, and still serialises', () => {
    const { s } = signup()
    expect(s.contentMesh.userData.surface).toBe(s)
    // three stringifies userData (clone, scene export): a plain back-reference would be a cycle
    expect(() => JSON.stringify(s.contentMesh.toJSON())).not.toThrow(); expect(() => s.contentMesh.clone()).not.toThrow()
  })
  it('a glass background adds the surface slab and lifts the content plane', () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass', cornerRadius: 24 }, ctx)
    s.tick(1 / 60)
    expect(s.contentPlaneZ).toBeCloseTo(0.15)   // min(400, 300) · 0.05 pt / 100
    expect(s.backgroundGlass!.buffer.count).toBe(1)
    expect(s.contentMesh.position.z).toBeCloseTo(s.contentPlaneZ)
    const lifted = s.children.filter((c): c is Mesh => c instanceof Mesh && c.renderOrder >= 0)
    expect(lifted.length).toBeGreaterThan(1); expect(lifted.every(m => Math.abs(m.position.z - s.contentPlaneZ) < 1e-9)).toBe(true)
    expect(s.children.filter((c): c is Mesh => c instanceof Mesh && c.renderOrder < 0).every(m => m.position.z === 0)).toBe(true)
    expect(s.foregroundImages.group.position.z).toBeCloseTo(s.contentPlaneZ)
    // the slab: the Surface rect, its corner radius, the shape and optics the brief gives a background
    const b = s.backgroundGlass!.buffer
    expect(b.get(0, 'iRect')).toEqual([0, 0, 4, 3])
    const [r, thickness, fillet, filletBottom] = b.get(0, 'iShape')
    expect(r).toBeCloseTo(0.24); expect(thickness).toBeCloseTo(0.15); expect(fillet).toBeCloseTo(0.045); expect(filletBottom).toBe(0)
    expect(b.get(0, 'iOptics')[2]).toBeCloseTo(0.4); expect(b.get(0, 'iOptics')[3]).toBeCloseTo(0.12)
  })
  it('the glass background refracts one screen capture with both its faces', () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, ctx)
    const slab = s.children.filter((c): c is Mesh => c instanceof Mesh && c.renderOrder < 0)
    expect(slab).toHaveLength(2)
    const bases = new Set(slab.flatMap(m => nodesOf((m.material as MeshPhysicalNodeMaterial).backdropNode)
      .filter(n => n.constructor.type === 'ViewportTextureNode').map(n => n.getBase!())))
    expect(bases.size).toBe(1)
  })
  it('places every draw in the documented order, on its layer', () => {
    const { s } = signup()
    s.tick(1 / 60)
    const fg = meshes(s)
    const quad = fg.filter(m => m.renderOrder === 0)
    expect(quad).toHaveLength(1); expect(quad[0]).toBe(s.contentMesh)
    const [back, front] = [fg.filter(m => m.renderOrder === 1), fg.filter(m => m.renderOrder === 2)]
    expect(back).toHaveLength(1); expect(front).toHaveLength(1)
    for (const m of [...back, ...front]) { expect(m.geometry).toBe(s.glass.geometry); expect(m.castShadow).toBe(true); expect(m.receiveShadow).toBe(false) }
    const rim = fg.filter(m => m.renderOrder === 3)
    expect(rim).toHaveLength(1); expect(rim[0]!.geometry).toBe(s.rims.geometry)
    const fgGlyphs = fg.filter(m => m.renderOrder === 4)
    expect(fgGlyphs.map(m => m.geometry)).toEqual([...s.foregroundText.perPage.values()].map(p => p.geometry))
    expect(s.foregroundImages.group.parent).toBe(s); expect(s.foregroundImages.group.renderOrder).toBe(4)
    const content = meshes(s.contentPass.scene)
    expect(content.find(m => m.geometry === s.panels.geometry)!.renderOrder).toBe(0)
    expect(content.find(m => m.geometry === s.pools.geometry)!.renderOrder).toBe(1)
    expect(content.filter(m => m.renderOrder === 2).map(m => m.geometry)).toEqual([...s.contentText.perPage.values()].map(p => p.geometry))
    expect(s.contentImages.group.parent).toBe(s.contentPass.scene); expect(s.contentImages.group.renderOrder).toBe(2)
    for (const m of [...fg, ...content]) { expect(m.frustumCulled).toBe(false); expect((m.material as MeshStandardNodeMaterial).toneMapped).toBe(false) }
    expect(s.contentMesh.receiveShadow).toBe(true); expect(s.contentMesh.castShadow).toBe(false)
  })
  it('without back faces (quality) the glass draws its front only', () => {
    const { s } = signup({ ...ctx, quality: { ...ctx.quality, backFaces: false } })
    expect(meshes(s).filter(m => m.renderOrder === 1)).toHaveLength(0)
    expect(meshes(s).filter(m => m.renderOrder === 2)).toHaveLength(1)
  })
  it('lifts rims and the glass\'s text onto the glass top face, and leaves content text on the plane', () => {
    const { s } = signup()
    s.tick(1 / 60)
    const top = 48 * theme.glass.thicknessRatio / 100   // the button's thickness (shorter side · ratio), in units
    expect(s.rims.buffer.get(0, 'iMat2')[3]).toBeCloseTo(top)
    const fgPage = [...s.foregroundText.perPage.values()][0]!
    expect(fgPage.buffer.get(0, 'iMat2')[3]).toBeCloseTo(top)
    const contentPage = [...s.contentText.perPage.values()][0]!
    expect(contentPage.buffer.get(0, 'iMat2')[3]).toBeCloseTo(0)
  })
  it('rebuilds glyph batches when the atlas epoch moves, even if nothing else changed', () => {
    const { s } = signup()
    s.tick(1 / 60); s.contentDirty = false
    ctx.text.atlas.invalidate()
    s.tick(1 / 60)
    expect(s.contentDirty).toBe(true); expect(s.foregroundText.glyphCount).toBe(13)
    s.contentDirty = false
    s.tick(1 / 60)                                // the rebuild caught up with the epoch: nothing more to do
    expect(s.contentDirty).toBe(false)
  })
  it('lays the glyphs out once more when the atlas evicts during the fill', () => {
    const { s } = signup()
    const update = s.foregroundText.update.bind(s.foregroundText)
    const spy = vi.spyOn(s.foregroundText, 'update').mockImplementationOnce((...a) => { update(...a); ctx.text.atlas.invalidate() })
    s.tick(1 / 60)
    expect(spy).toHaveBeenCalledTimes(2)
    s.contentDirty = false
    s.tick(1 / 60)
    expect(spy).toHaveBeenCalledTimes(2); expect(s.contentDirty).toBe(false)
  })
  it('glows where the pointer presses the glass, and follows it while pressed', () => {
    const { s, btn } = signup()
    btn.setStyle({ pressed: {} })                 // no press scale: the glass keeps its rect
    s.tick(1 / 60)
    // the button spans (40, 200)–(360, 248): a quarter right of and above its centre is u = v = ¼ (slab uv, y up)
    s.setPointer([280, 212]); s.pointer.down(280, 212)
    s.tick(1 / 60)
    expect(btn.state.pressed).toBe(true)
    expect(s.glass.buffer.get(0, 'iTouch')).toEqual([0.25, 0.25, 1, Math.fround(REFLECTION_STRENGTH)])
    s.setPointer([120, 236])                      // moved while pressed, nothing else changed
    s.tick(1 / 60)
    expect(s.glass.buffer.get(0, 'iTouch').slice(0, 3)).toEqual([-0.25, -0.25, 1])
    s.pointer.up(120, 236); s.tick(1 / 60)
    expect(s.glass.buffer.get(0, 'iTouch').slice(0, 3)).toEqual([0, 0, 0])
  })
  it('divides the glass\'s own (press) scale out of the glow point', () => {
    const { s } = signup()                        // pressed: scale 0.96
    s.tick(1 / 60)
    s.setPointer([280, 212]); s.pointer.down(280, 212)
    for (let i = 0; i < 6; i++) s.tick(1 / 60)
    const k = s.glass.buffer.get(0, 'iMat0')[0]   // the instance's scale about its centre
    expect(k).toBeLessThan(0.99)
    const [u, v] = s.glass.buffer.get(0, 'iTouch')
    expect(u).toBeCloseTo(0.25 / k, 5); expect(v).toBeCloseTo(0.25 / k, 5)
  })
  it('isolates frame errors: sets error, hides, emits, does not throw', () => {
    const { s } = signup()
    const bad = new Node('box', 'bad'); bad.setStyle({ bg: 'no-such-token' }); s.root.appendChild(bad)   // throws inside buildRenderList
    const onError = vi.fn(); s.addEventListener('error', onError)
    expect(() => s.tick(1 / 60)).not.toThrow()
    expect(s.error).toBeInstanceOf(Error); expect(s.visible).toBe(false); expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![0]).toMatchObject({ type: 'error', error: s.error })
    s.tick(1 / 60)                                // a failed Surface stays down: no more frames, no more events
    expect(onError).toHaveBeenCalledTimes(1)
  })
  it('isolates a failing content pass too', () => {
    const { s } = signup()
    s.tick(1 / 60)
    const onError = vi.fn(); s.addEventListener('error', onError)
    const renderer = { ...stubRenderer(), render: vi.fn(() => { throw new Error('backend not initialised') }) }
    expect(() => s.prepare(renderer, { width: 400, height: 300 }, 1)).not.toThrow()
    expect(s.error?.message).toBe('backend not initialised'); expect(s.visible).toBe(false); expect(onError).toHaveBeenCalledTimes(1)
  })
  it('setSize marks layout and resizes the content quad', () => {
    const { s } = signup()
    s.tick(1 / 60); s.setSize(200, 100); s.tick(1 / 60)
    expect(s.contentMesh.scale.x).toBeCloseTo(2); expect(s.model.width).toBe(200); expect(s.root.style.width).toBe(200)
    expect(s.contentDirty).toBe(true)
  })
  it('animates against the Surface corner radius (a concentric root)', () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, cornerRadius: 24 }, ctx)
    const spy = vi.spyOn(ctx.anim, 'tick')
    s.tick(1 / 60)
    expect(spy).toHaveBeenCalledWith(s.root, 1 / 60, 24)
    spy.mockRestore()
  })
  it('glassBounds spans the content face up to the tallest glass', () => {
    const { s } = signup()
    s.tick(1 / 60)
    const b = s.glassBounds
    expect(b.min.x).toBeCloseTo(-2); expect(b.max.x).toBeCloseTo(2); expect(b.min.y).toBeCloseTo(-1.5); expect(b.max.y).toBeCloseTo(1.5)
    expect(b.min.z).toBe(0); expect(b.max.z).toBeGreaterThanOrEqual(48 * theme.glass.thicknessRatio / 100)
  })
  it('dispose drops the animation and layout state and detaches', () => {
    const { s } = signup()
    const parent = new Group(); parent.add(s)
    s.tick(1 / 60)
    const forget = vi.spyOn(ctx.anim, 'forget'), release = vi.spyOn(ctx.layout, 'dispose')
    s.dispose()
    expect(forget).toHaveBeenCalledWith(s.root); expect(release).toHaveBeenCalledWith(s.root)
    expect(s.parent).toBeNull()
    forget.mockRestore(); release.mockRestore()
  })
})

describe('createContentMaterial', () => {
  it('composites the premultiplied content RT, lit and receiving shadows', () => {
    const tex = new Texture()
    const m = createContentMaterial(tex)
    expect(m).toBeInstanceOf(MeshStandardNodeMaterial)
    expect(m.blending).toBe(CustomBlending); expect(m.premultipliedAlpha).toBe(false)
    expect([m.blendSrc, m.blendDst, m.blendSrcAlpha, m.blendDstAlpha]).toEqual([OneFactor, OneMinusSrcAlphaFactor, OneFactor, OneMinusSrcAlphaFactor])
    expect(m.transparent).toBe(true); expect(m.depthWrite).toBe(true); expect(m.alphaTest).toBe(0.02); expect(m.toneMapped).toBe(false)
    expect(m.roughness).toBe(1); expect(m.metalness).toBe(0)
    const sampled = [...nodesOf(m.colorNode), ...nodesOf(m.opacityNode)].filter(n => n.isTextureNode).map(n => n.value)
    expect(new Set(sampled)).toEqual(new Set([tex]))
  })
})

describe('content quad material shaders (generated under Node)', () => {
  for (const forceWebGL of [false, true]) {
    it(`${forceWebGL ? 'GLSL' : 'WGSL'}: builds, with the alpha-test discard`, () => {
      const warnings: string[] = []
      const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')) })
      try {
        const out = buildShaders(createContentMaterial(new Texture()), new PlaneGeometry(1, 1), forceWebGL)
        expect(out.fragment).toContain('discard')
      } finally { spy.mockRestore() }
      expect(warnings).toEqual([])
    })
  }
})
