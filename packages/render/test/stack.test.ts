import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { CustomBlending, HalfFloatType, Mesh, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, Texture, Vector2, type Material, type Object3D, type RenderTarget } from 'three'
import type { MeshBasicNodeMaterial } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { Node, IDENTITY, scaleAbout, defaultTheme as theme, resolveColor, type ClipRect, type GlassInstance, type ImageInstance, type PanelInstance, type ResolvedGlass, type RGBA, type TextInstance } from '@glassui/core'
import { SystemFontEngine } from '@glassui/text'
import { StackPass, STACK_FILL_ALPHA, STACK_ORDER, createStackContentMaterial } from '../src/surface/stack'
import { PanelBatch, PANEL_ATTRS } from '../src/panel/batch'
import { AtlasPages } from '../src/text/pages'
import { FILL } from '../src/glass/frost'
import { srgbToLinear } from '../src/color'
import { buildShaders } from './fixtures/build-shaders'

let text: SystemFontEngine, pages: AtlasPages
beforeAll(() => {
  text = new SystemFontEngine({ createCanvas: ((w: number, h: number) => createCanvas(w, h)) as never, pageSize: 512, maxPages: 2 })
  pages = new AtlasPages(text.atlas)
})

/** Instance attributes are float32: the expected value of a stored number is its float32 rounding. */
const f32 = (v: number[]) => v.map(Math.fround)
const s = { width: 400, height: 300, ptPerUnit: 100 }
const su = () => ({ size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(100) })
const params: ResolvedGlass = { thickness: 8, fillet: 2.4, filletBottom: 1.6, profile: 'fillet', scatter: 0.05, lift: 0.1, edgeGlow: 0.8, ior: 1.5, dispersion: 0.8, roughness: 0.06, tint: null, absorption: 0, glow: null, cornerExponent: 4.5, envIntensity: 1, specularIntensity: 1, innerGlow: 0, adaptive: true, variant: 'regular' }
function glass(id: string, z: number, p: Partial<ResolvedGlass> = {}, extra: Partial<GlassInstance> = {}): GlassInstance {
  return { node: new Node('glass', id), rect: { x: 20, y: 20, width: 200, height: 120 }, radius: 24, z, params: { ...params, ...p }, elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1, ...extra }
}
function textOn(id: string, value: string, z: number): TextInstance {
  return { node: new Node('text', id), rect: { x: 40, y: 40, width: 120, height: 20 }, text: value, font: { family: 'system-ui', size: 15, weight: 400 }, color: [0, 0, 0, 1], align: 'left', lineHeight: 20, letterSpacing: 0, wrap: false, z, elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1 }
}
function meshes(o: Object3D): Mesh[] { const out: Mesh[] = []; o.traverse(c => { if (c instanceof Mesh) out.push(c) }); return out }
interface GraphNode { value?: unknown; isTextureNode?: boolean; getChildren(): Iterable<GraphNode> }
/** The textures a node graph samples. */
function texturesOf(root: unknown): unknown[] {
  const seen = new Set<GraphNode>(), stack = [root as GraphNode]
  while (stack.length) { const n = stack.pop()!; if (seen.has(n)) continue; seen.add(n); for (const c of n.getChildren()) stack.push(c) }
  return [...seen].filter(n => n.isTextureNode).map(n => n.value)
}
const stubRenderer = () => ({ setRenderTarget: vi.fn(), render: vi.fn(), setClearColor: vi.fn(), getClearColor: vi.fn(c => c), getClearAlpha: vi.fn(() => 1) })

describe('StackPass (spatial spec §2.4)', () => {
  it('fills at 0.35', () => expect(STACK_FILL_ALPHA).toBe(0.35))

  it('draws each outer glass as the panel the fill mode would colour it, at STACK_FILL_ALPHA, with a 1 pt tertiaryLabel border; the glass\'s own place, opacity and clip', () => {
    const st = new StackPass(new Texture(), su(), { text, pages })
    const clip: ClipRect = { x: 0, y: 0, width: 300, height: 100, radius: 12, transform: IDENTITY }
    const glowing = glass('glow', 1, { glow: { color: [0.42, 0.39, 0.96, 1], strength: 1.1 }, tint: [1, 0.5, 0, 1] })
    const tinted = glass('tint', 2, { tint: [1, 0.5, 0, 0.8], glow: { color: [0, 1, 0, 1], strength: 0 } })   // a glow of strength 0 does not glow
    const plain = glass('plain', 3, {}, { opacity: 0.5, clip, elevation: 6, tilt: { x: 0.1, y: -0.2 }, transform: scaleAbout(120, 80, 0.9), scale: 0.9 })
    st.update([plain, tinted, glowing], [], [], [], s, theme, 'light')
    expect(st.panels.buffer.count).toBe(3)

    const fade = (c: RGBA): RGBA => [c[0], c[1], c[2], c[3] * STACK_FILL_ALPHA]
    const fill = resolveColor('fill', theme, 'light'), label = resolveColor('label', theme, 'light')
    const shade: RGBA = [0, 1, 2].map(k => fill[k]! + (label[k]! - fill[k]!) * FILL.labelMix).concat(1) as RGBA   // the fill mode's rule, in sRGB
    const border = { width: 1, color: fade(resolveColor('tertiaryLabel', theme, 'light')) }
    // what a plain PanelBatch packs for the panels expected, attribute for attribute
    const panel = (g: GlassInstance, color: RGBA): PanelInstance => {
      const { node, rect, radius, z, elevation, scale, transform, tilt, opacity, clip: c } = g
      return { node, rect, radius, z, elevation, scale, transform, tilt, opacity, color: fade(color), border, ...(c ? { clip: c } : {}) }
    }
    const ref = new PanelBatch()
    ref.update([panel(glowing, [0.42, 0.39, 0.96, 1]), panel(tinted, [1, 0.5, 0, 0.8]), panel(plain, shade)], s)
    for (let i = 0; i < 3; i++) for (const name of PANEL_ATTRS) expect(st.panels.buffer.get(i, name), `${i} ${name}`).toEqual(ref.buffer.get(i, name))
    expect(st.panels.buffer.get(2, 'iColor')).toEqual(f32([...shade.slice(0, 3).map(srgbToLinear), STACK_FILL_ALPHA]))
    expect(st.panels.buffer.get(0, 'iBorder')[3]).toBe(Math.fround(STACK_FILL_ALPHA))
    expect(st.panels.buffer.get(0, 'iShape')[1]).toBe(Math.fround(1 / 100))   // 1 pt
  })

  it('spatial §11.8: holds the panels riding on outer glass (a chip on a Card) in the same batch, over the Card\'s fill, flat and as they are', () => {
    const st = new StackPass(new Texture(), su(), { text, pages })
    const card = glass('card', 1, {}, { elevation: 24 })
    const chip: PanelInstance = { node: new Node('box', 'chip'), rect: { x: 40, y: 40, width: 60, height: 22 }, radius: 11, color: [0.2, 0.5, 1, 1], z: 2, elevation: 24, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1 }
    st.update([card], [chip], [], [], s, theme, 'light')
    expect(st.panels.buffer.count).toBe(2)                                           // the Card's fill and the chip
    const ref = new PanelBatch(); ref.update([chip], s)                              // the chip as a plain batch packs it: no lift, own colour
    for (const name of PANEL_ATTRS) expect(st.panels.buffer.get(1, name), name).toEqual(ref.buffer.get(0, name))
    expect(st.panels.buffer.get(0, 'iColor')[3]).toBe(Math.fround(STACK_FILL_ALPHA))  // first (z order): the translucent fill
    expect(st.panels.buffer.get(1, 'iMat2')[3]).toBeCloseTo(0.24)                    // its own elevation, nothing added
    st.update([card], [], [], [], s, theme, 'light')                                 // the chip went away
    expect(st.panels.buffer.count).toBe(1)
  })

  it('starts from the content RT: a full-Surface quad, the first draw, composited premultiplied', () => {
    const content = new Texture(), st = new StackPass(content, su(), { text, pages })
    st.update([glass('g', 1)], [], [], [], s, theme, 'light')
    const draws = meshes(st.pass.scene).sort((a, b) => a.renderOrder - b.renderOrder)
    const quad = draws[0]!
    expect(quad.renderOrder).toBe(STACK_ORDER.content); expect(STACK_ORDER.content).toBe(-1)
    expect(draws.slice(1).every(m => m.renderOrder >= STACK_ORDER.panels)).toBe(true)
    expect([quad.scale.x, quad.scale.y]).toEqual([4, 3])                            // the Surface, in units
    const m = quad.material as MeshBasicNodeMaterial
    expect(texturesOf(m.colorNode)).toContain(content); expect(texturesOf(m.opacityNode)).toContain(content)
    expect(m.blending).toBe(CustomBlending); expect(m.premultipliedAlpha).toBe(false)
    expect([m.blendSrc, m.blendDst, m.blendSrcAlpha, m.blendDstAlpha]).toEqual([OneFactor, OneMinusSrcAlphaFactor, OneFactor, OneMinusSrcAlphaFactor])
    expect(st.pass.camera.right).toBeCloseTo(2); expect(st.pass.camera.top).toBeCloseTo(1.5)  // the content pass's own view
  })

  it('holds the text and images it is given, flat, over the panels', () => {
    const st = new StackPass(new Texture(), su(), { text, pages })
    const img: ImageInstance = { node: new Node('image', 'icon'), rect: { x: 30, y: 30, width: 20, height: 20 }, src: new Texture(), radius: 0, z: 1.25, elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1 }
    st.update([glass('g', 1)], [], [textOn('t', 'Hi', 1.25)], [img], s, theme, 'light')
    let glyphs = 0; for (const pb of st.text.perPage.values()) { glyphs += pb.buffer.count; for (let i = 0; i < pb.buffer.count; i++) expect(pb.buffer.get(i, 'iMat2')[3]).toBe(0) }
    expect(glyphs).toBe(2)
    const draws = meshes(st.pass.scene)
    expect(draws.filter(m => m.renderOrder === STACK_ORDER.glyphs)).toHaveLength(st.text.perPage.size)
    const images = draws.filter(m => m.renderOrder >= STACK_ORDER.images && m.renderOrder < STACK_ORDER.glyphs)
    expect(images).toHaveLength(1)
    expect(STACK_ORDER.panels).toBeLessThan(STACK_ORDER.images)
    st.update([glass('g', 1)], [], [], [], s, theme, 'light')                        // nothing rides on it any more
    glyphs = 0; for (const pb of st.text.perPage.values()) glyphs += pb.buffer.count
    expect(glyphs).toBe(0); expect(meshes(st.pass.scene).filter(m => m.renderOrder >= STACK_ORDER.images && m.renderOrder < STACK_ORDER.glyphs)).toHaveLength(0)
  })

  it('renders into its own mipmapped RT over a transparent clear, and puts the renderer back', () => {
    const st = new StackPass(new Texture(), su(), { text, pages }), r = stubRenderer()
    expect(st.texture).toBe(st.pass.texture); expect(st.texture.generateMipmaps).toBe(true)
    st.render(r)
    expect(r.setClearColor).toHaveBeenNthCalledWith(1, expect.objectContaining({ r: 0, g: 0, b: 0 }), 0)
    expect(r.setRenderTarget.mock.calls.map(c => c[0])).toEqual([st.pass.target, null])
    expect(r.render).toHaveBeenCalledWith(st.pass.scene, st.pass.camera)
  })

  it('resizes and switches its texel type like the content pass', () => {
    const st = new StackPass(new Texture(), su(), { text, pages, type: 'byte' })
    expect(st.resize(256, 192)).toBe(true); expect(st.resize(256, 192)).toBe(false)
    expect([st.pass.width, st.pass.height]).toEqual([256, 192])
    const texture = st.texture
    st.setType('half')
    expect(st.texture).toBe(texture); expect(texture.type).toBe(HalfFloatType)
    expect(new StackPass(new Texture(), su(), { text, pages, type: 'half' }).texture.type).toBe(HalfFloatType)
  })

  it('dispose frees its RT, batches, geometry and materials', () => {
    const st = new StackPass(new Texture(), su(), { text, pages })
    st.update([glass('g', 1)], [], [textOn('t', 'Hi', 1.25)], [], s, theme, 'light')
    type Disposable = { addEventListener(type: 'dispose', fn: () => void): void }
    const draws = meshes(st.pass.scene)
    const tracked: Disposable[] = [st.pass.target as RenderTarget, ...draws.map(m => m.material as Material), ...draws.map(m => m.geometry)]
    const freed = new Set<Disposable>()
    for (const o of tracked) o.addEventListener('dispose', () => freed.add(o))
    st.dispose()
    expect(draws.length).toBeGreaterThanOrEqual(3)                                   // quad, panels, a glyph page
    for (const o of tracked) expect(freed.has(o)).toBe(true)
  })
})

describe('stack content quad material shaders (generated under Node)', () => {
  for (const forceWebGL of [false, true]) {
    it(`${forceWebGL ? 'GLSL' : 'WGSL'}: builds without warnings`, () => {
      const warnings: string[] = []
      const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')) })
      try {
        const out = buildShaders(createStackContentMaterial(new Texture()), new PlaneGeometry(1, 1), forceWebGL)
        expect(out.fragment.length).toBeGreaterThan(0)
      } finally { spy.mockRestore() }
      expect(warnings).toEqual([])
    })
  }
})
