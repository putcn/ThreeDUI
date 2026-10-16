import { resolveColor, type ColorScheme, type RGBA, type Theme } from '@glassui/core'

/** `[r, g, b, a]` (sRGB 0..1) as a canvas or style colour (`rgba(…)`), its alpha × `k`. */
export const cssColor = ([r, g, b, a]: RGBA, k = 1): string => `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${Math.round(a * k * 1000) / 1000})`

/** 0..1 → two hex digits. */
const hex2 = (v: number): string => Math.round(v * 255).toString(16).padStart(2, '0')

/**
 * `color` (a colour token, `#hex` or `rgba(…)`) resolved against `theme` / `scheme` and mixed `k` (0..1) of the way
 * toward white, as `#rrggbb` (its alpha dropped). An unknown token throws core's `[color] …` error.
 */
export function towardWhite(color: string, k: number, theme: Theme, scheme: ColorScheme): string {
  const [r, g, b] = resolveColor(color, theme, scheme)
  const lift = (v: number): string => hex2(v + (1 - v) * k)
  return `#${lift(r)}${lift(g)}${lift(b)}`
}

/**
 * The tint of glowing glass (spec §8.3: a primary button, a switch that is on): the theme's `accent` in `scheme`
 * lifted 15 % toward white. With the glow and an absorption of 1.4 the control reads as coloured glass over a light
 * panel rather than a pale wash. For the default accent it is the playground's `GLOWING.tint`, `#817af7`.
 */
export const glowingTint = (theme: Theme, scheme: ColorScheme): string => towardWhite('accent', 0.15, theme, scheme)

/**
 * `color` (a colour token, `#hex` or `rgba(…)`) resolved against `theme` / `scheme`, with its alpha set to `a` (not
 * multiplied: a token that is already translucent gets `a` too), as an `rgba(…)` literal. An unknown token throws
 * core's `[color] …` error.
 */
export function withAlpha(color: string, a: number, theme: Theme, scheme: ColorScheme): string {
  const [r, g, b] = resolveColor(color, theme, scheme)
  return cssColor([r, g, b, a])
}
