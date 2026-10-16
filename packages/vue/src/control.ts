import { ref, watch, type Ref } from '@vue/runtime-core'
import type { Node, PointerType, Style, UIEvent } from '@glassui/core'
import { useRoot } from './inject'

/** A control's largest hover tilt about each axis (spec §8.3: at most 3°), radians. */
const CONTROL_TILT = 3 * Math.PI / 180
/** How far a hovered control lifts by default, pt. */
const LIFT = 6

/** Where `v` falls across `size`, 0..1 (the middle when there is no size). */
const across = (v: number, size: number): number => size > 0 ? Math.min(1, Math.max(0, v / size)) : 0.5

/**
 * The hover tilt that turns `n`'s face toward the pointer at (`localX`, `localY`) on it, at most `max` radians about
 * each axis: the edge under the pointer recedes (+y takes the right edge back and −x the top one, in the render's y-up
 * frame; Task 9I checked the sign on the GPU). A point off the node counts as its nearest edge; an axis with no size
 * stays level. Cards and controls both tilt by it, so a Button pitches the way the Card it sits in does.
 */
export function tiltToward(n: Node, at: Pick<UIEvent, 'localX' | 'localY'>, max: number): { x: number; y: number } {
  const lx = across(at.localX, n.layout.width), ly = across(at.localY, n.layout.height)
  return { x: (ly - 0.5) * 2 * max, y: (lx - 0.5) * 2 * max }
}

/**
 * The look every glass control shares (spec §8.3), to merge into its own style: the press scales it to `pressScale`
 * (default 0.96); the press, the hover lift and the tilt spring `snappy`; a hover brightens the glass (the glint).
 */
export function controlStyle(opts: { pressScale?: number } = {}): Style {
  return {
    transition: { scale: 'snappy', elevation: 'snappy', tilt: 'snappy' },
    pressed: { scale: opts.pressScale ?? 0.96 },
    hover: { glass: { specularIntensity: 1.35, edgeGlow: 1.1 } },
  }
}

export interface GlassControlOptions {
  /** While true the control ignores everything; turning it on drops the lift, the tilt and a Space press it has. */
  disabled: Readonly<Ref<boolean>>
  /** The activation: a click (with its pointer's type), Enter, or Space released. */
  onActivate(e: { pointerType: PointerType | 'keyboard' }): void
  /** false: a hover lifts without tilting (default true). */
  tilt?: boolean
  /** How far a hover lifts the node, pt (default 6). */
  lift?: number
}

/**
 * A control's interaction (spec §8.3) on its host node `el`: `handlers` go onto the host (`h(tag, { ref: el, ...handlers })`).
 * - A mouse or pen over the node lifts it by `lift` and tilts it toward the pointer (`tiltToward`, at most 3° about
 *   each axis); reduced motion (`root.anim.reducedMotion`) or `tilt: false` lifts without tilting; touch never hovers.
 *   Leaving the node settles it.
 * - A click activates (with its pointer's type); Enter on keydown activates; Space presses the node visually
 *   (`state.pressed`) on keydown and activates on its keyup. A keyup without its keydown here, or after a blur, does not.
 * - `pressing` is true while a press is held on the node with the pointer over it (a press dragged off and back counts
 *   again), or while Space is down: what a control animates its own parts by (the Switch's knob).
 * - While `disabled` everything is ignored.
 */
export function useGlassControl(el: Readonly<Ref<Node | null | undefined>>, opts: GlassControlOptions): { handlers: Record<string, (e: UIEvent) => void>; pressing: Ref<boolean> } {
  const root = useRoot(), pressing = ref(false)
  /** Space went down on this control: its keyup activates. */
  let spaceDown = false
  const lift = opts.lift ?? LIFT
  const hovers = (e: UIEvent): boolean => !opts.disabled.value && (e.pointerType === 'mouse' || e.pointerType === 'pen')
  const settle = (): void => { const n = el.value; if (n) { n.elevation = 0; n.tilt = { x: 0, y: 0 } } }
  /** Lets go of a Space press without activating. */
  const dropSpace = (): void => {
    if (!spaceDown) return
    spaceDown = false; pressing.value = false
    el.value?.setState({ pressed: false })
  }
  watch(opts.disabled, off => { if (off) { settle(); dropSpace(); pressing.value = false } })
  const handlers: Record<string, (e: UIEvent) => void> = {
    onPointerenter(e) {
      const n = el.value
      if (!n || opts.disabled.value) return
      pressing.value = spaceDown || n.state.pressed
      if (hovers(e)) n.elevation = lift
    },
    onPointermove(e) {
      const n = el.value
      if (!n || !hovers(e)) return
      n.elevation = lift
      // reduced motion (which may have turned on mid-hover) or no tilt: level, as a Card is
      n.tilt = opts.tilt === false || root.anim.reducedMotion ? { x: 0, y: 0 } : tiltToward(n, e, CONTROL_TILT)
    },
    onPointerleave() { settle(); pressing.value = spaceDown },
    onPointerdown() { if (!opts.disabled.value) pressing.value = true },
    onPointerup() { pressing.value = spaceDown },
    onPointercancel() { pressing.value = spaceDown },
    onClick(e) { if (!opts.disabled.value) opts.onActivate({ pointerType: e.pointerType }) },
    onKeydown(e) {
      if (opts.disabled.value) return
      if (e.key === 'Enter') opts.onActivate({ pointerType: 'keyboard' })
      else if (e.key === ' ') { spaceDown = true; pressing.value = true; el.value?.setState({ pressed: true }) }
    },
    onKeyup(e) {
      if (e.key !== ' ' || !spaceDown) return
      dropSpace()
      if (!opts.disabled.value) opts.onActivate({ pointerType: 'keyboard' })
    },
    onBlur() { dropSpace() },
  }
  return { handlers, pressing }
}
