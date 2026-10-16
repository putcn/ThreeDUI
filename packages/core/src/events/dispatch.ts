import type { Node } from '../node'
import { defaultTheme, type Theme } from '../style/theme'
import { absoluteRect, hitTest, pointerReachable } from './hit'

/** Every event type, in one list the type is read from (a renderer maps `onClick` → `'click'` against it). */
export const UI_EVENT_TYPES = ['pointerdown', 'pointerup', 'pointermove', 'pointerenter', 'pointerleave', 'pointercancel', 'click', 'dblclick', 'contextmenu', 'wheel', 'keydown', 'keyup', 'focus', 'blur', 'press', 'change'] as const
export type UIEventType = typeof UI_EVENT_TYPES[number]
export type PointerType = 'mouse' | 'touch' | 'pen' | 'xr'
export interface UIEvent {
  type: UIEventType; target: Node; currentTarget: Node
  /** Surface pt. */
  x: number; y: number
  /** Relative to `currentTarget`'s absolute rect. */
  localX: number; localY: number
  pointerType: PointerType
  key?: string; deltaX?: number; deltaY?: number
  /**
   * The 3D object the pointer is on (a three.js `Object3D` attached to the target or an ancestor, typed `unknown` here:
   * core does not know three); absent unless the pointer is on one.
   */
  object?: unknown
  /** Which instance of `object` the pointer is on, when `object` is instanced (a three.js `InstancedMesh`); absent otherwise. */
  instanceId?: number
  /**
   * Where the pointer is on the canvas, CSS px from its top-left: unlike `x`/`y` (the point on the Surface, or on a 3D
   * object, taken onto it) it moves only with the pointer, so it suits drags. Set on events a pointer caused (by the
   * renderer's bridge); absent on the others (keys, focus) and wherever the caller gave none.
   */
  screenX?: number; screenY?: number
  propagationStopped: boolean
  /** Lets the remaining listeners on the current node run, then stops bubbling (DOM semantics). */
  stopPropagation(): void
}
export type Listener = (e: UIEvent) => void

/** Like the DOM's, these reach only their target (the tracker sends enter/leave to every node entered or left). */
const NON_BUBBLING: ReadonlySet<UIEventType> = new Set(['pointerenter', 'pointerleave', 'focus', 'blur'])

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
   * Runs `type`'s listeners on `target`, then its element handler (`Node.handlers`), then the same on each ancestor
   * (except non-bubbling types). `stopPropagation` stops after the current node, its handler included.
   * The path is captured before any listener runs, so listeners that move or remove nodes do not change it;
   * listeners or a handler added or removed on a node during its turn take effect from the next dispatch.
   */
  dispatch(target: Node, type: UIEventType, init: Partial<UIEvent> = {}): UIEvent {
    const e: UIEvent = {
      type, target, currentTarget: target,
      x: init.x ?? 0, y: init.y ?? 0, localX: 0, localY: 0, pointerType: init.pointerType ?? 'mouse',
      ...(init.key !== undefined ? { key: init.key } : {}),
      ...(init.deltaX !== undefined ? { deltaX: init.deltaX } : {}),
      ...(init.deltaY !== undefined ? { deltaY: init.deltaY } : {}),
      ...(init.object !== undefined ? { object: init.object } : {}),
      ...(init.instanceId !== undefined ? { instanceId: init.instanceId } : {}),
      ...(init.screenX !== undefined ? { screenX: init.screenX } : {}),
      ...(init.screenY !== undefined ? { screenY: init.screenY } : {}),
      propagationStopped: false,
      stopPropagation: () => { e.propagationStopped = true },   // a closure, so it also works destructured
    }
    const path: Node[] = [target]
    if (!NON_BUBBLING.has(type)) for (let p = target.parent; p; p = p.parent) path.push(p)
    for (const n of path) {
      const fns = this.listeners.get(n)?.get(type)
      const own = n.handlers.get(type)
      if (fns?.size || own) {
        e.currentTarget = n
        const r = absoluteRect(n); e.localX = e.x - r.x; e.localY = e.y - r.y
        if (fns) for (const fn of [...fns]) fn(e)
        own?.(e)
      }
      if (e.propagationStopped) break
    }
    return e
  }
}

/**
 * Where a pointer landed when it is not for the hit test to say: a 3D object (`object`, a three.js `Object3D`, typed
 * `unknown` in core) that the renderer hit and that is attached to `node`; `instanceId`, the instance hit when the object
 * is instanced (an `InstancedMesh`), absent otherwise.
 */
export interface PointerTarget { node: Node; object: unknown; instanceId?: number }

/** Where the pointer is on the canvas, CSS px from its top-left (`UIEvent.screenX` / `screenY`). */
export interface ScreenPoint { x: number; y: number }

/** A second `click` this soon (ms) after the first, this close (pt), on the same node, also fires `dblclick`. */
const DBLCLICK = { ms: 500, pt: 4 } as const

/**
 * Turns one pointer's move/down/up/cancel (Surface pt) into node events and `state.hover/pressed`.
 * Like CSS `:hover`/`:active`, hover and press cover the hit node and all its ancestors up to `root`;
 * `pointerenter`/`pointerleave` go to each node entered (outermost first) or left (innermost first).
 * As in the DOM, `click` fires on up at the nearest common ancestor of the down and up targets (none when the up
 * misses the tree, or the pressed node has since left it); a `click` on the node the previous one hit, within
 * `DBLCLICK` (time from `opts.now`, default `performance.now()`), is followed by `dblclick` there (a third click starts
 * over). `contextMenu` is a secondary-button press. State is updated through `Node.setState` (which marks the nodes
 * dirty) before events are dispatched, so listeners see it.
 * `move`, `down` and `up` may name a `target` (a 3D object the renderer hit, and the node it is attached to): while
 * `pointerReachable(target.node, root)`, that node is the hit, whatever `hitTest` says at (x, y), and every event the
 * call dispatches carries `object` (and the target's `instanceId`, when it has one); otherwise the hit test decides as
 * usual and no event carries either. `move`, `down`, `up` and `contextMenu` may also name `screen`, the pointer's
 * place on the canvas: every event the call dispatches (and a later `cancel`'s) carries it as `screenX` / `screenY`.
 * Call `cancel()` when the pointer is lost or leaves the Surface.
 */
export class PointerTracker {
  /** Hit node first, then its ancestors up to `root`, as of the last hover / press. */
  private hoverPath: Node[] = []
  private pressPath: Node[] = []
  /**
   * The last position, the 3D object (and instance) it was on and its place on the canvas (each absent when none): the
   * init of every event dispatched.
   */
  private last: { x: number; y: number; pointerType: PointerType; object?: unknown; instanceId?: number; screenX?: number; screenY?: number } = { x: 0, y: 0, pointerType: 'mouse' }
  private lastClick: { node: Node; t: number; x: number; y: number } | null = null
  private readonly now: () => number

  /** What the hit test resolves radius tokens against; the owner replaces it when the theme changes. */
  theme: Theme

  constructor(private readonly root: Node, private readonly d: EventDispatcher, theme: Theme = defaultTheme, opts: { now?: () => number } = {}) {
    this.theme = theme
    this.now = opts.now ?? (() => performance.now())
  }

  get hovered(): Node | null { return this.hoverPath[0] ?? null }
  get pressed(): Node | null { return this.pressPath[0] ?? null }

  move(x: number, y: number, pointerType: PointerType = 'mouse', target?: PointerTarget, screen?: ScreenPoint): void {
    const hit = this.locate(x, y, pointerType, target, screen)
    this.hover(hit)
    if (hit) this.d.dispatch(hit, 'pointermove', this.last)
  }

  down(x: number, y: number, pointerType: PointerType = 'mouse', target?: PointerTarget, screen?: ScreenPoint): void {
    const hit = this.locate(x, y, pointerType, target, screen)
    this.hover(hit)
    this.release()   // a press whose up was lost
    if (!hit) return
    this.pressPath = this.pathTo(hit)
    for (const n of this.pressPath) n.setState({ pressed: true })
    this.d.dispatch(hit, 'pointerdown', this.last)
  }

  up(x: number, y: number, pointerType: PointerType = 'mouse', target?: PointerTarget, screen?: ScreenPoint): void {
    const hit = this.locate(x, y, pointerType, target, screen)
    const was = this.pressed
    this.release()
    this.hover(hit)
    if (hit) this.d.dispatch(hit, 'pointerup', this.last)
    const clicked = was && hit ? this.commonAncestor(was, hit) : null
    if (!clicked) return
    const t = this.now(), prev = this.lastClick, at = this.last   // read before listeners can move the pointer
    const double = prev !== null && prev.node === clicked && t - prev.t <= DBLCLICK.ms && Math.hypot(x - prev.x, y - prev.y) <= DBLCLICK.pt
    this.lastClick = double ? null : { node: clicked, t, x, y }
    this.d.dispatch(clicked, 'click', at)
    if (double) this.d.dispatch(clicked, 'dblclick', at)
  }

  /** A secondary-button press: `contextmenu` at the hit node; no press state (the DOM presses nothing either). */
  contextMenu(x: number, y: number, pointerType: PointerType = 'mouse', screen?: ScreenPoint): void {
    const hit = this.locate(x, y, pointerType, undefined, screen)
    if (hit) this.d.dispatch(hit, 'contextmenu', this.last)
  }

  /** Drops the press (`pointercancel` to the pressed node) and the hover (`pointerleave`s), at the last position. */
  cancel(): void {
    const was = this.pressed
    this.release()
    if (was) this.d.dispatch(was, 'pointercancel', this.last)
    this.hover(null)
  }

  /**
   * The node at (x, y), or `target`'s while it is reachable (then `last` carries its object and instance); records
   * `last`, with `screen` when given.
   */
  private locate(x: number, y: number, pointerType: PointerType, target?: PointerTarget, screen?: ScreenPoint): Node | null {
    const at = screen ? { screenX: screen.x, screenY: screen.y } : {}
    if (target && pointerReachable(target.node, this.root)) {
      this.last = { x, y, pointerType, object: target.object, ...(target.instanceId !== undefined ? { instanceId: target.instanceId } : {}), ...at }
      return target.node
    }
    this.last = { x, y, pointerType, ...at }
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
    for (const n of left) n.setState({ hover: false })
    for (const n of entered) n.setState({ hover: true })
    for (const n of left) this.d.dispatch(n, 'pointerleave', this.last)
    for (const n of entered) this.d.dispatch(n, 'pointerenter', this.last)
  }

  private release(): void {
    for (const n of this.pressPath) n.setState({ pressed: false })
    this.pressPath = []
  }
}
