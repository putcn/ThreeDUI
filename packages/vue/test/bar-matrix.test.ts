import { it, expect } from 'vitest'
import { h, nextTick, ref, type VNodeChild } from '@vue/runtime-core'
import type { Canvas } from '@napi-rs/canvas'
import { defaultTheme, rampColor, resolveColor, type Node, type RGBA } from '@glassui/core'
import { Space } from '../src/components/Space'
import { Block } from '../src/components/Block'
import { BarMatrix3D } from '../src/components/BarMatrix3D'
import { glassComponents } from '../src/define'
import { createFakeRoot, flush, type FakeRoot } from './fixtures/fake-root'
import { first, mountGlass } from './fixtures/mount'
import { tree } from './fixtures/tree'

const inBlock = (child: () => VNodeChild) => h(Space, { camera: false }, () => [h(Block, { name: 'a', width: 760, height: 560 }, () => [child()])])
const ROWS = ['A 区', 'B 区'], COLS = ['日化', '食品', '家电']
/** Stock: 2 zones × 3 categories, the largest 4,580 (A 区, 日化). */
const V = [[4580, 1200, 300], [2400, 3600, 900]]
/** Days of cover: the least 8 (B 区, 日化), the most 60 (B 区, 家电). */
const D = [[12, 30, 45], [8, 20, 60]]
const GREEN = '#34c759', AMBER = '#ffb86b', RED = '#ff6b6b'
const hex = (c: string, scheme: 'light' | 'dark' = 'light'): RGBA => resolveColor(c, defaultTheme, scheme)
const RAMP = [hex(GREEN), hex(AMBER), hex(RED)]
const pieces = (n = 4580): string => `${n.toLocaleString('en-US')} 件`
const days = (n: number): string => `${n} 天`
/** A bar the pointer is on: a stand-in for the render matrix's mesh (its userData names the cell). */
const barAt = (row: number, col: number) => ({ isObject3D: true, userData: { row, col } })

/** Mounts the matrix in a Block of `root` and lays it out; its Surface. */
async function mounted(root: FakeRoot, props: Record<string, unknown>) {
  mountGlass(() => inBlock(() => h(BarMatrix3D, props)), { root })
  await flush(); root.tick(); await flush(); root.tick(); await flush()
  return root.surfacesMade[0]!
}
/** Every text under `n`, its runs joined (no-break spaces as spaces). */
function textOf(n: Node): string {
  const out: string[] = []
  const walk = (m: Node): void => { if (m.type === 'text') out.push(String(m.props.value ?? '')); m.children.forEach(walk) }
  walk(n)
  return out.join('').replace(/\u00a0/g, ' ')
}
/** The first text node under `n` whose value is `value`. */
function byText(n: Node, value: string): Node | undefined {
  if (n.type === 'text' && n.props.value === value) return n
  for (const c of n.children) { const hit = byText(c, value); if (hit) return hit }
  return undefined
}
const readout = (vp: Node): string => textOf(vp.parent!.children[1]!)
/** The canvas pixel at (x, y) px, as 0..255 channels. */
const pixel = (cv: Canvas, x: number, y: number): number[] => [...cv.getContext('2d').getImageData(Math.round(x), Math.round(y), 1, 1).data]
const rgb255 = (c: RGBA): number[] => c.slice(0, 3).map(v => Math.round(v * 255))

it('BarMatrix3D sets the matrix: values, a nice max, each cell the default ramp at value / max; the row and column labels', async () => {
  const root = createFakeRoot()
  await mounted(root, { rows: ROWS, cols: COLS, values: V })
  const m = root.barMatrices[0]!
  expect(m.set).toHaveBeenLastCalledWith({ values: V, max: 5000, colors: V.map(row => row.map(v => rampColor(RAMP, v / 5000))) })
  expect(m.labels).toHaveBeenLastCalledWith({ rows: ROWS, cols: COLS })
  // capped at max: a value over it takes the ramp's last colour
  const capped = createFakeRoot()
  await mounted(capped, { rows: ROWS, cols: COLS, values: V, max: 4000 })
  expect(capped.barMatrices[0]!.set.mock.lastCall![0].colors[0]![0]).toEqual(RAMP[2])
})
it('BarMatrix3D colours by colorValues over their own min..max: the least cell the ramp\'s first colour, the greatest its last; all equal: its middle', async () => {
  const root = createFakeRoot()
  await mounted(root, { rows: ROWS, cols: COLS, values: V, colorValues: D })
  const { colors, values, max } = root.barMatrices[0]!.set.mock.lastCall![0]
  expect(values).toEqual(V); expect(max).toBe(5000)
  expect(colors[1]![0]).toEqual(RAMP[0]); expect(colors[1]![2]).toEqual(RAMP[2])
  expect(colors[0]![0]).toEqual(rampColor(RAMP, (12 - 8) / (60 - 8))); expect(colors[0]![2]).toEqual(rampColor(RAMP, (45 - 8) / (60 - 8)))
  const flat = createFakeRoot()
  await mounted(flat, { rows: ROWS, cols: COLS, values: V, colorValues: [[5, 5, 5], [5, 5, 5]] })
  for (const row of flat.barMatrices[0]!.set.mock.lastCall![0].colors) for (const c of row) expect(c).toEqual(RAMP[1])
  const two = createFakeRoot()
  await mounted(two, { rows: ROWS, cols: COLS, values: V, colorValues: [[5, 5, 5], [5, 5, 5]], colorRamp: ['#000000', '#ffffff'] })
  expect(two.barMatrices[0]!.set.mock.lastCall![0].colors[0]![0]).toEqual([0.5, 0.5, 0.5, 1])
})
it('BarMatrix3D: colorRamp takes tokens, resolved for the scheme and again when it changes', async () => {
  const root = createFakeRoot()
  await mounted(root, { rows: ROWS, cols: COLS, values: V, colorValues: D, colorRamp: ['success', 'danger'] })
  const m = root.barMatrices[0]!
  expect(m.set.mock.lastCall![0].colors[1]![0]).toEqual(resolveColor('success', defaultTheme, 'light'))
  root.emit('theme', { theme: root.theme, scheme: 'dark', contrast: false }); await nextTick()
  expect(m.set.mock.lastCall![0].colors[1]![0]).toEqual(resolveColor('success', defaultTheme, 'dark'))
  expect(m.set.mock.lastCall![0].colors[1]![2]).toEqual(resolveColor('danger', defaultTheme, 'dark'))
})
it('BarMatrix3D attaches the matrix to a box of its height; depth is the matrix\'s own rise; update is the matrix\'s', async () => {
  const root = createFakeRoot()
  const s = await mounted(root, { rows: ROWS, cols: COLS, values: V, height: 300 })
  const a = s.attached[0]!, m = root.barMatrices[0]!
  expect(a.object).toBe(m); expect(a.node.layout.height).toBe(300)
  expect(m.riseFor).toHaveBeenLastCalledWith(300, 300); expect(a.opts.depth).toBe(300 + 40)   // the fake's min(w, h) + 40
  const c = { width: 600, height: 300, reducedMotion: false, theme: defaultTheme, scheme: 'light' as const }
  a.opts.update!(1 / 60, c); expect(m.update).toHaveBeenLastCalledWith(1 / 60, c)
})
it('BarMatrix3D: a pointermove on a bar hovers its cell, emits the payload and reads "row · col · value · colour value"; off a bar or leaving clears it', async () => {
  const root = createFakeRoot(), seen: unknown[] = []
  const s = await mounted(root, { rows: ROWS, cols: COLS, values: V, colorValues: D, format: pieces, colorFormat: days, colorLabel: '周转', onHover: (e: unknown) => seen.push(e) })
  const vp = s.attached[0]!.node, m = root.barMatrices[0]!
  expect(readout(vp)).toBe('指向柱子查看数值')
  s.pointer.move(-999, -999, 'mouse', { node: vp, object: barAt(0, 0), point: [0, 0, 40] }); await nextTick(); root.tick()
  expect(m.hover).toHaveBeenLastCalledWith({ row: 0, col: 0 })
  expect(seen).toEqual([{ row: 0, col: 0, value: 4580, colorValue: 12, rowLabel: 'A 区', colLabel: '日化' }])
  expect(readout(vp)).toBe('A 区 · 日化 · 4,580 件 · 周转 12 天')
  s.pointer.move(-999, -999, 'mouse', { node: vp, object: barAt(0, 0), point: [3, 2, 50] }); await nextTick()
  expect(seen.length).toBe(1)                                                          // the same cell: no new event
  s.pointer.move(-999, -999, 'mouse', { node: vp, object: barAt(1, 2), point: [0, 0, 0] }); await nextTick()
  expect(seen.at(-1)).toEqual({ row: 1, col: 2, value: 900, colorValue: 60, rowLabel: 'B 区', colLabel: '家电' })
  expect(readout(vp)).toBe('B 区 · 家电 · 900 件 · 周转 60 天')
  s.pointer.move(-999, -999, 'mouse', { node: vp, object: { isObject3D: true, userData: {} }, point: [0, 0, 0] }); await nextTick()   // not a bar
  expect(m.hover).toHaveBeenLastCalledWith(null); expect(seen.at(-1)).toBeNull(); expect(readout(vp)).toBe('指向柱子查看数值')
  s.pointer.move(-999, -999, 'mouse', { node: vp, object: barAt(4, 0), point: [0, 0, 0] }); await nextTick()                   // a cell the data lacks
  expect(seen.at(-1)).toBeNull(); expect(seen.length).toBe(3)
  s.pointer.move(-999, -999, 'mouse', { node: vp, object: barAt(1, 1), point: [0, 0, 0] }); await nextTick()
  s.pointer.move(-999, -999, 'mouse'); await nextTick()                               // left the matrix
  expect(m.hover).toHaveBeenLastCalledWith(null); expect(seen.at(-1)).toBeNull(); expect(readout(vp)).toBe('指向柱子查看数值')
})
it('BarMatrix3D without colorValues: the payload has no colorValue and the readout no colour part', async () => {
  const root = createFakeRoot(), seen: Record<string, unknown>[] = []
  const s = await mounted(root, { rows: ROWS, cols: COLS, values: V, format: pieces, colorLabel: '周转', onHover: (e: Record<string, unknown>) => seen.push(e) })
  const vp = s.attached[0]!.node
  s.pointer.move(-999, -999, 'mouse', { node: vp, object: barAt(1, 1) }); await nextTick()
  expect(seen).toEqual([{ row: 1, col: 1, value: 3600, rowLabel: 'B 区', colLabel: '食品' }]); expect('colorValue' in seen[0]!).toBe(false)
  expect(readout(vp)).toBe('B 区 · 食品 · 3,600 件')
})
it('BarMatrix3D: a touch does not hover (core spec §8.3); a click on a bar selects it', async () => {
  const root = createFakeRoot(), hovers: unknown[] = [], picks: unknown[] = []
  const s = await mounted(root, { rows: ROWS, cols: COLS, values: V, colorValues: D, onHover: (e: unknown) => hovers.push(e), onSelect: (e: unknown) => picks.push(e) })
  const vp = s.attached[0]!.node, m = root.barMatrices[0]!
  s.pointer.move(-999, -999, 'touch', { node: vp, object: barAt(0, 1) }); await nextTick()
  expect(hovers).toEqual([]); expect(m.hover).not.toHaveBeenCalled(); expect(readout(vp)).toBe('指向柱子查看数值')
  s.pointer.down(-999, -999, 'touch', { node: vp, object: barAt(0, 1) }); s.pointer.up(-999, -999, 'touch', { node: vp, object: barAt(0, 1) })
  expect(picks).toEqual([{ row: 0, col: 1, value: 1200, colorValue: 30, rowLabel: 'A 区', colLabel: '食品' }])
  s.pointer.down(-999, -999, 'mouse', { node: vp, object: { userData: {} } }); s.pointer.up(-999, -999, 'mouse', { node: vp, object: { userData: {} } })
  expect(picks.length).toBe(1)                                                         // not on a bar: no select
})
it('BarMatrix3D: with colorValues a legend under the readout: the ramp as a gradient strip, its min and max (colorFormat) and colorLabel; none without', async () => {
  const root = createFakeRoot()
  const s = await mounted(root, { rows: ROWS, cols: COLS, values: V, colorValues: D, colorFormat: days, colorLabel: '周转天数' })
  const column = s.attached[0]!.node.parent!
  expect(column.children.length).toBe(3)
  const legend = column.children[2]!, strip = first(legend, 'image'), src = strip.props.src as Canvas
  expect(textOf(legend)).toBe('8 天周转天数60 天')
  // drawn at 2×: the ramp from its first colour at the left to its last at the right, the middle colour halfway
  const w = strip.layout.width, hh = strip.layout.height
  expect(w).toBeGreaterThan(80); expect(hh).toBeGreaterThan(4); expect([src.width, src.height]).toEqual([w * 2, hh * 2])
  const mid = src.height / 2, ends = (x: number) => rampColor(RAMP, x / (src.width - 1))
  for (const x of [hh, src.width / 2 - 0.5, src.width - 1 - hh]) {
    const got = pixel(src, x, mid), want = rgb255(ends(x))
    for (let i = 0; i < 3; i++) expect(Math.abs(got[i]! - want[i]!), `x ${x} channel ${i}`).toBeLessThanOrEqual(2)
  }
  expect(rgb255(ends(src.width / 2 - 0.5))).toEqual(rgb255(RAMP[1]!))
  // no backgrounds: the legend is type and the strip
  const walk = (n: Node): void => { expect(n.style.bg, n.id).toBeUndefined(); n.children.forEach(walk) }
  walk(legend)
  const plain = createFakeRoot(), p = await mounted(plain, { rows: ROWS, cols: COLS, values: V, colorLabel: '周转天数' })
  const col = p.attached[0]!.node.parent!
  expect(col.children.length).toBe(2); expect(JSON.stringify(tree(col))).not.toContain('周转天数')
  expect(JSON.stringify(tree(col))).not.toContain('"image"')
})
it('BarMatrix3D legend: a long colorLabel gives way, cut to one line between the min and max, which stay whole inside the legend', async () => {
  /** The legend's label row (under the strip), and its min, label and max. */
  const labels = async (colorLabel: string) => {
    const s = await mounted(createFakeRoot(), { rows: ROWS, cols: COLS, values: V, colorValues: D, colorFormat: days, colorLabel })
    const row = s.attached[0]!.node.parent!.children[2]!.children[1]!, [lo, label, hi] = row.children.filter(n => n.type !== 'anchor')
    return { row, lo: lo!, label: label!, hi: hi! }
  }
  const short = await labels('周转'), long = await labels('近三十天按出库量加权计算的平均周转天数')
  expect(long.row.layout.width).toBe(short.row.layout.width)
  for (const n of [long.lo, long.label, long.hi]) { expect(n.layout.x).toBeGreaterThanOrEqual(0); expect(n.layout.x + n.layout.width).toBeLessThanOrEqual(long.row.layout.width + 1e-6) }
  expect(long.lo.layout.width).toBe(short.lo.layout.width); expect(long.hi.layout.width).toBe(short.hi.layout.width)
  expect(long.label.layout.height).toBe(short.label.layout.height)                   // one line
  expect(long.label.layout.width).toBeLessThan(19 * 0.6 * 12)                         // narrower than its text: cut
  expect(long.label.layout.x).toBeGreaterThan(long.lo.layout.x + long.lo.layout.width); expect(long.hi.layout.x).toBeGreaterThan(long.label.layout.x + long.label.layout.width)
  expect(long.label.style.maxLines).toBe(1)
})
it('BarMatrix3D: a hovered cell the data drops is hovered no more; one it keeps shows its new value', async () => {
  const root = createFakeRoot(), props = ref<Record<string, unknown>>({ rows: ROWS, cols: COLS, values: V }), seen: unknown[] = []
  mountGlass(() => inBlock(() => h(BarMatrix3D, { ...props.value, onHover: (e: unknown) => seen.push(e) })), { root })
  await flush(); root.tick(); await flush()
  const s = root.surfacesMade[0]!, vp = s.attached[0]!.node, m = root.barMatrices[0]!
  s.pointer.move(-999, -999, 'mouse', { node: vp, object: barAt(1, 2) }); await nextTick()
  expect(seen.at(-1)).toEqual({ row: 1, col: 2, value: 900, rowLabel: 'B 区', colLabel: '家电' })
  props.value = { rows: ROWS, cols: COLS, values: [[1, 2, 3], [4, 5, 6]] }; await nextTick(); root.tick(); await flush()
  expect(m.hover).toHaveBeenLastCalledWith({ row: 1, col: 2 }); expect(readout(vp)).toBe('B 区 · 家电 · 6')
  props.value = { rows: ROWS, cols: ['日化', '食品'], values: [[1, 2], [4, 5]] }; await nextTick(); root.tick(); await flush()
  expect(m.hover).toHaveBeenLastCalledWith(null); expect(seen.at(-1)).toBeNull(); expect(readout(vp)).toBe('指向柱子查看数值')
})
it('BarMatrix3D: empty values say so and set nothing, as tall as the matrix with its readout (and legend)', async () => {
  for (const extra of [{}, { colorValues: [] as number[][] }]) {
    const root = createFakeRoot()
    mountGlass(() => inBlock(() => h(BarMatrix3D, { rows: ROWS, cols: COLS, values: [], height: 240, ...extra })), { root }); await flush(); root.tick()
    const s = root.surfacesMade[0]!
    expect(JSON.stringify(tree(s.root))).toContain('暂无数据'); expect(s.attached).toEqual([])
    expect(root.barMatrices[0]!.set).not.toHaveBeenCalled()
    const empty = byText(s.root, '暂无数据')!.parent!
    const full = createFakeRoot(), f = await mounted(full, { rows: ROWS, cols: COLS, values: V, height: 240, ...('colorValues' in extra ? { colorValues: D } : {}) })
    expect(empty.layout.height).toBe(f.attached[0]!.node.parent!.layout.height)
    expect(empty.layout.height).toBeGreaterThanOrEqual(240 + 10 + 20)
  }
})
it('BarMatrix3D: values coming back after empty grow in again (the matrix lets go of its drawing), not from stale heights', async () => {
  const root = createFakeRoot(), values = ref<number[][]>(V)
  mountGlass(() => inBlock(() => h(BarMatrix3D, { rows: ROWS, cols: COLS, values: values.value })), { root }); await flush(); root.tick()
  const m = root.barMatrices[0]!
  expect(m.set).toHaveBeenCalledTimes(1); expect(m.dispose).not.toHaveBeenCalled()
  values.value = []; await nextTick()
  expect(m.dispose).toHaveBeenCalledTimes(1); expect(root.surfacesMade[0]!.attached).toEqual([])
  values.value = V; await nextTick(); await flush()
  expect(m.set).toHaveBeenCalledTimes(2)
  expect(m.dispose.mock.invocationCallOrder[0]!).toBeLessThan(m.set.mock.invocationCallOrder[1]!)
  expect(root.surfacesMade[0]!.attached.map(a => a.object)).toEqual([m])
})
it('BarMatrix3D errors name the prop: values and colorValues must be rows × cols', () => {
  const err = (props: Record<string, unknown>) => mountGlass(() => inBlock(() => h(BarMatrix3D, props))).errors[0]
  expect(err({ rows: ROWS, cols: COLS, values: [[1, 2, 3]] })).toMatch(/\[BarMatrix3D\.values\] .*2 行.*得到 1 行/)
  expect(err({ rows: ROWS, cols: COLS, values: [[1, 2, 3], [4, 5]] })).toMatch(/\[BarMatrix3D\.values\] .*第 2 行有 2 个.*cols 有 3 个/)
  expect(err({ rows: ROWS, cols: COLS, values: [[1, 2, 3], [4, 5, -6]] })).toMatch(/\[BarMatrix3D\.values\.1\.2\]/)
  expect(err({ rows: ROWS, cols: COLS, values: V, colorValues: [[1, 2, 3]] })).toMatch(/\[BarMatrix3D\.colorValues\] .*2 行.*得到 1 行/)
  expect(err({ rows: ROWS, cols: COLS, values: V, colorValues: [[1, 2, 3], [4, 5, 6, 7]] })).toMatch(/\[BarMatrix3D\.colorValues\] .*第 2 行有 4 个.*应为 3 个/)
  expect(err({ rows: ROWS, cols: COLS, values: [], colorValues: D })).toMatch(/\[BarMatrix3D\.colorValues\] .*0 行.*得到 2 行/)
  expect(err({ rows: ROWS, cols: COLS, values: V, colorValues: [[1, 2, 3], [4, 5, NaN]] })).toMatch(/\[BarMatrix3D\.colorValues\.1\.2\]/)
  expect(err({ rows: [], cols: COLS, values: [] })).toMatch(/\[BarMatrix3D\.rows\] 至少 1 项/)
  expect(err({ rows: ROWS, cols: COLS, values: V, colorRamp: ['accent'] })).toMatch(/\[BarMatrix3D\.colorRamp\]/)
  expect(err({ rows: ROWS, cols: COLS, values: V, colorRamp: ['acent', '#fff'] })).toMatch(/\[BarMatrix3D\.colorRamp\.0\] 未知颜色 token "acent"/)
})
it('BarMatrix3D is registered with complete manifest metadata', () => {
  const c = glassComponents().find(g => g.glass.name === 'BarMatrix3D')!
  expect(c).toBeDefined()
  expect(c.glass.description.length).toBeGreaterThan(40); expect(c.glass.examples.length).toBeGreaterThanOrEqual(2); expect(c.glass.examples.length).toBeLessThanOrEqual(3)
  const shape = c.glass.props.shape as Record<string, { description?: string }>
  expect(Object.keys(shape).sort()).toEqual(['colorFormat', 'colorLabel', 'colorRamp', 'colorValues', 'cols', 'format', 'height', 'max', 'rows', 'values'])
  for (const [k, s] of Object.entries(shape)) expect(s.description, `BarMatrix3D.${k}`).toMatch(/[一-鿿]/)
  expect(shape.max!.description).toMatch(/封顶/)
  expect(shape.colorRamp!.description).toContain('#34c759')
  for (const e of c.glass.examples) expect(e).toMatch(/^<Space\b[^]*<BarMatrix3D\b[^]*<\/Space>$/)
  expect(c.glass.examples.some(e => /color-values/.test(e))).toBe(true); expect(c.glass.examples[0]).toContain('color-label="周转"')
  expect(c.glass.mistakes!.length).toBeGreaterThanOrEqual(2)
  expect(c.glass.mistakes!.map(m => m.mistake).join('\n')).toMatch(/values/)
  expect(Object.keys(c.glass.events!)).toEqual(['hover', 'select'])
})
