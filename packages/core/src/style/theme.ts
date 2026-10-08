import { GlassUIError } from '../errors'
import type { Style } from './schema'

export type ColorScheme = 'light' | 'dark'
/** sRGB-encoded floats in 0..1 (not linear); conversion to linear happens in the renderer. */
export type RGBA = [number, number, number, number]

/** Own-property lookup so user tokens never resolve to Object.prototype members. */
function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

export interface Theme {
  colors: { light: Record<string, string>; dark: Record<string, string> }
  spacing: number[]
  radius: Record<string, number>
  fontSize: Record<string, number>
  springs: Record<'snappy' | 'smooth' | 'bouncy', { stiffness: number; damping: number; mass: number }>
  glass: { thickness: number; fillet: number; filletBottom: number; scatter: number; lift: number; edgeGlow: number; ior: number; dispersion: number; roughness: number }
  metrics: { controlPadding: number; icon: number; iconGap: number; groupGap: number; checkbox: number; checkboxRadius: number; switchWidth: number; switchHeight: number; knob: number; knobMargin: number }
}

export const defaultTheme: Theme = {
  colors: {
    light: { accent: '#6b63f5', label: '#1c1c22', secondaryLabel: '#6a6a78', tertiaryLabel: '#8a8a98', fill: '#ffffff', separator: '#00000014', danger: '#ff3b30', success: '#34c759' },
    dark: { accent: '#8a83ff', label: '#f2f2f7', secondaryLabel: '#aeaeb8', tertiaryLabel: '#8e8e98', fill: '#1c1c22', separator: '#ffffff1f', danger: '#ff453a', success: '#30d158' },
  },
  spacing: [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96],
  radius: { none: 0, sm: 8, md: 12, lg: 16, xl: 24, '2xl': 32 },
  fontSize: { xs: 12, sm: 14, base: 17, lg: 20, xl: 24, '2xl': 30, '3xl': 36, '4xl': 46 },
  springs: {
    snappy: { stiffness: 400, damping: 30, mass: 1 },
    smooth: { stiffness: 170, damping: 26, mass: 1 },
    bouncy: { stiffness: 300, damping: 15, mass: 1 },
  },
  glass: { thickness: 16, fillet: 5, filletBottom: 3, scatter: 0.05, lift: 0.1, edgeGlow: 0.8, ior: 1.5, dispersion: 0.8, roughness: 0.06 },
  metrics: { controlPadding: 26, icon: 28, iconGap: 14, groupGap: 12, checkbox: 44, checkboxRadius: 12, switchWidth: 136, switchHeight: 62, knob: 48, knobMargin: 7 },
}

function hexToRgba(hex: string): RGBA | null {
  const h = hex.slice(1)
  const n = h.length
  if (![3, 4, 6, 8].includes(n) || !/^[0-9a-f]+$/i.test(h)) return null
  const full = n <= 4 ? [...h].map(c => c + c).join('') : h
  const v = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255
  return [v(0), v(2), v(4), full.length === 8 ? v(6) : 1]
}

export function resolveColor(token: string, theme: Theme, scheme: ColorScheme): RGBA {
  if (token.startsWith('#')) {
    const c = hexToRgba(token)
    if (!c) throw new GlassUIError('color', `非法颜色 "${token}"`)
    return c
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(token)
  if (m) {
    const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const a = m[4] === undefined ? 1 : Number(m[4])
    const inRange = (x: number, max: number) => x >= 0 && x <= max // false for NaN
    if (![r, g, b].every(x => inRange(x, 255)) || !inRange(a, 1)) throw new GlassUIError('color', `非法颜色 "${token}"`)
    return [r / 255, g / 255, b / 255, a]
  }
  const table = theme.colors[scheme]
  const hex = own(table, token)
  if (hex === undefined) throw new GlassUIError('color', `未知颜色 token "${token}"`, { allowed: Object.keys(table), got: token })
  return resolveColor(hex, theme, scheme)
}

export function resolveRadius(v: Style['radius'], theme: Theme, width: number, height: number, parentRadius = 0, inset = 0): number {
  if (v === undefined) return 0
  if (typeof v === 'number') return v
  if (v === 'capsule') return Math.min(width, height) / 2
  if (v === 'concentric') return Math.max(parentRadius - inset, 0)
  const r = own(theme.radius, v)
  if (r === undefined) throw new GlassUIError('style.radius', `未知 radius token "${v}"`, { allowed: [...Object.keys(theme.radius), 'capsule', 'concentric'], got: v })
  return r
}

export function resolveFontSize(v: Style['fontSize'], theme: Theme): number {
  if (v === undefined) return theme.fontSize.base!
  if (typeof v === 'number') return v
  const s = own(theme.fontSize, v)
  if (s === undefined) throw new GlassUIError('style.fontSize', `未知 fontSize token "${v}"`, { allowed: Object.keys(theme.fontSize), got: v })
  return s
}
