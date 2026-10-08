import { describe, it, expect, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { uniform } from 'three/tsl'
import { Vector2, Vector3, Texture, NoColorSpace, LinearFilter, LinearMipmapLinearFilter } from 'three'
import { Node, IDENTITY, scaleAbout, defaultTheme as theme, type ClipRect, type TextInstance } from '@glassui/core'
import { SystemFontEngine } from '@glassui/text'
import { createMeasureFn, runFor } from '../src/text/measure'
import { AtlasPages } from '../src/text/pages'
import { GlyphBatch, GLYPH_ATTRS } from '../src/text/batch'
import { createGlyphMaterial } from '../src/text/material'
import { instanceMatrix } from '../src/transform'
import { srgbToLinear } from '../src/color'
import type { InstanceBuffer } from '../src/instances'
import { evalNode } from './fixtures/tsl-eval'
import { buildShaders } from './fixtures/build-shaders'

const engine = new SystemFontEngine({ createCanvas: ((w: number, h: number) => createCanvas(w, h)) as never, pageSize: 256, maxPages: 2 })
const s = { width: 400, height: 300, ptPerUnit: 100 }
function text(value: string, extra: Partial<TextInstance> = {}): TextInstance {
  return { node: new Node('text'), rect: { x: 10, y: 10, width: 200, height: 40 }, text: value, font: { family: 'system-ui', size: 17, weight: 400 }, color: [0.1, 0.1, 0.13, 1], align: 'left', lineHeight: 22, letterSpacing: 0, wrap: true, z: 1.25, elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1, ...extra }
}
/** Instance attributes are float32: the expected value of a stored number is its float32 rounding. */
const f32 = (v: number[]) => v.map(Math.fround)
const su = () => ({ size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(100) })
/** Glyph `i`'s packed attributes by name, as `evalNode` takes them. */
const packed = (b: InstanceBuffer, i = 0) => Object.fromEntries(GLYPH_ATTRS.map(name => [name, b.get(i, name)]))
/** The single page batch of a one-page update. */
const only = (b: GlyphBatch) => { expect(b.perPage.size).toBe(1); return [...b.perPage.values()][0]! }

describe('createMeasureFn', () => {
  it('measures through resolveTextStyle and caches', () => {
    const n = new Node('text'); n.setProp('value', '创建账号'); n.setStyle({ fontSize: 'lg' })
    const measure = createMeasureFn(engine, theme, 'light')
    const a = measure(n, undefined)
    expect(a.width).toBeGreaterThan(0); expect(a.height).toBe(Math.round(1.3 * theme.fontSize.lg!))
    expect(measure(n, undefined)).toEqual(a)
    expect(measure(n, 10).width).toBeLessThanOrEqual(a.width)
  })
  it('runFor carries maxLines and wrap', () => {
    expect(runFor(text('x', { maxLines: 2, wrap: false }))).toMatchObject({ text: 'x', maxLines: 2, wrap: false, lineHeight: 22 })
  })
  it('passes the style\'s run and maxWidth to the engine, evicts the least recently used beyond cacheSize, clears', () => {
    const spy = vi.spyOn(engine, 'measure')
    try {
      const node = (value: string) => { const n = new Node('text'); n.setProp('value', value); n.setStyle({ fontWeight: 600, maxLines: 2, wrap: false, letterSpacing: 1 }); return n }
      const a = node('a'), b = node('b'), c = node('c')
      const measure = createMeasureFn(engine, theme, 'dark', { cacheSize: 2 })
      measure(a, 50)
      expect(spy).toHaveBeenLastCalledWith({ text: 'a', font: { family: 'system-ui', size: theme.fontSize.base, weight: 600 }, lineHeight: Math.round(1.3 * theme.fontSize.base!), letterSpacing: 1, maxLines: 2, wrap: false }, { maxWidth: 50 })
      measure(b, 50); measure(a, 50)   // a is now the most recent
      expect(spy).toHaveBeenCalledTimes(2)
      measure(c, 50)                   // evicts b
      measure(a, 50); expect(spy).toHaveBeenCalledTimes(3)
      measure(b, 50); expect(spy).toHaveBeenCalledTimes(4)
      measure(b, 60); expect(spy).toHaveBeenCalledTimes(5)   // maxWidth is part of the key
      measure.clear()
      measure(b, 60); expect(spy).toHaveBeenCalledTimes(6)
    } finally { spy.mockRestore() }
  })
})

describe('AtlasPages', () => {
  it('creates textures for pages, uploads dirty ones, reports epoch changes', () => {
    const pages = new AtlasPages(engine.atlas)
    engine.layout({ text: 'abc', font: { family: 'system-ui', size: 17, weight: 400 } }, undefined, 'left')
    const r = pages.sync()
    expect(pages.textures.length).toBe(engine.atlas.pages.length)
    expect(r.uploaded).toContain(0); expect(r.epochChanged).toBe(false)
    expect(pages.textures[0]!.needsUpdate === true || pages.textures[0]!.version > 0).toBe(true)
    expect(pages.sync().uploaded).toEqual([])
    engine.atlas.invalidate()
    expect(pages.sync().epochChanged).toBe(true)
  })
  it('page textures: the page canvas, raw (no colour space), linear with mipmaps, anisotropy 4, straight alpha, flipped', () => {
    const pages = new AtlasPages(engine.atlas)
    engine.layout({ text: 'abc', font: { family: 'system-ui', size: 17, weight: 400 } }, undefined, 'left')
    pages.sync()
    const t = pages.textures[0]!
    expect(t.image).toBe(engine.atlas.pages[0])
    expect([t.colorSpace, t.generateMipmaps, t.minFilter, t.magFilter, t.anisotropy, t.premultiplyAlpha]).toEqual([NoColorSpace, true, LinearMipmapLinearFilter, LinearFilter, 4, false])
    expect(t.flipY).toBe(true)   // the material samples at (u, 1 − v) for the atlas's top-left uvs
    const v = t.version
    engine.layout({ text: 'xyz', font: { family: 'system-ui', size: 17, weight: 400 } }, undefined, 'left')
    expect(pages.sync().uploaded).toEqual([0]); expect(t.version).toBeGreaterThan(v)
  })
})

describe('GlyphBatch', () => {
  it('emits one quad per visible glyph, grouped by page, with the text transform', () => {
    const pages = new AtlasPages(engine.atlas)
    const b = new GlyphBatch(engine, pages)
    b.update([text('ab cd'), text('中文', { rect: { x: 0, y: 100, width: 100, height: 30 }, opacity: 0.5, elevation: 2 })], s, t => t.text === '中文' ? 8 : 0)
    expect(b.glyphCount).toBe(6)
    const pageBuf = [...b.perPage.values()]
    expect(pageBuf.reduce((n, p) => n + p.buffer.count, 0)).toBe(6)
    const first = pageBuf[0]!.buffer
    const rect = first.get(0, 'iRect')
    expect(rect[2]).toBeGreaterThan(0); expect(rect[3]).toBeGreaterThan(0)
    const uv = first.get(0, 'iUV'); expect(uv[2]).toBeGreaterThan(uv[0]); expect(uv[3]).toBeGreaterThan(uv[1])
    const cjk = pageBuf.flatMap(p => Array.from({ length: p.buffer.count }, (_, i) => p.buffer.get(i, 'iMisc')[0])).filter(o => o === 0.5)
    expect(cjk).toHaveLength(2)
    expect(GLYPH_ATTRS).toHaveLength(10)
  })
  it('lifts glyphs by elevation plus lift', () => {
    const pages = new AtlasPages(engine.atlas)
    const b = new GlyphBatch(engine, pages)
    b.update([text('A', { elevation: 2 })], s, () => 8)
    const p = [...b.perPage.values()][0]!.buffer
    expect(p.get(0, 'iMat2')[3]).toBeCloseTo(0.1)
  })
  it('grows beyond the initial capacity', () => {
    const pages = new AtlasPages(engine.atlas)
    const b = new GlyphBatch(engine, pages)
    b.update([text('x'.repeat(100), { rect: { x: 0, y: 0, width: 2000, height: 40 } })], s)
    expect(b.glyphCount).toBe(100)
  })
  it('material builds', () => {
    const pages = new AtlasPages(engine.atlas)
    const b = new GlyphBatch(engine, pages); b.update([text('A')], s)
    const g = [...b.perPage.values()][0]!.geometry
    const m = createGlyphMaterial(g, { size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(100) }, new Texture())
    expect(m.transparent).toBe(true); expect(m.opacityNode).toBeTruthy()
  })

  it('packs the layout\'s size and uvs, linear colour, (opacity, no luma, 0, 0), sorted far→near by z', () => {
    const b = new GlyphBatch(engine, new AtlasPages(engine.atlas))
    const near = text('B', { z: 3, color: [1, 0.5, 0, 0.6], opacity: 0.25 }), far = text('A', { z: 1 })
    b.update([near, far], s)
    const { buffer } = only(b)
    expect(buffer.count).toBe(2)
    const [gA] = engine.layout(runFor(far), far.rect.width, far.align), [gB] = engine.layout(runFor(near), near.rect.width, near.align)
    expect(buffer.get(0, 'iUV')).toEqual(f32([gA!.u0, gA!.v0, gA!.u1, gA!.v1]))
    expect(buffer.get(1, 'iUV')).toEqual(f32([gB!.u0, gB!.v0, gB!.u1, gB!.v1]))
    expect(buffer.get(1, 'iRect').slice(2)).toEqual(f32([gB!.width / 100, gB!.height / 100]))
    expect(buffer.get(1, 'iColor')).toEqual(f32([1, srgbToLinear(0.5), 0, 0.6]))
    expect(buffer.get(1, 'iMisc')).toEqual(f32([0.25, -1, 0, 0]))
  })
  it('places each glyph at its layout position through the text\'s transform; a tilt turns the block as one', () => {
    // the glyph quad's vertices must be the text instance's own matrix (transform, elevation + lift, tilt about the
    // text rect's centre) applied to the glyph's position inside the text rect, not a tilt about each glyph's centre
    const t = text('Hi 中', { rect: { x: 40, y: 60, width: 160, height: 44 }, align: 'center', elevation: 6, transform: scaleAbout(120, 92, 0.8), tilt: { x: 0.3, y: -0.2 } })
    const lift = 4
    const b = new GlyphBatch(engine, new AtlasPages(engine.atlas)); b.update([t], s, () => lift)
    const { geometry, buffer } = only(b)
    const m = createGlyphMaterial(geometry, su(), new Texture())
    const M = instanceMatrix({ ...t, elevation: t.elevation + lift }, s)
    const glyphs = engine.layout(runFor(t), t.rect.width, t.align)
    expect(buffer.count).toBe(glyphs.length)
    let worst = 0
    glyphs.forEach((g, i) => {
      for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const) {
        const got = evalNode(m.positionNode, { ...packed(buffer, i), position: [x, y, 0] })
        // the vertex in the text rect's centred frame (pt, y down) → units (y up), then the text's matrix
        const px = g.x + (x + 0.5) * g.width - t.rect.width / 2, py = g.y + (0.5 - y) * g.height - t.rect.height / 2
        const want = new Vector3(px / 100, -py / 100, 0).applyMatrix4(M)
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(got[k]! - want.getComponent(k)))
      }
    })
    expect(worst).toBeLessThan(1e-5)   // float32 packing
  })
  it('keeps an emptied page\'s batch (buffers never shrink) at zero instances', () => {
    const b = new GlyphBatch(engine, new AtlasPages(engine.atlas))
    b.update([text('A')], s)
    const pb = only(b)
    b.update([], s)
    expect(b.glyphCount).toBe(0); expect(only(b)).toBe(pb); expect(pb.buffer.count).toBe(0); expect(pb.geometry.instanceCount).toBe(0)
  })
  it('syncs the page textures after laying out', () => {
    const pages = new AtlasPages(engine.atlas)
    const b = new GlyphBatch(engine, pages)
    b.update([text('Qq')], s)
    expect(pages.textures.length).toBe(engine.atlas.pages.length); expect(engine.atlas.dirtyPages.size).toBe(0)
  })
})

describe('glyph material', () => {
  // the fragment at quad vertex (x, y) of glyph 0, through a sampler that records the uv and returns alpha 0.8
  const frag = (inst: TextInstance, x: number, y: number) => {
    const b = new GlyphBatch(engine, new AtlasPages(engine.atlas)); b.update([inst], s)
    const { geometry, buffer } = only(b)
    const page = new Texture(), uvs: number[][] = []
    const m = createGlyphMaterial(geometry, su(), page)
    const sample = (tex: unknown, uv: readonly number[]) => { expect(tex).toBe(page); uvs.push([...uv]); return [1, 1, 1, 0.8] }
    const at = { ...packed(buffer), position: [x, y, 0], uv: [x + 0.5, y + 0.5] }
    return { rgba: [...evalNode(m.colorNode, at), ...evalNode(m.opacityNode, at, undefined, undefined, sample)], uv: uvs[0]!, iUV: buffer.get(0, 'iUV') }
  }
  it('samples the slot at (u, 1 − v): the quad\'s top-left is the slot\'s top-left (atlas v runs down, the texture is flipped)', () => {
    const tl = frag(text('A'), -0.5, 0.5), br = frag(text('A'), 0.5, -0.5)
    const [u0, v0, u1, v1] = tl.iUV
    expect(tl.uv[0]).toBeCloseTo(u0, 7); expect(tl.uv[1]).toBeCloseTo(1 - v0, 7)
    expect(br.uv[0]).toBeCloseTo(u1, 7); expect(br.uv[1]).toBeCloseTo(1 - v1, 7)
  })
  it('colours by the linear text colour; opacity = page alpha × colour alpha × instance opacity', () => {
    const { rgba } = frag(text('A', { color: [1, 0.5, 0, 0.6], opacity: 0.5 }), 0, 0)
    rgba.forEach((c, k) => expect(c).toBeCloseTo([1, srgbToLinear(0.5), 0, 0.8 * 0.6 * 0.5][k]!, 6))
  })
  it('masks by the instance clip', () => {
    const clip: ClipRect = { x: 0, y: 0, width: 100, height: 300, radius: 0, transform: IDENTITY }
    const b = new GlyphBatch(engine, new AtlasPages(engine.atlas))
    b.update([text('A', { rect: { x: 90, y: 10, width: 200, height: 40 }, clip })], s)   // 'A' straddles x = 100
    const { geometry, buffer } = only(b)
    const m = createGlyphMaterial(geometry, su(), new Texture())
    expect(evalNode(m.maskNode, { ...packed(buffer), position: [-0.5, 0, 0] })[0]).toBe(1)
    expect(evalNode(m.maskNode, { ...packed(buffer), position: [0.5, 0, 0] })[0]).toBe(0)
  })
  for (const forceWebGL of [false, true]) {
    it(`${forceWebGL ? 'GLSL' : 'WGSL'}: builds with packed varyings only and the clip discard`, () => {
      const warnings: string[] = []
      const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')) })
      try {
        const pages = new AtlasPages(engine.atlas)
        const b = new GlyphBatch(engine, pages); b.update([text('A')], s)
        const { geometry } = only(b)
        const out = buildShaders(createGlyphMaterial(geometry, su(), pages.textures[0]!), geometry, forceWebGL)
        // flatVertex's clip pair, the uv/colour/misc packs and the quad uv: the fragment reads no instance attribute
        // (and needs no q), and unlit, no view position
        expect([...out.varyings].sort()).toEqual(['vFlatClip', 'vFlatClipR', 'vGlyphUV', 'v_iColor', 'v_iMisc', 'v_iUV'])
        expect(out.fragment).toContain('discard')   // the clip mask
      } finally { spy.mockRestore() }
      expect(warnings).toEqual([])
    })
  }
})
