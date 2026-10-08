import { describe, it, expect } from 'vitest'
import { Node } from '../src/node'
import { GlassUIError } from '../src/errors'
import { validateStyle } from '../src/style/schema'
import { resolveTextStyle } from '../src/style/text'
import { defaultTheme as theme, resolveColor } from '../src/style/theme'

describe('resolveTextStyle', () => {
  it('fills the defaults: system-ui 400 at the base size, a 1.3 line height in pt, no letter spacing, wrapping', () => {
    expect(resolveTextStyle(new Node('text'), theme, 'light')).toEqual({
      family: 'system-ui', size: 17, weight: 400, lineHeight: 22, letterSpacing: 0, align: 'left', wrap: true,
      color: resolveColor('label', theme, 'light'),
    })
  })

  it('reads lineHeight as a unitless multiplier of the font size and returns whole pt', () => {
    const n = new Node('text'); n.setStyle({ fontSize: 17, lineHeight: 1.4 })
    expect(resolveTextStyle(n, theme, 'light').lineHeight).toBe(24)   // 23.8
    n.setStyle({ fontSize: 'sm', lineHeight: 1 })
    expect(resolveTextStyle(n, theme, 'light')).toMatchObject({ size: 14, lineHeight: 14 })
  })

  it('resolves tokens from the effective style and includes maxLines only when set', () => {
    const n = new Node('text')
    n.setStyle({
      font: 'mono', fontSize: 'lg', fontWeight: 700, letterSpacing: 0.5, textAlign: 'center', color: 'accent', maxLines: 2, wrap: false,
      hover: { fontSize: 'xl', color: 'danger' },
    })
    n.setState({ hover: true })
    expect(resolveTextStyle(n, theme, 'dark')).toEqual({
      family: 'mono', size: 24, weight: 700, lineHeight: 31, letterSpacing: 0.5, align: 'center', maxLines: 2, wrap: false,
      color: resolveColor('danger', theme, 'dark'),
    })
    expect(resolveTextStyle(new Node('text'), theme, 'light')).not.toHaveProperty('maxLines')
  })

  it('throws a GlassUIError for unknown tokens', () => {
    const n = new Node('text'); n.setStyle({ fontSize: 'huge' })
    expect(() => resolveTextStyle(n, theme, 'light')).toThrow(GlassUIError)
    n.setStyle({ fontSize: 'sm', color: 'nope' })
    expect(() => resolveTextStyle(n, theme, 'light')).toThrow('[color] 未知颜色 token "nope"')
  })
})

describe('Style.lineHeight', () => {
  it('is a positive multiplier', () => {
    expect(validateStyle({ lineHeight: 1.3 }).lineHeight).toBe(1.3)
    expect(() => validateStyle({ lineHeight: 0 })).toThrow('[style.lineHeight]')
    expect(() => validateStyle({ hover: { lineHeight: -1 } })).toThrow('[style.hover.lineHeight]')
  })
})
