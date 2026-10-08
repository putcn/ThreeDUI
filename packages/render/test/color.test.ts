import { describe, it, expect } from 'vitest'
import { attribute } from 'three/tsl'
import { srgbToLinear, srgbToLinearNode, toLinear, toColor } from '../src/color'
import { evalNode } from './fixtures/tsl-eval'

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
  it('srgbToLinearNode is srgbToLinear per channel, both sides of the linear segment, and never feeds pow a base ≤ 0', () => {
    const node = srgbToLinearNode(attribute('c', 'vec4').xyz)
    let worst = 0, minPowBase = Infinity
    const onPow = (base: readonly number[]) => { minPowBase = Math.min(minPowBase, ...base) }
    for (let i = 0; i <= 100; i++) {
      const c = [i / 100, 0.04045, 0.04045 + 1e-9]
      const got = evalNode(node, { c: [...c, 0] }, onPow)
      c.forEach((x, k) => { worst = Math.max(worst, Math.abs(got[k]! - srgbToLinear(x))) })
    }
    expect(worst).toBeLessThan(1e-12)
    expect(minPowBase).toBeGreaterThan(0)   // WGSL pow is exp2(y·log2 x)
  })
})
