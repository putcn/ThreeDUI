import type { InstancedBufferGeometry } from 'three'
import type { Node } from 'three/webgpu'
import { attribute, float, vec2, vec3, vec4, abs, sign, pow, sin, cos, sqrt, max, min, select, dot, length, varying } from 'three/tsl'
import { AXIS_SNAP } from './slab9'

const HALF_PI = Math.PI / 2
/** What the vertex stage reads: the base mesh's `slab` and the GLASS_ATTRS it needs. */
const VERTEX_ATTRS = ['slab', 'iRect', 'iShape', 'iCorner', 'iMat0', 'iMat1', 'iMat2'] as const

/** The CPU's `l || 1` for a length `l ≥ 0` (NaN → 1 too): divide by 1 instead of 0, so a zero vector stays zero. */
const orOne = (l: Node<'float'>) => select(l.greaterThan(0), l, float(1))

/**
 * TSL mirror of `evalSlabVertex` (slab9.ts) for the current vertex: the base mesh's `slab` = (anchor.x, anchor.y,
 * angle, ring) placed by the instance attributes (packing: GLASS_ATTRS in batch.ts). Must stay numerically identical to
 * the CPU evaluator, whose tests are the contract; each step quotes the CPU line it mirrors. The CPU's early returns
 * and `if` cascade become nested `select`s (three emits each as an if/else, so only the taken branch runs), which need
 * no TSL stack and so build outside a `Fn`.
 *
 * - `slabLocal`: slab-local position (centred, y up, back face at z = 0), before the instance matrix — for planar uvs.
 * - `local` (= `position`, for `material.positionNode`): Surface-local units after the `iMat` rows.
 * - `normal`: the unit normal in Surface-local space, as a vertex-stage varying — `material.normalNode` is read in the
 *   fragment stage, and re-evaluating the slab there from interpolated `slab` attributes would smear the per-band
 *   branches across each triangle. The rows' 3×3 is applied directly (not its inverse transpose): exact for the
 *   uniform scales and rotations core composes.
 *
 * Instance attributes are read by name (`attribute`), not bound as objects: `InstanceBuffer` replaces them when it
 * grows, and the renderer rebinds a geometry attribute whose id changed under the same name.
 */
export function slabVertex(geometry: InstancedBufferGeometry, K: number) {
  for (const name of VERTEX_ATTRS) if (!geometry.hasAttribute(name)) throw new Error(`[render] slabVertex: geometry has no "${name}" attribute`)
  if (geometry.userData.K !== K) throw new Error(`[render] slabVertex: geometry was laid out for K = ${String(geometry.userData.K)}, not K = ${K}`)

  const slab = attribute('slab', 'vec4')
  const iRect = attribute('iRect', 'vec4'), iShape = attribute('iShape', 'vec4'), iCorner = attribute('iCorner', 'vec4')
  const iMat0 = attribute('iMat0', 'vec4'), iMat1 = attribute('iMat1', 'vec4'), iMat2 = attribute('iMat2', 'vec4')

  // SlabVertex { ax, ay, angle, ring } and SlabInstanceParams from the packing
  const ax = slab.x, ay = slab.y, angle = slab.z, ring = slab.w
  const width = iRect.z, height = iRect.w
  const radius = iShape.x, thickness = iShape.y, fillet = iShape.z, filletBottom = iShape.w
  const n = iCorner.x, profile = iCorner.y

  // slabProfile(p)
  const maxInset = min(width, height).div(2).sub(1e-4)              // Math.min(p.width, p.height) / 2 - 1e-4
  const fb = min(filletBottom, thickness.mul(0.5), maxInset)          // Math.min(p.filletBottom, p.thickness * 0.5, maxInset)
  const f = min(fillet, thickness.sub(fb), maxInset)                  // Math.min(p.fillet, p.thickness - fb, maxInset)
  const wall = thickness.sub(f).sub(fb)                               // p.thickness - f - fb
  const bezel = maxInset.mul(0.6)                                     // maxInset * 0.6

  // evalSlabVertex: ring classification (ring ids are exact integers; ±0.5 bands stand in for `===`)
  const isCentre = ring.greaterThan(2 * K + 1.5).and(ring.lessThan(2 * K + 3.5))   // ring === 2K+2 || ring === 2K+3
  const isTopCentre = ring.lessThan(2 * K + 2.5)                                    // ring === 2K+2 (within isCentre)
  const isBackRim = ring.greaterThan(2 * K + 3.5)                                   // back = v.ring === 2 * K + 4
  const pRing = select(isBackRim, float(0), ring)                                   // profileAt(back ? 0 : v.ring, K, p)

  // profileAt(pRing, K, p) → (inset, z, nr, nz), one vec4 per CPU branch
  // lens (p.profile === 1)
  // WGSL pow is exp2(y·log2 x), out of domain at x = 0 (ring 0 and the back rim). Rings are integers, so t is 0 or
  // ≥ 1/(2K+1): the floor never changes a value, and the select gives the CPU's exact pow(0, 1.6) = 0
  const t = pRing.div(2 * K + 1)                                      // ring / (2 * K + 1)
  const x = select(t.greaterThan(0), pow(max(t, 1e-20), 1.6), float(0))   // Math.pow(ring / (2 * K + 1), 1.6)
  const h = sqrt(max(float(1).sub(float(1).sub(x).mul(float(1).sub(x))), 0))   // Math.sqrt(Math.max(1 - (1 - x) * (1 - x), 0))
  const lnr = thickness.mul(float(1).sub(x)), lnz = bezel.mul(h)      // nr = p.thickness * (1 - x), nz = bezel * h
  const ll = orOne(length(vec2(lnr, lnz)))                            // Math.hypot(nr, nz) || 1
  const lens = vec4(bezel.mul(x), thickness.mul(h), lnr.div(ll), lnz.div(ll))   // { inset: bezel * x, z: p.thickness * h, nr: nr / l, nz: nz / l }
  // ring < K: bottom round-over
  const ab = pRing.div(K).mul(HALF_PI)                                // (ring / K) * (Math.PI / 2)
  const bottom = vec4(fb.sub(fb.mul(sin(ab))), fb.sub(fb.mul(cos(ab))), sin(ab), cos(ab).negate())   // { fb - fb·sin a, fb - fb·cos a, sin a, -cos a }
  // ring === K: wall bottom; ring === K + 1: wall top
  const wallBottom = vec4(0, fb, 1, 0)                                // { inset: 0, z: fb, nr: 1, nz: 0 }
  const wallTop = vec4(0, fb.add(wall), 1, 0)                         // { inset: 0, z: fb + wall, nr: 1, nz: 0 }
  // otherwise: top round-over
  const at = pRing.sub(K).sub(1).div(K).mul(HALF_PI)                  // ((ring - K - 1) / K) * (Math.PI / 2)
  const top = vec4(f.sub(f.mul(cos(at))), fb.add(wall).add(f.mul(sin(at))), cos(at), sin(at))      // { f - f·cos a, fb + wall + f·sin a, cos a, sin a }
  const prof = select(profile.greaterThan(0.5), lens,                 // if (p.profile === 1)
    select(pRing.lessThan(K - 0.5), bottom,                           // if (ring < K)
      select(pRing.lessThan(K + 0.5), wallBottom,                     // if (ring === K)
        select(pRing.lessThan(K + 1.5), wallTop, top))))              // if (ring === K + 1) … else
  const inset = prof.x, z = prof.y, nr = prof.z, nz = prof.w

  // the contour inset by `inset`: a rounded rect whose corners are superellipse quadrants of radius r at (±cx, ±cy)
  const hw = width.div(2).sub(inset), hh = height.div(2).sub(inset)                 // p.width / 2 - inset, p.height / 2 - inset
  const r = max(min(radius, min(width, height).div(2)).sub(inset), 0)               // Math.max(Math.min(p.radius, Math.min(p.width, p.height) / 2) - inset, 0)
  const cx = max(hw.sub(r), 0), cy = max(hh.sub(r), 0)                              // Math.max(hw - r, 0), Math.max(hh - r, 0)
  const c0 = cos(angle), s0 = sin(angle)                                            // let c = Math.cos(v.angle), s = Math.sin(v.angle)
  const c = select(abs(c0).lessThan(AXIS_SNAP), float(0), c0)                       // if (Math.abs(c) < AXIS_SNAP) c = 0
  const s = select(abs(s0).lessThan(AXIS_SNAP), float(0), s0)                       // if (Math.abs(s) < AXIS_SNAP) s = 0
  // pow bases: |c| is either 0 (snapped) or ≥ AXIS_SNAP, so the floor only keeps pow(0, ·) off the GPU (it multiplies
  // sign(0) = 0 either way)
  const absC = max(abs(c), 1e-20), absS = max(abs(s), 1e-20)
  const e = float(2).div(n)                                                         // 2 / n
  const px = ax.mul(cx).add(sign(c).mul(pow(absC, e)).mul(r))                       // v.ax * cx + Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * r
  const py = ay.mul(cy).add(sign(s).mul(pow(absS, e)).mul(r))                       // v.ay * cy + Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * r
  // outward normal of |x|^n + |y|^n = r^n at the parametric point, independent of r
  const e2 = float(2).sub(e)                                                        // 2 - 2 / n
  const o = vec2(sign(c).mul(pow(absC, e2)), sign(s).mul(pow(absS, e2)))            // ox, oy
  const on = o.div(orOne(length(o)))                                                // ol = Math.hypot(ox, oy) || 1; ox /= ol; oy /= ol
  // tilt the horizontal contour normal by the profile normal: radial part along (ox, oy), vertical part nz
  const nv = vec3(on.x.mul(nr), on.y.mul(nr), nz)                                   // nx = ox * nr, ny = oy * nr
  const contourNormal = nv.div(orOne(length(nv)))                                   // l = Math.hypot(nx, ny, nz) || 1
  const contourPos = vec3(px, py, z)                                                // position: [px, py, z]

  // early returns for the centres; the back rim keeps ring 0's position with a flat normal
  const slabLocal = select(isCentre, vec3(0, 0, select(isTopCentre, thickness, float(0))), contourPos)   // [0, 0, p.thickness] | [0, 0, 0]
  const slabNormal = select(isCentre, vec3(0, 0, select(isTopCentre, float(1), float(-1))),             // [0, 0, 1] | [0, 0, -1]
    select(isBackRim, vec3(0, 0, -1), contourNormal))                                                     // back ? [0, 0, -1] : [nx / l, ny / l, nz / l]

  // instance placement: rows of instanceMatrix (writeMatrixRows) — local = M · (slabLocal, 1), normal ∝ M₃ₓ₃ · n
  const p4 = vec4(slabLocal, 1)
  const local = vec3(dot(iMat0, p4), dot(iMat1, p4), dot(iMat2, p4))
  const mn = vec3(dot(iMat0.xyz, slabNormal), dot(iMat1.xyz, slabNormal), dot(iMat2.xyz, slabNormal))
  const normal = varying(mn.div(orOne(length(mn))))
  return { position: local, normal, local, slabLocal }
}
