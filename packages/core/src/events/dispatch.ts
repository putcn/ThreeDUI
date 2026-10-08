import type { Node } from '../node'
import { defaultTheme, type Theme } from '../style/theme'
import { absoluteRect, hitTest } from './hit'

export type UIEventType = 'pointerdown' | 'pointerup' | 'pointermove' | 'pointerenter' | 'pointerleave' | 'pointercancel' | 'click' | 'wheel' | 'keydown' | 'keyup' | 'focus' | 'blur' | 'press' | 'change'
export type PointerType = 'mouse' | 'touch' | 'pen' | 'xr'
export interface UIEvent {
  type: UIEventType; target: Node; currentTarget: Node
  /** Surface pt. */
  x: number; y: number
  /** Relative to `currentTarget`'s absolute rect. */
  localX: number; localY: number
  pointerType: PointerType
  key?: string; deltaX?: number; deltaY?: number
  propagationStopped: boolean
  /** Lets the remaining listeners on the current node run, then stops bubbling (DOM semantics). */
  stopPropagation(): void
}
export type Listener = (e: UIEvent) => void

/** Like the DOM's, these reach only their target; the tracker dispatches them to every node entered or left. */
const NON_BUBBLING: ReadonlySet<UIEventType> = new Set(['pointerenter', 'pointerleave'])

export class EventDispatcher {
  private readonly listeners = new WeakMap<Node, Map<UIEventType, Set<Listener>>>()

  /** Adds `fn` (once; re-adding is a no-op) and returns a function that removes it. */
  on(node: Node, type: UIEventType, fn: Listener): () => void {
    let byType = this.listeners.get(node)
    if (!byType) { byType = new Map(); this.listeners.set(node, byType) }
    let set = byType.get(type)
    if (!set) { set = new Set(); byType.set(type, set) }
    set.add(fn)
    return () => { set.delete(fn) }
  }

  /**
   * Runs `type`'s listeners on `target`, then on each ancestor (except non-bubbling types).
   * The path is captured before any listener runs, so listeners that move or remove nodes do not change it;
   * listeners added or removed on a node during its turn take effect from the next dispatch.
   */
  dispatch(target: Node, type: UIEventType, init: Partial<UIEvent> = {}): UIEvent {
    const e: UIEvent = {
      type, target, currentTarget: target,
      x: init.x ?? 0, y: init.y ?? 0, localX: 0, localY: 0, pointerType: init.pointerType ?? 'mouse',
      ...(init.key !== undefined ? { key: init.key } : {}),
      ...(init.deltaX !== undefined ? { deltaX: init.deltaX } : {}),
      ...(init.deltaY !== undefined ? { deltaY: init.deltaY } : {}),
      propagationStopped: false,
      stopPropagation: () => { e.propagationStopped = true },   // a closure, so it also works destructured
    }
    const path: Node[] = [target]
    if (!NON_BUBBLING.has(type)) for (let p = target.parent; p; p = p.parent) path.push(p)
    for (const n of path) {
      const fns = this.listeners.get(n)?.get(type)
      if (fns?.size) {
        e.currentTarget = n
        const r = absoluteRect(n); e.localX = e.x - r.x; e.localY = e.y - r.y
        for (const fn of [...fns]) fn(e)
      }
      if (e.propagationStopped) break
    }
    return e
  }
}

/**
 * Turns one pointer's move/down/up/cancel (Surface pt) into node events and `state.hover/pressed`.
 * Like CSS `:hover`/`:active`, hover and press cover the hit node and all its ancestors up to `root`;
 * `pointerenter`/`pointerleave` go to each node entered (outermost first) or left (innermost first).
 * As in the DOM, `click` fires on up at the nearest common ancestor of the down and up targets (none when the up
 * misses the tree, or the pressed node has since left it). State is updated before events are dispatched,
 * so listeners see it. Call `cancel()` when the pointer is lost or leaves the Surface.
 */
export class PointerTracker {
  /** Hit node first, then its ancestors up to `root`, as of the last hover / press. */
  private hoverPath: Node[] = []
  private pressPath: Node[] = []
  private last: { x: number; y: number; pointerType: PointerType } = { x: 0, y: 0, pointerType: 'mouse' }

  constructor(private readonly root: Node, private readonly d: EventDispatcher, private readonly theme: Theme = defaultTheme) {}

  get hovered(): Node | null { return this.hoverPath[0] ?? null }
  get pressed(): Node | null { return this.pressPath[0] ?? null }

  move(x: number, y: number, pointerType: PointerType = 'mouse'): void {
    const hit = this.locate(x, y, pointerType)
    this.hover(hit)
    if (hit) this.d.dispatch(hit, 'pointermove', this.last)
  }

  down(x: number, y: number, pointerType: PointerType = 'mouse'): void {
    const hit = this.locate(x, y, pointerType)
    this.hover(hit)
    this.release()   // a press whose up was lost
    if (!hit) return
    this.pressPath = this.pathTo(hit)
    for (const n of this.pressPath) n.state.pressed = true
    this.d.dispatch(hit, 'pointerdown', this.last)
  }

  up(x: number, y: number, pointerType: PointerType = 'mouse'): void {
    const hit = this.locate(x, y, pointerType)
    const was = this.pressed
    this.release()
    this.hover(hit)
    if (hit) this.d.dispatch(hit, 'pointerup', this.last)
    const target = was && hit ? this.commonAncestor(was, hit) : null
    if (target) this.d.dispatch(target, 'click', this.last)
  }

  /** Drops the press (`pointercancel` to the pressed node) and the hover (`pointerleave`s), at the last position. */
  cancel(): void {
    const was = this.pressed
    this.release()
    if (was) this.d.dispatch(was, 'pointercancel', this.last)
    this.hover(null)
  }

  private locate(x: number, y: number, pointerType: PointerType): Node | null {
    this.last = { x, y, pointerType }
    return hitTest(this.root, x, y, this.theme)
  }

  private pathTo(n: Node): Node[] {
    const path: Node[] = []
    for (let p: Node | null = n; p; p = p === this.root ? null : p.parent) path.push(p)
    return path
  }

  /** Nearest node that is `a` or an ancestor of it and also `b` or an ancestor of it, read from the tree as it is now. */
  private commonAncestor(a: Node, b: Node): Node | null {
    const ofB = this.pathTo(b)
    return this.pathTo(a).find(n => ofB.includes(n)) ?? null
  }

  private hover(hit: Node | null): void {
    const prev = this.hoverPath
    const next = hit ? this.pathTo(hit) : []
    const left = prev.filter(n => !next.includes(n))                // innermost first
    const entered = next.filter(n => !prev.includes(n)).reverse()   // outermost first
    this.hoverPath = next
    for (const n of left) n.state.hover = false
    for (const n of entered) n.state.hover = true
    for (const n of left) this.d.dispatch(n, 'pointerleave', this.last)
    for (const n of entered) this.d.dispatch(n, 'pointerenter', this.last)
  }

  private release(): void {
    for (const n of this.pressPath) n.state.pressed = false
    this.pressPath = []
  }
}
