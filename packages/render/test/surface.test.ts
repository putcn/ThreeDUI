import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { CustomBlending, DataTexture, FramebufferTexture, FrontSide, PerspectiveCamera, Group, HalfFloatType, Mesh, Object3D, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, Texture, UnsignedByteType, Vector3, type Material, type RenderTarget } from 'three'
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, type MeshBasicNodeMaterial } from 'three/webgpu'
import { Node, createYogaLayout, AnimationRuntime, defaultTheme as theme, resolveColor } from '@glassui/core'
import { SystemFontEngine } from '@glassui/text'
import { Surface, createContentMaterial, CONTENT_ORDER, SLAB_FROST, SURFACE_ORDER, type SurfaceContext } from '../src/surface/surface'
import { AtlasPages } from '../src/text/pages'
import { createMeasureFn } from '../src/text/measure'
import { REFLECTION_STRENGTH } from '../src/glass/batch'
import { srgbToLinear } from '../src/color'
import { surfaceToLocal } from '../src/units'
import { ScreenCapture } from '../src/glass/material'
import { buildShaders } from './fixtures/build-shaders'
import { QUALITY } from '../src/quality'
import { toColor } from '../src/color'
import { evalNode } from './fixtures/tsl-eval'

let ctx: SurfaceContext
beforeAll(async () => {
  const text = new SystemFontEngine({ createCanvas: ((w: number, h: number) => createCanvas(w, h)) as never, pageSize: 512, maxPages: 2 })
  ctx = { theme, scheme: 'light', layout: await createYogaLayout(), measure: createMeasureFn(text, theme, 'light'), anim: new AnimationRuntime(theme, 'light'), text, pages: new AtlasPages(text.atlas), quality: { contentType: 'byte', contentScale: 1, backFaces: true, depthReject: true, blur: 'mip', glassMode: 'refract', dispersion: 'always' } }
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
/** Every node any of `m`'s node slots (`colorNode`, `backdropNode`, `castShadowNode`…) reaches. */
function materialGraph(m: Material): GraphNode[] {
  return Object.entries(m).filter(([k, v]) => k.endsWith('Node') && typeof (v as { getChildren?: unknown } | null)?.getChildren === 'function').flatMap(([, v]) => nodesOf(v))
}
/** The node types whose draws copy the framebuffer (or depth buffer) first. */
const CAPTURES = ['ViewportTextureNode', 'ViewportDepthTextureNode']
/** A Surface's element glass draws (back and front). */
const elementGlass = (s: Surface) => meshes(s).filter(m => m.renderOrder === SURFACE_ORDER.glassBack || m.renderOrder === SURFACE_ORDER.glassFront)

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
  it('never draws the content below one texel per CSS px: the quality\'s scale only caps supersampling at DPR > 1', () => {
    const at = (contentScale: number, dpr: number, own?: number) => {
      const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, ...(own ? { contentScale: own } : {}) }, { ...ctx, quality: { ...ctx.quality, contentScale } })
      s.tick(1 / 60); s.prepare(stubRenderer(), { width: 400, height: 300 }, dpr)
      return [s.contentPass.target.width, s.contentPass.target.height]
    }
    // low/minimal (¼) at DPR 1: 400 × 300 CSS px get at least 400 × 300 texels, not 100 × 75
    const [w, h] = at(0.25, 1)
    expect(w).toBeGreaterThanOrEqual(400); expect(h).toBeGreaterThanOrEqual(300)
    expect([w, h]).toEqual([448, 320])
    expect(at(0.5, 1)).toEqual([448, 320])                  // medium at DPR 1: the floor, not 200 × 150
    expect(at(0.5, 2)).toEqual([448, 320])                  // medium at DPR 2: 400 · 2 · ½ = one texel per CSS px
    expect(at(0.5, 3)).toEqual([640, 512])                  // DPR 3: ½ of 1200 = 600 → 640 (1.5 texels per CSS px)
    expect(at(0.25, 2)).toEqual([448, 320])                 // ¼ at DPR 2 is below the floor: ½
    expect(at(1, 2)).toEqual([832, 640])                    // high: the full device resolution
    expect(at(0.25, 1, 0.5)).toEqual([256, 192])            // the Surface's own scale still multiplies the floored one
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
    const c: SurfaceContext = { ...ctx }   // a context of its own, to check setQuality leaves it alone
    const { s } = signup(c)
    s.tick(1 / 60); s.prepare(stubRenderer(), { width: 400, height: 300 }, 1)
    const glassMeshes = () => meshes(s).filter(m => m.renderOrder === SURFACE_ORDER.glassBack || m.renderOrder === SURFACE_ORDER.glassFront)
    const before = glassMeshes()
    expect(before).toHaveLength(2)
    const freed: unknown[] = []
    for (const m of before) (m.material as MeshPhysicalNodeMaterial).addEventListener('dispose', () => freed.push(m.material))
    const shared = c.quality
    const low = Object.freeze({ ...ctx.quality, backFaces: false, contentScale: 0.5, contentType: 'half' as const })
    s.setQuality(low)
    expect(c.quality).toBe(shared); expect(c.quality.contentScale).toBe(1)   // the root owns the shared profile
    expect(s.contentDirty).toBe(true)
    s.prepare(stubRenderer(), { width: 400, height: 300 }, 2)
    expect(s.contentPass.target.width).toBe(448)              // 400 · 2 · ½ = 400 → 448: this Surface's own profile (the shared one: 832)
    expect(s.contentPass.texture.type).toBe(HalfFloatType)
    // a Surface made afterwards starts from the untouched shared profile
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
    // both faces read one depth capture (one depth copy per render), kept across rebuilds and freed with the Surface
    const depthBases = () => new Set(graph().filter(n => n.constructor.type === 'ViewportDepthTextureNode').map(n => n.getBase!()))
    const depth = [...depthBases()][0] as { getTextureForReference(r: object): Texture }
    expect(depthBases().size).toBe(1)
    const depthCopy = depth.getTextureForReference({})
    let depthFreed = 0
    depthCopy.addEventListener('dispose', () => { depthFreed++ })
    s.setQuality({ ...ctx.quality, backFaces: true, depthReject: true })
    expect(depthBases()).toEqual(new Set([depth])); expect(depthFreed).toBe(0)
    s.dispose()
    expect(depthFreed).toBe(1); expect(captureFreed).toBeGreaterThan(0)
  })
  it('element glass on a glass Surface sees the slab\'s captures under transparent content, through the slab\'s frost', () => {
    const graph = (ms: Mesh[]) => ms.flatMap(m => nodesOf((m.material as MeshPhysicalNodeMaterial).backdropNode))
    const bases = (ms: Mesh[], type: string) => new Set(graph(ms).filter(n => n.constructor.type === type).map(n => n.getBase!()))
    const c: SurfaceContext = { ...ctx }
    const glass = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, c)
    const slab = () => meshes(glass).filter(m => m.renderOrder === SURFACE_ORDER.slab)
    expect(bases(elementGlass(glass), 'ViewportTextureNode').size).toBe(1)
    expect(bases(elementGlass(glass), 'ViewportTextureNode')).toEqual(bases(slab(), 'ViewportTextureNode'))   // the slab's capture: no second copy
    expect(graph(elementGlass(glass)).some(n => n.constructor.type === 'ConstNode' && n.value === SLAB_FROST.roughness * 8)).toBe(true)
    // with the depth reject, the slab's one depth capture too; without it, none
    expect(bases(elementGlass(glass), 'ViewportDepthTextureNode').size).toBe(1)
    expect(bases(elementGlass(glass), 'ViewportDepthTextureNode')).toEqual(bases(slab(), 'ViewportDepthTextureNode'))
    glass.setQuality({ ...ctx.quality, depthReject: false })
    expect(bases(elementGlass(glass), 'ViewportDepthTextureNode').size).toBe(0)
    expect(bases(elementGlass(glass), 'ViewportTextureNode')).toEqual(bases(slab(), 'ViewportTextureNode'))
    const opaque = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: '#ffffff' }, { ...ctx })
    expect(bases(elementGlass(opaque), 'ViewportTextureNode').size).toBe(0)   // an opaque content RT hides nothing
  })
  it('a \'none\' Surface takes no capture: its element glass refracts the content RT alone', () => {
    for (const s of [new Surface({ width: 400, height: 300, ptPerUnit: 100 }, { ...ctx }), new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'none' }, { ...ctx })]) {
      const draws = [...meshes(s), ...meshes(s.contentPass.scene)]
      expect(elementGlass(s)).toHaveLength(2)
      expect(draws.flatMap(m => materialGraph(m.material as Material)).filter(n => CAPTURES.includes(n.constructor.type!))).toEqual([])
      const sampled = elementGlass(s).flatMap(m => materialGraph(m.material as Material)).filter(n => n.isTextureNode).map(n => n.value)
      expect(sampled).toContain(s.contentPass.texture)
    }
  })
  it('repeated identical rebuilds keep exactly one live set of glass draws and never free the shared capture', () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, { ...ctx })
    const orders: number[] = [SURFACE_ORDER.slab, SURFACE_ORDER.glassBack, SURFACE_ORDER.glassFront]
    const draws = () => meshes(s).filter(m => orders.includes(m.renderOrder))
    const count = draws().length
    expect(count).toBe(4)                                           // slab back + front, element back + front
    const capture = [...new Set(draws().flatMap(m => nodesOf((m.material as MeshPhysicalNodeMaterial).backdropNode))
      .filter(n => n.constructor.type === 'ViewportTextureNode').map(n => n.getBase!()))][0] as { value: Texture; copies: Set<Texture> }
    let captureFreed = 0
    capture.value.addEventListener('dispose', () => { captureFreed++ })
    const freed = new Set<unknown>()
    for (let i = 0; i < 5; i++) {
      for (const m of draws()) (m.material as MeshPhysicalNodeMaterial).addEventListener('dispose', () => freed.add(m.material))
      s.setQuality({ ...ctx.quality })
      expect(draws()).toHaveLength(count)
      expect(draws().every(m => !freed.has(m.material) && (m.parent === s.layer || m.parent === s.plane))).toBe(true)
    }
    expect(freed.size).toBe(5 * count)                               // every replaced material was freed, once
    expect(captureFreed).toBe(0)
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

describe('Surface: the dual-Kawase pyramid (quality.blur = \'kawase\')', () => {
  const kawase = (q: Partial<SurfaceContext['quality']> = {}): SurfaceContext => ({ ...ctx, quality: { ...ctx.quality, blur: 'kawase', ...q } })
  /** A stub renderer recording the target of every draw. */
  const recording = () => {
    let bound: RenderTarget | null = null
    const drawn: (RenderTarget | null)[] = []
    return { ...stubRenderer(), drawn, setRenderTarget: vi.fn((t: RenderTarget | null) => { bound = t }), render: vi.fn(() => { drawn.push(bound) }) }
  }
  /** The pyramid's levels among `drawn`: each drawn twice (its down- and up-sample), finest first. */
  const levelsOf = (drawn: (RenderTarget | null)[]) => [...new Set(drawn)].filter(t => drawn.filter(d => d === t).length === 2) as RenderTarget[]
  const sampledBy = (ms: Mesh[]) => new Set(ms.flatMap(m => nodesOf((m.material as MeshPhysicalNodeMaterial).backdropNode)).filter(n => n.isTextureNode).map(n => n.value))

  it('prepare redraws the pyramid after the content RT, at its size, only when the content is redrawn; the element glass samples it', () => {
    const { s } = signup(kawase()); s.tick(1 / 60)
    const r = recording()
    s.prepare(r, { width: 400, height: 300 }, 1)
    expect(r.render).toHaveBeenCalledTimes(1 + 9)                  // the content, then 4 + 1 downs and 4 ups
    expect(r.drawn[0]).toBe(s.contentPass.target)
    const levels = levelsOf(r.drawn)
    expect(levels.map(l => [l.width, l.height])).toEqual([[224, 160], [112, 80], [56, 40], [28, 20]])   // the RT is 448 × 320
    for (const l of levels) expect(sampledBy(elementGlass(s))).toContain(l.texture)
    s.prepare(r, { width: 400, height: 300 }, 1)
    expect(r.render).toHaveBeenCalledTimes(10)                      // a clean content RT: the pyramid is current
    s.prepare(r, { width: 800, height: 300 }, 1)                     // a resize redraws both
    expect(r.render).toHaveBeenCalledTimes(20)
    expect(levels.map(l => l.width)).toEqual([416, 208, 104, 52])   // 800 → 832
  })
  it('a background slab never samples the pyramid; a \'mip\' Surface has none', () => {
    const glass = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, kawase()), r = recording()
    glass.tick(1 / 60); glass.prepare(r, { width: 400, height: 300 }, 1)
    const levels = levelsOf(r.drawn)
    expect(levels).toHaveLength(4)
    for (const l of levels) expect(sampledBy(meshes(glass).filter(m => m.renderOrder === SURFACE_ORDER.slab))).not.toContain(l.texture)
    for (const l of levels) expect(sampledBy(elementGlass(glass))).toContain(l.texture)
    const { s } = signup(), r2 = recording()
    s.tick(1 / 60); s.prepare(r2, { width: 400, height: 300 }, 1)
    expect(r2.render).toHaveBeenCalledTimes(1)
  })
  it('setQuality keeps the pyramid in the content\'s texel type, drops it on \'mip\' and makes a new one on \'kawase\'', () => {
    const { s } = signup(kawase({ contentType: 'half' })); s.tick(1 / 60)
    const r = recording()
    s.prepare(r, { width: 400, height: 300 }, 1)
    const levels = levelsOf(r.drawn)
    expect(levels.every(l => l.texture.type === HalfFloatType)).toBe(true)
    s.setQuality(kawase({ contentType: 'byte' }).quality)
    expect(levels.every(l => l.texture.type === UnsignedByteType)).toBe(true)   // the same targets, re-typed
    for (const l of levels) expect(sampledBy(elementGlass(s))).toContain(l.texture)
    const freed = new Set<unknown>()
    for (const l of levels) l.addEventListener('dispose', () => freed.add(l))
    s.setQuality({ ...ctx.quality, blur: 'mip' })
    expect(freed).toEqual(new Set(levels))
    for (const l of levels) expect(sampledBy(elementGlass(s))).not.toContain(l.texture)
    r.drawn.length = 0; s.prepare(r, { width: 400, height: 300 }, 1)
    expect(r.drawn).toEqual([s.contentPass.target])
    s.setQuality(kawase().quality)
    r.drawn.length = 0; s.prepare(r, { width: 400, height: 300 }, 1)
    const fresh = levelsOf(r.drawn)
    expect(fresh).toHaveLength(4); for (const l of fresh) expect(levels).not.toContain(l)
    for (const l of fresh) expect(sampledBy(elementGlass(s))).toContain(l.texture)
  })
  it('dispose frees the pyramid', () => {
    const { s } = signup(kawase()); s.tick(1 / 60)
    const r = recording()
    s.prepare(r, { width: 400, height: 300 }, 1)
    const targets = [...new Set(r.drawn)].filter(t => t !== s.contentPass.target) as RenderTarget[]
    expect(targets).toHaveLength(5)
    const freed = new Set<unknown>()
    for (const t of targets) t.addEventListener('dispose', () => freed.add(t))
    s.dispose()
    expect(freed).toEqual(new Set(targets))
  })
})

describe('Surface: adaptive luma (clear + adaptive glass, spec §5.3)', () => {
  /** A 400 × 300 Surface: a card panel and one glass element at (40, 30), 120 × 60 pt, with glass style `g`. */
  function clearGlass(c: SurfaceContext = ctx, g: Record<string, unknown> = { variant: 'clear', adaptive: true }, background: 'none' | 'glass' = 'none') {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background }, c)
    const card = new Node('box', 'card'); card.setStyle({ position: 'absolute', left: 0, top: 0, width: 400, height: 300, bg: 'fill' })
    const el = new Node('glass', 'el'); el.setStyle({ position: 'absolute', left: 40, top: 30, width: 120, height: 60, glass: g })
    s.root.appendChild(card); card.appendChild(el)
    return s
  }
  /** A stub renderer recording the target and the scene of every draw. */
  const recording = () => {
    let bound: RenderTarget | null = null
    const drawn: (RenderTarget | null)[] = [], scenes: Object3D[] = []
    return { ...stubRenderer(), drawn, scenes, setRenderTarget: vi.fn((t: RenderTarget | null) => { bound = t }), render: vi.fn((scene: Object3D) => { drawn.push(bound); scenes.push(scene) }) }
  }
  const sampledBy = (ms: Mesh[]) => new Set(ms.flatMap(m => nodesOf((m.material as MeshPhysicalNodeMaterial).backdropNode)).filter(n => n.isTextureNode).map(n => n.value))

  it('a redraw draws the content, then the luma pass into a 256 × 1 target the element glass samples', () => {
    const s = clearGlass(); s.tick(1 / 60)
    const r = recording()
    s.prepare(r, { width: 400, height: 300 }, 1)
    expect(r.render).toHaveBeenCalledTimes(2)
    expect(r.drawn[0]).toBe(s.contentPass.target)
    const luma = r.drawn[1]!
    expect([luma.width, luma.height]).toEqual([256, 1])
    for (const m of elementGlass(s)) expect(sampledBy([m])).toContain(luma.texture)
  })
  it('packs the glass rect in content uv, v = 0 at the top: (x/W, y/H, w/W, h/H), where the content camera draws it', () => {
    const s = clearGlass(); s.tick(1 / 60)
    const r = recording()
    s.prepare(r, { width: 400, height: 300 }, 1)
    const kernel = ((r.scenes[1] as Mesh).material as MeshBasicNodeMaterial).colorNode
    const rects = nodesOf(kernel).map(n => n.value).find((v): v is DataTexture => v instanceof DataTexture)!
    const [u, v, w, h] = Array.from((rects.image.data as Float32Array).slice(0, 4))
    expect([u, v, w, h]).toEqual([40 / 400, 30 / 300, 120 / 400, 60 / 300].map(Math.fround))
    // the glass's corners through the content pass's camera: NDC y = +1 is the RT's top row (v = 0) on both backends
    const rtUV = (x: number, y: number) => { const p = new Vector3(...surfaceToLocal(x, y, s.model), 0).project(s.contentPass.camera); return [(p.x + 1) / 2, (1 - p.y) / 2] }
    const [[u0, v0], [u1, v1]] = [rtUV(40, 30), rtUV(160, 90)]
    expect(u0).toBeCloseTo(u!, 6); expect(v0).toBeCloseTo(v!, 6); expect(u1).toBeCloseTo(u! + w!, 6); expect(v1).toBeCloseTo(v! + h!, 6)
  })
  it('on the kawase tier a redraw is content 1 + pyramid 9 + luma 1, the luma last (it reads the content RT, not the pyramid)', () => {
    const q = { ...ctx.quality, blur: 'kawase' as const }
    const s = clearGlass({ ...ctx, quality: q }); s.tick(1 / 60)
    const r = recording()
    s.prepare(r, { width: 400, height: 300 }, 1)
    const pyramidPasses = 2 * 4 + 1                                   // 4 levels: 5 downs and 4 ups
    expect(r.render).toHaveBeenCalledTimes(1 + pyramidPasses + 1)
    expect(r.drawn[0]).toBe(s.contentPass.target)
    expect(r.drawn[r.drawn.length - 1]!.width).toBe(256)
    const read = new Set(nodesOf(((r.scenes[r.scenes.length - 1] as Mesh).material as MeshBasicNodeMaterial).colorNode).filter(n => n.isTextureNode).map(n => n.value))
    expect(read).toContain(s.contentPass.texture)
    for (const t of r.drawn.slice(1, -1)) expect(read).not.toContain(t!.texture)
  })
  it('without clear + adaptive glass a redraw draws the content only', () => {
    for (const g of [{ variant: 'clear', adaptive: false }, { variant: 'regular', adaptive: true }]) {
      const s = clearGlass(ctx, g); s.tick(1 / 60)
      const r = recording()
      s.prepare(r, { width: 400, height: 300 }, 1)
      expect(r.drawn).toEqual([s.contentPass.target])
    }
  })
  it('after a redraw the pass runs on while its smoothing settles, then a quiet prepare runs nothing', () => {
    const s = clearGlass(); s.tick(0.25)
    const r = recording()
    s.prepare(r, { width: 400, height: 300 }, 1)
    expect(r.render).toHaveBeenCalledTimes(2)
    for (let i = 0; i < 3; i++) { s.tick(0.25); expect(s.contentDirty || s.needsFrame).toBe(false); s.prepare(r, { width: 400, height: 300 }, 1) }
    expect(r.render).toHaveBeenCalledTimes(5)                         // luma only: 0.25, 0.5 and 0.75 s after the redraw
    expect(r.drawn.slice(2).every(t => t !== s.contentPass.target)).toBe(true)
    s.tick(0.25); s.prepare(r, { width: 400, height: 300 }, 1)        // 1 s (5τ): settled
    s.tick(0.25); s.prepare(r, { width: 400, height: 300 }, 1)
    expect(r.render).toHaveBeenCalledTimes(5)
  })
  it('a quality rebuild points the new element glass at the current luma result at once', () => {
    const s = clearGlass(); s.tick(1 / 60)
    const r = recording()
    s.prepare(r, { width: 400, height: 300 }, 1)
    const luma = r.drawn[1]!.texture
    s.setQuality({ ...ctx.quality, backFaces: false })
    expect(elementGlass(s)).toHaveLength(1)
    expect(sampledBy(elementGlass(s))).toContain(luma)
  })
  it('a glass background slab never samples the luma; the element glass on it does', () => {
    const s = clearGlass(ctx, { variant: 'clear', adaptive: true }, 'glass'); s.tick(1 / 60)
    const r = recording()
    s.prepare(r, { width: 400, height: 300 }, 1)
    const luma = r.drawn[1]!.texture
    expect(sampledBy(meshes(s).filter(m => m.renderOrder === SURFACE_ORDER.slab))).not.toContain(luma)
    expect(sampledBy(elementGlass(s))).toContain(luma)
  })
  it('a glass Surface drawn with a camera measures every frame, quiet ones too, over the slab capture\'s latest copy; a \'none\' one settles', () => {
    const camera = new PerspectiveCamera(40, 4 / 3, 0.1, 100); camera.position.z = 8; camera.updateMatrixWorld()
    const glass = clearGlass(ctx, { variant: 'clear', adaptive: true }, 'glass'), none = clearGlass()
    const capture = nodesOf((meshes(glass).find(m => m.renderOrder === SURFACE_ORDER.slab)!.material as MeshPhysicalNodeMaterial).backdropNode)
      .find((n): n is GraphNode & ScreenCapture => n instanceof ScreenCapture)!.getBase() as ScreenCapture
    const rs = [recording(), recording()] as const
    for (const [s, r] of [[glass, rs[0]], [none, rs[1]]] as const) {
      s.updateMatrixWorld(true); s.tick(0.25); s.prepare(r, { width: 400, height: 300 }, 1, camera)
      for (let i = 0; i < 8; i++) { s.tick(0.25); s.prepare(r, { width: 400, height: 300 }, 1, camera) }   // 2 s of quiet frames
    }
    expect(rs[0].render).toHaveBeenCalledTimes(2 + 8)
    expect(rs[1].render).toHaveBeenCalledTimes(2 + 3)                 // the settle window only
    const read = (r: typeof rs[0]) => new Set(nodesOf(((r.scenes[r.scenes.length - 1] as Mesh).material as MeshBasicNodeMaterial).colorNode).map(n => n.value))
    capture.latest = new FramebufferTexture(8, 8)                     // what the slab's next copy would leave
    glass.tick(0.25); glass.prepare(rs[0], { width: 400, height: 300 }, 1, camera)
    expect(read(rs[0])).toContain(capture.latest)
    expect(read(rs[0])).toContain(glass.contentPass.texture)
  })
  it('dispose frees the luma pass', () => {
    const s = clearGlass(); s.tick(1 / 60)
    const r = recording()
    s.prepare(r, { width: 400, height: 300 }, 1); s.tick(1 / 60); s.prepare(r, { width: 400, height: 300 }, 1)
    const targets = [...new Set(r.drawn)].filter(t => t !== s.contentPass.target) as RenderTarget[]
    expect(targets).toHaveLength(2)                                   // both ping-pong targets
    const freed = new Set<unknown>()
    for (const t of targets) t.addEventListener('dispose', () => freed.add(t))
    s.dispose()
    expect(freed).toEqual(new Set(targets))
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

describe('content quad orientation', () => {
  it('reads the render target upright: the quad\'s top edge (uv v = 1) samples the RT\'s top row (v = 0)', () => {
    const m = createContentMaterial(new Texture())
    const at = (u: number, v: number) => evalNode(m.colorNode, { uv: [u, v] }, undefined, undefined, (_t, uv) => [uv[0]!, uv[1]!, 0, 1])
    expect(at(0.25, 1)).toEqual([0.25, 0, 0])
    expect(at(0.75, 0)).toEqual([0.75, 1, 0])
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
    it(`${forceWebGL ? 'GLSL' : 'WGSL'}: a 'none' Surface's draws copy nothing first; a glass Surface's element glass reuses the slab's copies`, () => {
      const warnings: string[] = []
      const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')) })
      const copies = (m: Mesh) => buildShaders(m.material as MeshPhysicalNodeMaterial, m.geometry, forceWebGL).updateBefore
        .filter(n => CAPTURES.includes(n.constructor.type!)).map(n => n.getBase!())
      try {
        const none = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, ctx)
        const draws = [...meshes(none), ...meshes(none.contentPass.scene)]
        expect(draws.length).toBeGreaterThanOrEqual(6)   // content quad, element glass ×2, rims; panels, pools
        for (const m of draws) expect(copies(m)).toEqual([])
        const glass = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, ctx)
        const slabCopies = new Set(meshes(glass).filter(m => m.renderOrder === SURFACE_ORDER.slab).flatMap(copies))
        expect(slabCopies.size).toBe(2)                     // one framebuffer and one depth capture
        for (const m of elementGlass(glass)) expect(new Set(copies(m))).toEqual(slabCopies)
      } finally { spy.mockRestore() }
      expect(warnings.filter(w => !w.includes('Vertex attribute "position" not found'))).toEqual([])
    })
  }
})

describe('Surface: the glass modes of the quality tiers (spec §5.6)', () => {
  const graph = (ms: Mesh[]) => ms.flatMap(m => materialGraph(m.material as Material))
  const slabOf = (s: Surface) => meshes(s).filter(m => m.renderOrder === SURFACE_ORDER.slab)
  const refractions = (ms: Mesh[]) => graph(ms).filter(n => n.constructor.type === 'MathNode' && (n as { method?: string }).method === 'refract').length
  for (const forceWebGL of [false, true]) {
    it(`${forceWebGL ? 'GLSL' : 'WGSL'}: on minimal (fill) no draw copies the framebuffer or the depth buffer; back on high the slab takes its captures again`, () => {
      const warnings: string[] = []
      const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')) })
      const copies = (m: Mesh) => buildShaders(m.material as MeshPhysicalNodeMaterial, m.geometry, forceWebGL).updateBefore
        .filter(n => CAPTURES.includes(n.constructor.type!)).map(n => n.getBase!())
      try {
        const { s } = signup({ ...ctx })
        const glass = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, { ...ctx })
        glass.root.appendChild(s.root.children[0]!)                  // the sign-up card on a glass Surface
        glass.tick(1 / 60)
        const draws = () => [...meshes(glass), ...meshes(glass.contentPass.scene)]
        const before = new Set(slabOf(glass).flatMap(copies))
        expect(before.size).toBe(2)                                   // one framebuffer and one depth capture
        glass.setQuality(QUALITY.minimal)
        expect(draws().length).toBeGreaterThanOrEqual(8)
        for (const m of draws()) expect(copies(m)).toEqual([])
        glass.setQuality(QUALITY.high)
        const after = new Set(slabOf(glass).flatMap(copies))
        expect(after).toEqual(before)                                 // the Surface's own captures, resumed
        for (const m of elementGlass(glass)) expect(new Set(copies(m))).toEqual(after)
      } finally { spy.mockRestore() }
      expect(warnings.filter(w => !w.includes('Vertex attribute "position" not found'))).toEqual([])
    })
  }
  it('fill: the slab and the element glass sample nothing and draw the theme\'s fill colour, linear; the luma never runs', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const c: SurfaceContext = { ...ctx, scheme, quality: QUALITY.minimal }
      const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, c)
      const el = new Node('glass', 'el'); el.setStyle({ position: 'absolute', left: 40, top: 30, width: 120, height: 60, glass: { variant: 'clear', adaptive: true } })
      s.root.appendChild(el)
      s.updateMatrixWorld(true); s.tick(1 / 60)
      const draws = [...slabOf(s), ...elementGlass(s)]
      expect(draws).toHaveLength(2)                                   // minimal: front faces only
      expect(graph(draws).filter(n => n.isTextureNode)).toEqual([])
      const fill = toColor(resolveColor('fill', theme, scheme))
      const pinned = { vGlassMisc: [1, -1, -1, 1], vGlassTint: [1, 1, 1, 0], vGlassOptics: [1.5, 0, 0, 0], vGlassGlow2: [-1, 0.04, 0, 0], vGlassGeom: [0.1, 0.1, 0.5, 0.5] }
      for (const m of draws) expect(evalNode((m.material as MeshPhysicalNodeMaterial).backdropNode, pinned).map(v => +v.toFixed(9))).toEqual([fill.r, fill.g, fill.b].map(v => +v.toFixed(9)))
      const camera = new PerspectiveCamera(40, 4 / 3, 0.1, 100); camera.position.z = 8; camera.updateMatrixWorld()
      const r = stubRenderer()
      for (let i = 0; i < 3; i++) { s.tick(1 / 60); s.prepare(r, { width: 400, height: 300 }, 1, camera) }
      expect(r.render).toHaveBeenCalledTimes(1)                       // the content once: no luma pass, no pyramid
    }
  })
  it('low (straight): the element glass sees the content RT and the slab capture unrefracted, with no depth copy even when asked', () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, { ...ctx })
    s.setQuality({ ...QUALITY.low, depthReject: true })
    const g = graph(elementGlass(s))
    expect(refractions(elementGlass(s))).toBe(0); expect(refractions(slabOf(s))).toBe(0)
    expect(g.filter(n => n.isTextureNode).map(n => n.value)).toContain(s.contentPass.texture)
    expect(new Set(g.filter(n => n.constructor.type === 'ViewportTextureNode').map(n => n.getBase!()))).toEqual(new Set(graph(slabOf(s)).filter(n => n.constructor.type === 'ViewportTextureNode').map(n => n.getBase!())))
    expect(graph([...slabOf(s), ...elementGlass(s)]).some(n => n.constructor.type === 'ViewportDepthTextureNode')).toBe(false)
  })
  it('refract per colour channel unless the quality\'s dispersion is \'never\' (medium\'s \'auto\' disperses for now)', () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, { ...ctx, quality: QUALITY.medium })
    expect(elementGlass(s)).toHaveLength(1); expect(refractions(elementGlass(s))).toBe(3)
    s.setQuality({ ...QUALITY.medium, dispersion: 'never' })
    expect(refractions(elementGlass(s))).toBe(1)
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
