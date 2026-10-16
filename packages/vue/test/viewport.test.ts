import { it, expect } from 'vitest'
import { h, nextTick, ref, toRaw, type VNodeChild } from '@vue/runtime-core'
import { defaultTheme, resolveColor, type UIEvent } from '@glassui/core'
import { formatValue, niceMax } from '../src/chart'
import { Space } from '../src/components/Space'
import { Block } from '../src/components/Block'
import { ScreenLayer, Surface } from '../src/components/Surface'
import { Viewport3D } from '../src/components/Viewport3D'
import { BarChart3D } from '../src/components/BarChart3D'
import { glassComponents } from '../src/define'
import { createFakeRoot, flush } from './fixtures/fake-root'
import { mountGlass } from './fixtures/mount'
import { byId, tree } from './fixtures/tree'

const inBlock = (child: () => VNodeChild) => h(Space, { camera: false }, () => [h(Block, { name: 'a', width: 488, height: 488 }, () => [child()])])

it('niceMax and formatValue', () => {
  expect([0, 0.3, 5, 17, 101, 236, 186].map(niceMax)).toEqual([1, 0.3, 5, 20, 150, 250, 200]); expect(formatValue(1.5)).toBe('1.5'); expect(formatValue(2)).toBe('2'); expect(formatValue(1 / 3)).toBe('0.33')
})
it('Viewport3D attaches its object to its own box, re-attaches on change, detaches on unmount', async () => {
  const root = createFakeRoot(), obj = ref<object>({ isObject3D: true }), show = ref(true)
  mountGlass(() => inBlock(() => show.value ? h(Viewport3D, { id: 'vp', object: obj.value, depth: 40 }) : null), { root }); await flush()
  const s = root.surfacesMade[0]!
  expect(s.attached).toEqual([{ node: byId(s.root, 'vp'), object: obj.value, opts: { depth: 40 } }])
  obj.value = { isObject3D: true }; await flush(); expect(s.attached.map(a => a.object)).toEqual([obj.value])
  expect(s.attached[0]!.object).toBe(toRaw(obj.value))                         // the new object itself, never a reactive proxy
  show.value = false; await nextTick(); expect(s.attached).toEqual([])
})
it('Viewport3D re-emits pointer events with the object', async () => {
  const root = createFakeRoot(), moves: unknown[] = [], obj = { isObject3D: true }
  mountGlass(() => inBlock(() => h(Viewport3D, { id: 'vp', object: obj, onPointermove: (e: UIEvent) => moves.push(e.object) })), { root }); await flush(); root.tick()
  const s = root.surfacesMade[0]!; s.pointer.move(-999, -999, 'mouse', { node: byId(s.root, 'vp')!, object: obj })
  expect(moves).toEqual([obj])
})
it('Viewport3D refuses a scroll ancestor and a non-object', async () => {
  const a = mountGlass(() => inBlock(() => h('scroll', null, [h(Viewport3D, { object: { isObject3D: true } })]))); await flush()
  expect(a.errors.join()).toMatch(/\[Viewport3D\] 不能放在 scroll 里/)
  expect(mountGlass(() => inBlock(() => h(Viewport3D, { object: 3 as never }))).errors[0]).toMatch(/\[Viewport3D\.object\]/)
})
it('Viewport3D on a screen Surface: the render error reaches the app', async () => {
  const m = mountGlass(() => h(ScreenLayer, () => [h(Surface, { width: 200, height: 100 }, () => [h(Viewport3D, { object: { isObject3D: true } })])])); await flush()
  expect(m.errors.join()).toMatch(/\[Surface\.attach3D\] 只能挂在世界层 Surface 上/)
})
it('BarChart3D sets the chart from data with a nice max and theme colours', async () => {
  const root = createFakeRoot()
  mountGlass(() => inBlock(() => h(BarChart3D, { data: [{ label: '一', value: 3 }, { label: '二', value: 17, color: 'danger' }] })), { root }); await flush()
  const chart = root.charts[0]!
  expect(chart.set).toHaveBeenLastCalledWith({ values: [3, 17], max: 20, colors: [resolveColor('accent', defaultTheme, 'light'), resolveColor('danger', defaultTheme, 'light')] })
  root.emit('theme', { theme: root.theme, scheme: 'dark', contrast: false }); await nextTick()
  expect(chart.set).toHaveBeenLastCalledWith({ values: [3, 17], max: 20, colors: [resolveColor('accent', defaultTheme, 'dark'), resolveColor('danger', defaultTheme, 'dark')] })
})
it('BarChart3D: one label column per bar; hover shows the formatted value over its bar; click selects', async () => {
  const root = createFakeRoot(), picked: unknown[] = []
  mountGlass(() => inBlock(() => h(BarChart3D, { data: [{ label: 'A', value: 1 }, { label: 'B', value: 2 }], format: (v: number) => `${v} 次`, onSelect: (e: unknown) => picked.push(e) })), { root })
  await flush(); root.tick()
  const s = root.surfacesMade[0]!, vp = s.attached[0]!.node, bar = { isObject3D: true, userData: { index: 1 } }
  // two equal label columns under the chart box, as wide as it
  const box = vp.parent!, labels = box.parent!.children[1]!
  expect(labels.children.map(c => c.layout.width)).toEqual([box.layout.width / 2, box.layout.width / 2])
  s.pointer.move(-999, -999, 'mouse', { node: vp, object: bar }); await nextTick(); root.tick()
  expect(root.charts[0]!.hover).toHaveBeenLastCalledWith(1)
  expect(JSON.stringify(tree(s.root))).toContain('2 次')
  // the tag: centred on bar 1's column, 8 pt over its top (2 of max 2: the full 200 pt)
  const tag = box.children.find(c => c !== vp && c.type === 'box')!
  expect(tag.style).toMatchObject({ position: 'absolute', left: box.layout.width / 2 * 1.5 - 40, bottom: 208, width: 80 })
  s.pointer.down(-999, -999, 'mouse', { node: vp, object: bar }); s.pointer.up(-999, -999, 'mouse', { node: vp, object: bar })
  expect(picked).toEqual([{ index: 1, label: 'B', value: 2 }])
  s.pointer.move(-999, -999, 'mouse'); await nextTick(); expect(root.charts[0]!.hover).toHaveBeenLastCalledWith(null)
  expect(JSON.stringify(tree(s.root))).not.toContain('2 次')
})
it('BarChart3D: a hovered bar the data drops is hovered no more', async () => {
  const root = createFakeRoot(), two = [{ label: 'A', value: 1 }, { label: 'B', value: 2 }], data = ref(two)
  mountGlass(() => inBlock(() => h(BarChart3D, { data: data.value })), { root }); await flush(); root.tick()
  const s = root.surfacesMade[0]!, vp = s.attached[0]!.node
  s.pointer.move(-999, -999, 'mouse', { node: vp, object: { isObject3D: true, userData: { index: 1 } } }); await nextTick(); root.tick()
  expect(JSON.stringify(tree(s.root))).toContain('"value":"2"')
  data.value = [{ label: 'A', value: 1 }]; await nextTick()
  expect(root.charts[0]!.hover).toHaveBeenLastCalledWith(null)
  data.value = two; await nextTick(); root.tick(); await flush()
  expect(JSON.stringify(tree(s.root))).not.toContain('"value":"2"')            // no stale tag when the bar comes back
})
it('BarChart3D with no data says so and attaches nothing; a negative value is an error', async () => {
  const root = createFakeRoot()
  mountGlass(() => inBlock(() => h(BarChart3D, { data: [] })), { root }); await flush()
  expect(JSON.stringify(tree(root.surfacesMade[0]!.root))).toContain('暂无数据'); expect(root.surfacesMade[0]!.attached).toEqual([])
  expect(root.charts[0]!.set).not.toHaveBeenCalled()
  expect(mountGlass(() => inBlock(() => h(BarChart3D, { data: [{ label: 'x', value: -1 }] }))).errors[0]).toMatch(/\[BarChart3D\.data/)
})
it('a leaving Block keeps its chart attached until its Surface goes', async () => {
  const root = createFakeRoot(), show = ref(true)
  mountGlass(() => h(Space, { camera: false }, () => [show.value ? h(Block, { name: 'a', width: 488, height: 488 }, () => [h(BarChart3D, { data: [{ label: 'A', value: 1 }] })]) : null]), { root }); await flush()
  const s = root.surfacesMade[0]!; show.value = false; await nextTick()
  expect(s.attached.length).toBe(1); expect(root.charts[0]!.dispose).not.toHaveBeenCalled()
  root.tick(); await flush(); expect(root.charts[0]!.dispose).toHaveBeenCalled()
})
it('a BarChart3D unmounted from a staying Block detaches and disposes its chart at once', async () => {
  const root = createFakeRoot(), show = ref(true)
  mountGlass(() => inBlock(() => show.value ? h(BarChart3D, { data: [{ label: 'A', value: 1 }] }) : null), { root }); await flush()
  const s = root.surfacesMade[0]!; expect(s.attached.length).toBe(1)
  show.value = false; await nextTick()
  expect(s.attached).toEqual([]); expect(root.charts[0]!.dispose).toHaveBeenCalledTimes(1)
})
it('Viewport3D and BarChart3D are registered with complete manifest metadata', () => {
  for (const name of ['Viewport3D', 'BarChart3D']) {
    const c = glassComponents().find(g => g.glass.name === name)!
    expect(c, name).toBeDefined()
    expect(c.glass.description.length).toBeGreaterThan(40); expect(c.glass.examples.length).toBeGreaterThanOrEqual(2); expect(c.glass.examples.length).toBeLessThanOrEqual(3)
    expect(c.glass.mistakes!.length).toBeGreaterThan(0)
    for (const [k, s] of Object.entries(c.glass.props.shape)) expect((s as { description?: string }).description, `${name}.${k}`).toMatch(/[一-鿿]/)
    for (const e of c.glass.examples) expect(e).toMatch(/^<Space\b[^]*<\/Space>$/)   // they live in a Block
  }
  expect(Object.keys(glassComponents().find(g => g.glass.name === 'Viewport3D')!.glass.events!)).toEqual(['pointerenter', 'pointerleave', 'pointermove', 'click'])
})
