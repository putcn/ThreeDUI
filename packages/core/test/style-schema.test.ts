import { describe, it, expect } from 'vitest'
import { validateStyle, STYLE_KEYS } from '../src/style/schema'

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
