import { BufferAttribute, InstancedBufferGeometry, ShapeUtils, Sphere, Vector2, Vector3 } from 'three'
import { GlassUIError } from '@glassui/core'
import { profileAt, type SlabInstanceParams } from './slab9'

/*
 * Fused glass (GlassContainer, spec §5.2): nearby glass shapes drawn as one slab — the zero contours of the smooth
 * union of their rounded-rect SDFs (`fusedOutline`), extruded with the 9-slice slab's fillet profile (`extrudeSlab`)
 * into a plain mesh that `GlassBatch({ mesh })` draws through the glass material (`meshVertex`).
 *
 * Frames: the shapes, `fusedField` and the point `fusedNormal` takes are in Surface pt (y down). The outline and the
 * extrusion share one frame: pt, y up, origin at the centre of the shapes' bounds (`fusedBounds`), back face at z = 0
 * — the slab-local frame of an instance whose rect is those bounds, once scaled by 1 / ptPerUnit.
 */

export type Contour = [number, number][]
/** An axis-aligned rounded rect in Surface pt (already through its instance transform). */
export interface FusedShape { x: number; y: number; width: number; height: number; radius: number }
/** The slab profile `extrudeSlab` follows (pt); the fillets are clamped as on a 9-slice slab `minSide` wide and high. */
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

/** The smooth union of the shapes' SDFs at (x, y) (Surface pt, y down; negative inside); `Infinity` for no shapes. */
export function fusedField(shapes: readonly FusedShape[], spacing: number, x: number, y: number): number {
  const k = spacing * SMOOTHING_PER_SPACING
  let d = Infinity
  for (const s of shapes) { const e = sdRound(s, x, y); d = d === Infinity ? e : smin(d, e, k) }
  return d
}

/**
 * The unit outward gradient of `fusedField` at (x, y) (Surface pt, y down), by central differences, as (x, y) in the
 * outline's y-up frame; (0, 0) where the field is flat.
 */
export function fusedNormal(shapes: readonly FusedShape[], spacing: number, x: number, y: number): [number, number] {
  const e = 0.25
  const gx = fusedField(shapes, spacing, x + e, y) - fusedField(shapes, spacing, x - e, y)
  const gy = fusedField(shapes, spacing, x, y + e) - fusedField(shapes, spacing, x, y - e)
  const l = Math.hypot(gx, gy) || 1
  return [gx / l, -gy / l]                                   // y down → y up
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
 * The most grid nodes `fusedOutline` samples under its default step (a few hundred KB of field and links, a couple of
 * ms per call): a small member (step 0.5 pt) in a large cluster would otherwise sample millions, every frame of a press.
 */
export const FUSED_MAX_CELLS = 40_000

/**
 * The sampling grid of `fusedOutline` (Surface pt): `nx × ny` nodes `step` apart from (x0, y0), covering the shapes'
 * bounds plus `spacing + 2·step`. The default step is `clamp(minSide / 24, 0.5, 2)` (`minSide` the shortest side of any
 * shape), coarsened until the grid has at most `FUSED_MAX_CELLS` nodes; a given `step` is kept as is.
 */
export function fusedGrid(shapes: readonly FusedShape[], spacing: number, step?: number): { step: number; x0: number; y0: number; nx: number; ny: number } {
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
 * `spacing + 2·step`, edge points interpolated linearly, then simplified
 * (Douglas–Peucker, ε = 0.1 · step). O(grid · shapes) with a few typed arrays per call and none per cell: it reruns
 * whenever a cluster's shapes change (a press or hover tilt does, every frame for a while).
 */
export function fusedOutline(shapes: readonly FusedShape[], spacing: number, opts: { step?: number } = {}): Contour[] {
  checkSpacing('fusedOutline', spacing)
  for (const s of shapes) if (!finite(s.x, s.y, s.width, s.height, s.radius)) throw new GlassUIError('fusedOutline', '形状的位置、尺寸和圆角必须是有限数', { got: `x ${s.x}, y ${s.y}, ${s.width} × ${s.height}, radius ${s.radius}` })
  if (opts.step !== undefined && (!(opts.step > 0) || !Number.isFinite(opts.step))) throw new GlassUIError('fusedOutline', 'step 必须是正的有限数', { got: String(opts.step) })
  if (!shapes.length) return []

  const { step, x0, y0, nx, ny } = fusedGrid(shapes, spacing, opts.step)
  const b = fusedBounds(shapes), cx = b.x + b.width / 2, cy = b.y + b.height / 2
  const field = new Float64Array(nx * ny)
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) field[j * nx + i] = fusedField(shapes, spacing, x0 + i * step, y0 + j * step)

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
 * from it — inward of the point (along −n), with glass halfway there (`inside`: not a separate blob or the mouth of a
 * bay), and either on another contour (a hole's rim across a thin band) or far along its own (an arc length over twice
 * the distance: the far side of a bridge, not the point's own neighbours). Two facing sides then each reach at most
 * 0.45 · d in. Sampling the field along −n cannot find a neck's far side (there the normals run diagonally across it),
 * hence the contour itself. O(N²) over all contour points (N in the hundreds); the field is sampled only for a
 * candidate nearer than both the nearest so far and maxInset / 0.45 (beyond which nothing is squeezed).
 */
function insetScales(contours: readonly Contour[], normals: readonly Float64Array[], maxInset: number, inside: (x: number, y: number) => boolean): Float64Array[] {
  const out = contours.map(c => new Float64Array(c.length).fill(1))
  if (!(maxInset > 0)) return out
  // every point flat: position, outward normal, arc length along its contour, its contour and index there, the next
  // point (its segment's end)
  let N = 0
  for (const c of contours) N += c.length
  const X = new Float64Array(N), Y = new Float64Array(N), NX = new Float64Array(N), NY = new Float64Array(N), S = new Float64Array(N)
  const C = new Int32Array(N), I = new Int32Array(N), next = new Int32Array(N), perimeter: number[] = []
  let o = 0
  contours.forEach((c, ci) => {
    const n = c.length, on = normals[ci]!
    let arc = 0
    for (let i = 0; i < n; i++) {
      const [x, y] = c[i]!, [x2, y2] = c[(i + 1) % n]!
      X[o + i] = x; Y[o + i] = y; NX[o + i] = on[2 * i]!; NY[o + i] = on[2 * i + 1]!; S[o + i] = arc; C[o + i] = ci; I[o + i] = i
      next[o + i] = o + (i + 1) % n
      arc += Math.sqrt((x2 - x) ** 2 + (y2 - y) ** 2)
    }
    perimeter.push(arc)
    o += n
  })
  const reach = maxInset / 0.45                                          // only a side nearer than this squeezes anything
  for (let i = 0; i < N; i++) {
    const px = X[i]!, py = Y[i]!, nx = NX[i]!, ny = NY[i]!, ci = C[i]!, L = perimeter[ci]!
    let d = reach                                                        // so the field is rarely sampled
    for (let j = 0; j < N; j++) {
      const ax = X[j]!, ay = Y[j]!, dx = X[next[j]!]! - ax, dy = Y[next[j]!]! - ay, l2 = dx * dx + dy * dy
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0
      const qx = ax + t * dx - px, qy = ay + t * dy - py, dist = Math.sqrt(qx * qx + qy * qy)
      if (dist >= d || qx * nx + qy * ny >= 0) continue                   // no nearer, or not inward of P
      if (C[j] === ci) {
        const along = Math.abs(S[j]! + t * Math.sqrt(l2) - S[i]!)
        if (Math.min(along, L - along) <= 2 * dist) continue             // a neighbour along the contour
      }
      if (!inside(px + qx / 2, py + qy / 2)) continue                     // empty between: nothing to cross
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
 * collapses onto the crossing (`unfold`), and where the glass is thinner than twice its insets (a bridge just under the
 * spacing, where two shapes barely join) each point's insets shrink to its local feature size (`insetScales`), so the
 * two sides' rings never cross. Walls join consecutive rings (outward: material lies left of every contour); the top
 * cap triangulates the plateau edge (ring 2K+1, normal +z) and the back cap ring 0 (normal −z), holes included, on
 * those rings' own vertices — the fillet profile's end rings already carry exactly those normals.
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

  // outward normals per contour point
  const outward = contours.map(c => {
    const n = c.length, on = new Float64Array(2 * n)
    c.forEach(([x, y], i) => {
      let [ox, oy] = fusedNormal(shapes, spacing, x + cx, cy - y)
      if (ox === 0 && oy === 0) {
        // a flat field (a bridge exactly at its pinch): the polyline's own outward normal, right of its tangent
        const [px, py] = c[(i + n - 1) % n]!, [qx, qy] = c[(i + 1) % n]!, l = Math.hypot(qx - px, qy - py) || 1
        ox = (qy - py) / l; oy = -(qx - px) / l
      }
      on[2 * i] = ox; on[2 * i + 1] = oy
    })
    return on
  })
  const scales = insetScales(contours, outward, Math.max(...prof.map(r => r.inset)), (x, y) => fusedField(shapes, spacing, x + cx, cy - y) < 0)

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
