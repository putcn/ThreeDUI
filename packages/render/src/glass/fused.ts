import { BufferAttribute, InstancedBufferGeometry, ShapeUtils, Sphere, Vector2, Vector3 } from 'three'
import { GlassUIError } from '@glassui/core'
import { profileAt, type SlabInstanceParams } from './slab9'

/*
 * Fused glass (GlassContainer, spec §5.2): nearby glass shapes drawn as one slab — the zero contours (`fusedOutline`)
 * of the smooth union of their rounded-rect SDFs (`fusedField`: the polynomial smin of the nearest two), extruded with
 * the 9-slice slab's fillet profile (`extrudeSlab`) into a plain mesh that `GlassBatch({ mesh })` draws through the
 * glass material (`meshVertex`).
 *
 * Frames: the shapes, `fusedField` and the point `fusedNormal` takes are in Surface pt (y down). The outline and the
 * extrusion share one frame: pt, y up, origin at the centre of the shapes' bounds (`fusedBounds`), back face at z = 0
 * — the slab-local frame of an instance whose rect is those bounds, once scaled by 1 / ptPerUnit.
 */

export type Contour = [number, number][]
/** An axis-aligned rounded rect in Surface pt (already through its instance transform). */
export interface FusedShape { x: number; y: number; width: number; height: number; radius: number }
/**
 * The slab profile `extrudeSlab` follows (pt); the fillets are clamped as on a 9-slice slab `minSide` wide and high, so
 * `minSide` is the smallest member's short side.
 */
export interface FusedProfile { thickness: number; fillet: number; filletBottom: number; minSide: number }
/** A plain slab mesh: xyz positions and unit normals (3 floats per vertex each) and a triangle index. */
export interface SlabMesh { positions: Float32Array; normals: Float32Array; index: Uint32Array }

/**
 * The smoothing `k` per pt of spacing. The polynomial smin lowers the field by at most k/4 (where the two distances are
 * equal), so two shapes a gap g apart join where g/2 < k/4: with k = 2 · spacing they join exactly when g < spacing —
 * the container's contract, and the gap under which Task 16 clusters its members. (k = spacing would join them only
 * under spacing/2, leaving two separate slabs bulging toward each other for gaps in between.)
 */
const SMOOTHING_PER_SPACING = 2

/** Signed distance to a rounded rect (pt; negative inside), y down like the shapes. */
function sdRound(s: FusedShape, x: number, y: number): number {
  const hx = s.width / 2, hy = s.height / 2, r = Math.max(Math.min(s.radius, hx, hy), 0)
  const qx = Math.abs(x - (s.x + hx)) - (hx - r), qy = Math.abs(y - (s.y + hy)) - (hy - r)
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0)                    // sqrt, not Math.hypot: this runs per grid node
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - r
}
/** Polynomial smooth minimum: `h = max(k − |a − b|, 0)/k`, `min(a, b) − h²k/4`; the plain minimum at k ≤ 0. */
function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b)
  const h = Math.max(k - Math.abs(a - b), 0) / k
  return Math.min(a, b) - h * h * k * 0.25
}

/**
 * The smooth union of the shapes' SDFs at (x, y) (Surface pt, y down; negative inside): `smin` of the nearest two
 * (`Infinity` for no shapes; the one SDF for one shape). It depends on the shapes but not on their order, so a symmetric
 * layout gives a symmetric outline and a reorder changes nothing; two shapes blend as the brief's polynomial smin, and
 * nowhere is the field lowered by more than k/4 (folding smin over every shape would add up where three or four meet:
 * in a grid of rounds, a speck of glass inside each hole). It also bounds the cost: only the nearest two count.
 */
export function fusedField(shapes: readonly FusedShape[], spacing: number, x: number, y: number): number {
  let a = Infinity, b = Infinity                                       // the nearest two SDFs, a ≤ b
  for (const s of shapes) { const e = sdRound(s, x, y); if (e < a) { b = a; a = e } else if (e < b) b = e }
  return b === Infinity ? a : smin(a, b, spacing * SMOOTHING_PER_SPACING)
}

/** Nodes per side of the blocks `fusedSamples` culls the shapes for. */
const BLOCK = 8

/**
 * `fusedField` at every node of `grid` (`fusedGrid`), row by row: identical values, at a cost nearly independent of the
 * member count. Per block of BLOCK × BLOCK nodes, a shape is dropped when the block lies off its bounding box and the
 * distance between them (a lower bound of its SDF there) exceeds the second least of the shapes' upper bounds over the
 * block (each SDF at the block's centre plus its half-diagonal: an SDF changes by at most the distance moved): two
 * shapes are then nearer than it at every node of the block, so it is never one of the nearest two.
 */
export function fusedSamples(shapes: readonly FusedShape[], spacing: number, grid: { step: number; x0: number; y0: number; nx: number; ny: number }): Float64Array {
  const { step, x0, y0, nx, ny } = grid, k = spacing * SMOOTHING_PER_SPACING
  const field = new Float64Array(nx * ny), cand = new Int32Array(shapes.length)
  for (let bj = 0; bj < ny; bj += BLOCK) for (let bi = 0; bi < nx; bi += BLOCK) {
    const i1 = Math.min(bi + BLOCK, nx) - 1, j1 = Math.min(bj + BLOCK, ny) - 1
    const ax = x0 + bi * step, bx = x0 + i1 * step, ay = y0 + bj * step, by = y0 + j1 * step
    const mx = (ax + bx) / 2, my = (ay + by) / 2, r = Math.sqrt((bx - ax) ** 2 + (by - ay) ** 2) / 2
    let h1 = Infinity, h2 = Infinity                                   // the least two upper bounds
    for (const s of shapes) { const h = sdRound(s, mx, my) + r; if (h < h1) { h2 = h1; h1 = h } else if (h < h2) h2 = h }
    const reach = h2 + 1e-6                                             // (the margin absorbs rounding)
    let nc = 0
    shapes.forEach((s, q) => {
      const gx = Math.max(s.x - bx, ax - (s.x + s.width), 0), gy = Math.max(s.y - by, ay - (s.y + s.height), 0)
      if ((gx === 0 && gy === 0) || !(Math.sqrt(gx * gx + gy * gy) > reach)) cand[nc++] = q   // overlapping: no bound
    })
    for (let j = bj; j <= j1; j++) for (let i = bi; i <= i1; i++) {
      const x = x0 + i * step, y = y0 + j * step
      let a = Infinity, b = Infinity
      for (let c = 0; c < nc; c++) { const e = sdRound(shapes[cand[c]!]!, x, y); if (e < a) { b = a; a = e } else if (e < b) b = e }
      field[j * nx + i] = b === Infinity ? a : smin(a, b, k)
    }
  }
  return field
}

/**
 * The gradient of `fusedField` at (x, y) (Surface pt, y down; per pt) by central differences, as (x, y) y up: about
 * unit length on a plain SDF, shorter where two shapes blend, near 0 at a bridge's saddle.
 */
function fusedGradient(shapes: readonly FusedShape[], spacing: number, x: number, y: number): [number, number] {
  const e = 0.25
  const gx = fusedField(shapes, spacing, x + e, y) - fusedField(shapes, spacing, x - e, y)
  const gy = fusedField(shapes, spacing, x, y + e) - fusedField(shapes, spacing, x, y - e)
  return [gx / (2 * e), -gy / (2 * e)]                       // y down → y up
}

/**
 * The unit outward gradient of `fusedField` at (x, y) (Surface pt, y down), by central differences, as (x, y) in the
 * outline's y-up frame; (0, 0) where the field is flat.
 */
export function fusedNormal(shapes: readonly FusedShape[], spacing: number, x: number, y: number): [number, number] {
  const [gx, gy] = fusedGradient(shapes, spacing, x, y), l = Math.hypot(gx, gy) || 1
  return [gx / l, gy / l]
}

/** The shapes' bounding rect (Surface pt): the fused frame's origin is its centre. */
export function fusedBounds(shapes: readonly FusedShape[]): { x: number; y: number; width: number; height: number } {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of shapes) { x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x + s.width); y1 = Math.max(y1, s.y + s.height) }
  return shapes.length ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : { x: 0, y: 0, width: 0, height: 0 }
}

/*
 * Marching squares. A cell's corners c0 = (i, j), c1 = (i+1, j), c2 = (i+1, j+1), c3 = (i, j+1) (bit k of the case is
 * "ck is inside": field < 0) are walked c0 → c1 → c2 → c3 → c0, counter-clockwise in grid coordinates (i, j); edge k
 * runs ck → ck+1, and a crossing on it is an exit when ck is inside, an enter otherwise. Each exit pairs with an enter;
 * the segment runs from the enter to the exit, which keeps the inside on its right in (i, j) — so on its left once y
 * flips up: outer loops counter-clockwise, holes clockwise. A shared edge is walked in opposite directions by its two
 * cells (an exit in one is an enter in the other), so every crossing gets exactly one outgoing link and the links close
 * into loops. Saddles (four crossings) pair each exit with the next enter in walk order when the cell centre (the
 * corners' mean) is inside — the insides join — else with the previous one.
 * PAIRS[(case · 2 + centreInside) · 4 …]: up to two (exit, enter) local edge pairs, −1 when unused.
 */
const PAIRS = (() => {
  const t = new Int8Array(16 * 2 * 4).fill(-1)
  for (let c = 0; c < 16; c++) for (let centre = 0; centre < 2; centre++) {
    const inside = (k: number) => (c >> (k & 3)) & 1
    const crossings: number[] = []
    for (let k = 0; k < 4; k++) if (inside(k) !== inside(k + 1)) crossings.push(k)
    let o = (c * 2 + centre) * 4
    crossings.forEach((k, q) => {
      if (!inside(k)) return
      const enter = crossings.length === 2 ? crossings[1 - q]! : crossings[(q + (centre ? 1 : 3)) % 4]!
      t[o++] = k; t[o++] = enter
    })
  }
  return t
})()

/** Global id of local edge `k` of the cell at node `n0`: horizontal edge (n, n+1) = 2n, vertical (n, n+nx) = 2n + 1. */
function edgeId(n0: number, k: number, nx: number): number {
  return k === 0 ? 2 * n0 : k === 1 ? 2 * (n0 + 1) + 1 : k === 2 ? 2 * (n0 + nx) : 2 * n0 + 1
}

/** Distance from point i to the segment a–b of the flat xy array `p`. */
function segDist(p: Float64Array, a: number, i: number, b: number): number {
  const ax = p[2 * a]!, ay = p[2 * a + 1]!, dx = p[2 * b]! - ax, dy = p[2 * b + 1]! - ay
  const px = p[2 * i]! - ax, py = p[2 * i + 1]! - ay, l2 = dx * dx + dy * dy
  const t = l2 > 0 ? Math.min(1, Math.max(0, (px * dx + py * dy) / l2)) : 0
  return Math.hypot(px - t * dx, py - t * dy)
}

/**
 * Douglas–Peucker over a closed loop of `n` points (flat xy): anchored at point 0 and the point farthest from it, then
 * one sweep dropping any kept point within `eps` of the chord between its kept neighbours (an anchor can sit mid-run;
 * earcut would drop such a collinear point from a cap and leave a T-junction). Null below three points.
 */
function simplifyLoop(p: Float64Array, n: number, eps: number): Contour | null {
  if (n < 3) return null
  let far = 0, best = 0
  for (let i = 1; i < n; i++) { const d = (p[2 * i]! - p[0]!) ** 2 + (p[2 * i + 1]! - p[1]!) ** 2; if (d > best) { best = d; far = i } }
  if (far === 0) return null
  const keep = new Uint8Array(n)
  keep[0] = 1; keep[far] = 1
  const stack = [0, far, far, n]                            // index n is point 0 again
  while (stack.length) {
    const l = stack.pop()!, f = stack.pop()!
    let m = -1, dm = eps
    for (let i = f + 1; i < l; i++) { const d = segDist(p, f, i, l % n); if (d > dm) { dm = d; m = i } }
    if (m >= 0) { keep[m] = 1; stack.push(f, m, m, l) }
  }
  const idx: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) idx.push(i)
  const out: number[] = []
  idx.forEach((i, q) => {
    const prev = out.length ? out[out.length - 1]! : idx[idx.length - 1]!, next = q + 1 < idx.length ? idx[q + 1]! : out[0] ?? idx[0]!
    if (out.length + idx.length - q - 1 >= 3 && segDist(p, prev, i, next) <= eps) return
    out.push(i)
  })
  return out.length >= 3 ? out.map(i => [p[2 * i]!, p[2 * i + 1]!]) : null
}

const finite = (...v: number[]) => v.every(Number.isFinite)
function checkSpacing(scope: string, spacing: number): void {
  if (!(spacing >= 0) || !Number.isFinite(spacing)) throw new GlassUIError(scope, 'spacing 必须是不小于 0 的有限数', { got: String(spacing) })
}

/**
 * The most grid nodes `fusedOutline` samples under its default step (a few hundred KB of field and links): a small
 * member (step 0.5 pt) in a large cluster would otherwise sample millions, every frame of a press. A call's cost is
 * about nodes × the members near each block (`fusedSamples`), so nearly flat in the member count — measured under Node
 * on the development Mac: a 5-capsule toolbar (11 k nodes) ≈ 0.5 ms, 30 rounds or 60 squares at the cap ≈ 1.6–1.9 ms.
 */
export const FUSED_MAX_CELLS = 40_000

/**
 * The sampling grid of `fusedOutline` (Surface pt): `nx × ny` nodes `step` apart from (x0, y0), covering the shapes'
 * bounds plus `spacing + 2·step`. The default step is `clamp(minSide / 24, 0.5, 2)` (`minSide` the shortest side of any
 * shape), coarsened until the grid has at most `FUSED_MAX_CELLS` nodes; a given `step` (positive, finite) is kept as
 * is. A coarsened step traces a member under a few steps across roughly (one under about one step can vanish).
 */
export function fusedGrid(shapes: readonly FusedShape[], spacing: number, step?: number): { step: number; x0: number; y0: number; nx: number; ny: number } {
  checkSpacing('fusedGrid', spacing)
  if (step !== undefined && (!(step > 0) || !Number.isFinite(step))) throw new GlassUIError('fusedGrid', 'step 必须是正的有限数', { got: String(step) })
  const b = fusedBounds(shapes)
  const layout = (st: number) => {
    const margin = spacing + 2 * st
    return { step: st, x0: b.x - margin, y0: b.y - margin, nx: Math.ceil((b.width + 2 * margin) / st) + 1, ny: Math.ceil((b.height + 2 * margin) / st) + 1 }
  }
  if (step !== undefined) return layout(step)
  const minSide = shapes.length ? Math.min(...shapes.map(s => Math.min(s.width, s.height))) : 0
  let g = layout(Math.min(2, Math.max(0.5, minSide / 24)))
  // the cell count falls about as 1 / step² (the margin grows a little with the step, hence the loop; it ends, the
  // count tending to a few dozen nodes)
  while (g.nx * g.ny > FUSED_MAX_CELLS) g = layout(g.step * Math.max(1.01, Math.sqrt((g.nx * g.ny) / FUSED_MAX_CELLS)))
  return g
}

/**
 * The zero contours of the shapes' smooth union (`fusedField`), in the fused frame (pt, y up, centred on
 * `fusedBounds`): each closed (the last point does not repeat the first), outer boundaries counter-clockwise and holes
 * clockwise. Shapes a gap of less than `spacing` apart join into one contour with a smooth bridge; farther ones keep
 * their own. Marching squares over a grid of `step` pt (default `clamp(minSide / 24, 0.5, 2)`, `minSide` the shortest
 * side of any shape; coarsened to at most `FUSED_MAX_CELLS` nodes: `fusedGrid`) covering the bounds plus
 * `spacing + 2·step`, sampled by `fusedSamples`, edge points interpolated linearly, then simplified
 * (Douglas–Peucker, ε = 0.1 · step). A few typed arrays per call and none per cell, at the cost `FUSED_MAX_CELLS`
 * notes: it reruns whenever a cluster's shapes change (a press or hover tilt does, every frame for a while).
 */
export function fusedOutline(shapes: readonly FusedShape[], spacing: number, opts: { step?: number } = {}): Contour[] {
  checkSpacing('fusedOutline', spacing)
  for (const s of shapes) if (!finite(s.x, s.y, s.width, s.height, s.radius)) throw new GlassUIError('fusedOutline', '形状的位置、尺寸和圆角必须是有限数', { got: `x ${s.x}, y ${s.y}, ${s.width} × ${s.height}, radius ${s.radius}` })
  if (opts.step !== undefined && (!(opts.step > 0) || !Number.isFinite(opts.step))) throw new GlassUIError('fusedOutline', 'step 必须是正的有限数', { got: String(opts.step) })
  if (!shapes.length) return []

  const { step, x0, y0, nx, ny } = fusedGrid(shapes, spacing, opts.step)
  const b = fusedBounds(shapes), cx = b.x + b.width / 2, cy = b.y + b.height / 2
  const field = fusedSamples(shapes, spacing, { step, x0, y0, nx, ny })

  // link[enter edge] = the exit edge its segment runs to (−1: no crossing, or already chained)
  const link = new Int32Array(2 * nx * ny).fill(-1)
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const n0 = j * nx + i
    const v0 = field[n0]!, v1 = field[n0 + 1]!, v2 = field[n0 + nx + 1]!, v3 = field[n0 + nx]!
    const c = (v0 < 0 ? 1 : 0) | (v1 < 0 ? 2 : 0) | (v2 < 0 ? 4 : 0) | (v3 < 0 ? 8 : 0)
    if (c === 0 || c === 15) continue
    const o = (c * 2 + (v0 + v1 + v2 + v3 < 0 ? 1 : 0)) * 4
    for (let q = o; q < o + 4 && PAIRS[q]! >= 0; q += 2) link[edgeId(n0, PAIRS[q + 1]!, nx)] = edgeId(n0, PAIRS[q]!, nx)
  }

  // chain the links into loops: each crossing interpolated along its edge, from the edge's first node (the grid is
  // margined, so no loop reaches its border and every chain closes)
  const contours: Contour[] = []
  let raw = new Float64Array(256)
  for (let start = 0; start < link.length; start++) {
    if (link[start]! < 0) continue
    let n = 0, cur = start
    do {
      const node = cur >> 1, vertical = cur & 1, a = field[node]!, t = a / (a - field[vertical ? node + nx : node + 1]!)
      const i = node % nx, j = (node - i) / nx
      const x = x0 + (i + (vertical ? 0 : t)) * step - cx, y = cy - (y0 + (j + (vertical ? t : 0)) * step)
      if (n === 0 || x !== raw[2 * n - 2] || y !== raw[2 * n - 1]) {
        if (2 * n + 2 > raw.length) { const r = new Float64Array(raw.length * 2); r.set(raw); raw = r }
        raw[2 * n] = x; raw[2 * n + 1] = y; n++
      }
      const next = link[cur]!; link[cur] = -1; cur = next
    } while (cur !== start && cur >= 0)
    if (n > 1 && raw[0] === raw[2 * n - 2] && raw[1] === raw[2 * n - 1]) n--
    const c = simplifyLoop(raw, n, 0.1 * step)
    if (c) contours.push(c)
  }
  return contours
}

const signedArea = (c: Contour) => c.reduce((s, [x, y], i) => { const [x2, y2] = c[(i + 1) % c.length]!; return s + x * y2 - x2 * y }, 0) / 2
/** Even–odd ray cast: (x, y) inside the closed polygon `c`. */
function contains(c: Contour, x: number, y: number): boolean {
  let inside = false
  for (let i = 0, j = c.length - 1; i < c.length; j = i++) {
    const [xi, yi] = c[i]!, [xj, yj] = c[j]!
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/**
 * Per contour point, the factor (≤ 1) its insets are scaled by so that the inset rings of glass thinner than twice
 * `maxInset` stay apart: `min(1, 0.45 · d / maxInset)`, d the distance to the nearest contour segment across the glass
 * from it — the straight path there runs through the glass all the way by the traced outline (it leaves the point into
 * the glass and crosses no outline segment: not across the mouth of a bay or out to a separate blob) — and either on
 * another contour (a hole's rim across a thin band) or far along its own (an arc length over twice the distance: the
 * far side of a bridge, not the point's own neighbours). Two sides across the glass then each reach at most 0.45 · d
 * in. The traced outline decides, not the field: it is what the mesh is built on, and near a bridge's saddle the two
 * disagree (a grid cell can join a pinch whose true field is just positive). Sampling the field along −n would not find
 * a neck's far side either (there the normals run diagonally across it). Only segments within maxInset / 0.45 matter
 * (nothing farther squeezes), so the segments are bucketed in cells that wide and each point scans its 3 × 3 cells:
 * linear in the contour points.
 */
function insetScales(contours: readonly Contour[], maxInset: number): Float64Array[] {
  const out = contours.map(c => new Float64Array(c.length).fill(1))
  if (!(maxInset > 0)) return out
  // every point flat: position, arc length along its contour, its contour and index there, its neighbours (the next
  // is its segment's end)
  let N = 0
  for (const c of contours) N += c.length
  const X = new Float64Array(N), Y = new Float64Array(N), S = new Float64Array(N)
  const C = new Int32Array(N), I = new Int32Array(N), prev = new Int32Array(N), next = new Int32Array(N), perimeter: number[] = []
  let o = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  contours.forEach((c, ci) => {
    const n = c.length
    let arc = 0
    for (let i = 0; i < n; i++) {
      const [x, y] = c[i]!, [x2, y2] = c[(i + 1) % n]!
      X[o + i] = x; Y[o + i] = y; S[o + i] = arc; C[o + i] = ci; I[o + i] = i
      prev[o + i] = o + (i + n - 1) % n; next[o + i] = o + (i + 1) % n
      arc += Math.sqrt((x2 - x) ** 2 + (y2 - y) ** 2)
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
    }
    perimeter.push(arc)
    o += n
  })
  const reach = maxInset / 0.45                                          // only a side nearer than this squeezes anything
  // segment buckets (compressed rows): every cell a segment's bounding box overlaps; cells at least `reach` wide (at
  // most 256 across)
  const cell = Math.max(reach, (x1 - x0) / 256, (y1 - y0) / 256)
  const gw = Math.floor((x1 - x0) / cell) + 1, gh = Math.floor((y1 - y0) / cell) + 1
  const cellOf = (v: number, v0: number, g: number) => Math.min(g - 1, Math.max(0, Math.floor((v - v0) / cell)))
  const span = (j: number) => {
    const ax = X[j]!, ay = Y[j]!, bx = X[next[j]!]!, by = Y[next[j]!]!
    return [cellOf(Math.min(ax, bx), x0, gw), cellOf(Math.max(ax, bx), x0, gw), cellOf(Math.min(ay, by), y0, gh), cellOf(Math.max(ay, by), y0, gh)] as const
  }
  const start = new Int32Array(gw * gh + 1)
  for (let j = 0; j < N; j++) { const [c0, c1, r0, r1] = span(j); for (let r = r0; r <= r1; r++) for (let q = c0; q <= c1; q++) start[r * gw + q + 1]!++ }
  for (let q = 0; q < gw * gh; q++) start[q + 1]! += start[q]!
  const bucket = new Int32Array(start[gw * gh]!), fill = start.slice(0, gw * gh)
  for (let j = 0; j < N; j++) { const [c0, c1, r0, r1] = span(j); for (let r = r0; r <= r1; r++) for (let q = c0; q <= c1; q++) bucket[fill[r * gw + q]!++] = j }
  // a segment in several cells is visited once per scan: `seen[j] === stamp`
  const seen = new Int32Array(N).fill(-1)
  let stamp = 0
  const scan = (px: number, py: number, visit: (j: number) => boolean | void) => {
    stamp++
    const cq = cellOf(px, x0, gw), cr = cellOf(py, y0, gh)
    for (let r = Math.max(0, cr - 1); r <= Math.min(gh - 1, cr + 1); r++) for (let q = Math.max(0, cq - 1); q <= Math.min(gw - 1, cq + 1); q++) {
      for (let b = start[r * gw + q]!; b < start[r * gw + q + 1]!; b++) {
        const j = bucket[b]!
        if (seen[j] === stamp) continue
        seen[j] = stamp
        if (visit(j) === false) return
      }
    }
  }
  /** The path from point i to i + q runs through the glass: it leaves i into the glass and crosses no outline segment. */
  const throughGlass = (i: number, qx: number, qy: number) => {
    // the glass lies left of the contour's direction: at a convex vertex inside both edges' left sides, else either's
    const px = X[i]!, py = Y[i]!, ix = px - X[prev[i]!]!, iy = py - Y[prev[i]!]!, ox = X[next[i]!]! - px, oy = Y[next[i]!]! - py
    const leftIn = ix * qy - iy * qx > 0, leftOut = ox * qy - oy * qx > 0
    if (!(ix * oy - iy * ox > 0 ? leftIn && leftOut : leftIn || leftOut)) return false
    let clear = true
    scan(px, py, j => {
      const ax = X[j]!, ay = Y[j]!, ex = X[next[j]!]! - ax, ey = Y[next[j]!]! - ay, den = qx * ey - qy * ex
      if (den === 0) return
      const t = ((ax - px) * ey - (ay - py) * ex) / den, u = ((ax - px) * qy - (ay - py) * qx) / den
      if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) { clear = false; return false }
    })
    return clear
  }
  const near: number[] = []
  for (let i = 0; i < N; i++) {
    const px = X[i]!, py = Y[i]!, ci = C[i]!, L = perimeter[ci]!
    let d = reach
    near.length = 0
    scan(px, py, j => { near.push(j) })                                   // (throughGlass scans too: collect first)
    for (const j of near) {
      const ax = X[j]!, ay = Y[j]!, dx = X[next[j]!]! - ax, dy = Y[next[j]!]! - ay, l2 = dx * dx + dy * dy
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0
      const qx = ax + t * dx - px, qy = ay + t * dy - py, dist = Math.sqrt(qx * qx + qy * qy)
      if (dist >= d) continue                                            // no nearer
      if (C[j] === ci) {
        const along = Math.abs(S[j]! + t * Math.sqrt(l2) - S[i]!)
        if (Math.min(along, L - along) <= 2 * dist) continue             // a neighbour along the contour
      }
      if (!throughGlass(i, qx, qy)) continue                             // not across the glass: nothing to cross
      d = dist
    }
    out[ci]![I[i]!] = Math.min(1, (0.45 * d) / maxInset)
  }
  return out
}

/**
 * Collapses the local self-intersection loops of the closed polyline `q` (flat xy, `n` points) onto their crossing
 * point, as an inset ring folds over where it is inset past a convex corner's radius: the 9-slice slab's
 * `r = max(radius − inset, 0)`, a sharp corner, in general. Segment i is tested against the next `window` ones, the
 * farthest first, so a whole loop goes at once; the collapsed points stay (as duplicates), so every ring keeps one
 * vertex per contour point for the walls.
 */
function unfold(q: Float64Array, n: number): void {
  const window = Math.min(16, Math.floor(n / 3))
  for (let i = 0; i < n; i++) {
    const i1 = (i + 1) % n, ax = q[2 * i]!, ay = q[2 * i + 1]!, dx = q[2 * i1]! - ax, dy = q[2 * i1 + 1]! - ay
    for (let w = window; w >= 2; w--) {
      const j = (i + w) % n, j1 = (j + 1) % n
      const cx = q[2 * j]!, cy = q[2 * j + 1]!, ex = q[2 * j1]! - cx, ey = q[2 * j1 + 1]! - cy
      const den = dx * ey - dy * ex
      if (den === 0) continue                                               // parallel, or a collapsed (zero) segment
      const t = ((cx - ax) * ey - (cy - ay) * ex) / den, u = ((cx - ax) * dy - (cy - ay) * dx) / den
      if (!(t > 0 && t < 1 && u > 0 && u < 1)) continue
      const x = ax + t * dx, y = ay + t * dy
      for (let m = 1; m <= w; m++) { const k = (i + m) % n; q[2 * k] = x; q[2 * k + 1] = y }
      i += w - 1
      break
    }
  }
}

/**
 * The fused slab mesh (pt, in the fused frame: centred on `fusedBounds(shapes)`, y up, back face at z = 0) of
 * `fusedOutline(shapes, spacing)`'s contours. Each contour point P, with outward normal n (`fusedNormal`), gets the
 * 9-slice slab's rings 0 … 2K+1 (`profileAt` for a slab `minSide` wide and high): ring k at P − n·inset_k, z = z_k,
 * normal normalize(n·nr_k, nz_k); where a ring would fold over (inset past a corner sharper than the fillet) its loop
 * collapses onto the crossing (`unfold`). Where the glass is thinner than twice its insets (a bridge just under — or,
 * as traced, just over — the spacing) each point's insets shrink so that it moves at most 0.45 × its distance to the
 * nearest outline segment straight across the glass (`insetScales`), and near a bridge's saddle, where the field's
 * gradient is weak or points into the outline, n is the traced polyline's own normal. Two sides across the glass then
 * keep apart; the tests sweep pairs of rounds, capsules and rounded rects, axis-aligned and diagonal, within 0.2 pt
 * either side of the spacing at the default and at coarsened steps, and every mesh is closed with single-cover caps.
 * Not covered: a member thinner than twice the profile's insets, whose straight sides the simplified outline leaves as
 * single segments that see each other only around its ends — `minSide` must be the smallest member's short side, so
 * that the profile's fillets fit it (as on a 9-slice slab). Walls join consecutive rings (outward: material lies left
 * of every contour); the top cap triangulates the plateau edge (ring 2K+1, normal +z) and the back cap ring 0
 * (normal −z), holes included, on those rings' own vertices — the fillet profile's end rings already carry exactly
 * those normals.
 */
export function extrudeSlab(contours: readonly Contour[], shapes: readonly FusedShape[], spacing: number, profile: FusedProfile, K: number): SlabMesh {
  if (!Number.isInteger(K) || K < 1) throw new GlassUIError('extrudeSlab', 'K 必须是不小于 1 的整数（每段圆角的环数）', { got: String(K) })
  checkSpacing('extrudeSlab', spacing)
  for (const name of ['thickness', 'minSide'] as const) {
    if (!(profile[name] > 0) || !Number.isFinite(profile[name])) throw new GlassUIError('extrudeSlab', `profile.${name} 必须是正的有限数`, { got: String(profile[name]) })
  }
  for (const name of ['fillet', 'filletBottom'] as const) {
    if (!(profile[name] >= 0) || !Number.isFinite(profile[name])) throw new GlassUIError('extrudeSlab', `profile.${name} 必须是不小于 0 的有限数`, { got: String(profile[name]) })
  }
  const rings = 2 * K + 2
  const p: SlabInstanceParams = { width: profile.minSide, height: profile.minSide, radius: 0, thickness: profile.thickness, fillet: profile.fillet, filletBottom: profile.filletBottom, cornerExponent: 2, profile: 0 }
  const prof = Array.from({ length: rings }, (_, k) => profileAt(k, K, p))
  const b = fusedBounds(shapes), cx = b.x + b.width / 2, cy = b.y + b.height / 2
  let total = 0
  for (const c of contours) total += c.length
  const positions = new Float32Array(total * rings * 3), normals = new Float32Array(total * rings * 3)
  const index: number[] = []
  /** Vertex index of ring k, point i of contour `ci`. */
  const offsets: number[] = []
  const vertex = (ci: number, k: number, i: number) => offsets[ci]! + k * contours[ci]!.length + i

  // outward normals per contour point: the field's gradient (`fusedNormal`), unless it is weak (|∇f| < 0.5: near a
  // bridge's saddle, where it points anywhere — the outline traced there may even pinch where the field does not) or
  // points into the traced outline; then the polyline's own, right of its tangent, which the outline agrees with
  const outward = contours.map(c => {
    const n = c.length, on = new Float64Array(2 * n)
    c.forEach(([x, y], i) => {
      const [gx, gy] = fusedGradient(shapes, spacing, x + cx, cy - y), g = Math.hypot(gx, gy)
      const [px, py] = c[(i + n - 1) % n]!, [qx, qy] = c[(i + 1) % n]!, l = Math.hypot(qx - px, qy - py) || 1
      const tx = (qy - py) / l, ty = -(qx - px) / l
      const weak = g < 0.5 || gx * tx + gy * ty <= 0
      on[2 * i] = weak ? tx : gx / g; on[2 * i + 1] = weak ? ty : gy / g
    })
    return on
  })
  const scales = insetScales(contours, Math.max(...prof.map(r => r.inset)))

  let base = 0
  contours.forEach((c, ci) => {
    const n = c.length, on = outward[ci]!, sc = scales[ci]!
    offsets.push(base)
    const q = new Float64Array(2 * n)                                   // one ring's xy
    for (let k = 0; k < rings; k++) {
      const { inset, z, nr, nz } = prof[k]!
      c.forEach(([x, y], i) => { const d = inset * sc[i]!; q[2 * i] = x - on[2 * i]! * d; q[2 * i + 1] = y - on[2 * i + 1]! * d })
      if (inset > 0) unfold(q, n)
      for (let i = 0; i < n; i++) {
        // the profile squeezed across by the point's scale s: its normal (nr, nz) becomes ∝ (nr, s·nz) — floored, so the
        // end rings' (nr = 0 or ≈ 6e-17) stay ±z for the caps sharing them
        const v = 3 * (base + k * n + i), ox = on[2 * i]!, oy = on[2 * i + 1]!, sz = Math.max(sc[i]!, 1e-6) * nz
        positions[v] = q[2 * i]!; positions[v + 1] = q[2 * i + 1]!; positions[v + 2] = z
        const l = Math.hypot(ox * nr, oy * nr, sz) || 1
        normals[v] = (ox * nr) / l; normals[v + 1] = (oy * nr) / l; normals[v + 2] = sz / l
      }
    }
    for (let k = 0; k < rings - 1; k++) {
      const a = base + k * n, a2 = a + n
      for (let i = 0; i < n; i++) { const j = (i + 1) % n; index.push(a + i, a + j, a2 + j, a + i, a2 + j, a2 + i) }
    }
    base += rings * n
  })

  // caps: each outer contour with the holes it is the innermost container of
  const areas = contours.map(signedArea)
  const holes = new Map<number, number[]>()
  areas.forEach((ar, h) => {
    if (ar >= 0) return
    const [hx, hy] = contours[h]![0]!
    let owner = -1
    areas.forEach((ao, o) => { if (ao > 0 && (owner < 0 || ao < areas[owner]!) && contains(contours[o]!, hx, hy)) owner = o })
    if (owner >= 0) holes.set(owner, [...(holes.get(owner) ?? []), h])
  })
  areas.forEach((ao, o) => {
    if (ao <= 0) return
    const loops = [o, ...(holes.get(o) ?? [])]
    for (const [k, up] of [[rings - 1, true], [0, false]] as const) {
      const pts = loops.map(ci => contours[ci]!.map((_, i) => { const v = 3 * vertex(ci, k, i); return new Vector2(positions[v]!, positions[v + 1]!) }))
      const faces = ShapeUtils.triangulateShape(pts[0]!, pts.slice(1))
      // face indices run over the loops as triangulated (it drops a loop's repeated end point, shortening that loop)
      const map: number[] = []
      loops.forEach((ci, q) => { for (let i = 0; i < pts[q]!.length; i++) map.push(vertex(ci, k, i)) })
      for (const f of faces) {
        const A = map[f[0]!]!, B = map[f[1]!]!, C = map[f[2]!]!
        const cross = (positions[3 * B]! - positions[3 * A]!) * (positions[3 * C + 1]! - positions[3 * A + 1]!) - (positions[3 * B + 1]! - positions[3 * A + 1]!) * (positions[3 * C]! - positions[3 * A]!)
        if ((cross < 0) === up) index.push(A, C, B); else index.push(A, B, C)   // counter-clockwise faces +z
      }
    }
  })
  return { positions, normals, index: Uint32Array.from(index) }
}

/**
 * The instanced base geometry of a fused slab (`GlassBatch({ mesh })`): `position` in slab-local units (the caller
 * scales the pt mesh by 1 / ptPerUnit) and `slabNormal`, its index, `userData.vertex = 'mesh'` (the material then places
 * it with `meshVertex`) and `K = 0` (no rings to classify). The normal is not three's `normal`: a geometry with one is
 * lit differently from the 9-slice slab, which has none (three r186 adds a geometric roughness from its derivatives to
 * the specular, `getGeometryRoughness`, and spends a varying, `v_normalViewGeometry`, on it — 12 of the 11 allowed).
 */
export function createFusedGeometry(mesh: SlabMesh): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry()
  g.setAttribute('position', new BufferAttribute(mesh.positions, 3))
  g.setAttribute('slabNormal', new BufferAttribute(mesh.normals, 3))
  g.setIndex(new BufferAttribute(mesh.index, 1))
  g.userData = { vertex: 'mesh', K: 0 }
  g.boundingSphere = new Sphere(new Vector3(), 1e6)   // placed by the instances; never frustum-cull by this
  return g
}
