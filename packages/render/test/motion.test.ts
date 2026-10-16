import { describe, expect, it } from 'vitest'
import { Euler, Quaternion, Vector3 } from 'three'
import { defaultTheme } from '@glassui/core'
import { SurfaceMotion, type ResolvedPose } from '../src/surface/motion'

const pose = (): ResolvedPose => ({ position: new Vector3(), quaternion: new Quaternion(), scale: new Vector3(1, 1, 1), opacity: 1 })
const run = (m: SurfaceMotion, out: ResolvedPose, s: number) => { for (let t = 0; t < s; t += 1 / 60) m.step(1 / 60, out) }

describe('SurfaceMotion', () => {
  it('springs each named channel to its target and resolves true; unnamed channels stay', async () => {
    const m = new SurfaceMotion(defaultTheme), p = pose()
    const done = m.to({ position: [2, 0, 0], opacity: 0 }, p)
    m.step(1 / 60, p); expect(p.position.x).toBeGreaterThan(0); expect(p.position.x).toBeLessThan(2)
    p.scale.set(3, 3, 3); m.step(1 / 60, p); expect(p.scale.x).toBe(3)        // idle: untouched
    run(m, p, 3); expect(p.position.x).toBe(2); expect(p.opacity).toBe(0)
    await expect(done).resolves.toBe(true); expect(m.active).toBe(false)
  })
  it('a retarget keeps the velocity of the channels it names and ends the older promise false', async () => {
    const m = new SurfaceMotion(defaultTheme), p = pose()
    const first = m.to({ position: [2, 0, 0] }, p)
    for (let i = 0; i < 6; i++) m.step(1 / 60, p)
    const x0 = p.position.x; m.step(1 / 60, p); const stepBefore = p.position.x - x0
    const second = m.to({ position: [4, 0, 0] }, p)
    const x1 = p.position.x; m.step(1 / 60, p)
    expect(p.position.x - x1).toBeGreaterThan(stepBefore * 0.9)               // no restart from rest
    await expect(first).resolves.toBe(false)
    run(m, p, 3); await expect(second).resolves.toBe(true)
  })
  it('calls naming different channels run side by side', async () => {
    const m = new SurfaceMotion(defaultTheme), p = pose()
    const a = m.to({ position: [1, 0, 0] }, p), b = m.to({ opacity: 0.5 }, p)
    run(m, p, 3); await expect(a).resolves.toBe(true); await expect(b).resolves.toBe(true)
  })
  it('rotation takes the short arc', () => {
    const m = new SurfaceMotion(defaultTheme), p = pose()
    const from = new Quaternion().setFromEuler(new Euler(0, 3, 0)), to = new Quaternion().setFromEuler(new Euler(0, -3, 0))
    p.quaternion.copy(from)
    void m.to({ rotation: [0, -3, 0] }, p)                                    // 6 rad apart as Euler, 0.28 rad the short way
    for (let i = 0; i < 30; i++) {
      m.step(1 / 60, p)
      expect(p.quaternion.angleTo(from) + p.quaternion.angleTo(to)).toBeCloseTo(from.angleTo(to), 4)   // on the short great arc
    }
  })
  it('immediate writes the end values at the next step and resolves true', async () => {
    const m = new SurfaceMotion(defaultTheme), p = pose()
    const done = m.to({ position: [5, 0, 0], scale: 2 }, p, { immediate: true })
    m.step(0, p); expect(p.position.x).toBe(5); expect(p.scale.toArray()).toEqual([2, 2, 2])
    await expect(done).resolves.toBe(true)
  })
  it('rest() is the target for moving channels and the current value for idle ones', () => {
    const m = new SurfaceMotion(defaultTheme), p = pose(); p.opacity = 0.7
    void m.to({ position: [1, 2, 3] }, p)
    const r = m.rest(p, pose()); expect(r.position.toArray()).toEqual([1, 2, 3]); expect(r.opacity).toBe(0.7)
  })
  it('stop() ends every pending promise false', async () => {
    const m = new SurfaceMotion(defaultTheme), p = pose(), done = m.to({ opacity: 0 }, p)
    m.stop(); await expect(done).resolves.toBe(false); expect(m.active).toBe(false)
  })
  it('rejects bad input readably', () => {
    const m = new SurfaceMotion(defaultTheme), p = pose()
    expect(() => m.to({ opacity: 2 }, p)).toThrow(/\[Surface\.animateTo\].*opacity/)
    expect(() => m.to({ position: [0, Number.NaN, 0] }, p)).toThrow(/\[Surface\.animateTo\]/)
    expect(() => m.to({ scale: 0 }, p)).toThrow(/\[Surface\.animateTo\].*scale/)
    expect(() => m.to({ opacity: 0 }, p, { spring: 'snapy' as never })).toThrow(/你可能想要：snappy/)
  })
})
