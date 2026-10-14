import { describe, it, expect } from 'vitest'
import { Matrix4, PerspectiveCamera, Vector3 } from 'three'
import { projectPolygon, W_EPSILON } from '../src/project'

/** A camera at the origin looking down −z (aspect 1, 90° fov: NDC = (x, y) / −z). */
function camera(): PerspectiveCamera {
  const c = new PerspectiveCamera(90, 1, 0.1, 100)
  c.updateMatrixWorld(); return c
}
const SQUARE = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const
/** The unit square's frame: translated to `p`, then turned about x by `rx` (radians). */
const placed = (p: [number, number, number], rx = 0) => new Matrix4().makeTranslation(...p).multiply(new Matrix4().makeRotationX(rx))
const finite = (b: object | null) => b !== null && Object.values(b).every(v => typeof v === 'boolean' || Number.isFinite(v))

describe('projectPolygon', () => {
  it('in front of the camera: the projected box, as Vector3.project gives it, unclamped', () => {
    const cam = camera(), m = placed([0.2, 0.1, -2])
    const b = projectPolygon(SQUARE, m, cam)!
    const ndc = SQUARE.map(([x, y]) => new Vector3(x, y, 0).applyMatrix4(m).project(cam))
    expect(b.clipped).toBe(false)
    expect(b.minX).toBeCloseTo(Math.min(...ndc.map(v => v.x)), 12); expect(b.maxX).toBeCloseTo(Math.max(...ndc.map(v => v.x)), 12)
    expect(b.minY).toBeCloseTo(Math.min(...ndc.map(v => v.y)), 12); expect(b.maxY).toBeCloseTo(Math.max(...ndc.map(v => v.y)), 12)
    // larger than the screen (a close Surface): not clamped, so its content RT keeps one texel per CSS px
    const big = projectPolygon(SQUARE, placed([0, 0, -0.2]), cam)!
    expect(big.clipped).toBe(false); expect(big.maxX).toBeCloseTo(2.5, 12); expect(big.minY).toBeCloseTo(-2.5, 12)
  })
  it('a corner exactly at w = 0: finite, reaching the viewport edge on its side, clamped', () => {
    const cam = camera()
    // a floor-like quad tipped back about x: its near edge passes through the camera plane at y = 0.25
    const m = placed([0.3, 0.25, -0.5], -Math.PI / 2)   // local +y → world −z: corners at z = −1 and z = 0
    const corners = SQUARE.map(([x, y]) => new Vector3(x, y, 0).applyMatrix4(m))
    expect(corners.filter(c => Math.abs(c.z) < 1e-12)).toHaveLength(2)   // two corners exactly on the camera plane (w = 0)
    const b = projectPolygon(SQUARE, m, cam)!
    expect(finite(b)).toBe(true); expect(b.clipped).toBe(true)
    // its near edge spans x ∈ [−0.2, 0.8] above the eye: toward the camera plane it runs off the top and both sides
    expect([b.minX, b.maxX, b.maxY]).toEqual([-1, 1, 1])
    expect(b.minY).toBeCloseTo(0.25, 12)                                   // the far edge, at w = 1, as projected
  })
  it('a quad straddling the camera plane never mirrors: finite and within the viewport', () => {
    const cam = camera()
    // a wall right of the eye from z = −2 to z = +1 (its far half in front, its near part behind the camera)
    const wall = new Matrix4().makeTranslation(0.3, 0, -0.5).multiply(new Matrix4().makeRotationY(Math.PI / 2)).multiply(new Matrix4().makeScale(3, 1, 1))
    const b = projectPolygon(SQUARE, wall, cam)!
    expect(finite(b)).toBe(true); expect(b.clipped).toBe(true)
    expect(b.minX).toBeCloseTo(0.15, 12)                                   // the far edge, at w = 2, as projected
    expect([b.maxX, b.minY, b.maxY]).toEqual([1, -1, 1])                   // toward the eye: off the right, top and bottom
    // the naive per-corner projection mirrors the corners behind the camera to the left of the eye
    const naive = SQUARE.map(([x, y]) => new Vector3(x, y, 0).applyMatrix4(wall).project(cam).x)
    expect(Math.min(...naive)).toBeLessThan(0)
    // a corner a hair behind the camera: the naive projection runs to ~10⁴ viewports, this stays in the viewport
    const hair = new Matrix4().makeTranslation(0.3, 0, -1.0 + 0.0005).multiply(new Matrix4().makeRotationY(Math.PI / 2)).multiply(new Matrix4().makeScale(2.001, 1, 1))
    const h = projectPolygon(SQUARE, hair, cam)!
    expect(finite(h)).toBe(true); expect(Math.max(...[h.minX, h.maxX, h.minY, h.maxY].map(Math.abs))).toBeLessThanOrEqual(1)
  })
  it('entirely behind the camera, or not finite: null', () => {
    const cam = camera()
    expect(projectPolygon(SQUARE, placed([0, 0, 2]), cam)).toBeNull()
    expect(projectPolygon(SQUARE, placed([0, 0, W_EPSILON / 2]), cam)).toBeNull()   // on the camera plane
    expect(projectPolygon(SQUARE, new Matrix4().makeTranslation(NaN, 0, -2), cam)).toBeNull()
    expect(projectPolygon(SQUARE, new Matrix4().makeTranslation(0, 0, -2).multiply(new Matrix4().makeScale(Infinity, 1, 1)), cam)).toBeNull()
  })
})
