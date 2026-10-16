import { it, expect } from 'vitest'
import { h, nextTick, ref, type VNodeChild } from '@vue/runtime-core'
import { defaultTheme, resolveColor, type Node } from '@glassui/core'
import { Space } from '../src/components/Space'
import { Block } from '../src/components/Block'
import { SurfaceChart3D } from '../src/components/SurfaceChart3D'
import { glassComponents } from '../src/define'
import { createFakeRoot, flush, type FakeRoot } from './fixtures/fake-root'
import { mountGlass } from './fixtures/mount'
import { tree } from './fixtures/tree'

const inBlock = (child: () => VNodeChild) => h(Space, { camera: false }, () => [h(Block, { name: 'a', width: 760, height: 520 }, () => [child()])])
const X = ['00', '01', '02'], Y = ['10-13', '10-14']
/** 2 days × 3 hours; the largest is 236 (10-14, 01). */
const V = [[12, 80, 40], [30, 236, 90]]
const DEFAULT_RAMP = ['#cfd8ff', '#a59bff', 'accent', '#c2185b']
const ramp = (scheme: 'light' | 'dark') => DEFAULT_RAMP.map(c => resolveColor(c, defaultTheme, scheme))

/** Mounts the chart in a Block of `root`, lays it out and lets its width reach it; its Surface. */
async function mounted(root: FakeRoot, props: Record<string, unknown>) {
  mountGlass(() => inBlock(() => h(SurfaceChart3D, props)), { root })
  await flush(); root.tick(); await flush(); root.tick(); await flush()
  return root.surfacesMade[0]!
}
/** The first text node under `n` whose value is `value`. */
function byText(n: Node, value: string): Node | undefined {
  if (n.type === 'text' && n.props.value === value) return n
  for (const c of n.children) { const hit = byText(c, value); if (hit) return hit }
  return undefined
}
/** The readout row's text, its runs joined (no-break spaces as spaces). */
function readout(vp: Node): string {
  const row = vp.parent!.children[1]!, out: string[] = []
  const walk = (n: Node): void => { if (n.type === 'text') out.push(String(n.props.value ?? '')); n.children.forEach(walk) }
  walk(row)
  return out.join('').replace(/ /g, ' ')
}

it('SurfaceChart3D sets the chart: values, a nice max, the default ramp resolved for the scheme; labels with formatted ticks', async () => {
  const root = createFakeRoot()
  await mounted(root, { xLabels: X, yLabels: Y, values: V, format: (v: number) => `${v} 单` })
  const chart = root.surfaceCharts[0]!
  expect(chart.set).toHaveBeenLastCalledWith({ values: V, max: 250, ramp: ramp('light') })
  expect(chart.labels).toHaveBeenLastCalledWith({ x: X, y: Y, ticks: ['0 单', '50 单', '100 单', '150 单', '200 单', '250 单'] })
  root.emit('theme', { theme: root.theme, scheme: 'dark', contrast: false }); await nextTick()
  expect(chart.set).toHaveBeenLastCalledWith({ values: V, max: 250, ramp: ramp('dark') })
})
it('SurfaceChart3D: an explicit max and ramp are used; a max no nice step reaches gets 0, half and the max as ticks', async () => {
  const root = createFakeRoot()
  await mounted(root, { xLabels: X, yLabels: Y, values: V, max: 300, ramp: ['success', '#ff0000'] })
  expect(root.surfaceCharts[0]!.set).toHaveBeenLastCalledWith({ values: V, max: 300, ramp: [resolveColor('success', defaultTheme, 'light'), [1, 0, 0, 1]] })
  expect(root.surfaceCharts[0]!.labels).toHaveBeenLastCalledWith({ x: X, y: Y, ticks: ['0', '100', '200', '300'] })
  const odd = createFakeRoot()
  await mounted(odd, { xLabels: X, yLabels: Y, values: V, max: 245 })
  expect(odd.surfaceCharts[0]!.labels).toHaveBeenLastCalledWith({ x: X, y: Y, ticks: ['0', '122.5', '245'] })
})
it('SurfaceChart3D attaches the chart to a box of its height; depth is the chart\'s own rise at any width; update is the chart\'s', async () => {
  const root = createFakeRoot()
  const s = await mounted(root, { xLabels: X, yLabels: Y, values: V, height: 300 })
  const a = s.attached[0]!, chart = root.surfaceCharts[0]!
  expect(a.object).toBe(chart); expect(a.node.layout.height).toBe(300)
  expect(chart.riseFor).toHaveBeenLastCalledWith(300, 300); expect(a.opts.depth).toBe(300 + 40)   // the fake's min(w, h) + 40
  const c = { width: 600, height: 300, reducedMotion: false, theme: defaultTheme, scheme: 'light' as const }
  a.opts.update!(1 / 60, c); expect(chart.update).toHaveBeenLastCalledWith(1 / 60, c)
})
it('SurfaceChart3D: a pointermove with a point hovers its cell, emits the payload and shows the readout; leave clears it', async () => {
  const root = createFakeRoot(), seen: unknown[] = []
  const s = await mounted(root, { xLabels: X, yLabels: Y, values: V, format: (v: number) => `${v} 单`, onHover: (e: unknown) => seen.push(e) })
  const vp = s.attached[0]!.node, chart = root.surfaceCharts[0]!, obj = { isObject3D: true }
  expect(readout(vp)).toBe('指向曲面查看数值')
  s.pointer.move(-999, -999, 'mouse', { node: vp, object: obj, point: [1, 1, 40] }); await nextTick(); root.tick()
  expect(chart.cellAt).toHaveBeenLastCalledWith([1, 1, 40])
  expect(chart.hover).toHaveBeenLastCalledWith({ row: 1, col: 1 })
  expect(seen).toEqual([{ row: 1, col: 1, value: 236, x: '01', y: '10-14' }])
  expect(readout(vp)).toBe('10-14 · 01 · 236 单')
  s.pointer.move(-999, -999, 'mouse', { node: vp, object: obj, point: [1, 1, 30] }); await nextTick()
  expect(seen.length).toBe(1)                                                          // the same cell: no new event
  s.pointer.move(-999, -999, 'mouse', { node: vp, object: obj, point: [-1, 0, 0] }); await nextTick()   // off the grid
  expect(chart.hover).toHaveBeenLastCalledWith(null); expect(seen.at(-1)).toBeNull(); expect(readout(vp)).toBe('指向曲面查看数值')
  s.pointer.move(-999, -999, 'mouse', { node: vp, object: obj, point: [2, 0, 0] }); await nextTick()
  expect(seen.at(-1)).toEqual({ row: 0, col: 2, value: 40, x: '02', y: '10-13' })
  s.pointer.move(-999, -999, 'mouse'); await nextTick()                               // left the chart
  expect(chart.hover).toHaveBeenLastCalledWith(null); expect(seen.at(-1)).toBeNull()
  expect(readout(vp)).toBe('指向曲面查看数值')
})
it('SurfaceChart3D: a touch does not hover (core spec §8.3); a click on a cell selects it', async () => {
  const root = createFakeRoot(), hovers: unknown[] = [], picks: unknown[] = []
  const s = await mounted(root, { xLabels: X, yLabels: Y, values: V, onHover: (e: unknown) => hovers.push(e), onSelect: (e: unknown) => picks.push(e) })
  const vp = s.attached[0]!.node, chart = root.surfaceCharts[0]!, obj = { isObject3D: true }
  s.pointer.move(-999, -999, 'touch', { node: vp, object: obj, point: [0, 1, 0] }); await nextTick()
  expect(hovers).toEqual([]); expect(chart.hover).not.toHaveBeenCalled(); expect(readout(vp)).toBe('指向曲面查看数值')
  s.pointer.down(-999, -999, 'touch', { node: vp, object: obj, point: [0, 1, 0] }); s.pointer.up(-999, -999, 'touch', { node: vp, object: obj, point: [0, 1, 0] })
  expect(picks).toEqual([{ row: 1, col: 0, value: 30, x: '00', y: '10-14' }])
})
it('SurfaceChart3D: a hovered cell the data drops is hovered no more; one it keeps shows its new value', async () => {
  const root = createFakeRoot(), props = ref<Record<string, unknown>>({ xLabels: X, yLabels: Y, values: V }), seen: unknown[] = []
  mountGlass(() => inBlock(() => h(SurfaceChart3D, { ...props.value, onHover: (e: unknown) => seen.push(e) })), { root })
  await flush(); root.tick(); await flush()
  const s = root.surfacesMade[0]!, vp = s.attached[0]!.node, chart = root.surfaceCharts[0]!
  s.pointer.move(-999, -999, 'mouse', { node: vp, object: {}, point: [2, 1, 0] }); await nextTick()
  expect(seen.at(-1)).toEqual({ row: 1, col: 2, value: 90, x: '02', y: '10-14' })
  props.value = { xLabels: X, yLabels: Y, values: [[1, 2, 3], [4, 5, 6]] }; await nextTick(); root.tick(); await flush()
  expect(chart.hover).toHaveBeenLastCalledWith({ row: 1, col: 2 }); expect(readout(vp)).toBe('10-14 · 02 · 6')
  props.value = { xLabels: ['00', '01'], yLabels: Y, values: [[1, 2], [4, 5]] }; await nextTick(); root.tick(); await flush()
  expect(chart.hover).toHaveBeenLastCalledWith(null); expect(seen.at(-1)).toBeNull(); expect(readout(vp)).toBe('指向曲面查看数值')
})
it('SurfaceChart3D: empty values say so and set nothing, as tall as the chart with its readout', async () => {
  const root = createFakeRoot()
  mountGlass(() => inBlock(() => h(SurfaceChart3D, { xLabels: X, yLabels: Y, values: [], height: 240 })), { root }); await flush(); root.tick()
  const s = root.surfacesMade[0]!
  expect(JSON.stringify(tree(s.root))).toContain('暂无数据'); expect(s.attached).toEqual([])
  expect(root.surfaceCharts[0]!.set).not.toHaveBeenCalled()
  const empty = byText(s.root, '暂无数据')!.parent!
  const full = createFakeRoot(), f = await mounted(full, { xLabels: X, yLabels: Y, values: V, height: 240 })
  expect(empty.layout.height).toBe(f.attached[0]!.node.parent!.layout.height); expect(empty.layout.height).toBe(240 + 10 + 20)
})
it('SurfaceChart3D: values coming back after empty grow in again (the chart lets go of its drawing), not from stale heights', async () => {
  const root = createFakeRoot(), values = ref<number[][]>(V)
  mountGlass(() => inBlock(() => h(SurfaceChart3D, { xLabels: X, yLabels: Y, values: values.value })), { root }); await flush(); root.tick()
  const chart = root.surfaceCharts[0]!
  expect(chart.set).toHaveBeenCalledTimes(1); expect(chart.dispose).not.toHaveBeenCalled()
  values.value = []; await nextTick()
  expect(chart.dispose).toHaveBeenCalledTimes(1); expect(root.surfacesMade[0]!.attached).toEqual([])
  values.value = V; await nextTick(); await flush()
  expect(chart.set).toHaveBeenCalledTimes(2)
  expect(chart.dispose.mock.invocationCallOrder[0]!).toBeLessThan(chart.set.mock.invocationCallOrder[1]!)
  expect(root.surfacesMade[0]!.attached.map(a => a.object)).toEqual([chart])
})
it('SurfaceChart3D errors name the prop', () => {
  const err = (props: Record<string, unknown>) => mountGlass(() => inBlock(() => h(SurfaceChart3D, props))).errors[0]
  expect(err({ xLabels: X, yLabels: Y, values: [[1, 2, 3]] })).toMatch(/\[SurfaceChart3D\.values\] .*2 行.*得到 1 行/)
  expect(err({ xLabels: X, yLabels: Y, values: [[1, 2, 3], [4, 5]] })).toMatch(/\[SurfaceChart3D\.values\] .*第 2 行有 2 个.*xLabels 有 3 个/)
  expect(err({ xLabels: X, yLabels: Y, values: [[1, 2, 3], [4, 5, -6]] })).toMatch(/\[SurfaceChart3D\.values\.1\.2\]/)
  expect(err({ xLabels: ['0'], yLabels: Y, values: [] })).toMatch(/\[SurfaceChart3D\.xLabels\] 至少 2 项/)
  expect(err({ xLabels: X, yLabels: Y, values: V, ramp: ['accent'] })).toMatch(/\[SurfaceChart3D\.ramp\]/)
  expect(err({ xLabels: X, yLabels: Y, values: V, ramp: ['acent', '#fff'] })).toMatch(/\[SurfaceChart3D\.ramp\.0\] 未知颜色 token "acent"/)
})
it('SurfaceChart3D is registered with complete manifest metadata', () => {
  const c = glassComponents().find(g => g.glass.name === 'SurfaceChart3D')!
  expect(c).toBeDefined()
  expect(c.glass.description.length).toBeGreaterThan(40); expect(c.glass.examples.length).toBeGreaterThanOrEqual(2); expect(c.glass.examples.length).toBeLessThanOrEqual(3)
  for (const [k, s] of Object.entries(c.glass.props.shape)) expect((s as { description?: string }).description, `SurfaceChart3D.${k}`).toMatch(/[一-鿿]/)
  expect((c.glass.props.shape.max as { description?: string }).description).toMatch(/封顶/)
  for (const e of c.glass.examples) expect(e).toMatch(/^<Space\b[^]*<SurfaceChart3D\b[^]*<\/Space>$/)
  expect(c.glass.mistakes!.length).toBeGreaterThanOrEqual(2)
  expect(c.glass.mistakes!.map(m => m.mistake).join('\n')).toMatch(/values/)
  expect(Object.keys(c.glass.events!)).toEqual(['hover', 'select'])
})
