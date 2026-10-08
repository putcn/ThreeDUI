import { describe, it, expect } from 'vitest'
import { parseTw } from '../src/style/tw'
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
})
