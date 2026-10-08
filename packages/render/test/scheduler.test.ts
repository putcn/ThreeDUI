import { describe, it, expect } from 'vitest'
import { FrameScheduler } from '../src/scheduler'

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
