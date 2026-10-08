import { describe, it, expect } from 'vitest'
import { FrameSampler, FrameScheduler } from '../src/scheduler'

describe('FrameScheduler', () => {
  it('first dt is 0, then real time, clamped to 1/20 s', () => {
    const f = new FrameScheduler()
    expect(f.dt(1000)).toBe(0)
    expect(f.dt(1016)).toBeCloseTo(0.016)
    expect(f.dt(1016 + 5 * 60 * 1000)).toBe(1 / 20)          // tab hidden for five minutes
    expect(f.dt(1000)).toBe(0)                                  // clock went backwards
    expect(f.dt(NaN)).toBe(0)
  })
  it('reset makes the next dt 0', () => {
    const f = new FrameScheduler({ maxDt: 0.1 })
    f.dt(0); f.dt(50); f.reset()
    expect(f.dt(1000)).toBe(0); expect(f.dt(1200)).toBe(0.1)
  })

  it('maxDt defaults to 1/20 s', () => {
    expect(new FrameScheduler().maxDt).toBe(1 / 20)
  })
  it('a non-finite time returns 0 and does not move the clock', () => {
    const f = new FrameScheduler()
    expect(f.dt(NaN)).toBe(0)                                   // not the first frame either
    expect(f.dt(1000)).toBe(0)
    for (const t of [NaN, Infinity, -Infinity]) expect(f.dt(t)).toBe(0)
    expect(f.dt(1016)).toBeCloseTo(0.016)
  })
  it('after the clock goes backwards, time runs from the new reading', () => {
    const f = new FrameScheduler()
    f.dt(5000); expect(f.dt(1000)).toBe(0)
    expect(f.dt(1020)).toBeCloseTo(0.02)
  })
})

describe('FrameSampler', () => {
  it('says nothing on the first frame, a repeated, earlier or non-finite stamp, or after a pause', () => {
    const f = new FrameSampler()
    expect(f.sample(1000, 2)).toBeNull()                        // no interval yet
    expect(f.sample(1000, 2)).toBeNull()                        // the same frame twice
    expect(f.sample(NaN, 2)).toBeNull()                         // leaves the clock where it was
    expect(f.sample(1016, 2)).toBe(2)
    expect(f.sample(1010, 2)).toBeNull()                        // clock went backwards: runs from the new reading
    expect(f.sample(1026, 3)).toBe(3)
    expect(f.sample(6026, 2)).toBeNull()                        // 5 s later: a hidden tab, not a frame time
    expect(f.sample(6042, 4)).toBe(4)
  })
  it('a frame that met the refresh costs its CPU time; a dropped one its interval', () => {
    const f = new FrameSampler()
    let t = 0
    f.sample(t, 1)
    expect(f.sample(t += 16, 2)).toBe(2)
    expect(f.period).toBe(16)
    expect(f.sample(t += 24, 2)).toBe(2)                        // ≤ 1.5 · 16: jitter, still met
    expect(f.sample(t += 25, 2)).toBe(25)                       // > 1.5 · 16: dropped
    expect(f.sample(t += 50, 2)).toBe(50)
  })
  it('estimates the refresh period as the shortest of the last 60 intervals, clamped to [4, 40] ms', () => {
    const f = new FrameSampler()
    let t = 0
    f.sample(t, 1); f.sample(t += 16, 1)
    for (let i = 0; i < 59; i++) f.sample(t += 33, 1)
    expect(f.period).toBe(16)                                   // still among the last 60
    f.sample(t += 33, 1)
    expect(f.period).toBe(33)                                   // rolled out: a 30 Hz cap
    expect(f.sample(t += 33, 2)).toBe(2)                        // so 30 Hz frames meet the refresh
    for (let i = 0; i < 60; i++) f.sample(t += 100, 1)
    expect(f.period).toBe(40)
    expect(f.sample(t += 100, 2)).toBe(100)                     // > 1.5 · 40: dropped, however slow the display
    const fast = new FrameSampler()
    fast.sample(0, 1); fast.sample(1, 1)
    expect(fast.period).toBe(4)
  })
})
