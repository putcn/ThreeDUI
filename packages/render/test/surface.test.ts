import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { CustomBlending, FrontSide, Group, HalfFloatType, Mesh, Object3D, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, Texture, UnsignedByteType, Vector3 } from 'three'
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import { Node, createYogaLayout, AnimationRuntime, defaultTheme as theme } from '@glassui/core'
import { SystemFontEngine } from '@glassui/text'
import { Surface, createContentMaterial, CONTENT_ORDER, SURFACE_ORDER, type SurfaceContext } from '../src/surface/surface'
import { AtlasPages } from '../src/text/pages'
import { createMeasureFn } from '../src/text/measure'
import { REFLECTION_STRENGTH } from '../src/glass/batch'
import { srgbToLinear } from '../src/color'
import { buildShaders } from './fixtures/build-shaders'

let ctx: SurfaceContext
beforeAll(async () => {
  const text = new SystemFontEngine({ createCanvas: ((w: number, h: number) => createCanvas(w, h)) as never, pageSize: 512, maxPages: 2 })
  ctx = { theme, scheme: 'light', layout: await createYogaLayout(), measure: createMeasureFn(text, theme, 'light'), anim: new AnimationRuntime(theme, 'light'), text, pages: new AtlasPages(text.atlas), quality: { contentType: 'byte', contentScale: 1, backFaces: true, depthReject: true, blur: 'mip' } }
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
/** Every mesh under `o` (a Surface's draws, or the content scene's). */
function meshes(o: Object3D): Mesh[] { const out: Mesh[] = []; o.traverse(c => { if (c instanceof Mesh) out.push(c) }); return out }
/** `o`'s z in its Surface's own frame. */
function localZ(s: Surface, o: Object3D): number { s.updateMatrixWorld(true); return s.worldToLocal(o.getWorldPosition(new Vector3())).z }
/** A `w × h` image node at (x, y) showing `src`. */
function image(id: string, src: unknown, x = 0, y = 0, w = 40, h = 40): Node {
  const n = new Node('image', id); n.setProp('src', src); n.setStyle({ position: 'absolute', left: x, top: y, width: w, height: h }); return n
}

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
    expect(localZ(s, s.contentMesh)).toBeCloseTo(s.contentPlaneZ)
    const lifted = meshes(s).filter(m => m.renderOrder >= 0)
    expect(lifted.length).toBeGreaterThan(1); expect(lifted.every(m => Math.abs(localZ(s, m) - s.contentPlaneZ) < 1e-9)).toBe(true)
    expect(meshes(s).filter(m => m.renderOrder < 0).every(m => localZ(s, m) === 0)).toBe(true)
    expect(localZ(s, s.foregroundImages.container)).toBeCloseTo(s.contentPlaneZ)
    // one write moves the whole plane: everything on it is a child of `plane`
    expect(lifted.every(m => m.parent === s.plane)).toBe(true); expect(s.foregroundImages.container.parent).toBe(s.plane)
    // the slab: the Surface rect, its corner radius, the shape and optics the brief gives a background
    const b = s.backgroundGlass!.buffer
    expect(b.get(0, 'iRect')).toEqual([0, 0, 4, 3])
    const [r, thickness, fillet, filletBottom] = b.get(0, 'iShape')
    expect(r).toBeCloseTo(0.24); expect(thickness).toBeCloseTo(0.15); expect(fillet).toBeCloseTo(0.045); expect(filletBottom).toBe(0)
    expect(b.get(0, 'iOptics')[2]).toBeCloseTo(0.4); expect(b.get(0, 'iOptics')[3]).toBeCloseTo(0.12)
  })
  it('the glass background refracts one screen capture with both its faces', () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, ctx)
    const slab = meshes(s).filter(m => m.renderOrder < 0)
    expect(slab).toHaveLength(2)
    const bases = new Set(slab.flatMap(m => nodesOf((m.material as MeshPhysicalNodeMaterial).backdropNode)
      .filter(n => n.constructor.type === 'ViewportTextureNode').map(n => n.getBase!())))
    expect(bases.size).toBe(1)
  })
  it('the glass background follows the Surface size, and is never 0 thick', () => {
    const s = new Surface({ width: 10, height: 10, ptPerUnit: 100, background: 'glass' }, ctx)   // as the root makes fill surfaces
    expect(s.contentPlaneZ).toBeCloseTo(0.01)   // max(1, 10 · 0.05) pt
    s.setSize(400, 300)
    expect(s.contentPlaneZ).toBeCloseTo(0.15)
    expect(s.backgroundGlass!.buffer.get(0, 'iShape')[1]).toBeCloseTo(0.15); expect(s.backgroundGlass!.buffer.get(0, 'iRect')).toEqual([0, 0, 4, 3])
    expect(localZ(s, s.contentMesh)).toBeCloseTo(0.15)
    const empty = new Surface({ width: 0, height: 0, ptPerUnit: 100, background: 'glass' }, ctx)
    expect(empty.backgroundGlass!.buffer.get(0, 'iShape')[1]).toBeCloseTo(0.01)   // the refraction divides by it
  })
  it('dispose frees the screen capture, including the copies three made per target', () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, ctx)
    const sample = meshes(s).filter(m => m.renderOrder < 0).flatMap(m => nodesOf((m.material as MeshPhysicalNodeMaterial).backdropNode))
      .find(n => n.constructor.type === 'ViewportTextureNode') as unknown as { getTextureForReference(ref: object): Texture; getBase(): { value: Texture } }
    const copy = sample.getTextureForReference({})   // what a frame drawn into a target (or the canvas) copies into
    const own = sample.getBase().value
    expect(copy).not.toBe(own)
    const freed: Texture[] = []
    for (const t of [copy, own]) t.addEventListener('dispose', () => freed.push(t))
    s.dispose()
    expect(freed).toHaveLength(2); expect(new Set(freed)).toEqual(new Set([copy, own]))
  })
  it('places every draw in the documented order, on its layer', () => {
    const { s, btn } = signup()
    s.root.appendChild(image('photo', new Texture(), 300, 30)); btn.appendChild(image('icon', new Texture(), 8, 8, 32, 32))
    s.tick(1 / 60)
    expect(SURFACE_ORDER).toEqual({ slab: -1, content: 0, glassBack: 1, glassFront: 2, rims: 3, images: 3.5, glyphs: 4 })
    expect(CONTENT_ORDER).toEqual({ panels: 0, pools: 1, images: 1.5, glyphs: 2 })
    const fg = meshes(s)
    const quad = fg.filter(m => m.renderOrder === SURFACE_ORDER.content)
    expect(quad).toHaveLength(1); expect(quad[0]).toBe(s.contentMesh)
    const [back, front] = [fg.filter(m => m.renderOrder === SURFACE_ORDER.glassBack), fg.filter(m => m.renderOrder === SURFACE_ORDER.glassFront)]
    expect(back).toHaveLength(1); expect(front).toHaveLength(1)
    for (const m of [...back, ...front]) { expect(m.geometry).toBe(s.glass.geometry); expect(m.castShadow).toBe(true); expect(m.receiveShadow).toBe(false) }
    const rim = fg.filter(m => m.renderOrder === SURFACE_ORDER.rims)
    expect(rim).toHaveLength(1); expect(rim[0]!.geometry).toBe(s.rims.geometry)
    const fgGlyphs = fg.filter(m => m.renderOrder === SURFACE_ORDER.glyphs)
    expect(fgGlyphs.map(m => m.geometry)).toEqual([...s.foregroundText.perPage.values()].map(p => p.geometry))
    // the icon rides on the glass: over its rim, under its label
    const icon = s.foregroundImages.container.children as Mesh[]
    expect(icon).toHaveLength(1); expect(icon[0]!.renderOrder).toBe(SURFACE_ORDER.images)
    const content = meshes(s.contentPass.scene)
    expect(content.find(m => m.geometry === s.panels.geometry)!.renderOrder).toBe(CONTENT_ORDER.panels)
    expect(content.find(m => m.geometry === s.pools.geometry)!.renderOrder).toBe(CONTENT_ORDER.pools)
    expect(content.filter(m => m.renderOrder === CONTENT_ORDER.glyphs).map(m => m.geometry)).toEqual([...s.contentText.perPage.values()].map(p => p.geometry))
    // the photo is content: over panels and pools, under the text
    const photo = s.contentImages.container.children as Mesh[]
    expect(photo).toHaveLength(1); expect(photo[0]!.renderOrder).toBe(CONTENT_ORDER.images)
    expect(s.contentImages.container.parent).toBe(s.contentPass.scene)
    for (const m of [...fg, ...content]) { expect(m.frustumCulled).toBe(false); expect((m.material as MeshStandardNodeMaterial).toneMapped).toBe(false) }
    expect(s.contentMesh.receiveShadow).toBe(true); expect(s.contentMesh.castShadow).toBe(false)
  })
  it('keeps every draw in one layer group ordered by drawOrder, with no group below it', () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, ctx)
    const pill = new Node('glass', 'pill'); pill.setStyle({ position: 'absolute', left: 10, top: 10, width: 120, height: 48 })
    pill.appendChild(image('icon', new Texture(), 8, 8, 32, 32)); s.root.appendChild(pill)
    s.tick(1 / 60)
    expect(s.foregroundImages.container.children).toHaveLength(1)
    expect(s.drawOrder).toBe(0)
    s.drawOrder = 5
    expect(s.layer).toBeInstanceOf(Group); expect(s.layer.renderOrder).toBe(5); expect(s.layer.parent).toBe(s)
    const all = meshes(s)
    expect(all.length).toBeGreaterThan(4)
    for (const m of all) {
      let nearestGroup: Object3D | null = null
      for (let p = m.parent; p && !nearestGroup; p = p.parent) if ((p as Group).isGroup) nearestGroup = p
      expect(nearestGroup).toBe(s.layer)        // three takes the nearest group's renderOrder as the draw's group order
    }
  })
  it('without back faces (quality) the glass draws its front only', () => {
    const { s } = signup({ ...ctx, quality: { ...ctx.quality, backFaces: false } })
    expect(meshes(s).filter(m => m.renderOrder === SURFACE_ORDER.glassBack)).toHaveLength(0)
    expect(meshes(s).filter(m => m.renderOrder === SURFACE_ORDER.glassFront)).toHaveLength(1)
  })
  it('redraws the content when a content image\'s texture changes (a URL that loaded), and only then', () => {
    const tex = new Texture({ width: 2, height: 2 })
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, ctx)
    s.root.appendChild(image('photo', tex))
    const renderer = stubRenderer()
    s.tick(1 / 60); s.prepare(renderer, { width: 400, height: 300 }, 1)
    s.tick(1 / 60); s.prepare(renderer, { width: 400, height: 300 }, 1)
    expect(renderer.render).toHaveBeenCalledTimes(1)
    tex.needsUpdate = true
    s.tick(1 / 60); s.prepare(renderer, { width: 400, height: 300 }, 1)
    expect(renderer.render).toHaveBeenCalledTimes(2)
  })
  it('asks for a frame (not a content redraw) when an image riding on glass changes', () => {
    const tex = new Texture({ width: 2, height: 2 })
    const { s, btn } = signup()
    btn.appendChild(image('icon', tex, 8, 8, 32, 32))
    s.tick(1 / 60); s.contentDirty = false
    s.tick(1 / 60)
    expect(s.needsFrame).toBe(false)
    tex.needsUpdate = true
    s.tick(1 / 60)
    expect(s.needsFrame).toBe(true); expect(s.contentDirty).toBe(false)
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
  it('a throwing error listener does not escape the frame', () => {
    const { s } = signup()
    const bad = new Node('box', 'bad'); bad.setStyle({ bg: 'no-such-token' }); s.root.appendChild(bad)
    s.addEventListener('error', () => { throw new Error('listener bug') })
    const logged: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a) })
    try {
      expect(() => s.tick(1 / 60)).not.toThrow()
    } finally { spy.mockRestore() }
    expect(s.error).toBeInstanceOf(Error); expect(logged).toHaveLength(1)
    expect(String(logged[0]![0])).toContain('"error" listener'); expect((logged[0]![1] as Error).message).toBe('listener bug')
  })
  it('a failed Surface no longer asks for frames', () => {
    const { s, btn } = signup()
    s.tick(1 / 60)
    btn.setState({ pressed: true }); s.tick(1 / 60)
    expect(s.needsFrame).toBe(true)
    btn.setState({ pressed: false })
    const bad = new Node('box', 'bad'); bad.setStyle({ bg: 'no-such-token' }); s.root.appendChild(bad)
    s.tick(1 / 60)                                // still animating when the render list throws
    expect(s.error).toBeInstanceOf(Error); expect(s.needsFrame).toBe(false)
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
  it('setQuality rebuilds the element glass with or without back faces, and marks the content dirty', () => {
    const c: SurfaceContext = { ...ctx }   // setQuality writes the shared context: keep the suite's own
    const { s } = signup(c)
    s.tick(1 / 60); s.prepare(stubRenderer(), { width: 400, height: 300 }, 1)
    const glassMeshes = () => meshes(s).filter(m => m.renderOrder === SURFACE_ORDER.glassBack || m.renderOrder === SURFACE_ORDER.glassFront)
    const before = glassMeshes()
    expect(before).toHaveLength(2)
    const freed: unknown[] = []
    for (const m of before) (m.material as MeshPhysicalNodeMaterial).addEventListener('dispose', () => freed.push(m.material))
    const shared = c.quality
    const low = Object.freeze({ ...ctx.quality, backFaces: false, contentScale: 0.5 })
    s.setQuality(low)
    expect(c.quality).toBe(shared); expect(c.quality.contentScale).toBe(1)   // the root owns the shared profile
    expect(s.contentDirty).toBe(true)
    s.prepare(stubRenderer(), { width: 400, height: 300 }, 1)
    expect(s.contentPass.target.width).toBe(256)              // 400 · ½ = 200 → 256: this Surface's own profile
    expect(new Surface({ width: 400, height: 300, ptPerUnit: 100 }, c).contentPass.texture.type).toBe(UnsignedByteType)
    expect(freed).toHaveLength(2)
    const after = glassMeshes()
    expect(after).toHaveLength(1); expect(after[0]!.renderOrder).toBe(SURFACE_ORDER.glassFront)
    expect(after[0]!.geometry).toBe(s.glass.geometry); expect(after[0]!.castShadow).toBe(true); expect(after[0]!.parent).toBe(s.plane)
    expect(before.every(m => m.parent === null)).toBe(true)
    s.setQuality({ ...low, backFaces: true })
    expect(glassMeshes().map(m => m.renderOrder).sort()).toEqual([SURFACE_ORDER.glassBack, SURFACE_ORDER.glassFront])
    // the rebuilt front refracts the same content RT
    const sampled = nodesOf((glassMeshes()[0]!.material as MeshPhysicalNodeMaterial).backdropNode).filter(n => n.isTextureNode).map(n => n.value)
    expect(sampled).toContain(s.contentPass.texture)
  })
  it('setQuality rebuilds the background slab around its one screen capture, with the new depth reject', () => {
    const c: SurfaceContext = { ...ctx }
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, c)
    const slab = () => meshes(s).filter(m => m.renderOrder === SURFACE_ORDER.slab)
    const graph = () => slab().flatMap(m => nodesOf((m.material as MeshPhysicalNodeMaterial).backdropNode))
    const bases = () => new Set(graph().filter(n => n.constructor.type === 'ViewportTextureNode').map(n => n.getBase!()))
    const capture = [...bases()][0] as { value: Texture }
    let captureFreed = 0
    capture.value.addEventListener('dispose', () => { captureFreed++ })
    expect(slab()).toHaveLength(2); expect(graph().some(n => n.constructor.type === 'ViewportDepthTextureNode')).toBe(true)
    s.setQuality({ ...ctx.quality, backFaces: false, depthReject: false })
    expect(slab()).toHaveLength(1); expect((slab()[0]!.material as MeshPhysicalNodeMaterial).side).toBe(FrontSide)
    expect(graph().some(n => n.constructor.type === 'ViewportDepthTextureNode')).toBe(false)
    expect(bases()).toEqual(new Set([capture])); expect(captureFreed).toBe(0)
    s.setQuality({ ...ctx.quality, backFaces: true, depthReject: true })
    expect(slab()).toHaveLength(2); expect(bases()).toEqual(new Set([capture]))
    expect(graph().some(n => n.constructor.type === 'ViewportDepthTextureNode')).toBe(true)
    expect(slab().every(m => m.parent === s.layer)).toBe(true)
  })
  it('setQuality switches the content RT\'s texel type', () => {
    const c: SurfaceContext = { ...ctx }
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, c)
    expect(s.contentPass.texture.type).toBe(UnsignedByteType)
    s.setQuality({ ...ctx.quality, contentType: 'half' })
    expect(s.contentPass.texture.type).toBe(HalfFloatType)
  })
  it('a throwing rebuild fails the Surface instead of propagating', () => {
    const c: SurfaceContext = { ...ctx }
    const { s } = signup(c)
    s.glass.geometry.deleteAttribute('iTouch')   // createGlassMaterial refuses a geometry missing an attribute
    const onError = vi.fn(); s.addEventListener('error', onError)
    expect(() => s.setQuality({ ...ctx.quality })).not.toThrow()
    expect(s.error?.message).toMatch(/iTouch/); expect(onError).toHaveBeenCalledTimes(1)
  })
  it('refreshText rebuilds the glyphs when another Surface moved the atlas, and only then', () => {
    const { s } = signup()
    s.tick(1 / 60); s.contentDirty = false
    expect(s.refreshText()).toBe(false); expect(s.contentDirty).toBe(false)
    ctx.text.atlas.invalidate()                   // another Surface's glyphs evicted this one's
    expect(s.refreshText()).toBe(true)
    expect(s.contentDirty).toBe(true); expect(s.foregroundText.glyphCount).toBe(13)
    s.contentDirty = false
    expect(s.refreshText()).toBe(false)           // caught up
    s.tick(1 / 60)
    expect(s.contentDirty).toBe(false)
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

describe('background slab shaders (generated under Node)', () => {
  for (const forceWebGL of [false, true]) {
    it(`${forceWebGL ? 'GLSL' : 'WGSL'}: both faces build around the disposable screen capture`, () => {
      // the slab geometry has no `position` attribute on purpose (positionNode replaces it); three warns once per build
      const warnings: string[] = []
      const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')) })
      try {
        const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, ctx)
        for (const m of meshes(s).filter(m => m.renderOrder === SURFACE_ORDER.slab)) {
          const out = buildShaders(m.material as MeshPhysicalNodeMaterial, s.backgroundGlass!.geometry, forceWebGL)
          expect(out.fragment).toContain('discard')
        }
      } finally { spy.mockRestore() }
      expect(warnings.filter(w => !w.includes('Vertex attribute "position" not found'))).toEqual([])
    })
  }
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
