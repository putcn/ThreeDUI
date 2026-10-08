import { describe, it, expect } from 'vitest'
import { srgbToLinear, toLinear, toColor } from '../src/color'

describe('colour conversion', () => {
  it('matches the sRGB transfer function', () => {
    expect(srgbToLinear(0)).toBe(0); expect(srgbToLinear(1)).toBeCloseTo(1, 9)
    expect(srgbToLinear(0.5)).toBeCloseTo(0.2140, 3)
    expect(srgbToLinear(0.04)).toBeCloseTo(0.04 / 12.92, 9)
  })
  it('converts RGBA and keeps alpha linear', () => {
    expect(toLinear([0.5, 1, 0, 0.3])).toEqual([srgbToLinear(0.5), srgbToLinear(1), 0, 0.3])
    const c = toColor([0.5, 0.5, 0.5, 1])
    expect(c.r).toBeCloseTo(0.214, 3)
  })
})
