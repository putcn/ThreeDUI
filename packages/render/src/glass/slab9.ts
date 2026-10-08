import { InstancedBufferGeometry, Float32BufferAttribute, Sphere, Vector3 } from 'three'

// One geometry for every glass element in a Surface (spec §5.2): vertices carry only *where on the shape* they are
// (corner anchor, contour angle, profile ring); the instance's size/radius/thickness/fillets place them, both here
// (CPU reference, used by tests) and in the TSL vertex stage (glass/vertex.ts), which must stay identical.
//
// Ring layout (K profile segments; each ring is M = 4(S+1) contour vertices, CCW: corner 0 = +x+y at angles 0..π/2,
// then +y−x, −x−y, −y+x):
//   rings 0..K−1     bottom round-over, α = ring/K · π/2 (ring 0 is the rim on the back plane)
//   ring  K          wall bottom
//   ring  K+1        wall top
//   rings K+2..2K+1  top round-over, α = (ring−K−1)/K · π/2 (ring 2K+1 is the plateau edge)
//   ring  2K+2       plateau centre (one vertex)
//   ring  2K+3       back centre (one vertex)
//   ring  2K+4       back rim: ring 0's anchors/angles and position, but a flat (0, 0, −1) normal; the back face is
//                    this ring fanned to the back centre with reversed winding (its own vertices, so the back face is
//                    not smoothed into ring 0's side normals — a split-normal seam, welded by position to ring 0)
// Vertex order follows the ring id: rings 0..2K+1 at index ring·M, the two centres at (2K+2)M and (2K+2)M+1, then the
// back rim from (2K+2)M+2.
// The lens profile (profile 1) uses the same 2K+2 rings as one convex bevel from the rim (ring 0) to the plateau edge.

export interface SlabInstanceParams { width: number; height: number; radius: number; thickness: number; fillet: number; filletBottom: number; cornerExponent: number; profile: 0 | 1 }
export interface SlabVertex { ax: number; ay: number; angle: number; ring: number }

/**
 * `cos`/`sin` magnitudes below this are taken as exactly 0 — here and in the TSL vertex stage, which imports it.
 * The `slab` attribute stores the contour angle as float32, so a quadrant-boundary vertex (angle kπ/2) yields |cos| or
 * |sin| ≈ 1e-7 on the CPU rather than 0, and on the GPU WGSL only bounds f32 sin/cos to 2⁻¹¹ ≈ 4.9e-4 absolute error
 * inside [−π, π] (none outside; our angles reach 2π). `pow(·, 2/n)` magnifies such a residual (≈1e-4 units at
 * n = 4.5 from 1e-7; ≈0.034·r from 4.9e-4), pulling the vertex off the straight edge. No other contour sample comes
 * near the threshold: the nearest has |cos| = sin(π/2S) (≈ 0.16 at S = 10, ≈ 0.0245 at S = 64; above 2e-3 up to S ≈ 785).
 */
export const AXIS_SNAP = 2e-3

/** The clamped profile numbers: bottom round-over, top round-over, straight wall, max inset, lens bezel. */
export function slabProfile(p: SlabInstanceParams): { fb: number; f: number; wall: number; maxInset: number; bezel: number } {
  const maxInset = Math.min(p.width, p.height) / 2 - 1e-4
  const fb = Math.min(p.filletBottom, p.thickness * 0.5, maxInset)
  const f = Math.min(p.fillet, p.thickness - fb, maxInset)
  return { fb, f, wall: p.thickness - f - fb, maxInset, bezel: maxInset * 0.6 }
}

/** Inset and height of ring `ring`, plus the unit profile normal (radial-outward r, z) — mirrors the TSL. */
function profileAt(ring: number, K: number, p: SlabInstanceParams): { inset: number; z: number; nr: number; nz: number } {
  const { fb, f, wall, bezel } = slabProfile(p)
  if (p.profile === 1) {
    // lens: a quarter-circle height h(x) = √(1 − (1−x)²) over the bevel, x eased by ^1.6 so rings bunch at the rim
    const x = Math.pow(ring / (2 * K + 1), 1.6)
    const h = Math.sqrt(Math.max(1 - (1 - x) * (1 - x), 0))   // 0 at the rim (x = 0), 1 at the plateau edge (x = 1)
    // slope normal ∝ (T(1−x)/h, bezel); multiplied through by h so the rim (h = 0) gets its exact horizontal limit
    // without a division
    const nr = p.thickness * (1 - x), nz = bezel * h
    const l = Math.hypot(nr, nz) || 1
    return { inset: bezel * x, z: p.thickness * h, nr: nr / l, nz: nz / l }
  }
  if (ring < K) { const a = (ring / K) * (Math.PI / 2); return { inset: fb - fb * Math.sin(a), z: fb - fb * Math.cos(a), nr: Math.sin(a), nz: -Math.cos(a) } }
  if (ring === K) return { inset: 0, z: fb, nr: 1, nz: 0 }
  if (ring === K + 1) return { inset: 0, z: fb + wall, nr: 1, nz: 0 }
  const a = ((ring - K - 1) / K) * (Math.PI / 2)
  return { inset: f - f * Math.cos(a), z: fb + wall + f * Math.sin(a), nr: Math.cos(a), nz: Math.sin(a) }
}

/** Slab-local position (centred, y up, back face at z = 0) and unit normal of one base vertex for one instance. */
export function evalSlabVertex(v: SlabVertex, p: SlabInstanceParams, K: number): { position: [number, number, number]; normal: [number, number, number] } {
  if (v.ring === 2 * K + 2) return { position: [0, 0, p.thickness], normal: [0, 0, 1] }
  if (v.ring === 2 * K + 3) return { position: [0, 0, 0], normal: [0, 0, -1] }
  const back = v.ring === 2 * K + 4   // back rim: positioned exactly as ring 0, normal replaced by the flat (0, 0, −1)
  const { inset, z, nr, nz } = profileAt(back ? 0 : v.ring, K, p)
  const n = p.cornerExponent
  // the contour inset by `inset`: a rounded rect whose corners are superellipse quadrants of radius r centred at (±cx, ±cy)
  const hw = p.width / 2 - inset, hh = p.height / 2 - inset
  const r = Math.max(Math.min(p.radius, Math.min(p.width, p.height) / 2) - inset, 0)
  const cx = Math.max(hw - r, 0), cy = Math.max(hh - r, 0)
  let c = Math.cos(v.angle), s = Math.sin(v.angle)
  if (Math.abs(c) < AXIS_SNAP) c = 0
  if (Math.abs(s) < AXIS_SNAP) s = 0
  // parametric superellipse point: (sign(c)|c|^(2/n), sign(s)|s|^(2/n)) · r, offset to the anchor's corner centre
  const px = v.ax * cx + Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * r
  const py = v.ay * cy + Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * r
  // outward normal of |x|^n + |y|^n = r^n at the parametric point, independent of r
  let ox = Math.sign(c) * Math.pow(Math.abs(c), 2 - 2 / n), oy = Math.sign(s) * Math.pow(Math.abs(s), 2 - 2 / n)
  const ol = Math.hypot(ox, oy) || 1; ox /= ol; oy /= ol
  // tilt the horizontal contour normal by the profile normal: radial part along (ox, oy), vertical part nz
  const nx = ox * nr, ny = oy * nr
  const l = Math.hypot(nx, ny, nz) || 1
  return { position: [px, py, z], normal: back ? [0, 0, -1] : [nx / l, ny / l, nz / l] }
}

/** The shared base mesh: attribute `slab` = (anchor.x, anchor.y, angle, ring); see the ring layout in the file comment. */
export function createSlabBaseGeometry(K = 8, S = 8): InstancedBufferGeometry {
  const M = 4 * (S + 1)
  const slab: number[] = []
  const indices: number[] = []
  const corners: [number, number, number][] = [[1, 1, 0], [-1, 1, Math.PI / 2], [-1, -1, Math.PI], [1, -1, Math.PI * 1.5]]
  const pushRing = (ring: number) => {
    for (const [ax, ay, a0] of corners) for (let i = 0; i <= S; i++) slab.push(ax, ay, a0 + (i / S) * (Math.PI / 2), ring)
  }
  const connect = (a: number, b: number) => {
    for (let i = 0; i < M; i++) { const j = (i + 1) % M; indices.push(a + i, a + j, b + j, a + i, b + j, b + i) }
  }
  for (let ring = 0; ring <= 2 * K + 1; ring++) pushRing(ring)
  for (let ring = 0; ring < 2 * K + 1; ring++) connect(ring * M, (ring + 1) * M)
  const centreF = slab.length / 4; slab.push(0, 0, 0, 2 * K + 2)
  const top = (2 * K + 1) * M
  for (let i = 0; i < M; i++) indices.push(centreF, top + i, top + (i + 1) % M)
  const centreB = slab.length / 4; slab.push(0, 0, 0, 2 * K + 3)
  const rimB = slab.length / 4; pushRing(2 * K + 4)
  for (let i = 0; i < M; i++) indices.push(centreB, rimB + (i + 1) % M, rimB + i)
  const g = new InstancedBufferGeometry()
  g.setAttribute('slab', new Float32BufferAttribute(slab, 4))
  g.setIndex(indices)
  g.userData = { K, S, M }
  g.boundingSphere = new Sphere(new Vector3(), 1e6)   // positions come from instances; never frustum-cull by this
  return g
}
