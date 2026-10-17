import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { AlwaysDepth, Color, CustomBlending, DataTexture, FramebufferTexture, FrontSide, PerspectiveCamera, Group, HalfFloatType, Mesh, Object3D, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, Texture, UnsignedByteType, Vector2, Vector3, type Material, type RenderTarget } from 'three'
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, type MeshBasicNodeMaterial } from 'three/webgpu'
import { Node, buildRenderList, createYogaLayout, AnimationRuntime, defaultTheme as theme, resolveColor } from '@glassui/core'
import { SystemFontEngine } from '@glassui/text'
import { Surface, createContentMaterial, fillColors, CONTENT_ORDER, SLAB_FROST, SURFACE_ORDER, type SurfaceContext } from '../src/surface/surface'
import { FILL, SLAB_BEHIND } from '../src/glass/frost'
import { AtlasPages } from '../src/text/pages'
import { createMeasureFn } from '../src/text/measure'
import { REFLECTION_STRENGTH } from '../src/glass/batch'
import { srgbToLinear } from '../src/color'
import { surfaceToLocal } from '../src/units'
import { ScreenCapture } from '../src/glass/material'
import { buildShaders } from './fixtures/build-shaders'
import { LumaPass } from '../src/luma'
import { QUALITY } from '../src/quality'
import { toColor } from '../src/color'
import { evalNode } from './fixtures/tsl-eval'
import { SHADOW_DECAL } from '../src/decoration/material'
import { fusedProfile, fusedShapes } from '../src/surface/fused'
import { extrudeSlab, fusedOutline } from '../src/glass/fused'

let ctx: SurfaceContext
beforeAll(async () => {
  const text = new SystemFontEngine({ createCanvas: ((w: number, h: number) => createCanvas(w, h)) as never, pageSize: 512, maxPages: 2 })
  ctx = { theme, scheme: 'light', layout: await createYogaLayout(), measure: createMeasureFn(text, theme, 'light'), anim: new AnimationRuntime(theme, 'light'), text, pages: new AtlasPages(text.atlas), contrast: false, quality: { contentType: 'byte', contentScale: 1, backFaces: true, depthReject: true, blur: 'mip', glassMode: 'refract', dispersion: 'always' } }
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
/** The capture nodes `ms` sample. */
const capturesIn = (ms: Mesh[]) => ms.flatMap(m => materialGraph(m.material as Material)).filter(n => CAPTURES.includes(n.constructor.type!))
/** A 'none' Surface's draws at the slab's place in the order: its capture probe, when it has one. */
const probeOf = (s: Surface) => meshes(s).filter(m => m.renderOrder === SURFACE_ORDER.slab)

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
  it('worldFromPoint maps Surface pt onto the content quad, in world space (the glass slab\'s lift included)', () => {
    for (const background of ['none', 'glass'] as const) {
      const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background }, ctx)
      const parent = new Group(); parent.position.set(1, -2, 3); parent.rotation.set(0.2, 0.4, -0.1); parent.add(s)
      s.position.set(0.5, 0.25, -1); s.rotation.y = 0.6; s.scale.setScalar(1.5)
      parent.updateMatrixWorld(true)
      const at = (x: number, y: number) => s.worldFromPoint(x, y, new Vector3())
      const corner = (x: number, y: number) => s.contentMesh.localToWorld(new Vector3(x, y, 0))
      expect(at(0, 0).distanceTo(corner(-0.5, 0.5))).toBeLessThan(1e-9)
      expect(at(400, 300).distanceTo(corner(0.5, -0.5))).toBeLessThan(1e-9)
      expect(at(200, 150).distanceTo(corner(0, 0))).toBeLessThan(1e-9)
      const target = new Vector3(); expect(s.worldFromPoint(1, 2, target)).toBe(target)
    }
  })
  it('restyle re-reads the scheme: an opaque token background clears to its new colour, every node is marked, the content redraws', () => {
    const c: SurfaceContext = { ...ctx }
    const s = new Surface({ width: 40, height: 30, background: 'fill' }, c)
    const label = new Node('text', 'l'); label.setProp('value', 'a'); s.root.appendChild(label)
    s.tick(1 / 60); s.prepare(stubRenderer(), { width: 40, height: 30 }, 1)
    expect(s.contentDirty).toBe(false); expect(label.dirty.paint || label.dirty.layout || label.dirty.text).toBe(false)
    c.scheme = 'dark'
    s.restyle()
    expect(s.contentDirty).toBe(true)
    expect([label.dirty.layout, label.dirty.paint, label.dirty.text, s.root.dirty.layout, s.root.dirty.paint]).toEqual([true, true, true, true, true])
    s.tick(1 / 60)
    const r = stubRenderer(); s.prepare(r, { width: 40, height: 30 }, 1)
    const [color, alpha] = r.setClearColor.mock.calls[0]!, dark = toColor(resolveColor('fill', theme, 'dark'))
    expect(color.getHexString()).toBe(dark.getHexString()); expect(alpha).toBe(1)
    expect(s.error).toBeNull()
  })
  it("restyle rebuilds the glass through the same path: a 'none' Surface keeps its behind-capture, a glass one its screen capture", () => {
    const base = (ms: Mesh[]) => new Set(ms.flatMap(m => materialGraph(m.material as Material)).filter(n => n.constructor.type === 'ViewportTextureNode').map(n => n.getBase!()))
    for (const background of ['none', 'glass'] as const) {
      const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background }, { ...ctx })
      const g = new Node('glass', 'g'); g.setStyle({ position: 'absolute', left: 20, top: 20, width: 200, height: 60, radius: 'capsule' })
      s.root.appendChild(g); s.tick(0)
      const before = elementGlass(s), captures = base(before), probe = probeOf(s)
      expect(captures.size).toBe(1)
      s.restyle()
      const after = elementGlass(s)
      expect(after).toHaveLength(before.length)
      for (const m of before) expect(after).not.toContain(m)        // rebuilt, the old draws gone
      expect(base(after)).toEqual(captures)
      // 'none': the same probe; glass: new slab faces around the same screen capture
      if (background === 'none') expect(probeOf(s)).toEqual(probe)
      else expect(base(probeOf(s))).toEqual(captures)
      expect(s.error).toBeNull()
    }
  })
  it('restyle re-reads a swapped theme: the background slab, the pointer tracker\'s radius tokens', () => {
    const c: SurfaceContext = { ...ctx }
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, c)
    const ior = () => s.backgroundGlass!.geometry.getAttribute('iOptics').getX(0)
    expect(ior()).toBeCloseTo(theme.glass.ior)
    const other = { ...theme, glass: { ...theme.glass, ior: 1.2 } }
    c.theme = other
    s.restyle()
    expect(s.pointer.theme).toBe(other); expect(ior()).toBeCloseTo(1.2)
    expect(s.error).toBeNull()
  })
  it('a restyle that throws fails the Surface; a failed Surface ignores it', () => {
    const brand = { ...theme, colors: { light: { ...theme.colors.light, brand: '#ff0000' }, dark: theme.colors.dark } }
    const c: SurfaceContext = { ...ctx, theme: brand }
    const s = new Surface({ width: 40, height: 30, background: 'brand' }, c)
    const onError = vi.fn(); s.addEventListener('error', onError)
    c.scheme = 'dark'                                              // 'brand' has no dark value
    expect(() => s.restyle()).not.toThrow()
    expect(s.error?.message).toMatch(/brand/); expect(onError).toHaveBeenCalledTimes(1)
    s.restyle(); expect(onError).toHaveBeenCalledTimes(1)
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
    expect(meshes(s).filter(m => m.renderOrder === SURFACE_ORDER.slab).every(m => localZ(s, m) === 0)).toBe(true)
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
    const slab = meshes(s).filter(m => m.renderOrder === SURFACE_ORDER.slab)
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
    const sample = meshes(s).filter(m => m.renderOrder === SURFACE_ORDER.slab).flatMap(m => nodesOf((m.material as MeshPhysicalNodeMaterial).backdropNode))
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
    expect(SURFACE_ORDER).toEqual({ floor: -2, slab: -1, content: 0, glassBack: 1, glassFront: 2, innerGlassBack: 2.25, innerGlassFront: 2.5, panels: 2.75, rims: 3, viewport: 3.25, images: 3.5, glyphs: 4 })
    expect(CONTENT_ORDER).toEqual({ panels: 0, shadows: 0.5, pools: 1, images: 1.5, glyphs: 2 })
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
  it('a screen Surface draws its depth floor first: over its rect, behind its slab, depth always, no colour; a world one has none', () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 1, placement: 'screen', background: 'glass', cornerRadius: 32 }, ctx)
    s.tick(1 / 60)
    const floors = meshes(s).filter(m => m.renderOrder === SURFACE_ORDER.floor)
    expect(floors).toHaveLength(1)
    const f = floors[0]!, m = f.material as MeshBasicNodeMaterial
    expect(f.parent).toBe(s.layer); expect(f.name).toBe('screen-floor')
    expect(Math.min(...meshes(s).map(x => x.renderOrder))).toBe(SURFACE_ORDER.floor)   // the first draw in the Surface's group
    expect(m.colorWrite).toBe(false); expect(m.depthWrite).toBe(true); expect(m.depthTest).toBe(true); expect(m.depthFunc).toBe(AlwaysDepth)
    expect(m.transparent).toBe(true)                                     // sorted with the Surfaces' other draws, by group order
    expect(localZ(s, f)).toBe(-1)                                        // 1 pt behind the slab's bottom (its z = 0) ...
    for (const x of meshes(s)) if (x !== f) expect(localZ(s, x)).toBeGreaterThanOrEqual(0)   // ... so behind all it draws
    expect([f.scale.x, f.scale.y]).toEqual([402, 302]); expect(f.castShadow).toBe(false)   // not placed yet: the rect, 1 px out
    s.setSize(480, 220); expect([f.scale.x, f.scale.y]).toEqual([482, 222])
    // placed off-centre under a perspective eye: it reaches past the rect toward the viewport's centre (the slab's
    // bottom shows there) and is enlarged for its own depth (the root's replay test checks the depths it leaves)
    s.position.set(-500, 0, -s.contentPlaneZ); s.fitScreenFloor(1000)
    // where the floor's edge shows on the plane (the layer's x, drawn toward the centre for its depth), and the slab's
    // bottom on the side facing the centre
    const shown = (x: number) => (s.position.x + f.position.x + x * f.scale.x / 2) * 1000 / (1000 + s.contentPlaneZ + 1)
    expect(shown(-1)).toBeLessThan(-500 - 240); expect(shown(1)).toBeGreaterThan((-500 + 240) * 1000 / (1000 + s.contentPlaneZ))
    s.fitScreenFloor(Infinity); expect([f.scale.x, f.scale.y, f.position.x]).toEqual([482, 222, 0])   // orthographic: nothing shrinks
    const world = new Surface({ width: 400, height: 300, ptPerUnit: 100, placement: 'world', background: 'glass' }, ctx)
    expect(meshes(world).filter(x => x.renderOrder === SURFACE_ORDER.floor)).toHaveLength(0)
    const material = vi.spyOn(m, 'dispose'), geometry = vi.spyOn(f.geometry, 'dispose')
    s.dispose(); expect(material).toHaveBeenCalled(); expect(geometry).toHaveBeenCalled()
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
  it("a 'none' Surface without glass takes no capture", () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, { ...ctx })
    const card = new Node('box'); card.setStyle({ position: 'absolute', left: 0, top: 0, width: 100, height: 100, bg: 'fill' })
    s.root.appendChild(card); s.tick(0)
    expect(capturesIn([...meshes(s), ...meshes(s.contentPass.scene)])).toEqual([])
    expect(probeOf(s)).toEqual([])
  })
  it("a 'none' Surface with glass captures what is behind it before its content quad, and drops the capture with the glass", () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, { ...ctx })
    const g = new Node('glass', 'g'); g.setStyle({ position: 'absolute', left: 20, top: 20, width: 200, height: 60, radius: 'capsule' })
    s.root.appendChild(g); s.tick(0)
    const probe = probeOf(s)
    expect(probe).toHaveLength(1)
    expect(probe[0]!.renderOrder).toBeLessThan(SURFACE_ORDER.content)
    // what that order rests on: the probe sorts with the (transparent) content quad, in the Surface's own layer group
    expect((probe[0]!.material as Material).transparent).toBe(true); expect(probe[0]!.parent).toBe(s.layer)
    const base = (ms: Mesh[]) => new Set(ms.flatMap(m => materialGraph(m.material as Material)).filter(n => n.constructor.type === 'ViewportTextureNode').map(n => n.getBase!()))
    const probeBase = base(probe)
    expect(probeBase.size).toBe(1)
    expect(base(elementGlass(s))).toEqual(probeBase)                     // element glass reads the probe's copy: one copy
    g.remove(); s.tick(0)
    expect(probeOf(s)).toEqual([])
    expect(capturesIn([...meshes(s), ...meshes(s.contentPass.scene)])).toEqual([])
  })
  it("a 'none' Surface's element glass reads what is behind it at its own roughness level, as it frosts its content", () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, { ...ctx })
    const g = new Node('glass'); g.setStyle({ position: 'absolute', left: 20, top: 20, width: 200, height: 60, glass: { roughness: 0.5 } })
    s.root.appendChild(g); s.tick(0)
    for (const mode of ['refract', 'straight'] as const) {
      s.setQuality({ ...ctx.quality, glassMode: mode })
      const samples = capturesIn(elementGlass(s)).map(n => (n as GraphNode & { levelNode?: GraphNode | null }).levelNode).filter(l => l)
      expect(samples.length).toBeGreaterThan(0)
      // the level is the glass's roughness (its vGlassOptics varying) × FROST.levelPerRoughness, not a constant
      for (const l of samples) {
        expect(l!.constructor.type).not.toBe('ConstNode')
        expect(nodesOf(l).some(n => n.constructor.type === 'VaryingNode' && (n as { name?: string }).name === 'vGlassOptics')).toBe(true)
      }
    }
  })
  it("a 'none' Surface in the 'fill' glass mode takes no capture even with glass", () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, { ...ctx, quality: QUALITY.minimal })
    const g = new Node('glass'); g.setStyle({ position: 'absolute', left: 20, top: 20, width: 200, height: 60 })
    s.root.appendChild(g); s.tick(0)
    expect(probeOf(s)).toEqual([])
    expect(capturesIn(meshes(s))).toEqual([])
  })
  it("a 'none' Surface's behind-capture follows the quality: dropped on 'fill', made again on a refracting tier, freed on dispose", () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, { ...ctx })
    const g = new Node('glass'); g.setStyle({ position: 'absolute', left: 20, top: 20, width: 200, height: 60 })
    s.root.appendChild(g); s.tick(0)
    const first = probeOf(s)[0]!
    const freed: unknown[] = []
    ;(first.material as Material).addEventListener('dispose', () => freed.push(first.material))
    s.setQuality(QUALITY.minimal)
    expect(probeOf(s)).toEqual([]); expect(capturesIn(meshes(s))).toEqual([]); expect(freed).toHaveLength(1)
    s.setQuality(QUALITY.high)
    const again = probeOf(s)
    expect(again).toHaveLength(1)
    const bases = (ms: Mesh[]) => new Set(capturesIn(ms).map(n => n.getBase!()))
    expect(bases(elementGlass(s))).toEqual(bases(again))
    const capture = [...bases(again)][0] as { value: Texture }
    let captureFreed = 0
    capture.value.addEventListener('dispose', () => { captureFreed++ })
    ;(again[0]!.material as Material).addEventListener('dispose', () => freed.push(again[0]!.material))
    s.dispose()
    expect(captureFreed).toBe(1); expect(freed).toHaveLength(2)
  })
  it('the probe builds on both backends and copies the framebuffer, the copy the element glass reads', () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, { ...ctx })
    const g = new Node('glass'); g.setStyle({ position: 'absolute', left: 20, top: 20, width: 200, height: 60 })
    s.root.appendChild(g); s.tick(0)
    const warnings: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')) })
    const copies = (m: Mesh, forceWebGL: boolean) => new Set(buildShaders(m.material as never, m.geometry, forceWebGL).updateBefore
      .filter(n => CAPTURES.includes(n.constructor.type!)).map(n => n.getBase!()))
    try {
      for (const forceWebGL of [false, true]) {
        const probe = probeOf(s)[0]!
        expect(buildShaders(probe.material as never, probe.geometry, forceWebGL).updateBefore.length).toBeGreaterThan(0)
        const probeCopies = copies(probe, forceWebGL)
        expect(probeCopies.size).toBe(1)
        for (const m of elementGlass(s)) expect(copies(m, forceWebGL)).toEqual(probeCopies)
      }
    } finally { spy.mockRestore() }
    expect(warnings.filter(w => !w.includes('Vertex attribute "position" not found'))).toEqual([])
  })
  it("takesPointer on a 'none' Surface: only where a node on the path from the hit up to the root is painted or interactive", () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 1 }, { ...ctx })
    // a full-size layout wrapper, as a Vue template has, around a painted chip, a text, an image and an unpainted box
    const wrap = new Node('box', 'wrap'); wrap.setStyle({ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' })
    const chip = new Node('box', 'chip'); chip.setStyle({ position: 'absolute', left: 10, top: 10, width: 50, height: 50, bg: 'fill' })
    const label = new Node('text', 'label'); label.setProp('value', 'Hi'); label.setStyle({ position: 'absolute', left: 100, top: 10, width: 60, height: 20 })
    const inner = new Node('box', 'inner'); inner.setStyle({ position: 'absolute', left: 300, top: 200, width: 50, height: 50 })
    const list = new Node('scroll', 'list'); list.setStyle({ position: 'absolute', left: 10, top: 100, width: 100, height: 100 })
    const row = new Node('box', 'row'); row.setStyle({ height: 20, flexShrink: 0 }); list.appendChild(row)   // unpainted content
    for (const n of [chip, label, image('pic', new Texture(), 200, 10), inner, list]) wrap.appendChild(n)
    s.root.appendChild(wrap); s.tick(0)
    expect(s.hitNode(300, 150)).toBe(wrap); expect(s.hitNode(310, 210)).toBe(inner)
    expect(s.takesPointer(20, 20)).toBe(true)                          // the chip's background
    expect(s.takesPointer(110, 15)).toBe(true)                         // a text
    expect(s.takesPointer(210, 20)).toBe(true)                         // an image
    expect(s.takesPointer(300, 150)).toBe(false)                       // the wrapper's empty area: through to what is behind
    expect(s.takesPointer(310, 210)).toBe(false)                       // an unpainted box in it: through too
    expect(s.hitNode(50, 150)).toBe(list); expect(s.takesPointer(50, 150)).toBe(true)   // a scroll node's empty area: it scrolls
    expect(s.hitNode(50, 110)).toBe(row); expect(s.takesPointer(50, 110)).toBe(true)    // and its unpainted content
    wrap.setProp('tabIndex', 0)                                        // focusable: interactive, and so is all of it
    expect(s.takesPointer(300, 150)).toBe(true); expect(s.takesPointer(310, 210)).toBe(true)
    wrap.setProp('tabIndex', null)
    expect(s.takesPointer(300, 150)).toBe(false)
    // element handlers (`Node.handlers`, Vue's on* props): a pointer type takes, a key type does not; only on the hit path
    inner.setHandler('keydown', () => {})
    expect(s.takesPointer(310, 210)).toBe(false)
    inner.setHandler('click', () => {})
    expect(s.takesPointer(310, 210)).toBe(true); expect(s.takesPointer(300, 150)).toBe(false)
    inner.setHandler('click', null)
    expect(s.takesPointer(310, 210)).toBe(false)
    inner.setHandler('contextmenu', () => {})
    expect(s.takesPointer(310, 210)).toBe(true)
    inner.setStyle({ border: { width: 1, color: 'separator' } }); inner.setHandler('contextmenu', null); inner.setHandler('keydown', null); s.tick(0)
    expect(s.takesPointer(310, 210)).toBe(true)                        // a border paints
    s.root.setStyle({ bg: '#00000040' }); s.tick(0)
    expect(s.takesPointer(300, 150)).toBe(true)                        // a root background paints the whole Surface
  })
  it('takesPointer: a bare root takes nothing, a hit node, a coloured root or a glass background takes the pointer', () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 1 }, { ...ctx })
    const b = new Node('box'); b.setStyle({ position: 'absolute', left: 10, top: 10, width: 50, height: 50, bg: 'fill' })
    s.root.appendChild(b); s.tick(0)
    expect(s.takesPointer(20, 20)).toBe(true)
    expect(s.takesPointer(300, 200)).toBe(false)
    s.root.setStyle({ bg: '#00000040' }); s.tick(0)
    expect(s.takesPointer(300, 200)).toBe(true)
    const glass = new Surface({ width: 400, height: 300, ptPerUnit: 1, background: 'glass' }, { ...ctx }); glass.tick(0)
    expect(glass.takesPointer(300, 200)).toBe(true)
  })
  it("takesPointer: a 'box-none' node is not the pointer's — neither its scrolling nor its paint — while its children are", () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 1 }, { ...ctx })
    // a full-screen page: a scroll root that lets the pointer through its empty area, around unpainted content and a text
    const page = new Node('scroll', 'page'); page.setStyle({ width: '100%', height: '100%', pointerEvents: 'box-none', bg: '#00000020' })
    const content = new Node('box', 'content'); content.setStyle({ height: 500, flexShrink: 0 })
    const label = new Node('text', 'label'); label.setProp('value', 'Hi'); label.setStyle({ position: 'absolute', left: 20, top: 20, width: 60, height: 20 })
    content.appendChild(label); page.appendChild(content); s.root.appendChild(page); s.tick(0)
    expect(s.hitNode(300, 200)).toBe(content)                          // the scroll itself is never hit
    expect(s.takesPointer(300, 200)).toBe(false)                       // through: it neither scrolls nor paints for the pointer
    expect(s.takesPointer(30, 25)).toBe(true)                          // its text does
    content.setHandler('click', () => {})
    expect(s.takesPointer(300, 200)).toBe(true)                        // and so does an interactive child
    content.setHandler('click', null)
    page.setStyle({ pointerEvents: 'auto' }); s.tick(0)
    expect(s.takesPointer(300, 200)).toBe(true)                        // an ordinary scroll takes its whole area
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
  it('dispose is idempotent: a second call frees nothing twice, the captures and the probe included; one dispose event, after the frees', () => {
    type Disposable = { addEventListener(type: 'dispose', fn: () => void): void }
    type Captures = { screen: Disposable | null; depth: Disposable | null; behindCapture: Disposable | null; captureProbe: Mesh | null }
    const glassy = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, { ...ctx })   // screen + depth captures
    const bare = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, { ...ctx })                          // with glass: a behind-capture and its probe
    for (const s of [glassy, bare]) {
      const g = new Node('glass'); g.setStyle({ position: 'absolute', left: 20, top: 20, width: 200, height: 60 })
      s.root.appendChild(g); s.tick(0)
    }
    const own = (s: Surface) => s as unknown as Captures
    const { screen, depth } = own(glassy), { behindCapture, captureProbe } = own(bare)
    expect([screen, depth, behindCapture, captureProbe].every(c => c !== null)).toBe(true)
    // the slab-order meshes: the glass Surface's background slab, the 'none' one's probe
    const draws = (s: Surface): Disposable[] => [s.contentPass.target, s.contentMesh.geometry, s.contentMesh.material as Material,
      ...meshes(s).filter(m => m.renderOrder === SURFACE_ORDER.slab || elementGlass(s).includes(m)).map(m => m.material as Material)]
    const tracked = new Map<Surface, Set<Disposable>>([
      [glassy, new Set([...draws(glassy), screen!, depth!])],
      [bare, new Set([...draws(bare), behindCapture!, captureProbe!.material as Material, captureProbe!.geometry])],
    ])
    expect(tracked.get(bare)!.has(captureProbe!.material as Material)).toBe(true)
    const freed = new Map<object, number>(), events: boolean[] = []
    for (const [s, objs] of tracked) {
      for (const o of objs) o.addEventListener('dispose', () => freed.set(o, (freed.get(o) ?? 0) + 1))
      s.addEventListener('dispose', () => events.push([...objs].every(o => freed.get(o) === 1)))
      expect(s.disposed).toBe(false)
      s.dispose(); s.dispose()
      expect(s.disposed).toBe(true)
    }
    expect(events).toEqual([true, true])           // one event per Surface, after its frees
    for (const objs of tracked.values()) { expect(objs.size).toBeGreaterThan(5); for (const o of objs) expect(freed.get(o)).toBe(1) }
  })
  it('a disposed Surface does not tick, prepare, rebuild or resize', () => {
    const { s, btn } = signup()
    s.tick(1 / 60); s.dispose()
    btn.setStyle({ width: 100 })
    const compute = vi.spyOn(ctx.layout, 'compute'), build = vi.spyOn(s as unknown as { buildGlass(q: unknown): void }, 'buildGlass')
    const renderer = stubRenderer()
    try {
      s.tick(1 / 60); s.prepare(renderer, { width: 400, height: 300 }, 1)
      s.setQuality({ ...ctx.quality, backFaces: false }); s.restyle(); ctx.text.atlas.invalidate()
      expect(s.refreshText()).toBe(false)
      expect(compute).not.toHaveBeenCalled(); expect(renderer.render).not.toHaveBeenCalled(); expect(build).not.toHaveBeenCalled()
      expect(s.error).toBeNull()
      s.setSize(10, 10)                             // the Vue layer may still patch its size while unmounting
      expect([s.model.width, s.model.height]).toEqual([400, 300]); expect(s.contentMesh.scale.x).toBeCloseTo(4)
    } finally { compute.mockRestore() }
  })
  it('markFailed stops the Surface: error set, hidden, one error event; its nodes\' whenSettled waiters settle', async () => {
    const { s, btn } = signup()
    s.tick(1 / 60); btn.setState({ pressed: true }); s.tick(1 / 60)
    expect(s.needsFrame).toBe(true)                // the press is animating
    let settled = false
    void ctx.anim.whenSettled(btn).then(() => { settled = true })
    const onError = vi.fn(); s.addEventListener('error', onError)
    s.markFailed('shader')
    expect(s.error).toBeInstanceOf(Error); expect(s.error!.message).toBe('shader')
    expect(s.visible).toBe(false); expect(s.needsFrame).toBe(false); expect(onError).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(settled).toBe(true)                    // a failed Surface never ticks again: its waiters must not hang
    s.markFailed(new Error('again'))              // already down: the first error stands, no second event
    expect(s.error!.message).toBe('shader'); expect(onError).toHaveBeenCalledTimes(1)
    s.dispose()
    const late = new Surface({ width: 10, height: 10 }, ctx); late.dispose()
    late.markFailed(new Error('after dispose'))   // a disposed Surface stays as it is
    expect(late.error).toBeNull()
  })
})

describe('Surface motion', () => {
  const world = () => new Surface({ id: 'w', width: 400, height: 300, ptPerUnit: 100, placement: 'world' }, ctx)
  const quadAlpha = (s: Surface) => evalNode((s.contentMesh.material as MeshStandardNodeMaterial).opacityNode, { uv: [0.5, 0.5] }, undefined, undefined, () => [1, 1, 1, 1])[0]!
  it('animateTo moves a world Surface and fades its plane draws; restPose is the target', async () => {
    const s = world(), done = s.animateTo({ position: [1, 0, 0], opacity: 0.5 })
    expect(s.restPose.position).toEqual([1, 0, 0]); expect(s.restPose.opacity).toBe(0.5)
    s.stepMotion(1 / 60); expect(s.position.x).toBeGreaterThan(0)
    for (let i = 0; i < 180; i++) s.stepMotion(1 / 60)
    expect(s.position.x).toBe(1); expect(s.opacity).toBe(0.5); expect(quadAlpha(s)).toBeCloseTo(0.5)
    await expect(done).resolves.toBe(true)
  })
  it('below opacity 1 the content quad stops writing depth; at 0 the layer hides', () => {
    const s = world(), m = s.contentMesh.material as MeshStandardNodeMaterial
    s.opacity = 0.5; expect(m.depthWrite).toBe(false); expect(s.layer.visible).toBe(true)
    s.opacity = 1; expect(m.depthWrite).toBe(true)
    s.opacity = 0; expect(s.layer.visible).toBe(false)
    s.opacity = 0.2; s.culled = true; expect(s.layer.visible).toBe(false)
    s.culled = false; expect(s.layer.visible).toBe(true)
  })
  it('reduced motion jumps; a failed or disposed Surface resolves false at once; dispose ends a running one false', async () => {
    const s = world(); ctx.anim.reducedMotion = true
    try { const p = s.animateTo({ position: [3, 0, 0] }); s.stepMotion(1 / 60); expect(s.position.x).toBe(3); await expect(p).resolves.toBe(true) }
    finally { ctx.anim.reducedMotion = false }
    const d = world(); d.dispose(); await expect(d.animateTo({ opacity: 0 })).resolves.toBe(false)
    const f = world(); f.markFailed(new Error('x')); await expect(f.animateTo({ opacity: 0 })).resolves.toBe(false)
    const g = world(), running = g.animateTo({ opacity: 0 }); g.dispose(); await expect(running).resolves.toBe(false)
  })
  it('a screen Surface animates opacity only', () => {
    const s = new Surface({ width: 10, height: 10, ptPerUnit: 1, placement: 'screen' }, ctx)
    expect(() => s.animateTo({ position: [1, 0, 0] })).toThrow(/\[Surface\.animateTo\].*屏幕层/)
    expect(() => s.animateTo({ opacity: 0.5 })).not.toThrow()
  })
  it('a direct write between animations is where the next one starts', () => {
    const s = world(); s.position.set(5, 0, 0)
    void s.animateTo({ position: [6, 0, 0] }); s.stepMotion(1 / 60)
    expect(s.position.x).toBeGreaterThan(5); expect(s.position.x).toBeLessThan(6)
  })
  it('the opacity reaches every plane draw and no content-pass draw (the content RT is faded once, on its quad)', () => {
    const { s, btn } = signup()
    const glass = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, ctx)
    s.root.appendChild(image('photo', new Texture(), 300, 30)); btn.appendChild(image('icon', new Texture(), 8, 8, 32, 32))
    s.tick(1 / 60)
    const fade = (x: Surface) => (x as unknown as { su: { opacity: unknown } }).su.opacity
    const reads = (x: Surface, m: Mesh) => materialGraph(m.material as Material).some(n => n === fade(x))
    // the probe and the screen floor draw no colour: nothing to fade (the floor resets the depth whatever the opacity)
    const plane = meshes(s).filter(m => m.name !== 'capture-probe' && m.name !== 'screen-floor'), content = meshes(s.contentPass.scene)
    const { content: quad, glassBack, glassFront, innerGlassBack, innerGlassFront, panels, rims, images, glyphs } = SURFACE_ORDER
    expect(new Set(plane.map(m => m.renderOrder))).toEqual(new Set([quad, glassBack, glassFront, innerGlassBack, innerGlassFront, panels, rims, images, glyphs]))   // the inner glass and the panels riding glass fade too
    for (const m of plane) expect(reads(s, m)).toBe(true)
    expect(content.length).toBeGreaterThanOrEqual(4)                       // panels, pools, the photo, content glyphs
    for (const m of content) expect(reads(s, m)).toBe(false)
    const slab = meshes(glass).filter(m => m.renderOrder === SURFACE_ORDER.slab)
    expect(slab).toHaveLength(2); for (const m of slab) expect(reads(glass, m)).toBe(true)
  })
  it('prepare grows the content RT with headroom and shrinks it only after 30 still frames', () => {
    const s = world(), r = stubRenderer(), size = () => [s.contentPass.width, s.contentPass.height]
    s.tick(1 / 60)
    s.prepare(r, { width: 400, height: 300 }, 1); expect(size()).toEqual([448, 320])                      // fresh: what it needs
    s.prepare(r, { width: 500, height: 300 }, 1, undefined, true); expect(size()).toEqual([640, 320])     // 512 × 1.25 → 640
    for (let i = 0; i < 29; i++) s.prepare(r, { width: 400, height: 300 }, 1)
    expect(size()).toEqual([640, 320])                                                                     // 29 still frames: kept
    s.prepare(r, { width: 400, height: 300 }, 1); expect(size()).toEqual([448, 320])                      // the 30th: shrinks
    s.prepare(r, { width: 400, height: 300 }, 1, undefined, true); expect(size()).toEqual([448, 320])
  })
  it('a growth while nothing moves (a resize, a DPR change) keeps its headroom: the settle count starts over', () => {
    const s = world(), r = stubRenderer(), size = () => [s.contentPass.width, s.contentPass.height]
    s.tick(1 / 60)
    for (let i = 0; i < 31; i++) s.prepare(r, { width: 400, height: 300 }, 1)
    expect(size()).toEqual([448, 320])                                                                     // settled
    const resize = vi.spyOn(s.contentPass, 'resize')
    s.prepare(r, { width: 500, height: 300 }, 1); expect(size()).toEqual([640, 320])                      // 512 × 1.25 → 640
    for (let i = 0; i < 29; i++) s.prepare(r, { width: 500, height: 300 }, 1)
    expect(size()).toEqual([640, 320])                                                                     // not back to 512 next frame
    expect(resize.mock.results.filter(x => x.value === true)).toHaveLength(1)                             // one reallocation
    s.prepare(r, { width: 500, height: 300 }, 1); expect(size()).toEqual([512, 320])                      // 30 still frames after it
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
    expect(s.contentPass.width).toBe(1088)                          // 800 → 832, grown with 25 % headroom (rtTarget)
    expect(levels.map(l => l.width)).toEqual([544, 272, 136, 68])
  })
  it('a background slab never samples the pyramid; a \'mip\' Surface has none', () => {
    const glass = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, kawase()), r = recording()
    const el = new Node('glass', 'el'); el.setStyle({ position: 'absolute', left: 20, top: 20, width: 120, height: 48 }); glass.root.appendChild(el)
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
  it('skips the pyramid while the Surface has no glass (keeping its targets), and draws it once glass appears', () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, kawase())
    const card = new Node('box', 'card'); card.setStyle({ position: 'absolute', left: 0, top: 0, width: 400, height: 300, bg: 'fill' })
    s.root.appendChild(card); s.tick(1 / 60)
    const r = recording()
    s.prepare(r, { width: 400, height: 300 }, 1)
    expect(r.drawn).toEqual([s.contentPass.target])                 // the content only: nothing samples a blur
    const levels = [...sampledBy(elementGlass(s))].filter(t => t !== s.contentPass.texture && !(t instanceof DataTexture))   // not the luma placeholder
    expect(levels).toHaveLength(4)                                    // the targets stay wired to the (empty) glass draws
    const btn = new Node('glass', 'btn'); btn.setStyle({ position: 'absolute', left: 20, top: 20, width: 120, height: 48 })
    card.appendChild(btn); s.tick(1 / 60)
    r.drawn.length = 0; s.prepare(r, { width: 400, height: 300 }, 1)
    expect(r.drawn).toHaveLength(1 + 9); expect(r.drawn[0]).toBe(s.contentPass.target)
    for (const l of levelsOf(r.drawn)) expect(levels).toContain(l.texture)
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
  function clearGlass(c: SurfaceContext = ctx, g: Record<string, unknown> = { variant: 'clear', adaptive: true }, background = 'none') {
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
  it('a glass or \'none\' Surface drawn with a camera measures every frame, quiet ones too, over its capture\'s latest copy; an opaque one settles', () => {
    const camera = new PerspectiveCamera(40, 4 / 3, 0.1, 100); camera.position.z = 8; camera.updateMatrixWorld()
    const adaptive = { variant: 'clear', adaptive: true }
    const glass = clearGlass(ctx, adaptive, 'glass'), none = clearGlass(), opaque = clearGlass(ctx, adaptive, '#ffffff')
    const rs = [recording(), recording(), recording()] as const
    const passRender = vi.spyOn(LumaPass.prototype, 'render')
    try {
      for (const [s, r] of [[glass, rs[0]], [none, rs[1]], [opaque, rs[2]]] as const) {
        s.updateMatrixWorld(true); s.tick(0.25); s.prepare(r, { width: 400, height: 300 }, 1, camera)
        for (let i = 0; i < 8; i++) { s.tick(0.25); s.prepare(r, { width: 400, height: 300 }, 1, camera) }   // 2 s of quiet frames
      }
      expect(rs[0].render).toHaveBeenCalledTimes(2 + 8)
      expect(rs[1].render).toHaveBeenCalledTimes(2 + 8)               // what is behind a 'none' Surface changes without a redraw too
      expect(rs[2].render).toHaveBeenCalledTimes(2 + 3)               // the settle window only: an opaque content RT hides what is behind it
      const read = (r: typeof rs[0]) => new Set(nodesOf(((r.scenes[r.scenes.length - 1] as Mesh).material as MeshBasicNodeMaterial).colorNode).map(n => n.value))
      // the slab's capture on the glass Surface, the probe's on the 'none' one: what the element glass sees, frosted as it sees it
      for (const [s, r, frost] of [[glass, rs[0], SLAB_BEHIND], [none, rs[1], { level: 0, lift: 0 }]] as const) {
        const capture = materialGraph(meshes(s).find(m => m.renderOrder === SURFACE_ORDER.slab)!.material as Material)
          .find((n): n is GraphNode & ScreenCapture => n instanceof ScreenCapture)!.getBase() as ScreenCapture
        capture.latest = new FramebufferTexture(8, 8)                 // what the capture's next copy would leave
        s.tick(0.25); s.prepare(r, { width: 400, height: 300 }, 1, camera)
        expect(read(r)).toContain(capture.latest)
        expect(read(r)).toContain(s.contentPass.texture)
        expect(passRender.mock.lastCall![4]).toEqual(frost)
      }
    } finally { passRender.mockRestore() }
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
  it('fill: nothing sampled; the slab fills with the theme\'s fill, element glass a shade toward label with a tertiaryLabel border; no luma', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const c: SurfaceContext = { ...ctx, scheme, quality: QUALITY.minimal }
      const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, c)
      const el = new Node('glass', 'el'); el.setStyle({ position: 'absolute', left: 40, top: 30, width: 120, height: 60, glass: { variant: 'clear', adaptive: true } })
      s.root.appendChild(el)
      s.updateMatrixWorld(true); s.tick(1 / 60)
      const draws = [...slabOf(s), ...elementGlass(s)]
      expect(draws).toHaveLength(2)                                   // minimal: front faces only
      expect(graph(draws).filter(n => n.isTextureNode)).toEqual([])
      // the colours from the tokens: the shade is fill moved 4 % toward label in sRGB, then linear
      const [fill, label, border] = (['fill', 'label', 'tertiaryLabel'] as const).map(t => resolveColor(t, theme, scheme))
      const shade = toColor([0, 1, 2, 3].map(i => fill![i]! + (label![i]! - fill![i]!) * FILL.labelMix) as [number, number, number, number])
      expect(fillColors(theme, scheme)).toEqual({ slab: toColor(fill!), glass: shade, border: toColor(border!), alpha: FILL.alpha })
      // light: a shade darker than the white card; dark: lighter than the dark one
      expect(scheme === 'light' ? shade.r < toColor(fill!).r : shade.r > toColor(fill!).r).toBe(true)
      // the element glass's outline (120 × 60 pt) in its varying; at the centre the fill, ½ pt inside its edge the border
      const pinned = (u: number) => ({ vGlassMisc: [1, -1, -1, 1], vGlassTint: [1, 1, 1, 0], vGlassGlow: [0, 0, 0, 0], vGlassGeom: [0.1, 0.1, u, 0.5], vGlassOutline: [0.6, 0.3, 0.12, 2] })
      const rgb = (m: Mesh, u: number) => evalNode((m.material as MeshPhysicalNodeMaterial).backdropNode, pinned(u), undefined, 0.2).map(v => +v.toFixed(9))
      const round = (k: Color) => [k.r, k.g, k.b].map(v => +v.toFixed(9))
      expect(rgb(slabOf(s)[0]!, 0.5)).toEqual(round(toColor(fill!))); expect(rgb(slabOf(s)[0]!, 1)).toEqual(round(toColor(fill!)))   // no border
      expect(rgb(elementGlass(s)[0]!, 0.5)).toEqual(round(shade))
      expect(rgb(elementGlass(s)[0]!, 1 - 0.5 / 120)).toEqual(round(toColor(border!)))
      const camera = new PerspectiveCamera(40, 4 / 3, 0.1, 100); camera.position.z = 8; camera.updateMatrixWorld()
      const r = stubRenderer()
      for (let i = 0; i < 3; i++) { s.tick(1 / 60); s.prepare(r, { width: 400, height: 300 }, 1, camera) }
      expect(r.render).toHaveBeenCalledTimes(1)                       // the content once: no luma pass, no pyramid
    }
  })
  it('fill with increased contrast: solid black/white fills and a label border; a restyle switches them per scheme', () => {
    const pinned = (u: number, glow = [0, 0, 0, 0]) => ({ vGlassMisc: [1, -1, -1, 1], vGlassTint: [1, 1, 1, 0], vGlassGlow: glow, vGlassGeom: [0.1, 0.1, u, 0.5], vGlassOutline: [0.6, 0.3, 0.12, 2] })
    const rgb = (m: Mesh, u: number, glow?: number[]) => evalNode((m.material as MeshPhysicalNodeMaterial).backdropNode, pinned(u, glow), undefined, 0.2).map(v => +v.toFixed(9))
    const alpha = (m: Mesh, u: number) => +evalNode((m.material as MeshPhysicalNodeMaterial).backdropAlphaNode, pinned(u), undefined, 0.2)[0]!.toFixed(9)
    const round = (k: Color) => [k.r, k.g, k.b].map(v => +v.toFixed(9))
    const c: SurfaceContext = { ...ctx, quality: QUALITY.minimal, contrast: true }
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, c)
    const el = new Node('glass', 'el'); el.setStyle({ position: 'absolute', left: 40, top: 30, width: 120, height: 60 })
    s.root.appendChild(el); s.updateMatrixWorld(true); s.tick(1 / 60)
    for (const scheme of ['light', 'dark'] as const) {
      if (scheme !== c.scheme) { c.scheme = scheme; s.restyle() }
      const solid = scheme === 'light' ? [1, 1, 1] : [0, 0, 0], label = round(toColor(resolveColor('label', theme, scheme)))
      expect(rgb(slabOf(s)[0]!, 0.5)).toEqual(solid)
      expect(rgb(elementGlass(s)[0]!, 0.5)).toEqual(solid)
      expect(rgb(elementGlass(s)[0]!, 1 - 0.5 / 120)).toEqual(label)
      expect([alpha(slabOf(s)[0]!, 0.5), alpha(elementGlass(s)[0]!, 0.5)]).toEqual([1, 1])   // solid, not FILL.alpha
      // a coloured control (glow) keeps its colour, solid too
      expect(rgb(elementGlass(s)[0]!, 0.5, [0.2, 0.1, 0.9, 1.1])).toEqual([0.2, 0.1, 0.9])
    }
    c.contrast = false; s.restyle()                                 // contrast off: the theme's fill colours, near-opaque again
    expect(rgb(elementGlass(s)[0]!, 1 - 0.5 / 120)).toEqual(round(fillColors(theme, 'dark').border))
    expect([alpha(slabOf(s)[0]!, 0.5), alpha(elementGlass(s)[0]!, 0.5)]).toEqual([FILL.alpha, FILL.alpha])
    expect(alpha(elementGlass(s)[0]!, 1 - 0.5 / 120)).toBe(1)       // the border band is opaque either way
  })
  it('a quality change after a contrast change builds the glass with the new fills (one rebuild, no restyle needed)', () => {
    const alpha = (m: Mesh) => +evalNode((m.material as MeshPhysicalNodeMaterial).backdropAlphaNode, { vGlassMisc: [1, -1, -1, 1], vGlassTint: [1, 1, 1, 0], vGlassGlow: [0, 0, 0, 0], vGlassGeom: [0.1, 0.1, 0.5, 0.5], vGlassOutline: [0.6, 0.3, 0.12, 2] }, undefined, 0.2)[0]!.toFixed(9)
    const c: SurfaceContext = { ...ctx, quality: QUALITY.high }
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, c)
    c.contrast = true
    s.setQuality(QUALITY.minimal)
    expect(elementGlass(s).map(alpha)).toEqual([1])
  })
  it('fill: no rim decorations over the glass (its border replaces them), pools kept; back on a refracting tier the rims return', () => {
    const { s } = signup({ ...ctx })
    s.tick(1 / 60)
    expect(s.rims.buffer.count).toBe(1); expect(s.pools.buffer.count).toBe(1)
    s.setQuality(QUALITY.minimal)
    expect(s.rims.buffer.count).toBe(0); expect(s.pools.buffer.count).toBe(1); expect(s.contentDirty).toBe(true)
    const btn2 = new Node('glass', 'btn2'); btn2.setStyle({ position: 'absolute', left: 20, top: 120, width: 120, height: 48 })
    s.root.children[0]!.appendChild(btn2); s.tick(1 / 60)               // a rebuilt render list on minimal: still none
    expect(s.glass.buffer.count).toBe(2); expect(s.rims.buffer.count).toBe(0); expect(s.pools.buffer.count).toBe(2)
    s.setQuality(QUALITY.low)
    expect(s.rims.buffer.count).toBe(2)
    // a Surface made on minimal never gets them
    const fresh = signup({ ...ctx, quality: QUALITY.minimal }).s
    fresh.tick(1 / 60)
    expect(fresh.rims.buffer.count).toBe(0); expect(fresh.pools.buffer.count).toBe(1)
  })
  it('fill: a theme missing the fill, label or tertiaryLabel token falls back to the default light values instead of failing the Surface', () => {
    const { fill: _f, label: _l, tertiaryLabel: _t, ...light } = theme.colors.light
    const bare = { ...theme, colors: { ...theme.colors, light } }
    expect(fillColors(bare, 'light')).toEqual(fillColors(theme, 'light'))
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, { ...ctx, theme: bare, quality: QUALITY.minimal })
    expect(s.error).toBeNull(); expect(elementGlass(s)).toHaveLength(1)
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

describe('nested glass', () => {
  const nested = (c: SurfaceContext = ctx) => {
    const s = new Surface({ id: 'n', width: 400, height: 300, ptPerUnit: 100 }, c)
    const card = new Node('box'); card.setStyle({ width: 300, height: 200, padding: 20, gap: 10, bg: 'glass' })
    const title = new Node('text'); title.setProp('value', 'Hi')
    const btn = new Node('box'); btn.setStyle({ width: 120, height: 44, bg: 'glass' })
    const label = new Node('text'); label.setProp('value', 'Go')
    btn.appendChild(label); card.appendChild(title); card.appendChild(btn); s.root.appendChild(card)
    s.tick(1 / 60)
    return { s, card, btn }
  }
  /** The textures `m`'s node graph samples. */
  const texturesOf = (m: Mesh) => materialGraph(m.material as Material).filter(n => n.isTextureNode).map(n => n.value)
  const innerGlass = (s: Surface) => meshes(s.plane).filter(m => m.renderOrder === SURFACE_ORDER.innerGlassBack || m.renderOrder === SURFACE_ORDER.innerGlassFront)
  it('splits the glass into outer and inner batches and samples a stacked RT for the inner', () => {
    const { s } = nested()
    expect(s.glass.buffer.count).toBe(1); expect(s.innerGlass.buffer.count).toBe(1)
    expect(s.stack).not.toBeNull()
    const inner = meshes(s.plane).filter(m => m.renderOrder === SURFACE_ORDER.innerGlassBack || m.renderOrder === SURFACE_ORDER.innerGlassFront)
    expect(inner.length).toBe(2)
    for (const m of inner) { expect(texturesOf(m)).toContain(s.stack!.texture); expect(texturesOf(m)).not.toContain(s.contentPass.texture) }
    expect(s.innerGlass.buffer.get(0, 'iGlow2')[3]).toBe(-1)
  })
  it('the stack holds the outer glass as a translucent panel and only the text riding on it', () => {
    const { s } = nested()
    expect(s.stack!.panels.buffer.count).toBe(1)
    let glyphs = 0; for (const pb of s.stack!.text.perPage.values()) glyphs += pb.buffer.count
    expect(glyphs).toBe(2)                                          // "Hi", not "Go"
  })
  it('spatial §11.8: the stack holds the panels riding on the outer glass, not those riding on the inner', () => {
    const { s, card, btn } = nested()
    const chip = new Node('box'); chip.setStyle({ width: 60, height: 22, bg: 'accent' }); card.appendChild(chip)
    const dot = new Node('box'); dot.setStyle({ width: 8, height: 8, bg: 'label' }); btn.appendChild(dot)
    s.tick(1 / 60)
    expect(s.foregroundPanels.buffer.count).toBe(2)                 // both ride glass on the plane
    expect(s.stack!.panels.buffer.count).toBe(2)                    // the outer glass's fill and the chip on it
    const accent = resolveColor('accent', theme, 'light')
    expect(s.stack!.panels.buffer.get(1, 'iColor')).toEqual([...accent.slice(0, 3).map(srgbToLinear), accent[3]!].map(Math.fround))   // the chip, in its own colour
  })
  it('renders the stack right after the content pass', () => {
    const { s } = nested(), r = stubRenderer()
    s.prepare(r, { width: 400, height: 300 }, 1)
    const scenes = r.render.mock.calls.map(c => c[0])
    expect(scenes.indexOf(s.stack!.pass.scene)).toBe(scenes.indexOf(s.contentPass.scene) + 1)
  })
  it('drops the stack when the nesting goes away, and never makes one on the fill tier', () => {
    const { s, card, btn } = nested(); card.removeChild(btn); s.root.appendChild(btn); s.tick(1 / 60)
    expect(s.stack).toBeNull(); expect(s.innerGlass.buffer.count).toBe(0)
    const fill = nested({ ...ctx, quality: { ...ctx.quality, glassMode: 'fill' } }).s
    expect(fill.stack).toBeNull()
  })
  it('the stack resizes with the content RT and redraws only with it, as an RT the size of the content\'s', () => {
    const { s } = nested(), r = stubRenderer()
    s.prepare(r, { width: 400, height: 300 }, 2)
    expect([s.stack!.pass.width, s.stack!.pass.height]).toEqual([s.contentPass.width, s.contentPass.height])
    s.prepare(r, { width: 400, height: 300 }, 2)                    // nothing changed: neither redraws
    expect(r.render).toHaveBeenCalledTimes(2)
    s.prepare(r, { width: 800, height: 300 }, 2)
    expect([s.stack!.pass.width, s.stack!.pass.height]).toEqual([s.contentPass.width, s.contentPass.height])
    expect(r.render).toHaveBeenCalledTimes(4)
  })
  it('the inner glass draws only while there is nested glass (a Surface without it builds no inner glass shader)', () => {
    const plain = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, ctx); plain.tick(1 / 60)
    expect(innerGlass(plain)).toHaveLength(2); expect(innerGlass(plain).every(m => !m.visible)).toBe(true)
    const { s, card, btn } = nested()
    expect(innerGlass(s)).toHaveLength(2); expect(innerGlass(s).every(m => m.visible)).toBe(true)
    card.removeChild(btn); s.root.appendChild(btn); s.tick(1 / 60)
    expect(innerGlass(s).every(m => !m.visible)).toBe(true)
  })
  it('the press glow lands on the batch that holds the pressed glass, and follows it there', () => {
    const { s, card, btn } = nested()
    const x = card.layout.x + btn.layout.x, y = card.layout.y + btn.layout.y, { width: w, height: h } = btn.layout
    // a quarter right of and above the button's centre is u = v = ¼ (slab uv, y up)
    s.setPointer([x + 0.75 * w, y + 0.25 * h]); s.pointer.down(x + 0.75 * w, y + 0.25 * h); s.tick(1 / 60)
    expect(s.innerGlass.buffer.get(0, 'iTouch').slice(0, 3)).toEqual([0.25, 0.25, 1]); expect(s.glass.buffer.get(0, 'iTouch')[2]).toBe(0)
    s.setPointer([x + 0.25 * w, y + 0.75 * h]); s.tick(1 / 60)     // moved while pressed, nothing else changed
    expect(s.innerGlass.buffer.get(0, 'iTouch').slice(0, 3)).toEqual([-0.25, -0.25, 1])
  })
  it('adaptive darkening reads the outer glass only: the luma packs the outer batch, and the inner glass never samples it', () => {
    const { s, card, btn } = nested()
    for (const n of [card, btn]) n.setStyle({ glass: { variant: 'clear', adaptive: true } })
    s.tick(1 / 60)
    let bound: RenderTarget | null = null; const drawn: (RenderTarget | null)[] = []
    const r = { ...stubRenderer(), setRenderTarget: vi.fn((t: RenderTarget | null) => { bound = t }), render: vi.fn(() => { drawn.push(bound) }) }
    s.prepare(r, { width: 400, height: 300 }, 1)
    expect(drawn.slice(0, 2)).toEqual([s.contentPass.target, s.stack!.pass.target])
    const luma = drawn[2]!
    expect(luma.width).toBe(256)
    expect(s.glass.buffer.get(0, 'iGlow2')[3]).toBe(0); expect(s.innerGlass.buffer.get(0, 'iGlow2')[3]).toBe(-1)
    for (const m of elementGlass(s)) expect(texturesOf(m)).toContain(luma.texture)
    for (const m of innerGlass(s)) expect(texturesOf(m)).not.toContain(luma.texture)
    // only the inner glass clear + adaptive: nothing to measure
    card.setStyle({ glass: {} }); s.tick(1 / 60)
    drawn.length = 0; s.prepare(r, { width: 400, height: 300 }, 1)
    expect(drawn).toEqual([s.contentPass.target, s.stack!.pass.target])
  })
  it('setQuality passes the texel type on and drops the stack on the fill tier; dispose frees it', () => {
    const { s } = nested(), stack = s.stack!
    s.setQuality({ ...ctx.quality, contentType: 'half' })
    expect(s.stack).toBe(stack); expect(stack.texture.type).toBe(HalfFloatType)
    s.setQuality({ ...ctx.quality, glassMode: 'fill' })
    expect(s.stack).toBeNull()
    for (const m of innerGlass(s)) expect(texturesOf(m)).not.toContain(stack.texture)
    s.setQuality(ctx.quality)
    const again = s.stack!, freed = vi.fn()
    expect(again).not.toBe(stack); expect(again.panels.buffer.count).toBe(1)   // filled as it appears
    for (const m of innerGlass(s)) expect(texturesOf(m)).toContain(again.texture)
    again.pass.target.addEventListener('dispose', freed)
    s.dispose()
    expect(freed).toHaveBeenCalled()
  })
})

describe('Surface: panels on glass ride the glass (spatial §11.8)', () => {
  /** A Card of glass raised 24 pt, 12 pt thick, holding a status chip and its label; a panel on the plate beside it. */
  function carded() {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, ctx)
    const card = new Node('glass', 'card'); card.setStyle({ position: 'absolute', left: 40, top: 40, width: 200, height: 120, radius: 16, glass: { thickness: 12 } }); card.elevation = 24
    const chip = new Node('box', 'chip'); chip.setStyle({ position: 'absolute', left: 20, top: 20, width: 60, height: 22, radius: 'capsule', bg: 'accent' })
    const label = new Node('text', 'label'); label.setProp('value', '已发货')
    const plate = new Node('box', 'plate'); plate.setStyle({ position: 'absolute', left: 260, top: 40, width: 100, height: 40, bg: 'fill' })
    chip.appendChild(label); card.appendChild(chip); s.root.appendChild(card); s.root.appendChild(plate)
    s.tick(1 / 60)
    return { s, card, chip }
  }
  /** The panel `i` of `b` packs at this centre (units). */
  const centre = (b: { buffer: { get(i: number, name: string): number[] } }, i = 0) => b.buffer.get(i, 'iRect').slice(0, 2)

  it('a chip inside a raised Card is one foreground panel, on the Card\'s top face with its label (24 + 12 pt); the content pass no longer holds it', () => {
    const { s } = carded()
    expect(s.foregroundPanels.buffer.count).toBe(1)
    expect(centre(s.foregroundPanels)).toEqual(surfaceToLocal(40 + 20 + 30, 40 + 20 + 11, s.model).map(Math.fround))   // the chip
    expect(s.foregroundPanels.buffer.get(0, 'iMat2')[3]).toBeCloseTo(0.36)
    const fgPage = [...s.foregroundText.perPage.values()][0]!
    expect(fgPage.buffer.get(0, 'iMat2')[3]).toBeCloseTo(0.36)                         // its label, at the same height
    // the content pass: the plate's panel only
    expect(s.panels.buffer.count).toBe(1)
    expect(centre(s.panels)).toEqual(surfaceToLocal(310, 60, s.model).map(Math.fround))
    expect(s.panels.buffer.get(0, 'iMat2')[3]).toBe(0)
    const content = meshes(s.contentPass.scene)
    expect(content.some(m => m.geometry === s.foregroundPanels.geometry)).toBe(false)
    expect(content.find(m => m.geometry === s.panels.geometry)!.renderOrder).toBe(CONTENT_ORDER.panels)
  })
  it('the foreground panels draw on the plane at 2.75, after the inner glass and before the rims, and fade with the Surface', () => {
    const { s } = carded()
    expect(SURFACE_ORDER.panels).toBe(2.75)
    expect(SURFACE_ORDER.innerGlassFront).toBeLessThan(SURFACE_ORDER.panels); expect(SURFACE_ORDER.panels).toBeLessThan(SURFACE_ORDER.rims)
    const mesh = meshes(s).filter(m => m.geometry === s.foregroundPanels.geometry)
    expect(mesh).toHaveLength(1)
    expect(mesh[0]!.parent).toBe(s.plane); expect(mesh[0]!.renderOrder).toBe(SURFACE_ORDER.panels); expect(mesh[0]!.frustumCulled).toBe(false)
    const fade = (s as unknown as { su: { opacity: unknown } }).su.opacity
    expect(materialGraph(mesh[0]!.material as Material)).toContain(fade)
    // the content pass's panels do not: the RT is faded once, on its quad
    const contentPanels = meshes(s.contentPass.scene).find(m => m.geometry === s.panels.geometry)!
    expect(materialGraph(contentPanels.material as Material)).not.toContain(fade)
  })
  it('follows the Card: lowered to the plate, the chip rides 12 pt; taken off the Card, it goes back to the content pass', () => {
    const { s, card, chip } = carded()
    card.elevation = 0; s.tick(1 / 60)
    expect(s.foregroundPanels.buffer.get(0, 'iMat2')[3]).toBeCloseTo(0.12)
    card.removeChild(chip); s.root.appendChild(chip); s.tick(1 / 60)
    expect(s.foregroundPanels.buffer.count).toBe(0); expect(s.panels.buffer.count).toBe(2)
  })
  it('Task 10 V1: a focused glass control\'s ring rides its own top face, with its elevation, tilt and press scale (registered with its rim)', () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, ctx)
    const btn = new Node('glass', 'btn')
    btn.setStyle({ position: 'absolute', left: 40, top: 40, width: 200, height: 52, radius: 'capsule', scale: 0.96, glass: { thickness: 10 } })
    btn.elevation = 6; btn.tilt = { x: -0.04, y: 0.05 }
    btn.setProp('tabIndex', 0); btn.setState({ focused: true, focusVisible: true })
    s.root.appendChild(btn); s.tick(1 / 60)
    expect(s.panels.buffer.count).toBe(0)                                          // no longer flat in the content pass
    expect(s.foregroundPanels.buffer.count).toBe(1); expect(s.rims.buffer.count).toBe(1)
    const ring = (a: string) => s.foregroundPanels.buffer.get(0, a), rim = (a: string) => s.rims.buffer.get(0, a)
    const accent = resolveColor('accent', theme, 'light')
    expect(ring('iBorder')).toEqual([...accent.slice(0, 3).map(srgbToLinear), 1].map(Math.fround))
    // the rim's centre, tilt and press scale (the matrix's linear part), on the glass's top face: 6 + 10 pt up
    expect(ring('iRect').slice(0, 2)).toEqual(rim('iRect').slice(0, 2))
    for (const row of ['iMat0', 'iMat1', 'iMat2']) expect(ring(row).slice(0, 3)).toEqual(rim(row).slice(0, 3))
    expect(ring('iMat0')[0]).not.toBeCloseTo(0.96, 3)                              // the tilt is in there (cos·scale)
    expect(ring('iMat2')[3]).toBeCloseTo(0.16, 6)
  })
  it('dispose frees the foreground panels\' geometry and material', () => {
    const { s } = carded()
    const mesh = meshes(s).find(m => m.geometry === s.foregroundPanels.geometry)!
    const freed: unknown[] = []
    for (const o of [mesh.geometry, mesh.material as Material]) o.addEventListener('dispose', () => freed.push(o))
    s.dispose()
    expect(freed).toHaveLength(2)
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

describe('Surface: drop shadows of raised glass (spatial §11.7)', () => {
  /** A glass Surface with a card of glass raised 24 pt (and a flat one), ticked once. */
  function raised(c: SurfaceContext = ctx) {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass' }, c)
    const card = new Node('glass', 'card'); card.setStyle({ position: 'absolute', left: 40, top: 40, width: 200, height: 120, radius: 16 }); card.elevation = 24
    const flat = new Node('glass', 'flat'); flat.setStyle({ position: 'absolute', left: 260, top: 40, width: 100, height: 40, radius: 'capsule' })
    s.root.appendChild(card); s.root.appendChild(flat); s.tick(1 / 60)
    return { s, card }
  }
  /** The shadows' shared uniforms (private: the content pass reads them). */
  const shadowUniforms = (s: Surface) => s as unknown as { shadowDir: { value: Vector2 }; shadowAlpha: { value: number } }

  it('a raised glass casts one shadow, drawn in the content pass between the panels and the pools, never on the plane', () => {
    const { s, card } = raised()
    expect(s.shadows.buffer.count).toBe(1)                                    // the card's; the flat glass casts none
    const content = meshes(s.contentPass.scene).filter(m => m.geometry === s.shadows.geometry)
    expect(content).toHaveLength(1); expect(content[0]!.renderOrder).toBe(CONTENT_ORDER.shadows)
    expect(CONTENT_ORDER.panels).toBeLessThan(CONTENT_ORDER.shadows); expect(CONTENT_ORDER.shadows).toBeLessThan(CONTENT_ORDER.pools)
    expect(content[0]!.frustumCulled).toBe(false)
    expect(meshes(s).some(m => m.geometry === s.shadows.geometry)).toBe(false)
    card.elevation = 0; s.tick(1 / 60)
    expect(s.shadows.buffer.count).toBe(0)
    expect(s.error).toBeNull()
  })
  /** A Surface with a raised card of glass per elevation (pt), side by side, ticked and drawn once. */
  function casters(...elevations: number[]) {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, ctx)
    elevations.forEach((e, i) => {
      const g = new Node('glass', `c${i}`); g.setStyle({ position: 'absolute', left: 20 + i * 120, top: 40, width: 100, height: 60 }); g.elevation = e
      s.root.appendChild(g)
    })
    s.tick(1 / 60); s.prepare(stubRenderer(), { width: 400, height: 300 }, 1)
    return s
  }
  /** The light whose shadows fall `(dx, dy)` pt per pt of elevation (y down): `setLightDirection` inverted at z = 1. */
  const lightFor = (dx: number, dy: number) => new Vector3(-dx, dy, 1).normalize()
  const SIZE = { width: 400, height: 300 }

  it('the light starts straight in front; the content draws its shadows along (−x / z, y / z), z at least 0.1', () => {
    const { s } = raised(), r = stubRenderer(), dir = () => shadowUniforms(s).shadowDir.value
    expect(dir().toArray()).toEqual([0, 0])
    const drawn = (l: Vector3) => { s.setLightDirection(l); s.prepare(r, SIZE, 1); return dir() }
    const a = drawn(new Vector3(-0.3, 0.6, 0.74).normalize())
    expect(a.x).toBeCloseTo(0.3 / 0.74, 12); expect(a.y).toBeCloseTo(0.6 / 0.74, 12)
    const b = drawn(new Vector3(0.6, 0.8, 0))                                    // grazing: z clamped to 0.1
    expect(b.x).toBeCloseTo(-6, 12); expect(b.y).toBeCloseTo(8, 12)
    const c = drawn(new Vector3(0.6, 0, -0.8))                                   // from behind: clamped as well
    expect(c.x).toBeCloseTo(-6, 12); expect(c.y).toBe(0)
  })
  it('redraws when the tallest shadow\'s offset would move more than 0.5 pt: a 4 pt caster ignores 0.2 pt, a 100 pt one redraws for 1 pt', () => {
    const moved = (elevations: number[], dx: number, dy: number) => {
      const s = casters(...elevations)
      s.setLightDirection(lightFor(0.2, 0.5)); s.prepare(stubRenderer(), SIZE, 1)
      expect(s.contentDirty).toBe(false)
      s.setLightDirection(lightFor(0.2 + dx, 0.5 + dy))
      return s.contentDirty
    }
    expect(moved([4], 0, 0.2 / 4)).toBe(false)                                    // its offset moves 0.2 pt
    expect(moved([4], -0.2 / 4, 0)).toBe(false)
    expect(moved([4], 0, 0.6 / 4)).toBe(true)                                     // 0.6 pt
    expect(moved([100], 0, 1 / 100)).toBe(true)                                   // 1 pt
    expect(moved([100], 1 / 100, 0)).toBe(true)
    expect(moved([100], 0, 0.4 / 100)).toBe(false)                                // 0.4 pt
    expect(moved([4, 100], 0, 0.6 / 100)).toBe(true)                              // the tallest sets the step: 0.6 pt at 100
  })
  it('small moves add up against the direction last drawn, and any redraw draws the latest direction', () => {
    const s = casters(24), r = stubRenderer(), dir = () => shadowUniforms(s).shadowDir.value
    s.setLightDirection(lightFor(0, 0)); s.prepare(r, SIZE, 1)
    let redraws = 0
    for (let k = 1; k <= 10; k++) {
      s.setLightDirection(lightFor(0, 0.005 * k))                                  // 0.12 pt a step at 24 pt: negligible
      if (s.contentDirty) { redraws++; s.prepare(r, SIZE, 1) }
    }
    expect(redraws).toBe(2)                                                        // 1.2 pt in all: past 0.5 pt at 0.6 and 1.2
    s.setLightDirection(lightFor(0, 0.06)); expect(s.contentDirty).toBe(false)    // 0.24 pt more: kept, not drawn yet
    expect(dir().y).toBeCloseTo(0.05, 12)
    s.contentDirty = true; s.prepare(r, SIZE, 1)                                   // redrawn for another reason…
    expect(dir().y).toBeCloseTo(0.06, 12)                                         // …with the latest direction
  })
  it('a Surface casting no shadow does not redraw for the light; once one appears, it draws along the latest light', () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, ctx), r = stubRenderer()
    const g = new Node('glass', 'g'); g.setStyle({ position: 'absolute', left: 20, top: 20, width: 200, height: 60 }); s.root.appendChild(g)
    s.tick(1 / 60); s.prepare(r, SIZE, 1)
    s.setLightDirection(lightFor(0.3, 0.4))
    expect(s.contentDirty).toBe(false)
    g.elevation = 24; s.tick(1 / 60); s.prepare(r, SIZE, 1)
    expect(s.shadows.buffer.count).toBe(1)
    expect(shadowUniforms(s).shadowDir.value.x).toBeCloseTo(0.3, 12); expect(shadowUniforms(s).shadowDir.value.y).toBeCloseTo(0.4, 12)
  })
  it('the shadow alpha follows the scheme: 0.22 light, 0.35 dark after a restyle, and back', () => {
    const c: SurfaceContext = { ...ctx }
    const { s } = raised(c), alpha = () => shadowUniforms(s).shadowAlpha.value
    expect(alpha()).toBe(SHADOW_DECAL.alphaLight)
    c.scheme = 'dark'; s.restyle(); expect(alpha()).toBe(0.35)
    c.scheme = 'light'; s.restyle(); expect(alpha()).toBe(0.22)
    const dark = raised({ ...ctx, scheme: 'dark' }).s                            // a Surface made in the dark starts dark
    expect(shadowUniforms(dark).shadowAlpha.value).toBe(SHADOW_DECAL.alphaDark)
  })
  it('the shadow material reads the Surface\'s light direction and alpha, and not its opacity', () => {
    const { s } = raised(), u = shadowUniforms(s)
    const mesh = meshes(s.contentPass.scene).find(m => m.geometry === s.shadows.geometry)!
    const graph = materialGraph(mesh.material as Material)
    expect(graph).toContain(u.shadowDir); expect(graph).toContain(u.shadowAlpha)
    expect(graph).not.toContain((s as unknown as { su: { opacity: unknown } }).su.opacity)
  })
  it('the minimal tier (the fill glass mode) still draws the shadows: they are content, not glass optics', () => {
    const { s } = raised({ ...ctx, quality: QUALITY.minimal })
    expect(s.shadows.buffer.count).toBe(1)
    s.setQuality(QUALITY.high); s.tick(1 / 60); expect(s.shadows.buffer.count).toBe(1)
    s.setQuality(QUALITY.minimal); s.tick(1 / 60); expect(s.shadows.buffer.count).toBe(1)
  })
})

describe('glass containers: fused slabs (GlassContainer, spec §5.2)', () => {
  /** A Surface whose root holds a container with two close glass nodes (`a`, `b`: 10 pt apart) and one far one. */
  function fusedSurface(c: SurfaceContext = ctx, opts: { ptPerUnit?: number; labels?: boolean; glass?: Record<string, unknown>; background?: string; placement?: 'world' } = {}) {
    const s = new Surface({ width: 400, height: 100, ptPerUnit: opts.ptPerUnit ?? 1, ...(opts.background ? { background: opts.background } : {}), ...(opts.placement ? { placement: opts.placement } : {}) }, c)
    const box = new Node('box', 'bar'); box.setProp('glassContainer', { spacing: 16 }); box.setStyle({ position: 'absolute', left: 0, top: 0, width: 400, height: 100 })
    const at = (id: string, left: number) => {
      const g = new Node('glass', id); g.setStyle({ position: 'absolute', left, top: 30, width: 80, height: 40, radius: 'capsule', ...(opts.glass ? { glass: opts.glass } : {}) }); box.appendChild(g)
      if (opts.labels) { const t = new Node('text', `${id}-label`); t.setProp('value', id.toUpperCase()); t.setStyle({ width: '100%', height: '100%', textAlign: 'center' }); g.appendChild(t) }
      return g
    }
    const a = at('a', 0), b = at('b', 90), far = at('far', 300)
    s.root.appendChild(box); s.tick(0)
    return { s, box, a, b, far }
  }
  const meshBatches = (s: Surface) => meshes(s).filter(m => (m.geometry as { userData?: { vertex?: string } }).userData?.vertex === 'mesh')
  /** The members' thickness: an 80 × 40 capsule's (shorter side · ratio), pt. */
  const T = 40 * theme.glass.thicknessRatio

  it('draws a fused cluster as one mesh-based glass batch and rebuilds only when the shapes change', () => {
    const { s, b, far } = fusedSurface()
    const fused = meshBatches(s)
    expect(fused.length).toBeGreaterThan(0)                                      // front (+ back when backFaces)
    expect(s.glass.nodes).toEqual([far])                                          // members left the instanced batch
    const geometry = fused[0]!.geometry
    s.tick(0); expect(meshBatches(s)[0]!.geometry).toBe(geometry)                 // nothing changed: same mesh
    let disposed = 0; geometry.addEventListener('dispose', () => { disposed++ })
    b.setStyle({ left: 95 }); s.tick(0)                                           // still within the spacing (gap 15)
    expect(meshBatches(s)[0]!.geometry).not.toBe(geometry); expect(disposed).toBe(1)
    expect(meshBatches(s).every(m => m.geometry === meshBatches(s)[0]!.geometry)).toBe(true)
  })
  it("in the 'fill' mode a fused cluster draws its members as single glass with rims", () => {
    const { s, a, b, far } = fusedSurface({ ...ctx, quality: QUALITY.minimal })
    expect(meshBatches(s)).toEqual([])
    expect([...s.glass.nodes].sort()).toEqual([a, b, far].sort())
    expect(s.rims.buffer.count).toBe(0)                                           // fill mode draws no rims at all (Plan 2)
  })
  it('the fused draws: back and front at the element glass\'s orders on the plane, casting shadows; one instance over the shapes\' bounds', () => {
    const { s } = fusedSurface()
    const draws = meshBatches(s)
    expect(draws.map(m => m.renderOrder).sort()).toEqual([SURFACE_ORDER.glassBack, SURFACE_ORDER.glassFront])
    for (const m of draws) { expect(m.parent).toBe(s.plane); expect(m.castShadow).toBe(true); expect(m.receiveShadow).toBe(false); expect(m.frustumCulled).toBe(false) }
    expect((draws.find(m => m.renderOrder === SURFACE_ORDER.glassBack)!.material as MeshPhysicalNodeMaterial).side).not.toBe(FrontSide)
    const batch = s.fused.batches[0]!
    expect(batch.buffer.count).toBe(1); expect(batch.geometry).toBe(draws[0]!.geometry)
    // a at (0, 30), b at (90, 30), both 80 × 40: bounds (0, 30)–(170, 70), centred at (85, 50)
    expect(batch.buffer.get(0, 'iRect')).toEqual([...surfaceToLocal(85, 50, s.model), 170, 40].map(Math.fround))
    expect(batch.buffer.get(0, 'iShape').slice(0, 2)).toEqual([0, Math.fround(T)])   // radius 0, the first member's thickness
    expect(batch.buffer.get(0, 'iMat0').slice(0, 3)).toEqual([1, 0, 0]); expect(batch.buffer.get(0, 'iMat1').slice(0, 3)).toEqual([0, 1, 0])
    // the mesh: centred on those bounds, in units
    const pos = batch.geometry.getAttribute('position')
    let x0 = Infinity, x1 = -Infinity
    for (let i = 0; i < pos.count; i++) { x0 = Math.min(x0, pos.getX(i)); x1 = Math.max(x1, pos.getX(i)) }
    expect(x0).toBeCloseTo(-85, 0); expect(x1).toBeCloseTo(85, 0)
    const half = fusedSurface(ctx, { ptPerUnit: 2 }).s.fused.batches[0]!.geometry.getAttribute('position')
    let h1 = -Infinity; for (let i = 0; i < half.count; i++) h1 = Math.max(h1, half.getX(i))
    expect(h1).toBeCloseTo(85 / 2, 0)
  })
  it('a sub-0.25 pt move keeps the mesh; a member leaving the spacing dissolves the cluster and frees its draws', () => {
    const { s, b, far } = fusedSurface()
    const geometry = s.fused.batches[0]!.geometry, materials = meshBatches(s).map(m => m.material as Material)
    let freed = 0; geometry.addEventListener('dispose', () => { freed++ })
    b.setStyle({ left: 90.1 }); s.tick(0)
    expect(s.fused.batches[0]!.geometry).toBe(geometry)
    b.setStyle({ left: 110 }); s.tick(0)                                          // 30 pt apart
    expect(meshBatches(s)).toEqual([]); expect(s.fused.batches).toEqual([]); expect(freed).toBe(1)
    expect(s.glass.nodes.length).toBe(3); expect(s.glass.nodes).toContain(far)
    expect(s.rims.buffer.count).toBe(3)                                           // single again: rims back
    b.setStyle({ left: 90 }); s.tick(0)
    expect(meshBatches(s).map(m => m.material)).toEqual(materials)               // the shared fused materials are kept
  })
  it('content riding a fused member sits on the slab\'s top: a hovered (raised) member lifts the slab, its neighbour\'s label and focus ring with it', () => {
    const { s, a, b } = fusedSurface(ctx, { labels: true })
    a.elevation = 6
    b.setProp('tabIndex', 0); b.setState({ focused: true, focusVisible: true })
    s.tick(0)
    const top = 6 + T                                                             // the tallest member's elevation + the slab's thickness
    expect(s.fused.batches[0]!.buffer.get(0, 'iMat2')[3]).toBeCloseTo(6)          // the slab stands at the raised member's elevation
    const glyphs = [...s.foregroundText.perPage.values()].flatMap(pb => Array.from({ length: pb.buffer.count }, (_, i) => pb.buffer.get(i, 'iMat2')[3]!))
    // "A" and "B" on the slab's top (b's own elevation is 0: without the ruling its label would sink to T, into the
    // slab); the far glass's "FAR" on its own top
    expect(glyphs.filter(z => Math.abs(z - top) < 1e-4)).toHaveLength(2); expect(glyphs.filter(z => Math.abs(z - T) < 1e-4)).toHaveLength(3)
    expect(s.foregroundPanels.buffer.count).toBe(1)                               // b's focus ring
    expect(s.foregroundPanels.buffer.get(0, 'iMat2')[3]).toBeCloseTo(top, 4)
  })
  it('the fused slab is untilted: a member\'s hover tilt has no slab of its own to bend', () => {
    const { s, a } = fusedSurface()
    a.tilt = { x: 0.05, y: 0.05 }; s.tick(0)
    const batch = s.fused.batches[0]!
    expect(batch.buffer.get(0, 'iMat0').slice(0, 3)).toEqual([1, 0, 0]); expect(batch.buffer.get(0, 'iMat2').slice(0, 3)).toEqual([0, 0, 1])
  })
  it('castShadows covers the fused draws, those made later included', () => {
    const { s, b } = fusedSurface()
    s.castShadows = false
    expect(meshBatches(s).every(m => !m.castShadow)).toBe(true)
    b.setStyle({ left: 200 }); s.tick(0); b.setStyle({ left: 90 }); s.tick(0)     // dissolved, then fused again
    expect(meshBatches(s).length).toBeGreaterThan(0); expect(meshBatches(s).every(m => !m.castShadow)).toBe(true)
    s.castShadows = true
    expect(meshBatches(s).every(m => m.castShadow)).toBe(true)
  })
  it('a quality rebuild (and a restyle) rebuilds the fused materials like the element glass, keeping the mesh', () => {
    const { s } = fusedSurface({ ...ctx })
    const before = meshBatches(s), geometry = before[0]!.geometry, freed: unknown[] = []
    for (const m of before) (m.material as Material).addEventListener('dispose', () => freed.push(m.material))
    s.setQuality({ ...ctx.quality, backFaces: false })
    expect(freed).toHaveLength(2); expect(before.every(m => m.parent === null)).toBe(true)
    const after = meshBatches(s)
    expect(after.map(m => m.renderOrder)).toEqual([SURFACE_ORDER.glassFront]); expect(after[0]!.geometry).toBe(geometry)
    // the same backdrop as the element glass's: the content RT
    const sampled = nodesOf((after[0]!.material as MeshPhysicalNodeMaterial).backdropNode).filter(n => n.isTextureNode).map(n => n.value)
    expect(sampled).toContain(s.contentPass.texture)
    const front = after[0]!.material
    s.restyle()
    expect(meshBatches(s)[0]!.material).not.toBe(front)
  })
  it("switching to the 'fill' mode puts the members back in the element batch at their own height, and back again", () => {
    const { s, a, b, far } = fusedSurface({ ...ctx }, { labels: true })
    a.elevation = 6; s.tick(0)
    const geometry = s.fused.batches[0]!.geometry
    let freed = 0; geometry.addEventListener('dispose', () => { freed++ })
    s.setQuality(QUALITY.minimal)
    expect(meshBatches(s)).toEqual([]); expect(freed).toBe(1)
    expect([...s.glass.nodes].sort()).toEqual([a, b, far].sort())
    const z = [...s.foregroundText.perPage.values()].flatMap(pb => Array.from({ length: pb.buffer.count }, (_, i) => pb.buffer.get(i, 'iMat2')[3]!))
    expect(z.some(v => Math.abs(v - T) < 1e-4)).toBe(true)                        // b's label on b itself, not on the slab
    s.setQuality(QUALITY.high)
    expect(meshBatches(s).length).toBeGreaterThan(0); expect(s.glass.nodes).toEqual([far])
  })
  it('a press on a member glows on the fused slab, at the pointer in the slab\'s bounds, as large as that member', () => {
    const { s, b } = fusedSurface()
    b.setStyle({ pressed: {} })                                                   // no press scale: the shapes stay
    s.tick(0)
    // bounds (0, 30)–(170, 70): a quarter right of and above its centre (85, 50) is (127.5, 40)
    s.setPointer([127.5, 40]); s.pointer.down(127.5, 40); s.tick(0)
    expect(b.state.pressed).toBe(true)
    expect(s.fused.batches[0]!.buffer.get(0, 'iTouch').slice(0, 3)).toEqual([0.25, 0.25, 1])
    expect(s.fused.batches[0]!.buffer.get(0, 'iCorner').slice(0, 2)).toEqual([Math.fround(80 / 170), 1])   // b's 80 × 40 of the 170 × 40 slab
    expect(s.glass.buffer.get(0, 'iTouch')[2]).toBe(0)                            // not on the far glass
    s.pointer.up(127.5, 40); s.tick(0)
    expect(s.fused.batches[0]!.buffer.get(0, 'iTouch').slice(0, 3)).toEqual([0, 0, 0])
    expect(s.fused.batches[0]!.buffer.get(0, 'iCorner').slice(0, 2)).toEqual([1, 1])
  })
  it('adaptive darkening: the fused slab reads the luma texel after the element glass\'s, packed with its bounds', () => {
    const { s } = fusedSurface(ctx, { glass: { variant: 'clear', adaptive: true } })
    expect(s.glass.buffer.get(0, 'iGlow2')[3]).toBe(0)                            // far
    expect(s.fused.batches[0]!.buffer.get(0, 'iGlow2')[3]).toBe(1)               // after it
    let bound: RenderTarget | null = null; const drawn: (RenderTarget | null)[] = [], scenes: Object3D[] = []
    const r = { ...stubRenderer(), setRenderTarget: vi.fn((t: RenderTarget | null) => { bound = t }), render: vi.fn((scene: Object3D) => { drawn.push(bound); scenes.push(scene) }) }
    s.prepare(r, { width: 400, height: 100 }, 1)
    const luma = drawn[1]!
    for (const m of meshBatches(s)) expect(new Set(materialGraph(m.material as Material).filter(n => n.isTextureNode).map(n => n.value))).toContain(luma.texture)
    const kernel = ((scenes[1] as Mesh).material as MeshBasicNodeMaterial).colorNode
    const rects = nodesOf(kernel).map(n => n.value).find((v): v is DataTexture => v instanceof DataTexture)!
    expect(Array.from((rects.image.data as Float32Array).slice(4, 8))).toEqual([0, 30 / 100, 170 / 400, 40 / 100].map(Math.fround))
  })
  it("a 'none' Surface whose only glass is fused still sees what is behind it", () => {
    const { s, far } = fusedSurface()
    far.setStyle({ display: 'none' }); s.tick(0)
    expect(s.glass.buffer.count).toBe(0); expect(meshBatches(s).length).toBeGreaterThan(0)
    expect(probeOf(s)).toHaveLength(1)
    for (const m of meshBatches(s)) expect(capturesIn([m]).length).toBeGreaterThan(0)
  })
  it('nested: a container inside a glass card draws its slab as inner glass, over the stacked RT, with no luma index', () => {
    const s = new Surface({ width: 400, height: 200, ptPerUnit: 1 }, ctx)
    const card = new Node('glass', 'card'); card.setStyle({ position: 'absolute', left: 0, top: 0, width: 400, height: 200, radius: 24, glass: { variant: 'clear', adaptive: true } })
    const box = new Node('box', 'bar'); box.setProp('glassContainer', { spacing: 16 }); box.setStyle({ position: 'absolute', left: 20, top: 20, width: 300, height: 100 })
    for (const [id, left] of [['a', 0], ['b', 90]] as const) { const g = new Node('glass', id); g.setStyle({ position: 'absolute', left, top: 30, width: 80, height: 40, radius: 'capsule', glass: { variant: 'clear', adaptive: true } }); box.appendChild(g) }
    card.appendChild(box); s.root.appendChild(card); s.tick(0)
    expect(s.stack).not.toBeNull()
    const draws = meshBatches(s)
    expect(draws.map(m => m.renderOrder).sort()).toEqual([SURFACE_ORDER.innerGlassBack, SURFACE_ORDER.innerGlassFront])
    for (const m of draws) {
      const tex = materialGraph(m.material as Material).filter(n => n.isTextureNode).map(n => n.value)
      expect(tex).toContain(s.stack!.texture); expect(tex).not.toContain(s.contentPass.texture)
    }
    expect(s.fused.batches[0]!.buffer.get(0, 'iGlow2')[3]).toBe(-1)
    expect(s.glass.nodes.map(n => n.id)).toEqual(['card']); expect(s.innerGlass.buffer.count).toBe(0)
    box.parent!.removeChild(box); s.root.appendChild(box); s.tick(0)               // out of the card: outer again
    expect(meshBatches(s).map(m => m.renderOrder).sort()).toEqual([SURFACE_ORDER.glassBack, SURFACE_ORDER.glassFront])
  })
  it('the stacked RT holds an outer fused cluster\'s members as panels (their own shapes) when glass nests in one', () => {
    const { s, a } = fusedSurface()
    const knob = new Node('glass', 'knob'); knob.setStyle({ position: 'absolute', left: 10, top: 10, width: 20, height: 20 }); a.appendChild(knob)
    s.tick(0)
    expect(s.innerGlass.nodes).toEqual([knob]); expect(s.stack).not.toBeNull()
    expect(s.stack!.panels.buffer.count).toBe(3)                                  // far, a and b
  })
  for (const forceWebGL of [false, true]) {
    it(`${forceWebGL ? 'GLSL' : 'WGSL'}: on a glass Surface (kawase, depth reject) the fused draws build within 11 varyings, reuse the slab's copies, and cast`, () => {
      const warnings: string[] = []
      const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')) })
      try {
        const { s } = fusedSurface({ ...ctx, quality: { ...ctx.quality, blur: 'kawase' } }, { background: 'glass', glass: { variant: 'clear', adaptive: true } })
        const copies = (m: Mesh) => buildShaders(m.material as MeshPhysicalNodeMaterial, m.geometry, forceWebGL).updateBefore
          .filter(n => CAPTURES.includes(n.constructor.type!)).map(n => n.getBase!())
        const slab = new Set(probeOf(s).flatMap(copies))
        expect(slab.size).toBe(2)
        const draws = meshBatches(s)
        expect(draws).toHaveLength(2)
        for (const m of draws) {
          const built = buildShaders(m.material as MeshPhysicalNodeMaterial, m.geometry, forceWebGL)
          expect(built.varyings.length).toBeLessThanOrEqual(11)
          expect(new Set(copies(m))).toEqual(slab)
          expect(buildShaders(m.material as MeshPhysicalNodeMaterial, m.geometry, forceWebGL, true).vertex.length).toBeGreaterThan(0)
        }
        expect(new Set(draws.flatMap(m => materialGraph(m.material as Material)).filter(n => n.isTextureNode).map(n => n.value))).toContain(s.contentPass.texture)
        // the low tier (straight through) and medium build too
        for (const q of [QUALITY.low, QUALITY.medium]) {
          s.setQuality(q)
          expect(s.error).toBeNull()
          for (const m of meshBatches(s)) expect(buildShaders(m.material as MeshPhysicalNodeMaterial, m.geometry, forceWebGL).varyings.length).toBeLessThanOrEqual(11)
        }
      } finally { spy.mockRestore() }
      expect(warnings.filter(w => !w.includes('Vertex attribute "position" not found'))).toEqual([])
    })
  }
  it('a pointer moving while pressed (a touch change only) rewrites the glow alone: same mesh, same outer instances (the luma does not repack)', () => {
    const { s, b } = fusedSurface(ctx, { glass: { variant: 'clear', adaptive: true } })
    b.setStyle({ pressed: {} }); s.tick(0)
    s.setPointer([127.5, 40]); s.pointer.down(127.5, 40); s.tick(0)
    const geometry = s.fused.batches[0]!.geometry, outer = s.fused.outer
    expect(outer).toHaveLength(1)
    s.setPointer([60, 60]); s.tick(0)
    expect(s.fused.batches[0]!.buffer.get(0, 'iTouch').slice(0, 3)).toEqual([-25 / 170, -0.25, 1].map(Math.fround))
    expect(s.fused.batches[0]!.geometry).toBe(geometry); expect(s.fused.outer).toBe(outer)
  })
  it('clusters keep their draws by member: one dissolving leaves the next one\'s mesh alone', () => {
    const s = new Surface({ width: 400, height: 100, ptPerUnit: 1 }, ctx)
    const box = new Node('box', 'bar'); box.setProp('glassContainer', { spacing: 16 }); box.setStyle({ position: 'absolute', left: 0, top: 0, width: 400, height: 100 })
    const at = (left: number) => { const g = new Node('glass'); g.setStyle({ position: 'absolute', left, top: 30, width: 40, height: 40, radius: 'capsule' }); box.appendChild(g); return g }
    const [, b] = [at(0), at(50), at(200), at(250)]
    s.root.appendChild(box); s.tick(0)
    expect(s.fused.batches).toHaveLength(2)
    const second = s.fused.batches[1]!.geometry
    b!.setStyle({ left: 120 }); s.tick(0)                                         // the first pair comes apart
    expect(s.fused.batches).toHaveLength(1); expect(s.fused.batches[0]!.geometry).toBe(second)
  })
  it('a fused member\'s focus ring drops its hover tilt on the flat slab; drawn alone (\'fill\') it keeps it', () => {
    const { s, b } = fusedSurface({ ...ctx })
    b.setProp('tabIndex', 0); b.setState({ focused: true, focusVisible: true }); b.tilt = { x: 0.05, y: 0.05 }; s.tick(0)
    expect(s.foregroundPanels.buffer.count).toBe(1)
    expect(s.foregroundPanels.buffer.get(0, 'iMat0').slice(0, 3)).toEqual([1, 0, 0]); expect(s.foregroundPanels.buffer.get(0, 'iMat2').slice(0, 3)).toEqual([0, 0, 1])
    s.setQuality(QUALITY.minimal)
    expect(s.foregroundPanels.buffer.get(0, 'iMat2')[0]).not.toBe(0)
  })
  it('a primary Button between two plain ones stays single glass with its rim and glow; hovering the second member glints the slab', () => {
    const { s, a, b } = fusedSurface()
    const p = new Node('glass', 'primary'); p.setStyle({ position: 'absolute', left: 180, top: 30, width: 80, height: 40, radius: 'capsule', glass: { glow: { color: 'accent', strength: 1.1 } } })
    a.parent!.insertBefore(p, a.parent!.children[2]!); s.tick(0)
    expect(s.glass.nodes.map(n => n.id)).toEqual(['primary', 'far'])
    expect(s.glass.buffer.get(0, 'iGlow')[3]).toBeCloseTo(1.1); expect(s.rims.buffer.count).toBe(2)
    for (const n of [a, b]) n.setStyle({ hover: { glass: { edgeGlow: 1.1 } } })
    b.setState({ hover: true }); b.elevation = 6; s.tick(0)
    expect(s.fused.batches[0]!.buffer.get(0, 'iCorner')[3]).toBeCloseTo(1.1)       // b's glint on the slab it lifts
  })
  it('the mesh is extruded on the smallest member\'s short side, so the fillets fit it', () => {
    const s = new Surface({ width: 400, height: 100, ptPerUnit: 2 }, ctx)
    const box = new Node('box', 'bar'); box.setProp('glassContainer', { spacing: 16 }); box.setStyle({ position: 'absolute', left: 0, top: 0, width: 400, height: 100 })
    const a = new Node('glass', 'a'); a.setStyle({ position: 'absolute', left: 0, top: 30, width: 80, height: 40, radius: 'capsule', glass: { thickness: 20, fillet: 10, filletBottom: 6 } })
    const b = new Node('glass', 'b'); b.setStyle({ position: 'absolute', left: 90, top: 44, width: 12, height: 12, radius: 3 })
    box.appendChild(a); box.appendChild(b); s.root.appendChild(box); s.tick(0)
    const f = buildRenderList(s.model, theme, 'light').fused[0]!, shapes = fusedShapes(f), profile = fusedProfile(f, shapes)
    expect(profile).toEqual({ thickness: 20, fillet: 10, filletBottom: 6, minSide: 12 })
    const mesh = (minSide: number) => extrudeSlab(fusedOutline(shapes, 16), shapes, 16, { ...profile, minSide }, s.glass.K).positions.map(v => v / 2)
    const drawn = s.fused.batches[0]!.geometry.getAttribute('position').array
    expect(Array.from(drawn)).toEqual(Array.from(mesh(12)))
    expect(Array.from(drawn)).not.toEqual(Array.from(mesh(40)))                     // a's own short side would not fit b
  })
  it('a 3D attachment on a fused member stands on the slab\'s top; in \'fill\' on its member\'s own', () => {
    const { s, a, b } = fusedSurface({ ...ctx }, { placement: 'world' })
    b.setStyle({ glass: { thickness: 5 } })
    const vp = new Node('box', 'vp'); vp.setStyle({ position: 'absolute', left: 10, top: 5, width: 20, height: 20 }); b.appendChild(vp)
    s.attach3D(vp, new Object3D()); a.elevation = 6; s.tick(0)
    expect(s.viewports.get(vp)!.base).toBeCloseTo(6 + T)                              // a lifts the slab; its thickness is a's
    s.setQuality(QUALITY.minimal); s.tick(0)
    expect(s.viewports.get(vp)!.base).toBeCloseTo(5)
  })
  it('removing a container frees its slab\'s draws', () => {
    const { s, box } = fusedSurface()
    const geometry = s.fused.batches[0]!.geometry
    let freed = 0; geometry.addEventListener('dispose', () => { freed++ })
    s.root.removeChild(box); s.tick(0)
    expect(freed).toBe(1); expect(s.fused.batches).toEqual([]); expect(meshBatches(s)).toEqual([])
  })
  it('dispose frees the fused meshes, batches and materials', () => {
    const { s } = fusedSurface()
    const draws = meshBatches(s), freed: string[] = []
    draws[0]!.geometry.addEventListener('dispose', () => freed.push('geometry'))
    for (const m of draws) (m.material as Material).addEventListener('dispose', () => freed.push('material'))
    s.dispose()
    expect(freed.sort()).toEqual(['geometry', 'material', 'material'])
  })
})
