import { Matrix4, Vector4, type Camera } from 'three'

/**
 * Clip-space w below which a point counts as behind the camera (or on its plane): dividing by such a w mirrors the
 * point through the camera (w < 0) or blows it up (w → 0).
 */
export const W_EPSILON = 1e-6

/** A box in NDC: x right, y up, the viewport is [−1, 1]². */
export interface NDCBox { minX: number; minY: number; maxX: number; maxY: number }
/** `projectPolygon`'s result; `clipped`: part of the polygon was behind the camera (the box is then clamped to the viewport). */
export interface ProjectedBox extends NDCBox { clipped: boolean }

const mvp = new Matrix4()
const clip: Vector4[] = Array.from({ length: 4 }, () => new Vector4())

/**
 * The NDC bounding box of the convex polygon `points` (2D, in polygon order, in the local frame that `matrix` places in
 * the world: a Surface's content quad or plane) as `camera` sees it, its matrices current.
 *
 * The polygon is clipped to the half-space in front of the camera (clip w ≥ `W_EPSILON`) before the perspective
 * divide, so a corner at or behind the camera plane never mirrors through it:
 * - every corner in front: the projected box as is (it may extend past the viewport: a Surface larger than the screen);
 * - some behind (the polygon straddles the camera plane): the vertices the clip adds lie on w = ε and project
 *   arbitrarily far toward the side that crossed, so the box reaches the viewport edge there (conservative); it is
 *   clamped to the viewport and `clipped` is set;
 * - every corner behind, or a non-finite input: null (nothing to see).
 *
 * Never returns a non-finite value.
 */
export function projectPolygon(points: readonly (readonly [number, number])[], matrix: Matrix4, camera: Camera): ProjectedBox | null {
  mvp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(matrix)
  const n = points.length
  while (clip.length < n) clip.push(new Vector4())
  let clipped = false
  for (let i = 0; i < n; i++) {
    const [x, y] = points[i]!, c = clip[i]!.set(x, y, 0, 1).applyMatrix4(mvp)
    if (!(Number.isFinite(c.x) && Number.isFinite(c.y) && Number.isFinite(c.w))) return null
    if (c.w < W_EPSILON) clipped = true
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const add = (x: number, y: number, w: number): void => {
    const px = x / w, py = y / w
    minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py)
  }
  // Sutherland–Hodgman against the one plane w = ε: each vertex in front, plus where an edge crosses the plane
  for (let i = 0; i < n; i++) {
    const a = clip[i]!, b = clip[(i + 1) % n]!
    const aIn = a.w >= W_EPSILON, bIn = b.w >= W_EPSILON
    if (aIn) add(a.x, a.y, a.w)
    if (aIn !== bIn) {
      const t = (W_EPSILON - a.w) / (b.w - a.w)
      add(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, W_EPSILON)
    }
  }
  if (minX > maxX) return null   // nothing in front
  if (clipped) {
    const c = (v: number) => Math.min(1, Math.max(-1, v))
    minX = c(minX); maxX = c(maxX); minY = c(minY); maxY = c(maxY)
  }
  // an absurdly large but finite input can still overflow the divide
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null
  return { minX, minY, maxX, maxY, clipped }
}
