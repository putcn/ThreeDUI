import { describe, it, expect, beforeAll } from 'vitest'
import { Node } from '../src/node'
import { GlassUIError } from '../src/errors'
import { defaultTheme, type Theme } from '../src/style/theme'
import { createYogaLayout, type LayoutEngine } from '../src/layout/yoga'
import { absoluteRect, hitTest, pointerReachable } from '../src/events/hit'
import { EventDispatcher, PointerTracker, type UIEvent } from '../src/events/dispatch'
import { createSurface } from '../src/surface'
import { validateStyle } from '../src/style/schema'

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
  const d = new EventDispatcher(), tracker = new PointerTracker(root, d)
  return { root, panel, btn, over, ghost, hidden, d, tracker }
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
  it("pointerEvents 'box-none': the node itself is never hit, its children are", () => {
    const root = box({ width: 100, height: 100 }, 'root')
    const layer = box({ position: 'absolute', inset: 0, pointerEvents: 'box-none', bg: 'fill' }, 'layer')
    const badge = box({ position: 'absolute', left: 10, top: 10, width: 20, height: 20 }, 'badge')
    const inner = box({ width: 10, height: 10 }, 'inner')
    root.appendChild(layer); layer.appendChild(badge); badge.appendChild(inner)
    engine.compute(root, 100, 100)
    expect(hitTest(root, 60, 60)?.id).toBe('root')     // the layer's own area: through to what is below it
    expect(hitTest(root, 25, 25)?.id).toBe('badge')    // a child: hit
    expect(hitTest(root, 12, 12)?.id).toBe('inner')    // and a grandchild
    expect(hitTest(layer, 60, 60)).toBeNull()          // as the test's root too
    layer.setStyle({ pointerEvents: undefined, hover: { pointerEvents: 'box-none' } })
    expect(hitTest(root, 60, 60)?.id).toBe('layer')
    layer.setState({ hover: true })                    // read from the effective style, like 'none'
    expect(hitTest(root, 60, 60)?.id).toBe('root')
  })
  it("pointerEvents 'box-none' passes on what it inherits: inside a 'none' ancestor its children stay transparent", () => {
    const root = box({ width: 100, height: 100 }, 'root')
    const off = box({ position: 'absolute', inset: 0, pointerEvents: 'none' }, 'off')
    const layer = box({ position: 'absolute', inset: 0, pointerEvents: 'box-none' }, 'layer')
    const badge = box({ position: 'absolute', left: 10, top: 10, width: 20, height: 20 }, 'badge')
    const hot = box({ position: 'absolute', left: 60, top: 60, width: 20, height: 20, pointerEvents: 'auto' }, 'hot')
    root.appendChild(off); off.appendChild(layer); layer.appendChild(badge); layer.appendChild(hot)
    engine.compute(root, 100, 100)
    expect(hitTest(root, 15, 15)?.id).toBe('root')     // badge inherits 'none' from above the layer
    expect(hitTest(root, 65, 65)?.id).toBe('hot')      // an explicit 'auto' below still opts back in
    off.setStyle({ pointerEvents: 'auto' })
    expect(hitTest(root, 15, 15)?.id).toBe('badge')
  })
  it("validates pointerEvents: 'auto', 'none' and 'box-none'", () => {
    expect(validateStyle({ pointerEvents: 'box-none' })).toEqual({ pointerEvents: 'box-none' })
    expect(() => validateStyle({ pointerEvents: 'box-only' })).toThrow(/\[style\.pointerEvents\].*box-none/)
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

describe('3D targets (Plan 3 Task 9C)', () => {
  it('pointerReachable: none or display none on the path blocks; box-none does not; outside the root is unreachable', () => {
    const root = new Node('box'), a = new Node('box'), b = new Node('box'); root.appendChild(a); a.appendChild(b)
    expect(pointerReachable(b, root)).toBe(true)
    a.setStyle({ pointerEvents: 'box-none' }); expect(pointerReachable(b, root)).toBe(true)
    a.setStyle({ pointerEvents: 'none' }); expect(pointerReachable(b, root)).toBe(false)
    a.setStyle({ pointerEvents: 'auto', display: 'none' }); expect(pointerReachable(b, root)).toBe(false)
    expect(pointerReachable(new Node('box'), root)).toBe(false)
  })
  it('the tracker honours a reachable target and carries its object on every event', () => {
    const { root, tracker, d } = scene(), target = root.children[0]!, obj = { isObject3D: true }, got: unknown[] = []
    d.on(target, 'pointerenter', e => got.push(['enter', e.object])); d.on(target, 'pointermove', e => got.push(['move', e.object]))
    tracker.move(-1000, -1000, 'mouse', { node: target, object: obj })     // far outside its rect: the target wins
    expect(tracker.hovered).toBe(target); expect(got).toEqual([['enter', obj], ['move', obj]])
  })
  it('an instanced target carries its instanceId on every event; without one the events have no instanceId key', () => {
    const { root, tracker, d } = scene(), target = root.children[0]!, obj = { isObject3D: true }, got: unknown[] = []
    for (const t of ['pointerenter', 'pointermove', 'pointerdown', 'pointerup', 'click'] as const) d.on(target, t, e => got.push([t, e.object, e.instanceId, 'instanceId' in e]))
    tracker.move(-1000, -1000, 'mouse', { node: target, object: obj, instanceId: 7 })
    tracker.down(-1000, -1000, 'mouse', { node: target, object: obj, instanceId: 0 })   // 0 is an instance, not absence
    tracker.up(-1000, -1000, 'mouse', { node: target, object: obj, instanceId: 3 })
    expect(got).toEqual([['pointerenter', obj, 7, true], ['pointermove', obj, 7, true], ['pointerdown', obj, 0, true], ['pointerup', obj, 3, true], ['click', obj, 3, true]])
    got.length = 0
    tracker.move(-1000, -1000, 'mouse', { node: target, object: obj })                   // the same node, a plain object
    expect(got).toEqual([['pointermove', obj, undefined, false]])
    expect('instanceId' in d.dispatch(target, 'click', {})).toBe(false)
  })
})

describe('screen position (Plan 3 Task 9K fix)', () => {
  it('the tracker carries screenX / screenY (canvas CSS px) onto every event of a call that names them', () => {
    const { tracker, d, btn } = scene(), got: unknown[] = []
    for (const t of ['pointerenter', 'pointermove', 'pointerdown', 'pointerup', 'click', 'pointerleave', 'pointercancel', 'contextmenu'] as const) d.on(btn, t, e => got.push([t, e.screenX, e.screenY]))
    tracker.move(70, 70, 'mouse', undefined, { x: 400, y: 300 })
    tracker.down(70, 70, 'mouse', undefined, { x: 401, y: 300 })
    tracker.up(71, 70, 'mouse', undefined, { x: 402, y: 301 })
    tracker.contextMenu(71, 70, 'mouse', { x: 403, y: 302 })
    tracker.down(71, 70, 'mouse', undefined, { x: 404, y: 303 }); tracker.cancel()   // the cancel at the last position
    expect(got).toEqual([
      ['pointerenter', 400, 300], ['pointermove', 400, 300], ['pointerdown', 401, 300], ['pointerup', 402, 301], ['click', 402, 301],
      ['contextmenu', 403, 302], ['pointerdown', 404, 303], ['pointercancel', 404, 303], ['pointerleave', 404, 303],
    ])
  })
  it('a call that names none leaves both keys absent (as do events no pointer caused)', () => {
    const { root, tracker, d, btn } = scene(), seen: UIEvent[] = []
    d.on(btn, 'pointermove', e => seen.push(e)); d.on(btn, 'click', e => seen.push(e))
    tracker.move(70, 70, 'mouse', undefined, { x: 1, y: 2 })
    tracker.move(70, 70); tracker.down(70, 70); tracker.up(70, 70)
    expect(seen.slice(1).map(e => ['screenX' in e, 'screenY' in e])).toEqual([[false, false], [false, false]])
    expect('screenX' in d.dispatch(root, 'keydown', { key: 'a' })).toBe(false)
  })
})

describe('element handlers, dblclick and contextmenu (Plan 3 seams)', () => {
  it('runs a node\'s element handler after the dispatcher\'s listeners, bubbling like them', () => {
    const d = new EventDispatcher(), root = new Node('box'), child = new Node('box'); root.appendChild(child)
    const order: string[] = []
    d.on(child, 'click', () => order.push('listener'))
    child.setHandler('click', () => order.push('child handler'))
    root.setHandler('click', e => order.push(`root handler ${e.currentTarget === root}`))
    d.dispatch(child, 'click')
    expect(order).toEqual(['listener', 'child handler', 'root handler true'])
    child.setHandler('click', null); order.length = 0
    d.dispatch(child, 'click')
    expect(order).toEqual(['listener', 'root handler true'])
  })
  it('an element handler sees local coordinates, and stopPropagation in a listener still lets the node\'s own handler run', () => {
    const s = scene(); const d = new EventDispatcher(); const log: string[] = []
    d.on(s.btn, 'click', e => { log.push('listener'); e.stopPropagation() })
    s.btn.setHandler('click', e => log.push(`btn ${e.localX},${e.localY}`))
    s.root.setHandler('click', () => log.push('root'))
    d.dispatch(s.btn, 'click', { x: 70, y: 75 })
    expect(log).toEqual(['listener', 'btn 10,15'])   // the DOM runs every listener of the current node, then stops
    expect([...s.btn.handlers.keys()]).toEqual(['click'])
  })
  it('dblclick after two clicks on one node within 500 ms and 4 pt', () => {
    let t = 0
    const d = new EventDispatcher(), root = new Node('box')
    root.layout = { x: 0, y: 0, width: 100, height: 100 }
    const tr = new PointerTracker(root, d, defaultTheme, { now: () => t })
    const got: string[] = []
    root.setHandler('click', () => got.push('click')); root.setHandler('dblclick', () => got.push('dblclick'))
    tr.down(10, 10); tr.up(10, 10); t = 300; tr.down(12, 11); tr.up(12, 11)
    expect(got).toEqual(['click', 'click', 'dblclick'])
    got.length = 0; t = 2000; tr.down(10, 10); tr.up(10, 10); t = 2700; tr.down(10, 10); tr.up(10, 10)
    expect(got).toEqual(['click', 'click'])                                 // too slow
    got.length = 0; t = 4000; tr.down(10, 10); tr.up(10, 10); t = 4100; tr.down(20, 10); tr.up(20, 10)
    expect(got).toEqual(['click', 'click'])                                 // too far
  })
  it('dblclick needs both clicks on the same node', () => {
    let t = 0
    const s = scene(); const d = new EventDispatcher(); const got: string[] = []
    const tr = new PointerTracker(s.root, d, defaultTheme, { now: () => t })
    s.root.setHandler('dblclick', e => got.push(e.target.id))
    tr.down(100, 61); tr.up(100, 61); t = 100; tr.down(100, 58); tr.up(100, 58)   // btn, then panel (3 pt apart)
    expect(got).toEqual([])
    t = 200; tr.down(100, 58); tr.up(100, 58)
    expect(got).toEqual(['panel'])
  })
  it('contextMenu dispatches contextmenu at the hit node and presses nothing', () => {
    const d = new EventDispatcher(), root = new Node('box'); root.layout = { x: 0, y: 0, width: 100, height: 100 }
    const tr = new PointerTracker(root, d)
    const got: string[] = []; root.setHandler('contextmenu', e => got.push(`${e.x},${e.y}`))
    tr.contextMenu(5, 6)
    expect(got).toEqual(['5,6']); expect(tr.pressed).toBeNull(); expect(root.state.pressed).toBe(false)
    tr.contextMenu(500, 6)                                                  // off the tree: nothing
    expect(got).toEqual(['5,6'])
  })
})

describe('hitTest with concentric radii and scale (Plan 2 seams)', () => {
  const theme = defaultTheme
  it('concentric resolves against the parent radius minus the inset', () => {
    const s = createSurface({ id: 'h', width: 200, height: 200 })
    const card = new Node('box', 'card'); card.setStyle({ position: 'absolute', left: 0, top: 0, width: 200, height: 200, radius: 40 })
    const inner = new Node('box', 'inner'); inner.setStyle({ position: 'absolute', left: 10, top: 10, width: 180, height: 180, radius: 'concentric', bg: 'fill' })
    s.root.appendChild(card); card.appendChild(inner)
    engine.compute(s.root, 200, 200)
    // inner radius = 40 − 10 = 30 (corner centre (40,40)); (14,14) is 36.8 from it: inside the card's 40 corner, outside inner's 30
    expect(hitTest(s.root, 14, 14, theme)?.id).toBe('card')
    expect(hitTest(s.root, 30, 30, theme)?.id).toBe('inner')
  })
  it('a scaled node is hit in its scaled footprint and children follow', () => {
    const s = createSurface({ id: 'h2', width: 200, height: 200 })
    const btn = new Node('box', 'btn'); btn.setStyle({ position: 'absolute', left: 50, top: 50, width: 100, height: 100, scale: 0.5, bg: 'fill' })
    const dot = new Node('box', 'dot'); dot.setStyle({ position: 'absolute', left: 0, top: 0, width: 20, height: 20, bg: 'accent' })
    s.root.appendChild(btn); btn.appendChild(dot)
    engine.compute(s.root, 200, 200)
    // scaled about (100,100): footprint is 75..125; the layout corner (55,55) is now empty
    expect(hitTest(s.root, 55, 55, theme)?.id).toBe(`${s.id}-root`)
    expect(hitTest(s.root, 80, 80, theme)?.id).toBe('dot')   // dot's layout (50..70) maps to 75..85
    expect(hitTest(s.root, 120, 120, theme)?.id).toBe('btn')
  })
  it('visual scale is honoured too', () => {
    const s = createSurface({ id: 'h3', width: 200, height: 200 })
    const btn = new Node('box', 'btn'); btn.setStyle({ position: 'absolute', left: 50, top: 50, width: 100, height: 100, bg: 'fill' })
    s.root.appendChild(btn); engine.compute(s.root, 200, 200)
    btn.setVisual({ scale: 0.5 })
    expect(hitTest(s.root, 55, 55, theme)?.id).toBe(`${s.id}-root`)
  })
  it('a node whose composed transform is singular is skipped with its subtree, not thrown on', () => {
    const s = createSurface({ id: 'h4', width: 200, height: 200 })
    const btn = new Node('box', 'btn'); btn.setStyle({ position: 'absolute', left: 50, top: 50, width: 100, height: 100, bg: 'fill' })
    const dot = new Node('box', 'dot'); dot.setStyle({ position: 'absolute', left: 0, top: 0, width: 20, height: 20, bg: 'accent' })
    s.root.appendChild(btn); btn.appendChild(dot); engine.compute(s.root, 200, 200)
    btn.setVisual({ scale: 0 })   // mid-animation collapse: everything maps to the centre (100,100)
    expect(hitTest(s.root, 100, 100, theme)?.id).toBe(`${s.id}-root`)
    expect(hitTest(s.root, 55, 55, theme)?.id).toBe(`${s.id}-root`)
  })
})
