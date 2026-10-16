import { Group, type Material, type Object3D } from 'three'
import { absoluteRect, effectiveStyle, type ColorScheme, type GlassInstance, type Node, type Theme } from '@glassui/core'

/**
 * What `Attach3DOptions.update` is told each tick: the node's box size (pt) and the root's preferences; and `eye`, where
 * the object is seen from when the camera rig focuses its Surface (the focus pose's camera, square in front of the
 * Surface at its fit distance; spatial spec §2.2), in the anchor's frame (pt: x right, y up, z out of the face the box
 * stands on), so a model can fit itself to show inside its box from there. It follows the rest pose, not the moving
 * camera (no parallax, no flight); absent when the root names no view (`Viewport3DStep.focus`). The `eye` tuple is the
 * attachment's own, rewritten every tick: copy its values to keep them.
 */
export interface Viewport3DContext { width: number; height: number; reducedMotion: boolean; theme: Theme; scheme: ColorScheme; eye?: readonly [number, number, number] }
export interface Attach3DOptions {
  /** pt: the most the object rises off the face it stands on, for the shadow-camera fit (`Surface.glassBounds`). Default: the node's width. */
  depth?: number
  /** Called once per tick while the anchor is shown (spatial spec §2.3); true asks for another frame (`Surface.needsFrame`). */
  update?: (dt: number, ctx: Viewport3DContext) => boolean
}

/** What the Surface hands its attachments each tick. */
export interface Viewport3DStep {
  root: Node
  surface: { width: number; height: number; ptPerUnit: number }
  /** The current render list's glass: the faces an object can stand on. */
  glass: readonly GlassInstance[]
  /** The Surface's opacity (`Surface.opacity`). */
  opacity: number
  context: Omit<Viewport3DContext, 'width' | 'height' | 'eye'>
  /** pt: how far in front of the content plane the camera stands at the Surface's focus pose (absent: no view known). */
  focus?: number
}

/** A drawable's or a Group's own values before an attachment adopted it; `users`: the attachments holding it. */
interface DrawRecord { renderOrder: number; castShadow: boolean; users: number }
/** A material's own values; `applied`: the opacity last written (another value there is its owner's new original). */
interface MaterialRecord { opacity: number; transparent: boolean; applied: number; users: number }

/**
 * Keyed by drawable (or Group) and by material, so a value is recorded once however many attachments hold it (a
 * material shared by two objects fades without compounding) and restored when the last one lets go.
 */
const draws = new WeakMap<Object3D, DrawRecord>()
const materials = new WeakMap<Material, MaterialRecord>()

/** The materials `o` draws with (a mesh, line, points or sprite; one or several): none for a group or a bare Object3D. */
function materialsOf(o: Object3D): Material[] {
  const m = (o as { material?: unknown }).material
  return (Array.isArray(m) ? m : [m]).filter((x): x is Material => (x as Material | null | undefined)?.isMaterial === true)
}

const isGroup = (o: Object3D): boolean => (o as Partial<Group>).isGroup === true

/**
 * An adopted drawable's own `renderOrder` survives as its place inside the viewport's slot: the slot's order plus the
 * own one × `step`, the own one clamped to ±`span` (so the slot stays within ±0.1 of `SURFACE_ORDER.viewport`, between
 * the rims and the foreground images). An object with several parts (a chart's plate, surface and hover marks) orders
 * them this way; three would otherwise order equal `renderOrder`s by their distance from the camera.
 */
export const VIEWPORT_ORDER = { step: 1e-3, span: 100 } as const
const slotOrder = (slot: number, own: number): number => slot + Math.max(-VIEWPORT_ORDER.span, Math.min(VIEWPORT_ORDER.span, own)) * VIEWPORT_ORDER.step
/** Whether an adopted drawable casts a shadow: when its attachment's do, unless it opts out (`userData.noShadow === true`). */
const casts = (o: Object3D, on: boolean): boolean => on && o.userData.noShadow !== true

/** `n` is `root` or under it, with no `display: 'none'` on the way (its box is laid out and shown). */
function displayed(n: Node, root: Node): boolean {
  for (let p: Node | null = n; p; p = p.parent) {
    if (effectiveStyle(p).display === 'none') return false
    if (p === root) return true
  }
  return false
}

/** pt above the content plane of the face `n`'s box sits on: its nearest glass ancestor's top (elevation + thickness), else 0. */
function faceUnder(n: Node, glass: readonly GlassInstance[]): number {
  for (let p = n.parent; p; p = p.parent) {
    const g = glass.find(i => i.node === p)
    if (g) return g.elevation + g.params.thickness
  }
  return 0
}

/**
 * A three.js object attached to a layout node of a world Surface (`Surface.attach3D`, spatial spec §2.3). `anchor` is a
 * child of the Surface's content plane holding `object`: its origin at the centre of the node's box, z = 0 on the face
 * the box sits on (`base`), x right, y up, z out, 1 local unit = 1 pt. `step` (every Surface tick, after the render
 * list) places it, runs `update`, then adopts the object; `dispose` (the detach, or the Surface's dispose) undoes both.
 *
 * Adoption, each step so that drawables added later are adopted too: every drawable under `object` (anything with a
 * material) gets `renderOrder` (`SURFACE_ORDER.viewport`: after the Surface's rims, before its foreground images and
 * text; its own `renderOrder` kept as its place within that slot, `VIEWPORT_ORDER`) and `castShadow` (`castShadows`:
 * the Surface's, default true; never for one whose `userData.noShadow` is true); every material `transparent` (the
 * transparent queue, so the order holds; depth write and test untouched), and `opacity` = its own × the Surface's,
 * written only when that changes. A material whose opacity its owner changed takes the new value as its own. The
 * originals are recorded once, and restored when the attachment lets go of them: at `dispose`, or at the first step
 * after they left `object`. Geometries and materials stay the owner's: nothing is disposed.
 *
 * Group order: three sorts draws by the `renderOrder` of the nearest `Group` above them first (the Surface's `layer`
 * carries its `drawOrder` for that), so the anchor and every Group inside `object` (adopted like a drawable) carry
 * `groupOrder`, the Surface's `drawOrder`: the object sorts among its own Surface's draws, not before every Surface.
 */
export class Viewport3DAttachment {
  readonly node: Node
  readonly object: Object3D
  /** Hidden until the first `step` places it, and while the node is out of the Surface's tree or not displayed. */
  readonly anchor = new Group()
  /** `Viewport3DContext.eye`, rewritten each step (no tuple a tick). */
  private readonly eye: [number, number, number] = [0, 0, 0]
  private readonly opts: Attach3DOptions
  private readonly renderOrder: number
  /** What this attachment adopted, with the step that last saw it under `object`. */
  private readonly heldDraws = new Map<Object3D, number>()
  private readonly heldMaterials = new Map<Material, number>()
  private steps = 0
  private face = 0
  private order = 0
  private on = true
  private disposed = false

  /** `renderOrder`: what the drawables get (`SURFACE_ORDER.viewport`); `groupOrder`: the Surface's `drawOrder`. */
  constructor(node: Node, object: Object3D, opts: Attach3DOptions, renderOrder: number, groupOrder: number) {
    this.node = node; this.object = object; this.opts = opts; this.renderOrder = renderOrder
    // the raycast hit's way back (`hitSurfaces`); not enumerable, so `toJSON`/`clone` (which stringify userData) skip it
    Object.defineProperty(this.anchor.userData, 'viewport', { value: this, enumerable: false })
    this.anchor.name = 'viewport'
    this.anchor.visible = false
    this.anchor.add(object)
    this.groupOrder = groupOrder
  }

  /** The Surface's `drawOrder`, on the anchor and every Group adopted (the Surface sets it whenever its own changes). */
  get groupOrder(): number { return this.order }
  set groupOrder(v: number) {
    this.order = v; this.anchor.renderOrder = v
    for (const o of this.heldDraws.keys()) if (isGroup(o)) o.renderOrder = v
  }

  /**
   * Whether its drawables cast shadows (`Surface.castShadows`): set on those adopted, and on those adopted later; one
   * whose `userData.noShadow` is true never does.
   */
  get castShadows(): boolean { return this.on }
  set castShadows(v: boolean) {
    this.on = v
    for (const o of this.heldDraws.keys()) if (!isGroup(o)) o.castShadow = casts(o, v)
  }

  /** pt: `Attach3DOptions.depth`, or the node's current width. */
  get depth(): number { return this.opts.depth ?? this.node.layout.width }
  /** pt above the content plane of the face the object stands on, as of the last `step` (0: the content plane itself). */
  get base(): number { return this.face }

  /**
   * One Surface tick: shows the anchor while the node is under `root` and displayed, and then only places it at the
   * node's box (`absoluteRect`) on its face and calls `update`; last, shown or not, adopts and fades the object, so
   * what `update` wrote or added this tick (an opacity, a new mesh) is faded and sorted in the frame it first draws.
   * True when `update` asked for another frame. A throw from `update` propagates (the Surface fails). Nothing after
   * `dispose`.
   */
  step(dt: number, s: Viewport3DStep): boolean {
    if (this.disposed) return false
    const shown = displayed(this.node, s.root)
    this.anchor.visible = shown
    let more = false
    if (shown) {
      const rect = absoluteRect(this.node), { width: W, height: H, ptPerUnit: ppu } = s.surface
      this.face = faceUnder(this.node, s.glass)
      this.anchor.position.set((rect.x + rect.width / 2 - W / 2) / ppu, (H / 2 - rect.y - rect.height / 2) / ppu, this.face / ppu)
      this.anchor.scale.setScalar(1 / ppu)
      const ctx: Viewport3DContext = { width: rect.width, height: rect.height, reducedMotion: s.context.reducedMotion, theme: s.context.theme, scheme: s.context.scheme }
      if (s.focus !== undefined) {
        // the focus pose's camera, on the Surface's axis: from the anchor (the box centre on its face) back to the centre and out
        const e = this.eye
        e[0] = W / 2 - rect.x - rect.width / 2; e[1] = rect.y + rect.height / 2 - H / 2; e[2] = s.focus - this.face
        ctx.eye = e
      }
      more = this.opts.update?.(dt, ctx) === true
      // `update` may have detached this attachment: then it has restored everything, and must not adopt again
      if (this.disposed) return more
    }
    this.adopt(s.opacity)
    return more
  }

  /** Adopts what is new under `object`, fades every material to `opacity` × its own, and lets go of what left. */
  private adopt(opacity: number): void {
    const now = ++this.steps
    this.object.traverse(o => {
      if (isGroup(o)) {
        if (!this.heldDraws.has(o)) holdDraw(o, this.order)
        this.heldDraws.set(o, now)
        return
      }
      const mats = materialsOf(o)
      if (!mats.length) return
      if (!this.heldDraws.has(o)) { holdDraw(o, this.renderOrder, true); o.castShadow = casts(o, this.on) }
      this.heldDraws.set(o, now)
      for (const m of mats) {
        if (!this.heldMaterials.has(m)) holdMaterial(m)
        this.heldMaterials.set(m, now)
        const r = materials.get(m)!
        if (m.opacity !== r.applied) r.opacity = m.opacity   // its owner set a new opacity: that is its own now
        const want = r.opacity * opacity
        if (m.opacity !== want) m.opacity = want
        r.applied = want
      }
    })
    for (const [o, seen] of this.heldDraws) if (seen !== now) { releaseDraw(o); this.heldDraws.delete(o) }
    for (const [m, seen] of this.heldMaterials) if (seen !== now) { releaseMaterial(m); this.heldMaterials.delete(m) }
  }

  /** Restores every value adopted, takes the object off the anchor and the anchor off the plane. Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const o of this.heldDraws.keys()) releaseDraw(o)
    for (const m of this.heldMaterials.keys()) releaseMaterial(m)
    this.heldDraws.clear(); this.heldMaterials.clear()
    if (this.object.parent === this.anchor) this.anchor.remove(this.object)
    this.anchor.removeFromParent()
  }
}

/**
 * Records `o`'s order and shadow once (`releaseDraw` restores them), then gives it `renderOrder`: as is (a Group's), or
 * with its own order kept as its place in that slot (`slot`: a drawable's, `VIEWPORT_ORDER`).
 */
function holdDraw(o: Object3D, renderOrder: number, slot = false): void {
  let r = draws.get(o)
  if (!r) {
    r = { renderOrder: o.renderOrder, castShadow: o.castShadow, users: 0 }
    draws.set(o, r)
    o.renderOrder = slot ? slotOrder(renderOrder, r.renderOrder) : renderOrder
  }
  r.users++
}

function releaseDraw(o: Object3D): void {
  const r = draws.get(o)
  if (!r || --r.users > 0) return
  draws.delete(o)
  o.renderOrder = r.renderOrder; o.castShadow = r.castShadow
}

function holdMaterial(m: Material): void {
  let r = materials.get(m)
  if (!r) {
    r = { opacity: m.opacity, transparent: m.transparent, applied: m.opacity, users: 0 }
    materials.set(m, r)
    if (!m.transparent) { m.transparent = true; m.needsUpdate = true }
  }
  r.users++
}

function releaseMaterial(m: Material): void {
  const r = materials.get(m)
  if (!r || --r.users > 0) return
  materials.delete(m)
  if (m.opacity === r.applied) m.opacity = r.opacity   // otherwise its owner set a newer one since: it stays
  if (m.transparent !== r.transparent) { m.transparent = r.transparent; m.needsUpdate = true }
}
