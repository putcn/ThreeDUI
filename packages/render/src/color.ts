import { Color } from 'three'
import type { RGBA } from '@glassui/core'

/** sRGB transfer function (IEC 61966-2-1) for one channel in 0..1. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** Core colours are sRGB-encoded (spec §4.3); materials want linear. Alpha is left alone. */
export function toLinear(c: RGBA): RGBA {
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), c[3]]
}

/** A linear three `Color` from a core RGBA (alpha dropped). `out` avoids allocation in hot paths. */
export function toColor(c: RGBA, out = new Color()): Color {
  return out.setRGB(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]))
}
