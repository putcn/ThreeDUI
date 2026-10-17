import { describe, it, expect, beforeAll } from 'vitest'
import { Node } from '../src/node'
import { createSurface } from '../src/surface'
import { createYogaLayout, type LayoutEngine } from '../src/layout/yoga'
import { AnimationRuntime } from '../src/animation/runtime'
import { ease } from '../src/animation/easing'
import { defaultTheme as theme } from '../src/style/theme'
import { buildRenderList } from '../src/renderlist'
import type { Style } from '../src/style/schema'

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
  it('a transition only a state branch configures animates into that branch and jumps out of it', () => {
    const { s, btn } = button()
    btn.setStyle({ transition: undefined, pressed: { scale: 0.96, transition: { scale: 'snappy' } } })   // no base transition
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setState({ pressed: true })
    expect(rt.tick(s.root, 1 / 60)).toBe(true)
    expect(btn.visual!.scale!).toBeLessThan(1); expect(btn.visual!.scale!).toBeGreaterThan(0.96)
    btn.setState({ pressed: false })              // the branch (and its transition) is off now: the change jumps
    expect(rt.tick(s.root, 1 / 60)).toBe(false)
    expect(btn.visual).toBeNull(); expect(rt.active).toBe(0)
  })
  it('a branch adds a transition key next to the base ones', () => {
    const { s, btn } = button()
    btn.setStyle({ transition: { opacity: 'smooth' }, pressed: { scale: 0.9, transition: { scale: 'snappy' } } })
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setState({ pressed: true })
    expect(rt.tick(s.root, 1 / 60)).toBe(true)
    expect(btn.visual!.scale!).toBeLessThan(1); expect(btn.visual!.scale!).toBeGreaterThan(0.9)
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
  it('resolves a concentric root radius against the surface corner radius it is given', () => {
    const { s, btn } = button()                   // at (10, 10) in 300 × 200: inset 10
    s.cornerRadius = 24
    s.root.setStyle({ radius: 'concentric' })     // the root follows the surface's corners (24), the button nests in it
    btn.setStyle({ radius: 'concentric', transition: { radius: { duration: 0.2, easing: 'linear' } } })
    const drawn = buildRenderList(s, theme, 'light').glass[0]!.radius
    expect(drawn).toBe(14)                        // 24 − 10, as the render list draws it
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60, s.cornerRadius)
    btn.setStyle({ radius: 'sm' })                // 8
    rt.tick(s.root, 0.1, s.cornerRadius)
    expect(btn.visual!.radius).toBeCloseTo(11, 5) // halfway from 14; without the corner radius it would start at 0
  })
  it('forget drops one root\'s state and visuals and keeps the others\'', () => {
    const a = button(), b = button()
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(a.s.root, 1 / 60); rt.tick(b.s.root, 1 / 60)
    a.btn.setState({ pressed: true }); b.btn.setState({ pressed: true })
    rt.tick(a.s.root, 1 / 60); rt.tick(b.s.root, 1 / 60)
    const both = rt.active
    expect(a.btn.visual).not.toBeNull()
    rt.forget(a.s.root)
    expect(a.btn.visual).toBeNull()
    expect(rt.active).toBe(both / 2)              // b's channels only
    expect(rt.tick(b.s.root, 1 / 60)).toBe(true)
    expect(rt.tick(a.s.root, 1 / 60)).toBe(false) // first sight again: nothing animates from the dropped state
    expect(a.btn.visual).toBeNull()
  })
})

describe('AnimationRuntime hooks', () => {
  const box = (style: Style) => { const n = new Node('box'); n.setStyle(style); n.layout = { x: 0, y: 0, width: 100, height: 40 }; return n }
  const tree = () => { const root = new Node('box'); root.layout = { x: 0, y: 0, width: 400, height: 400 }; return root }
  const linear = { duration: 0.2, easing: 'linear' } as const
  it('whenSettled resolves on the tick the node stops moving', async () => {
    const rt = new AnimationRuntime(theme, 'light'), root = new Node('box'); root.layout = { x: 0, y: 0, width: 400, height: 400 }
    const n = box({ opacity: 1, transition: { opacity: { duration: 0.1, easing: 'linear' } } }); root.appendChild(n)
    rt.tick(root, 0)                                         // first sight
    n.setStyle({ opacity: 0 })
    let done = false; void rt.whenSettled(n).then(() => { done = true })
    rt.tick(root, 0.05); await Promise.resolve(); expect(done).toBe(false)
    rt.tick(root, 0.06); await Promise.resolve(); expect(done).toBe(true)
  })
  it('whenSettled resolves for a node that never animates, and for one removed from the tree', async () => {
    const rt = new AnimationRuntime(theme, 'light'), root = new Node('box'); root.layout = { x: 0, y: 0, width: 400, height: 400 }
    const still = box({}); root.appendChild(still)
    const gone = box({ opacity: 1, transition: { opacity: 'smooth' } }); root.appendChild(gone)
    rt.tick(root, 0); gone.setStyle({ opacity: 0 }); rt.tick(root, 0.01)
    const a = rt.whenSettled(still), b = rt.whenSettled(gone)
    gone.remove(); rt.tick(root, 0.01)
    await expect(Promise.all([a, b])).resolves.toBeDefined()
  })
  it('seed makes the first sight animate from the seeded values', () => {
    const rt = new AnimationRuntime(theme, 'light'), root = new Node('box'); root.layout = { x: 0, y: 0, width: 400, height: 400 }
    const n = box({ transition: { x: { duration: 0.2, easing: 'linear' }, width: { duration: 0.2, easing: 'linear' } } })
    n.layout = { x: 200, y: 0, width: 100, height: 40 }; root.appendChild(n)
    rt.seed(n, { x: 0, width: 50 })
    rt.tick(root, 0.1)
    expect(n.visual?.x).toBeCloseTo(100); expect(n.visual?.width).toBeCloseTo(75)
  })
  it('a seed in the Surface frame becomes parent-relative at the first tick after layout (a new or moving parent)', () => {
    const rt = new AnimationRuntime(theme, 'light'), root = tree()
    // the old glass was drawn at (30, 20) 80 × 40 of the root; the new one sits in a scroll wrapper not laid out yet
    const outer = box({}), wrap = new Node('scroll'), n = box({ transition: { x: linear, y: linear, width: linear } })
    wrap.appendChild(n); outer.appendChild(wrap); root.appendChild(outer)
    rt.seed(n, { x: 30, y: 20, width: 80 }, { frame: 'surface' })
    // layout lands only now (before the tick): the wrapper at (150, 60) inside outer at (10, 5), scrolled 40 down
    outer.layout = { x: 10, y: 5, width: 300, height: 300 }; wrap.layout = { x: 150, y: 60, width: 200, height: 200 }
    wrap.setProp('scrollY', 40); n.layout = { x: 20, y: 100, width: 120, height: 40 }
    rt.tick(root, 0)
    // its first frame stands where the old one was: origin (160, 25) + visual = (30, 20)
    expect(n.visual).toMatchObject({ x: 30 - 160, y: 20 - 25, width: 80 })
    rt.tick(root, 0.1)
    expect(n.visual?.x).toBeCloseTo((30 - 160 + 20) / 2); expect(n.visual?.y).toBeCloseTo((-5 + 100) / 2)
    // the default frame is the parent's, as before
    const m = box({ transition: { x: linear } }); m.layout = { x: 200, y: 0, width: 100, height: 40 }
    const holder = box({}); holder.layout = { x: 50, y: 0, width: 300, height: 40 }; holder.appendChild(m); root.appendChild(holder)
    rt.seed(m, { x: 0 }, { frame: 'parent' }); rt.tick(root, 0)
    expect(m.visual?.x).toBe(0)
  })
  it('glowSplit animates like the other glass numbers', () => {
    const rt = new AnimationRuntime(theme, 'light'), root = new Node('box'); root.layout = { x: 0, y: 0, width: 400, height: 400 }
    const g = new Node('glass'); g.layout = { x: 0, y: 0, width: 136, height: 62 }
    g.setStyle({ glass: { glow: { color: 'accent', strength: 1, split: 0.2 } }, transition: { glass: { duration: 0.2, easing: 'linear' } } })
    root.appendChild(g); rt.tick(root, 0)
    g.setStyle({ glass: { glow: { color: 'accent', strength: 1, split: 0.8 } } })
    rt.tick(root, 0.1)
    expect(g.visual?.glass?.glowSplit).toBeCloseTo(0.5)
  })
  it('the animated split reaches the render list; a glow without a split stays unsplit while its glass animates', () => {
    const rt = new AnimationRuntime(theme, 'light'), s = createSurface({ id: 'glow', width: 400, height: 400 })
    s.root.layout = { x: 0, y: 0, width: 400, height: 400 }
    const sw = new Node('glass'), btn = new Node('glass')
    sw.layout = { x: 0, y: 0, width: 136, height: 62 }; btn.layout = { x: 0, y: 100, width: 136, height: 62 }
    sw.setStyle({ glass: { glow: { color: 'accent', strength: 1, split: 0.2 } }, transition: { glass: linear } })
    btn.setStyle({ glass: { glow: { color: 'accent', strength: 1 } }, transition: { glass: linear } })
    s.root.appendChild(sw); s.root.appendChild(btn); rt.tick(s.root, 0)
    sw.setStyle({ glass: { glow: { color: 'accent', strength: 1, split: 0.8 } } })
    btn.setStyle({ glass: { glow: { color: 'accent', strength: 0.5 } } })
    rt.tick(s.root, 0.1)
    expect(btn.visual?.glass?.glowStrength).toBeCloseTo(0.75)
    expect(btn.visual?.glass).not.toHaveProperty('glowSplit')   // render reads a missing split as "no split", not 0.5
    const [a, b] = buildRenderList(s, theme, 'light').glass
    expect(a!.params.glow?.split).toBeCloseTo(0.5)
    expect(b!.params.glow).not.toHaveProperty('split')
  })
  it('a springing split stays in 0..1: render reads a negative split as "no split"', () => {
    const rt = new AnimationRuntime(theme, 'light'), root = tree()
    const g = new Node('glass'); g.layout = { x: 0, y: 0, width: 136, height: 62 }
    g.setStyle({ glass: { glow: { color: 'accent', strength: 1, split: 0.9 } }, transition: { glass: 'bouncy' } })
    root.appendChild(g); rt.tick(root, 0)
    g.setStyle({ glass: { glow: { color: 'accent', strength: 1, split: 0 } } })
    let low = Infinity
    for (let i = 0; i < 120; i++) { rt.tick(root, 1 / 60); low = Math.min(low, g.visual?.glass?.glowSplit ?? Infinity) }
    expect(low).toBe(0)                         // it reached the target, and the overshoot below it was clamped
  })
  it('seed on a tracked node restarts the seeded keys and keeps its other channels', () => {
    const rt = new AnimationRuntime(theme, 'light'), root = tree()
    const n = box({ opacity: 1, transition: { opacity: linear, x: linear } }); root.appendChild(n)
    rt.tick(root, 0); n.setStyle({ opacity: 0 }); rt.tick(root, 0.05)   // opacity a quarter of the way
    rt.seed(n, { x: 50 }); n.layout = { x: 250, y: 0, width: 100, height: 40 }
    rt.tick(root, 0.05)
    expect(n.visual?.opacity).toBeCloseTo(0.5); expect(n.visual?.x).toBeCloseTo(100)
  })
  it('a node seeded in a detached parent animates under the root it joins; its waiter waits for that root', async () => {
    const rt = new AnimationRuntime(theme, 'light'), a = tree(), b = tree()
    const wrap = box({}), n = box({ transition: { x: linear } }); n.layout = { x: 200, y: 0, width: 100, height: 40 }
    wrap.appendChild(n); rt.seed(n, { x: 0 })   // Vue mounts children first: the parent is not in a tree yet
    b.appendChild(wrap)
    let done = false; void rt.whenSettled(n).then(() => { done = true })
    rt.tick(a, 0.1); await Promise.resolve(); expect(done).toBe(false)   // another root's tick does not settle it
    rt.tick(b, 0.1); expect(n.visual?.x).toBeCloseTo(100)
    await Promise.resolve(); expect(done).toBe(false)
    rt.tick(b, 0.1); await Promise.resolve(); expect(done).toBe(true)
  })
  it('a seeded node its root never visits is dropped there and settles', async () => {
    const rt = new AnimationRuntime(theme, 'light'), root = tree()
    const hidden = box({ display: 'none' }), n = box({ transition: { x: linear } }); n.layout = { x: 200, y: 0, width: 100, height: 40 }
    hidden.appendChild(n); rt.seed(n, { x: 0 }); root.appendChild(hidden)
    let done = false; void rt.whenSettled(n).then(() => { done = true })
    rt.tick(root, 0.1); await Promise.resolve(); expect(done).toBe(true)
    hidden.setStyle({ display: 'flex' }); rt.tick(root, 0.1)
    expect(n.visual).toBeNull()                 // first sight: the stale seed is gone
  })
  it('forget settles the waiters of the forgotten tree at once', async () => {
    const rt = new AnimationRuntime(theme, 'light'), root = tree()
    const n = box({ opacity: 1, transition: { opacity: 'smooth' } }), still = box({}); root.appendChild(n); root.appendChild(still)
    rt.tick(root, 0); n.setStyle({ opacity: 0 }); rt.tick(root, 0.01)
    let done = 0; void rt.whenSettled(n).then(() => { done++ }); void rt.whenSettled(still).then(() => { done++ })
    rt.forget(root); await Promise.resolve()
    expect(done).toBe(2)                        // no tick: a disposed Surface's root is never ticked again
  })
  it('reset settles the node\'s waiters at once', async () => {
    const rt = new AnimationRuntime(theme, 'light'), root = tree()
    const n = box({ opacity: 1, transition: { opacity: 'smooth' } }); root.appendChild(n)
    rt.tick(root, 0); n.setStyle({ opacity: 0 }); rt.tick(root, 0.01)
    let done = false; void rt.whenSettled(n).then(() => { done = true })
    rt.reset(n); await Promise.resolve()
    expect(done).toBe(true); expect(n.visual).toBeNull()
  })
})
