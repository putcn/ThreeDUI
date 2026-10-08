// SPIKE: GlassSlab geometry — a superellipse rounded rect with a convex bevel
// profile and real thickness. Front plateau at z = thickness, rim at z = 0.
// (Per-element build; the 9-slice instanced version comes in Phase 2.)

import { BufferGeometry, Float32BufferAttribute } from 'three'

export interface SlabParams {
  width: number
  height: number
  radius: number
  bezel: number
  thickness: number
  cornerExponent?: number      // 2 = circle, ~4.5 = continuous corner
  profile?: 'squircle' | 'circle'
  cornerSegments?: number
  profileSegments?: number
  backFace?: boolean
}

function profileHeight(x: number, profile: 'squircle' | 'circle') {
  // x: 0 at rim → 1 at plateau
  const t = 1 - x
  return profile === 'circle' ? Math.sqrt(Math.max(0, 1 - t * t)) : Math.pow(Math.max(0, 1 - t ** 4), 0.25)
}

/** contour of the shape inset by d, sampled around the perimeter */
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
      const x = Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * r
      const y = Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * r
      pts.push([ox + x, oy + y])
    }
  }
  return pts
}

export function createSlabGeometry(p: SlabParams): BufferGeometry {
  const n = p.cornerExponent ?? 4.5
  const profile = p.profile ?? 'squircle'
  const S = p.cornerSegments ?? 10
  const K = p.profileSegments ?? 10
  const bezel = Math.min(p.bezel, Math.min(p.width, p.height) / 2 - 1e-4)

  const positions: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const M = 4 * (S + 1)
  const pushRing = (pts: [number, number][], z: number) => {
    const base = positions.length / 3
    for (const [x, y] of pts) {
      positions.push(x, y, z)
      uvs.push(x / p.width + 0.5, y / p.height + 0.5)
    }
    return base
  }

  // front: rings from rim (k=0) to plateau (k=K)
  const rings: number[] = []
  for (let k = 0; k <= K; k++) {
    // concentrate samples near the rim where curvature is highest
    const x = Math.pow(k / K, 1.6)
    rings.push(pushRing(contour(p, bezel * x, n, S), p.thickness * profileHeight(x, profile)))
  }
  for (let k = 0; k < K; k++) {
    const a = rings[k], b = rings[k + 1]
    for (let i = 0; i < M; i++) {
      const j = (i + 1) % M
      indices.push(a + i, a + j, b + j, a + i, b + j, b + i)
    }
  }
  // plateau fan
  const centerF = positions.length / 3
  positions.push(0, 0, p.thickness); uvs.push(0.5, 0.5)
  const top = rings[K]
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
