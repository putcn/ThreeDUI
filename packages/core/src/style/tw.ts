import { GlassUIError } from '../errors'
import { validateStyle, type Style } from './schema'
import type { Theme } from './theme'

type Base = Omit<Style, 'hover' | 'pressed' | 'focused' | 'disabled'>
type Branch = 'hover' | 'pressed' | 'focused' | 'disabled'
const PREFIX: Record<string, Branch> = { hover: 'hover', active: 'pressed', focus: 'focused', disabled: 'disabled' }

/** Own-property lookup so class names never resolve to Object.prototype members. */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

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
/** SPACING targets typed as Length in the schema; the others (padding*, margin*, gap*) are pt-only. */
const SPACING_PERCENT: ReadonlySet<keyof Base> = new Set<keyof Base>(['inset', 'top', 'right', 'bottom', 'left'])
const LENGTH: Record<string, keyof Base> = { w: 'width', h: 'height', 'min-w': 'minWidth', 'max-w': 'maxWidth', 'min-h': 'minHeight', 'max-h': 'maxHeight' }

function known(theme: Theme): string[] {
  const colours = Object.keys(theme.colors.light)
  return [
    ...Object.keys(ENUMS), ...Object.keys(SPACING).map(k => `${k}-N`), ...Object.keys(LENGTH).map(k => `${k}-N`), 'font-{weight}', 'opacity-N', 'scale-N', 'scale-[N]',
    ...Object.keys(theme.fontSize).map(k => `text-${k}`), ...colours.map(c => `text-${c}`), ...colours.map(c => `bg-${c}`), 'text-[#hex]', 'bg-[#hex]',
  ]
}

/** Contents of a `[...]` literal, undefined when `raw` is not bracketed; throws on an unclosed or empty bracket. */
function bracketed(raw: string, scope: string, hint: string): string | undefined {
  if (!raw.startsWith('[')) return undefined
  const v = /^\[(.+)\]$/.exec(raw)?.[1]
  if (v === undefined) throw new GlassUIError(scope, `非法任意值 "${raw}"（${hint}）`)
  return v
}

function parseValue(raw: string, theme: Theme, scope: string, prop: keyof Base, percent: boolean): number | `${number}%` {
  const hint = percent ? '允许 [42] 或 [50%]' : '允许 [42]'
  const v = bracketed(raw, scope, hint)
  if (v !== undefined) {
    if (/^-?\d+(\.\d+)?%$/.test(v)) {
      if (!percent) throw new GlassUIError(scope, `${prop} 不支持百分比，得到 "${raw}"`)
      return v as `${number}%`
    }
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
    throw new GlassUIError(scope, `非法任意值 "${raw}"（${hint}）`)
  }
  if (!/^\d+$/.test(raw)) throw new GlassUIError(scope, `非法间距 "${raw}"`)
  const idx = Number(raw)
  const pt = theme.spacing[idx]
  if (pt === undefined) throw new GlassUIError(scope, `spacing 索引 ${idx} 超出范围（0–${theme.spacing.length - 1}）`)
  return pt
}

/** `scale-N` is a percentage (`scale-95` → 0.95), `scale-[N]` a factor (`scale-[1.03]`); either must be positive. */
function parseScale(raw: string, scope: string): number {
  const hint = '写成 scale-95 或 scale-[1.03]'
  const v = bracketed(raw, scope, hint)
  const n = v === undefined ? Number(raw) / 100 : /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN
  if (!(n > 0 && Number.isFinite(n))) throw new GlassUIError(scope, `scale 必须为正数（${hint}），得到 "${raw}"`)
  return n
}

function one(cls: string, theme: Theme, scope: string): Partial<Base> {
  const e = own(ENUMS, cls); if (e) return e
  // Key may carry one hyphenated segment (gap-x, min-w); a value starting with `[` is validated by bracketed().
  const m = /^([a-z]+(?:-[a-z]+)?)-(\[.*|\d+)$/.exec(cls)
  if (m) {
    const [, key, raw] = m as unknown as [string, string, string]
    const sp = own(SPACING, key)
    if (sp) return { [sp]: parseValue(raw, theme, scope, sp, SPACING_PERCENT.has(sp)) }
    const len = own(LENGTH, key)
    if (len) return { [len]: parseValue(raw, theme, scope, len, true) }
    if (key === 'opacity') { const n = Number(raw); if (n < 0 || n > 100 || raw.startsWith('[')) throw new GlassUIError(scope, `opacity 取值 0–100，得到 "${raw}"`); return { opacity: n / 100 } }
    if (key === 'scale') return { scale: parseScale(raw, scope) }
    if (key === 'font') { const n = Number(raw); if (n % 100 || n < 100 || n > 900) throw new GlassUIError(scope, `font 字重 100–900，得到 "${raw}"`); return { fontWeight: n } }
  }
  // text-/bg- take a theme token or a bracketed literal; bg-glass|glass-clear|none are ENUMS.
  const colourHint = '颜色写成 [#hex] 或 [rgba(…)]'
  const t = /^text-(.+)$/.exec(cls)
  if (t) {
    const v = t[1]!
    if (Object.hasOwn(theme.fontSize, v)) return { fontSize: v }
    const lit = bracketed(v, scope, colourHint)
    if (lit !== undefined) return { color: lit }
    if (Object.hasOwn(theme.colors.light, v)) return { color: v }
  }
  const b = /^bg-(.+)$/.exec(cls)
  if (b) {
    const v = b[1]!
    const lit = bracketed(v, scope, colourHint)
    if (lit !== undefined) return { bg: lit }
    if (Object.hasOwn(theme.colors.light, v)) return { bg: v }
  }
  throw new GlassUIError(scope, `未知 class "${cls}"`, { allowed: known(theme), got: cls })
}

export function parseTw(tw: string, theme: Theme, scope = 'tw'): Style {
  const out: Style = {}
  for (const token of tw.trim().split(/\s+/).filter(Boolean)) {
    const parts = token.split(':')
    if (parts.length > 2) throw new GlassUIError(scope, `不支持的前缀 "${parts.slice(0, -1).join(':')}"（只允许一个：hover/focus/active/disabled）`)
    let branch: Branch | undefined
    if (parts.length === 2) {
      branch = own(PREFIX, parts[0]!)
      if (!branch) throw new GlassUIError(scope, `不支持的前缀 "${parts[0]}"`, { allowed: Object.keys(PREFIX), got: parts[0]! })
    }
    const style = one(parts[parts.length - 1]!, theme, scope)
    if (branch) out[branch] = { ...(out[branch] ?? {}), ...style }
    else Object.assign(out, style)
  }
  // Backstop: never hand back a Style the schema would reject (e.g. a non-finite arbitrary value).
  return validateStyle(out, scope)
}
