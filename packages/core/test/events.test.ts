import { describe, it, expect, beforeAll } from 'vitest'
import { Node } from '../src/node'
import { GlassUIError } from '../src/errors'
import { defaultTheme, type Theme } from '../src/style/theme'
import { createYogaLayout, type LayoutEngine } from '../src/layout/yoga'
import { absoluteRect, hitTest } from '../src/events/hit'
import { EventDispatcher, PointerTracker } from '../src/events/dispatch'

let engine: LayoutEngine
beforeAll(async () => { engine = await createYogaLayout() })
const box = (style: Parameters<Node['setStyle']>[0], id?: string) => { const n = new Node('box', id); n.setStyle(style); return n }

function scene() {
  const root = box({ width: 200, height: 200 }, 'root')
  const panel = box({ position: 'absolute', left: 50, top: 50, width: 100, height: 100, overflow: 'hidden' }, 'panel')
  const btn = box({ position: 'absolute', left: 10, top: 10, width: 80, height: 40, radius: 'capsule' }, 'btn')
  const over = box({ position: 'absolute', left: 90, top: 90, width: 40, height: 40 }, 'overflowing')
  const ghost = box({ position: 'absolute', left: 0, top: 0, width: 200, height: 200, pointerEvents: 'none' }, 'ghost')
  const hidden = box({ position: 'absolute', left: 0, top: 0, width: 200, height: 200, display: 'none' }, 'hidden')
  root.appendChild(panel); panel.appendChild(btn); panel.appendChild(over); root.appendChild(ghost); root.appendChild(hidden)
  engine.compute(root, 200, 200)
  return { root, panel, btn, over, ghost, hidden }
}

describe('hitTest', () => {
  it('computes absolute rects and hits the topmost visible node', () => {
    const s = scene()
    expect(absoluteRect(s.btn)).toEqual({ x: 60, y: 60, width: 80, height: 40 })
    expect(hitTest(s.root, 100, 80)?.id).toBe('btn')
    expect(hitTest(s.root, 55, 55)?.id).toBe('panel')
    expect(hitTest(s.root, 10, 10)?.id).toBe('root')
  })
  it('ignores pointerEvents none, display none, and clipped overflow', () => {
    const s = scene()
    expect(hitTest(s.root, 100, 80)?.id).not.toBe('ghost')
    expect(hitTest(s.root, 155, 155)?.id).toBe('root')      // 'overflowing' is clipped by panel
    expect(hitTest(s.root, 145, 145)?.id).toBe('overflowing')
  })
  it('respects capsule corners', () => {
    const s = scene()
    expect(hitTest(s.root, 61, 61)?.id).toBe('panel')   // outside the rounded corner of btn
    expect(hitTest(s.root, 100, 61)?.id).toBe('btn')
  })
})

describe('hitTest edge cases', () => {
  it('lets pointerEvents none pass through a whole subtree unless a descendant opts back in', () => {
    const root = box({ width: 100, height: 100 }, 'root')
    const overlay = box({ position: 'absolute', inset: 0, pointerEvents: 'none' }, 'overlay')
    const label = box({ width: 50, height: 50 }, 'label')
    const hotspot = box({ position: 'absolute', left: 60, top: 60, width: 20, height: 20, pointerEvents: 'auto' }, 'hotspot')
    root.appendChild(overlay); overlay.appendChild(label); overlay.appendChild(hotspot)
    engine.compute(root, 100, 100)
    expect(hitTest(root, 10, 10)?.id).toBe('root')
    expect(hitTest(root, 70, 70)?.id).toBe('hotspot')
  })
  it('skips display none subtrees and clips to a rounded overflow-hidden parent', () => {
    const root = box({ width: 100, height: 100 }, 'root')
    const card = box({ position: 'absolute', left: 0, top: 0, width: 80, height: 80, radius: 40, overflow: 'hidden' }, 'card')
    const fill = box({ width: 80, height: 80 }, 'fill')
    const gone = box({ position: 'absolute', inset: 0 }, 'gone')
    const goneChild = box({ width: 100, height: 100 }, 'goneChild')
    root.appendChild(card); card.appendChild(fill); root.appendChild(gone); gone.appendChild(goneChild)
    engine.compute(root, 100, 100)
    gone.setStyle({ display: 'none' })   // hidden after layout, as v-show does: goneChild keeps its 100x100 rect
    expect(hitTest(root, 50, 50)?.id).toBe('fill')
    expect(hitTest(root, 2, 2)?.id).toBe('root')   // inside fill's square, outside card's rounded clip
    expect(hitTest(root, 90, 90)?.id).toBe('root')
  })
  it('clamps oversized radii and never hits zero-size nodes', () => {
    const root = box({ width: 200, height: 100 }, 'root')
    const pill = box({ position: 'absolute', left: 0, top: 0, width: 80, height: 40, radius: 100 }, 'pill')
    const anchor = box({ position: 'absolute', left: 150, top: 50, width: 0, height: 0 }, 'anchor')
    root.appendChild(pill); root.appendChild(anchor)
    engine.compute(root, 200, 100)
    expect(hitTest(root, 5, 20)?.id).toBe('pill')   // inside the capsule the radius clamps to
    expect(hitTest(root, 1, 1)?.id).toBe('root')
    expect(hitTest(root, 150, 50)?.id).toBe('root')
  })
  it('offsets content by scroll ancestors', () => {
    const root = box({ width: 100, height: 100 }, 'root')
    const sc = new Node('scroll', 'sc'); sc.setStyle({ width: 100, height: 50 })
    const a = box({ height: 40, flexShrink: 0 }, 'a'), b = box({ height: 40, flexShrink: 0 }, 'b')
    root.appendChild(sc); sc.appendChild(a); sc.appendChild(b)
    engine.compute(root, 100, 100)
    sc.setProp('scrollY', 30)
    expect(absoluteRect(b)).toEqual({ x: 0, y: 10, width: 100, height: 40 })
    expect(hitTest(root, 50, 5)?.id).toBe('a')
    expect(hitTest(root, 50, 45)?.id).toBe('b')
    expect(hitTest(root, 50, 60)?.id).toBe('root')   // b's scrolled rect ends at 50, the viewport too
    sc.setProp('scrollX', Number.NaN)
    expect(absoluteRect(b).x).toBe(0)
  })
  it('resolves radius tokens against the given theme', () => {
    const theme: Theme = { ...defaultTheme, radius: { ...defaultTheme.radius, card: 20 } }
    const root = box({ width: 100, height: 100 }, 'root')
    const card = box({ position: 'absolute', left: 0, top: 0, width: 40, height: 40, radius: 'card' }, 'card')
    root.appendChild(card)
    engine.compute(root, 100, 100)
    expect(hitTest(root, 2, 2, theme)?.id).toBe('root')
    expect(hitTest(root, 20, 20, theme)?.id).toBe('card')
    expect(() => hitTest(root, 20, 20)).toThrow(GlassUIError)   // not a default-theme token
    const p = new PointerTracker(root, new EventDispatcher(), theme)
    p.move(20, 20)
    expect(p.hovered?.id).toBe('card')
  })
})

describe('hitTest reads the effective style', () => {
  it('applies state branches for display, overflow, radius and pointerEvents', () => {
    const s = scene()
    s.btn.setStyle({ hover: { display: 'none' } })
    s.panel.setStyle({ pressed: { overflow: 'visible' } })
    s.ghost.setStyle({ focused: { pointerEvents: 'auto' } })
    expect(hitTest(s.root, 100, 80)?.id).toBe('btn')
    s.btn.setState({ hover: true })
    expect(hitTest(s.root, 100, 80)?.id).toBe('panel')   // hidden by its hover branch
    s.btn.setStyle({ hover: { radius: 0 } })
    expect(hitTest(s.root, 61, 61)?.id).toBe('btn')     // square corners while hovered
    expect(hitTest(s.root, 155, 155)?.id).toBe('root')
    s.panel.setState({ pressed: true })
    expect(hitTest(s.root, 155, 155)?.id).toBe('overflowing')   // no longer clipped
    s.ghost.setState({ focused: true })
    expect(hitTest(s.root, 10, 10)?.id).toBe('ghost')
  })
})

describe('EventDispatcher + PointerTracker', () => {
  it('changes hover and press through setState, so the nodes are marked dirty', () => {
    const s = scene()
    s.btn.setStyle({ hover: { opacity: 0.9 }, pressed: { width: 90 } })
    engine.compute(s.root, 200, 200)
    s.root.walk(n => { n.dirty = { layout: false, paint: false, text: false, tree: false } })
    const p = new PointerTracker(s.root, new EventDispatcher())
    p.move(100, 80)
    expect([s.btn.dirty.paint, s.panel.dirty.paint, s.root.dirty.paint]).toEqual([true, true, true])
    expect(s.root.dirty.layout).toBe(false)
    p.down(100, 80)
    expect([s.btn.dirty.layout, s.root.dirty.layout]).toEqual([true, true])
    engine.compute(s.root, 200, 200)
    expect(s.btn.layout.width).toBe(90)
    p.up(100, 80)
    expect(s.root.dirty.layout).toBe(true)
  })
  it('bubbles with stopPropagation and tracks hover/press/click', () => {
    const s = scene()
    const d = new EventDispatcher()
    const log: string[] = []
    d.on(s.root, 'click', e => log.push(`root:${e.target.id}`))
    d.on(s.btn, 'click', e => { log.push('btn'); e.stopPropagation() })
    d.on(s.btn, 'pointerenter', () => log.push('enter'))
    d.on(s.btn, 'pointerleave', () => log.push('leave'))
    const p = new PointerTracker(s.root, d)
    p.move(100, 80); expect(s.btn.state.hover).toBe(true)
    p.down(100, 80); expect(s.btn.state.pressed).toBe(true)
    p.up(100, 80);   expect(s.btn.state.pressed).toBe(false)
    p.move(10, 10);  expect(s.btn.state.hover).toBe(false)
    expect(log).toEqual(['enter', 'btn', 'leave'])
    p.down(55, 55); p.up(55, 55)
    expect(log.at(-1)).toBe('root:panel')
  })
  it('clicks the nearest common ancestor when up happens on a different node, and nothing when up misses the tree', () => {
    const s = scene(); const d = new EventDispatcher(); const clicks: string[] = []
    d.on(s.root, 'click', e => clicks.push(e.target.id))
    const p = new PointerTracker(s.root, d)
    p.down(100, 80); p.up(10, 10)     // btn → root
    expect(clicks).toEqual(['root'])
    expect(s.btn.state.pressed).toBe(false)
    p.down(100, 80); p.up(55, 55)     // btn → panel
    expect(clicks).toEqual(['root', 'panel'])
    p.down(100, 80); p.up(250, 250)   // outside the root: hitTest is null
    expect(clicks).toEqual(['root', 'panel'])
    expect(s.btn.state.pressed).toBe(false)
  })
  it('clicks the button when a press on its padding is released over its label', () => {
    const s = scene(); const d = new EventDispatcher(); const clicks: string[] = []
    const label = box({ position: 'absolute', left: 20, top: 10, width: 40, height: 20 }, 'label')   // abs 80..120 × 70..90
    s.btn.appendChild(label)
    engine.compute(s.root, 200, 200)
    d.on(s.btn, 'click', e => clicks.push(`${e.currentTarget.id}:${e.target.id}`))
    const p = new PointerTracker(s.root, d)
    p.down(70, 80)
    expect(p.pressed?.id).toBe('btn')
    p.up(100, 80)
    expect(p.hovered?.id).toBe('label')
    expect(clicks).toEqual(['btn:btn'])
  })
  it('gives local coordinates relative to the current target', () => {
    const s = scene(); const d = new EventDispatcher(); let local: [number, number] | null = null
    d.on(s.btn, 'pointerdown', e => { local = [e.localX, e.localY] })
    new PointerTracker(s.root, d).down(70, 70)
    expect(local).toEqual([10, 10])
  })
})

describe('EventDispatcher semantics', () => {
  it('finishes the stopping node, bubbles along the path captured at dispatch, and unsubscribes', () => {
    const s = scene(); const d = new EventDispatcher(); const log: string[] = []
    d.on(s.btn, 'click', ({ stopPropagation }) => { log.push('a'); stopPropagation() })   // works unbound
    d.on(s.btn, 'click', () => log.push('b'))
    d.on(s.root, 'click', () => log.push('root'))
    expect(d.dispatch(s.btn, 'click').propagationStopped).toBe(true)
    expect(log).toEqual(['a', 'b'])

    log.length = 0
    d.on(s.btn, 'pointerup', () => { log.push('btn'); s.btn.remove() })
    const off = d.on(s.panel, 'pointerup', () => log.push('panel'))
    d.on(s.root, 'pointerup', () => log.push('root'))
    d.dispatch(s.btn, 'pointerup')
    expect(log).toEqual(['btn', 'panel', 'root'])
    off()
    d.dispatch(s.over, 'pointerup')
    expect(log).toEqual(['btn', 'panel', 'root', 'root'])
  })
  it('does not bubble focus or blur', () => {
    const s = scene(); const d = new EventDispatcher(); const log: string[] = []
    for (const t of ['focus', 'blur'] as const) {
      d.on(s.btn, t, () => log.push(`btn:${t}`)); d.on(s.panel, t, () => log.push(`panel:${t}`))
    }
    d.dispatch(s.btn, 'focus'); d.dispatch(s.btn, 'blur')
    expect(log).toEqual(['btn:focus', 'btn:blur'])
  })
})

describe('PointerTracker semantics', () => {
  it('hovers and presses the whole ancestor chain; enter/leave reach each node once and do not bubble', () => {
    const s = scene(); const d = new EventDispatcher(); const log: string[] = []
    const chain = [s.root, s.panel, s.btn]
    for (const n of chain) {
      d.on(n, 'pointerenter', e => log.push(`enter:${n.id}:${e.target.id}`))
      d.on(n, 'pointerleave', e => log.push(`leave:${n.id}:${e.target.id}`))
    }
    const p = new PointerTracker(s.root, d)
    p.move(100, 80)
    expect(log).toEqual(['enter:root:root', 'enter:panel:panel', 'enter:btn:btn'])
    expect(chain.map(n => n.state.hover)).toEqual([true, true, true])
    p.down(100, 80)
    expect(chain.map(n => n.state.pressed)).toEqual([true, true, true])
    p.up(100, 80)
    expect(chain.map(n => n.state.pressed)).toEqual([false, false, false])
    log.length = 0
    p.move(55, 55)
    expect(log).toEqual(['leave:btn:btn'])
    expect(chain.map(n => n.state.hover)).toEqual([true, true, false])
  })
  it('emits no synthetic move on down, cancel resets press and hover, and a lost up does not leave a node pressed', () => {
    const s = scene(); const d = new EventDispatcher(); const log: string[] = []
    for (const t of ['pointermove', 'pointerdown', 'pointercancel', 'pointerleave'] as const) d.on(s.btn, t, () => log.push(t))
    const p = new PointerTracker(s.root, d)
    p.down(100, 80)
    expect(log).toEqual(['pointerdown'])
    p.cancel()
    expect(log).toEqual(['pointerdown', 'pointercancel', 'pointerleave'])
    expect([p.pressed, p.hovered]).toEqual([null, null])
    expect([s.btn.state.pressed, s.btn.state.hover, s.root.state.hover]).toEqual([false, false, false])
    p.down(100, 80); p.down(55, 55)
    expect(s.btn.state.pressed).toBe(false)
    expect(p.pressed?.id).toBe('panel')
  })
})
