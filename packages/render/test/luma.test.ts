import { describe, it, expect, vi } from 'vitest'
import { DataTexture, FloatType, NearestFilter, NoBlending, RenderTarget, Texture, UnsignedByteType, type Mesh, type Object3D } from 'three'
import type { MeshBasicNodeMaterial, Node as TSLNode } from 'three/webgpu'
import { GlassUIError, IDENTITY, Node, type GlassInstance, type ResolvedGlass } from '@glassui/core'
import { LumaPass, LUMA_SETTLE, LUMA_TAU, SurfaceLuma, type LumaRect } from '../src/luma'
import { GlassBatch } from '../src/glass/batch'
import type { GlassMaterial } from '../src/glass/material'
import { evalNode } from './fixtures/tsl-eval'
import { buildShaders } from './fixtures/build-shaders'

describe('LumaPass', () => {
  it('packs rects into the data texture and ping-pongs targets', () => {
    const p = new LumaPass(8)
    p.setRects([{ u: 0.1, v: 0.2, w: 0.3, h: 0.4 }, { u: 0.5, v: 0.5, w: 0.1, h: 0.1 }])
    expect(p.count).toBe(2)
    const data = p.rectTexture.image.data as Float32Array
    // the texture is float32: each stored number is its float32 rounding
    expect(Array.from(data.slice(0, 8))).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.5, 0.1, 0.1].map(Math.fround))
    expect(p.rectTexture.needsUpdate || p.rectTexture.version > 0).toBe(true)
    const targets: unknown[] = []
    const renderer = { setRenderTarget: vi.fn((t: unknown) => targets.push(t)), render: vi.fn() }
    const src = new Texture()
    p.render(renderer, src, 1 / 60); const t1 = p.texture
    p.render(renderer, src, 1 / 60); const t2 = p.texture
    expect(t1).not.toBe(t2); expect(renderer.render).toHaveBeenCalledTimes(2); expect(targets[targets.length - 1]).toBeNull()
  })
  it('rejects more rects than maxCount', () => {
    const p = new LumaPass(2)
    expect(() => p.setRects([{ u: 0, v: 0, w: 1, h: 1 }, { u: 0, v: 0, w: 1, h: 1 }, { u: 0, v: 0, w: 1, h: 1 }])).toThrow(/maxCount/)
    expect(() => p.setRects([{ u: 0, v: 0, w: 1, h: 1 }, { u: 0, v: 0, w: 1, h: 1 }, { u: 0, v: 0, w: 1, h: 1 }])).toThrow(GlassUIError)
    expect(() => new LumaPass(0)).toThrow(GlassUIError)
    expect(() => new LumaPass(2.5)).toThrow(/maxCount/)
  })
  it('allocates a maxCount × 1 float rect texture and two maxCount × 1 RGBA8 nearest targets', () => {
    const p = new LumaPass(16)
    expect([p.rectTexture.image.width, p.rectTexture.image.height]).toEqual([16, 1])
    expect(p.rectTexture.type).toBe(FloatType); expect(p.rectTexture.magFilter).toBe(NearestFilter)
    const targets = new Set<RenderTarget>()
    const r = { setRenderTarget: (t: RenderTarget | null) => { if (t) targets.add(t) }, render: vi.fn() }
    p.render(r, new Texture(), 0); p.render(r, new Texture(), 0)
    expect(targets.size).toBe(2)
    for (const t of targets) {
      expect([t.width, t.height]).toEqual([16, 1])
      expect(t.texture.type).toBe(UnsignedByteType); expect(t.texture.magFilter).toBe(NearestFilter); expect(t.texture.generateMipmaps).toBe(false)
    }
  })
  it('restores the previous render target, even when the pass throws', () => {
    const p = new LumaPass(4)
    const prev = { isRenderTarget: true } as unknown as RenderTarget
    const set = vi.fn()
    p.render({ setRenderTarget: set, getRenderTarget: () => prev, render: vi.fn() }, new Texture(), 1 / 60)
    expect(set).toHaveBeenLastCalledWith(prev)
    const before = p.texture
    const failing = { setRenderTarget: vi.fn(), getRenderTarget: () => prev, render: vi.fn(() => { throw new Error('backend not initialised') }) }
    expect(() => p.render(failing, new Texture(), 1 / 60)).toThrow(/backend/)
    expect(failing.setRenderTarget).toHaveBeenLastCalledWith(prev)
    expect(p.texture).toBe(before)                                     // nothing was written: the last result stands
  })
  it('writes the luma straight (no blending, depth or tone mapping)', () => {
    const p = new LumaPass(4)
    let m: MeshBasicNodeMaterial | null = null
    p.render({ setRenderTarget: vi.fn(), render: vi.fn((scene: Object3D) => { m = (scene as Mesh).material as MeshBasicNodeMaterial }) }, new Texture(), 0)
    const mat = m as unknown as MeshBasicNodeMaterial
    expect(mat.blending).toBe(NoBlending); expect(mat.transparent).toBe(false)
    expect(mat.depthTest).toBe(false); expect(mat.depthWrite).toBe(false); expect(mat.toneMapped).toBe(false)
  })
  it('dispose frees both targets, the rect texture and the material', () => {
    const p = new LumaPass(4)
    const targets = new Set<RenderTarget>()
    let m: MeshBasicNodeMaterial | null = null
    const r = { setRenderTarget: (t: RenderTarget | null) => { if (t) targets.add(t) }, render: (scene: Object3D) => { m = (scene as Mesh).material as MeshBasicNodeMaterial }}
    p.render(r, new Texture(), 0); p.render(r, new Texture(), 0)
    const owned = [...targets, p.rectTexture, m as unknown as MeshBasicNodeMaterial]
    const freed = new Set<unknown>()
    for (const o of owned) o.addEventListener('dispose', () => freed.add(o))
    p.dispose()
    expect(freed).toEqual(new Set(owned))
  })
})

interface Image { w: number; d: Float64Array }   // one row of RGBA texels
type Colour = (u: number, v: number) => readonly [number, number, number]
const REC709 = [0.2126, 0.7152, 0.0722] as const
const luma709 = (c: readonly number[]) => c[0]! * REC709[0] + c[1]! * REC709[1] + c[2]! * REC709[2]
/**
 * A CPU stand-in for the GPU: runs the pass's kernel per target texel with tsl-eval. The rect texture and the targets
 * read nearest (as their samplers do); the source is `colour(u, v)` and every tap is recorded with its level.
 */
function cpuRenderer(rects: DataTexture, source: Texture, colour: { fn: Colour }) {
  let target: RenderTarget | null = null
  const images = new Map<Texture, Image>(), taps: { texel: number; uv: number[]; level: number }[] = []
  let texel = 0
  const nearest = (img: Image, u: number) => { const i = Math.min(img.w - 1, Math.max(0, Math.floor(u * img.w))); return Array.from(img.d.slice(i * 4, i * 4 + 4)) }
  return {
    images, taps,
    setRenderTarget(t: RenderTarget | null) { target = t },
    getRenderTarget() { return target },
    render(scene: Object3D) {
      const m = (scene as Mesh).material as MeshBasicNodeMaterial, rt = target!, out: Image = { w: rt.width, d: new Float64Array(rt.width * 4) }
      const sample = (tex: unknown, uv: readonly number[], level?: readonly number[]) => {
        if (tex === rects) return nearest({ w: rects.image.width, d: Float64Array.from(rects.image.data as Float32Array) }, uv[0]!)
        if (tex === source) { taps.push({ texel, uv: [...uv], level: level![0]! }); return [...colour.fn(uv[0]!, uv[1]!), 1] }
        return nearest(images.get(tex as Texture) ?? { w: 1, d: new Float64Array(4) }, uv[0]!)   // a target not drawn yet: zeros
      }
      for (texel = 0; texel < out.w; texel++) out.d.set(evalNode(m.colorNode as TSLNode<'vec4'>, { uv: [(texel + 0.5) / out.w, 0.5] }, undefined, undefined, sample), texel * 4)
      images.set(rt.texture, out)
    },
  }
}
/** The 3 × 3 tap grid over `r` (cell centres) and the mip level the kernel samples it at, for a `W × H` source. */
function expected(r: LumaRect, W: number, H: number, fn: Colour) {
  const uvs: number[][] = []
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) uvs.push([r.u + r.w * (i + 0.5) / 3, r.v + r.h * (j + 0.5) / 3])
  return { uvs, level: Math.max(Math.log2(Math.max(r.w * W, r.h * H, 1)) - 1, 0), luma: uvs.reduce((s, [u, v]) => s + luma709(fn(u!, v!)), 0) / 9 }
}

describe('LumaPass kernel (run on the CPU through tsl-eval)', () => {
  const rects: LumaRect[] = [
    { u: 0.1, v: 0.2, w: 0.25, h: 0.5 },          // 128 × 128 source texels: level log2(128) − 1 = 6
    { u: 0.5, v: 0.5, w: 0.01, h: 0.01 },         // 5.12 × 2.56: level log2(5.12) − 1
    { u: 0.9, v: 0.05, w: 0.001, h: 0.002 },      // under 2 texels: level 0
  ].map(r => ({ u: Math.fround(r.u), v: Math.fround(r.v), w: Math.fround(r.w), h: Math.fround(r.h) }))   // as the float texture stores them
  const W = 512, H = 256
  const source = new RenderTarget(W, H).texture                         // a content RT's texture: its image carries the size
  const curved: Colour = (u, v) => [u * u, v * v, u * v]                // not linear: a single centre tap would not match

  it('averages a 3 × 3 grid over each element\'s rect at level log2(max(w·W, h·H)) − 1, in Rec. 709 luminance', () => {
    const p = new LumaPass(4); p.setRects(rects)
    const colour = { fn: curved }, r = cpuRenderer(p.rectTexture, source, colour)
    p.render(r, source, 1 / 60)
    const out = r.images.get(p.texture)!
    rects.forEach((rect, i) => {
      const e = expected(rect, W, H, curved)
      const taps = r.taps.filter(t => t.texel === i)
      expect(taps).toHaveLength(9)
      taps.forEach((t, k) => { expect(t.uv[0]).toBeCloseTo(e.uvs[k]![0]!, 6); expect(t.uv[1]).toBeCloseTo(e.uvs[k]![1]!, 6); expect(t.level).toBeCloseTo(e.level, 6) })
      Array.from(out.d.slice(i * 4, i * 4 + 4)).forEach((x, c) => expect(x).toBeCloseTo(c < 3 ? e.luma : 1, 12))   // the first render writes through
    })
    expect(expected(rects[0]!, W, H, curved).level).toBeCloseTo(6, 6)
    expect(expected(rects[2]!, W, H, curved).level).toBe(0)
    const unused = r.taps.filter(t => t.texel === 3)                     // an unused texel (rect 0 × 0): level 0, never log2(0)
    expect(unused).toHaveLength(9); expect(unused.every(t => t.level === 0)).toBe(true)
  })
  it('weights the channels by Rec. 709', () => {
    for (const [c, w] of [[[1, 0, 0], 0.2126], [[0, 1, 0], 0.7152], [[0, 0, 1], 0.0722]] as const) {
      const p = new LumaPass(1); p.setRects([{ u: 0, v: 0, w: 1, h: 1 }])
      const r = cpuRenderer(p.rectTexture, source, { fn: () => c })
      p.render(r, source, 1 / 60)
      expect(r.images.get(p.texture)!.d[0]).toBeCloseTo(w, 12)
    }
  })
  it('then blends toward the new luma by 1 − e^(−dt/τ), τ = 0.2 s; new rects write through again, equal ones keep smoothing', () => {
    const p = new LumaPass(4); p.setRects(rects)
    const colour = { fn: curved }, r = cpuRenderer(p.rectTexture, source, colour)
    p.render(r, source, 1 / 60)
    const first = rects.map(rect => expected(rect, W, H, curved).luma)
    const bright: Colour = (u, v) => [1 - u * v, 0.9, 0.5 + 0.5 * v]
    colour.fn = bright
    p.render(r, source, 0.1)
    const b = 1 - Math.exp(-0.1 / LUMA_TAU)
    expect(LUMA_TAU).toBe(0.2)
    let out = r.images.get(p.texture)!
    rects.forEach((rect, i) => expect(out.d[i * 4]).toBeCloseTo(first[i]! + (expected(rect, W, H, bright).luma - first[i]!) * b, 9))
    const second = rects.map((_, i) => out.d[i * 4]!)
    p.setRects(rects.map(x => ({ ...x })))                               // equal data: smoothing continues
    p.render(r, source, 0.1)
    out = r.images.get(p.texture)!
    rects.forEach((rect, i) => expect(out.d[i * 4]).toBeCloseTo(second[i]! + (expected(rect, W, H, bright).luma - second[i]!) * b, 9))
    const moved = [{ ...rects[0]!, u: Math.fround(0.3) }, ...rects.slice(1)]
    p.setRects(moved)                                                    // a rect moved: the next render writes through
    p.render(r, source, 0.1)
    out = r.images.get(p.texture)!
    moved.forEach((rect, i) => expect(out.d[i * 4]).toBeCloseTo(expected(rect, W, H, bright).luma, 9))
  })
  it('setRects re-uploads only when the packed data changed', () => {
    const p = new LumaPass(4)
    p.setRects(rects); const v = p.rectTexture.version
    p.setRects(rects.map(x => ({ ...x })))
    expect(p.rectTexture.version).toBe(v)
    p.setRects(rects.slice(0, 2))                                         // fewer rects: a change
    expect(p.rectTexture.version).toBeGreaterThan(v); expect(p.count).toBe(2)
  })
})

describe('LumaPass shaders (generated under Node)', () => {
  for (const forceWebGL of [false, true]) {
    it(`${forceWebGL ? 'GLSL' : 'WGSL'}: the kernel builds, with 9 taps of the source at an explicit level`, () => {
      const p = new LumaPass(8)
      let mesh: Mesh | null = null
      p.render({ setRenderTarget: vi.fn(), render: vi.fn((scene: Object3D) => { mesh = scene as Mesh }) }, new Texture(), 0)
      const m = mesh as unknown as Mesh
      const out = buildShaders(m.material as MeshBasicNodeMaterial, m.geometry, forceWebGL)
      // the source (linear, mipmapped) samples at the computed level; the rect texture and the previous target (nearest)
      // read level 0: loads in WGSL (a float32 texture is unfilterable there), textureLod at 0.0 in GLSL
      if (forceWebGL) {
        expect(out.fragment.match(/textureLod\s*\(/g)).toHaveLength(11)
        expect(out.fragment.match(/textureLod\s*\([^;]*,\s*0\.0\s*\)/g)).toHaveLength(2)
      } else {
        expect(out.fragment.match(/textureSampleLevel\s*\(/g)).toHaveLength(9)
        expect(out.fragment.match(/textureLoad\s*\(/g)).toHaveLength(2)
      }
      expect(out.fragment).toMatch(/log2\s*\(/)
    })
  }
})

const params: ResolvedGlass = { thickness: 8, fillet: 2.4, filletBottom: 1.6, profile: 'fillet', scatter: 0.05, lift: 0.1, edgeGlow: 0.8, ior: 1.5, dispersion: 0.8, roughness: 0.06, tint: null, absorption: 0, glow: null, cornerExponent: 2, envIntensity: 1, specularIntensity: 1, innerGlow: 0, adaptive: true, variant: 'clear' }
function glass(id: string, z: number, rect: { x: number; y: number; width: number; height: number }, p: Partial<ResolvedGlass> = {}): GlassInstance {
  return { node: new Node('glass', id), rect, radius: 4, z, params: { ...params, ...p }, elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1 }
}
const fakeMaterial = () => ({ setLuma: vi.fn() }) as unknown as GlassMaterial & { setLuma: ReturnType<typeof vi.fn> }
/** A stub renderer recording each draw's target. */
const recording = () => {
  let bound: RenderTarget | null = null
  const drawn: (RenderTarget | null)[] = []
  return { drawn, setRenderTarget: vi.fn((t: RenderTarget | null) => { bound = t }), render: vi.fn(() => { drawn.push(bound) }) }
}

describe('SurfaceLuma (a Surface\'s luma bookkeeping)', () => {
  const S = { width: 400, height: 200 }
  const src = new Texture()

  it('packs every glass instance\'s rect in content uv (v = 0 at the top), in the glass batch\'s instance order', () => {
    const list = [glass('c', 3, { x: 200, y: 100, width: 100, height: 50 }), glass('a', 1, { x: 40, y: 20, width: 80, height: 40 }, { variant: 'regular' }), glass('b', 2, { x: 0, y: 150, width: 400, height: 50 })]
    const l = new SurfaceLuma()
    l.update(recording(), list, S, src, 1 / 60, true)
    const data = Array.from((l.pass!.rectTexture.image.data as Float32Array).slice(0, 12))
    expect(data).toEqual([0.1, 0.1, 0.2, 0.2, 0, 0.75, 1, 0.25, 0.5, 0.5, 0.25, 0.25].map(Math.fround))   // a, b, c: far → near
    const batch = new GlassBatch(); batch.update(list, { ...S, ptPerUnit: 1 })
    expect(batch.nodes.map(n => n.id)).toEqual(['a', 'b', 'c'])           // texel i is instance i: the luma index the batch writes
    expect([0, 1, 2].map(i => batch.buffer.get(i, 'iGlow2')[3])).toEqual([-1, 1, 2])   // 'a' is regular: never read
    expect(l.pass!.count).toBe(3)
  })
  it('runs only with clear + adaptive glass, and points the attached element glass at the result (texture, maxCount)', () => {
    const l = new SurfaceLuma(), m = fakeMaterial(), r = recording()
    l.attach([m])
    l.update(r, [glass('a', 1, { x: 0, y: 0, width: 10, height: 10 }, { variant: 'regular' }), glass('b', 2, { x: 0, y: 0, width: 10, height: 10 }, { adaptive: false })], S, src, 1 / 60, true)
    expect(r.render).not.toHaveBeenCalled(); expect(l.pass).toBeNull(); expect(m.setLuma).not.toHaveBeenCalled()
    l.update(r, [glass('a', 1, { x: 0, y: 0, width: 10, height: 10 })], S, src, 1 / 60, true)
    expect(r.render).toHaveBeenCalledTimes(1)
    expect(m.setLuma).toHaveBeenLastCalledWith(l.pass!.texture, 256)       // count is the texture's width, not the rect count
    const later = fakeMaterial()
    l.attach([later])                                                     // a rebuild's new materials see the current result at once
    expect(later.setLuma).toHaveBeenCalledWith(l.pass!.texture, 256)
  })
  it('runs on a redraw and while the smoothing settles (LUMA_SETTLE of frame time), then never on a quiet frame', () => {
    const l = new SurfaceLuma(), m = fakeMaterial(), r = recording(), list = [glass('a', 1, { x: 0, y: 0, width: 10, height: 10 })]
    l.attach([m])
    expect(LUMA_SETTLE).toBeCloseTo(5 * LUMA_TAU, 12)
    l.update(r, list, S, src, 0.25, true)
    for (let i = 0; i < 3; i++) l.update(r, list, S, src, 0.25, false)   // 0.25 … 0.75 s after the redraw
    expect(r.render).toHaveBeenCalledTimes(4)
    l.update(r, list, S, src, 0.25, false)                                 // 1 s: settled
    l.update(r, list, S, src, 0.25, false)
    expect(r.render).toHaveBeenCalledTimes(4)
    const textures = new Set(m.setLuma.mock.calls.map(c => c[0]))
    expect(textures.size).toBe(2)                                          // the ping-pong: each render's own target
    expect(m.setLuma).toHaveBeenCalledTimes(4)
    l.update(r, list, S, src, 0.25, true)                                  // a new redraw starts it again
    expect(r.render).toHaveBeenCalledTimes(5)
  })
  it('re-packs the rects only when the glass list or the Surface size changed', () => {
    const l = new SurfaceLuma(), r = recording(), list = [glass('a', 1, { x: 0, y: 0, width: 100, height: 100 })]
    l.update(r, list, S, src, 1 / 60, true)
    const set = vi.spyOn(l.pass!, 'setRects')
    l.update(r, list, S, src, 1 / 60, true)
    expect(set).not.toHaveBeenCalled()
    const rebuilt = [...list]                                             // a rebuilt render list
    l.update(r, rebuilt, S, src, 1 / 60, true)
    expect(set).toHaveBeenCalledTimes(1)
    l.update(r, rebuilt, { width: 200, height: 200 }, src, 1 / 60, true)  // the same list on a resized Surface
    expect(set).toHaveBeenCalledTimes(2)
    expect(Array.from((l.pass!.rectTexture.image.data as Float32Array).slice(0, 4))).toEqual([0, 0, 0.5, 0.5])
  })
  it('grows past maxCount by doubling: a new pass, the old one freed, the element glass re-pointed', () => {
    const l = new SurfaceLuma(2), m = fakeMaterial(), r = recording()
    l.attach([m])
    const few = [glass('a', 1, { x: 0, y: 0, width: 10, height: 10 })]
    l.update(r, few, S, src, 1 / 60, true)
    const old = l.pass!
    expect(old.maxCount).toBe(2)
    const freed = vi.fn(); old.rectTexture.addEventListener('dispose', freed)
    const many = Array.from({ length: 5 }, (_, i) => glass(`g${i}`, i, { x: i * 10, y: 0, width: 10, height: 10 }))
    l.update(r, many, S, src, 1 / 60, true)
    expect(l.pass).not.toBe(old); expect(l.pass!.maxCount).toBe(8); expect(l.pass!.count).toBe(5)
    expect(freed).toHaveBeenCalled()
    expect(m.setLuma).toHaveBeenLastCalledWith(l.pass!.texture, 8)
  })
  it('dispose frees the pass', () => {
    const l = new SurfaceLuma(), r = recording()
    l.update(r, [glass('a', 1, { x: 0, y: 0, width: 10, height: 10 })], S, src, 1 / 60, true)
    const freed = vi.fn(); l.pass!.rectTexture.addEventListener('dispose', freed)
    l.dispose()
    expect(freed).toHaveBeenCalled(); expect(l.pass).toBeNull()
  })
})
