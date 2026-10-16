import type { RGBA } from '@glassui/core'
import { cssColor as css } from './colors'

/** pt: the gutter left of the plot (the y labels) and the one under it (the x labels). */
export const GUTTER = { left: 44, bottom: 22 } as const

/** What `drawLineChart` draws. Lengths in pt; colours sRGB 0..1. */
export interface LineChartDrawing {
  /** The chart's size, pt: the canvas is `width · scale` × `height · scale` px. */
  width: number; height: number; scale: number
  /** One per point, left to right; at most 6 are drawn (`MAX_X_LABELS`). */
  labels: readonly string[]
  /** Each series' line colour and values, one per label. */
  series: readonly { color: RGBA; data: readonly number[] }[]
  /** The y axis, bottom to top (`niceTicks`): its first and last span the plot's height, each gets a grid line and a label. */
  ticks: readonly number[]
  grid: RGBA; text: RGBA
  /** The labels' font family list (CSS `font-family`, e.g. `system-ui, sans-serif`); they are 12 pt, weight 600. */
  font: string
  /** A tick's label. */
  format: (v: number) => string
  /** The index the pointer is on (a guide and a dot per series), or null. */
  hover: number | null
}

/** At most this many x labels. */
const MAX_X_LABELS = 6
/**
 * pt: a series' line width, a hover dot's radius, the labels' size, the gap between a y label and the plot, an x
 * label's centre under the plot.
 */
const LINE = 2.5, DOT = 4, FONT_SIZE = 12, LABEL_GAP = 8, X_LABEL_Y = 13
/** The labels' weight (the Text engine's semibold). */
const FONT_WEIGHT = 600
/** pt: the least a y label shrinks to so that the widest fits the gutter. */
const MIN_FONT_SIZE = 8
/** The alpha of an area under a curve at its top (fading to 0 at the plot's bottom), and of the hover guide, × the colour's own. */
const AREA_ALPHA = 0.22, GUIDE_ALPHA = 0.5

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** The indices of the x labels drawn: all of up to 6, else 6 spread evenly over them, the first and last included. */
function picked(n: number): number[] {
  if (n <= MAX_X_LABELS) return Array.from({ length: n }, (_, i) => i)
  return Array.from({ length: MAX_X_LABELS }, (_, j) => Math.round(j * (n - 1) / (MAX_X_LABELS - 1)))
}

/**
 * Fritsch–Carlson tangents (dy/dx) at the points (xs[i], ys[i]), x increasing: the Hermite cubic through them is
 * monotone between any two points, so it never overshoots the data (flat at a peak, a trough or a flat run).
 */
function tangents(xs: readonly number[], ys: readonly number[]): number[] {
  const n = xs.length, d: number[] = []
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1]! - ys[i]!) / (xs[i + 1]! - xs[i]!))
  // ends: the one-sided secant; inside: the mean of the two secants, or 0 where the data turns
  const m = xs.map((_, i) => i === 0 ? d[0]! : i === n - 1 ? d[n - 2]! : d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2)
  for (let i = 0; i < n - 1; i++) {
    const s = d[i]!
    if (s === 0) { m[i] = 0; m[i + 1] = 0; continue }
    const a = m[i]! / s, b = m[i + 1]! / s, r = a * a + b * b
    if (r > 9) { const t = 3 / Math.sqrt(r); m[i] = t * a * s; m[i + 1] = t * b * s }
  }
  return m
}

/** The curve through the points as Bézier segments (the Hermite cubic with tangents `m`), starting with a `moveTo`. */
function trace(ctx: CanvasRenderingContext2D, xs: readonly number[], ys: readonly number[], m: readonly number[]): void {
  ctx.moveTo(xs[0]!, ys[0]!)
  for (let i = 0; i < xs.length - 1; i++) {
    const h = (xs[i + 1]! - xs[i]!) / 3
    ctx.bezierCurveTo(xs[i]! + h, ys[i]! + m[i]! * h, xs[i + 1]! - h, ys[i + 1]! - m[i + 1]! * h, xs[i + 1]!, ys[i + 1]!)
  }
}

/**
 * A 2D line chart into `ctx`, in pt scaled by `o.scale` (the canvas is `width · scale` px wide). The plot spans
 * x `GUTTER.left`..`width` (label i at i / (n − 1) of it) and y 0..`height − GUTTER.bottom` (the first tick at the
 * bottom, the last at the top), and holds, back to front:
 * - a 1 pt horizontal grid line per tick, in `grid`; the ticks' `format`ted labels right-aligned 8 pt left of the plot
 *   (the top one kept inside the canvas; all of them smaller, down to 8 pt, when the widest would not fit), and up to
 *   6 x labels evenly picked, centred under their points in the bottom gutter (the end ones kept inside the canvas),
 *   all `600 12px <font>` in `text`;
 * - under each series' curve, an area fading from its colour at alpha 0.22 at the curve's top to 0 at the plot's bottom;
 * - each series as a smooth monotone cubic (Fritsch–Carlson), 2.5 pt wide, round joins;
 * - with `hover`, a 1 pt vertical guide at that index in `text` at half its alpha, and a dot of radius 4 pt in each
 *   series' colour on its point.
 * Pure: it only draws (the context's state is restored), so it runs on a DOM canvas and on `@napi-rs/canvas` alike.
 */
export function drawLineChart(ctx: CanvasRenderingContext2D, o: LineChartDrawing): void {
  const { width, height, scale, labels, ticks, format } = o
  const left = GUTTER.left, bottom = height - GUTTER.bottom, n = labels.length
  const lo = ticks[0] ?? 0, span = (ticks.at(-1) ?? 1) - lo || 1
  const xAt = (i: number): number => left + (n > 1 ? i / (n - 1) : 0.5) * (width - left)
  const yAt = (v: number): number => bottom - (v - lo) / span * bottom
  /** `v` on the pixel grid: a 1 pt line there covers whole pixel rows (at an integer scale). */
  const snap = (v: number): number => Math.round(v * scale) / scale

  ctx.save()
  ctx.scale(scale, scale)

  ctx.lineWidth = 1; ctx.strokeStyle = css(o.grid)
  ctx.beginPath()
  for (const t of ticks) { const y = snap(yAt(t)); ctx.moveTo(left, y); ctx.lineTo(width, y) }
  ctx.stroke()

  ctx.font = `${FONT_WEIGHT} ${FONT_SIZE}px ${o.font}`; ctx.fillStyle = css(o.text); ctx.textBaseline = 'middle'
  // the y labels share one size, smaller when the widest would not fit left of the plot (a unit: "1500 件")
  // (re-measured each time: a width is not quite proportional to the size; half-pt steps, each smaller, so it ends)
  const yLabels = ticks.map(format), room = left - LABEL_GAP
  const widest = (): number => Math.max(0, ...yLabels.map(s => ctx.measureText(s).width))
  for (let size = FONT_SIZE, w = widest(); w > room && size > MIN_FONT_SIZE; w = widest()) {
    size = Math.max(MIN_FONT_SIZE, Math.floor(size * room / w * 2) / 2)
    ctx.font = `${FONT_WEIGHT} ${size}px ${o.font}`
  }
  ctx.textAlign = 'right'
  // the top label's middle kept 7 pt down: centred on the top line it would be cut in half
  yLabels.forEach((s, k) => { ctx.fillText(s, room, Math.max(yAt(ticks[k]!), FONT_SIZE / 2 + 1)) })
  ctx.font = `${FONT_WEIGHT} ${FONT_SIZE}px ${o.font}`
  ctx.textAlign = 'center'
  for (const i of picked(n)) {
    const s = labels[i]!, half = ctx.measureText(s).width / 2
    ctx.fillText(s, clamp(xAt(i), half, width - half), bottom + X_LABEL_Y)
  }

  const curves = o.series.map(s => {
    const xs = s.data.map((_, i) => xAt(i)), ys = s.data.map(yAt)
    return { color: s.color, xs, ys, m: tangents(xs, ys) }
  }).filter(c => c.xs.length >= 2)
  // every area first, then every line: an area never veils another series' line
  for (const c of curves) {
    const g = ctx.createLinearGradient(0, Math.min(...c.ys), 0, bottom)
    g.addColorStop(0, css(c.color, AREA_ALPHA)); g.addColorStop(1, css(c.color, 0))
    ctx.beginPath(); trace(ctx, c.xs, c.ys, c.m)
    ctx.lineTo(c.xs.at(-1)!, bottom); ctx.lineTo(c.xs[0]!, bottom); ctx.closePath()
    ctx.fillStyle = g; ctx.fill()
  }
  ctx.lineWidth = LINE; ctx.lineJoin = 'round'; ctx.lineCap = 'round'
  for (const c of curves) { ctx.beginPath(); trace(ctx, c.xs, c.ys, c.m); ctx.strokeStyle = css(c.color); ctx.stroke() }

  const i = o.hover
  if (i !== null && i >= 0 && i < n) {
    const x = snap(xAt(i))
    ctx.lineWidth = 1; ctx.strokeStyle = css(o.text, GUIDE_ALPHA)
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, bottom); ctx.stroke()
    for (const c of curves) {
      const y = c.ys[i]
      if (y === undefined) continue
      ctx.fillStyle = css(c.color)
      ctx.beginPath(); ctx.arc(xAt(i), y, DOT, 0, Math.PI * 2); ctx.fill()
    }
  }
  ctx.restore()
}
