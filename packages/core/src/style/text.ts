import type { Node } from '../node'
import { effectiveStyle } from './effective'
import { resolveColor, resolveFontSize, type ColorScheme, type RGBA, type Theme } from './theme'

/** The `lineHeight` multiplier used when the style sets none. */
const LINE_HEIGHT = 1.3

/** A text node's typography with every default filled in. Lengths are pt. */
export interface ResolvedTextStyle {
  family: string
  size: number
  weight: number
  /** pt: the style's unitless `lineHeight` multiplier × `size`, rounded to whole pt. */
  lineHeight: number
  /** pt added after every character. */
  letterSpacing: number
  align: 'left' | 'center' | 'right'
  /** Present only when the style sets it. */
  maxLines?: number
  wrap: boolean
  color: RGBA
}

/**
 * The typography `node` shows in its current state (its effective style, state branches applied), resolved against
 * `theme` and `scheme`. Defaults: family `system-ui`, weight 400, size `fontSize.base`, line height 1.3 × size,
 * letter spacing 0, left-aligned, wrapping, colour `label`. Unknown tokens throw `GlassUIError`.
 * The single resolver for text: the render list and text measurement both go through it.
 */
export function resolveTextStyle(node: Node, theme: Theme, scheme: ColorScheme): ResolvedTextStyle {
  const s = effectiveStyle(node)
  const size = resolveFontSize(s.fontSize, theme)
  return {
    family: s.font ?? 'system-ui',
    size,
    weight: s.fontWeight ?? 400,
    lineHeight: Math.round((s.lineHeight ?? LINE_HEIGHT) * size),
    letterSpacing: s.letterSpacing ?? 0,
    align: s.textAlign ?? 'left',
    ...(s.maxLines !== undefined ? { maxLines: s.maxLines } : {}),
    wrap: s.wrap ?? true,
    color: resolveColor(s.color ?? 'label', theme, scheme),
  }
}
