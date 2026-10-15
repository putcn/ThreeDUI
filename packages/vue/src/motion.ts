import type { Node, Style } from '@glassui/core'
import type { Surface } from '@glassui/render'
import type { GlassRoot } from './root'

/**
 * Where `GlassTransition` enters from and leaves to (spec §8.3: refraction and blur modulate with scale 0.9 → 1;
 * `glass` starts from no refraction or dispersion at roughness 0.35). The `glass` keys only affect glass nodes; the
 * runtime animates `ior`, `dispersion` and `roughness`.
 */
export const PRESETS = {
  glass: { opacity: 0, scale: 0.9, glass: { ior: 1, dispersion: 0, roughness: 0.35 } },
  fade: { opacity: 0 },
  scale: { opacity: 0, scale: 0.9 },
} as const satisfies Record<string, Style>
export type TransitionPreset = keyof typeof PRESETS

/** The transitions every preset animates with, for the keys the node's own style has none for. */
export const PRESET_TRANSITION = { opacity: 'smooth', scale: 'smooth', glass: 'smooth' } as const satisfies NonNullable<Style['transition']>

/**
 * The live Surface `n` is in: one of `root.surfaces` whose root is `n`'s tree root, neither failed (`error`) nor
 * disposed. Null when there is none (a detached container or placeholder, a failed or disposed Surface): nothing will
 * tick `n` again, so a transition must not wait for its animation (`whenSettled` resolves only on a tick of its tree).
 */
export function liveSurface(root: GlassRoot, n: Node): Surface | null {
  const top = n.root
  return root.surfaces.find(s => s.root === top && !s.error && !s.disposed) ?? null
}
