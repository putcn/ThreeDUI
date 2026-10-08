import { Color } from 'three'
import type { Node } from 'three/webgpu'
import { mix, pow, step, vec3 } from 'three/tsl'
import type { RGBA } from '@glassui/core'

/** sRGB transfer function (IEC 61966-2-1) for one channel in 0..1. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/**
 * TSL twin of `srgbToLinear` per channel, for `c` ≥ 0. A plain node expression (no `Fn`, as `sdfNode`), so tests can
 * evaluate it against the CPU reference; both segments are computed and mixed (no branch), the power's base ≥ 0.052.
 */
export function srgbToLinearNode(c: Node<'vec3'>): Node<'vec3'> {
  return mix(pow(c.add(0.055).div(1.055), 2.4), c.div(12.92), step(c, vec3(0.04045)))
}

/** Core colours are sRGB-encoded (spec §4.3); materials want linear. Alpha is left alone. */
export function toLinear(c: RGBA): RGBA {
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), c[3]]
}

/** A linear three `Color` from a core RGBA (alpha dropped). `out` avoids allocation in hot paths. */
export function toColor(c: RGBA, out = new Color()): Color {
  return out.setRGB(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]))
}
