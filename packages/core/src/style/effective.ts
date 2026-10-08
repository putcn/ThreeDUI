import type { Node } from '../node'
import type { Style } from './schema'

/** Keys holding partial objects: a state branch overrides their entries one by one instead of replacing them. */
const NESTED: ReadonlySet<string> = new Set(['glass', 'transition'])

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Writes `src`'s defined values onto `dst`; with `deep`, NESTED objects merge entry by entry into copies. */
function overlay(dst: Record<string, unknown>, src: object, deep: boolean): Record<string, unknown> {
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue
    const prev = dst[k]
    dst[k] = deep && NESTED.has(k) && isObject(v) ? overlay(isObject(prev) ? { ...prev } : {}, v, false) : v
  }
  return dst
}

/**
 * The style a node shows in its current state: the base style with the branches of its active states laid over it
 * in the order hover → focused → pressed → disabled (later wins). A branch only overrides the keys it defines
 * (`undefined` values are skipped), and `glass`/`transition` merge key by key, so `hover: { glass: { lift } }`
 * keeps the base glow. The result has no state branches; `n.style` is not modified.
 */
export function effectiveStyle(n: Node): Style {
  const { hover, pressed, focused, disabled, ...base } = n.style   // a fresh object, safe to overlay in place
  const { state } = n
  for (const b of [state.hover && hover, state.focused && focused, state.pressed && pressed, state.disabled && disabled]) {
    if (b) overlay(base, b, true)
  }
  return base
}
