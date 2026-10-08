import { describe, it, expect, beforeAll } from 'vitest'
import { Node } from '../src/node'
import { createSurface } from '../src/surface'
import { createYogaLayout, type LayoutEngine } from '../src/layout/yoga'
import { AnimationRuntime } from '../src/animation/runtime'
import { ease } from '../src/animation/easing'
import { defaultTheme as theme } from '../src/style/theme'

let engine: LayoutEngine
beforeAll(async () => { engine = await createYogaLayout() })

function button() {
  const s = createSurface({ id: 'a', width: 300, height: 200 })
  const btn = new Node('glass', 'btn')
  btn.setStyle({ position: 'absolute', left: 10, top: 10, width: 100, height: 40, radius: 'capsule', transition: { scale: 'snappy', opacity: { duration: 0.2, easing: 'linear' }, bg: 'smooth' }, pressed: { scale: 0.96 } })
  s.root.appendChild(btn)
  engine.compute(s.root, 300, 200)
  return { s, btn }
}

describe('ease', () => {
  it('endpoints and symmetry', () => {
    for (const e of ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const) { expect(ease(e, 0)).toBe(0); expect(ease(e, 1)).toBe(1) }
    expect(ease('ease-in', 0.5)).toBeCloseTo(0.125); expect(ease('ease-out', 0.5)).toBeCloseTo(0.875); expect(ease('ease-in-out', 0.5)).toBeCloseTo(0.5)
  })
})

describe('AnimationRuntime', () => {
  it('does not animate the first time it sees a node', () => {
    const { s, btn } = button()
    const rt = new AnimationRuntime(theme, 'light')
    expect(rt.tick(s.root, 1 / 60)).toBe(false)
    expect(btn.visual).toBeNull()
  })
  it('springs scale toward the pressed branch and settles back to null', () => {
    const { s, btn } = button()
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setState({ pressed: true })
    expect(rt.tick(s.root, 1 / 60)).toBe(true)
    const first = btn.visual!.scale!
    expect(first).toBeLessThan(1); expect(first).toBeGreaterThan(0.96)
    for (let i = 0; i < 240; i++) rt.tick(s.root, 1 / 60)
    expect(btn.visual).toBeNull()                 // settled → no overrides, the style target applies
    expect(rt.active).toBe(0)
  })
  it('tweens opacity linearly over the duration', () => {
    const { s, btn } = button()
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setStyle({ opacity: 0 })
    rt.tick(s.root, 0.1)
    expect(btn.visual!.opacity).toBeCloseTo(0.5, 5)
    rt.tick(s.root, 0.1)
    rt.tick(s.root, 1 / 60)
    expect(btn.visual).toBeNull()
  })
  it('retargets mid-flight without a jump', () => {
    const { s, btn } = button()
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setState({ pressed: true }); rt.tick(s.root, 1 / 60); rt.tick(s.root, 1 / 60)
    const mid = btn.visual!.scale!
    btn.setState({ pressed: false }); rt.tick(s.root, 1 / 600)
    expect(Math.abs(btn.visual!.scale! - mid)).toBeLessThan(0.01)
  })
  it('animates bg colour per channel', () => {
    const { s, btn } = button()
    btn.setStyle({ bg: 'fill' })
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setStyle({ bg: 'accent' })
    rt.tick(s.root, 1 / 60)
    const c = btn.visual!.bg!
    expect(c[0]).toBeLessThan(1); expect(c[0]).toBeGreaterThan(0.42)   // between fill (1) and accent (0x6b/255)
  })
  it('drops state for a removed node and restarts fresh when re-added', () => {
    const { s, btn } = button()
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setState({ pressed: true }); rt.tick(s.root, 1 / 60)
    btn.remove()
    expect(rt.tick(s.root, 1 / 60)).toBe(false)
    expect(rt.active).toBe(0)
    s.root.appendChild(btn)
    rt.tick(s.root, 1 / 60)
    expect(btn.visual).toBeNull()                 // first sight again: no animation from the stale value
  })
  it('reducedMotion jumps instead of animating', () => {
    const { s, btn } = button()
    const rt = new AnimationRuntime(theme, 'light'); rt.reducedMotion = true
    rt.tick(s.root, 1 / 60)
    btn.setState({ pressed: true })
    expect(rt.tick(s.root, 1 / 60)).toBe(false); expect(btn.visual).toBeNull()
  })
  it('marks paint on the node every tick while animating', () => {
    const { s, btn } = button()
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setState({ pressed: true }); rt.tick(s.root, 1 / 60)
    btn.dirty.paint = false; s.root.dirty.paint = false
    rt.tick(s.root, 1 / 60)
    expect(s.root.dirty.paint).toBe(true)
  })

  it('a retarget follows the transition now in effect (release uses the base spring, not the pressed one)', () => {
    const { s, btn } = button()
    btn.setStyle({ transition: { scale: { stiffness: 1, damping: 2 } }, pressed: { scale: 0.96, transition: { scale: 'snappy' } } })
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setState({ pressed: true }); for (let i = 0; i < 3; i++) rt.tick(s.root, 1 / 60)   // snappy press-in, ~0.987
    btn.setState({ pressed: false })
    for (let i = 0; i < 6; i++) rt.tick(s.root, 1 / 60)
    expect(btn.visual!.scale!).toBeLessThan(0.975)   // the soft base spring barely pulls back; staying snappy would be past 0.99
  })
  it('clamps an overshooting opacity spring to [0, 1]', () => {
    const { s, btn } = button()
    btn.setStyle({ transition: { opacity: 'bouncy' } })
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setStyle({ opacity: 0 })
    let clamped = 0
    for (let i = 0; i < 240; i++) {
      rt.tick(s.root, 1 / 60)
      const o = btn.visual?.opacity
      if (o === undefined) continue
      expect(o).toBeGreaterThanOrEqual(0); expect(o).toBeLessThanOrEqual(1)
      if (o === 0) clamped++
    }
    expect(clamped).toBeGreaterThan(0)            // bouncy overshoots below 0: those frames read exactly 0
  })
  it('clamps overshooting colour channels to [0, 1]', () => {
    const { s, btn } = button()
    btn.setStyle({ bg: 'accent', transition: { bg: 'bouncy' } })
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setStyle({ bg: 'fill' })                  // red 0x6b/255 → 1: bouncy overshoots above 1
    let clamped = 0
    for (let i = 0; i < 240; i++) {
      rt.tick(s.root, 1 / 60)
      const c = btn.visual?.bg
      if (!c) continue
      for (const x of c) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(1) }
      if (c[0] === 1) clamped++
    }
    expect(clamped).toBeGreaterThan(0)
  })
  it('turning reducedMotion on mid-flight settles every channel at once', () => {
    const { s, btn } = button()
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setState({ pressed: true }); rt.tick(s.root, 1 / 60)
    rt.reducedMotion = true
    btn.setState({ pressed: false })
    expect(rt.tick(s.root, 1 / 60)).toBe(false)
    expect(btn.visual).toBeNull(); expect(rt.active).toBe(0)
  })
  it('keeps the state of nodes under other roots (one runtime shared by several surfaces)', () => {
    const a = button(), b = button()
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(a.s.root, 1 / 60); rt.tick(b.s.root, 1 / 60)
    b.btn.setState({ pressed: true })
    rt.tick(a.s.root, 1 / 60)                     // must not forget b's button
    expect(rt.tick(b.s.root, 1 / 60)).toBe(true)
    expect(b.btn.visual!.scale!).toBeLessThan(1)
  })
  it('animates radius between the clamped radii the render list draws', () => {
    const { s, btn } = button()                   // 100 × 40: radii clamp to 20
    btn.setStyle({ radius: 'xl', transition: { radius: { duration: 0.2, easing: 'linear' } } })   // 24 → drawn as 20
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setStyle({ radius: 'sm' })                // 8
    rt.tick(s.root, 0.1)
    expect(btn.visual!.radius).toBeCloseTo(14, 5) // halfway from 20, not from 24
  })
})
