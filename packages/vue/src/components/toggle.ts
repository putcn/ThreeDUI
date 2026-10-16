import { computed, h, type ComputedRef, type Ref, type SetupContext, type Slots, type VNode, type VNodeChild } from '@vue/runtime-core'
import type { Node, Style } from '@glassui/core'
import { useGlassControl, type ControlHandlers } from '../control'
import { Text } from './Text'

/**
 * A toggle's label type (Switch, Checkbox): 20 pt at weight 500 in the label colour, `gap` pt from its control, as the
 * reference's "Remember me" and terms line beside the 62 pt switch and the 44 pt checkbox.
 */
export const TOGGLE_LABEL = { size: 20, weight: 500, color: 'label', gap: 16 } as const

/**
 * A toggle's interaction (Switch, Checkbox): `useGlassControl` on its control `el`, inert while its props are invalid
 * (the render throws that error; nothing here throws it again) or `disabled`. An activation emits `update:checked`, then
 * `change`, with `next(props)`.
 */
export function useToggle<P extends { disabled: boolean }>(
  el: Readonly<Ref<Node | null | undefined>>, p: ComputedRef<P>, emit: SetupContext['emit'], next: (props: P) => boolean,
): ReturnType<typeof useGlassControl> & { inert: ComputedRef<boolean> } {
  const valid = computed(() => { try { return p.value } catch { return null } })
  const inert = computed(() => !valid.value || valid.value.disabled)
  const ctl = useGlassControl(el, { disabled: inert, onActivate: () => { const v = next(p.value); emit('update:checked', v); emit('change', v) } })
  return { ...ctl, inert }
}

/**
 * A toggle's row: `children` (its control and its label, in order) centred across, `TOGGLE_LABEL.gap` apart, `style`
 * added; while `disabled` the whole row, label included, dims to 0.4. The row takes no events: a click in the empty
 * space a stretching parent gives it does nothing.
 */
export function toggleRow(disabled: boolean, children: VNodeChild[], style: Style = {}): VNode {
  return h('box', { style: { flexDirection: 'row', alignItems: 'center', gap: TOGGLE_LABEL.gap, ...style, disabled: { opacity: 0.4 } }, disabled }, children)
}

/**
 * A toggle's label: the default slot, else `label` as Text in `TOGGLE_LABEL`'s type, in a box that shrinks and carries
 * `handlers` (`useGlassControl`'s `label`: a press on it presses the control, its click focuses and toggles it). `right`
 * aligns it right, against a control to its right. Null when there is neither slot nor label.
 */
export function toggleLabel(slots: Slots, label: string | undefined, handlers: ControlHandlers, align: 'left' | 'right' = 'left'): VNode | null {
  const right = align === 'right'
  const content = slots.default ? slots.default() : label !== undefined
    ? [h(Text, { value: label, size: TOGGLE_LABEL.size, weight: TOGGLE_LABEL.weight, color: TOGGLE_LABEL.color, ...(right ? { align } : {}) })]
    : null
  return content ? h('box', { style: { flexShrink: 1, ...(right ? { alignItems: 'flex-end' } : {}) }, ...handlers }, content) : null
}
