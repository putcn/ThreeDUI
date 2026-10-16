import { GlassUIError, resolveColor, type ColorScheme, type RGBA, type Theme } from '@glassui/core'

/**
 * `v` (a colour token, `#hex` or `rgba(…)`) resolved against `theme` / `scheme`. A bad one throws `[scope] …` at once,
 * naming the component's prop: left to the renderer, an unknown token would only fail the Surface's next layout.
 */
export function colorOf(scope: string, v: string, theme: Theme, scheme: ColorScheme): RGBA {
  try { return resolveColor(v, theme, scheme) } catch {
    if (v.startsWith('#') || /^rgba?\(/.test(v)) throw new GlassUIError(scope, `非法颜色 "${v}"（写成 #rgb、#rrggbb、#rrggbbaa 或 rgba(r, g, b, a)）`)
    throw new GlassUIError(scope, `未知颜色 token "${v}"`, { allowed: Object.keys(theme.colors[scheme]), got: v })
  }
}

/** `[r, g, b, a]` (sRGB 0..1) as a canvas colour (`rgba(…)`), its alpha × `k`. */
export const cssColor = ([r, g, b, a]: RGBA, k = 1): string => `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Math.round(a * k * 1000) / 1000})`

/** Checks a font size: a number, or one of `theme.fontSize`'s tokens; anything else throws `[scope] …` (a string number hints at `:size`). */
export function checkFontSize(scope: string, v: number | string, theme: Theme): void {
  if (typeof v === 'number' || Object.hasOwn(theme.fontSize, v)) return
  if (/^\d+(\.\d+)?$/.test(v)) throw new GlassUIError(scope, `类型应为 number 或 fontSize token，得到字符串 "${v}"（模板里数字要写成 :size="${v}"）`)
  throw new GlassUIError(scope, `未知字号 token "${v}"`, { allowed: Object.keys(theme.fontSize), got: v })
}
