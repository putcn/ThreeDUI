import { h, type VNode } from '@vue/runtime-core'
import { Text, type TextFragment } from './components/Text'

/** pt: a 3D chart's readout row's height (the same for the hint and a reading, so nothing below moves), and its gap to the chart. */
export const READOUT = 20, READOUT_GAP = 10

/**
 * The flat readout row under a 3D chart (spatial spec §12; `SurfaceChart3D`, `BarMatrix3D`): `parts` joined by " · "
 * (13 pt, the dots `tertiaryLabel`), or `hint` in `tertiaryLabel` when nothing is hovered; centred, no panel.
 */
export function readoutRow(parts: readonly TextFragment[] | null, hint: string): VNode {
  const dot: TextFragment = { text: ' · ', color: 'tertiaryLabel' }
  const line = parts
    ? h(Text, { value: parts.flatMap((p, i) => (i ? [dot, p] : [p])), size: 13, wrap: false })
    : h(Text, { value: hint, size: 13, color: 'tertiaryLabel', wrap: false })
  return h('box', { style: { height: READOUT, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' } }, [line])
}
