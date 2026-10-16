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
  /**
   * Seen from its box's focus-pose eye (`Viewport3DContext.eye`), the chart stays this far inside its box on every
   * side (pt), centred in it; it may shrink for that, never grow past its own size.
   */
  margin: 16,
  /** The eye moving less than this share of its distance (a Card rising on hover) does not refit the chart: no breathing. */
  eyeTolerance: 0.02,
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

/** Where a chart is seen from, and its box (pt): what `seatFrame` fits it to (`Viewport3DContext`'s `eye`, `width`, `height`). */
export interface FrameView { eye: readonly [number, number, number]; width: number; height: number }

/**
 * Places the tilted frame `inner` for its outline, the plate's box and the chart's own `pts` ((x, y, z) in the grid's
 * frame: the corners of what it draws at its tallest): the lowest point `FRAME.seat` over the glass, centred up and down
 * the box and across it.
 *
 * With a `view`, the centring is as the eye sees it: what stands toward the eye looks bigger and further from the
 * eye's foot, so a chart in a box off the view's centre would spill past its side. The outline is projected from the
 * eye onto the glass; the frame is moved so that projection is centred in the box and scaled (never past 1) so it, and
 * `reach` (points it reaches only now and then, such as a hovered bar's lift: kept inside, not centred on), keep
 * `FRAME.margin` inside every edge, seated as above. A few rounds settle it (the seat, and so each point's
 * magnification, depends on the scale).
 */
export function seatFrame(inner: Group, plate: Plate, pts: readonly (readonly [number, number, number])[], view?: FrameView, reach: readonly (readonly [number, number, number])[] = []): void {
  plate.geometry.computeBoundingBox()
  const b = plate.geometry.boundingBox!
  const all: (readonly [number, number, number])[] = [...pts]
  for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) all.push([x, y, z])
  const fit = tiltFit(all.map(([, y, z]) => [y, z] as const))
  const xs = all.map(p => p[0]), x0 = Math.min(...xs), x1 = Math.max(...xs)
  inner.scale.setScalar(1)
  inner.position.set(-(x0 + x1) / 2, fit.y, fit.z)
  if (!view) return
  // the outline and the reach, tilted (unscaled, unmoved)
  const tilt = ([x, y, z]: readonly [number, number, number]) => [x, y * COS - z * SIN, y * SIN + z * COS] as const
  const outline = all.map(tilt), extra = [...outline, ...reach.map(tilt)]
  const [ex, ey, ez] = view.eye, M = FRAME.margin, hw = Math.max(0.5, view.width / 2 - M), hh = Math.max(0.5, view.height / 2 - M)
  const low = Math.min(...extra.map(q => q[2]))
  let k = 1, tx = inner.position.x, ty = inner.position.y
  /** Where `q` shows on the glass, at this round's scale and place. */
  const show = ([qx, qy, qz]: readonly [number, number, number], tz: number): [number, number, number] => {
    const m = ez / Math.max(1e-3, ez - (k * qz + tz))
    return [ex + (k * qx + tx - ex) * m, ey + (k * qy + ty - ey) * m, m]
  }
  for (let round = 0; round < 24; round++) {
    const tz = FRAME.seat - k * low
    // re-centre the outline as seen (undoing an average magnification) …
    let sx0 = Infinity, sx1 = -Infinity, sy0 = Infinity, sy1 = -Infinity, mean = 0
    for (const q of outline) {
      const [sx, sy, m] = show(q, tz)
      sx0 = Math.min(sx0, sx); sx1 = Math.max(sx1, sx); sy0 = Math.min(sy0, sy); sy1 = Math.max(sy1, sy); mean += m / outline.length
    }
    tx -= (sx0 + sx1) / 2 / mean; ty -= (sy0 + sy1) / 2 / mean
    // … and rescale so everything, the reach included, keeps the margin from the box's edges
    let ax = 0, ay = 0
    for (const q of extra) { const [sx, sy] = show(q, tz); ax = Math.max(ax, Math.abs(sx)); ay = Math.max(ay, Math.abs(sy)) }
    k = Math.min(1, k * Math.min(hw / ax, hh / ay))
  }
  inner.scale.setScalar(k)
  inner.position.set(tx, ty, FRAME.seat - k * low)
}

/** Whether a chart laid out for `was` must fit itself again for `now`: one has an eye the other lacks, or it moved past `FRAME.eyeTolerance`. */
export function eyeMoved(now: readonly [number, number, number] | undefined, was: readonly [number, number, number] | undefined): boolean {
  if (!now || !was) return now !== was
  const tol = FRAME.eyeTolerance * Math.max(1, Math.abs(was[2]))
  return Math.abs(now[0] - was[0]) > tol || Math.abs(now[1] - was[1]) > tol || Math.abs(now[2] - was[2]) > tol
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

/**
 * Shows every `step`-th of the first `count` planes, where `step` keeps neighbours `room` pt apart at `pitch`, counting
 * from the first (or, `from: 'last'`, from the last: it is always shown); hides the rest.
 */
export function thinPlanes(planes: readonly TextPlane[], count: number, room: (m: TextPlane) => number, pitch: number, from: 'first' | 'last' = 'first'): void {
  const need = Math.max(0, ...planes.slice(0, count).map(room))
  const step = Math.max(1, Math.ceil(need / pitch))
  planes.forEach((m, i) => { m.visible = i < count && (from === 'first' ? i : count - 1 - i) % step === 0 })
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
  /**
   * The eye the chart is fitted to (a copy of a `Viewport3DContext.eye`'s values: the context's tuple is rewritten each
   * tick); `hasEye` whether there is one. It refits only when the eye moves far enough (`eyeMoved`).
   */
  private readonly fitted: [number, number, number] = [0, 0, 0]
  private hasEye = false
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
   * colours and lays out again when the box, the data, the labels or the eye (past its tolerance) changed. False when
   * there is nothing to draw (no data, an empty box): `update` then returns false.
   */
  protected prepare(ctx: Viewport3DContext): boolean {
    const resized = ctx.width !== this.ctx?.width || ctx.height !== this.ctx?.height
    // the eye it is fitted for: kept until it moves far enough, so a Card's hover lift does not refit (breathe)
    const refit = eyeMoved(ctx.eye, this.hasEye ? this.fitted : undefined)
    this.ctx = ctx
    if (!this.hasData()) return false
    this.inner.visible = ctx.width > 0 && ctx.height > 0
    if (!this.inner.visible) return false
    this.paint(ctx)
    if (resized || refit || this.dirty) {
      if (refit) { this.hasEye = ctx.eye !== undefined; if (ctx.eye) { this.fitted[0] = ctx.eye[0]; this.fitted[1] = ctx.eye[1]; this.fitted[2] = ctx.eye[2] } }
      this.layout(ctx)
    }
    return true
  }

  /** The view a layout in `ctx`'s box fits the frame to (`seatFrame`): the eye it is fitted to, when it has one. */
  protected viewOf(ctx: Viewport3DContext): FrameView | undefined {
    return this.hasEye ? { eye: this.fitted, width: ctx.width, height: ctx.height } : undefined
  }
}
