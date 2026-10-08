import { describe, it, expect } from 'vitest'
import { AXIS_SNAP, createSlabBaseGeometry, evalSlabVertex, slabProfile, type SlabInstanceParams } from '../src/glass/slab9'
import { createSlabGeometry } from './fixtures/spike-slab'

const K = 10, S = 10
const button: SlabInstanceParams = { width: 3.11, height: 0.344, radius: 0.172, thickness: 0.0656, fillet: 0.0205, filletBottom: 0.0123, cornerExponent: 2, profile: 0 }
const card: SlabInstanceParams = { width: 2, height: 1, radius: 0.2, thickness: 0.1, fillet: 0.03, filletBottom: 0.0, cornerExponent: 4.5, profile: 0 }

function attrs(K: number, S: number) {
  const g = createSlabBaseGeometry(K, S)
  const a = g.getAttribute('slab')
  const out = []
  for (let i = 0; i < a.count; i++) out.push({ ax: a.getX(i), ay: a.getY(i), angle: a.getZ(i), ring: a.getW(i) })
  return { g, verts: out }
}

describe('createSlabBaseGeometry', () => {
  it('has 2K+2 profile rings and a back rim of 4(S+1) vertices plus two centres, and a closed index', () => {
    const { g, verts } = attrs(K, S)
    const M = 4 * (S + 1)
    expect(verts.length).toBe((2 * K + 3) * M + 2)
    expect(g.userData).toMatchObject({ K, S, M })
    expect(verts[0]).toEqual({ ax: 1, ay: 1, angle: 0, ring: 0 })
    expect(verts[M - 1]!.ring).toBe(0); expect(verts[M]!.ring).toBe(1)
    const centreF = (2 * K + 2) * M, centreB = centreF + 1, rimB = centreF + 2
    expect(verts[centreF]!.ring).toBe(2 * K + 2); expect(verts[centreB]!.ring).toBe(2 * K + 3)
    // the back rim repeats ring 0's anchors and angles under its own ring id
    for (let i = 0; i < M; i++) expect(verts[rimB + i]).toEqual({ ...verts[i]!, ring: 2 * K + 4 })
    const idx = g.getIndex()!
    // every edge is shared by exactly two triangles (closed, consistently wound manifold) once the back rim is welded
    // to its ring-0 twin — the two rings coincide in position and differ only in normal (a split-normal seam)
    const weld = (i: number) => (i >= rimB ? i - rimB : i)
    const edges = new Map<string, number>()
    for (let t = 0; t < idx.count; t += 3) {
      const tri = [weld(idx.getX(t)), weld(idx.getX(t + 1)), weld(idx.getX(t + 2))]
      for (let e = 0; e < 3; e++) { const a = tri[e]!, b = tri[(e + 1) % 3]!; const key = a < b ? `${a}-${b}` : `${b}-${a}`; edges.set(key, (edges.get(key) ?? 0) + (a < b ? 1 : -1)) }
    }
    for (const [, v] of edges) expect(v).toBe(0)   // opposite directions on the two sides of each edge
    // the back fan uses only the back rim and the back centre, never ring 0 directly
    for (let t = 0; t < idx.count; t += 3) {
      const tri = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)]
      if (tri.includes(centreB)) for (const i of tri) expect(i === centreB || i >= rimB).toBe(true)
    }
  })
})

describe('evalSlabVertex', () => {
  it('reproduces the spike geometry ring by ring (fillet profile)', () => {
    for (const p of [button, card]) {
      const oracle = createSlabGeometry({ width: p.width, height: p.height, radius: p.radius, thickness: p.thickness, fillet: p.fillet, filletBottom: p.filletBottom, cornerExponent: p.cornerExponent, profile: 'fillet', cornerSegments: S, profileSegments: K })
      const pos = oracle.getAttribute('position')
      const { verts } = attrs(K, S)
      const M = 4 * (S + 1)
      const { fb } = slabProfile(p)
      // spike ring order: bottom round-over (K rings, only when fb > 0), wall bottom, wall top, top round-over (K), plateau centre
      const ringsInOracle = (fb > 1e-5 ? K : 0) + 2 + K
      let o = 0
      for (let ring = fb > 1e-5 ? 0 : K; ring <= 2 * K + 1; ring++) {
        for (let i = 0; i < M; i++) {
          const v = verts[ring * M + i]!
          const { position } = evalSlabVertex(v, p, K)
          expect(position[0]).toBeCloseTo(pos.getX(o), 6); expect(position[1]).toBeCloseTo(pos.getY(o), 6); expect(position[2]).toBeCloseTo(pos.getZ(o), 6)
          o++
        }
      }
      expect(o).toBe(ringsInOracle * M)
      const centre = evalSlabVertex(verts[(2 * K + 2) * M]!, p, K)
      expect(centre.position).toEqual([0, 0, p.thickness])
    }
  })
  it('normals are unit length and point the right way on each band', () => {
    const { verts } = attrs(K, S)
    const M = 4 * (S + 1)
    const len = (n: number[]) => Math.hypot(n[0]!, n[1]!, n[2]!)
    for (const v of verts) expect(len(evalSlabVertex(v, button, K).normal)).toBeCloseTo(1, 6)
    expect(evalSlabVertex(verts[0]!, button, K).normal[2]).toBeCloseTo(-1, 6)                  // ring 0: back face
    expect(evalSlabVertex(verts[K * M]!, button, K).normal[2]).toBeCloseTo(0, 6)               // wall: horizontal
    expect(evalSlabVertex(verts[K * M]!, button, K).normal[0]).toBeGreaterThan(0.99)           // corner 0, angle 0 → +x
    expect(evalSlabVertex(verts[(2 * K + 2) * M]!, button, K).normal).toEqual([0, 0, 1])
    expect(evalSlabVertex(verts[(K + 1) * M + S / 2]!, card, K).normal[0]).toBeGreaterThan(0)  // 45° corner of the squircle: x and y positive
  })
  it('clamps a fillet that exceeds the thickness and a radius that exceeds half the short side', () => {
    const p: SlabInstanceParams = { ...card, fillet: 1, filletBottom: 1, radius: 5 }
    const { fb, f, wall } = slabProfile(p)
    expect(fb).toBeCloseTo(0.05); expect(f).toBeCloseTo(0.05); expect(wall).toBeCloseTo(0)
    const { verts } = attrs(K, S)
    const top = evalSlabVertex(verts[(2 * K + 1) * 4 * (S + 1)]!, p, K).position
    expect(Math.abs(top[0])).toBeLessThanOrEqual(p.width / 2 + 1e-9)
  })
  it('lens profile rises from the rim to the plateau', () => {
    const p: SlabInstanceParams = { ...card, profile: 1 }
    const { verts } = attrs(K, S)
    const M = 4 * (S + 1)
    const rim = evalSlabVertex(verts[0]!, p, K).position, edge = evalSlabVertex(verts[(2 * K + 1) * M]!, p, K).position
    expect(rim[2]).toBeCloseTo(0, 9); expect(edge[2]).toBeCloseTo(p.thickness, 6)
    expect(Math.abs(edge[0])).toBeLessThan(Math.abs(rim[0]))
  })
  it('lens normals are unit length, horizontal at the rim and vertical at the plateau edge', () => {
    const p: SlabInstanceParams = { ...card, profile: 1 }
    const { verts } = attrs(K, S)
    const M = 4 * (S + 1)
    for (const v of verts) expect(Math.hypot(...evalSlabVertex(v, p, K).normal)).toBeCloseTo(1, 6)
    const rim = evalSlabVertex(verts[0]!, p, K).normal, edge = evalSlabVertex(verts[(2 * K + 1) * M]!, p, K).normal
    expect(rim[0]).toBeCloseTo(1, 6); expect(rim[2]).toBeCloseTo(0, 6)    // corner 0, angle 0 → +x, meeting the back plane square
    expect(edge[2]).toBeCloseTo(1, 6)
  })
  it('the back face is flat: its rim sits exactly on ring 0 at z = 0 with a fixed −z normal (fillet and lens)', () => {
    const { verts } = attrs(K, S)
    const M = 4 * (S + 1)
    const centreB = (2 * K + 2) * M + 1, rimB = centreB + 1
    for (const p of [button, card, { ...card, profile: 1 } as SlabInstanceParams]) {
      expect(evalSlabVertex(verts[centreB]!, p, K).normal).toEqual([0, 0, -1])
      for (let i = 0; i < M; i++) {
        const back = evalSlabVertex(verts[rimB + i]!, p, K), front = evalSlabVertex(verts[i]!, p, K)
        expect(back.position).toEqual(front.position)
        expect(back.position[2]).toBe(0)
        expect(back.normal).toEqual([0, 0, -1])
      }
    }
  })
  it('a quadrant-boundary vertex stays on its straight edge under a GPU-sized sin/cos residual', () => {
    expect(AXIS_SNAP).toBeGreaterThan(2 ** -11)                     // WGSL f32 sin/cos absolute error bound in [−π, π]
    expect(AXIS_SNAP).toBeLessThan(Math.sin(Math.PI / (2 * 64)) / 10)  // far below the nearest interior sample at S = 64
    const { verts } = attrs(K, S)
    const M = 4 * (S + 1)
    for (let i = 0; i < M; i++) {
      if (i % (S + 1) !== 0 && i % (S + 1) !== S) continue          // only the corner ends, at angles kπ/2
      const v = verts[K * M + i]!
      const exact = evalSlabVertex(v, card, K).position
      for (const d of [-(2 ** -11), 2 ** -11]) {
        const drifted = evalSlabVertex({ ...v, angle: v.angle + d }, card, K).position
        expect(drifted[0]).toBeCloseTo(exact[0], 6); expect(drifted[1]).toBeCloseTo(exact[1], 6)
      }
    }
  })
})
