import { describe, it, expect } from 'vitest'
import { IDENTITY, multiply, invert, apply, scaleAbout, isIdentity } from '../src/transform2d'
import { GlassUIError } from '../src/errors'

describe('Mat2D', () => {
  it('scaleAbout keeps the pivot fixed and scales distances', () => {
    const m = scaleAbout(100, 50, 0.5)
    expect(apply(m, 100, 50)).toEqual([100, 50])
    expect(apply(m, 140, 50)).toEqual([120, 50])
  })
  it('multiply applies the right operand first', () => {
    const outer = scaleAbout(0, 0, 2), inner = scaleAbout(10, 10, 0.5)
    const m = multiply(outer, inner)
    // inner: (20,10) → (15,10); outer: → (30,20)
    expect(apply(m, 20, 10)).toEqual([30, 20])
  })
  it('invert undoes apply', () => {
    const m = multiply(scaleAbout(30, 40, 1.5), { a: 1, b: 0.2, c: -0.1, d: 1, tx: 5, ty: -3 })
    const [x, y] = apply(m, 12, 34)
    const [bx, by] = apply(invert(m), x, y)
    expect(bx).toBeCloseTo(12, 9); expect(by).toBeCloseTo(34, 9)
  })
  it('invert rejects a singular or non-finite matrix with a GlassUIError', () => {
    expect(() => invert(scaleAbout(10, 10, 0))).toThrow(GlassUIError)
    expect(() => invert(scaleAbout(10, 10, 0))).toThrow('[transform2d] 矩阵不可逆（det=0）')
    expect(() => invert({ ...IDENTITY, a: Number.NaN })).toThrow('不可逆')
  })
  it('isIdentity', () => { expect(isIdentity(IDENTITY)).toBe(true); expect(isIdentity(scaleAbout(1, 1, 0.9))).toBe(false) })
})
