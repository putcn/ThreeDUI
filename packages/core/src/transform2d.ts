/** A 2D affine in surface pt: `x' = a·x + c·y + tx`, `y' = b·x + d·y + ty` (CSS matrix convention). */
export interface Mat2D { a: number; b: number; c: number; d: number; tx: number; ty: number }

export const IDENTITY: Readonly<Mat2D> = Object.freeze({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 })

/** `p ∘ q`: applies `q` first, then `p`. */
export function multiply(p: Mat2D, q: Mat2D): Mat2D {
  return {
    a: p.a * q.a + p.c * q.b, b: p.b * q.a + p.d * q.b,
    c: p.a * q.c + p.c * q.d, d: p.b * q.c + p.d * q.d,
    tx: p.a * q.tx + p.c * q.ty + p.tx, ty: p.b * q.tx + p.d * q.ty + p.ty,
  }
}

export function invert(m: Mat2D): Mat2D {
  const det = m.a * m.d - m.b * m.c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw new Error(`[transform2d] matrix is singular (det=${det})`)
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det
  return { a, b, c, d, tx: -(a * m.tx + c * m.ty), ty: -(b * m.tx + d * m.ty) }
}

export function apply(m: Mat2D, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.tx, m.b * x + m.d * y + m.ty]
}

/** Uniform scale `s` about the pivot `(cx, cy)`; the pivot maps to itself. */
export function scaleAbout(cx: number, cy: number, s: number): Mat2D {
  return { a: s, b: 0, c: 0, d: s, tx: cx * (1 - s), ty: cy * (1 - s) }
}

export function isIdentity(m: Mat2D): boolean {
  return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.tx === 0 && m.ty === 0
}
