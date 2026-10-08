import { GlassUIError } from '../errors'
import type { Style } from './schema'
import type { Theme } from './theme'

type Base = Omit<Style, 'hover' | 'pressed' | 'focused' | 'disabled'>
const PREFIX: Record<string, 'hover' | 'pressed' | 'focused' | 'disabled'> = { hover: 'hover', active: 'pressed', focus: 'focused', disabled: 'disabled' }

const ENUMS: Record<string, Partial<Base>> = {
  flex: { display: 'flex' }, hidden: { display: 'none' }, absolute: { position: 'absolute' }, relative: { position: 'relative' },
  'flex-row': { flexDirection: 'row' }, 'flex-col': { flexDirection: 'column' },
  'flex-row-reverse': { flexDirection: 'row-reverse' }, 'flex-col-reverse': { flexDirection: 'column-reverse' },
  'flex-wrap': { flexWrap: 'wrap' }, 'flex-nowrap': { flexWrap: 'nowrap' }, 'flex-1': { flex: 1 }, grow: { flexGrow: 1 }, 'shrink-0': { flexShrink: 0 },
  'items-start': { alignItems: 'flex-start' }, 'items-center': { alignItems: 'center' }, 'items-end': { alignItems: 'flex-end' }, 'items-stretch': { alignItems: 'stretch' }, 'items-baseline': { alignItems: 'baseline' },
  'justify-start': { justifyContent: 'flex-start' }, 'justify-center': { justifyContent: 'center' }, 'justify-end': { justifyContent: 'flex-end' }, 'justify-between': { justifyContent: 'space-between' }, 'justify-around': { justifyContent: 'space-around' }, 'justify-evenly': { justifyContent: 'space-evenly' },
  'self-start': { alignSelf: 'flex-start' }, 'self-center': { alignSelf: 'center' }, 'self-end': { alignSelf: 'flex-end' }, 'self-stretch': { alignSelf: 'stretch' },
  'rounded-none': { radius: 0 }, 'rounded-sm': { radius: 'sm' }, 'rounded-md': { radius: 'md' }, 'rounded-lg': { radius: 'lg' }, 'rounded-xl': { radius: 'xl' }, 'rounded-2xl': { radius: '2xl' }, 'rounded-full': { radius: 'capsule' },
  'bg-glass': { bg: 'glass' }, 'bg-glass-clear': { bg: 'glass-clear' }, 'bg-none': { bg: 'none' },
  'text-left': { textAlign: 'left' }, 'text-center': { textAlign: 'center' }, 'text-right': { textAlign: 'right' },
  'font-medium': { fontWeight: 500 }, 'font-semibold': { fontWeight: 600 }, 'font-bold': { fontWeight: 700 },
  'overflow-hidden': { overflow: 'hidden' }, 'overflow-scroll': { overflow: 'scroll' }, 'overflow-visible': { overflow: 'visible' },
  'shadow-sm': { shadow: 'sm' }, 'shadow-md': { shadow: 'md' }, 'shadow-lg': { shadow: 'lg' },
  'w-full': { width: '100%' }, 'w-auto': { width: 'auto' }, 'h-full': { height: '100%' }, 'h-auto': { height: 'auto' },
}
const SPACING: Record<string, keyof Base> = {
  p: 'padding', px: 'paddingX', py: 'paddingY', pt: 'paddingTop', pr: 'paddingRight', pb: 'paddingBottom', pl: 'paddingLeft',
  m: 'margin', mx: 'marginX', my: 'marginY', mt: 'marginTop', mr: 'marginRight', mb: 'marginBottom', ml: 'marginLeft',
  gap: 'gap', 'gap-x': 'columnGap', 'gap-y': 'rowGap', inset: 'inset', top: 'top', right: 'right', bottom: 'bottom', left: 'left',
}
const LENGTH: Record<string, keyof Base> = { w: 'width', h: 'height', 'min-w': 'minWidth', 'max-w': 'maxWidth', 'min-h': 'minHeight', 'max-h': 'maxHeight' }

function known(theme: Theme): string[] {
  return [...Object.keys(ENUMS), ...Object.keys(SPACING).map(k => `${k}-N`), ...Object.keys(LENGTH).map(k => `${k}-N`), 'text-{size|color}', 'bg-{token}', 'font-{weight}', 'opacity-N', ...Object.keys(theme.fontSize).map(k => `text-${k}`)]
}

function parseValue(raw: string, theme: Theme, scope: string): number | `${number}%` {
  const arb = /^\[(.+)\]$/.exec(raw)
  if (arb) {
    const v = arb[1]!
    if (/^-?\d+(\.\d+)?%$/.test(v)) return v as `${number}%`
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
    throw new GlassUIError(scope, `非法任意值 "${raw}"（允许 [42] 或 [50%]）`)
  }
  if (!/^\d+$/.test(raw)) throw new GlassUIError(scope, `非法间距 "${raw}"`)
  const idx = Number(raw)
  const pt = theme.spacing[idx]
  if (pt === undefined) throw new GlassUIError(scope, `spacing 索引 ${idx} 超出范围（0–${theme.spacing.length - 1}）`)
  return pt
}

function one(cls: string, theme: Theme, scope: string): Partial<Base> {
  const e = ENUMS[cls]; if (e) return e
  const m = /^([a-z]+(?:-[xy])?)-(\[.+\]|\d+)$/.exec(cls)
  if (m) {
    const [, key, raw] = m as unknown as [string, string, string]
    if (key in SPACING) return { [SPACING[key]!]: parseValue(raw, theme, scope) }
    if (key in LENGTH) return { [LENGTH[key]!]: parseValue(raw, theme, scope) }
    if (key === 'opacity') { const n = Number(raw); if (n < 0 || n > 100 || raw.startsWith('[')) throw new GlassUIError(scope, `opacity 取值 0–100，得到 "${raw}"`); return { opacity: n / 100 } }
    if (key === 'font') { const n = Number(raw); if (n % 100 || n < 100 || n > 900) throw new GlassUIError(scope, `font 字重 100–900，得到 "${raw}"`); return { fontWeight: n } }
  }
  const t = /^text-(.+)$/.exec(cls)
  if (t) { const v = t[1]!; if (v in theme.fontSize) return { fontSize: v }; return { color: v.startsWith('[') ? v.slice(1, -1) : v } }
  const b = /^bg-(.+)$/.exec(cls)
  if (b) { const v = b[1]!; return { bg: v.startsWith('[') ? v.slice(1, -1) : v } }
  throw new GlassUIError(scope, `未知 class "${cls}"`, { allowed: known(theme), got: cls })
}

export function parseTw(tw: string, theme: Theme, scope = 'tw'): Style {
  const out: Style = {}
  for (const token of tw.trim().split(/\s+/).filter(Boolean)) {
    const parts = token.split(':')
    if (parts.length > 2) throw new GlassUIError(scope, `不支持的前缀 "${parts.slice(0, -1).join(':')}"（只允许一个：hover/focus/active/disabled）`)
    const cls = parts[parts.length - 1]!
    const style = one(cls, theme, scope)
    if (parts.length === 2) {
      const branch = PREFIX[parts[0]!]
      if (!branch) throw new GlassUIError(scope, `不支持的前缀 "${parts[0]}"`, { allowed: Object.keys(PREFIX), got: parts[0]! })
      out[branch] = { ...(out[branch] ?? {}), ...style }
    } else Object.assign(out, style)
  }
  return out
}
