import type { Node } from 'three/webgpu'
import { float, abs, max, min, pow, length, select } from 'three/tsl'

/** Signed distance to a rounded box with superellipse corners (exponent `n`; 2 = circular): < 0 inside. CPU reference. */
export function superellipseSDF(x: number, y: number, hw: number, hh: number, r: number, n: number): number {
  const rr = Math.max(0, Math.min(r, hw, hh))
  const qx = Math.abs(x) - (hw - rr), qy = Math.abs(y) - (hh - rr)
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0)
  const outside = rr > 0 && n !== 2 ? Math.pow(Math.pow(ox, n) + Math.pow(oy, n), 1 / n) : Math.hypot(ox, oy)
  return outside + Math.min(Math.max(qx, qy), 0) - rr
}

/**
 * TSL twin of `superellipseSDF`: `p` vec2, `half` vec2, `r` float, `n` float. A plain node expression (no `Fn`: it needs
 * no stack), so it inlines into the caller's graph and tests can evaluate it against the CPU reference.
 *
 * The corner's Lⁿ norm is taken as `m · ‖o / m‖ₙ` with `m = max(o.x, o.y)`, as `hypot` does: the ratios are in [0, 1]
 * with one of them 1, so no power overflows or underflows, and the floors only keep `pow` off a 0 base (WGSL `pow` is
 * `exp2(y·log2 x)`): a ratio of 0 becomes 1e-20 (its nth power is 0 in float32 either way), the sum is ≥ 1 already
 * (the floor absorbs a GPU division a ulp short of 1), and where o = 0 (not past either corner centre line) the norm is
 * 1e-20 instead of 0.
 */
export function sdfNode(p: Node<'vec2'>, half: Node<'vec2'>, r: Node<'float'>, n: Node<'float'>): Node<'float'> {
  const rr = max(min(r, min(half.x, half.y)), 0)
  const q = abs(p).sub(half.sub(rr))
  const o = max(q, 0)
  const m = max(max(o.x, o.y), 1e-20)
  const u = max(o.div(m), 1e-20)
  const ln = m.mul(pow(max(pow(u.x, n).add(pow(u.y, n)), 1), float(1).div(n)))
  const outside = select(rr.greaterThan(0).and(n.notEqual(2)), ln, length(o))
  return outside.add(min(max(q.x, q.y), 0)).sub(rr)
}
