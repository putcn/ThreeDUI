import { describe, it, expect, vi } from 'vitest'
import { QualityController, QUALITY, defaultTier, type QualityTier } from '../src/quality'

describe('QUALITY tiers', () => {
  it('follow the spec table', () => {
    expect(QUALITY.high).toMatchObject({ contentType: 'half', contentScale: 1, backFaces: true, shadowMap: 2048, blur: 'kawase', refraction: true, dispersion: 'always' })
    expect(QUALITY.medium).toMatchObject({ contentType: 'byte', contentScale: 0.5, shadowMap: 1024, blur: 'mip', dispersion: 'auto' })
    expect(QUALITY.low).toMatchObject({ contentScale: 0.25, refraction: false })
    expect(QUALITY.minimal.refraction).toBe(false)
  })
  it('each profile names its own tier and is frozen (every root shares the table)', () => {
    for (const t of ['high', 'medium', 'low', 'minimal'] as const) { expect(QUALITY[t].tier).toBe(t); expect(Object.isFrozen(QUALITY[t])).toBe(true) }
  })
})

describe('QualityController', () => {
  const slow = (q: QualityController, n = 30) => { let t: string | null = null; for (let i = 0; i < n; i++) t = q.sample(25) ?? t; return t }
  const fast = (q: QualityController, n = 30) => { let t: string | null = null; for (let i = 0; i < n; i++) t = q.sample(5) ?? t; return t }
  it('steps down after two slow windows, not one', () => {
    const q = new QualityController({ initial: 'high' })
    expect(slow(q)).toBeNull(); expect(q.tier).toBe('high')
    expect(slow(q)).toBe('medium'); expect(q.tier).toBe('medium')
  })
  it('steps up after five fast windows, never above the cap', () => {
    const q = new QualityController({ initial: 'medium', cap: 'medium' })
    slow(q); slow(q); expect(q.tier).toBe('low')
    for (let i = 0; i < 4; i++) expect(fast(q)).toBeNull()
    expect(fast(q)).toBe('medium')
    for (let i = 0; i < 10; i++) fast(q)
    expect(q.tier).toBe('medium')
  })
  it('reduced transparency pins minimal and notifies', () => {
    const q = new QualityController({ initial: 'high' })
    const fn = vi.fn(); q.onChange(fn)
    q.setReducedTransparency(true)
    expect(q.tier).toBe('minimal'); expect(fn).toHaveBeenCalledWith('minimal', 'high')
    for (let i = 0; i < 10; i++) fast(q)
    expect(q.tier).toBe('minimal')
    q.setReducedTransparency(false)
    expect(q.tier).toBe('high')
  })
  it('defaultTier', () => {
    expect(defaultTier({ touch: false, reducedTransparency: false })).toBe('high')
    expect(defaultTier({ touch: true, reducedTransparency: false })).toBe('medium')
    expect(defaultTier({ touch: true, reducedTransparency: true })).toBe('minimal')
  })

  it('profile follows the tier', () => {
    const q = new QualityController({ initial: 'high' })
    expect(q.profile).toBe(QUALITY.high)
    slow(q); slow(q)
    expect(q.profile).toBe(QUALITY.medium)
  })
  it('a window between 10 and 20 ms resets both counters', () => {
    const down = new QualityController({ initial: 'high', window: 1 })
    expect([25, 15, 25].map(ms => down.sample(ms))).toEqual([null, null, null])
    expect(down.sample(25)).toBe('medium')
    const up = new QualityController({ initial: 'low', cap: 'high', window: 1 })
    expect([5, 5, 5, 5, 15, 5, 5, 5, 5].map(ms => up.sample(ms))).toEqual(Array(9).fill(null))
    expect(up.sample(5)).toBe('medium')
  })
  it('ignores non-finite and negative frame times', () => {
    const q = new QualityController({ initial: 'medium', cap: 'high', window: 1 })
    for (let i = 0; i < 10; i++) for (const ms of [Infinity, -Infinity, NaN, -5]) expect(q.sample(ms)).toBeNull()
    expect(q.tier).toBe('medium')
    expect(q.sample(25)).toBeNull(); expect(q.sample(25)).toBe('low')
  })
  it('never steps below minimal', () => {
    const q = new QualityController({ initial: 'minimal' })
    for (let i = 0; i < 10; i++) expect(slow(q)).toBeNull()
    expect(q.tier).toBe('minimal')
  })
  it('set notifies (tier, prev) only on change; the returned function unsubscribes', () => {
    const q = new QualityController({ initial: 'high' })
    const fn = vi.fn(); const off = q.onChange(fn)
    q.set('high'); expect(fn).not.toHaveBeenCalled()
    q.set('low'); expect(fn).toHaveBeenCalledExactlyOnceWith('low', 'high'); expect(q.tier).toBe('low')
    off(); q.set('medium'); expect(fn).toHaveBeenCalledTimes(1)
  })
  it('a tier change from set restarts the hysteresis (runs counted at the cap do not carry over)', () => {
    const q = new QualityController({ initial: 'high', window: 1 })
    for (let i = 0; i < 10; i++) q.sample(5)                   // fast windows at the cap: nowhere to go
    q.set('low')
    expect([5, 5, 5, 5].map(ms => q.sample(ms))).toEqual([null, null, null, null])
    expect(q.sample(5)).toBe('medium')
    const m = new QualityController({ initial: 'minimal', cap: 'high', window: 1 })
    for (let i = 0; i < 10; i++) m.sample(25)                  // slow windows at the floor
    m.set('high')
    expect(m.sample(25)).toBeNull(); expect(m.sample(25)).toBe('medium')
  })
  it('sample reports the change on the frame it happens and notifies once', () => {
    const q = new QualityController({ initial: 'high', window: 1 })
    const fn = vi.fn(); q.onChange(fn)
    expect(q.sample(25)).toBeNull(); expect(q.sample(25)).toBe('medium')
    expect(fn).toHaveBeenCalledExactlyOnceWith('medium', 'high')
  })
  it('clearing reduced transparency returns to the cap and restarts the hysteresis', () => {
    const q = new QualityController({ initial: 'high', window: 2 })
    q.sample(25); q.sample(25)                                  // one slow window counted
    q.sample(1000)                                               // half a window accumulated
    q.setReducedTransparency(true); q.setReducedTransparency(false)
    expect(q.tier).toBe('high')
    expect([25, 25, 25].map(ms => q.sample(ms))).toEqual([null, null, null])
    expect(q.sample(25)).toBe('medium')                          // two fresh slow windows
  })
  it('reduced transparency from the constructor pins minimal until cleared', () => {
    const q = new QualityController({ initial: 'high', reducedTransparency: true })
    expect(q.tier).toBe('minimal')
    for (let i = 0; i < 10; i++) expect(fast(q)).toBeNull()
    q.setReducedTransparency(false)
    expect(q.tier).toBe('high')
  })
  it('a redundant setReducedTransparency changes nothing', () => {
    const q = new QualityController({ initial: 'high' })
    slow(q); slow(q); expect(q.tier).toBe('medium')
    const fn = vi.fn(); q.onChange(fn)
    q.setReducedTransparency(false)                              // was never on: no jump back to the cap
    expect(q.tier).toBe('medium'); expect(fn).not.toHaveBeenCalled()
    q.setReducedTransparency(true); q.setReducedTransparency(true)
    expect(fn).toHaveBeenCalledExactlyOnceWith('minimal', 'medium')
  })
  it('set while pinned keeps minimal, emits nothing, and is where clearing the pin returns', () => {
    const q = new QualityController({ initial: 'high', reducedTransparency: true })
    const fn = vi.fn(); q.onChange(fn)
    q.set('high')
    expect(q.tier).toBe('minimal'); expect(fn).not.toHaveBeenCalled()
    q.setReducedTransparency(false)
    expect(q.tier).toBe('high'); expect(fn).toHaveBeenCalledExactlyOnceWith('high', 'minimal')
    q.setReducedTransparency(true); expect(q.tier).toBe('minimal')   // the pin can be re-applied
  })
  it('the request recorded while pinned replaces the cap as the return target, never above it, for that pin only', () => {
    const q = new QualityController({ initial: 'medium', reducedTransparency: true })
    q.set('low'); q.setReducedTransparency(false)
    expect(q.tier).toBe('low')
    q.setReducedTransparency(true); q.set('high'); q.setReducedTransparency(false)
    expect(q.tier).toBe('medium')                                // clamped to the cap
    q.set('low'); q.setReducedTransparency(true); q.setReducedTransparency(false)
    expect(q.tier).toBe('medium')                                // no request this time: back to the cap
  })
  it('listeners get a snapshot: one added during delivery waits for the next change', () => {
    const q = new QualityController({ initial: 'high' })
    const late = vi.fn()
    q.onChange(() => { q.onChange(late) })
    q.set('low'); expect(late).not.toHaveBeenCalled()
    q.set('medium'); expect(late).toHaveBeenCalledExactlyOnceWith('medium', 'low')
  })
  it('a listener calling set does not reorder what later listeners see', () => {
    const q = new QualityController({ initial: 'high' })
    const seen: string[] = []
    q.onChange(t => { if (t === 'medium') q.set('low') })
    q.onChange((t, p) => seen.push(`${p}→${t}`))
    q.set('medium')
    expect(seen).toEqual(['high→medium', 'medium→low']); expect(q.tier).toBe('low')
  })
  it('a throwing listener is reported and neither stops the others nor escapes sample', () => {
    const logged: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a) })
    try {
      const q = new QualityController({ initial: 'high', window: 1 })
      const boom = new Error('boom'), after = vi.fn()
      q.onChange(() => { throw boom }); q.onChange(after)
      q.sample(25)
      expect(q.sample(25)).toBe('medium')
      expect(after).toHaveBeenCalledExactlyOnceWith('medium', 'high')
      expect(logged).toHaveLength(1); expect(logged[0]).toContain(boom)
    } finally { spy.mockRestore() }
  })
  it('tier is read-only from outside', () => {
    const q = new QualityController()
    // @ts-expect-error tier changes through set()
    expect(() => { q.tier = 'low' }).toThrow(TypeError)
    expect(q.tier).toBe<QualityTier>('high')
  })
})
