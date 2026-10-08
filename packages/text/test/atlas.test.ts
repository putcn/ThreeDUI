import { describe, it, expect } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { AtlasManager } from '../src/atlas'
import type { CanvasCtxLike, CanvasFactory } from '../src/types'

const factory: CanvasFactory = (w, h) => createCanvas(w, h) as never

/** Draws an "M" so the slot has visible pixels. */
const ink = (ctx: CanvasCtxLike, x: number, y: number) => {
  ctx.font = '28px sans-serif'; ctx.textBaseline = 'top'; ctx.fillStyle = '#fff'; ctx.fillText('M', x + 2, y + 2)
}
const hasInk = (ctx: CanvasCtxLike, x: number, y: number, w: number, h: number) => ctx.getImageData(x, y, w, h).data.some(v => v > 0)

describe('AtlasManager', () => {
  it('packs slots on shelves and returns cached slots by key', () => {
    const a = new AtlasManager({ pageSize: 64, createCanvas: factory })
    const s1 = a.allocate('a', 20, 10, () => {})
    const s2 = a.allocate('b', 20, 10, () => {})
    const s3 = a.allocate('c', 30, 12, () => {})   // does not fit on shelf 1 (64 - 40 = 24 < 30) → new shelf
    expect(s1).toMatchObject({ page: 0, x: 0, y: 0 }); expect(s2).toMatchObject({ page: 0, x: 20, y: 0 }); expect(s3).toMatchObject({ page: 0, x: 0, y: 10 })
    expect(a.get('b')).toBe(s2)
    expect(a.dirtyPages.has(0)).toBe(true)
  })
  it('allocate returns a cached slot without redrawing; clearDirty empties the upload set', () => {
    const a = new AtlasManager({ pageSize: 64, createCanvas: factory })
    const s = a.allocate('a', 10, 10, () => {})
    expect(a.allocate('a', 10, 10, () => { throw new Error('redrawn') })).toBe(s)
    a.clearDirty()
    expect(a.dirtyPages.size).toBe(0)
  })
  it('opens new pages and evicts the least recently used one when full', () => {
    const a = new AtlasManager({ pageSize: 32, maxPages: 2, createCanvas: factory })
    a.allocate('p0', 32, 32, () => {})
    a.allocate('p1', 32, 32, () => {})
    a.get('p0')                              // touch page 0 → page 1 is now LRU
    const s = a.allocate('p2', 32, 32, () => {})
    expect(s.page).toBe(1)
    expect(a.get('p1')).toBeUndefined()
    expect(a.get('p0')).toBeDefined()
  })
  it('clears an evicted page before reuse, leaves the others intact and marks only it dirty', () => {
    const a = new AtlasManager({ pageSize: 32, maxPages: 2, createCanvas: factory })
    a.allocate('p0', 32, 32, ink)
    a.allocate('p1', 32, 32, ink)
    a.clearDirty()
    let stale: boolean | null = null
    const s = a.allocate('p2', 32, 32, (ctx, x, y) => { stale = hasInk(ctx, x, y, 32, 32) })   // page 0 is LRU
    expect(s.page).toBe(0)
    expect(stale).toBe(false)
    expect(hasInk(a.pages[1]!.getContext('2d'), 0, 0, 32, 32)).toBe(true)
    expect([...a.dirtyPages]).toEqual([0])
  })
  it('invokes the draw callback at the slot origin', () => {
    const a = new AtlasManager({ pageSize: 64, createCanvas: factory })
    let at: [number, number] | null = null
    a.allocate('x', 10, 10, (_ctx, x, y) => { at = [x, y] })
    a.allocate('y', 10, 10, (_ctx, x, y) => { at = [x, y] })
    expect(at).toEqual([10, 0])
  })
  it('throws when a glyph is larger than a page', () => {
    const a = new AtlasManager({ pageSize: 16, createCanvas: factory })
    expect(() => a.allocate('big', 20, 5, () => {})).toThrow(/page/)
  })
  it('rejects non-finite or negative glyph sizes and invalid options', () => {
    const a = new AtlasManager({ pageSize: 16, createCanvas: factory })
    expect(() => a.allocate('nan', NaN, 5, () => {})).toThrow(/invalid glyph size/)
    expect(() => a.allocate('neg', -1, 5, () => {})).toThrow(/invalid glyph size/)
    expect(a.get('neg')).toBeUndefined()
    expect(() => new AtlasManager({ pageSize: 0, createCanvas: factory })).toThrow(/pageSize/)
    expect(() => new AtlasManager({ pageSize: 10.5, createCanvas: factory })).toThrow(/pageSize/)
    expect(() => new AtlasManager({ maxPages: 0, createCanvas: factory })).toThrow(/maxPages/)
  })
})
