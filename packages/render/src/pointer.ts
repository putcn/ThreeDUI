import { Matrix4, Plane, Ray, Raycaster, Vector2, Vector3, type Camera, type Intersection, type Object3D } from 'three'
import { scrollOffset, type Node, type PointerKeys, type PointerTarget, type PointerType, type ScreenPoint } from '@glassui/core'
import type { Surface } from './surface/surface'
import type { Viewport3DAttachment } from './viewport'

/**
 * `target`: present when the ray hit a 3D object attached to a node (`Surface.attach3D`), naming the node, the object
 * hit, the instance hit (`instanceId`) when the object is an `InstancedMesh`, and the hit point in the attachment
 * anchor's frame (`point`, pt).
 */
export interface SurfaceHit { surface: Surface; x: number; y: number; distance: number; target?: PointerTarget }

/** `o` and every ancestor are visible (three's raycaster does not check this). */
function shown(o: Object3D | null): boolean {
  for (; o; o = o.parent) if (!o.visible) return false
  return true
}

/** Hits this much (relative) apart are one plane: coplanar Surfaces, e.g. a screen layer's. */
const COPLANAR = 1e-6

const surfaceOf = (h: Intersection): Surface => h.object.userData.surface as Surface

/**
 * The nearest content-quad hit among the shown, interactive, error-free `surfaces` whose Surface takes the pointer at
 * the hit point (`Surface.takesPointer`), converted with `pointFromUV`; null when none does (the pointer is the host
 * app's). Coplanar hits (the screen layer's Surfaces share one plane) are tried from the highest `drawOrder` down: the
 * one drawn on top first. A hit its Surface does not take (an empty area of a bare 'none' Surface, e.g. a full-screen
 * HUD) falls through to the next. Reads the meshes' current `matrixWorld` (the root updates them each tick before routing).
 *
 * The same Surfaces' 3D attachments (`Surface.viewports`, shown anchors only) are raycast too, recursively, and only
 * where every ancestor of the object hit is visible: the nearest such hit wins over the quad hit when it is nearer, or
 * when no quad hit was taken (a 3D object takes the pointer even over an empty area of a 'none' Surface). It carries
 * `target` (the attached node, the object hit, for an `InstancedMesh` the instance hit, and `point`: the hit point in the
 * anchor's frame, the object's box centre on its face, 1 unit = 1 pt; spatial spec §12.3), and its (x, y) is the hit
 * point taken into the content quad's space (straight down onto the content plane), through `pointFromUV`.
 */
export function hitSurfaces(raycaster: Raycaster, surfaces: readonly Surface[]): SurfaceHit | null {
  const eligible = surfaces.filter(s => s.interactive && !s.error && shown(s.contentMesh))
  const quad = hitQuads(raycaster, eligible), solid = hitViewports(raycaster, eligible)
  return solid && (!quad || solid.distance < quad.distance) ? solid : quad
}

/** The content-quad part of `hitSurfaces`. */
function hitQuads(raycaster: Raycaster, surfaces: readonly Surface[]): SurfaceHit | null {
  const hits = raycaster.intersectObjects(surfaces.map(s => s.contentMesh), false)
  for (let i = 0; i < hits.length;) {
    // the coplanar group starting at hit i, on top first (a stable sort: ties keep the raycaster's order)
    const near = hits[i]!.distance
    let j = i + 1
    while (j < hits.length && hits[j]!.distance - near <= COPLANAR * Math.max(1, near)) j++
    const group = hits.slice(i, j).sort((a, b) => surfaceOf(b).drawOrder - surfaceOf(a).drawOrder)
    for (const h of group) {
      if (!h.uv) continue
      const surface = surfaceOf(h)
      const [x, y] = surface.pointFromUV(h.uv.x, h.uv.y)
      if (surface.takesPointer(x, y)) return { surface, x, y, distance: h.distance }
    }
    i = j
  }
  return null
}

const hitPoint = new Vector3()

/** The 3D-attachment part of `hitSurfaces`: the nearest visible object hit under a shown anchor of `surfaces`. */
function hitViewports(raycaster: Raycaster, surfaces: readonly Surface[]): SurfaceHit | null {
  const owner = new Map<Viewport3DAttachment, Surface>(), anchors: Object3D[] = []
  for (const s of surfaces) for (const a of s.viewports.values()) if (shown(a.anchor)) { owner.set(a, s); anchors.push(a.anchor) }
  if (!anchors.length) return null
  for (const h of raycaster.intersectObjects(anchors, true)) {
    if (!shown(h.object)) continue   // three does not skip hidden descendants
    // up to its anchor (an object's own `userData.viewport`, if it has one, is not ours)
    let a: Viewport3DAttachment | undefined, surface: Surface | undefined
    for (let o: Object3D | null = h.object; o && !surface; o = o.parent) { a = o.userData.viewport as Viewport3DAttachment | undefined; surface = a && owner.get(a) }
    if (!a || !surface) continue
    const point = a.anchor.worldToLocal(hitPoint.copy(h.point)).toArray()
    const at = surface.contentMesh.worldToLocal(hitPoint.copy(h.point))
    const [x, y] = surface.pointFromUV(at.x + 0.5, at.y + 0.5)
    const target: PointerTarget = { node: a.node, object: h.object, ...(h.instanceId !== undefined ? { instanceId: h.instanceId } : {}), point }
    return { surface, x, y, distance: h.distance, target }
  }
  return null
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
  clientX?: number; clientY?: number; pointerType?: string; pointerId?: number; isPrimary?: boolean; button?: number; buttons?: number
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
 * One pointer, as the trackers model it: secondary pointers (`isPrimary: false`) are ignored. A primary-button down
 * presses and focuses (`FocusManager.focusFromPointer`: the nearest focusable at or above the pressed node, without the
 * ring; none blurs); a right-button down only dispatches `contextmenu` at the hit node (no press, no capture, focus and
 * `active` unchanged); other buttons are ignored. A press captures (as `setPointerCapture` does in the DOM): until
 * up/cancel, moves and the up go to the pressed Surface (`active`) at the ray's point on its content plane, even off
 * its quad or over another Surface, and no other Surface is hovered. Otherwise moves hover the Surface under the
 * pointer (`hovered`; `hitSurfaces`: an empty area of a bare 'none' Surface lets the pointer through), and the one left
 * behind gets its hover cleared. Keys go to `active`, the Surface last pressed (pressing another Surface, or nothing,
 * blurs its focus), or the one `setActive` named (a dialog); before any press, the topmost interactive Surface is
 * adopted. Tab steps through its focusables and is prevented, except past the last (Shift+Tab: before the first), which
 * blurs and lets the browser move focus out of the canvas — unless the Surface traps focus (`Surface.trapFocus`, a modal
 * dialog): then Tab wraps to the first (Shift+Tab to the last), is always prevented and never leaves.
 * A hit on a 3D object (`SurfaceHit.target`) hands the tracker of the Surface it belongs to its node and object with
 * the move, down or up (the node takes the event while it can take the pointer, and the event carries `object`, the
 * hit `point`, and `instanceId` for an instanced one); a press captured by another Surface gets none.
 * A wheel goes to the node under the pointer: unless a press holds the capture (then to its Surface's hovered node), it
 * first hovers there as a move would (enters and leaves, and a `pointermove`), since the Surfaces may have moved under a
 * still pointer since the last move; over no Surface it clears the hover and goes nowhere.
 * Every pointer event it dispatches (moves, enters and leaves, presses, clicks, `contextmenu`, `wheel`, a cancel)
 * carries the pointer's place on the canvas, CSS px from its top-left, as `screenX` / `screenY`, and the DOM event's
 * `buttons` and `shiftKey` when it had them (spatial spec §12.5: a right drag, which presses nothing, is moves with
 * `buttons & 2`).
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

  /** The event's place on the canvas, CSS px from its top-left. */
  private screenOf(e: BridgeEvent): ScreenPoint {
    const r = this.opts.canvas.getBoundingClientRect()
    return { x: (e.clientX ?? 0) - r.left, y: (e.clientY ?? 0) - r.top }
  }

  /** Surface pt of the cast on `s`: the quad hit when it is `s`'s, else the content-plane point (null: no point). */
  private pointOn(s: Surface, hit: SurfaceHit | null): [number, number] | null {
    return hit?.surface === s ? [hit.x, hit.y] : pointOnSurfacePlane(this.raycaster.ray, s)
  }

  /** The 3D object hit, for `s`'s tracker: only when the hit is on `s` (a press captured by another Surface gets none). */
  private targetOn(s: Surface, hit: SurfaceHit | null): PointerTarget | undefined {
    return hit?.surface === s ? hit.target : undefined
  }

  /** Makes `s` the hovered Surface, clearing the hover (and press-glow point) of the one it replaces (its leaves at `screen`, with `keys`). */
  private hover(s: Surface | null, type: PointerType, screen: ScreenPoint, keys?: PointerKeys): void {
    const prev = this.hovered
    if (prev && prev !== s) { prev.pointer.move(FAR, FAR, type, undefined, screen, keys); prev.setPointer(null) }
    this.hovered = s
  }

  /**
   * Makes `s` the Surface that receives the keys (a dialog that opens takes them), as a press on it would. Moving to
   * another Surface (or none) blurs the old one's focus: one focused node per canvas. A press the old one holds is
   * cancelled (`pointercancel`), since the capture is `active`'s and the rest of that press would reach `s`; so is
   * the press being dispatched when a `pointerdown` listener calls this (no focus, no capture for it).
   */
  setActive(s: Surface | null): void {
    if (this.active === s) return
    if (this.pressing) { this.active?.pointer.cancel(); this.pressing = false }
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
    // the pointer's place on the canvas, and the buttons and Shift held, as the DOM event has them (keys have none:
    // their cases never read them)
    const at = KEY_TYPES.includes(type) ? { x: 0, y: 0 } : this.screenOf(e)
    const keys: PointerKeys = { ...(e.buttons !== undefined ? { buttons: e.buttons } : {}), ...(e.shiftKey !== undefined ? { shiftKey: e.shiftKey } : {}) }
    switch (type) {
      case 'pointermove': {
        const hit = this.cast(e)
        const s = this.pressing ? this.active : hit?.surface ?? null
        this.hover(s, ptype, at, keys)
        const pt = s && this.pointOn(s, hit)
        if (s && pt) { s.setPointer(pt); s.pointer.move(pt[0], pt[1], ptype, this.targetOn(s, hit), at, keys) }
        break
      }
      case 'pointerdown': {
        if (e.button === 2) {
          // a chorded button arrives as a move, so a held press here lost its up: drop it
          if (this.pressing) { this.active?.pointer.cancel(); this.pressing = false }
          const hit = this.cast(e)
          if (hit) hit.surface.pointer.contextMenu(hit.x, hit.y, ptype, at, keys)
          break
        }
        if (e.button !== undefined && e.button !== 0) break
        const hit = this.cast(e)
        // a held press whose up was lost: its tracker releases it on a down of its own, another Surface's cannot
        if (this.pressing && this.active !== hit?.surface) this.active?.pointer.cancel()
        this.pressing = false
        this.setActive(hit?.surface ?? null)
        this.hover(hit?.surface ?? null, ptype, at, keys)
        if (!hit) break
        hit.surface.setPointer([hit.x, hit.y]); hit.surface.pointer.down(hit.x, hit.y, ptype, hit.target, at, keys)
        // a pointerdown listener moved the keys elsewhere (`setActive`: a dialog opened): the press is over, nothing
        // to focus or capture here
        if (this.active !== hit.surface) { hit.surface.pointer.cancel(); hit.surface.setPointer(null); break }
        hit.surface.focus.focusFromPointer(hit.surface.pointer.pressed)
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
        if (s) { const [x, y] = this.pointOn(s, hit) ?? [FAR, FAR]; s.pointer.up(x, y, ptype, this.targetOn(s, hit), at, keys) }
        // the tracker re-hovered `s` at the up; once released, a Surface it is not over loses the hover
        this.hover(hit?.surface === s ? s : null, ptype, at, keys)
        if (captured && e.pointerId !== undefined) this.opts.canvas.releasePointerCapture?.(e.pointerId)
        break
      }
      case 'pointercancel': {
        if (this.pressing) this.active?.pointer.cancel()
        this.pressing = false
        this.hover(null, ptype, at, keys)
        break
      }
      case 'pointerleave': {   // the pointer left the canvas; a captured press keeps receiving its moves
        if (!this.pressing) this.hover(null, ptype, at, keys)
        break
      }
      case 'wheel': {
        const hit = this.cast(e)
        // a press holds the capture: its Surface's hover stands. Otherwise the wheel first hovers where it is, as a move
        // there would: a Surface may have moved under a still pointer (a Block flying in), leaving the hover stale
        const s = this.pressing ? this.active : hit?.surface ?? null
        if (!this.pressing) {
          this.hover(s, ptype, at, keys)
          const pt = s && this.pointOn(s, hit)
          if (s && pt) { s.setPointer(pt); s.pointer.move(pt[0], pt[1], ptype, this.targetOn(s, hit), at, keys) }
        }
        const target = s && (s.pointer.hovered ?? s.root)
        if (!s || !target) break
        const scrolled = applyWheel(target, finite(e.deltaX), finite(e.deltaY))
        const [x, y] = this.pointOn(s, hit) ?? [0, 0]
        s.events.dispatch(target, 'wheel', { x, y, deltaX: finite(e.deltaX), deltaY: finite(e.deltaY), pointerType: ptype, screenX: at.x, screenY: at.y, ...keys })
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
          // the way out: Tab past the last focusable (Shift+Tab before the first) blurs, and the browser moves focus on;
          // a Surface that traps focus has none: the focus manager's step wraps around instead
          const list = s.focus.focusables(), cur = s.focus.current
          if (!s.trapFocus && cur && cur === (e.shiftKey ? list[0] : list[list.length - 1])) { s.focus.focus(null); break }
          s.focus.key(e.shiftKey ? 'Shift+Tab' : 'Tab', true)
          if (s.focus.current || s.trapFocus) e.preventDefault?.()   // nothing to focus: Tab leaves the canvas too, unless trapped
          break
        }
        s.focus.key(tab && e.shiftKey ? 'Shift+Tab' : e.key, down)
        break
      }
    }
  }
}
