import { describe, it, expect } from 'vitest'
import { ScrollPhysics } from '../src/scroll'
import { GlassUIError } from '../src/errors'

const settle = (s: ScrollPhysics, seconds = 3) => { for (let t = 0; t < seconds; t += 1 / 60) s.step(1 / 60) }

describe('ScrollPhysics', () => {
  it('wheel scrolls and clamps to bounds', () => {
    const s = new ScrollPhysics(); s.setBounds(0, 500)
    s.wheel(120); expect(s.offset).toBe(120)
    s.wheel(1000); expect(s.offset).toBe(500)
    s.wheel(-9999); expect(s.offset).toBe(0)
  })
  it('a flick keeps moving after release and stops within bounds', () => {
    const s = new ScrollPhysics(); s.setBounds(0, 500)
    s.beginDrag(); for (let i = 0; i < 5; i++) s.drag(20, 1 / 60); s.endDrag()
    const atRelease = s.offset
    s.step(1 / 60); expect(s.offset).toBeGreaterThan(atRelease)
    settle(s); expect(s.offset).toBeGreaterThan(100); expect(s.offset).toBeLessThanOrEqual(500); expect(s.settled).toBe(true)
  })
  it('rubber-bands past the edge during drag and springs back after release', () => {
    const s = new ScrollPhysics(); s.setBounds(0, 500)
    s.beginDrag(); s.drag(-100, 1 / 60)
    expect(s.offset).toBeLessThan(0); expect(s.offset).toBeGreaterThan(-100)
    s.endDrag(); settle(s)
    expect(s.offset).toBeCloseTo(0, 2)
  })

  it('resists only the part of a drag that lies past the edge', () => {
    const inside = new ScrollPhysics(); inside.setBounds(0, 500)
    inside.beginDrag(); inside.drag(50, 1 / 60); expect(inside.offset).toBe(50)
    const across = new ScrollPhysics(); across.setBounds(0, 500); across.wheel(20)
    across.beginDrag(); across.drag(-50, 1 / 60)
    const fromEdge = new ScrollPhysics(); fromEdge.setBounds(0, 500)
    fromEdge.beginDrag(); fromEdge.drag(-30, 1 / 60)
    expect(across.offset).toBeCloseTo(fromEdge.offset, 9)
    expect(across.offset).toBeLessThan(0); expect(across.offset).toBeGreaterThan(-30)
  })
  it('rubber-banding depends only on finger position: same result in one or many moves, back under the finger on return', () => {
    const one = new ScrollPhysics(); one.setBounds(0, 500)
    one.beginDrag(); one.drag(-100, 1 / 60); const first = one.offset; one.drag(-100, 1 / 60)
    expect(first - one.offset).toBeLessThan(-first)   // the second 100 pt moves the content less than the first
    const many = new ScrollPhysics(); many.setBounds(0, 500); many.beginDrag()
    for (let i = 0; i < 20; i++) many.drag(-10, 1 / 60)
    expect(many.offset).toBeCloseTo(one.offset, 6)
    for (let i = 0; i < 20; i++) many.drag(10, 1 / 60)
    expect(many.offset).toBeCloseTo(0, 6)
  })
  it('the inertial glide covers the same distance at any frame rate', () => {
    const glide = (fps: number) => {
      const s = new ScrollPhysics(); s.setBounds(0, 5000)
      s.beginDrag(); s.drag(20, 1 / 60); s.endDrag()
      for (let t = 0; t < 3; t += 1 / fps) s.step(1 / fps)
      expect(s.settled).toBe(true)
      return s.offset
    }
    expect(Math.abs(glide(30) - glide(144))).toBeLessThan(0.5)
  })
  it('a flick into the end bounces past it and settles exactly on it', () => {
    const s = new ScrollPhysics(); s.setBounds(0, 150)
    s.beginDrag(); for (let i = 0; i < 5; i++) s.drag(20, 1 / 60); s.endDrag()
    let peak = s.offset
    for (let t = 0; t < 3; t += 1 / 60) peak = Math.max(peak, s.step(1 / 60))
    expect(peak).toBeGreaterThan(150)
    expect(s.offset).toBe(150); expect(s.settled).toBe(true)
  })
  it('an underdamped snap-back swings into the content under spring control and settles exactly on the edge', () => {
    const s = new ScrollPhysics({ snapBack: { stiffness: 300, damping: 8 } }); s.setBounds(0, 500)
    s.beginDrag(); s.drag(-100, 1 / 60); s.endDrag()
    let swing = 0
    for (let t = 0; t < 8; t += 1 / 60) swing = Math.max(swing, s.step(1 / 60))
    expect(swing).toBeGreaterThan(1)
    expect(s.offset).toBe(0); expect(s.settled).toBe(true)
  })
  it('springs back when the content shrinks under the offset; bounds shorter than the viewport collapse to min', () => {
    const s = new ScrollPhysics(); s.setBounds(0, 500); s.wheel(400)
    s.setBounds(0, 200); expect(s.settled).toBe(false)
    settle(s); expect(s.offset).toBe(200); expect(s.settled).toBe(true)
    s.setBounds(0, -50); expect(s.max).toBe(0)
    s.wheel(30); expect(s.offset).toBe(0)
  })
  it('grabbing stops inertia, and re-grabbing during snap-back continues without a jump', () => {
    const s = new ScrollPhysics(); s.setBounds(0, 500)
    s.beginDrag(); for (let i = 0; i < 5; i++) s.drag(20, 1 / 60); s.endDrag(); s.step(1 / 60)
    s.beginDrag(); const held = s.offset
    expect(s.velocity).toBe(0); expect(s.settled).toBe(false)
    s.step(1 / 60); expect(s.offset).toBe(held)

    const b = new ScrollPhysics(); b.setBounds(0, 500)
    b.beginDrag(); b.drag(-150, 1 / 60); b.endDrag(); for (let i = 0; i < 3; i++) b.step(1 / 60)
    const y = b.offset; expect(y).toBeLessThan(0)
    b.beginDrag(); b.drag(0, 1 / 60); expect(b.offset).toBeCloseTo(y, 9)
    b.drag(-10, 1 / 60); expect(b.offset).toBeLessThan(y); expect(b.offset).toBeGreaterThan(y - 10)
  })
  it('a drag sample with dt ≤ 0 moves the content but keeps the velocity; non-finite input is ignored', () => {
    const s = new ScrollPhysics(); s.setBounds(0, 500)
    s.beginDrag(); s.drag(20, 1 / 60); s.drag(10, 0)
    expect(s.offset).toBe(30); expect(s.velocity).toBeCloseTo(1200, 6)
    s.drag(NaN, 1 / 60); s.wheel(Infinity); s.wheel(NaN)
    expect(s.offset).toBe(30)
    s.endDrag(); s.step(0); s.step(-1); s.step(NaN); s.step(Infinity)
    expect(s.offset).toBe(30); expect(s.velocity).toBeCloseTo(1200, 6)
  })
  it('rubber 1 is a rigid edge', () => {
    const s = new ScrollPhysics({ rubber: 1 }); s.setBounds(0, 500)
    s.beginDrag(); s.drag(-100, 1 / 60); expect(s.offset).toBe(0)
    s.drag(40, 1 / 60); expect(s.offset).toBe(40)
  })
  it('rejects invalid options and bounds', () => {
    expect(() => new ScrollPhysics({ decay: 1 })).toThrow(GlassUIError)
    expect(() => new ScrollPhysics({ decay: -0.1 })).toThrow(GlassUIError)
    expect(() => new ScrollPhysics({ decay: NaN })).toThrow(GlassUIError)
    expect(() => new ScrollPhysics({ rubber: 1.5 })).toThrow(GlassUIError)
    expect(() => new ScrollPhysics({ rubber: NaN })).toThrow(GlassUIError)
    expect(() => new ScrollPhysics({ snapBack: { stiffness: 0, damping: 10 } })).toThrow(GlassUIError)
    expect(() => new ScrollPhysics().setBounds(0, NaN)).toThrow(GlassUIError)
    expect(() => new ScrollPhysics().setBounds(-Infinity, 0)).toThrow(GlassUIError)
  })
})
