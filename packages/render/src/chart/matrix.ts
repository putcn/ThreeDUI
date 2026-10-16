import { Color, Group, Mesh, SRGBColorSpace } from 'three'
import type { MeshStandardNodeMaterial } from 'three/webgpu'
import type { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { GlassUIError, Spring, type RGBA } from '@glassui/core'
import type { CanvasFactory } from '@glassui/text'
import type { Viewport3DContext } from '../viewport'
import { barGeometry, barMaterial, MIN_SCALE, MIN_SIZE } from './bar'
import { disposeTextPlane, type TextPlane } from './labels'
import { fitPlate, FRAME, framePalette, framePlane, makePlate, paintFrame, plateBound, seatFrame, stepSprings, syncPlanes, thinPlanes, xLabelY, type GridCell, type Plate } from './frame'

/**
 * `BarMatrix.set`'s data: `values` rows × cols (each row as long, at least 1 × 1, every value finite and ≥ 0), `max`
 * (> 0, finite) the value that stands at the full height (a larger one is capped there), `colors` one per cell, the same
 * shape (sRGB; alpha ignored): the caller's colour scale, such as a fourth value's.
 */
export interface BarMatrixData { values: readonly (readonly number[])[]; max: number; colors: readonly (readonly RGBA[])[] }
/** `BarMatrix.labels`: `rows` one per row (row 0, at the back, first), `cols` one per column (left → right). Extra labels are not shown. */
export interface BarMatrixLabels { rows: readonly string[]; cols: readonly string[] }

/** The matrix's proportions and motion (spatial spec §12.2); its tilt, seat, plate and labels are the frame's (`FRAME`). */
export const MATRIX = {
  /** The grid's width (its columns) and depth (its rows, along y before the tilt), of the box's width and height. */
  fill: 0.8,
  /** A bar's footprint, of its cell: across (of the cell's width) and in depth (of the cell's depth). */
  footprint: 0.55,
  /** The full height (`max`), of the box's shorter side. */
  height: 0.45,
  /** Seconds: on the first `set` of a shape, cell (r, c) starts growing `(r + c) × stagger` after cell (0, 0). */
  stagger: 0.025,
  /** The hovered bar's colour multiplier (linear). */
  hoverBrightness: 1.2,
  /** The hovered bar's height, of its resting height. */
  hoverDepth: 1.08,
} as const

type BarMesh = Mesh<RoundedBoxGeometry, MeshStandardNodeMaterial>
/** One cell's bar: its mesh, its colour and its springs. */
interface Bar {
  mesh: BarMesh
  /** Linear: the data's sRGB colour. */
  base: Color
  /** Of the full height: springs to min(1, value / max). */
  height: Spring
  /** Of its resting height: springs to 1, or `MATRIX.hoverDepth` while hovered. */
  lift: Spring
  /** The colour's multiplier: springs to 1, or `MATRIX.hoverBrightness` while hovered. */
  brightness: Spring
  /** Seconds before its height starts growing (the diagonal stagger). */
  wait: number
}
/** The grid as laid out: `cols` cells `cw` wide from x = `x0` (its left edge), `rows` cells `cd` deep from y = `y0` (its back edge) toward −y. */
interface Grid { rows: number; cols: number; x0: number; cw: number; y0: number; cd: number; zMax: number }

/**
 * A bar standing on the plate (the 9E bar, `barGeometry`, turned to rise along +z): footprint `width` × `depth`
 * centred on the origin, base at z = 0, `height` high; `parameters` keep (width, height, depth).
 */
function standingBar(width: number, depth: number, height: number): RoundedBoxGeometry {
  return barGeometry(width, height, depth).rotateX(Math.PI / 2).translate(0, depth / 2, 0)
}

/**
 * The zone × category stock matrix (spatial spec §12.2): one rounded bar per cell of `values` (rows × cols), its height
 * the value and its colour the caller's (a fourth value: days of cover), to attach with `Surface.attach3D` (`update` as
 * the attachment's, `(dt, ctx) => chart.update(dt, ctx)`), so its origin is the box centre on the glass, 1 unit = 1 pt.
 *
 * Built in `inner`'s frame, the same frame as `SurfaceChart`'s (`FRAME`: the tilt, the seat on the glass, the plate,
 * the lying labels): the grid spans `MATRIX.fill` × the box's width (columns) and × its height (rows along y, row 0 at
 * the back); bar (r, c) stands centred on its cell, its footprint `MATRIX.footprint` of the cell's width and depth, a
 * value rising along z to `max` at `MATRIX.height` × the box's shorter side (a larger value is capped there).
 *
 * Parts, each its own draw (the attachment keeps their order: the plate, the labels, then the bars):
 * - bars (`bars`, row-major): each a `Mesh` (`bar-<r>-<c>`, `userData` = `{ row, col }`), the 9E bar
 *   (`barGeometry`, `MeshStandardNodeMaterial` roughness 0.35) turned to stand on the plate. Few cells, so no
 *   instancing: the corners are exact at rest and a raycast hits the bar itself (a pointer event's `object`). The only
 *   parts that cast shadows and take the pointer.
 * - `plate`: a thin translucent base (the theme's `fill`) under the grid and the labels; the pointer goes through it.
 * - labels (`textPlane`s, `secondaryLabel`): `cols` under the front edge, centred on their columns; `rows` left of the
 *   grid, ending at it, centred on their rows; both lying on the plate, thinned to every n-th when they would overlap.
 *
 * Each bar's geometry is built at its target height (a zero one: at its width, and hidden at rest); `scale.z` = its
 * current height / that, floored at 1e-4, so a new target rebuilds the geometry without a jump on screen. Heights spring
 * (the theme's `smooth`, as of the bar's creation) as a fraction of the full height: on the first `set` of a shape, cell
 * (r, c) waits `(r + c) × MATRIX.stagger` s, then grows from 0; a later `set` springs from where the heights are;
 * reduced motion puts them there at once. The hovered bar springs brighter (`MATRIX.hoverBrightness`) and taller
 * (`MATRIX.hoverDepth` of its height). A new box size lays the matrix out again at once. Theme colours follow `ctx`.
 */
export class BarMatrix extends Group {
  /** The tilted, seated frame the matrix is built in (see the class comment). */
  readonly inner = new Group()
  private readonly createCanvas: CanvasFactory
  private data: { values: number[][]; max: number; colors: RGBA[][] } | null = null
  private texts: { rows: string[]; cols: string[] } = { rows: [], cols: [] }
  private readonly planes: { rows: TextPlane[]; cols: TextPlane[] } = { rows: [], cols: [] }
  private plateMesh: Plate | null = null
  private readonly list: Bar[] = []
  /** The last `update`'s context: the box, the motion preference and the theme. */
  private ctx: Viewport3DContext | null = null
  /** The shape the bars were made for, `rows × cols`. */
  private shape = ''
  /** pt: the full height, as last laid out. */
  private zMax = 0
  private hovered: GridCell | null = null
  /** The theme's colours as last applied, and their key. */
  private palette: { label: RGBA; fill: RGBA } = { label: [0, 0, 0, 1], fill: [1, 1, 1, 1] }
  private paletteKey = ''
  /** Something the layout depends on changed since the last one (data, labels). */
  private dirty = true

  /** `createCanvas`: what the labels are drawn on (the root's canvas factory). */
  constructor(opts: { createCanvas: CanvasFactory }) {
    super()
    this.createCanvas = opts.createCanvas
    this.name = 'bar-matrix'; this.inner.name = 'tilt'
    this.inner.rotation.x = FRAME.tilt
    this.add(this.inner)
  }

  /** The bars, row-major: `bars[r × cols + c].userData` is `{ row: r, col: c }`. Empty until the first layout. */
  get bars(): readonly Mesh[] { return this.list.map(b => b.mesh) }
  /** The base plate; it exists once the matrix is first laid out (data and a box), and throws before. */
  get plate(): Plate {
    if (!this.plateMesh) throw new GlassUIError('BarMatrix', '矩阵还没有画出来：先 set 数据，再 update 一帧')
    return this.plateMesh
  }
  /** The label planes, in label order (thinned ones hidden, not removed). */
  get labelPlanes(): Readonly<{ rows: readonly TextPlane[]; cols: readonly TextPlane[] }> { return this.planes }

  /**
   * New data: throws a readable `GlassUIError` for a `max` that is not a finite number > 0, fewer than 1 × 1 values,
   * rows of different lengths, a value negative or not finite, or `colors` of another shape, changing nothing. Laid out
   * now when an `update` has told the box, else at the first one.
   */
  set(data: BarMatrixData): void {
    const scope = 'BarMatrix.set', { values, max, colors } = data
    if (!(max > 0 && max < Infinity)) throw new GlassUIError(scope, `max 必须是大于 0 的有限数，收到 ${max}`)
    const cols = values[0]?.length ?? 0
    if (cols < 1) throw new GlassUIError(scope, `values 至少要 1 × 1（1 行，每行 1 个），收到 ${values.length} 行${values.length ? '、第 1 行 0 个' : ''}`)
    values.forEach((row, r) => {
      if (row.length !== cols) throw new GlassUIError(scope, `values 每行一样长：第 1 行 ${cols} 个，第 ${r + 1} 行 ${row.length} 个`)
      row.forEach((v, c) => { if (!(v >= 0 && v < Infinity)) throw new GlassUIError(scope, `values[${r}][${c}] 必须是不小于 0 的有限数，收到 ${v}`) })
    })
    if (colors.length !== values.length) throw new GlassUIError(scope, `colors 要与 values 同形（每格一个颜色）：${values.length} 行，收到 ${colors.length} 行`)
    const bad = colors.findIndex(row => row.length !== cols)
    if (bad >= 0) throw new GlassUIError(scope, `colors 要与 values 同形（每格一个颜色）：每行 ${cols} 个，第 ${bad + 1} 行 ${colors[bad]!.length} 个`)
    this.data = { values: values.map(r => [...r]), max, colors: colors.map(r => r.map(c => [...c] as RGBA)) }
    this.dirty = true
    if (this.ctx) this.layout(this.ctx)
  }

  /** New row and column labels (see `BarMatrixLabels`); planes are made again only for changed text. */
  labels(l: BarMatrixLabels): void {
    this.texts = { rows: [...l.rows], cols: [...l.cols] }
    this.dirty = true
    if (this.ctx) this.layout(this.ctx)
  }

  /** Springs `cell`'s bar brighter and taller (`MATRIX.hoverBrightness`, `MATRIX.hoverDepth`), the others back; null, or a cell the data lacks: none. */
  hover(cell: GridCell | null): void { this.hovered = cell ? { row: cell.row, col: cell.col } : null }

  /**
   * pt: the most this matrix, laid out in a box `width` × `height`, rises off the glass it is seated on (its plate,
   * labels and bars, a hovered one included), rounded up, whatever its data, shape and labels: the plate as deep as
   * lying labels can make it, a bar at the full height (and hovered) on the front and back edges. For
   * `Attach3DOptions.depth`. It grows with the width only while the width is under the height (the full height is
   * `MATRIX.height` × the shorter side), so `riseFor(h, h)` bounds a box `h` high at any width.
   */
  riseFor(width: number, height: number): number {
    const y0 = MATRIX.fill * height / 2, z = MATRIX.height * Math.min(width, height) * MATRIX.hoverDepth
    return Math.ceil(plateBound(y0, [[-y0, z], [y0, z]]).top)
  }

  /**
   * One frame of `dt` s in `ctx`'s box: follows the theme's colours, lays out again when the box, the data or the
   * labels changed, steps the springs (reduced motion: puts them on their targets), poses the bars. True while anything
   * moves. Nothing to draw (no data, an empty box): false.
   */
  update(dt: number, ctx: Viewport3DContext): boolean {
    const resized = ctx.width !== this.ctx?.width || ctx.height !== this.ctx?.height
    this.ctx = ctx
    if (!this.data) return false
    this.inner.visible = ctx.width > 0 && ctx.height > 0
    if (!this.inner.visible) return false
    this.paint(ctx)
    if (resized || this.dirty) this.layout(ctx)
    const h = this.hovered, reduced = ctx.reducedMotion
    let moving = false
    for (const b of this.list) {
      const on = h !== null && b.mesh.userData.row === h.row && b.mesh.userData.col === h.col
      b.lift.set(on ? MATRIX.hoverDepth : 1); b.brightness.set(on ? MATRIX.hoverBrightness : 1)
      // the stagger holds back the growth only: a hover answers at once
      const grow = stepSprings([b.height], b.wait, dt, reduced), mark = stepSprings([b.lift, b.brightness], 0, dt, reduced)
      b.wait = grow.wait
      if (grow.moving || mark.moving) moving = true
    }
    this.pose()
    return moving
  }

  /** Frees every bar, the plate and the label textures and empties the matrix; it draws nothing until the next `set`, which grows it in anew. */
  dispose(): void {
    for (const k of ['rows', 'cols'] as const) for (const m of this.planes[k].splice(0)) disposeTextPlane(m)
    for (const b of this.list.splice(0)) this.drop(b)
    const p = this.plateMesh
    if (p) { p.removeFromParent(); p.geometry.dispose(); p.material.dispose() }
    this.plateMesh = null; this.data = null; this.shape = ''; this.paletteKey = ''
    this.dirty = true
  }

  /** The theme's colours from `ctx`: applied to the plate and labels when they changed (the textures stay). */
  private paint(ctx: Viewport3DContext): void {
    const palette = framePalette(ctx), key = [palette.label, palette.fill].join('|'), p = this.plateMesh
    this.palette = palette
    if (key === this.paletteKey || !p) return
    this.paletteKey = key
    paintFrame(p, [...this.planes.rows, ...this.planes.cols], palette)
  }

  /**
   * Lays the matrix out in `ctx`'s box: the bars (made again for a new shape, then growing in; rebuilt for a new size
   * or target height), their colours and targets, the labels (made for new text), the plate around the grid and the
   * labels, then the tilt's seat. Nothing before data and a box with an area.
   */
  private layout(ctx: Viewport3DContext): void {
    const d = this.data, W = ctx.width, H = ctx.height
    if (!d || !(W > 0 && H > 0)) return
    if (!this.plateMesh) { this.plateMesh = makePlate(false); this.inner.add(this.plateMesh); this.paletteKey = '' }
    const plate = this.plateMesh
    this.paint(ctx)
    const rows = d.values.length, cols = d.values[0]!.length, cfg = ctx.theme.springs.smooth
    const GW = MATRIX.fill * W, GD = MATRIX.fill * H
    const g: Grid = { rows, cols, x0: -GW / 2, cw: GW / cols, y0: GD / 2, cd: GD / rows, zMax: MATRIX.height * Math.min(W, H) }

    // a new shape is a new set of bars, grown in along the diagonals; the same shape springs from where it is
    const shape = `${rows}×${cols}`
    if (shape !== this.shape) { this.shape = shape; for (const b of this.list.splice(0)) this.drop(b) }
    const w = Math.max(MATRIX.footprint * g.cw, MIN_SIZE), depth = Math.max(MATRIX.footprint * g.cd, MIN_SIZE)
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const target = Math.min(1, d.values[r]![c]! / d.max), h = Math.max(target > 0 ? target * g.zMax : w, MIN_SIZE)
      let b = this.list[r * cols + c]
      if (!b) {
        const mesh: BarMesh = new Mesh(standingBar(w, depth, h), barMaterial())
        mesh.name = `bar-${r}-${c}`; mesh.userData = { row: r, col: c }
        b = { mesh, base: new Color(), height: new Spring(0, cfg), lift: new Spring(1, cfg), brightness: new Spring(1, cfg), wait: (r + c) * MATRIX.stagger }
        this.list.push(b); this.inner.add(mesh)
      } else {
        const p = b.mesh.geometry.parameters
        if (p.width !== w || p.height !== h || p.depth !== depth) { b.mesh.geometry.dispose(); b.mesh.geometry = standingBar(w, depth, h) }
      }
      const [cr, cg, cb] = d.colors[r]![c]!
      b.base.setRGB(cr, cg, cb, SRGBColorSpace)
      b.height.set(target)
      b.mesh.position.set(g.x0 + (c + 0.5) * g.cw, g.y0 - (r + 0.5) * g.cd, 0)
    }

    this.layoutLabels(g)
    fitPlate(plate, { x0: g.x0, x1: -g.x0, y0: -g.y0, y1: g.y0 }, [...this.planes.rows, ...this.planes.cols])
    // seated for the bars at the full height (their front and back faces), whatever the data: new data never moves it
    const inset = (g.cd - depth) / 2
    seatFrame(this.inner, plate, [[-g.y0 + inset, g.zMax], [g.y0 - inset, g.zMax]])
    this.zMax = g.zMax; this.dirty = false
    this.pose()
  }

  /** Makes the label planes for new text, then places them (see the class comment), thinning crowded ones. */
  private layoutLabels(g: Grid): void {
    const L = FRAME.label
    for (const k of ['rows', 'cols'] as const) {
      syncPlanes(this.planes[k], this.texts[k], (t, i) => {
        const n = framePlane(t, `${k === 'rows' ? 'row' : 'col'}-label-${i}`, { size: L.size, color: this.palette.label, align: k === 'cols' ? 'center' : 'right', createCanvas: this.createCanvas })
        this.inner.add(n)
        return n
      })
    }
    thinPlanes(this.planes.cols, g.cols, m => (m.userData.ink as number) + L.gap, g.cw)
    thinPlanes(this.planes.rows, g.rows, () => L.size + L.gap / 2, g.cd)
    this.planes.cols.forEach((m, c) => { m.position.set(g.x0 + (c + 0.5) * g.cw, xLabelY(g.y0), L.lift) })
    this.planes.rows.forEach((m, r) => { m.position.set(g.x0 - L.gap, g.y0 - (r + 0.5) * g.cd, L.lift) })
  }

  /** Each bar's height (its springs, of the full height), visibility and colour. */
  private pose(): void {
    for (const b of this.list) {
      const m = b.mesh, rest = b.height.value * this.zMax
      m.scale.z = Math.max(rest * b.lift.value / m.geometry.parameters.height, MIN_SCALE)
      m.visible = rest > 0
      m.material.color.copy(b.base).multiplyScalar(b.brightness.value)
    }
  }

  /** Takes `b` off the matrix and frees its geometry and material. */
  private drop(b: Bar): void {
    b.mesh.removeFromParent()
    b.mesh.geometry.dispose(); b.mesh.material.dispose()
  }
}
