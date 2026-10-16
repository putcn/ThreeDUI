import { Group, Line, Mesh, SRGBColorSpace } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { resolveColor, type RGBA, type Spring } from '@glassui/core'
import type { CanvasFactory } from '@glassui/text'
import type { Viewport3DContext } from '../viewport'
import { disposeTextPlane, recolorTextPlane, textPlane, textPlaneHeight, type TextPlane, type TextPlaneOptions } from './labels'

/**
 * The frame the 3D charts share (spatial spec §12): a grid lying back like a tabletop on a thin translucent plate, its
 * labels lying on the plate, the whole seated on the glass. `SurfaceChart` and `BarMatrix` are built on it, so they read
 * as one family: the same tilt, seat, plate and label style. pt unless noted.
 */
export const FRAME = {
  /** Radians about x: the grid lies back like a tabletop, its heights standing toward the viewer. */
  tilt: -0.9,
  /** How far over the glass the chart's lowest point sits. */
  seat: 1,
  /** The base plate: thickness, its margin past the grid where no label is, opacity (of the theme's `fill`), corner radius. */
  plate: { thickness: 3, margin: 12, opacity: 0.55, radius: 1.2 },
  /** The labels lying on the plate: font size, gap from the grid, how far over the plate they lie. */
  label: { size: 15, gap: 8, lift: 0.4 },
} as const

/**
 * The plate's and the labels' own `renderOrder`: the attachment keeps a part's as its place within the viewport's slot
 * (spatial spec §2.3), so the translucent plate draws first, then the labels lying on it, then the chart (0 and up).
 */
export const FRAME_ORDER = { plate: -3, labels: -1 } as const

/** A cell of a chart's grid: `values[row][col]`. */
export interface GridCell { row: number; col: number }

/** The plate: a thin rounded box in the theme's `fill`, translucent. */
export type Plate = Mesh<RoundedBoxGeometry, MeshStandardNodeMaterial>

/** Where a tilted frame goes (`tiltFit`): `y` and `z` its position, `top` its highest point's z (pt off the glass). */
export interface Fit { y: number; z: number; top: number }

const COS = Math.cos(FRAME.tilt), SIN = Math.sin(FRAME.tilt)

/**
 * Where the tilted frame goes for its outline `pts` ((y, z) in the grid's frame: the extremes of its parts): `y` centres
 * them up and down the box, `z` seats the lowest `FRAME.seat` over the glass; `top` is then the highest one's z.
 */
export function tiltFit(pts: readonly (readonly [number, number])[]): Fit {
  let lo = Infinity, hi = -Infinity, near = Infinity, far = -Infinity
  for (const [y, z] of pts) {
    const yy = y * COS - z * SIN, zz = y * SIN + z * COS
    lo = Math.min(lo, yy); hi = Math.max(hi, yy); near = Math.min(near, zz); far = Math.max(far, zz)
  }
  const z = FRAME.seat - near
  return { y: -(lo + hi) / 2, z, top: far + z }
}

/** The z, after the tilt, of the grid-frame point (`y`, `z`): with a `Fit`'s z added, its height off the glass. */
export const tiltedZ = (y: number, z: number): number => y * SIN + z * COS

/** pt: the centre line of the labels under the grid's front edge (`y0`: the grid's half depth), in the grid's frame. */
export const xLabelY = (y0: number): number => -y0 - FRAME.label.gap - FRAME.label.size / 2

/**
 * The tilt's fit (`tiltFit`) of a plate as deep as lying labels can push it around a grid ±`y0` deep (labels under its
 * front edge, labels beside it as far forward and back as its edges), with the chart's own outline `pts`: a bound for
 * a chart's `riseFor`, whatever its data and labels.
 */
export function plateBound(y0: number, pts: readonly (readonly [number, number])[]): Fit {
  const { label: L, plate: P } = FRAME, t = P.thickness, hL = textPlaneHeight(L.size), half = L.gap / 2
  const front = Math.min(-y0 - P.margin, xLabelY(y0) - hL / 2 - half, -y0 - hL / 2 - half)
  const back = Math.max(y0 + P.margin, y0 + hL / 2 + half)
  return tiltFit([[front, -t], [back, -t], [front, 0], [back, 0], ...pts])
}

/** A part the pointer goes through. */
const noRaycast = (): void => {}
/** Names a part that casts no shadow (`userData.noShadow`), with its draw order; the pointer goes through it unless `hit`. */
export function decoration<T extends Mesh | Line>(o: T, name: string, order: number, hit = false): T {
  o.name = name; o.renderOrder = order; o.userData.noShadow = true
  if (!hit) o.raycast = noRaycast
  return o
}

/** A new plate (sized by `fitPlate`): it takes the pointer only when `hit`. */
export function makePlate(hit: boolean): Plate {
  const material = new MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0, transparent: true, opacity: FRAME.plate.opacity, depthWrite: false })
  return decoration(new Mesh(new RoundedBoxGeometry(1, 1, 1), material), 'plate', FRAME_ORDER.plate, hit)
}

/**
 * Sizes `plate` to lie under the grid `x0..x1` × `y0..y1` (`FRAME.plate.margin` past it where no label is) and every
 * shown plane of `labels` (half the label gap past them), its top face at z = 0; its geometry is made again only when
 * its size changes.
 */
export function fitPlate(plate: Plate, grid: { x0: number; x1: number; y0: number; y1: number }, labels: Iterable<TextPlane>): void {
  const M = FRAME.plate.margin, half = FRAME.label.gap / 2, t = FRAME.plate.thickness
  let x0 = grid.x0 - M, x1 = grid.x1 + M, y0 = grid.y0 - M, y1 = grid.y1 + M
  for (const m of labels) {
    if (!m.visible) continue
    m.geometry.computeBoundingBox()
    const b = m.geometry.boundingBox!
    x0 = Math.min(x0, m.position.x + b.min.x - half); x1 = Math.max(x1, m.position.x + b.max.x + half)
    y0 = Math.min(y0, m.position.y + b.min.y - half); y1 = Math.max(y1, m.position.y + b.max.y + half)
  }
  const w = x1 - x0, d = y1 - y0, was = plate.geometry.parameters
  if (was.width !== w || was.height !== d || was.depth !== t) {
    const geometry = new RoundedBoxGeometry(w, d, t, 2, FRAME.plate.radius)
    geometry.translate((x0 + x1) / 2, (y0 + y1) / 2, -t / 2)
    plate.geometry.dispose(); plate.geometry = geometry
  }
}

/**
 * Places the tilted frame `inner`: its lowest point (of the plate's outline and the chart's `pts`, (y, z) in the grid's
 * frame) `FRAME.seat` over the glass, centred up and down the box, and across it on the plate (widened left to
 * `left` when the chart reaches past it).
 */
export function seatFrame(inner: Group, plate: Plate, pts: readonly (readonly [number, number])[], left = Infinity): void {
  plate.geometry.computeBoundingBox()
  const b = plate.geometry.boundingBox!
  const fit = tiltFit([[b.min.y, b.min.z], [b.max.y, b.min.z], [b.min.y, b.max.z], [b.max.y, b.max.z], ...pts])
  inner.position.set(-(Math.min(b.min.x, left) + b.max.x) / 2, fit.y, fit.z)
}

/** A label for the frame: a `textPlane` named `name`, in the labels' draw order, casting no shadow, letting the pointer through. */
export function framePlane(text: string, name: string, opts: TextPlaneOptions): TextPlane {
  return decoration(textPlane(text, opts), name, FRAME_ORDER.labels)
}

/**
 * Brings `planes` to `texts`: frees the planes past them, and makes a plane (`make`) for each text that has none or a
 * different one, freeing the old one; a plane whose text is unchanged is kept (no new texture).
 */
export function syncPlanes(planes: TextPlane[], texts: readonly string[], make: (text: string, i: number) => TextPlane): void {
  for (const m of planes.splice(texts.length)) disposeTextPlane(m)
  texts.forEach((t, i) => {
    const m = planes[i]
    if (m?.userData.text === t) return
    if (m) disposeTextPlane(m)
    planes[i] = make(t, i)
  })
}

/** Shows every `step`-th of the first `count` planes, where `step` keeps neighbours `room` pt apart at `pitch`; hides the rest. */
export function thinPlanes(planes: readonly TextPlane[], count: number, room: (m: TextPlane) => number, pitch: number): void {
  const need = Math.max(0, ...planes.slice(0, count).map(room))
  const step = Math.max(1, Math.ceil(need / pitch))
  planes.forEach((m, i) => { m.visible = i < count && i % step === 0 })
}

/** The frame's theme colours in `ctx`: the labels' (`secondaryLabel`) and the plate's (`fill`), sRGB. */
export function framePalette(ctx: Viewport3DContext): { label: RGBA; fill: RGBA } {
  return { label: resolveColor('secondaryLabel', ctx.theme, ctx.scheme), fill: resolveColor('fill', ctx.theme, ctx.scheme) }
}

/** Colours the plate (`fill`) and every label plane (`label`); the textures stay. */
export function paintFrame(plate: Plate, labels: Iterable<TextPlane>, palette: { label: RGBA; fill: RGBA }): void {
  const { fill, label } = palette
  plate.material.color.setRGB(fill[0], fill[1], fill[2], SRGBColorSpace)
  for (const m of labels) recolorTextPlane(m, label)
}

/**
 * One frame of `dt` s for `springs` that wait `wait` s before they move (a chart's staggered growth): what is left of
 * the wait, whether a value changed, and whether anything still moves (a spring, or the wait). Reduced motion drops
 * the wait and puts each spring on its target.
 */
export function stepSprings(springs: readonly Spring[], wait: number, dt: number, reduced: boolean): { wait: number; changed: boolean; moving: boolean } {
  let changed = false, moving = false, t = dt
  if (reduced) wait = 0
  else if (wait > 0 && dt > 0) { const w = Math.min(wait, dt); wait -= w; t -= w }
  for (const s of springs) {
    if (reduced) { if (s.value !== s.target || s.velocity !== 0) { s.jump(s.target); changed = true } }
    else if (!s.done) { s.step(t); changed = true }
    if (!s.done) moving = true
  }
  return { wait, changed, moving: moving || wait > 0 }
}

/**
 * A chart built in the frame (`SurfaceChart`, `BarMatrix`): a Group to attach with `Surface.attach3D` (its origin the
 * box centre on the glass, 1 unit = 1 pt) holding `inner`, the frame tilted `FRAME.tilt` that its parts are built in
 * and seated by its layout. It keeps the last `update`'s context and whether its layout is stale; `prepare` is the
 * start of every `update`, `invalidate` what a new `set` or `labels` calls.
 */
export abstract class FrameChart extends Group {
  /** The tilted, seated frame the chart is built in. */
  readonly inner = new Group()
  /** What the labels are drawn on (the root's canvas factory). */
  protected readonly createCanvas: CanvasFactory
  /** The last `update`'s context: the box, the motion preference and the theme. */
  protected ctx: Viewport3DContext | null = null
  /** Something the layout depends on changed since the last one (data, labels). */
  protected dirty = true

  constructor(name: string, opts: { createCanvas: CanvasFactory }) {
    super()
    this.createCanvas = opts.createCanvas
    this.name = name; this.inner.name = 'tilt'
    this.inner.rotation.x = FRAME.tilt
    this.add(this.inner)
  }

  /** Whether there is data to draw (set, and not disposed since). */
  protected abstract hasData(): boolean
  /** Follows the theme's colours in `ctx`. */
  protected abstract paint(ctx: Viewport3DContext): void
  /** Lays the chart out in `ctx`'s box (nothing before data and a box with an area); clears `dirty`. */
  protected abstract layout(ctx: Viewport3DContext): void

  /** The layout is stale (new data or labels): laid out now when an `update` has told the box, else at the next one. */
  protected invalidate(): void {
    this.dirty = true
    if (this.ctx) this.layout(this.ctx)
  }

  /**
   * The start of every `update` in `ctx`'s box: keeps `ctx`, hides `inner` in a box with no area, follows the theme's
   * colours and lays out again when the box, the data or the labels changed. False when there is nothing to draw (no
   * data, an empty box): `update` then returns false.
   */
  protected prepare(ctx: Viewport3DContext): boolean {
    const resized = ctx.width !== this.ctx?.width || ctx.height !== this.ctx?.height
    this.ctx = ctx
    if (!this.hasData()) return false
    this.inner.visible = ctx.width > 0 && ctx.height > 0
    if (!this.inner.visible) return false
    this.paint(ctx)
    if (resized || this.dirty) this.layout(ctx)
    return true
  }
}
