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
 * (≥ 3:1 against the default theme's card, WCAG 1.4.11); a glass background slab fills with plain `fill`, no border.
 */
export const FILL = { alpha: 0.92, borderPt: 1, labelMix: 0.04 } as const
