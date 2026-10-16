import { computed, onScopeDispose, shallowRef, watch, watchEffect, type ComputedRef, type Ref, type ShallowRef } from '@vue/runtime-core'
import type { ColorScheme, Node, Theme, UIEvent } from '@glassui/core'
import type { GridCell, Viewport3DContext } from '@glassui/render'
import { useRoot, useScheme } from './inject'
import { useOwned3D } from './owned3d'
import type { GlassRoot } from './root'

/** What a 3D chart component drives: a render chart, attached with its `update` and disposed by the component. */
export interface Chart3D { update(dt: number, ctx: Viewport3DContext): boolean; dispose(): void }

/**
 * The setup the 3D chart components share (`SurfaceChart3D`, `BarMatrix3D`); call it in `setup` with the component's
 * props (which throw while invalid).
 * - `chart`: made once from the root by `make`. It is the component's to dispose (`useOwned3D`): give `box` to the
 *   component's root node as its `ref`.
 * - `update`: the chart's, made once (a new function each render would re-attach the chart).
 * - `props`: the last valid props (the render reports invalid ones).
 * - `theme`, `scheme`: the root's, kept current (a `setTheme` with the same scheme swaps the colours tokens name).
 * - `draw(chart, x, theme, scheme)` gives the chart props that have data, and again whenever anything it reads
 *   changes. It never sees empty `values` (the chart's first `set` is the one that grows it in): emptied, the chart
 *   lets its drawing go (`dispose` keeps it usable), so data coming back grows in again, not from stale heights.
 */
export function use3DChart<P extends { values: readonly unknown[] }, C extends Chart3D>(
  props: ComputedRef<P>, make: (root: GlassRoot) => C, draw: (chart: C, x: P, theme: Theme, scheme: ColorScheme) => void,
): {
  chart: C; props: ComputedRef<P | null>; update: (dt: number, ctx: Viewport3DContext) => boolean
  box: ShallowRef<Node | null>; theme: Readonly<ShallowRef<Theme>>; scheme: Readonly<Ref<ColorScheme>>
} {
  const root = useRoot(), scheme = useScheme(), theme = shallowRef(root.theme)
  onScopeDispose(root.on('theme', e => { theme.value = e.theme }))
  const chart = make(root)
  const update = (dt: number, c: Viewport3DContext): boolean => chart.update(dt, c)
  const v = computed<P | null>(prev => { try { return props.value } catch { return prev ?? null } })
  watchEffect(() => {
    const x = v.value
    if (!x) return
    if (x.values.length === 0) { chart.dispose(); return }
    draw(chart, x, theme.value, scheme.value)
  })
  // in a leaving Block the chart flies out attached, so it goes with the Surface instead
  const box = shallowRef<Node | null>(null)
  useOwned3D(chart, box)
  return { chart, props: v, update, box, theme, scheme }
}

/**
 * Hover and select over a chart's grid of cells (`SurfaceChart3D`'s vertices, `BarMatrix3D`'s bars); call it in
 * `setup`. `props` is the last valid props (`use3DChart`'s), `reading` what a cell's events carry.
 * - `hovered`: the hovered cell, or null.
 * - `setHover(c)`: hovers `c` (null: none) on the chart and emits `hover` with its reading (null for none); nothing
 *   when it is the cell already hovered.
 * - `inData(c)`: `c` when the data has that cell, else null.
 * - `handlers(cellOf)`: the chart box's listeners, `cellOf` naming the cell an event is on (or null). A pointer move
 *   hovers it, but not a touch (core spec §8.3: a finger dragging across the Block would scrub the chart); leaving
 *   hovers none; a click on a cell of the data emits `select` with its reading.
 *
 * A data change that drops the hovered cell (or leaves no props) hovers none.
 */
export function useGridHover<R>(o: {
  chart: { hover(cell: GridCell | null): void }
  props: Readonly<Ref<{ values: readonly (readonly number[])[] } | null>>
  emit: (event: 'hover' | 'select', payload: R | null) => void
  reading: (c: GridCell) => R | null
}): {
  hovered: Readonly<ShallowRef<GridCell | null>>
  setHover: (c: GridCell | null) => void
  inData: (c: GridCell | null) => GridCell | null
  handlers: (cellOf: (e: UIEvent) => GridCell | null) => { onPointermove(e: UIEvent): void; onPointerleave(): void; onClick(e: UIEvent): void }
} {
  const { chart, props, emit, reading } = o
  const hovered = shallowRef<GridCell | null>(null)
  const inData = (c: GridCell | null): GridCell | null => (c && props.value?.values[c.row]?.[c.col] !== undefined ? c : null)
  const setHover = (c: GridCell | null): void => {
    const was = hovered.value
    if (was === c || (was && c && was.row === c.row && was.col === c.col)) return
    hovered.value = c; chart.hover(c)
    emit('hover', c && reading(c))
  }
  watch(() => { const x = props.value; return x ? `${x.values.length}×${x.values[0]?.length ?? 0}` : '' }, () => { if (!inData(hovered.value)) setHover(null) })
  const handlers = (cellOf: (e: UIEvent) => GridCell | null) => ({
    onPointermove: (e: UIEvent): void => { if (e.pointerType !== 'touch') setHover(inData(cellOf(e))) },
    onPointerleave: (): void => { setHover(null) },
    onClick: (e: UIEvent): void => { const c = inData(cellOf(e)), r = c && reading(c); if (r) emit('select', r) },
  })
  return { hovered, setHover, inData, handlers }
}
