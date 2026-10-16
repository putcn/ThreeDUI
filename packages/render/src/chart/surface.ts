import { BufferAttribute, BufferGeometry, Color, DoubleSide, Line, LineSegments, Matrix4, Mesh, SphereGeometry, SRGBColorSpace, Vector3 } from 'three'
import { LineBasicNodeMaterial, MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import { GlassUIError, rampColor, Spring, type RGBA } from '@glassui/core'
import type { CanvasFactory } from '@glassui/text'
import type { Viewport3DContext } from '../viewport'
import { disposeTextPlane, textPlaneHeight, type TextPlane } from './labels'
import {
  decoration, fitPlate, FRAME, FRAME_ORDER, FrameChart, framePalette, framePlane, makePlate, paintFrame, plateBound, seatFrame, stepSprings, syncPlanes,
  thinPlanes, tiltedZ, xLabelY, type GridCell, type Plate,
} from './frame'

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
export type SurfaceCell = GridCell

/**
 * The surface chart's proportions and motion (spatial spec §12.1); pt unless noted. Its tilt, seat, plate and lying
 * labels are the frame's (`FRAME`, shared with `BarMatrix`).
 */
export const SURFACE = {
  ...FRAME,
  /** The grid's width (its columns), of the box's width. */
  width: 0.8,
  /** The grid's depth (its rows, along y before the tilt), of the box's height. */
  depth: 0.6,
  /** The full height (`max`), of the box's shorter side. */
  height: 0.45,
  /** Seconds: on the first `set`, row r starts growing `r × stagger` after row 0. */
  stagger: 0.03,
  /** The grid lines on the plate: opacity (of the theme's `secondaryLabel`) and how far over the plate they lie. */
  grid: { opacity: 0.3, lift: 0.25 },
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
const ORDER = { ...FRAME_ORDER, grid: -2, surface: 0, guide: 1, ring: 2, dot: 3 } as const

type Kind = 'x' | 'y' | 'ticks'
interface Parts {
  surface: Mesh<BufferGeometry, MeshStandardNodeMaterial>
  plate: Plate
  grid: LineSegments<BufferGeometry, LineBasicNodeMaterial>
  guide: Line<BufferGeometry, LineBasicNodeMaterial>
  ring: Mesh<SphereGeometry, MeshBasicNodeMaterial>
  dot: Mesh<SphereGeometry, MeshBasicNodeMaterial>
}
/** The grid as laid out: `cols` columns from x = `x0`, `px` apart; `rows` rows from y = `y0` (row 0, the back), `py` apart toward −y. */
interface Grid { rows: number; cols: number; x0: number; px: number; y0: number; py: number; zMax: number }

/** `ramp` (sRGB, low → high) at `t` (`rampColor`: clamped, mixed in sRGB between the nearest stops), into `out` (linear). */
function rampAt(ramp: readonly RGBA[], t: number, out: Color): Color {
  const [r, g, b] = rampColor(ramp, t)
  return out.setRGB(r, g, b, SRGBColorSpace)
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
 *   ending at it, both lying on the plate (thinned to every n-th when they would overlap: `y` two lines apart, counted
 *   from the front row, the back row's left out where the ticks stand); `ticks` standing at the back-left corner at
 *   their heights, facing the front.
 * - `guide`, `ring`, `dot`: the hovered vertex: a line from the plate up to it and a `SURFACE.dot` dot in the ramp's
 *   last colour on a ring in the theme's `fill`, drawn over the surface (no depth test).
 *
 * Motion: each vertex's height springs (the theme's `smooth`, as of its creation) as a fraction of the full height. On
 * the first `set` of a shape, row r waits `r × SURFACE.stagger` s and then grows from 0; a later `set` springs from
 * where the heights are; reduced motion puts them there at once. A new box size lays the chart out again at once.
 * Theme colours follow `ctx` (a scheme change recolours the labels; their textures are made again only for new text).
 */
export class SurfaceChart extends FrameChart {
  private data: { values: number[][]; max: number; ramp: RGBA[] } | null = null
  private texts: { x: string[]; y: string[]; ticks: string[] } = { x: [], y: [], ticks: [] }
  private readonly planes: Record<Kind, TextPlane[]> = { x: [], y: [], ticks: [] }
  private parts: Parts | null = null
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
  /** The heights or the hover moved: the surface and the hover marks are posed again. */
  private posed = false

  /** `createCanvas`: what the labels are drawn on (the root's canvas factory). */
  constructor(opts: { createCanvas: CanvasFactory }) { super('surface-chart', opts) }

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
    this.invalidate()
  }

  /** New axis labels and value ticks (see `SurfaceChartLabels`); planes are made again only for changed text. */
  labels(l: SurfaceChartLabels): void {
    this.texts = { x: [...l.x], y: [...l.y], ticks: [...l.ticks] }
    this.invalidate()
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
    const y0 = SURFACE.depth * height / 2, zMax = SURFACE.height * Math.min(width, height), hT = textPlaneHeight(SURFACE.tick.size)
    // the plate as deep as the lying labels push it (the x labels under the front row, the y labels on the first and
    // last rows), the surface at the full height, the ticks standing at the back up to it
    const fit = plateBound(y0, [[-y0, zMax], [y0, zMax], [y0, -hT / 2], [y0, zMax + hT / 2]])
    const ring = tiltedZ(-y0, zMax) + fit.z + SURFACE.ring / 2
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
    if (!this.prepare(ctx)) return false
    let moving = false
    const cols = this.metrics?.cols ?? 0
    this.waits.forEach((wait, r) => {
      const s = stepSprings(this.springs.slice(r * cols, (r + 1) * cols), wait, dt, ctx.reducedMotion)
      this.waits[r] = s.wait
      if (s.changed) this.posed = false
      if (s.moving) moving = true
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

  protected hasData(): boolean { return this.data !== null }

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
    const plate = makePlate(true)
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
  protected paint(ctx: Viewport3DContext): void {
    const palette = framePalette(ctx), { label, fill } = palette, last = this.data?.ramp.at(-1)
    const key = [label, fill, last ?? ''].join('|')
    const p = this.parts
    this.palette = palette
    if (key === this.paletteKey || !p) return
    this.paletteKey = key
    paintFrame(p.plate, [...this.planes.x, ...this.planes.y, ...this.planes.ticks], palette)
    p.grid.material.color.setRGB(label[0], label[1], label[2], SRGBColorSpace)
    p.guide.material.color.setRGB(label[0], label[1], label[2], SRGBColorSpace)
    p.ring.material.color.setRGB(fill[0], fill[1], fill[2], SRGBColorSpace)
    if (last) p.dot.material.color.setRGB(last[0], last[1], last[2], SRGBColorSpace)
  }

  /**
   * Lays the chart out in `ctx`'s box: the surface geometry (made again for a new shape, its heights then growing in),
   * the springs' targets, the labels (made for new text), the grid lines, the plate around the grid and the lying
   * labels, then the tilt's seat. Nothing before data and a box with an area.
   */
  protected layout(ctx: Viewport3DContext): void {
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
    fitPlate(p.plate, { x0: g.x0, x1: -g.x0, y0: -g.y0, y1: g.y0 }, [...this.planes.x, ...this.planes.y])
    this.seat(g, ctx)
    this.dirty = false; this.posed = false
  }

  /** Makes the label planes for new text, then places them (see the class comment), thinning crowded ones. */
  private layoutLabels(g: Grid): void {
    const { label: L, tick: T } = SURFACE, gap = L.gap
    for (const k of ['x', 'y', 'ticks'] as const) {
      syncPlanes(this.planes[k], this.texts[k], (t, i) => {
        const n = framePlane(t, `${k}-label-${i}`, { size: k === 'ticks' ? T.size : L.size, color: this.palette.label, align: k === 'x' ? 'center' : 'right', createCanvas: this.createCanvas })
        this.inner.add(n)
        return n
      })
    }
    thinPlanes(this.planes.x, g.cols, m => (m.userData.ink as number) + gap, g.px)
    // lying back, the rows' labels are foreshortened onto each other: two lines' room apart, counted from the front row
    // (the latest, always shown); the back row's gives way to the value axis's 0, which stands there
    thinPlanes(this.planes.y, g.rows, () => 2 * L.size, g.py, 'last')
    const back = this.planes.y[0]
    if (back && this.texts.ticks.length > 0 && g.rows > 1) back.visible = false
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

  /**
   * Places the tilted frame (`seatFrame`): its lowest point (the plate's back edge, a tick label) `SURFACE.seat` over
   * the glass, and the chart (the plate, the full height, the standing ticks) centred across and up the box; with an
   * eye in `ctx`, fitted inside the box as seen from it.
   */
  private seat(g: Grid, ctx: Viewport3DContext): void {
    // the surface at the full height on its four corners, and the standing ticks' planes (their y is the height)
    const x1 = g.x0 + (g.cols - 1) * g.px, pts: [number, number, number][] = []
    for (const x of [g.x0, x1]) for (const y of [-g.y0, g.y0]) pts.push([x, y, g.zMax])
    for (const m of this.planes.ticks) {
      m.geometry.computeBoundingBox()
      const b = m.geometry.boundingBox!
      for (const x of [m.position.x + b.min.x, m.position.x + b.max.x]) for (const z of [m.position.z + b.min.y, m.position.z + b.max.y]) pts.push([x, g.y0, z])
    }
    seatFrame(this.inner, this.built.plate, pts, this.viewOf(ctx))
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
