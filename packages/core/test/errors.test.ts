import { describe, it, expect } from 'vitest'
import { GlassUIError, suggest } from '../src/errors'

describe('suggest', () => {
  it('returns the nearest candidate within distance 2', () => {
    expect(suggest('flexDirecton', ['flexDirection', 'alignItems'])).toBe('flexDirection')
  })
  it('returns null when nothing is close', () => {
    expect(suggest('banana', ['flexDirection'])).toBeNull()
  })
})

describe('GlassUIError', () => {
  it('formats scope, reason, allowed values and a suggestion', () => {
    const e = new GlassUIError('Button.variant', '未知取值 "glas"', { allowed: ['glass', 'filled'], got: 'glas' })
    expect(e.message).toBe('[Button.variant] 未知取值 "glas"。允许值：glass, filled。你可能想要：glass')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('GlassUIError')
  })
  it('omits the suggestion when there is no near miss', () => {
    const e = new GlassUIError('Box.style', '未知键 "zzz"', { allowed: ['padding'], got: 'zzz' })
    expect(e.message).toBe('[Box.style] 未知键 "zzz"。允许值：padding')
  })
})
