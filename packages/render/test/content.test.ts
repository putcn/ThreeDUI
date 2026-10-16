import { describe, it, expect, vi } from 'vitest'
import { Color, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, LinearSRGBColorSpace, RenderTarget, UnsignedByteType, Vector3 } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { contentRTSize, ContentPass, rtTarget, RT_SETTLE_FRAMES, type RendererLike } from '../src/surface/content'

// Type-level guard (checked by `pnpm typecheck`): the real renderer satisfies the stub-able subset.
export const asRendererLike = (r: WebGPURenderer): RendererLike => r

describe('contentRTSize', () => {
  it('steps up to a multiple of 64 and clamps', () => {
    expect(contentRTSize({ width: 100, height: 50 }, 2)).toEqual({ width: 256, height: 128 })
    expect(contentRTSize({ width: 100, height: 50 }, 1, { step: 1 })).toEqual({ width: 100, height: 50 })
    expect(contentRTSize({ width: 10000, height: 10 }, 1)).toEqual({ width: 4096, height: 64 })
    expect(contentRTSize({ width: 0, height: -5 }, 2)).toEqual({ width: 1, height: 1 })
    expect(contentRTSize({ width: NaN, height: 10 }, 2)).toEqual({ width: 1, height: 64 })
    expect(contentRTSize({ width: 100, height: 100 }, 2, { scale: 0.5 })).toEqual({ width: 128, height: 128 })
  })
})

describe('rtTarget', () => {
  const sz = (width: number, height: number) => ({ width, height })
  const moving = { settled: false, fresh: false }
  it('a fresh RT takes exactly what is needed', () => expect(rtTarget(sz(1, 1), sz(640, 384), { settled: false, fresh: true })).toEqual(sz(640, 384)))
  it('grows with 25 % headroom on the 64 step, per axis', () => {
    expect(rtTarget(sz(640, 384), sz(704, 384), moving)).toEqual(sz(896, 384))   // ceil(704 × 1.25 / 64) × 64
    expect(rtTarget(sz(896, 384), sz(832, 384), moving)).toEqual(sz(896, 384))   // within the headroom: kept
  })
  it('shrinks only once settled', () => {
    expect(rtTarget(sz(896, 384), sz(640, 320), moving)).toEqual(sz(896, 384))
    expect(rtTarget(sz(896, 384), sz(640, 320), { settled: true, fresh: false })).toEqual(sz(640, 320))
  })
  it('never passes the cap', () => expect(rtTarget(sz(3840, 64), sz(4000, 64), moving).width).toBe(4096))
  it('settles after 30 still frames', () => expect(RT_SETTLE_FRAMES).toBe(30))
})

describe('ContentPass', () => {
  it('allocates the target with mipmaps and resizes only on change', () => {
    const p = new ContentPass()
    expect(p.target.texture.generateMipmaps).toBe(true); expect(p.target.texture.type).toBe(UnsignedByteType)
    expect(p.texture).toBe(p.target.texture)
    expect(p.texture.minFilter).toBe(LinearMipmapLinearFilter); expect(p.texture.magFilter).toBe(LinearFilter)
    expect(p.texture.colorSpace).toBe(LinearSRGBColorSpace)
    expect([p.width, p.height]).toEqual([1, 1])
    expect(p.resize(256, 128)).toBe(true); expect(p.resize(256, 128)).toBe(false)
    expect(p.target.width).toBe(256); expect([p.width, p.height]).toEqual([256, 128])
    expect(new ContentPass({ type: 'half' }).target.texture.type).toBe(HalfFloatType)
  })
  it('switches the texel type in place, re-allocating the target only on a change', () => {
    const p = new ContentPass()
    const tex = p.texture
    let freed = 0
    p.target.addEventListener('dispose', () => { freed++ })
    expect(p.setType('byte')).toBe(false); expect(freed).toBe(0)
    expect(p.setType('half')).toBe(true)
    expect(p.texture).toBe(tex); expect(tex.type).toBe(HalfFloatType); expect(freed).toBe(1)   // same texture: materials keep sampling it
    expect(p.setType('byte')).toBe(true); expect(tex.type).toBe(UnsignedByteType); expect(freed).toBe(2)
  })
  it('sets the ortho view to the surface rect in units', () => {
    const p = new ContentPass()
    p.setView({ width: 400, height: 300, ptPerUnit: 100 })
    expect(p.camera.left).toBe(-2); expect(p.camera.right).toBe(2); expect(p.camera.top).toBe(1.5); expect(p.camera.bottom).toBe(-1.5)
    expect(p.camera.position.z).toBe(0); expect(p.camera.near).toBe(-6); expect(p.camera.far).toBe(6)   // ±(hypot(4, 3) + 1)
  })
  it('keeps content tilted out of the plane inside the depth range at 1 pt per unit (a screen Surface)', () => {
    const p = new ContentPass()
    p.setView({ width: 885, height: 1045, ptPerUnit: 1 })
    p.camera.updateMatrixWorld()
    // a 760-wide pool under glass tilted 0.05 rad: its ends leave the plane by ±19 units, beyond a fixed ±10
    for (const z of [-19, 19]) {
      const ndc = new Vector3(380, 0, z).project(p.camera)
      expect(Math.abs(ndc.z)).toBeLessThan(1)
    }
  })
  it('renders into the target and restores the default target and clear colour', () => {
    const p = new ContentPass()
    const calls: string[] = []
    const renderer = {
      setRenderTarget: vi.fn((rt: unknown) => calls.push(rt ? 'rt' : 'null')),
      render: vi.fn(() => calls.push('render')),
      setClearColor: vi.fn(), getClearColor: vi.fn((t: Color) => t.setRGB(0.2, 0.3, 0.4)), getClearAlpha: vi.fn(() => 1),
    }
    p.render(renderer, { color: new Color().setRGB(1, 0, 0), alpha: 0 })
    expect(calls).toEqual(['rt', 'render', 'null'])
    expect(renderer.setRenderTarget).toHaveBeenNthCalledWith(1, p.target)
    expect(renderer.render).toHaveBeenCalledWith(p.scene, p.camera)
    expect(renderer.setClearColor).toHaveBeenNthCalledWith(1, expect.objectContaining({ r: 1 }), 0)
    expect(renderer.setClearColor).toHaveBeenLastCalledWith(expect.objectContaining({ r: 0.2 }), 1)
  })
  it('restores the target and clear colour when rendering throws, and rethrows', () => {
    const p = new ContentPass()
    const renderer = {
      setRenderTarget: vi.fn(), render: vi.fn(() => { throw new Error('backend not initialised') }),
      setClearColor: vi.fn(), getClearColor: vi.fn((t: Color) => t.setRGB(0.2, 0.3, 0.4)), getClearAlpha: vi.fn(() => 1),
    }
    expect(() => p.render(renderer, { color: new Color(0, 0, 0), alpha: 0 })).toThrow('backend not initialised')
    expect(renderer.setRenderTarget.mock.calls).toEqual([[p.target], [null]])
    expect(renderer.setClearColor).toHaveBeenLastCalledWith(expect.objectContaining({ r: 0.2 }), 1)
  })
  it('clears its target whatever the host\'s autoClear, and restores the host\'s flags (also when rendering throws)', () => {
    const p = new ContentPass()
    const seen: [boolean | undefined, boolean | undefined][] = []
    const renderer = {
      autoClear: false, autoClearColor: false,
      setRenderTarget: vi.fn(), render: vi.fn(() => { seen.push([renderer.autoClear, renderer.autoClearColor]) }),
    }
    p.render(renderer, { color: new Color(0, 0, 0), alpha: 0 })
    expect(seen).toEqual([[true, true]])                       // three clears a target only with autoClear (and autoClearColor)
    expect([renderer.autoClear, renderer.autoClearColor]).toEqual([false, false])
    renderer.render.mockImplementation(() => { throw new Error('lost device') })
    expect(() => p.render(renderer, { color: new Color(0, 0, 0), alpha: 0 })).toThrow('lost device')
    expect([renderer.autoClear, renderer.autoClearColor]).toEqual([false, false])
    // a renderer without the flags (a stub) is left without them
    const bare: { setRenderTarget(): void; render(): void; autoClear?: boolean } = { setRenderTarget: vi.fn(), render: vi.fn() }
    p.render(bare, { color: new Color(0, 0, 0), alpha: 0 })
    expect('autoClear' in bare).toBe(false)
  })
  it('restores the previously bound target rather than the canvas', () => {
    const p = new ContentPass()
    const prev = new RenderTarget(8, 8)
    const renderer = { setRenderTarget: vi.fn(), render: vi.fn(), getRenderTarget: vi.fn(() => prev) }
    p.render(renderer, { color: new Color(0, 0, 0), alpha: 0 })
    expect(renderer.setRenderTarget.mock.calls).toEqual([[p.target], [prev]])
  })
})
