import { Color, Group, Mesh, SRGBColorSpace } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { GlassUIError, Spring, type RGBA } from '@glassui/core'
import type { Viewport3DContext } from '../viewport'

/** `BarChart.set`'s data: one bar per value (≥ 0, finite), each in its colour (sRGB; alpha ignored); `max` (> 0, finite) is the box's full height. */
export interface BarChartData { values: readonly number[]; colors: readonly RGBA[]; max: number }

/** The bar chart's proportions and motion (spatial spec §2.5). */
export const BAR = {
  /** A bar's width, of its column (the box width / n). */
  widthRatio: 0.6,
  /** A bar's depth (out of the plate), of its width. */
  depthRatio: 0.6,
  /** The corner radius, of the bar's width (and at most half its height and its depth). */
  radiusRatio: 0.12,
  /** Seconds: on the first `set`, bar i starts growing `i × stagger` after bar 0. */
  stagger: 0.04,
  /** The hovered bar's colour multiplier (linear). */
  hoverBrightness: 1.2,
  /** The hovered bar's depth, of its resting depth. */
  hoverDepth: 1.15,
} as const

/** A bar's matrix never goes singular (a raycast or a normal through it would break): its scales stay above this. */
export const MIN_SCALE = 1e-4
/** pt: a geometry's smallest side, so a box with no width (or a bar with no height) still builds a finite one. */
export const MIN_SIZE = 1e-3

/**
 * The spatial spec's layout (§2.5) for `n` bars in a box `width` × `height` pt centred on the origin: n equal columns,
 * bar i centred on its column (`x`), `BAR.widthRatio` of its width, `values[i] / max` of the box high. The Vue layer's
 * label row uses the same columns.
 */
export function barLayout(n: number, width: number, height: number, values: readonly number[], max: number): { x: number; width: number; height: number }[] {
  const column = width / n
  return Array.from({ length: n }, (_, i) => ({ x: (i + 0.5) * column - width / 2, width: BAR.widthRatio * column, height: (values[i] ?? 0) / max * height }))
}

/**
 * A rounded box `width` × `height` × `depth` pt (corners `BAR.radiusRatio` of its width, at most half its height and
 * depth), its base at y = 0 and its back at z = 0 (it stands on the plate, rising out of it). Its `parameters` keep the
 * three sizes, so a caller sees when a new size needs a new one.
 */
export function barGeometry(width: number, height: number, depth: number): RoundedBoxGeometry {
  const g = new RoundedBoxGeometry(width, height, depth, 3, Math.min(BAR.radiusRatio * width, height / 2, depth / 2))
  g.translate(0, height / 2, depth / 2)
  return g
}

/** A bar's material: lit, a little glossy (roughness 0.35, metalness 0); its colour is the bar's. */
export const barMaterial = (): MeshStandardNodeMaterial => new MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0 })

/** One bar: its mesh, its colour and its springs. */
interface Bar {
  mesh: Mesh<RoundedBoxGeometry, MeshStandardNodeMaterial>
  /** Linear: the data's sRGB colour. */
  base: Color
  /** Of the box height: springs to `value / max`. */
  height: Spring
  /** Of the bar's resting depth: springs to 1, or `BAR.hoverDepth` while hovered. */
  depth: Spring
  /** The colour's multiplier: springs to 1, or `BAR.hoverBrightness` while hovered. */
  brightness: Spring
  /** Seconds before its springs start (the first `set`'s stagger). */
  wait: number
}

/**
 * A 3D bar chart (spatial spec §2.5), to attach to a layout node with `Surface.attach3D`, `update` as the attachment's
 * (a method: pass `(dt, ctx) => chart.update(dt, ctx)`), so its origin is the box centre, 1 unit = 1 pt, z out of the
 * plate; it rises at most `BAR.depthRatio × BAR.hoverDepth` of a bar's width off it. Each bar is its own `Mesh` (`bar-<i>`,
 * `userData.index` = i): a rounded box in a `MeshStandardNodeMaterial` (roughness 0.35, metalness 0) standing on the
 * box's bottom edge and rising out of the plate. Few bars, so no instancing: the corners are exact at rest and a raycast
 * hits the bar itself. The attachment fades and orders the bars; the chart leaves `transparent` and opacity alone.
 *
 * A bar's geometry is built at its target height (a zero one: at its width; hidden at rest, as is any bar with no
 * height yet); `scale.y` = current height / that, `scale.z` = current depth / resting depth, both floored at 1e-4. A
 * new target rebuilds the geometry and rescales, so the bar's height on screen does not jump, and its corners stretch
 * only while it moves. Heights, depths and brightnesses spring (the theme's `smooth`, as of the bar's creation). Heights
 * spring as a fraction of the box height: a new box size re-lays out every bar at once, with no animation.
 */
export class BarChart extends Group {
  private readonly list: Bar[] = []
  private data: BarChartData | null = null
  /** The last `update`'s: the box the bars are laid out in, the theme their springs come from. */
  private ctx: Viewport3DContext | null = null
  private hovered: number | null = null
  /** The first `set` has not been laid out yet: its bars start one after another (`BAR.stagger`). */
  private entrance = true

  /** The bars, in data order: `bars[i].userData.index === i`. */
  get bars(): readonly Mesh[] { return this.list.map(b => b.mesh) }

  /**
   * New data: throws a readable `GlassUIError` for a `max` not finite or ≤ 0, a value negative or not finite, or a
   * `colors` of another length than `values`, changing nothing. On the first `set` bar i waits `i × BAR.stagger` s, then
   * its height and depth grow from 0; a later one springs the heights from where they are, and an added bar grows from
   * 0 (a dropped one is disposed at once). Laid out now when an `update` has told the box size, else at the first one.
   */
  set(data: BarChartData): void {
    const scope = 'BarChart.set', { values, colors, max } = data
    if (!(max > 0 && max < Infinity)) throw new GlassUIError(scope, `max 必须是大于 0 的有限数，收到 ${max}`)
    values.forEach((v, i) => { if (!(v >= 0 && v < Infinity)) throw new GlassUIError(scope, `values[${i}] 必须是不小于 0 的有限数，收到 ${v}`) })
    if (colors.length !== values.length) throw new GlassUIError(scope, `colors 的长度（${colors.length}）必须等于 values 的长度（${values.length}）`)
    this.data = { values: [...values], colors: [...colors], max }
    if (this.ctx) this.layout(this.ctx)
  }

  /** Springs bar `index`'s brightness to `BAR.hoverBrightness` and its depth to `BAR.hoverDepth`, the others back to 1; null: none. */
  hover(index: number | null): void { this.hovered = index }

  /**
   * One frame of `dt` s in `ctx`'s box: re-lays out the bars when its size changed, steps the springs (reduced motion:
   * puts them on their targets), poses the bars. True while anything moves.
   */
  update(dt: number, ctx: Viewport3DContext): boolean {
    const resized = ctx.width !== this.ctx?.width || ctx.height !== this.ctx?.height
    this.ctx = ctx
    if (resized) this.layout(ctx)
    let moving = false
    this.list.forEach((b, i) => {
      const on = i === this.hovered, springs = [b.height, b.depth, b.brightness]
      b.depth.set(on ? BAR.hoverDepth : 1); b.brightness.set(on ? BAR.hoverBrightness : 1)
      if (ctx.reducedMotion) {
        b.wait = 0
        for (const s of springs) s.jump(s.target)
      } else {
        let t = dt
        if (b.wait > 0 && dt > 0) { const w = Math.min(b.wait, dt); b.wait -= w; t -= w }
        for (const s of springs) s.step(t)
      }
      if (b.wait > 0 || springs.some(s => !s.done)) moving = true
    })
    this.pose(ctx.height)
    return moving
  }

  /** Disposes every bar's geometry and material and removes the bars; the chart is empty until the next `set`. */
  dispose(): void {
    for (const b of this.list.splice(0)) this.drop(b)
    this.data = null
  }

  /**
   * Brings the bars to `data` in `ctx`'s box: drops the extra ones, adds the missing ones (at height and depth 0),
   * sets each one's colour and target height, places it and rebuilds its geometry if its size changed; then poses them.
   */
  private layout(ctx: Viewport3DContext): void {
    const data = this.data
    if (!data) return
    const { values, colors, max } = data, cfg = ctx.theme.springs.smooth
    for (const b of this.list.splice(values.length)) this.drop(b)
    barLayout(values.length, ctx.width, ctx.height, values, max).forEach((l, i) => {
      const w = Math.max(l.width, MIN_SIZE), h = Math.max(l.height > 0 ? l.height : w, MIN_SIZE), d = BAR.depthRatio * w
      let b = this.list[i]
      if (!b) {
        const mesh = new Mesh(barGeometry(w, h, d), barMaterial())
        mesh.name = `bar-${i}`; mesh.userData.index = i
        b = { mesh, base: new Color(), height: new Spring(0, cfg), depth: new Spring(0, cfg), brightness: new Spring(1, cfg), wait: this.entrance ? i * BAR.stagger : 0 }
        this.list.push(b); this.add(mesh)
      } else {
        const p = b.mesh.geometry.parameters
        if (p.width !== w || p.height !== h || p.depth !== d) { b.mesh.geometry.dispose(); b.mesh.geometry = barGeometry(w, h, d) }
      }
      const [r, g, bl] = colors[i]!
      b.base.setRGB(r, g, bl, SRGBColorSpace)
      b.height.set(values[i]! / max)
      b.mesh.position.set(l.x, -ctx.height / 2, 0)
    })
    this.entrance = false
    this.pose(ctx.height)
  }

  /** Each bar's scales, visibility and colour from its springs, in a box `H` pt high. */
  private pose(H: number): void {
    for (const b of this.list) {
      const m = b.mesh, shown = b.height.value * H
      m.scale.y = Math.max(shown / m.geometry.parameters.height, MIN_SCALE)
      m.scale.z = Math.max(b.depth.value, MIN_SCALE)
      m.visible = shown > 0
      m.material.color.copy(b.base).multiplyScalar(b.brightness.value)
    }
  }

  /** Takes `b` off the chart and frees its geometry and material. */
  private drop(b: Bar): void {
    this.remove(b.mesh)
    b.mesh.geometry.dispose(); b.mesh.material.dispose()
  }
}
