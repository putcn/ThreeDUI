import { describe, it, expect, vi } from 'vitest'
import { HalfFloatType, NoBlending, Texture, UnsignedByteType, type Mesh, type Object3D, type RenderTarget } from 'three'
import type { MeshBasicNodeMaterial, Node } from 'three/webgpu'
import { vec4 } from 'three/tsl'
import { GlassUIError } from '@glassui/core'
import { KawasePyramid } from '../src/blur/kawase'
import { evalNode } from './fixtures/tsl-eval'
import { buildShaders } from './fixtures/build-shaders'

interface Image { w: number; h: number; d: Float64Array }   // RGBA per texel, row 0 at v ≈ 0
/** Bilinear, clamp to edge, texel centres at (i + ½)/w: what the passes' linear samplers do. */
function bilinear(img: Image, u: number, v: number): number[] {
  const x = u * img.w - 0.5, y = v * img.h - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0
  const at = (i: number, j: number, c: number) => img.d[(Math.min(img.h - 1, Math.max(0, j)) * img.w + Math.min(img.w - 1, Math.max(0, i))) * 4 + c]!
  return [0, 1, 2, 3].map(c => (at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx) * (1 - fy) + (at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx) * fy)
}
/** A CPU stand-in for the GPU: runs each pass's kernel (its colour and opacity nodes) per target texel with tsl-eval. */
function cpuRenderer(images: Map<Texture, Image>) {
  let target: RenderTarget | null = null
  return {
    setRenderTarget(t: RenderTarget | null) { target = t },
    getRenderTarget() { return target },
    render(scene: Object3D) {
      const m = (scene as Mesh).material as MeshBasicNodeMaterial, rt = target!, out = { w: rt.width, h: rt.height, d: new Float64Array(rt.width * rt.height * 4) }
      const kernel = vec4(m.colorNode as Node<'vec3'>, m.opacityNode as Node<'float'>)
      const sample = (tex: unknown, uv: readonly number[], level?: readonly number[]) => {
        expect(level).toEqual([0])   // the source's own texels, never its mips
        return bilinear(images.get(tex as Texture)!, uv[0]!, uv[1]!)
      }
      for (let y = 0; y < out.h; y++) for (let x = 0; x < out.w; x++) {
        out.d.set(evalNode(kernel, { uv: [(x + 0.5) / out.w, (y + 0.5) / out.h] }, undefined, undefined, sample), (y * out.w + x) * 4)
      }
      images.set(rt.texture, out)
    },
  }
}
/** RMS radius (source texels) of `img` magnified back to `n × n` around texel (c, c): the blur's width. */
function spread(img: Image, n: number, c: number): number {
  let sum = 0, m2 = 0
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const v = bilinear(img, (x + 0.5) / n, (y + 0.5) / n)[0]!
    sum += v; m2 += v * ((x - c) ** 2 + (y - c) ** 2)
  }
  return Math.sqrt(m2 / sum)
}

describe('KawasePyramid', () => {
  it('halves each level and never reaches 0', () => {
    const p = new KawasePyramid(4)
    p.resize(300, 100)
    expect(p.levels.map(l => [l.width, l.height])).toEqual([[150, 50], [75, 25], [38, 13], [19, 7]])
    p.resize(1, 1)
    expect(p.levels.every(l => l.width === 1 && l.height === 1)).toBe(true)
  })
  it('refuses a level count below 1', () => {
    expect(() => new KawasePyramid(0)).toThrow(GlassUIError)
    expect(() => new KawasePyramid(2.5)).toThrow(/层数/)
  })
  it('renders down to one level past the last, then up finest first (2·levels + 1 passes), restoring the target', () => {
    const p = new KawasePyramid(3); p.resize(64, 64)
    const targets: (RenderTarget | null)[] = []
    const renderer = { setRenderTarget: vi.fn((t: RenderTarget | null) => targets.push(t)), render: vi.fn() }
    p.render(renderer, new Texture())
    expect(renderer.render).toHaveBeenCalledTimes(7)
    const [l0, l1, l2] = p.levels
    expect(targets.slice(0, 3)).toEqual([l0, l1, l2])
    const extra = targets[3]!
    expect([extra.width, extra.height]).toEqual([4, 4])             // ⌈64/16⌉: the last level's down-sample
    expect(p.levels).not.toContain(extra)
    expect(targets.slice(4, 7)).toEqual([l0, l1, l2])               // each from the next one's down-sample, before it is overwritten
    expect(targets[targets.length - 1]).toBeNull()
    expect(p.textures).toEqual(p.levels.map(l => l.texture))
  })
  it('restores the previous render target, even when a pass throws', () => {
    const p = new KawasePyramid(2); p.resize(16, 16)
    const prev = { isRenderTarget: true } as unknown as RenderTarget
    const set = vi.fn()
    p.render({ setRenderTarget: set, getRenderTarget: () => prev, render: vi.fn() }, new Texture())
    expect(set).toHaveBeenLastCalledWith(prev)
    const failing = { setRenderTarget: vi.fn(), getRenderTarget: () => prev, render: vi.fn(() => { throw new Error('backend not initialised') }) }
    expect(() => p.render(failing, new Texture())).toThrow(/backend/)
    expect(failing.setRenderTarget).toHaveBeenLastCalledWith(prev)
  })
  it('levels are graded: each about twice as wide a blur as the one before; alpha blurs as the colour does', () => {
    const n = 128, c = 64
    const source = new Texture(), d = new Float64Array(n * n * 4)
    d.fill(1, (c * n + c) * 4, (c * n + c) * 4 + 4)                 // a premultiplied white impulse
    const images = new Map<Texture, Image>([[source, { w: n, h: n, d }]])
    const p = new KawasePyramid(3); p.resize(n, n)
    p.render(cpuRenderer(images), source)
    const widths = p.textures.map(t => spread(images.get(t)!, n, c))
    expect(widths[0]).toBeGreaterThan(4); expect(widths[0]).toBeLessThan(6.5)
    for (let i = 1; i < widths.length; i++) {
      expect(widths[i]! / widths[i - 1]!).toBeGreaterThan(1.7); expect(widths[i]! / widths[i - 1]!).toBeLessThan(2.3)
    }
    for (const t of p.textures) {
      const img = images.get(t)!
      for (let i = 0; i < img.w * img.h; i++) expect(img.d[i * 4 + 3]).toBeCloseTo(img.d[i * 4]!, 12)
    }
  })
  it('keeps a flat input flat in every channel (the kernels\' weights sum to 1)', () => {
    const source = new Texture(), d = new Float64Array(20 * 12 * 4)
    for (let i = 0; i < 20 * 12; i++) d.set([0.2, 0.4, 0.6, 0.8], i * 4)
    const images = new Map<Texture, Image>([[source, { w: 20, h: 12, d }]])
    const p = new KawasePyramid(2); p.resize(20, 12)
    p.render(cpuRenderer(images), source)
    for (const t of p.textures) {
      const img = images.get(t)!
      for (let i = 0; i < img.w * img.h; i++) [0.2, 0.4, 0.6, 0.8].forEach((v, ch) => expect(img.d[i * 4 + ch]).toBeCloseTo(v, 12))
    }
  })
  it('writes colour and alpha straight (no blending, depth or tone mapping)', () => {
    const p = new KawasePyramid(1); p.resize(8, 8)
    const materials = new Set<MeshBasicNodeMaterial>()
    p.render({ setRenderTarget: vi.fn(), render: vi.fn((scene: Object3D) => { materials.add((scene as Mesh).material as MeshBasicNodeMaterial) }) }, new Texture())
    expect(materials.size).toBe(2)
    for (const m of materials) {
      expect(m.blending).toBe(NoBlending); expect(m.transparent).toBe(false)
      expect(m.depthTest).toBe(false); expect(m.depthWrite).toBe(false); expect(m.toneMapped).toBe(false)
      expect(m.colorNode).toBeTruthy(); expect(m.opacityNode).toBeTruthy()
    }
  })
  it('setType switches every target\'s texel type in place, keeping the texture objects', () => {
    const p = new KawasePyramid(2, 'half'); p.resize(32, 32)
    expect(p.levels.every(l => l.texture.type === HalfFloatType)).toBe(true)
    const textures = p.textures
    const freed: unknown[] = []
    for (const l of p.levels) l.addEventListener('dispose', () => freed.push(l))
    expect(p.setType('half')).toBe(false); expect(freed).toHaveLength(0)
    expect(p.setType('byte')).toBe(true)
    expect(p.textures).toEqual(textures)
    expect(p.levels.every(l => l.texture.type === UnsignedByteType)).toBe(true)
    expect(freed).toEqual(p.levels)                                  // re-allocated, in the new type, at the next render
  })
  it('dispose frees every target and both pass materials', () => {
    const p = new KawasePyramid(2); p.resize(32, 32)
    const targets = new Set<RenderTarget>(), materials = new Set<MeshBasicNodeMaterial>()
    p.render({ setRenderTarget: (t: RenderTarget | null) => { if (t) targets.add(t) }, render: (scene: Object3D) => { materials.add((scene as Mesh).material as MeshBasicNodeMaterial) } }, new Texture())
    const freed = new Set<unknown>()
    for (const o of [...targets, ...materials]) o.addEventListener('dispose', () => freed.add(o))
    p.dispose()
    expect(freed).toEqual(new Set([...targets, ...materials]))
    expect(targets.size).toBe(3)
  })
})

describe('Kawase pass shaders (generated under Node)', () => {
  for (const forceWebGL of [false, true]) {
    it(`${forceWebGL ? 'GLSL' : 'WGSL'}: the down and up kernels build`, () => {
      const p = new KawasePyramid(1); p.resize(8, 8)
      const meshes: Mesh[] = []
      p.render({ setRenderTarget: vi.fn(), render: vi.fn((scene: Object3D) => { meshes.push(scene as Mesh) }) }, new Texture())
      const [down, up] = new Set(meshes)                              // two downs (to the level, then one past it), then the up
      expect(meshes).toEqual([down, down, up])
      for (const [mesh, taps] of [[down!, 5], [up!, 8]] as const) {
        const out = buildShaders(mesh.material as MeshBasicNodeMaterial, mesh.geometry, forceWebGL)
        expect(out.fragment.match(forceWebGL ? /textureLod\s*\(/g : /textureSampleLevel\s*\(/g)).toHaveLength(taps)
      }
    })
  }
})
