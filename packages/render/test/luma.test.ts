import { describe, it, expect, vi } from 'vitest'
import { DataTexture, FloatType, FramebufferTexture, HalfFloatType, NearestFilter, NoBlending, Object3D, OrthographicCamera, PerspectiveCamera, RenderTarget, Texture, type Mesh } from 'three'
import type { MeshBasicNodeMaterial, Node as TSLNode } from 'three/webgpu'
import { GlassUIError, IDENTITY, Node, type GlassInstance, type ResolvedGlass } from '@glassui/core'
import { LumaPass, LUMA_SETTLE, LUMA_TAU, SurfaceLuma, screenRect, type LumaFrame, type LumaRect } from '../src/luma'
import { GlassBatch } from '../src/glass/batch'
import { SLAB_BEHIND, SLAB_FROST } from '../src/glass/frost'
import type { GlassMaterial, ScreenCapture } from '../src/glass/material'
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
  it('allocates a maxCount × 2 float rect texture (content rects, screen rects) and two maxCount × 1 half-float nearest targets', () => {
    const p = new LumaPass(16)
    expect([p.rectTexture.image.width, p.rectTexture.image.height]).toEqual([16, 2])
    expect(p.rectTexture.type).toBe(FloatType); expect(p.rectTexture.magFilter).toBe(NearestFilter)
    const targets = new Set<RenderTarget>()
    const r = { setRenderTarget: (t: RenderTarget | null) => { if (t) targets.add(t) }, render: vi.fn() }
    p.render(r, new Texture(), 0); p.render(r, new Texture(), 0)
    expect(targets.size).toBe(2)
    for (const t of targets) {
      expect([t.width, t.height]).toEqual([16, 1])
      // half float: an 8-bit target would round a small blend step back to the previous value and stall short of the luma
      expect(t.texture.type).toBe(HalfFloatType); expect(t.texture.magFilter).toBe(NearestFilter); expect(t.texture.generateMipmaps).toBe(false)
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
  it('dispose frees both targets, the rect texture, the screen placeholder and the material', () => {
    const p = new LumaPass(4)
    const targets = new Set<RenderTarget>()
    let m: MeshBasicNodeMaterial | null = null
    const r = { setRenderTarget: (t: RenderTarget | null) => { if (t) targets.add(t) }, render: (scene: Object3D) => { m = (scene as Mesh).material as MeshBasicNodeMaterial }}
    p.render(r, new Texture(), 0); p.render(r, new Texture(), 0)
    const mat = m as unknown as MeshBasicNodeMaterial
    const placeholder = nodesOf(mat.colorNode).map(n => n.value).find((v): v is DataTexture => v instanceof DataTexture && v !== p.rectTexture)!
    const owned = [...targets, p.rectTexture, placeholder, mat]
    const freed = new Set<unknown>()
    for (const o of owned) o.addEventListener('dispose', () => freed.add(o))
    p.dispose()
    expect(freed).toEqual(new Set(owned))
  })
})

interface Image { w: number; h: number; d: Float64Array }   // RGBA texels, row 0 first
/** RGB (opaque) or premultiplied RGBA at (u, v), read at mip `level`. */
type Colour = (u: number, v: number, level: number) => readonly number[]
const REC709 = [0.2126, 0.7152, 0.0722] as const
const luma709 = (c: readonly number[]) => c[0]! * REC709[0] + c[1]! * REC709[1] + c[2]! * REC709[2]
interface GraphNode { value?: unknown; getChildren(): Iterable<GraphNode> }
/** Every node reachable from `root`, once each. */
function nodesOf(root: unknown): GraphNode[] {
  const seen = new Set<GraphNode>(), stack = [root as GraphNode]
  while (stack.length) { const n = stack.pop()!; if (seen.has(n)) continue; seen.add(n); for (const c of n.getChildren()) stack.push(c) }
  return [...seen]
}
/**
 * A CPU stand-in for the GPU: runs the pass's kernel per target texel with tsl-eval. The rect texture and the targets
 * read nearest (as their samplers do); the source is `colour.fn(u, v, level)`, a given `screen` texture
 * `screen.fn(u, v, level)`, and the pass's own screen placeholder black. Every source and screen tap is recorded with its level.
 */
function cpuRenderer(rects: DataTexture, source: Texture, colour: { fn: Colour }, screen?: { texture: Texture; fn: Colour }) {
  let target: RenderTarget | null = null
  const images = new Map<Texture, Image>(), taps: { texel: number; of: 'source' | 'screen'; uv: number[]; level: number }[] = []
  let texel = 0
  const nearest = (img: Image, u: number, v: number) => {
    const i = Math.min(img.w - 1, Math.max(0, Math.floor(u * img.w))), j = Math.min(img.h - 1, Math.max(0, Math.floor(v * img.h)))
    return Array.from(img.d.slice((j * img.w + i) * 4, (j * img.w + i) * 4 + 4))
  }
  const tap = (of: 'source' | 'screen', uv: readonly number[], level: readonly number[] | undefined, c: readonly number[]) => {
    taps.push({ texel, of, uv: [...uv], level: level![0]! }); return c.length === 4 ? [...c] : [...c, 1]
  }
  return {
    images, taps,
    setRenderTarget(t: RenderTarget | null) { target = t },
    getRenderTarget() { return target },
    render(scene: Object3D) {
      const m = (scene as Mesh).material as MeshBasicNodeMaterial, rt = target!, out: Image = { w: rt.width, h: 1, d: new Float64Array(rt.width * 4) }
      const sample = (tex: unknown, uv: readonly number[], level?: readonly number[]) => {
        if (tex === rects) return nearest({ w: rects.image.width, h: rects.image.height, d: Float64Array.from(rects.image.data as Float32Array) }, uv[0]!, uv[1]!)
        if (tex === source) return tap('source', uv, level, colour.fn(uv[0]!, uv[1]!, level![0]!))
        if (screen && tex === screen.texture) return tap('screen', uv, level, screen.fn(uv[0]!, uv[1]!, level![0]!))
        if ((tex as Texture).isRenderTargetTexture) return nearest(images.get(tex as Texture) ?? { w: 1, h: 1, d: new Float64Array(4) }, uv[0]!, uv[1]!)   // not drawn yet: zeros
        return tap('screen', uv, level, [0, 0, 0, 1])                    // the placeholder: no capture
      }
      for (texel = 0; texel < out.w; texel++) out.d.set(evalNode(m.colorNode as TSLNode<'vec4'>, { uv: [(texel + 0.5) / out.w, 0.5] }, undefined, undefined, sample), texel * 4)
      images.set(rt.texture, out)
    },
  }
}
/**
 * The 3 × 3 tap grid over `r` (cell centres) and the level a `W × H` texture is read at there: a texel of a sixth of the
 * short side, `max(log2(min(w·W, h·H) / 6), 0)` (floored at `floor`).
 */
function grid(r: LumaRect, W: number, H: number, floor = 0) {
  const uvs: number[][] = []
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) uvs.push([r.u + r.w * (i + 0.5) / 3, r.v + r.h * (j + 0.5) / 3])
  return { uvs, level: Math.max(Math.log2(Math.min(r.w * W, r.h * H) / 6), 0, floor) }
}
interface Level { w: number; h: number; d: Float32Array }
/** A coverage image (1 inside `[x0, x0 + w) × [y0, y0 + h)` px, row 0 at the top) and its 2 × 2 box-filtered mip chain, as a GPU builds it. */
function coverageMips(W: number, H: number, x0: number, y0: number, w: number, h: number): Level[] {
  const base = new Float32Array(W * H)
  for (let y = y0; y < y0 + h; y++) base.fill(1, y * W + x0, y * W + x0 + w)
  const levels: Level[] = [{ w: W, h: H, d: base }]
  for (let p = levels[0]!; p.w > 1 || p.h > 1; p = levels[levels.length - 1]!) {
    const w2 = Math.max(1, p.w >> 1), h2 = Math.max(1, p.h >> 1), d = new Float32Array(w2 * h2)
    const at = (x: number, y: number) => p.d[Math.min(p.h - 1, y) * p.w + Math.min(p.w - 1, x)]!
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) d[y * w2 + x] = (at(2 * x, 2 * y) + at(2 * x + 1, 2 * y) + at(2 * x, 2 * y + 1) + at(2 * x + 1, 2 * y + 1)) / 4
    levels.push({ w: w2, h: h2, d })
  }
  return levels
}
/** A trilinear (linear-mipmap-linear, clamp-to-edge) read of `levels` at (u, v), level `lod`: what the GPU's sampler returns. */
function trilinear(levels: Level[], u: number, v: number, lod: number): number {
  const bilinear = (l: Level) => {
    const x = u * l.w - 0.5, y = v * l.h - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0
    const at = (i: number, j: number) => l.d[Math.min(l.h - 1, Math.max(0, j)) * l.w + Math.min(l.w - 1, Math.max(0, i))]!
    return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
  }
  const l0 = Math.min(levels.length - 1, Math.floor(lod)), l1 = Math.min(levels.length - 1, l0 + 1), f = lod - Math.floor(lod)
  return bilinear(levels[l0]!) * (1 - f) + bilinear(levels[l1]!) * f
}
/** What the kernel computes for content rect `r` over an opaque `fn`: its grid and level, and the mean Rec. 709 luma. */
function expected(r: LumaRect, W: number, H: number, fn: Colour) {
  const g = grid(r, W, H)
  return { ...g, luma: g.uvs.reduce((s, [u, v]) => s + luma709(fn(u!, v!, g.level)), 0) / 9 }
}

describe('LumaPass kernel (run on the CPU through tsl-eval)', () => {
  const rects: LumaRect[] = [
    { u: 0.1, v: 0.2, w: 0.25, h: 0.5 },          // 128 × 128 source texels: level log2(128 / 6)
    { u: 0.5, v: 0.5, w: 0.2, h: 0.05 },          // 102.4 × 12.8, 8:1: by the short side, log2(12.8 / 6) (not the long side's 5.7)
    { u: 0.9, v: 0.05, w: 0.001, h: 0.002 },      // under 6 texels: level 0
  ].map(r => ({ u: Math.fround(r.u), v: Math.fround(r.v), w: Math.fround(r.w), h: Math.fround(r.h) }))   // as the float texture stores them
  const W = 512, H = 256
  const source = new RenderTarget(W, H).texture                         // a content RT's texture: its image carries the size
  const curved: Colour = (u, v) => [u * u, v * v, u * v]                // not linear: a single centre tap would not match

  it('averages a 3 × 3 grid over each element\'s rect at level log2(min(w·W, h·H) / 6), in Rec. 709 luminance', () => {
    const p = new LumaPass(4); p.setRects(rects)
    const colour = { fn: curved }, r = cpuRenderer(p.rectTexture, source, colour)
    p.render(r, source, 1 / 60)
    const out = r.images.get(p.texture)!
    rects.forEach((rect, i) => {
      const e = expected(rect, W, H, curved)
      const taps = r.taps.filter(t => t.texel === i && t.of === 'source')
      expect(taps).toHaveLength(9)
      taps.forEach((t, k) => { expect(t.uv[0]).toBeCloseTo(e.uvs[k]![0]!, 6); expect(t.uv[1]).toBeCloseTo(e.uvs[k]![1]!, 6); expect(t.level).toBeCloseTo(e.level, 6) })
      Array.from(out.d.slice(i * 4, i * 4 + 4)).forEach((x, c) => expect(x).toBeCloseTo(c < 3 ? e.luma : 1, 12))   // the first render writes through
    })
    expect(expected(rects[0]!, W, H, curved).level).toBeCloseTo(Math.log2(128 / 6), 6)
    expect(expected(rects[1]!, W, H, curved).level).toBeCloseTo(Math.log2(12.8 / 6), 5)
    expect(expected(rects[2]!, W, H, curved).level).toBe(0)
    const unused = r.taps.filter(t => t.texel === 3 && t.of === 'source')   // an unused texel (rect 0 × 0): level 0, never log2(0)
    expect(unused).toHaveLength(9); expect(unused.every(t => t.level === 0)).toBe(true)
  })
  it('a 9:1 pill over opaque white, transparent around it, measures white: every tap\'s footprint stays inside the rect', () => {
    // 756 × 84 px in a 1024 × 512 RT (the signup field's proportions), at offsets with different mip-grid alignments,
    // read through a real mip chain and trilinear filter: the outer taps sit a sixth of the short side from the edge
    const RW = 1024, RH = 512, pill = new RenderTarget(RW, RH).texture
    for (const [x0, y0] of [[101, 77], [13, 300], [200, 211], [64, 64]] as const) {
      const levels = coverageMips(RW, RH, x0, y0, 756, 84)
      const p = new LumaPass(1); p.setRects([{ u: x0 / RW, v: y0 / RH, w: 756 / RW, h: 84 / RH }])
      const r = cpuRenderer(p.rectTexture, pill, { fn: (u, v, lod) => { const a = trilinear(levels, u, v, lod); return [a, a, a, a] } })
      p.render(r, pill, 1 / 60)
      expect(r.taps.filter(t => t.of === 'source').every(t => Math.abs(t.level - Math.log2(84 / 6)) < 1e-4)).toBe(true)
      expect(r.images.get(p.texture)!.d[0]).toBeGreaterThan(0.95)
    }
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

describe('LumaPass kernel on a glass Surface: content over the frosted screen (CPU, tsl-eval)', () => {
  const whole: LumaRect = { u: 0, v: 0, w: 1, h: 1 }
  const screenAt: LumaRect = { u: 0.25, v: 0.125, w: 0.5, h: 0.25 }   // in a 1600 × 800 copy: 800 × 200 texels
  const source = new RenderTarget(64, 64).texture
  const capture = new FramebufferTexture(1600, 800)                    // what a ScreenCapture copies into
  const frosted = (c: readonly number[]) => c.map(x => x + (1 - x) * SLAB_BEHIND.lift)
  const S: readonly number[] = [0.9, 0.8, 0.7]                         // the screen behind the glass Surface
  const C: readonly number[] = [0.1, 0.3, 0.2]                         // the content's straight colour
  /** A fresh pass's first result (written through) for content of coverage `a` over the screen `S`. */
  function run(a: number, screen: Texture | null) {
    const p = new LumaPass(1); p.setRects([whole]); p.setScreenRects([screenAt])
    const r = cpuRenderer(p.rectTexture, source, { fn: () => [...C.map(x => x * a), a] }, { texture: capture, fn: () => S })
    p.render(r, source, 1 / 60, screen)
    return { luma: r.images.get(p.texture)!.d[0]!, taps: r.taps }
  }

  it('shares the slab\'s frost with the element glass', () => {
    expect(SLAB_BEHIND.level).toBeCloseTo(SLAB_FROST.roughness * 8, 12)
    expect(SLAB_BEHIND.lift).toBeCloseTo(SLAB_FROST.roughness * 0.08 + SLAB_FROST.lift, 12)
  })
  it('coverage 0: the frosted screen\'s luma; 1: the content\'s; ½: premultiplied content + ½ the frosted screen', () => {
    expect(run(0, capture).luma).toBeCloseTo(luma709(frosted(S)), 12)
    expect(run(1, capture).luma).toBeCloseTo(luma709(C), 12)
    expect(run(0.5, capture).luma).toBeCloseTo(luma709(C) * 0.5 + 0.5 * luma709(frosted(S)), 12)
  })
  it('without a capture copy yet the behind term is 0 (the content alone, as on a \'none\' Surface)', () => {
    expect(run(0, null).luma).toBeCloseTo(0, 12)
    expect(run(0.5, null).luma).toBeCloseTo(luma709(C) * 0.5, 12)
  })
  it('a 9:1 screen bbox over a white screen region, dark around it, under transparent content measures the frosted white', () => {
    const SW = 1024, SH = 512, levels = coverageMips(SW, SH, 101, 77, 756, 84), copy = new FramebufferTexture(SW, SH)
    const p = new LumaPass(1); p.setRects([whole]); p.setScreenRects([{ u: 101 / SW, v: 77 / SH, w: 756 / SW, h: 84 / SH }])
    const r = cpuRenderer(p.rectTexture, source, { fn: () => [0, 0, 0, 0] }, { texture: copy, fn: (u, v, lod) => { const a = trilinear(levels, u, v, lod); return [a, a, a] } })
    p.render(r, source, 1 / 60, copy)
    expect(r.taps.filter(t => t.of === 'screen').every(t => Math.abs(t.level - Math.log2(84 / 6)) < 1e-4)).toBe(true)   // above the frost floor
    expect(r.images.get(p.texture)!.d[0]).toBeGreaterThan(0.95)
  })
  it('reads the capture over a 3 × 3 grid of the screen rect, at its grid level but never finer than the slab\'s frost', () => {
    const screenTaps = run(0, capture).taps.filter(t => t.of === 'screen')
    const g = grid(screenAt, 1600, 800, SLAB_BEHIND.level)
    expect(g.level).toBeCloseTo(Math.log2(200 / 6), 12)                    // the short side, in capture px
    expect(screenTaps).toHaveLength(9)
    screenTaps.forEach((t, k) => { expect(t.uv[0]).toBeCloseTo(g.uvs[k]![0]!, 6); expect(t.uv[1]).toBeCloseTo(g.uvs[k]![1]!, 6); expect(t.level).toBeCloseTo(g.level, 6) })
    const p = new LumaPass(1); p.setRects([whole]); p.setScreenRects([{ u: 0.5, v: 0.5, w: 0.01, h: 0.02 }])   // 16 × 16 texels: under the frost
    const r = cpuRenderer(p.rectTexture, source, { fn: () => [0, 0, 0, 0] }, { texture: capture, fn: () => S })
    p.render(r, source, 1 / 60, capture)
    expect(r.taps.filter(t => t.of === 'screen').every(t => Math.abs(t.level - SLAB_BEHIND.level) < 1e-9)).toBe(true)
  })
  it('with no frost (a \'none\' Surface: no slab) the screen counts unlifted, at its grid level with no floor; the next render frosts again', () => {
    const small: LumaRect = { u: 0.5, v: 0.5, w: 0.01, h: 0.02 }       // 16 × 16 texels: under the slab's frost level
    const p = new LumaPass(1); p.setRects([whole]); p.setScreenRects([small])
    const r = cpuRenderer(p.rectTexture, source, { fn: () => [...C.map(x => x * 0.5), 0.5] }, { texture: capture, fn: () => S })
    p.render(r, source, 1 / 60, capture, { level: 0, lift: 0 })
    expect(r.images.get(p.texture)!.d[0]).toBeCloseTo(luma709(C) * 0.5 + 0.5 * luma709(S), 12)
    const level = grid({ ...small, w: Math.fround(small.w), h: Math.fround(small.h) }, 1600, 800).level
    expect(level).toBeLessThan(SLAB_BEHIND.level)
    expect(r.taps.filter(t => t.of === 'screen').every(t => Math.abs(t.level - level) < 1e-6)).toBe(true)
    const q = new LumaPass(1); q.setRects([whole]); q.setScreenRects([small])
    const r2 = cpuRenderer(q.rectTexture, source, { fn: () => [0, 0, 0, 0] }, { texture: capture, fn: () => S })
    q.render(r2, source, 1 / 60, capture, { level: 0, lift: 0 }); q.render(r2, source, 1 / 60, capture)   // the default again: the slab's
    const screenTaps = r2.taps.filter(t => t.of === 'screen')
    expect(screenTaps).toHaveLength(18)
    expect(screenTaps.slice(9).every(t => Math.abs(t.level - SLAB_BEHIND.level) < 1e-9)).toBe(true)
  })
  it('screen rects ride in row 1 and, unlike content rects, keep the smoothing when they change (the camera moved)', () => {
    const p = new LumaPass(2); p.setRects([whole]); p.setScreenRects([screenAt])
    expect(Array.from((p.rectTexture.image.data as Float32Array).slice(8, 12))).toEqual([0.25, 0.125, 0.5, 0.25])
    const r = cpuRenderer(p.rectTexture, source, { fn: () => [0, 0, 0, 0] }, { texture: capture, fn: () => [0, 0, 0] })
    p.render(r, source, 1 / 60, capture)                                  // the frosted black screen
    const first = luma709(frosted([0, 0, 0]))
    expect(r.images.get(p.texture)!.d[0]).toBeCloseTo(first, 12)
    const v = p.rectTexture.version
    p.setScreenRects([{ ...screenAt, u: 0.3 }])
    expect(p.rectTexture.version).toBeGreaterThan(v)
    p.setScreenRects([{ ...screenAt, u: 0.3 }])
    expect(p.rectTexture.version).toBe(v + 1)                             // unchanged: no re-upload
    const white = cpuRenderer(p.rectTexture, source, { fn: () => [0, 0, 0, 0] }, { texture: capture, fn: () => [1, 1, 1] })
    white.images.set(p.texture, r.images.get(p.texture)!)
    p.render(white, source, 0.1, capture)
    expect(white.images.get(p.texture)!.d[0]).toBeCloseTo(first + (1 - first) * (1 - Math.exp(-0.1 / LUMA_TAU)), 12)
    expect(() => p.setScreenRects([whole, whole, whole])).toThrow(/maxCount/)
  })
})

describe('LumaPass shaders (generated under Node)', () => {
  for (const forceWebGL of [false, true]) {
    it(`${forceWebGL ? 'GLSL' : 'WGSL'}: the kernel builds, with 9 taps of the source and 9 of the screen at explicit levels`, () => {
      const p = new LumaPass(8)
      let mesh: Mesh | null = null
      p.render({ setRenderTarget: vi.fn(), render: vi.fn((scene: Object3D) => { mesh = scene as Mesh }) }, new Texture(), 0)
      const m = mesh as unknown as Mesh
      const out = buildShaders(m.material as MeshBasicNodeMaterial, m.geometry, forceWebGL)
      // the source and the screen (linear, mipmapped; the screen placeholder is filterable as a capture copy is) sample
      // at their computed levels; the rect rows and the previous target (nearest) read level 0: loads in WGSL (a float32
      // texture is unfilterable there), textureLod at 0.0 in GLSL
      if (forceWebGL) {
        expect(out.fragment.match(/textureLod\s*\(/g)).toHaveLength(21)
        expect(out.fragment.match(/textureLod\s*\([^;]*,\s*0\.0\s*\)/g)).toHaveLength(3)
      } else {
        expect(out.fragment.match(/textureSampleLevel\s*\(/g)).toHaveLength(18)
        expect(out.fragment.match(/textureLoad\s*\(/g)).toHaveLength(3)
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
  const S = { width: 400, height: 200, ptPerUnit: 100 }
  const src = new Texture()
  /** One frame's inputs: `glass` on the 400 × 200 Surface `S`, the content `src`. */
  const at = (renderer: LumaFrame['renderer'], glass: LumaFrame['glass'], dt = 1 / 60, redrawn = true, over: Partial<LumaFrame> = {}): LumaFrame =>
    ({ renderer, glass, surface: S, content: src, dt, redrawn, ...over })

  it('packs every glass instance\'s rect in content uv (v = 0 at the top), in the glass batch\'s instance order', () => {
    const list = [glass('c', 3, { x: 200, y: 100, width: 100, height: 50 }), glass('a', 1, { x: 40, y: 20, width: 80, height: 40 }, { variant: 'regular' }), glass('b', 2, { x: 0, y: 150, width: 400, height: 50 })]
    const l = new SurfaceLuma()
    l.update(at(recording(), list))
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
    l.update(at(r, [glass('a', 1, { x: 0, y: 0, width: 10, height: 10 }, { variant: 'regular' }), glass('b', 2, { x: 0, y: 0, width: 10, height: 10 }, { adaptive: false })]))
    expect(r.render).not.toHaveBeenCalled(); expect(l.pass).toBeNull(); expect(m.setLuma).not.toHaveBeenCalled()
    l.update(at(r, [glass('a', 1, { x: 0, y: 0, width: 10, height: 10 })]))
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
    l.update(at(r, list, 0.25, true))
    for (let i = 0; i < 3; i++) l.update(at(r, list, 0.25, false))   // 0.25 … 0.75 s after the redraw
    expect(r.render).toHaveBeenCalledTimes(4)
    l.update(at(r, list, 0.25, false))                                 // 1 s: settled
    l.update(at(r, list, 0.25, false))
    expect(r.render).toHaveBeenCalledTimes(4)
    const textures = new Set(m.setLuma.mock.calls.map(c => c[0]))
    expect(textures.size).toBe(2)                                          // the ping-pong: each render's own target
    expect(m.setLuma).toHaveBeenCalledTimes(4)
    l.update(at(r, list, 0.25, true))                                  // a new redraw starts it again
    expect(r.render).toHaveBeenCalledTimes(5)
  })
  it('re-packs the rects only when the glass list or the Surface size changed', () => {
    const l = new SurfaceLuma(), r = recording(), list = [glass('a', 1, { x: 0, y: 0, width: 100, height: 100 })]
    l.update(at(r, list))
    const set = vi.spyOn(l.pass!, 'setRects')
    l.update(at(r, list))
    expect(set).not.toHaveBeenCalled()
    const rebuilt = [...list]                                             // a rebuilt render list
    l.update(at(r, rebuilt))
    expect(set).toHaveBeenCalledTimes(1)
    l.update(at(r, rebuilt, 1 / 60, true, { surface: { width: 200, height: 200, ptPerUnit: 100 } }))  // the same list on a resized Surface
    expect(set).toHaveBeenCalledTimes(2)
    expect(Array.from((l.pass!.rectTexture.image.data as Float32Array).slice(0, 4))).toEqual([0, 0, 0.5, 0.5])
  })
  it('grows past maxCount by doubling: a new pass, the old one freed, the element glass re-pointed', () => {
    const l = new SurfaceLuma(2), m = fakeMaterial(), r = recording()
    l.attach([m])
    const few = [glass('a', 1, { x: 0, y: 0, width: 10, height: 10 })]
    l.update(at(r, few))
    const old = l.pass!
    expect(old.maxCount).toBe(2)
    const freed = vi.fn(); old.rectTexture.addEventListener('dispose', freed)
    const many = Array.from({ length: 5 }, (_, i) => glass(`g${i}`, i, { x: i * 10, y: 0, width: 10, height: 10 }))
    l.update(at(r, many))
    expect(l.pass).not.toBe(old); expect(l.pass!.maxCount).toBe(8); expect(l.pass!.count).toBe(5)
    expect(freed).toHaveBeenCalled()
    expect(m.setLuma).toHaveBeenLastCalledWith(l.pass!.texture, 8)
  })
  it('with a glass Surface\'s view it runs every frame, packs the projected screen rects and reads the capture\'s latest copy', () => {
    const l = new SurfaceLuma(), r = recording(), list = [glass('a', 1, { x: 100, y: 50, width: 100, height: 50 })]
    const camera = new OrthographicCamera(-2, 2, 2, -2, 0.1, 10); camera.position.z = 5; camera.updateMatrixWorld()
    const plane = new Object3D(); plane.updateMatrixWorld()
    const capture = { latest: null as Texture | null } as unknown as ScreenCapture
    const behind = { capture, camera, plane }
    l.update(at(r, list, 0.25, true, { behind }))
    const render = vi.spyOn(l.pass!, 'render')
    for (let i = 0; i < 8; i++) l.update(at(r, list, 0.25, false, { behind }))   // 2 s of quiet frames
    expect(r.render).toHaveBeenCalledTimes(9)
    expect(render.mock.calls.every(c => c[3] === null)).toBe(true)        // no copy yet: no behind term
    const row1 = (e: number[]) => Array.from((l.pass!.rectTexture.image.data as Float32Array).slice(256 * 4, 256 * 4 + 4)).forEach((x, k) => expect(x).toBeCloseTo(e[k]!, 6))
    row1([0.25, 0.375, 0.25, 0.125])                                       // local x −1…0, y 0…0.5 over a 4 × 4 view: NDC = local / 2
    capture.latest = new FramebufferTexture(8, 8)
    l.update(at(r, list, 0.25, false, { behind }))
    expect(render).toHaveBeenLastCalledWith(r, src, 0.25, capture.latest, SLAB_BEHIND)   // by default, through the slab's frost
    plane.rotation.z = Math.PI / 2; plane.updateMatrixWorld()              // (x, y) → (−y, x): the bbox follows every frame
    l.update(at(r, list, 0.25, false, { behind }))
    row1([0.375, 0.5, 0.125, 0.25])
    const clear = { level: 0, lift: 0 }                                   // a 'none' Surface's view: no slab, no frost
    l.update(at(r, list, 0.25, false, { behind: { ...behind, frost: clear } }))
    expect(render).toHaveBeenLastCalledWith(r, src, 0.25, capture.latest, clear)
  })
  it('screenRect: the bbox of the rect\'s corners projected through the plane and the camera, v = 0 at the top, clamped', () => {
    const S2 = { width: 400, height: 200, ptPerUnit: 100 }, rect = { x: 100, y: 50, width: 100, height: 50 }
    const camera = new PerspectiveCamera(90, 1, 0.1, 10); camera.position.z = 2; camera.updateMatrixWorld()
    const plane = new Object3D(); plane.position.z = -2; plane.updateMatrixWorld()   // 4 units away: NDC = local / 4
    const r = screenRect(rect, S2, { camera, plane })
    for (const [k, v] of [['u', 0.375], ['v', 0.4375], ['w', 0.125], ['h', 0.0625]] as const) expect(r[k]).toBeCloseTo(v, 9)
    plane.position.z = 1.5; plane.updateMatrixWorld()                       // ½ unit away: NDC = local · 2, partly off screen
    const c = screenRect({ x: 0, y: 0, width: 200, height: 100 }, S2, { camera, plane })   // local x −2…0, y 0…1
    for (const [k, v] of [['u', 0], ['v', 0], ['w', 0.5], ['h', 0.5]] as const) expect(c[k]).toBeCloseTo(v, 9)
  })
  it('screenRect: a rect through the camera plane stays finite and in the viewport; one wholly behind it is a zero rect', () => {
    const S2 = { width: 400, height: 200, ptPerUnit: 100 }
    const camera = new PerspectiveCamera(90, 1, 0.1, 10); camera.position.z = 2; camera.updateMatrixWorld()
    // the plane lies flat ½ unit above the eye, its local +y running away from the camera: local y = 1 → z = 1, y = −1 → z = 3
    const plane = new Object3D(); plane.position.set(0, 0.5, 2); plane.rotation.x = -Math.PI / 2; plane.updateMatrixWorld()
    const inside = (r: LumaRect) => [r.u, r.v, r.w, r.h].every(Number.isFinite) && r.u >= 0 && r.v >= 0 && r.u + r.w <= 1 && r.v + r.h <= 1
    const ahead = screenRect({ x: 0, y: 0, width: 400, height: 50 }, S2, { camera, plane })      // z 1 … 1.5: in front
    const through = screenRect({ x: 0, y: 50, width: 400, height: 100 }, S2, { camera, plane })  // z 1.5 … 2.5: through the eye's plane
    const behind = screenRect({ x: 100, y: 150, width: 100, height: 50 }, S2, { camera, plane }) // z 2.5 … 3: behind
    expect(inside(ahead) && inside(through)).toBe(true)
    expect(through.v).toBe(0); expect(through.w).toBe(1)        // toward the eye it runs off the top and both sides
    expect(behind).toEqual({ u: 0, v: 0, w: 0, h: 0 })
  })
  it('the rect texture never holds a non-finite number: one is packed as 0', () => {
    const p = new LumaPass(4)
    p.setRects([{ u: NaN, v: 0.25, w: Infinity, h: 0.5 }])
    p.setScreenRects([{ u: 0.5, v: -Infinity, w: NaN, h: 0.25 }])
    const data = p.rectTexture.image.data as Float32Array
    expect(Array.from(data.slice(0, 4))).toEqual([0, 0.25, 0, 0.5])
    expect(Array.from(data.slice(16, 20))).toEqual([0.5, 0, 0, 0.25])
  })
  it('dispose frees the pass', () => {
    const l = new SurfaceLuma(), r = recording()
    l.update(at(r, [glass('a', 1, { x: 0, y: 0, width: 10, height: 10 })]))
    const freed = vi.fn(); l.pass!.rectTexture.addEventListener('dispose', freed)
    l.dispose()
    expect(freed).toHaveBeenCalled(); expect(l.pass).toBeNull()
  })
})
