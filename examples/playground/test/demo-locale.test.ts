import { describe, expect, it } from 'vitest'
import { resolveDemoLocale } from '../src/demo-locale'

describe('demo language', () => {
  it('uses the URL choice across demos and gallery before a saved preference', () => {
    expect(resolveDemoLocale('?scene=gallery&lang=en', 'zh', 'zh-CN')).toBe('en')
    expect(resolveDemoLocale('?lang=zh', 'en', 'en-US')).toBe('zh')
  })

  it('falls back through saved preference and browser language', () => {
    expect(resolveDemoLocale('', 'zh', 'en-US')).toBe('zh')
    expect(resolveDemoLocale('?lang=other', null, 'zh-Hans-CN')).toBe('zh')
    expect(resolveDemoLocale('', null, 'en-US')).toBe('en')
  })
})
