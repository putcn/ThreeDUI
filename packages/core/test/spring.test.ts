import { describe, it, expect } from 'vitest'
import { Spring, springFromResponse, resolveSpring } from '../src/animation/spring'
import { defaultTheme } from '../src/style/theme'
import { GlassUIError } from '../src/errors'

function run(s: Spring, seconds: number, dt = 1 / 60) { const out: number[] = []; for (let t = 0; t < seconds; t += dt) out.push(s.step(dt)); return out }

describe('Spring', () => {
  it('converges to the target and reports done', () => {
    const s = new Spring(0, defaultTheme.springs.smooth); s.set(1)
    run(s, 2)
    expect(s.value).toBeCloseTo(1, 3); expect(s.done).toBe(true)
  })
  it('critically damped spring never overshoots', () => {
    const s = new Spring(0, springFromResponse(0.3, 1)); s.set(1)
    expect(Math.max(...run(s, 1))).toBeLessThanOrEqual(1 + 1e-6)
  })
  it('bouncy preset overshoots at least once', () => {
    const s = new Spring(0, defaultTheme.springs.bouncy); s.set(1)
    expect(Math.max(...run(s, 1))).toBeGreaterThan(1.02)
  })
  it('is stable with a large dt (sub-stepping)', () => {
    const s = new Spring(0, { stiffness: 2000, damping: 10 }); s.set(1)
    for (let i = 0; i < 20; i++) s.step(0.1)
    expect(Number.isFinite(s.value)).toBe(true); expect(Math.abs(s.value)).toBeLessThan(3)
  })
  it('jump snaps without velocity', () => {
    const s = new Spring(0, defaultTheme.springs.snappy); s.set(5); s.step(0.016); s.jump(5)
    expect(s.value).toBe(5); expect(s.velocity).toBe(0); expect(s.done).toBe(true)
  })
  it('resolves theme presets, response form and duration form', () => {
    expect(resolveSpring('snappy', defaultTheme)).toEqual(defaultTheme.springs.snappy)
    expect(resolveSpring({ response: 0.5, dampingFraction: 0.8 }, defaultTheme)).toMatchObject({ stiffness: expect.any(Number), damping: expect.any(Number) })
    expect(resolveSpring({ duration: 200, easing: 'ease-out' }, defaultTheme)).toEqual({ duration: 200, easing: 'ease-out' })
  })

  it('springFromResponse follows the Apple response/dampingFraction mapping', () => {
    const cfg = springFromResponse(0.5, 0.8, 2)
    const k = 2 * (2 * Math.PI / 0.5) ** 2
    expect(cfg.stiffness).toBeCloseTo(k, 9)
    expect(cfg.damping).toBeCloseTo(2 * 0.8 * Math.sqrt(k * 2), 9)
    expect(cfg.mass).toBe(2)
  })
  it('passes a raw stiffness/damping config through unchanged', () => {
    expect(resolveSpring({ stiffness: 120, damping: 14, mass: 2 }, defaultTheme)).toEqual({ stiffness: 120, damping: 14, mass: 2 })
  })
  it('heavily damped and very stiff springs stay stable and do not overshoot', () => {
    // damping/mass > 480 (or a critical ω > ~200 rad/s) exceeds what a fixed 1/240 s semi-implicit Euler step can integrate.
    for (const cfg of [{ stiffness: 100, damping: 1000 }, { stiffness: 1e6, damping: 2000 }]) {
      const s = new Spring(0, cfg); s.set(1)
      const out = run(s, 1)
      expect(out.every(Number.isFinite), JSON.stringify(cfg)).toBe(true)
      expect(Math.min(...out), JSON.stringify(cfg)).toBeGreaterThanOrEqual(0)
      expect(Math.max(...out), JSON.stringify(cfg)).toBeLessThanOrEqual(1 + 1e-6)
    }
  })
  it('ignores non-positive and non-finite dt instead of integrating forever', () => {
    const s = new Spring(0, defaultTheme.springs.smooth); s.set(1); s.step(1 / 60)
    const before = [s.value, s.velocity]
    for (const dt of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(s.step(dt)).toBe(before[0])
    expect([s.value, s.velocity]).toEqual(before)
  })
  it('rejects configs that cannot be integrated', () => {
    for (const cfg of [{ stiffness: 100, damping: 10, mass: 0 }, { stiffness: -1, damping: 10 }, { stiffness: 100, damping: -1 }, { stiffness: Number.NaN, damping: 10 }, springFromResponse(0, 1)]) {
      expect(() => new Spring(0, cfg), JSON.stringify(cfg)).toThrow(GlassUIError)
    }
  })
})
