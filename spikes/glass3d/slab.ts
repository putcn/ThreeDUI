// SPIKE: GlassSlab geometry — a superellipse rounded rect extruded with real thickness.
// Profiles:
//   'fillet'   straight vertical side wall + small round-over to a flat top  (reference look)
//   'squircle' | 'circle'  lens-like convex bevel from the rim up to the plateau
// Back face at z = 0, top at z = thickness.

import { BufferGeometry, Float32BufferAttribute } from 'three'

export interface SlabParams {
  width: number
  height: number
  radius: number
  thickness: number
  profile?: 'fillet' | 'squircle' | 'circle'
  fillet?: number              // fillet profile: round-over radius (≤ thickness)
  bezel?: number               // lens profiles: width of the bevel band
  cornerExponent?: number      // 2 = circle, ~4.5 = continuous corner
  cornerSegments?: number
  profileSegments?: number
  backFace?: boolean
}

function lensHeight(x: number, profile: 'squircle' | 'circle') {
  const t = 1 - x
  return profile === 'circle' ? Math.sqrt(Math.max(0, 1 - t * t)) : Math.pow(Math.max(0, 1 - t ** 4), 0.25)
}

/** contour of the shape inset by d, sampled around the perimeter (CCW) */
function contour(p: SlabParams, inset: number, n: number, S: number): [number, number][] {
  const hw = p.width / 2 - inset, hh = p.height / 2 - inset
  const r = Math.max(Math.min(p.radius, Math.min(p.width, p.height) / 2) - inset, 0)
  const pts: [number, number][] = []
  const cx = Math.max(hw - r, 0), cy = Math.max(hh - r, 0)
  const corners: [number, number, number][] = [[cx, cy, 0], [-cx, cy, Math.PI / 2], [-cx, -cy, Math.PI], [cx, -cy, Math.PI * 1.5]]
  for (const [ox, oy, a0] of corners) {
    for (let i = 0; i <= S; i++) {
      const a = a0 + (i / S) * (Math.PI / 2)
      const c = Math.cos(a), s = Math.sin(a)
      pts.push([ox + Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * r, oy + Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * r])
    }
  }
  return pts
}

export function createSlabGeometry(p: SlabParams): BufferGeometry {
  const n = p.cornerExponent ?? 4.5
  const profile = p.profile ?? 'fillet'
  const S = p.cornerSegments ?? 10
  const K = p.profileSegments ?? 10
  const maxInset = Math.min(p.width, p.height) / 2 - 1e-4

  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const M = 4 * (S + 1)
  const pushRing = (pts: [number, number][], z: number) => {
    const base = positions.length / 3
    for (const [x, y] of pts) { positions.push(x, y, z); uvs.push(x / p.width + 0.5, y / p.height + 0.5) }
    return base
  }
  const connect = (a: number, b: number) => {
    for (let i = 0; i < M; i++) { const j = (i + 1) % M; indices.push(a + i, a + j, b + j, a + i, b + j, b + i) }
  }

  // (inset, z) samples of the profile, from the bottom rim up to the plateau edge
  const prof: [number, number][] = []
  if (profile === 'fillet') {
    const f = Math.min(p.fillet ?? p.thickness * 0.4, p.thickness, maxInset)
    const wall = p.thickness - f
    prof.push([0, 0])
    if (wall > 1e-5) prof.push([0, wall])              // straight side wall (separate ring → crisp edge)
    for (let k = 1; k <= K; k++) {                      // quarter-circle round-over
      const a = (k / K) * (Math.PI / 2)
      prof.push([f - f * Math.cos(a), wall + f * Math.sin(a)])
    }
  } else {
    const bezel = Math.min(p.bezel ?? maxInset * 0.6, maxInset)
    for (let k = 0; k <= K; k++) {
      const x = Math.pow(k / K, 1.6)
      prof.push([bezel * x, p.thickness * lensHeight(x, profile)])
    }
  }

  // side wall gets its own vertices so the wall/round-over crease stays sharp
  let rings: number[] = []
  if (profile === 'fillet' && prof.length > 2 && prof[1][0] === 0) {
    const r0 = pushRing(contour(p, 0, n, S), prof[0][1])
    const r1 = pushRing(contour(p, 0, n, S), prof[1][1])
    connect(r0, r1)
    rings = [pushRing(contour(p, 0, n, S), prof[1][1])]
    for (let k = 2; k < prof.length; k++) rings.push(pushRing(contour(p, prof[k][0], n, S), prof[k][1]))
  } else {
    rings = prof.map(([inset, z]) => pushRing(contour(p, inset, n, S), z))
  }
  for (let k = 0; k < rings.length - 1; k++) connect(rings[k], rings[k + 1])

  // plateau fan
  const centerF = positions.length / 3
  positions.push(0, 0, p.thickness); uvs.push(0.5, 0.5)
  const top = rings[rings.length - 1]
  for (let i = 0; i < M; i++) indices.push(centerF, top + i, top + (i + 1) % M)

  if (p.backFace ?? true) {
    const back = pushRing(contour(p, 0, n, S), 0)
    const centerB = positions.length / 3
    positions.push(0, 0, 0); uvs.push(0.5, 0.5)
    for (let i = 0; i < M; i++) indices.push(centerB, back + (i + 1) % M, back + i)
  }

  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(positions, 3))
  g.setAttribute('uv', new Float32BufferAttribute(uvs, 2))
  g.setIndex(indices)
  g.computeVertexNormals()
  return g
}
