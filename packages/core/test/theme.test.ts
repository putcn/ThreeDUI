import { describe, it, expect } from 'vitest'
import { defaultTheme, rampColor, resolveColor, resolveRadius, resolveFontSize, type RGBA } from '../src/style/theme'
import { GlassUIError } from '../src/errors'

describe('theme', () => {
  it('resolves semantic colour tokens per scheme', () => {
    const light = resolveColor('label', defaultTheme, 'light')
    const dark = resolveColor('label', defaultTheme, 'dark')
    expect(light[0]).toBeLessThan(0.2)   // dark text on light
    expect(dark[0]).toBeGreaterThan(0.8) // light text on dark
  })
  it('has a translucent black scrim (a dialog backdrop), darker in dark mode', () => {
    expect(resolveColor('scrim', defaultTheme, 'light')).toEqual([0, 0, 0, 0x47 / 255])
    expect(resolveColor('scrim', defaultTheme, 'dark')).toEqual([0, 0, 0, 0x80 / 255])
  })
  it('parses hex and rgba literals', () => {
    expect(resolveColor('#6b63f5', defaultTheme, 'light')).toEqual([0x6b / 255, 0x63 / 255, 0xf5 / 255, 1])
    expect(resolveColor('#fff8', defaultTheme, 'light')).toEqual([1, 1, 1, 0x88 / 255])
    expect(resolveColor('rgba(255, 0, 0, 0.5)', defaultTheme, 'light')).toEqual([1, 0, 0, 0.5])
  })
  it('throws a GlassUIError for unknown tokens with a suggestion', () => {
    expect(() => resolveColor('acent', defaultTheme, 'light')).toThrow('你可能想要：accent')
  })
  it('rejects rgba() channels outside 0–255 and alpha outside 0–1', () => {
    expect(() => resolveColor('rgba(300, 0, 0, 1)', defaultTheme, 'light')).toThrow(GlassUIError)
    expect(() => resolveColor('rgba(300, 0, 0, 1)', defaultTheme, 'light')).toThrow('[color] 非法颜色 "rgba(300, 0, 0, 1)"')
    expect(() => resolveColor('rgba(0, 0, 0, 1.5)', defaultTheme, 'light')).toThrow('[color] 非法颜色 "rgba(0, 0, 0, 1.5)"')
    expect(() => resolveColor('rgb(1.2.3, 0, 0)', defaultTheme, 'light')).toThrow('[color] 非法颜色')
  })
  it('does not resolve Object.prototype keys as tokens', () => {
    expect(() => resolveColor('constructor', defaultTheme, 'light')).toThrow(GlassUIError)
    expect(() => resolveColor('constructor', defaultTheme, 'light')).toThrow('允许值：accent')
    expect(() => resolveRadius('toString', defaultTheme, 200, 80)).toThrow(GlassUIError)
    expect(() => resolveRadius('toString', defaultTheme, 200, 80)).toThrow('[style.radius] 未知 radius token "toString"')
    expect(() => resolveFontSize('valueOf', defaultTheme)).toThrow(GlassUIError)
    expect(() => resolveFontSize('valueOf', defaultTheme)).toThrow('[style.fontSize] 未知 fontSize token "valueOf"')
  })
  it('resolves radius keywords', () => {
    expect(resolveRadius('capsule', defaultTheme, 200, 80)).toBe(40)
    expect(resolveRadius('concentric', defaultTheme, 200, 80, 24, 8)).toBe(16)
    expect(resolveRadius('lg', defaultTheme, 200, 80)).toBe(defaultTheme.radius.lg)
    expect(resolveRadius(7, defaultTheme, 200, 80)).toBe(7)
  })
  it('resolves font-size tokens and numbers', () => {
    expect(resolveFontSize('base', defaultTheme)).toBe(defaultTheme.fontSize.base)
    expect(resolveFontSize(17, defaultTheme)).toBe(17)
  })
  it('ships the spec control metrics and spring presets', () => {
    expect(defaultTheme.metrics).toMatchObject({ controlPadding: 26, icon: 28, iconGap: 14, groupGap: 12, checkbox: 44, checkboxRadius: 12, switchWidth: 136, switchHeight: 62, knob: 48, knobMargin: 7 })
    expect(Object.keys(defaultTheme.springs)).toEqual(['snappy', 'smooth', 'bouncy'])
  })
  it('ships a default for every glass parameter the theme owns', () => {
    expect(defaultTheme.glass).toEqual({
      thicknessRatio: 0.2, filletRatio: 0.06, filletBottomRatio: 0.04, scatter: 0.05, lift: 0.1, edgeGlow: 0.8, ior: 1.5, dispersion: 0.8, roughness: 0.06,
      envIntensity: 1, specularIntensity: 1, innerGlow: 0, adaptive: true, variant: 'regular',
    })
  })
  it('rampColor: evenly spaced stops mixed in sRGB between the two nearest; t clamped to 0..1 (Task 9O)', () => {
    const ramp: RGBA[] = [[0, 0.8, 0.2, 1], [1, 0.6, 0.4, 1], [1, 0.2, 0.2, 0.5]]
    expect(rampColor(ramp, 0)).toEqual(ramp[0]); expect(rampColor(ramp, 1)).toEqual(ramp[2]); expect(rampColor(ramp, 0.5)).toEqual(ramp[1])
    const quarter = rampColor(ramp, 0.25)
    for (const [i, want] of [0.5, 0.7, 0.3, 1].entries()) expect(quarter[i]).toBeCloseTo(want, 12)
    const late = rampColor(ramp, 0.75)
    for (const [i, want] of [1, 0.4, 0.3, 0.75].entries()) expect(late[i]).toBeCloseTo(want, 12)
    expect(rampColor(ramp, -2)).toEqual(ramp[0]); expect(rampColor(ramp, 7)).toEqual(ramp[2])
    expect(rampColor([[0, 0, 0, 1], [1, 1, 1, 1]], 0.3).map(v => +v.toFixed(12))).toEqual([0.3, 0.3, 0.3, 1])
    // a fresh array: the caller may keep or change it
    const got = rampColor(ramp, 0); got[0] = 9; expect(ramp[0]![0]).toBe(0)
  })
  it('rampColor guards: a NaN t is 0, ±Infinity clamped; an empty ramp throws a GlassUIError; one colour is itself (Task 9O fix)', () => {
    const ramp: RGBA[] = [[0, 0, 0, 1], [1, 1, 1, 1]]
    expect(rampColor(ramp, NaN)).toEqual(ramp[0]); expect(rampColor(ramp, Infinity)).toEqual(ramp[1]); expect(rampColor(ramp, -Infinity)).toEqual(ramp[0])
    expect(() => rampColor([], 0.5)).toThrow(GlassUIError); expect(() => rampColor([], 0.5)).toThrow(/^\[rampColor\] .*色带/)
    expect(rampColor([[0.2, 0.4, 0.6, 1]], 0.7)).toEqual([0.2, 0.4, 0.6, 1])
  })
})
