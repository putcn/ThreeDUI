import { it, expect, vi } from 'vitest'
import { effectScope, nextTick, shallowRef } from '@vue/runtime-core'
import type { UIEvent } from '@glassui/core'
import type { GridCell } from '@glassui/render'
import { useGridHover } from '../src/chart3d'

/** A pointer event (a mouse unless `o` says otherwise); in these tests its `object` is the cell it names. */
const ev = (o: Partial<UIEvent> = {}): UIEvent => ({ type: 'pointermove', pointerType: 'mouse', ...o }) as UIEvent
const at = (row: number, col: number): UIEvent => ev({ object: { row, col } })

/** `useGridHover` over a fake chart and `values`, in its own effect scope; `emitted` records every emit. */
function grid(values: number[][]) {
  const props = shallowRef<{ values: number[][] } | null>({ values })
  const chart = { hover: vi.fn<(c: GridCell | null) => void>() }, emitted: [string, unknown][] = []
  const scope = effectScope()
  const g = scope.run(() => useGridHover({
    chart, props,
    emit: (e, payload) => { emitted.push([e, payload]) },
    reading: c => ({ ...c, value: props.value!.values[c.row]![c.col]! }),
  }))!
  const h = g.handlers(e => (e.object as GridCell | undefined) ?? null)
  return { props, chart, emitted, g, h, scope }
}

it('useGridHover: a pointermove hovers the cell it names; the same cell again neither re-emits nor re-hovers the chart', () => {
  const { chart, emitted, g, h } = grid([[1, 2, 3], [4, 5, 6]])
  h.onPointermove(at(0, 1))
  expect(chart.hover).toHaveBeenCalledTimes(1); expect(chart.hover).toHaveBeenLastCalledWith({ row: 0, col: 1 })
  expect(emitted).toEqual([['hover', { row: 0, col: 1, value: 2 }]]); expect(g.hovered.value).toEqual({ row: 0, col: 1 })
  h.onPointermove(at(0, 1)); h.onPointermove(ev({ object: { row: 0, col: 1 }, pointerType: 'pen' }))
  expect(chart.hover).toHaveBeenCalledTimes(1); expect(emitted.length).toBe(1)
  h.onPointermove(at(1, 2)); expect(emitted.at(-1)).toEqual(['hover', { row: 1, col: 2, value: 6 }])
  h.onPointermove(at(2, 0))                                                            // a cell the data lacks: none
  expect(emitted.at(-1)).toEqual(['hover', null]); expect(chart.hover).toHaveBeenLastCalledWith(null)
  h.onPointermove(ev()); expect(emitted.length).toBe(3)                                // off the cells, already none
  expect(g.inData({ row: 1, col: 0 })).toEqual({ row: 1, col: 0 }); expect(g.inData({ row: 0, col: 3 })).toBeNull()
})
it('useGridHover: a touch does not hover; leaving clears; a click selects a cell of the data only', () => {
  const { chart, emitted, h } = grid([[1, 2, 3], [4, 5, 6]])
  h.onPointermove(ev({ object: { row: 1, col: 1 }, pointerType: 'touch' }))
  expect(chart.hover).not.toHaveBeenCalled(); expect(emitted).toEqual([])
  h.onPointermove(at(1, 1)); h.onPointerleave()
  expect(emitted).toEqual([['hover', { row: 1, col: 1, value: 5 }], ['hover', null]]); expect(chart.hover).toHaveBeenLastCalledWith(null)
  h.onPointerleave(); expect(emitted.length).toBe(2)
  h.onClick(ev({ type: 'click', object: { row: 0, col: 2 }, pointerType: 'touch' })); h.onClick(ev({ type: 'click', object: { row: 5, col: 0 } })); h.onClick(ev({ type: 'click' }))
  expect(emitted.slice(2)).toEqual([['select', { row: 0, col: 2, value: 3 }]])
})
it('useGridHover: a data shape change that drops the hovered cell clears it; one that keeps it keeps it', async () => {
  const { props, chart, emitted, g, h, scope } = grid([[1, 2, 3], [4, 5, 6]])
  h.onPointermove(at(1, 2))
  props.value = { values: [[7, 8, 9], [10, 11, 12]] }; await nextTick()
  expect(g.hovered.value).toEqual({ row: 1, col: 2 }); expect(emitted.length).toBe(1)
  props.value = { values: [[7, 8], [10, 11]] }; await nextTick()
  expect(g.hovered.value).toBeNull(); expect(emitted.at(-1)).toEqual(['hover', null]); expect(chart.hover).toHaveBeenLastCalledWith(null)
  h.onPointermove(at(0, 0)); props.value = null; await nextTick()
  expect(g.hovered.value).toBeNull(); expect(emitted.at(-1)).toEqual(['hover', null])
  scope.stop()
})
