import { BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Line, LineSegments, Matrix4, Mesh, SphereGeometry, SRGBColorSpace, Vector3 } from 'three'
import { LineBasicNodeMaterial, MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { GlassUIError, resolveColor, Spring, type RGBA } from '@glassui/core'
import type { CanvasFactory } from '@glassui/text'
import type { Viewport3DContext } from '../viewport'
import { disposeTextPlane, recolorTextPlane, textPlane, textPlaneHeight, type TextPlane } from './labels'

/**
 * `SurfaceChart.set`'s data: `values` rows × cols (each row as long, at least 2 × 2, every value finite and ≥ 0),
 * `max` (> 0, finite) the value that stands at the full height (a larger one is capped there), `ramp` 2–6 colours
 * (sRGB, low → high; alpha ignored).
 */
export interface SurfaceChartData { values: readonly (readonly number[])[]; max: number; ramp: readonly RGBA[] }
/**
 * `SurfaceChart.labels`: `x` one per column (left → right), `y` one per row (row 0, at the back, first), `ticks` the
 * value labels, evenly from 0 (on the plate) to `max` (the full height). Extra labels are not shown.
 */
export interface SurfaceChartLabels { x: readonly string[]; y: readonly string[]; ticks: readonly string[] }
/** A grid vertex: `values[row][col]`. */
export interface SurfaceCell { row: number; col: number }

/** The surface chart's proportions and motion (spatial spec §12.1); pt unless noted. */
export const SURFACE = {
  /** The grid's width (its columns), of the box's width. */
  width: 0.8,
  /** The grid's depth (its rows, along y before the tilt), of the box's height. */
  depth: 0.6,
  /** The full height (`max`), of the box's shorter side. */
  height: 0.45,
  /** Radians about x: the grid lies back like a tabletop, its heights standing toward the viewer. */
  tilt: -0.9,
  /** How far over the glass the chart's lowest point sits. */
  seat: 1,
  /** Seconds: on the first `set`, row r starts growing `r × stagger` after row 0. */
  stagger: 0.03,
  /** The base plate: thickness, its margin past the grid where no label is, opacity (of the theme's `fill`). */
  plate: { thickness: 3, margin: 12, opacity: 0.55, radius: 1.2 },
  /** The grid lines on the plate: opacity (of the theme's `secondaryLabel`) and how far over the plate they lie. */
  grid: { opacity: 0.3, lift: 0.25 },
  /** The axis labels lying on the plate: font size, gap from the grid, how far over the plate they lie. */
  label: { size: 15, gap: 8, lift: 0.4 },
  /** The value ticks standing at the back-left corner: font size, the length of a tick mark. */
  tick: { size: 13, mark: 5 },
  /** The hover dot's diameter, and the ring's behind it. */
  dot: 5,
  ring: 8,
} as const

/**
 * Each part's own `renderOrder`: the attachment keeps it as the part's place within the viewport's slot (spatial spec
 * §2.3, `VIEWPORT_ORDER`), so the translucent plate draws first, the guide and dot over the surface.
 */
const ORDER = { plate: -3, grid: -2, labels: -1, surface: 0, guide: 1, ring: 2, dot: 3 } as const

/** A part the pointer goes through (the labels, lines and hover marks: a hit is the surface's or the plate's). */
const noRaycast = (): void => {}

type Kind = 'x' | 'y' | 'ticks'
interface Parts {
  surface: Mesh<BufferGeometry, MeshStandardNodeMaterial>
  plate: Mesh<RoundedBoxGeometry, MeshStandardNodeMaterial>
  grid: LineSegments<BufferGeometry, LineBasicNodeMaterial>
  guide: Line<BufferGeometry, LineBasicNodeMaterial>
  ring: Mesh<SphereGeometry, MeshBasicNodeMaterial>
  dot: Mesh<SphereGeometry, MeshBasicNodeMaterial>
}
/** The grid as laid out: `cols` columns from x = `x0`, `px` apart; `rows` rows from y = `y0` (row 0, the back), `py` apart toward −y. */
interface Grid { rows: number; cols: number; x0: number; px: number; y0: number; py: number; zMax: number }

/** pt: the centre line of the x labels, under the front row (`y0`: the grid's half depth), in the grid's frame. */
const xLabelY = (y0: number): number => -y0 - SURFACE.label.gap - SURFACE.label.size / 2

const COS = Math.cos(SURFACE.tilt), SIN = Math.sin(SURFACE.tilt)
/**
 * Where the tilted frame goes for its outline `pts` ((y, z) in the grid's frame: the extremes of its parts): `y`
 * centres them up and down the box, `z` seats the lowest `SURFACE.seat` over the glass; `top` is then the highest one's
 * z, pt off the glass.
 */
function tiltFit(pts: readonly (readonly [number, number])[]): { y: number; z: number; top: number } {
  let lo = Infinity, hi = -Infinity, near = Infinity, far = -Infinity
  for (const [y, z] of pts) {
    const yy = y * COS - z * SIN, zz = y * SIN + z * COS
    lo = Math.min(lo, yy); hi = Math.max(hi, yy); near = Math.min(near, zz); far = Math.max(far, zz)
  }
  const z = SURFACE.seat - near
  return { y: -(lo + hi) / 2, z, top: far + z }
}

/** `ramp` (sRGB, low → high) at `t` (clamped to 0..1), mixed in sRGB between its two nearest stops, into `out` (linear). */
function rampAt(ramp: readonly RGBA[], t: number, out: Color): Color {
  const n = ramp.length - 1, x = Math.min(1, Math.max(0, t)) * n, k = Math.min(n - 1, Math.floor(x)), u = x - k
  const a = ramp[k]!, b = ramp[k + 1]!
  return out.setRGB(a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, SRGBColorSpace)
}
/** Names a part that casts no shadow (`userData.noShadow`), with its draw order; the pointer goes through it unless `hit`. */
function decoration<T extends Mesh | Line>(o: T, name: string, order: number, hit = false): T {
  o.name = name; o.renderOrder = order; o.userData.noShadow = true
  if (!hit) o.raycast = noRaycast
  return o
}

const tmp = new Color(), v3 = new Vector3(), m4 = new Matrix4()

/**
 * The outbound heat surface (spatial spec §12.1): `values` (rows × cols) as a smooth surface whose third dimension is
 * the value, to attach with `Surface.attach3D` (`update` as the attachment's, `(dt, ctx) => chart.update(dt, ctx)`), so
 * its origin is the box centre on the glass, 1 unit = 1 pt.
 *
 * Built in `inner`'s frame: the grid spans `SURFACE.width` × the box width along x (column c at `x0 + c·px`) and
 * `SURFACE.depth` × its height along y (row 0 at the back, +y, the last row at the front); a value stands along z,
 * `max` at `SURFACE.height` × the box's shorter side (a larger value is capped there: nothing rises past the top tick
 * or `riseFor`). `inner` is tilted `SURFACE.tilt` about x, so the grid lies back
 * like a tabletop and the heights rise toward the viewer and up, then seated on the glass (its lowest point
 * `SURFACE.seat` over it: nothing sinks behind the face it stands on) and centred in the box.
 *
 * Parts, each its own draw (`ORDER`, kept by the attachment):
 * - `surface`: one vertex per value (rows × cols, two triangles a cell), smooth normals, each vertex coloured from
 *   `ramp` at its current height / max (`MeshStandardNodeMaterial`, double-sided, roughness 0.55). The only part that
 *   casts a shadow and, with the plate, the only one the pointer hits.
 * - `plate`: a thin translucent base under the grid (the theme's `fill`), holding the lying labels.
 * - `grid`: lines on the plate along every column and row; on the back edge, a value axis with a tick mark and a guide
 *   line across at each tick (the theme's `secondaryLabel`).
 * - labels (`textPlane`s, `secondaryLabel`): `x` under the front edge, centred on their columns, `y` left of the grid,
 *   ending at it, both lying on the plate (thinned to every n-th when they would overlap); `ticks` standing at the
 *   back-left corner at their heights, facing the front.
 * - `guide`, `ring`, `dot`: the hovered vertex: a line from the plate up to it and a `SURFACE.dot` dot in the ramp's
 *   last colour on a ring in the theme's `fill`, drawn over the surface (no depth test).
 *
 * Motion: each vertex's height springs (the theme's `smooth`, as of its creation) as a fraction of the full height. On
 * the first `set` of a shape, row r waits `r × SURFACE.stagger` s and then grows from 0; a later `set` springs from
 * where the heights are; reduced motion puts them there at once. A new box size lays the chart out again at once.
 * Theme colours follow `ctx` (a scheme change recolours the labels; their textures are made again only for new text).
 */
export class SurfaceChart extends Group {
  /** The tilted, seated frame the chart is built in (see the class comment). */
  readonly inner = new Group()
  private readonly createCanvas: CanvasFactory
  private data: { values: number[][]; max: number; ramp: RGBA[] } | null = null
  private texts: { x: string[]; y: string[]; ticks: string[] } = { x: [], y: [], ticks: [] }
  private readonly planes: Record<Kind, TextPlane[]> = { x: [], y: [], ticks: [] }
  private parts: Parts | null = null
  /** The last `update`'s context: the box, the motion preference and the theme. */
  private ctx: Viewport3DContext | null = null
  private metrics: Grid | null = null
  /** One per vertex (row-major): its height, of the full height. */
  private springs: Spring[] = []
  /** Per row: seconds before its springs start. */
  private waits: number[] = []
  /** The shape the surface geometry was built for, `rows × cols`. */
  private shape = ''
  private hovered: SurfaceCell | null = null
  /** The theme's colours as last applied, and their key. */
  private palette: { label: RGBA; fill: RGBA } = { label: [0, 0, 0, 1], fill: [1, 1, 1, 1] }
  private paletteKey = ''
  /** Something the layout depends on changed since the last one (data, labels). */
  private dirty = true
  /** The heights or the hover moved: the surface and the hover marks are posed again. */
  private posed = false

  /** `createCanvas`: what the labels are drawn on (the root's canvas factory). */
  constructor(opts: { createCanvas: CanvasFactory }) {
    super()
    this.createCanvas = opts.createCanvas
    this.name = 'surface-chart'; this.inner.name = 'tilt'
    this.inner.rotation.x = SURFACE.tilt
    this.add(this.inner)
  }

  /** The heat surface; like the other parts, it exists once the chart is first laid out (data and a box), and throws before. */
  get surface(): Parts['surface'] { return this.built.surface }
  get plate(): Parts['plate'] { return this.built.plate }
  get grid(): Parts['grid'] { return this.built.grid }
  get guide(): Parts['guide'] { return this.built.guide }
  get dot(): Parts['dot'] { return this.built.dot }
  /** The label planes, by axis, in label order (thinned ones hidden, not removed). */
  get labelPlanes(): Readonly<Record<Kind, readonly TextPlane[]>> { return this.planes }

  /**
   * New data: throws a readable `GlassUIError` for a `max` that is not a finite number > 0, fewer than 2 × 2 values,
   * rows of different lengths, a value negative or not finite, or a `ramp` not of 2–6 colours, changing nothing. Laid
   * out now when an `update` has told the box, else at the first one.
   */
  set(data: SurfaceChartData): void {
    const scope = 'SurfaceChart.set', { values, max, ramp } = data
    if (!(max > 0 && max < Infinity)) throw new GlassUIError(scope, `max 必须是大于 0 的有限数，收到 ${max}`)
    const cols = values[0]?.length ?? 0
    if (values.length < 2 || cols < 2) throw new GlassUIError(scope, `values 至少要 2 × 2（2 行，每行 2 个），收到 ${values.length} 行、第 1 行 ${cols} 个`)
    values.forEach((row, r) => {
      if (row.length !== cols) throw new GlassUIError(scope, `values 每行一样长：第 1 行 ${cols} 个，第 ${r + 1} 行 ${row.length} 个`)
      row.forEach((v, c) => { if (!(v >= 0 && v < Infinity)) throw new GlassUIError(scope, `values[${r}][${c}] 必须是不小于 0 的有限数，收到 ${v}`) })
    })
    if (ramp.length < 2 || ramp.length > 6) throw new GlassUIError(scope, `ramp 要 2–6 个颜色（从低到高），收到 ${ramp.length} 个`)
    this.data = { values: values.map(r => [...r]), max, ramp: ramp.map(c => [...c] as RGBA) }
    this.dirty = true
    if (this.ctx) this.layout(this.ctx)
  }

  /** New axis labels and value ticks (see `SurfaceChartLabels`); planes are made again only for changed text. */
  labels(l: SurfaceChartLabels): void {
    this.texts = { x: [...l.x], y: [...l.y], ticks: [...l.ticks] }
    this.dirty = true
    if (this.ctx) this.layout(this.ctx)
  }

  /** Marks `cell` (the guide, ring and dot on its vertex, following its height); null, or a cell the data lacks: none. */
  hover(cell: SurfaceCell | null): void {
    this.hovered = cell ? { row: cell.row, col: cell.col } : null
    this.posed = false
  }

  /**
   * pt: the most this chart, laid out in a box `width` × `height`, rises off the glass it is seated on (its plate,
   * surface, labels and hover marks), rounded up, whatever its data and labels: the plate as deep as lying labels can
   * make it, the ticks up to the full height, the hover ring on the front row's full height. For
   * `Attach3DOptions.depth`. It grows with the width only while the width is under the height (the full height is
   * `SURFACE.height` × the shorter side), so `riseFor(h, h)` bounds a box `h` high at any width.
   */
  riseFor(width: number, height: number): number {
    const { label: L, tick: T, plate: P } = SURFACE
    const y0 = SURFACE.depth * height / 2, zMax = SURFACE.height * Math.min(width, height), t = P.thickness
    const hL = textPlaneHeight(L.size), hT = textPlaneHeight(T.size), half = L.gap / 2
    // the plate's edges as far as the lying labels push them (`layoutPlate`): the x labels under the front row, the
    // y labels on the first and last rows
    const front = Math.min(-y0 - P.margin, xLabelY(y0) - hL / 2 - half, -y0 - hL / 2 - half)
    const back = Math.max(y0 + P.margin, y0 + hL / 2 + half)
    const fit = tiltFit([[front, -t], [back, -t], [front, 0], [back, 0], [-y0, zMax], [y0, zMax], [y0, -hT / 2], [y0, zMax + hT / 2]])
    const ring = -y0 * SIN + zMax * COS + fit.z + SURFACE.ring / 2
    return Math.ceil(Math.max(fit.top, ring))
  }

  /**
   * The grid vertex nearest `point` (in the frame of the chart's parent, the attachment's anchor: a pointer event's
   * `point`), measured across the grid (the height does not count); null when it is more than half a cell off the
   * grid, or nothing is laid out.
   */
  cellAt(point: readonly [number, number, number]): SurfaceCell | null {
    const g = this.metrics
    if (!g || !this.data) return null
    this.updateMatrix(); this.inner.updateMatrix()
    v3.set(point[0], point[1], point[2]).applyMatrix4(m4.multiplyMatrices(this.matrix, this.inner.matrix).invert())
    const col = Math.round((v3.x - g.x0) / g.px) + 0, row = Math.round((g.y0 - v3.y) / g.py) + 0   // + 0: never −0
    return col >= 0 && col < g.cols && row >= 0 && row < g.rows ? { row, col } : null
  }

  /**
   * One frame of `dt` s in `ctx`'s box: follows the theme's colours, lays out again when the box, the data or the
   * labels changed, steps the heights (reduced motion: puts them there), poses the surface and the hover marks. True
   * while a height moves. Nothing to draw (no data, an empty box): false.
   */
  update(dt: number, ctx: Viewport3DContext): boolean {
    const resized = ctx.width !== this.ctx?.width || ctx.height !== this.ctx?.height
    this.ctx = ctx
    if (!this.data) return false
    this.inner.visible = ctx.width > 0 && ctx.height > 0
    if (!this.inner.visible) return false
    this.paint(ctx)
    if (resized || this.dirty) this.layout(ctx)
    let moving = false
    const cols = this.metrics?.cols ?? 0
    this.waits.forEach((wait, r) => {
      let t = dt
      if (ctx.reducedMotion) this.waits[r] = 0
      else if (wait > 0 && dt > 0) { const w = Math.min(wait, dt); this.waits[r] = wait - w; t -= w }
      for (let i = r * cols; i < (r + 1) * cols; i++) {
        const s = this.springs[i]!
        if (ctx.reducedMotion) { if (s.value !== s.target || s.velocity !== 0) { s.jump(s.target); this.posed = false } }
        else if (!s.done) { s.step(t); this.posed = false }
        if (!s.done) moving = true
      }
      if (this.waits[r]! > 0) moving = true
    })
    if (!this.posed) this.pose()
    return moving
  }

  /** Frees every geometry, material and label texture and empties the chart; it draws nothing until the next `set`. */
  dispose(): void {
    for (const k of ['x', 'y', 'ticks'] as const) for (const m of this.planes[k].splice(0)) disposeTextPlane(m)
    const p = this.parts
    if (p) for (const o of [p.surface, p.plate, p.grid, p.guide, p.ring, p.dot]) { o.removeFromParent(); o.geometry.dispose(); o.material.dispose() }
    this.parts = null; this.data = null; this.metrics = null; this.springs = []; this.waits = []; this.shape = ''; this.paletteKey = ''
    this.dirty = true
  }

  private get built(): Parts {
    if (!this.parts) throw new GlassUIError('SurfaceChart', '图表还没有画出来：先 set 数据，再 update 一帧')
    return this.parts
  }

  /** The parts, made at the first layout (and again after a `dispose`). */
  private build(): Parts {
    if (this.parts) return this.parts
    const surface = new Mesh(new BufferGeometry(), new MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, side: DoubleSide }))
    surface.material.forceSinglePass = true   // opaque: one pass, depth-tested, is right from either side
    surface.name = 'surface'; surface.renderOrder = ORDER.surface
    // the plate takes the pointer: a hit there names the cell over it, or none off the grid
    const plate = decoration(new Mesh(new RoundedBoxGeometry(1, 1, 1), new MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0, transparent: true, opacity: SURFACE.plate.opacity, depthWrite: false })), 'plate', ORDER.plate, true)
    const grid = decoration(new LineSegments(new BufferGeometry(), new LineBasicNodeMaterial({ transparent: true, opacity: SURFACE.grid.opacity })), 'grid', ORDER.grid)
    const guideGeometry = new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(6), 3))
    const guide = decoration(new Line(guideGeometry, new LineBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false })), 'guide', ORDER.guide)
    const mark = (d: number, name: string, order: number) => {
      const m = decoration(new Mesh(new SphereGeometry(d / 2, 16, 12), new MeshBasicNodeMaterial({ transparent: true, depthTest: false, depthWrite: false })), name, order)
      m.material.toneMapped = false
      return m
    }
    const ring = mark(SURFACE.ring, 'ring', ORDER.ring), dot = mark(SURFACE.dot, 'dot', ORDER.dot)
    guide.visible = ring.visible = dot.visible = false
    this.inner.add(plate, grid, surface, guide, ring, dot)
    this.parts = { surface, plate, grid, guide, ring, dot }
    this.paletteKey = ''
    return this.parts
  }

  /** The theme's colours from `ctx`: applied to the parts and labels when they changed (the textures stay). */
  private paint(ctx: Viewport3DContext): void {
    const label = resolveColor('secondaryLabel', ctx.theme, ctx.scheme), fill = resolveColor('fill', ctx.theme, ctx.scheme)
    const last = this.data?.ramp.at(-1)
    const key = [label, fill, last ?? ''].join('|')
    const p = this.parts
    if (key === this.paletteKey || !p) { this.palette = { label, fill }; return }
    this.paletteKey = key; this.palette = { label, fill }
    p.plate.material.color.setRGB(fill[0], fill[1], fill[2], SRGBColorSpace)
    p.grid.material.color.setRGB(label[0], label[1], label[2], SRGBColorSpace)
    p.guide.material.color.setRGB(label[0], label[1], label[2], SRGBColorSpace)
    p.ring.material.color.setRGB(fill[0], fill[1], fill[2], SRGBColorSpace)
    if (last) p.dot.material.color.setRGB(last[0], last[1], last[2], SRGBColorSpace)
    for (const k of ['x', 'y', 'ticks'] as const) for (const m of this.planes[k]) recolorTextPlane(m, label)
  }

  /**
   * Lays the chart out in `ctx`'s box: the surface geometry (made again for a new shape, its heights then growing in),
   * the springs' targets, the labels (made for new text), the grid lines, the plate around the grid and the lying
   * labels, then the tilt's seat. Nothing before data and a box with an area.
   */
  private layout(ctx: Viewport3DContext): void {
    const d = this.data, W = ctx.width, H = ctx.height
    if (!d || !(W > 0 && H > 0)) return
    const p = this.build()
    this.paint(ctx)
    const rows = d.values.length, cols = d.values[0]!.length, cfg = ctx.theme.springs.smooth
    const GW = SURFACE.width * W, GD = SURFACE.depth * H
    const g: Grid = { rows, cols, x0: -GW / 2, px: GW / (cols - 1), y0: GD / 2, py: GD / (rows - 1), zMax: SURFACE.height * Math.min(W, H) }
    this.metrics = g

    // the surface: a new shape is a new geometry, grown in row by row; the same shape springs from where it is
    const shape = `${rows}×${cols}`
    if (shape !== this.shape) {
      this.shape = shape
      const n = rows * cols, index: number[] = []
      for (let r = 0; r < rows - 1; r++) for (let c = 0; c < cols - 1; c++) {
        const back = r * cols + c, front = back + cols     // row r + 1 lies in front (−y): counter-clockwise from +z
        index.push(front, front + 1, back + 1, front, back + 1, back)
      }
      const geometry = new BufferGeometry()
      for (const a of ['position', 'normal', 'color']) geometry.setAttribute(a, new BufferAttribute(new Float32Array(n * 3), 3))
      geometry.setIndex(index)
      p.surface.geometry.dispose(); p.surface.geometry = geometry
      this.springs = Array.from({ length: n }, () => new Spring(0, cfg))
      this.waits = Array.from({ length: rows }, (_, r) => r * SURFACE.stagger)
    }
    const pos = p.surface.geometry.getAttribute('position') as BufferAttribute
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c
      pos.setXY(i, g.x0 + c * g.px, g.y0 - r * g.py)
      this.springs[i]!.set(Math.min(1, d.values[r]![c]! / d.max))   // capped at the full height
    }

    this.layoutLabels(g)
    this.layoutLines(g)
    this.layoutPlate(g)
    this.seat(g)
    this.dirty = false; this.posed = false
  }

  /** Makes the label planes for new text, then places them (see the class comment), thinning crowded ones. */
  private layoutLabels(g: Grid): void {
    const { label: L, tick: T } = SURFACE, gap = L.gap
    for (const k of ['x', 'y', 'ticks'] as const) {
      const texts = this.texts[k], planes = this.planes[k]
      for (const m of planes.splice(texts.length)) disposeTextPlane(m)
      texts.forEach((t, i) => {
        const m = planes[i]
        if (m?.userData.text === t) return
        if (m) disposeTextPlane(m)
        const n = textPlane(t, { size: k === 'ticks' ? T.size : L.size, color: this.palette.label, align: k === 'x' ? 'center' : 'right', createCanvas: this.createCanvas })
        planes[i] = decoration(n, `${k}-label-${i}`, ORDER.labels)
        this.inner.add(n)
      })
    }
    /** Shows every `step`-th of the first `count` planes, where `step` keeps neighbours `room` pt apart at `pitch`. */
    const thin = (planes: readonly TextPlane[], count: number, room: (m: TextPlane) => number, pitch: number): void => {
      const need = Math.max(0, ...planes.slice(0, count).map(room))
      const step = Math.max(1, Math.ceil(need / pitch))
      planes.forEach((m, i) => { m.visible = i < count && i % step === 0 })
    }
    thin(this.planes.x, g.cols, m => (m.userData.ink as number) + gap, g.px)
    thin(this.planes.y, g.rows, () => L.size + gap / 2, g.py)
    this.planes.x.forEach((m, c) => { m.position.set(g.x0 + c * g.px, xLabelY(g.y0), L.lift); m.rotation.set(0, 0, 0) })
    this.planes.y.forEach((m, r) => { m.position.set(g.x0 - gap, g.y0 - r * g.py, L.lift); m.rotation.set(0, 0, 0) })
    const n = this.planes.ticks.length
    this.planes.ticks.forEach((m, k) => {
      m.position.set(g.x0 - T.mark - 3, g.y0, n > 1 ? k / (n - 1) * g.zMax : 0)
      m.rotation.set(Math.PI / 2, 0, 0)   // standing in x–z, facing the front (−y)
      m.visible = true
    })
  }

  /** The lines: on the plate, one along each column and each row; on the back edge, the value axis, its tick marks and a guide across at each tick. */
  private layoutLines(g: Grid): void {
    const p = this.built, z = SURFACE.grid.lift, x1 = g.x0 + (g.cols - 1) * g.px, yF = g.y0 - (g.rows - 1) * g.py, out: number[] = []
    for (let c = 0; c < g.cols; c++) out.push(g.x0 + c * g.px, yF, z, g.x0 + c * g.px, g.y0, z)
    for (let r = 0; r < g.rows; r++) out.push(g.x0, g.y0 - r * g.py, z, x1, g.y0 - r * g.py, z)
    out.push(g.x0, g.y0, z, g.x0, g.y0, g.zMax)
    const n = this.planes.ticks.length
    for (let k = 0; k < n; k++) {
      const h = n > 1 ? k / (n - 1) * g.zMax : 0
      out.push(g.x0 - SURFACE.tick.mark, g.y0, h, g.x0, g.y0, h)
      if (k > 0) out.push(g.x0, g.y0, h, x1, g.y0, h)
    }
    const geometry = new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array(out), 3))
    p.grid.geometry.dispose(); p.grid.geometry = geometry
  }

  /** The plate: under the grid and every shown lying label, `SURFACE.plate.margin` past the grid where there is none. */
  private layoutPlate(g: Grid): void {
    const p = this.built, M = SURFACE.plate.margin, half = SURFACE.label.gap / 2, t = SURFACE.plate.thickness
    let x0 = g.x0 - M, x1 = -g.x0 + M, y0 = -g.y0 - M, y1 = g.y0 + M
    for (const m of [...this.planes.x, ...this.planes.y]) {
      if (!m.visible) continue
      m.geometry.computeBoundingBox()
      const b = m.geometry.boundingBox!
      x0 = Math.min(x0, m.position.x + b.min.x - half); x1 = Math.max(x1, m.position.x + b.max.x + half)
      y0 = Math.min(y0, m.position.y + b.min.y - half); y1 = Math.max(y1, m.position.y + b.max.y + half)
    }
    const w = x1 - x0, d = y1 - y0, was = p.plate.geometry.parameters
    if (was.width !== w || was.height !== d || was.depth !== t) {
      const geometry = new RoundedBoxGeometry(w, d, t, 2, SURFACE.plate.radius)
      geometry.translate((x0 + x1) / 2, (y0 + y1) / 2, -t / 2)
      p.plate.geometry.dispose(); p.plate.geometry = geometry
    }
  }

  /**
   * Places the tilted frame: its lowest point (the plate's back edge, a tick label) `SURFACE.seat` over the glass, and
   * the chart (the plate, the full height, the standing ticks) centred across and up the box.
   */
  private seat(g: Grid): void {
    const p = this.built, t = SURFACE.plate.thickness
    p.plate.geometry.computeBoundingBox()
    const plate = p.plate.geometry.boundingBox!
    const pts: [number, number][] = [[plate.min.y, -t], [plate.max.y, -t], [plate.min.y, 0], [plate.max.y, 0], [-g.y0, g.zMax], [g.y0, g.zMax]]
    let x0 = plate.min.x, x1 = plate.max.x
    for (const m of this.planes.ticks) {
      m.geometry.computeBoundingBox()
      const b = m.geometry.boundingBox!
      pts.push([g.y0, m.position.z + b.min.y], [g.y0, m.position.z + b.max.y])   // standing: the plane's y is the height
      x0 = Math.min(x0, m.position.x + b.min.x)
    }
    const fit = tiltFit(pts)
    this.inner.position.set(-(x0 + x1) / 2, fit.y, fit.z)
  }

  /** The surface's heights and colours from the springs, its normals and bounds; the hover marks on their vertex. */
  private pose(): void {
    const p = this.parts, g = this.metrics, d = this.data
    if (!p || !g || !d) return
    const geometry = p.surface.geometry, pos = geometry.getAttribute('position') as BufferAttribute, col = geometry.getAttribute('color') as BufferAttribute
    this.springs.forEach((s, i) => {
      pos.setZ(i, s.value * g.zMax)
      rampAt(d.ramp, s.value, tmp)
      col.setXYZ(i, tmp.r, tmp.g, tmp.b)
    })
    pos.needsUpdate = true; col.needsUpdate = true
    geometry.computeVertexNormals(); geometry.computeBoundingSphere()   // the bounds: three's culling and raycast read them

    const h = this.hovered, on = h !== null && h.row >= 0 && h.row < g.rows && h.col >= 0 && h.col < g.cols
    p.guide.visible = p.ring.visible = p.dot.visible = on
    if (on) {
      const i = h.row * g.cols + h.col
      v3.fromBufferAttribute(pos, i)
      const line = p.guide.geometry.getAttribute('position') as BufferAttribute
      line.setXYZ(0, v3.x, v3.y, 0); line.setXYZ(1, v3.x, v3.y, v3.z); line.needsUpdate = true
      p.guide.geometry.computeBoundingSphere()
      p.ring.position.copy(v3); p.dot.position.copy(v3)
    }
    this.posed = true
  }
}
