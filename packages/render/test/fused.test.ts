import { describe, it, expect } from 'vitest'
import { uniform } from 'three/tsl'
import { Texture, Vector2 } from 'three'
import { GlassUIError } from '@glassui/core'
import { fusedOutline, fusedField, fusedNormal, fusedBounds, fusedGrid, fusedSamples, extrudeSlab, FUSED_MAX_CELLS, type Contour, type FusedShape, type SlabMesh } from '../src/glass/fused'
import { profileAt } from '../src/glass/slab9'
import { GlassBatch } from '../src/glass/batch'
import { createGlassMaterial } from '../src/glass/material'
import { buildShaders } from './fixtures/build-shaders'

const area = (c: Contour) => c.reduce((s, [x, y], i) => { const [x2, y2] = c[(i + 1) % c.length]!; return s + x * y2 - x2 * y }, 0) / 2
const rect = (x: number, y: number, w: number, h: number, r = 0): FusedShape => ({ x, y, width: w, height: h, radius: r })
const su = () => ({ size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(100) })
const bbox = (c: Contour) => ({ x0: Math.min(...c.map(p => p[0])), x1: Math.max(...c.map(p => p[0])), y0: Math.min(...c.map(p => p[1])), y1: Math.max(...c.map(p => p[1])) })
const profile = { thickness: 8, fillet: 2.4, filletBottom: 1.6, minSide: 40 }
/** A contour point (fused frame: y up, centred on the shapes' bounds) back in Surface pt (y down). */
const toPt = (shapes: FusedShape[], x: number, y: number): [number, number] => { const b = fusedBounds(shapes); return [x + b.x + b.width / 2, b.y + b.height / 2 - y] }
/**
 * Directed-edge balance, vertices welded by position: 0 for every edge of a closed, consistently wound mesh (each edge
 * once each way). The weld joins the duplicates a collapsed fold leaves (zero-length edges drop out).
 */
function openEdges(m: SlabMesh): number {
  const ids = new Map<string, number>(), weld = (i: number) => {
    const key = `${m.positions[3 * i]},${m.positions[3 * i + 1]},${m.positions[3 * i + 2]}`
    let id = ids.get(key); if (id === undefined) { id = ids.size; ids.set(key, id) }
    return id
  }
  const edges = new Map<string, number>()
  for (let t = 0; t < m.index.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = weld(m.index[t + e]!), b = weld(m.index[t + (e + 1) % 3]!)
    if (a === b) continue
    const key = a < b ? `${a}-${b}` : `${b}-${a}`
    edges.set(key, (edges.get(key) ?? 0) + (a < b ? 1 : -1))
  }
  return [...edges.values()].filter(v => v !== 0).length
}
/** Signed volume (divergence theorem): positive when every face winds outward. */
function volume(m: SlabMesh): number {
  let v = 0
  const P = (i: number) => [m.positions[3 * i]!, m.positions[3 * i + 1]!, m.positions[3 * i + 2]!] as const
  for (let t = 0; t < m.index.length; t += 3) {
    const [ax, ay, az] = P(m.index[t]!), [bx, by, bz] = P(m.index[t + 1]!), [cx, cy, cz] = P(m.index[t + 2]!)
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  return v / 6
}

/** Ring k of each contour (vertex block base + k·n + i per contour, in contour order), as xy polygons. */
function ringOf(m: SlabMesh, cs: Contour[], K: number, k: number): Contour[] {
  let base = 0
  return cs.map(c => {
    const n = c.length, ring: Contour = []
    for (let i = 0; i < n; i++) { const v = 3 * (base + k * n + i); ring.push([m.positions[v]!, m.positions[v + 1]!]) }
    base += (2 * K + 2) * n
    return ring
  })
}
/** Proper crossings between non-adjacent segments of the polygons (zero-length segments, a collapsed fold's, skipped). */
function crossings(polys: Contour[]): number {
  const segs = polys.flatMap(p => p.map((a, i) => [a, p[(i + 1) % p.length]!, p, i] as const))
  let count = 0
  segs.forEach(([a, b, pa, ia], s1) => segs.forEach(([c, d, pc, ic], s2) => {
    if (s2 <= s1 || (pa === pc && (Math.abs(ia - ic) <= 1 || Math.abs(ia - ic) === pa.length - 1))) return
    const dx = b[0] - a[0], dy = b[1] - a[1], ex = d[0] - c[0], ey = d[1] - c[1], den = dx * ey - dy * ex
    if (den === 0) return
    const t = ((c[0] - a[0]) * ey - (c[1] - a[1]) * ex) / den, u = ((c[0] - a[0]) * dy - (c[1] - a[1]) * dx) / den
    if (t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9) count++
  }))
  return count
}
/** Total area of the triangles at height z (each counted positive: a double-covered cap sums to more than its ring). */
function capArea(m: SlabMesh, z: number): number {
  let sum = 0
  for (let t = 0; t < m.index.length; t += 3) {
    const [a, b, c] = [m.index[t]!, m.index[t + 1]!, m.index[t + 2]!]
    if (![a, b, c].every(i => Math.abs(m.positions[3 * i + 2]! - z) < 1e-5)) continue
    const P = (i: number) => [m.positions[3 * i]!, m.positions[3 * i + 1]!] as const
    const [ax, ay] = P(a), [bx, by] = P(b), [cx, cy] = P(c)
    sum += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2
  }
  return sum
}

/**
 * What is wrong with the fused slab of `shapes` ('' when nothing): welded open edges; proper crossings in its back
 * (ring 0) or plateau (ring 2K+1) ring; a ring turned over (its signed area not the sign of its contour's); a cap that
 * does not cover its rings exactly once (its triangles' areas against the rings' net area, which must be positive);
 * normals off unit length, or off ±z on the caps' rings.
 */
function faults(shapes: FusedShape[], spacing: number, K: number, opts: { step?: number; minSide?: number } = {}): string {
  const cs = fusedOutline(shapes, spacing, opts.step === undefined ? {} : { step: opts.step })
  const m = extrudeSlab(cs, shapes, spacing, { ...profile, minSide: opts.minSide ?? profile.minSide }, K)
  const why: string[] = []
  const open = openEdges(m)
  if (open) why.push(`${open} open edges`)
  for (const [k, z] of [[0, 0], [2 * K + 1, profile.thickness]] as const) {
    const rings = ringOf(m, cs, K, k)
    const x = crossings(rings)
    if (x) why.push(`ring ${k}: ${x} crossings`)
    rings.forEach((r, i) => { if (Math.sign(area(r)) !== Math.sign(area(cs[i]!))) why.push(`ring ${k} of contour ${i} turned over`) })
    const net = rings.reduce((sum, r) => sum + area(r), 0), cap = capArea(m, z)
    if (!(net > 0) || Math.abs(cap - net) / net > 1e-4) why.push(`cap ${k}: ${(cap / net).toFixed(4)} × its rings`)
  }
  let worst = 0, n = 0
  for (let v = 0; v < m.normals.length; v += 3) worst = Math.max(worst, Math.abs(Math.hypot(m.normals[v]!, m.normals[v + 1]!, m.normals[v + 2]!) - 1))
  for (const c of cs) {
    for (let i = 0; i < c.length; i++) for (const k of [0, 2 * K + 1]) worst = Math.max(worst, 1 - Math.abs(m.normals[3 * (n + k * c.length + i) + 2]!))
    n += (2 * K + 2) * c.length
  }
  if (worst > 1e-5) why.push(`normals off by ${worst}`)
  return why.join(', ')
}
const round = (cx: number, cy: number, D: number) => rect(cx - D / 2, cy - D / 2, D, D, D / 2)
/** Two rounds D across, the second `gap` from the first along `deg` degrees (y down). */
const diagonal = (D: number, deg: number, gap: number) => [round(0, 0, D), round((D + gap) * Math.cos(deg * Math.PI / 180), (D + gap) * Math.sin(deg * Math.PI / 180), D)]

describe('fusedOutline', () => {
  it('two distant shapes keep two contours; within spacing they fuse into one with a bridge', () => {
    const far = fusedOutline([rect(0, 0, 40, 40, 20), rect(100, 0, 40, 40, 20)], 16)
    expect(far).toHaveLength(2)
    const near = fusedOutline([rect(0, 0, 40, 40, 20), rect(48, 0, 40, 40, 20)], 16)
    expect(near).toHaveLength(1)
    const circle = Math.PI * 20 * 20
    expect(Math.abs(area(near[0]!))).toBeGreaterThan(2 * circle * 1.02)              // the bridge adds area
  })
  it('a single shape traces its own rounded rect (area within 1 %)', () => {
    const [c] = fusedOutline([rect(0, 0, 200, 60, 30)], 16)
    const exact = 200 * 60 - (4 - Math.PI) * 30 * 30
    expect(Math.abs(Math.abs(area(c!)) - exact) / exact).toBeLessThan(0.01)
  })
  it('outer contours wind counter-clockwise (y up) and holes clockwise', () => {
    const ring = [rect(0, 0, 100, 20), rect(0, 80, 100, 20), rect(0, 0, 20, 100), rect(80, 0, 20, 100)]
    const cs = fusedOutline(ring, 4)
    expect(cs.filter(c => area(c) > 0)).toHaveLength(1); expect(cs.filter(c => area(c) < 0)).toHaveLength(1)
  })
  it('joins shapes exactly when their gap is under the spacing (k = 2 · spacing: the smin lowers by k/4 at most)', () => {
    const pair = (gap: number) => fusedOutline([rect(0, 0, 40, 40, 20), rect(40 + gap, 0, 40, 40, 20)], 16)
    expect(pair(15)).toHaveLength(1); expect(pair(17)).toHaveLength(2)
    expect(fusedField([rect(0, 0, 40, 40, 20), rect(56, 0, 40, 40, 20)], 16, 48, 20)).toBeCloseTo(0, 12)   // gap 16: they touch
  })
  it('the outline frame: pt, y up, centred on the shapes\' bounds', () => {
    const shapes = [rect(10, 20, 100, 40, 8), rect(10, 200, 40, 40, 20)]
    expect(fusedBounds(shapes)).toEqual({ x: 10, y: 20, width: 100, height: 220 })
    const cs = fusedOutline(shapes, 8)
    expect(cs).toHaveLength(2)
    const [wide, small] = cs.map(bbox).sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0))
    // the wide rect spans x 10…110 → −50…50 about the bounds' centre (60, 130); it sits at the top: y up, so +70…+110
    // (within the simplification's ε = 0.1 · step, step = 40/24 here: a chord cuts a round)
    const near = (v: number, want: number) => expect(Math.abs(v - want)).toBeLessThan(0.2)
    near(wide!.x0, -50); near(wide!.x1, 50); near(wide!.y0, 70); near(wide!.y1, 110)
    near(small!.x0, -50); near(small!.x1, -10); near(small!.y0, -110); near(small!.y1, -70)
  })
  it('every point lies on the zero contour; none repeats its neighbour, and the last is not the first', () => {
    const shapes = [rect(0, 0, 80, 40, 20), rect(88, 0, 80, 40, 20), rect(30, 46, 60, 30, 6)]
    for (const c of fusedOutline(shapes, 16)) {
      for (const [x, y] of c) expect(Math.abs(fusedField(shapes, 16, ...toPt(shapes, x, y)))).toBeLessThan(0.05)
      c.forEach(([x, y], i) => { const [x2, y2] = c[(i + 1) % c.length]!; expect(x !== x2 || y !== y2).toBe(true) })
    }
  })
  it('simplifies to within 0.1 · step (a capsule: a few dozen points, not one per grid cell)', () => {
    const [c] = fusedOutline([rect(0, 0, 200, 60, 30)], 16)
    expect(c!.length).toBeLessThan(80)
    const [fine] = fusedOutline([rect(0, 0, 200, 60, 30)], 16, { step: 0.5 })
    expect(fine!.length).toBeGreaterThan(c!.length)
  })
  it('the default step follows the smallest shape, coarsened so the grid stays under FUSED_MAX_CELLS; a given step is kept', () => {
    const cells = (g: { nx: number; ny: number }) => g.nx * g.ny
    // a toolbar: 2 pt (72 × 60 capsules: 60/24 clamped), some 11 k cells, untouched by the cap
    const bar = [0, 1, 2, 3, 4].map(i => rect(i * 82, 0, 72, 60, 30))
    expect(fusedGrid(bar, 16).step).toBe(2); expect(cells(fusedGrid(bar, 16))).toBeLessThan(FUSED_MAX_CELLS)
    // a 12 pt dot on an 800 × 600 panel would sample at 0.5 pt: ~2 M cells; coarsened to the cap
    const panel = [rect(0, 0, 800, 600, 24), rect(840, 0, 12, 12, 6)]
    const g = fusedGrid(panel, 16)
    expect(cells(g)).toBeLessThanOrEqual(FUSED_MAX_CELLS); expect(cells(g)).toBeGreaterThan(FUSED_MAX_CELLS / 2)
    expect(g.step).toBeGreaterThan(0.5)
    expect(fusedGrid(panel, 16, 0.5).step).toBe(0.5)                     // an explicit step is the caller's
    // the coarser grid still traces the panel (area within 1 %) and keeps the dot its own contour
    const cs = fusedOutline(panel, 16)
    expect(cs).toHaveLength(2)
    const big = Math.max(...cs.map(c => Math.abs(area(c)))), exact = 800 * 600 - (4 - Math.PI) * 24 * 24
    expect(Math.abs(big - exact) / exact).toBeLessThan(0.01)
  })
  it('samples the grid exactly as fusedField, culling per block the shapes that cannot be among the nearest two', () => {
    const layouts: FusedShape[][] = [
      [rect(0, 0, 80, 40, 20), rect(88, 0, 80, 40, 20)],
      Array.from({ length: 60 }, (_, k) => rect((k % 10) * 50, Math.floor(k / 10) * 50, 40, 40, 0)),
      Array.from({ length: 30 }, (_, k) => round((k % 6) * 50, Math.floor(k / 6) * 50, 40)),
      [rect(0, 0, 100, 20), rect(0, 80, 100, 20), rect(0, 0, 20, 100), rect(80, 0, 20, 100)],   // overlapping
      [rect(0, 0, 300, 200, 24), rect(100, 60, 80, 40, 20), rect(320, 80, 12, 12, 6)],           // one inside another
    ]
    for (const shapes of layouts) {
      const g = fusedGrid(shapes, 16), f = fusedSamples(shapes, 16, g)
      let mismatches = 0
      for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) if (f[j * g.nx + i] !== fusedField(shapes, 16, g.x0 + i * g.step, g.y0 + j * g.step)) mismatches++
      expect(mismatches, `${shapes.length} shapes`).toBe(0)
    }
  })
  it('does not depend on the order of the shapes; four rounds around a hole leave one clean hole (no speck inside)', () => {
    const grid = Array.from({ length: 12 }, (_, k) => round((k % 4) * 50, Math.floor(k / 4) * 50, 40))
    const shuffled = [...grid].sort((a, b) => ((a.x * 7 + a.y * 13) % 11) - ((b.x * 7 + b.y * 13) % 11))
    expect(fusedOutline(shuffled, 16)).toEqual(fusedOutline(grid, 16))
    expect(fusedOutline([...grid].reverse(), 16)).toEqual(fusedOutline(grid, 16))
    const four = fusedOutline(grid.filter(s => s.x < 60 && s.y < 60), 16).map(area)
    expect(four.filter(a => a > 0)).toHaveLength(1); expect(four.filter(a => a < 0)).toHaveLength(1)
    // a symmetric layout gives a symmetric outline: every hole of the 4 × 3 grid alike
    const holes = fusedOutline(grid, 16).map(area).filter(a => a < 0)
    expect(holes).toHaveLength(6)
    for (const h of holes) expect(h).toBeCloseTo(holes[0]!, 6)
  })
  it('fusedGrid rejects a step or spacing that is not a positive (spacing: non-negative) finite number', () => {
    const shapes = [rect(0, 0, 40, 40)]
    for (const step of [0, -1, NaN, Infinity]) expect(() => fusedGrid(shapes, 16, step), `step ${step}`).toThrow(/fusedGrid.*step 必须是正的有限数/)
    expect(() => fusedGrid(shapes, NaN)).toThrow(GlassUIError)
    expect(fusedGrid(shapes, 16, 1.5).step).toBe(1.5)
  })
  it('rejects a spacing, step or shape that is not a finite number (and outlines nothing for no shapes)', () => {
    expect(fusedOutline([], 16)).toEqual([])
    expect(() => fusedOutline([rect(0, 0, 40, 40)], NaN)).toThrow(GlassUIError)
    expect(() => fusedOutline([rect(0, 0, 40, 40)], -1)).toThrow(/spacing/)
    expect(() => fusedOutline([rect(0, 0, 40, 40)], 16, { step: 0 })).toThrow(/step/)
    expect(() => fusedOutline([rect(0, 0, NaN, 40)], 16)).toThrow(GlassUIError)
  })
})

describe('fusedNormal', () => {
  it('the unit outward gradient, y down in, y up out', () => {
    const shapes = [rect(0, 0, 40, 40, 20)]
    const [rx, ry] = fusedNormal(shapes, 16, 40, 20), [tx, ty] = fusedNormal(shapes, 16, 20, 0)
    expect(rx).toBeCloseTo(1, 6); expect(ry).toBeCloseTo(0, 6)
    expect(tx).toBeCloseTo(0, 6); expect(ty).toBeCloseTo(1, 6)      // the top edge (y = 0 in pt) faces +y up
  })
})

describe('extrudeSlab', () => {
  it('extrudes the fillet profile: unit normals, top cap at the thickness, walls between rings', () => {
    const shapes = [rect(0, 0, 80, 40, 20), rect(88, 0, 80, 40, 20)]
    const cs = fusedOutline(shapes, 16)
    const m = extrudeSlab(cs, shapes, 16, { thickness: 8, fillet: 2.4, filletBottom: 1.6, minSide: 40 }, 4)
    for (let i = 0; i < m.normals.length; i += 3) expect(Math.hypot(m.normals[i]!, m.normals[i + 1]!, m.normals[i + 2]!)).toBeCloseTo(1, 5)
    const zs = [...m.positions].filter((_, i) => i % 3 === 2)
    expect(Math.max(...zs)).toBeCloseTo(8, 5); expect(Math.min(...zs)).toBeCloseTo(0, 5)
    expect(m.index.length % 3).toBe(0)
    expect(Math.max(...m.index)).toBeLessThan(m.positions.length / 3)
  })
  it('a closed mesh wound outward, around a hole too, with the caps facing ±z', () => {
    const frame = [rect(0, 0, 100, 20), rect(0, 80, 100, 20), rect(0, 0, 20, 100), rect(80, 0, 20, 100)]
    const pair = [rect(0, 0, 80, 40, 20), rect(88, 0, 80, 40, 20)]
    for (const [shapes, spacing] of [[pair, 16], [frame, 4]] as const) {
      const cs = fusedOutline([...shapes], spacing)
      const m = extrudeSlab(cs, [...shapes], spacing, profile, 4)
      expect(openEdges(m)).toBe(0)
      const outline = cs.reduce((s, c) => s + area(c), 0)                    // holes count negative
      // outward, and the outline's prism less what the fillets round off
      expect(volume(m)).toBeGreaterThan(0.9 * outline * 8); expect(volume(m)).toBeLessThan(outline * 8)
      for (let t = 0; t < m.index.length; t += 3) {
        const tri = [m.index[t]!, m.index[t + 1]!, m.index[t + 2]!], z = tri.map(i => m.positions[3 * i + 2]!)
        if (z.some(v => Math.abs(v - z[0]!) > 1e-6)) continue                 // a wall
        const [a, b, c] = tri.map(i => [m.positions[3 * i]!, m.positions[3 * i + 1]!])
        const cross = (b![0]! - a![0]!) * (c![1]! - a![1]!) - (b![1]! - a![1]!) * (c![0]! - a![0]!)
        if (Math.abs(cross) < 1e-6) continue                                   // flat (between two rings of one height)
        if (Math.abs(z[0]! - 8) < 1e-5) expect(cross).toBeGreaterThan(0)       // top: counter-clockwise from +z
        else if (Math.abs(z[0]!) < 1e-5) expect(cross).toBeLessThan(0)         // back: faces −z
      }
    }
  })
  it('a corner sharper than the fillet collapses its inset rings onto the offset corner instead of folding over', () => {
    const shapes = [rect(0, 0, 100, 60, 1)], K = 4
    const m = extrudeSlab(fusedOutline(shapes, 16), shapes, 16, profile, K)
    const p = { width: 40, height: 40, radius: 0, thickness: 8, fillet: 2.4, filletBottom: 1.6, cornerExponent: 2, profile: 0 as const }
    const n = m.positions.length / 3 / (2 * K + 2)                             // one contour: ring k is vertices k·n …
    let worst = -Infinity
    for (let i = 0; i < m.positions.length / 3; i++) {
      const { inset } = profileAt(Math.floor(i / n), K, p)
      // as the 9-slice's r = max(radius − inset, 0): every ring point within the rect inset by that ring's inset
      worst = Math.max(worst, Math.abs(m.positions[3 * i]!) - (50 - inset), Math.abs(m.positions[3 * i + 1]!) - (30 - inset))
    }
    expect(worst).toBeLessThan(0.2)
  })
  it('a bridge thinner than its fillets (a gap just under the spacing) keeps its rings uncrossed and its caps single', () => {
    const pairs: [string, (x: number) => FusedShape][] = [
      ['circles', x => rect(x, 0, 40, 40, 20)], ['capsules', x => rect(x, 0, 80, 40, 20)], ['r30', x => rect(x, 0, 120, 60, 30)],
    ]
    for (const [name, shape] of pairs) for (const gap of [15.8, 15.85, 15.9, 15.95, 15.99]) for (const K of [4, 8]) {
      const first = shape(0)
      expect(faults([first, shape(first.width + gap)], 16, K, { minSide: Math.min(first.width, first.height) }), `${name} gap ${gap} K ${K}`).toBe('')
    }
  })
  it('a pinch traced across the spacing (diagonal rounds just under or over it) keeps its rings uncrossed and its caps single', () => {
    // the review's repro: 45°, gap 16.01 — the grid joins a neck whose true field is just positive
    expect(faults([rect(0, 0, 40.5, 40.5, 20.25), rect(39.9586, 39.9586, 40.5, 40.5, 20.25)], 16, 4)).toBe('')
    const bad: string[] = []
    // the default step, within 0.2 pt either side of the spacing
    for (const D of [40, 42.5, 44]) for (const deg of [30, 45, 60]) for (let g = 0; g <= 40; g++) {
      const gap = 15.8 + g * 0.01, why = faults(diagonal(D, deg, gap), 16, 4)
      if (why) bad.push(`D ${D} ${deg}° gap ${gap.toFixed(2)}: ${why}`)
    }
    // a coarsened step (as FUSED_MAX_CELLS gives a large cluster), where the traced pinch reaches farther over
    for (const D of [40, 42, 44]) for (const deg of [15, 45, 75]) for (let g = 0; g <= 22; g++) {
      const gap = 15.9 + g * 0.01, why = faults(diagonal(D, deg, gap), 16, 4, { step: 3.9 })
      if (why) bad.push(`step 3.9 D ${D} ${deg}° gap ${gap.toFixed(2)}: ${why}`)
    }
    expect(bad).toEqual([])
  }, 30_000)   // ≈ 2 s alone, over the 5 s default beside the rest of the suite
  it('a separate blob facing another, even nearly touching, keeps its full fillets (only glass between squeezes them)', () => {
    for (const gap of [16.02, 16.1, 17]) {
      const shapes = [rect(0, 0, 40, 40, 20), rect(40 + gap, 0, 40, 40, 20)]
      const cs = fusedOutline(shapes, 16)
      expect(cs).toHaveLength(2)
      const both = extrudeSlab(cs, shapes, 16, profile, 4), alone = extrudeSlab([cs[0]!], shapes, 16, profile, 4)
      expect(both.positions.subarray(0, alone.positions.length)).toEqual(alone.positions)
    }
  })
  it('rejects a K that is not a whole number ≥ 1, and a profile or spacing that is not finite and in range', () => {
    const shapes = [rect(0, 0, 80, 40, 20)], cs = fusedOutline(shapes, 16)
    for (const K of [0, -1, 2.5, NaN]) expect(() => extrudeSlab(cs, shapes, 16, profile, K), `K ${K}`).toThrow(/K 必须是不小于 1 的整数/)
    expect(() => extrudeSlab(cs, shapes, 16, profile, 0)).toThrow(GlassUIError)
    const bad: [Partial<typeof profile>, RegExp][] = [
      [{ thickness: 0 }, /thickness/], [{ thickness: Infinity }, /thickness/], [{ minSide: -4 }, /minSide/],
      [{ fillet: -1 }, /fillet/], [{ filletBottom: NaN }, /filletBottom/],
    ]
    for (const [p, re] of bad) expect(() => extrudeSlab(cs, shapes, 16, { ...profile, ...p }, 4), JSON.stringify(p)).toThrow(re)
    expect(() => extrudeSlab(cs, shapes, NaN, profile, 4)).toThrow(/spacing/)
    expect(() => extrudeSlab(cs, shapes, 16, { ...profile, fillet: 0, filletBottom: 0 }, 1)).not.toThrow()
  })
  it('places ring k at the contour point inset by the slab profile, with its profile normal turned outward', () => {
    const shapes = [rect(0, 0, 200, 60, 30)], K = 4
    const cs = fusedOutline(shapes, 16), m = extrudeSlab(cs, shapes, 16, profile, K)
    const n = cs[0]!.length
    const p = { width: 40, height: 40, radius: 0, thickness: 8, fillet: 2.4, filletBottom: 1.6, cornerExponent: 2, profile: 0 as const }
    for (let k = 0; k <= 2 * K + 1; k++) {
      const { inset, z, nr, nz } = profileAt(k, K, p)
      for (let i = 0; i < n; i++) {
        const v = 3 * (k * n + i), [px, py] = cs[0]![i]!, [ox, oy] = fusedNormal(shapes, 16, ...toPt(shapes, px, py))
        expect(m.positions[v]!).toBeCloseTo(px - ox * inset, 4); expect(m.positions[v + 1]!).toBeCloseTo(py - oy * inset, 4)
        expect(m.positions[v + 2]!).toBeCloseTo(z, 5)
        expect(m.normals[v]!).toBeCloseTo(ox * nr, 5); expect(m.normals[v + 1]!).toBeCloseTo(oy * nr, 5); expect(m.normals[v + 2]!).toBeCloseTo(nz, 5)
        // an exact SDF (one shape): the ring sits inset_k inside the outline
        expect(fusedField(shapes, 16, ...toPt(shapes, m.positions[v]!, m.positions[v + 1]!))).toBeCloseTo(-inset, 1)
      }
    }
    // ring 0 rests on the back plane facing −z, the plateau edge (2K+1) at the thickness facing +z
    expect(m.normals[2]).toBe(-1); expect(m.normals[3 * (2 * K + 1) * n + 2]).toBeCloseTo(1, 12)
  })
})

describe('a mesh-based GlassBatch', () => {
  it('a mesh-based GlassBatch builds front and back materials on both backends within 11 varyings', () => {
    const shapes = [rect(0, 0, 80, 40, 20), rect(88, 0, 80, 40, 20)]
    const m = extrudeSlab(fusedOutline(shapes, 16), shapes, 16, { thickness: 8, fillet: 2.4, filletBottom: 1.6, minSide: 40 }, 4)
    const batch = new GlassBatch({ mesh: m })
    for (const side of ['front', 'back'] as const) for (const forceWebGL of [false, true]) {
      const gm = createGlassMaterial({ geometry: batch.geometry, K: 0, backdrop: 'panel', side, surface: su(), content: new Texture() })
      const built = buildShaders(gm.material, batch.geometry, forceWebGL)
      expect(built.varyings.length).toBeLessThanOrEqual(11)   // the fixture reports them by name
    }
    expect(() => createGlassMaterial({ geometry: batch.geometry, K: 0, backdrop: 'panel', side: 'front', surface: su(), content: new Texture(), mode: 'fill' })).toThrow(/融合玻璃/)
  })
})
