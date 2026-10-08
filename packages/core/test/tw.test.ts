import { describe, it, expect } from 'vitest'
import { parseTw } from '../src/style/tw'
import { GlassUIError } from '../src/errors'
import { defaultTheme as t } from '../src/style/theme'

describe('parseTw', () => {
  it('maps layout, spacing, radius and colour classes', () => {
    expect(parseTw('flex flex-row items-center justify-between gap-2 px-4 py-2 rounded-full bg-glass w-full', t)).toEqual({
      display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      gap: 8, paddingX: 16, paddingY: 8, radius: 'capsule', bg: 'glass', width: '100%',
    })
  })
  it('supports arbitrary values and typography', () => {
    expect(parseTw('w-[42] h-[50%] text-sm text-accent font-semibold opacity-80 text-center', t)).toEqual({
      width: 42, height: '50%', fontSize: 'sm', color: 'accent', fontWeight: 600, opacity: 0.8, textAlign: 'center',
    })
  })
  it('puts prefixed classes into state branches', () => {
    expect(parseTw('p-2 hover:opacity-90 active:p-1 focus:bg-accent disabled:opacity-40', t)).toEqual({
      padding: 8, hover: { opacity: 0.9 }, pressed: { padding: 4 }, focused: { bg: 'accent' }, disabled: { opacity: 0.4 },
    })
  })
  it('throws with suggestions for unknown classes', () => {
    expect(() => parseTw('flex-rwo', t, 'Box.tw')).toThrow('[Box.tw] 未知 class "flex-rwo"')
    expect(() => parseTw('flex-rwo', t, 'Box.tw')).toThrow('你可能想要：flex-row')
  })
  it('throws for unsupported or stacked prefixes', () => {
    expect(() => parseTw('dark:p-2', t)).toThrow('不支持的前缀 "dark"')
    expect(() => parseTw('hover:focus:p-2', t)).toThrow('不支持的前缀')
  })
  it('throws for a spacing index outside the scale', () => {
    expect(() => parseTw('p-99', t)).toThrow('[tw] spacing 索引 99 超出范围')
  })
  it('parses min/max sizes and gap-x/gap-y', () => {
    expect(parseTw('min-w-4 max-w-[50%] min-h-[42] max-h-2 gap-x-1 gap-y-3', t)).toEqual({
      minWidth: 16, maxWidth: '50%', minHeight: 42, maxHeight: 8, columnGap: 4, rowGap: 12,
    })
  })
  it('never resolves Object.prototype members as classes, keys or prefixes', () => {
    for (const cls of ['constructor', 'toString', '__proto__', 'constructor-2', 'text-constructor', 'bg-toString', 'hover:constructor']) {
      expect(() => parseTw(cls, t), cls).toThrow(GlassUIError)
      expect(() => parseTw(cls, t), cls).toThrow('未知 class')
    }
    expect(() => parseTw('constructor:p-2', t)).toThrow('[tw] 不支持的前缀 "constructor"')
  })
  it('rejects percentages on pt-only spacing keys but keeps them for insets and lengths', () => {
    expect(() => parseTw('p-[50%]', t)).toThrow('[tw] padding 不支持百分比，得到 "[50%]"')
    expect(() => parseTw('mx-[10%]', t)).toThrow('[tw] marginX 不支持百分比，得到 "[10%]"')
    expect(() => parseTw('gap-x-[50%]', t)).toThrow('[tw] columnGap 不支持百分比，得到 "[50%]"')
    expect(parseTw('top-[50%] inset-[10%] h-[25%]', t)).toEqual({ top: '50%', inset: '10%', height: '25%' })
  })
  it('accepts only theme tokens or bracketed literals after text- and bg-', () => {
    expect(parseTw('text-[#ff0000] text-base bg-danger', t)).toEqual({ color: '#ff0000', fontSize: 'base', bg: 'danger' })
    expect(parseTw('bg-[rgba(0,0,0,0.5)]', t)).toEqual({ bg: 'rgba(0,0,0,0.5)' })
    expect(() => parseTw('text-sml', t)).toThrow('[tw] 未知 class "text-sml"')
    expect(() => parseTw('text-sml', t)).toThrow('你可能想要：text-sm')
    expect(() => parseTw('text-acent', t)).toThrow('你可能想要：text-accent')
    expect(() => parseTw('bg-glas', t)).toThrow('你可能想要：bg-glass')
  })
  it('rejects unclosed or empty brackets and checks the prefix before the class', () => {
    expect(() => parseTw('text-[#fff', t)).toThrow('[tw] 非法任意值 "[#fff"')
    expect(() => parseTw('text-[]', t)).toThrow('[tw] 非法任意值 "[]"')
    expect(() => parseTw('bg-[', t)).toThrow('[tw] 非法任意值 "["')
    expect(() => parseTw('w-[42', t)).toThrow('[tw] 非法任意值 "[42"')
    expect(() => parseTw('dark:flex-rwo', t)).toThrow('不支持的前缀 "dark"')
  })
  it('validates the assembled style against the schema', () => {
    expect(() => parseTw(`w-[${'9'.repeat(400)}]`, t, 'Box.tw')).toThrow('[Box.tw.width] 非法取值 "Infinity"')
  })
})
