import { resolveColor, type ColorScheme, type RGBA, type Theme } from '@glassui/core'

/**
 * Frost (spec §5.3): glass of roughness `r` sees its backdrop at mip level `r · levelPerRoughness`, lifted toward white
 * by `r · liftPerRoughness + lift`. The glass material applies it per instance; what is behind a glass Surface's
 * content plane is seen through the slab's fixed frost (`SLAB_BEHIND`), by the element glass and the luma pass alike.
 */
export const FROST = { levelPerRoughness: 8, liftPerRoughness: 0.08 } as const

/** The frosted background slab's roughness and lift; element glass on such a Surface sees what is behind it as the slab does. */
export const SLAB_FROST = { roughness: 0.4, lift: 0.07 } as const

/** The slab's frost as a backdrop: the screen capture's mip level and the lift toward white. */
export const SLAB_BEHIND = {
  level: SLAB_FROST.roughness * FROST.levelPerRoughness,
  lift: SLAB_FROST.roughness * FROST.liftPerRoughness + SLAB_FROST.lift,
} as const

/**
 * The `'fill'` glass mode (minimal tier, reduced transparency; spec §5.6 "近不透明磨砂填充 + 边框"): the glass draws a
 * fill colour instead of a backdrop, mixed over the lit shell at `alpha` (the backdrop alpha), so it reads as near-opaque
 * glass. Element glass fills with its glow colour, else its tint, else the theme's `fill` moved `labelMix` toward
 * `label` (sRGB; a shade off the card it sits on), and draws a `borderPt` band along its outline in `tertiaryLabel`
 * (≥ 3:1 against the default theme's card, WCAG 1.4.11) — at least `borderMinPx` device pixels wide, the least that
 * leaves one solid border pixel on every edge whatever the outline's phase against the pixel grid (a 1 pt band on a
 * Surface drawn at 0.8 px per pt smears to a few percent). The band is final: no specular, glow or rim over it. A glass
 * background slab fills with plain `fill`, no border.
 */
export const FILL = { alpha: 0.92, borderPt: 1, borderMinPx: 2, labelMix: 0.04 } as const

/**
 * The `'fill'` glass mode's colours as the theme gives them for `scheme`, sRGB (core RGBA): `fill` (the slab's), `glass`
 * (element glass with neither glow nor tint: `fill` moved `FILL.labelMix` toward `label`), `border` (`tertiaryLabel`)
 * and `label`. A theme missing one of the tokens gets the default light theme's value for it instead of failing.
 * `fillColors` (the materials' linear colours) and the stacked RT's panels (`StackPass`) both read them.
 */
export function fillTokens(theme: Theme, scheme: ColorScheme): { fill: RGBA; glass: RGBA; border: RGBA; label: RGBA } {
  const table = theme.colors[scheme]
  const token = (name: string, fallback: RGBA): RGBA => Object.hasOwn(table, name) ? resolveColor(name, theme, scheme) : fallback
  const label = token('label', [28 / 255, 28 / 255, 34 / 255, 1])
  const fill = token('fill', [1, 1, 1, 1]), border = token('tertiaryLabel', [138 / 255, 138 / 255, 152 / 255, 1])
  const k = FILL.labelMix
  const glass: RGBA = [fill[0] + (label[0] - fill[0]) * k, fill[1] + (label[1] - fill[1]) * k, fill[2] + (label[2] - fill[2]) * k, 1]
  return { fill, glass, border, label }
}
