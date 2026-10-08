import { describe, it, expect, vi } from 'vitest'
import { Color, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, LinearSRGBColorSpace, RenderTarget, UnsignedByteType } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { contentRTSize, ContentPass, type RendererLike } from '../src/surface/content'

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

describe('ContentPass', () => {
  it('allocates the target with mipmaps and resizes only on change', () => {
    const p = new ContentPass()
    expect(p.target.texture.generateMipmaps).toBe(true); expect(p.target.texture.type).toBe(UnsignedByteType)
    expect(p.texture).toBe(p.target.texture)
    expect(p.texture.minFilter).toBe(LinearMipmapLinearFilter); expect(p.texture.magFilter).toBe(LinearFilter)
    expect(p.texture.colorSpace).toBe(LinearSRGBColorSpace)
    expect(p.resize(256, 128)).toBe(true); expect(p.resize(256, 128)).toBe(false)
    expect(p.target.width).toBe(256)
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
    expect(p.camera.near).toBe(-10); expect(p.camera.far).toBe(10); expect(p.camera.position.z).toBe(5)
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
  it('restores the previously bound target rather than the canvas', () => {
    const p = new ContentPass()
    const prev = new RenderTarget(8, 8)
    const renderer = { setRenderTarget: vi.fn(), render: vi.fn(), getRenderTarget: vi.fn(() => prev) }
    p.render(renderer, { color: new Color(0, 0, 0), alpha: 0 })
    expect(renderer.setRenderTarget.mock.calls).toEqual([[p.target], [prev]])
  })
})
