import { BaseTransition, defineComponent, h, type Component, type PropType } from '@vue/runtime-core'
import { GlassUIError, type Node, type Style } from '@glassui/core'
import { useMotion, useRoot } from './inject'
import { liveSurface, PRESET_TRANSITION, PRESETS, type TransitionPreset } from './motion'
import { setStyleLayer } from './renderer'

const MODES = ['out-in', 'in-out'] as const

/**
 * Vue's `<Transition>` for glass nodes, over the animation runtime (spec §4.4, §8.3): its one child enters from the
 * preset (`glass`: opacity 0, scale 0.9, no refraction or dispersion, roughness 0.35; `fade`; `scale`) and leaves to it,
 * through the `transition` style layer, with `smooth` springs for the keys the node's own style has no transition for.
 *
 * - Enter: the preset layer is on when the next tick first sees the node (it records those values); after that tick
 *   only the springs stay, so the node animates to its own style; settled, the layer comes off and `done()` runs.
 * - Leave: the next tick records where the node is; then the preset layer goes on and the node animates to it;
 *   settled, `done()` removes it. A leave during an enter starts from where the enter got to; the enter never reports.
 * - Motion `'frozen'`, or a node no live Surface ticks (a detached container, a failed or disposed Surface; checked
 *   again after every wait): `done()` at once, no layer.
 *
 * The enter/leave hooks are its own; the `before*` / `after*` hooks a user passes (`@after-enter`, …) run as usual.
 */
export const GlassTransition = defineComponent({
  name: 'GlassTransition',
  inheritAttrs: false,   // the attrs (the user's hooks, class…) go to BaseTransition explicitly, once
  props: {
    preset: { type: String as PropType<TransitionPreset>, default: 'glass' },
    appear: Boolean,
    mode: String as PropType<(typeof MODES)[number]>,
  },
  setup(props, { slots, attrs }) {
    const root = useRoot(), motion = useMotion()
    // per node: the current enter/leave (a continuation whose token moved on stops), and whether our layer is on
    const token = new WeakMap<Node, number>()
    const layered = new WeakSet<Node>()
    const bump = (el: Node): number => { const t = (token.get(el) ?? 0) + 1; token.set(el, t); return t }
    const current = (el: Node, t: number): boolean => token.get(el) === t
    const layer = (el: Node, style: Style | null): void => {
      if (style) layered.add(el); else if (!layered.delete(el)) return
      setStyleLayer(el, 'transition', style)
    }
    const cfg = (el: Node): Style => ({ transition: { ...PRESET_TRANSITION, ...el.style.transition } })
    const from = (el: Node): Style => ({ ...PRESETS[props.preset], ...cfg(el) })
    const live = (el: Node): boolean => motion === 'live' && liveSurface(root, el) !== null

    async function enter(el: Node, t: number, done: () => void): Promise<void> {
      await root.afterTick()                    // that tick recorded the preset values
      if (!current(el, t)) return
      if (live(el)) {
        layer(el, cfg(el))                      // the targets are the node's own style again: it animates there
        await root.anim.whenSettled(el)
        if (!current(el, t)) return
      }
      layer(el, null); done()
    }
    async function leave(el: Node, t: number, done: () => void): Promise<void> {
      await root.afterTick()                    // that tick recorded where the node is
      if (!current(el, t)) return
      if (live(el)) {
        layer(el, from(el))
        await root.anim.whenSettled(el)
        if (!current(el, t)) return
      }
      if (!live(el)) layer(el, null)
      done()
    }
    const hooks = {
      onEnter(el: Node, done: () => void) {
        const t = bump(el)
        if (!live(el)) { layer(el, null); done(); return }
        layer(el, from(el))                     // before any tick: the node is never drawn in its own style first
        void enter(el, t, done)
      },
      onEnterCancelled(el: Node) { bump(el) },  // the leave that follows takes the node from where it is
      onLeave(el: Node, done: () => void) {
        const t = bump(el)
        if (!live(el)) { layer(el, null); done(); return }
        // the springs on, so the next tick records the node where it is (a node the runtime never tracked would jump);
        // mid-enter our layer is already on, the preset values too when no tick has seen the node yet
        if (!layered.has(el)) layer(el, cfg(el))
        void leave(el, t, done)
      },
      onLeaveCancelled(el: Node) { bump(el); layer(el, null) },
    }
    return () => {
      if (!Object.hasOwn(PRESETS, props.preset)) throw new GlassUIError('GlassTransition.preset', `非法取值 "${props.preset}"`, { allowed: Object.keys(PRESETS), got: String(props.preset) })
      if (props.mode !== undefined && !MODES.includes(props.mode)) throw new GlassUIError('GlassTransition.mode', `非法取值 "${props.mode}"`, { allowed: MODES, got: String(props.mode) })
      return h(BaseTransition as Component, { ...attrs, appear: props.appear, mode: props.mode, ...hooks, onAppear: hooks.onEnter, onAppearCancelled: hooks.onEnterCancelled }, slots)
    }
  },
})
