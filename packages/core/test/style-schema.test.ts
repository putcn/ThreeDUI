import { describe, it, expect } from 'vitest'
import { validateStyle, STYLE_KEYS } from '../src/style/schema'
import type { Length } from '../src/style/schema'

describe('validateStyle', () => {
  it('accepts a valid flex style with tokens and state branches', () => {
    const s = validateStyle({
      flexDirection: 'row', gap: 8, padding: 12, width: '100%', bg: 'glass', radius: 'capsule',
      hover: { opacity: 0.9 }, transition: { opacity: 'snappy' },
    })
    expect(s.flexDirection).toBe('row')
    expect(s.hover?.opacity).toBe(0.9)
  })
  it('rejects unknown keys with a suggestion', () => {
    expect(() => validateStyle({ flexDirecton: 'row' }, 'Box.style'))
      .toThrow('[Box.style] 未知键 "flexDirecton"')
    expect(() => validateStyle({ flexDirecton: 'row' }, 'Box.style'))
      .toThrow('你可能想要：flexDirection')
  })
  it('rejects wrong enum values listing the allowed ones', () => {
    expect(() => validateStyle({ justifyContent: 'middle' }))
      .toThrow(/\[style\.justifyContent\].*允许值：flex-start, center, flex-end, space-between, space-around, space-evenly/)
  })
  it('rejects bad length strings', () => {
    expect(() => validateStyle({ width: '10px' })).toThrow('[style.width]')
  })
  it('exports the key list for tooling', () => {
    expect(STYLE_KEYS).toContain('padding')
    expect(STYLE_KEYS).toContain('glass')
  })
})

describe('validateStyle: nested keys, nested values and union errors', () => {
  const msg = (fn: () => unknown): string => {
    try { fn() } catch (e) { return (e as Error).message }
    throw new Error('expected validateStyle to throw')
  }

  it('rejects unknown keys inside glass.glow instead of silently dropping them', () => {
    expect(() => validateStyle({ glass: { glow: { color: 'white', strength: 1, colour: 'red' } } }))
      .toThrow('[style.glass.glow] 未知键 "colour"。允许值：color, strength, split。你可能想要：color')
  })

  it('scopes nested unknown keys to their object and lists that object\'s own keys', () => {
    expect(() => validateStyle({ glass: { thicknes: 2 } }))
      .toThrow(/^\[style\.glass\] 未知键 "thicknes"。允许值：variant, thickness, .*, cornerExponent。你可能想要：thickness$/)
    const m = msg(() => validateStyle({ hover: { flexDirecton: 'row' } }, 'Box.style'))
    expect(m).toMatch(/^\[Box\.style\.hover\] 未知键 "flexDirecton"。允许值：display, .*, transition。你可能想要：flexDirection$/)
    expect(m).not.toMatch(/pressed|focused|disabled/)
  })

  it('resolves the nested value of an enum error so it can be suggested', () => {
    expect(() => validateStyle({ hover: { justifyContent: 'centre' } }))
      .toThrow(/^\[style\.hover\.justifyContent\] 非法取值 "centre"。允许值：flex-start, center, .*。你可能想要：center$/)
  })

  it('names the allowed forms for union-typed keys', () => {
    expect(() => validateStyle({ bg: 5 }))
      .toThrow('[style.bg] 非法取值 "5"。允许值：glass, glass-clear, none, <颜色 token 或 #hex>')
    expect(() => validateStyle({ radius: true }))
      .toThrow('[style.radius] 非法取值 "true"。允许值：number(pt), capsule, concentric, <radius token>')
    expect(() => validateStyle({ width: '10px' }))
      .toThrow('[style.width] 非法取值 "10px"。允许值：number(pt), "N%", auto')
    expect(() => validateStyle({ hover: { inset: true } }))
      .toThrow('[style.hover.inset] 非法取值 "true"。允许值：number(pt), "N%", auto')
    expect(() => validateStyle({ fontSize: true }))
      .toThrow('[style.fontSize] 非法取值 "true"。允许值：number(pt), <fontSize token>')
    const transitionAllowed = '允许值：snappy, smooth, bouncy, {stiffness,damping,mass?}, {response,dampingFraction}, {duration,easing}'
    expect(() => validateStyle({ transition: { opacity: 'snapy' } }))
      .toThrow(`[style.transition.opacity] 非法取值 "snapy"。${transitionAllowed}。你可能想要：snappy`)
    expect(() => validateStyle({ transition: { opacity: { stiffness: 1 } } }))
      .toThrow(`[style.transition.opacity] 非法取值 "{"stiffness":1}"。${transitionAllowed}`)
  })

  it('restricts transition keys to animatable properties', () => {
    const s = validateStyle({ transition: { opacity: 'snappy', bg: 'smooth', tilt: { response: 0.3, dampingFraction: 0.8 } } })
    expect(s.transition?.bg).toBe('smooth')
    expect(() => validateStyle({ transition: { opacityy: 'snappy' } }))
      .toThrow('[style.transition] 未知键 "opacityy"。允许值：x, y, width, height, scale, opacity, color, bg, radius, glass, elevation, tilt。你可能想要：opacity')
  })

  it('reports an unknown key before a missing required field it was meant to be', () => {
    expect(() => validateStyle({ border: { width: 1, colr: 'red' } }))
      .toThrow('[style.border] 未知键 "colr"。允许值：width, color。你可能想要：color')
  })

  it('never lets value formatting throw, and truncates long values', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => validateStyle({ transition: { opacity: cyclic } }))
      .toThrow('[style.transition.opacity] 非法取值 "[object Object]"')
    expect(() => validateStyle({ width: 'x'.repeat(200) }))
      .toThrow(`[style.width] 非法取值 "${'x'.repeat(79)}…"。`)
  })
})

describe('Length', () => {
  it('is typed number | `${number}%` | auto and keeps percent strings at runtime', () => {
    const ok: Length[] = [12, '50%', '-2.5%', 'auto']
    // @ts-expect-error -- an arbitrary string is not a Length
    const bad: Length = '10px'
    void ok; void bad
    expect(validateStyle({ width: '50%' }).width).toBe('50%')
    expect(validateStyle({ height: '-2.5%', flexBasis: 'auto', minWidth: 0 }))
      .toEqual({ height: '-2.5%', flexBasis: 'auto', minWidth: 0 })
    for (const width of ['10px', '50 %', '%', '.5%', '1e2%', 'Infinity%']) {
      expect(() => validateStyle({ width })).toThrow('[style.width]')
    }
  })
})
