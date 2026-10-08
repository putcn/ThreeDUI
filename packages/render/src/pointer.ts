import { Matrix4, Plane, Ray, Raycaster, Vector2, Vector3, type Camera, type Object3D } from 'three'
import { scrollOffset, type Node, type PointerType } from '@glassui/core'
import type { Surface } from './surface/surface'

export interface SurfaceHit { surface: Surface; x: number; y: number; distance: number }

/** `o` and every ancestor are visible (three's raycaster does not check this). */
function shown(o: Object3D | null): boolean {
  for (; o; o = o.parent) if (!o.visible) return false
  return true
}

/** Hits this much (relative) apart are one plane: coplanar Surfaces, e.g. a screen layer's. */
const COPLANAR = 1e-6

/**
 * The nearest content-quad hit among the shown, interactive, error-free `surfaces`, converted with `pointFromUV`.
 * Coplanar hits (the screen layer's Surfaces share one plane) go to the highest `drawOrder`: the one drawn on top.
 * Reads the meshes' current `matrixWorld` (the root updates them each tick before routing).
 */
export function hitSurfaces(raycaster: Raycaster, surfaces: readonly Surface[]): SurfaceHit | null {
  const targets = surfaces.filter(s => s.interactive && !s.error && shown(s.contentMesh)).map(s => s.contentMesh)
  const hits = raycaster.intersectObjects(targets, false)
  const first = hits[0]
  if (!first) return null
  let best = first, order = (first.object.userData.surface as Surface).drawOrder
  for (let i = 1; i < hits.length; i++) {
    const h = hits[i]!
    if (h.distance - first.distance > COPLANAR * Math.max(1, first.distance)) break
    const o = (h.object.userData.surface as Surface).drawOrder
    if (o > order) { best = h; order = o }
  }
  if (!best.uv) return null
  const surface = best.object.userData.surface as Surface
  const [x, y] = surface.pointFromUV(best.uv.x, best.uv.y)
  return { surface, x, y, distance: best.distance }
}

const contentPlane = new Plane(new Vector3(0, 0, 1), 0), local = new Ray(), p = new Vector3(), inv = new Matrix4()

/**
 * Where `ray` meets the Surface's content plane, as Surface pt, also outside its rect (a drag that leaves the quad);
 * null when the ray is parallel to the plane or points away from it. The content mesh is a unit plane scaled to W×H
 * units at z = `contentPlaneZ`, so in its local space the plane is z = 0 and the hit's uv is (x + ½, y + ½).
 */
export function pointOnSurfacePlane(ray: Ray, surface: Surface): [number, number] | null {
  const m = surface.contentMesh.matrixWorld
  if (m.determinant() === 0) return null
  local.copy(ray).applyMatrix4(inv.copy(m).invert())
  if (!local.intersectPlane(contentPlane, p)) return null
  return surface.pointFromUV(p.x + 0.5, p.y + 0.5)
}

const finite = (v: number | undefined): number => (v !== undefined && Number.isFinite(v) ? v : 0)

/** Scrolls `s` along one axis by `delta`, clamped to `[0, content − viewport]` (content: the max child extent); true if it moved. */
function scrollAxis(s: Node, axis: 'x' | 'y', delta: number): boolean {
  let extent = 0
  for (const c of s.children) extent = Math.max(extent, axis === 'x' ? c.layout.x + c.layout.width : c.layout.y + c.layout.height)
  const max = Math.max(0, extent - (axis === 'x' ? s.layout.width : s.layout.height))
  const from = scrollOffset(s)[axis], to = Math.max(0, Math.min(max, from + delta))
  if (to === from) return false
  s.setProp(axis === 'x' ? 'scrollX' : 'scrollY', to)
  return true
}

/**
 * Scrolls by the wheel delta: on each axis, the nearest `scroll` node at or above `node` that can still move that way
 * (so a vertical wheel over a horizontal carousel scrolls the list around it, as the DOM chains). Writes
 * `props.scrollX/scrollY` through `setProp` (marks paint); a non-finite offset or delta counts as 0. True if anything moved.
 */
export function applyWheel(node: Node, deltaX: number, deltaY: number): boolean {
  let moved = false
  for (const [axis, delta] of [['x', finite(deltaX)], ['y', finite(deltaY)]] as const) {
    if (delta === 0) continue
    for (let s: Node | null = node; s; s = s.parent) if (s.type === 'scroll' && scrollAxis(s, axis, delta)) { moved = true; break }
  }
  return moved
}

export interface CanvasLike {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number }
  addEventListener(type: string, fn: (e: any) => void): void
  removeEventListener(type: string, fn: (e: any) => void): void
  setPointerCapture?(id: number): void
  releasePointerCapture?(id: number): void
  tabIndex?: number
}
/** The fields of a DOM PointerEvent / WheelEvent / KeyboardEvent the bridge reads. */
export interface BridgeEvent {
  clientX?: number; clientY?: number; pointerType?: string; pointerId?: number; isPrimary?: boolean; button?: number
  deltaX?: number; deltaY?: number; key?: string; shiftKey?: boolean; preventDefault?(): void
}
export type BridgeEventType = 'pointermove' | 'pointerdown' | 'pointerup' | 'pointercancel' | 'pointerleave' | 'wheel' | 'keydown' | 'keyup'
const POINTER_TYPES: readonly BridgeEventType[] = ['pointermove', 'pointerdown', 'pointerup', 'pointercancel', 'pointerleave', 'wheel']
const KEY_TYPES: readonly BridgeEventType[] = ['keydown', 'keyup']
/** A Surface pt no node contains: moving a tracker there clears its hover (`pointerleave`s) and keeps its press. */
const FAR = -1e6

/**
 * Spec §7.1/§7.2: DOM pointer, wheel and keyboard events on the canvas → a raycast against the Surface quads → Surface
 * pt → that Surface's core `PointerTracker` / `FocusManager` / `EventDispatcher` (its own raycast; `@pmndrs/pointer-events`
 * can replace `hitSurfaces` for XR rays).
 *
 * One pointer, as the trackers model it: secondary pointers (`isPrimary: false`) and non-primary buttons are ignored.
 * A press captures (as `setPointerCapture` does in the DOM): until up/cancel, moves and the up go to the pressed Surface
 * (`active`) at the ray's point on its content plane, even off its quad or over another Surface, and no other Surface
 * is hovered. Otherwise moves hover the Surface under the pointer (`hovered`), and the one left behind gets its hover
 * cleared. Keys go to `active`, the Surface last pressed (pressing another Surface, or nothing, blurs its focus); before
 * any press, the topmost interactive Surface is adopted. Tab steps through its focusables and is prevented, except past
 * the last (Shift+Tab: before the first), which blurs and lets the browser move focus out of the canvas.
 * `handle` is the testable core; `attach` wires the canvas events to it.
 */
export class PointerBridge {
  /** The Surface last pressed (or adopted by a key): it holds the capture while pressed, and receives the keys. */
  active: Surface | null = null
  /** The Surface whose tracker holds the hover. */
  hovered: Surface | null = null
  private pressing = false
  private readonly raycaster = new Raycaster()
  private readonly ndc = new Vector2()
  private readonly listeners = new Map<BridgeEventType, (e: BridgeEvent) => void>()
  private savedTabIndex: number | undefined

  constructor(private readonly opts: { canvas: CanvasLike; camera: Camera; surfaces: () => readonly Surface[]; keyboard?: boolean }) {}

  /** Listens on the canvas (once); with `keyboard` (default on) also to keys, making the canvas focusable (`tabIndex = 0`). */
  attach(): void {
    if (this.listeners.size) return
    const { canvas, keyboard } = this.opts
    const types = keyboard === false ? POINTER_TYPES : [...POINTER_TYPES, ...KEY_TYPES]
    if (keyboard !== false) { this.savedTabIndex = canvas.tabIndex; canvas.tabIndex = 0 }
    for (const t of types) { const fn = (e: BridgeEvent) => this.handle(t, e); this.listeners.set(t, fn); canvas.addEventListener(t, fn) }
  }

  /** Removes the listeners and restores the canvas's `tabIndex`. */
  detach(): void {
    const { canvas, keyboard } = this.opts
    for (const [t, fn] of this.listeners) canvas.removeEventListener(t, fn)
    if (this.listeners.size && keyboard !== false && this.savedTabIndex !== undefined) canvas.tabIndex = this.savedTabIndex
    this.listeners.clear()
  }

  /** Drops every reference to `s` (a Surface being removed): its capture, hover and keyboard. */
  forget(s: Surface): void {
    if (this.active === s) { this.active = null; this.pressing = false }
    if (this.hovered === s) this.hovered = null
  }

  /** Casts the event's ray (left in `raycaster.ray`) and hits the Surfaces. */
  private cast(e: BridgeEvent): SurfaceHit | null {
    const r = this.opts.canvas.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) return null
    this.ndc.set(((e.clientX ?? 0) - r.left) / r.width * 2 - 1, -((e.clientY ?? 0) - r.top) / r.height * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.opts.camera)
    return hitSurfaces(this.raycaster, this.opts.surfaces())
  }

  /** Surface pt of the cast on `s`: the quad hit when it is `s`'s, else the content-plane point (null: no point). */
  private pointOn(s: Surface, hit: SurfaceHit | null): [number, number] | null {
    return hit?.surface === s ? [hit.x, hit.y] : pointOnSurfacePlane(this.raycaster.ray, s)
  }

  /** Makes `s` the hovered Surface, clearing the hover (and press-glow point) of the one it replaces. */
  private hover(s: Surface | null, type: PointerType): void {
    const prev = this.hovered
    if (prev && prev !== s) { prev.pointer.move(FAR, FAR, type); prev.setPointer(null) }
    this.hovered = s
  }

  /** Pressing another Surface (or nothing) blurs the old one's focus: one focused node per canvas. */
  private activate(s: Surface | null): void {
    if (this.active === s) return
    this.active?.focus.focus(null)
    this.active = s
  }

  /**
   * The way in for keys before any press (Tab onto the canvas): the topmost shown, interactive, error-free Surface,
   * by `drawOrder` (ties: list order).
   */
  private adopt(): Surface | null {
    let best: Surface | null = null
    for (const s of this.opts.surfaces()) if (s.interactive && !s.error && shown(s.contentMesh) && (!best || s.drawOrder > best.drawOrder)) best = s
    return best
  }

  handle(type: BridgeEventType, e: BridgeEvent): void {
    if (e.isPrimary === false) return
    const ptype: PointerType = e.pointerType === 'touch' || e.pointerType === 'pen' || e.pointerType === 'xr' ? e.pointerType : 'mouse'
    switch (type) {
      case 'pointermove': {
        const hit = this.cast(e)
        const s = this.pressing ? this.active : hit?.surface ?? null
        this.hover(s, ptype)
        const pt = s && this.pointOn(s, hit)
        if (s && pt) { s.setPointer(pt); s.pointer.move(pt[0], pt[1], ptype) }
        break
      }
      case 'pointerdown': {
        if (e.button !== undefined && e.button !== 0) break
        const hit = this.cast(e)
        // a held press whose up was lost: its tracker releases it on a down of its own, another Surface's cannot
        if (this.pressing && this.active !== hit?.surface) this.active?.pointer.cancel()
        this.pressing = false
        this.activate(hit?.surface ?? null)
        this.hover(hit?.surface ?? null, ptype)
        if (!hit) break
        hit.surface.setPointer([hit.x, hit.y]); hit.surface.pointer.down(hit.x, hit.y, ptype)
        this.pressing = true
        if (e.pointerId !== undefined) this.opts.canvas.setPointerCapture?.(e.pointerId)
        break
      }
      case 'pointerup': {
        // pointerup comes with the LAST button released (a chord: left down, right down, left up, right up → button 2),
        // so a held press ends on any button; only a stray up (no press) is filtered like a down
        if (!this.pressing && e.button !== undefined && e.button !== 0) break
        const hit = this.cast(e)
        const s = this.pressing ? this.active : hit?.surface ?? null
        const captured = this.pressing
        this.pressing = false
        if (s) { const [x, y] = this.pointOn(s, hit) ?? [FAR, FAR]; s.pointer.up(x, y, ptype) }
        // the tracker re-hovered `s` at the up; once released, a Surface it is not over loses the hover
        this.hover(hit?.surface === s ? s : null, ptype)
        if (captured && e.pointerId !== undefined) this.opts.canvas.releasePointerCapture?.(e.pointerId)
        break
      }
      case 'pointercancel': {
        if (this.pressing) this.active?.pointer.cancel()
        this.pressing = false
        this.hover(null, ptype)
        break
      }
      case 'pointerleave': {   // the pointer left the canvas; a captured press keeps receiving its moves
        if (!this.pressing) this.hover(null, ptype)
        break
      }
      case 'wheel': {
        const hit = this.cast(e)
        const s = this.hovered ?? hit?.surface ?? null
        const target = s && (s.pointer.hovered ?? s.root)
        if (!s || !target) break
        const scrolled = applyWheel(target, finite(e.deltaX), finite(e.deltaY))
        const [x, y] = this.pointOn(s, hit) ?? [0, 0]
        s.events.dispatch(target, 'wheel', { x, y, deltaX: finite(e.deltaX), deltaY: finite(e.deltaY), pointerType: ptype })
        if (scrolled) e.preventDefault?.()
        break
      }
      case 'keydown': case 'keyup': {
        if (!e.key) break
        const s = this.active ?? this.adopt()
        if (!s) break
        this.active = s
        const tab = e.key === 'Tab', down = type === 'keydown'
        if (tab && down) {
          // the way out: Tab past the last focusable (Shift+Tab before the first) blurs, and the browser moves focus on
          const list = s.focus.focusables(), cur = s.focus.current
          if (cur && cur === (e.shiftKey ? list[0] : list[list.length - 1])) { s.focus.focus(null); break }
          s.focus.key(e.shiftKey ? 'Shift+Tab' : 'Tab', true)
          if (s.focus.current) e.preventDefault?.()   // nothing to focus: Tab leaves the canvas too
          break
        }
        s.focus.key(tab && e.shiftKey ? 'Shift+Tab' : e.key, down)
        break
      }
    }
  }
}
