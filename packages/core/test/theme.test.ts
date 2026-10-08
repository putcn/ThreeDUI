import { describe, it, expect } from 'vitest'
import { defaultTheme, resolveColor, resolveRadius, resolveFontSize } from '../src/style/theme'

describe('theme', () => {
  it('resolves semantic colour tokens per scheme', () => {
    const light = resolveColor('label', defaultTheme, 'light')
    const dark = resolveColor('label', defaultTheme, 'dark')
    expect(light[0]).toBeLessThan(0.2)   // dark text on light
    expect(dark[0]).toBeGreaterThan(0.8) // light text on dark
  })
  it('parses hex and rgba literals', () => {
    expect(resolveColor('#6b63f5', defaultTheme, 'light')).toEqual([0x6b / 255, 0x63 / 255, 0xf5 / 255, 1])
    expect(resolveColor('#fff8', defaultTheme, 'light')).toEqual([1, 1, 1, 0x88 / 255])
    expect(resolveColor('rgba(255, 0, 0, 0.5)', defaultTheme, 'light')).toEqual([1, 0, 0, 0.5])
  })
  it('throws a GlassUIError for unknown tokens with a suggestion', () => {
    expect(() => resolveColor('acent', defaultTheme, 'light')).toThrow('你可能想要：accent')
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
})
