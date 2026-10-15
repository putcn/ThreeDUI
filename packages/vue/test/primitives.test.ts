import { it, expect } from 'vitest'
import { h, nextTick, ref } from '@vue/runtime-core'
import { defaultTheme, resolveColor, type Theme } from '@glassui/core'
import { glassComponents } from '../src/define'
import { Box } from '../src/components/Box'
import { Text } from '../src/components/Text'
import { Icon } from '../src/components/Icon'
import { Stack } from '../src/components/Stack'
import { ICON_NAMES, iconCanvas } from '../src/icons'
import { createFakeRoot } from './fixtures/fake-root'
import { first, mountGlass, napiCanvas } from './fixtures/mount'

it('Text renders a text node with its typography', () => {
  const { c } = mountGlass(() => h(Text, { value: '你好', size: 20, weight: 600, color: 'secondaryLabel' }))
  const t = first(c, 'text')
  expect(t.props.value).toBe('你好'); expect(t.style).toMatchObject({ fontSize: 20, fontWeight: 600, color: 'secondaryLabel' })
})
it('Text takes slot text', () => {
  const { c } = mountGlass(() => h(Text, null, () => 'from slot'))
  expect(first(c, 'text').props.value).toBe('from slot')
})
it('Text fragments render as a wrapping row of runs', () => {
  const { c } = mountGlass(() => h(Text, { value: [{ text: 'A ' }, { text: 'link', color: 'accent', weight: 700 }] }))
  const row = first(c, 'box'); expect(row.style).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' })
  expect(row.children.map(n => n.props.value)).toEqual(['A ', 'link'])
})
it('Icon rasterises at 2× into a cached canvas; an unknown name suggests (Review Focus 5)', () => {
  const { c } = mountGlass(() => h('box', [h(Icon, { name: 'check', size: 20 }), h(Icon, { name: 'check', size: 20 })]))
  const [a, b] = c.children[0]!.children.filter(n => n.type === 'image')
  expect((a!.props.src as { width: number }).width).toBe(40); expect(a!.props.src).toBe(b!.props.src)
  expect(mountGlass(() => h(Icon, { name: 'chek' })).errors[0]).toMatch(/\[Icon\.name\] 非法取值 "chek".*你可能想要：check/)
})
it('Stack maps direction, gap, align and justify; z stacks children', () => {
  const { c } = mountGlass(() => h(Stack, { direction: 'horizontal', gap: 12, align: 'center', justify: 'between' }, () => [h(Box), h(Box)]))
  expect(first(c, 'box').style).toMatchObject({ flexDirection: 'row', gap: 12, alignItems: 'center', justifyContent: 'space-between' })
  const z = mountGlass(() => h(Stack, { direction: 'z' }, () => [h(Box), h(Box)])).c
  expect(first(z, 'box').children.every(w => w.style.position === 'absolute' && w.style.inset === 0)).toBe(true)
})

// ── beyond the brief's five ──

it('Text maps maxLines, align and wrap; absent props leave no style keys', () => {
  const { c } = mountGlass(() => h('box', [h(Text, { value: 'a', maxLines: 2, align: 'center', wrap: false }), h(Text, { value: 'b' })]))
  const [a, b] = c.children[0]!.children
  expect(a!.style).toEqual({ maxLines: 2, textAlign: 'center', wrap: false }); expect(b!.style).toEqual({})
})
it('Text takes template-style slot text (several text vnodes, a v-if comment) and rejects anything else in the slot', () => {
  const { c } = mountGlass(() => h(Text, null, () => ['a', 'b', null]))
  expect(first(c, 'text').props.value).toBe('ab')
  expect(mountGlass(() => h(Text, null, () => [h('box')])).errors[0]).toMatch(/\[Text\] 默认插槽只能是纯文本/)
})
it('Text: a fragment run keeps the Text\'s typography and overrides it; align moves the row; wrap: false keeps one row', () => {
  const { c } = mountGlass(() => h(Text, { value: [{ text: 'A' }, { text: 'B', size: 30, color: '#ff0000', weight: 800 }], size: 'lg', color: 'secondaryLabel', align: 'right', wrap: false }))
  const row = first(c, 'box')
  expect(row.style).toMatchObject({ flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'flex-end' })
  expect(row.children.map(n => n.style)).toEqual([
    { fontSize: 'lg', color: 'secondaryLabel', wrap: false },
    { fontSize: 30, color: '#ff0000', fontWeight: 800, wrap: false },
  ])
})
it('Text: an unknown colour or fontSize token is a readable error at render (not a failed Surface later); a string number hints at :size', () => {
  expect(mountGlass(() => h(Text, { value: 'x', color: 'secondarylabel' })).errors[0]).toMatch(/\[Text\.color\] 未知颜色 token "secondarylabel"。允许值：.*你可能想要：secondaryLabel/)
  expect(mountGlass(() => h(Text, { value: 'x', color: '#12' })).errors[0]).toMatch(/\[Text\.color\] 非法颜色 "#12"/)
  expect(mountGlass(() => h(Text, { value: 'x', size: 'xxl' })).errors[0]).toMatch(/\[Text\.size\] 未知字号 token "xxl"。允许值：xs, sm, base.*你可能想要：xl/)
  expect(mountGlass(() => h(Text, { value: 'x', size: '20' })).errors[0]).toMatch(/\[Text\.size\] 类型应为 number 或 fontSize token，得到字符串 "20"（模板里数字要写成 :size="20"）$/)
  expect(mountGlass(() => h(Text, { value: [{ text: 'x', color: 'acent' }] })).errors[0]).toMatch(/\[Text\.value\.0\.color\] 未知颜色 token "acent".*你可能想要：accent/)
})
it('Icon: size, default colour and stroke; the colour token resolves against the scheme and a scheme change redraws', async () => {
  const root = createFakeRoot()
  const { c, errors } = mountGlass(() => h(Icon, { name: 'star' }), { root })
  const img = first(c, 'image'), light = img.props.src as { width: number }
  expect(errors).toEqual([])
  expect(light.width).toBe(48); expect(img.style).toEqual({ width: 24, height: 24, flexShrink: 0 })
  expect(light).toBe(iconCanvas('star', 24, resolveColor('label', defaultTheme, 'light'), 0.1, napiCanvas))
  root.emit('theme', { theme: root.theme, scheme: 'dark', contrast: false }); await nextTick()
  expect(img.props.src).not.toBe(light)
  expect(img.props.src).toBe(iconCanvas('star', 24, resolveColor('label', defaultTheme, 'dark'), 0.1, napiCanvas))
})
it('Icon: a theme swap with the same scheme redraws too', async () => {
  const root = createFakeRoot(), theme: Theme = { ...defaultTheme, colors: { ...defaultTheme.colors, light: { ...defaultTheme.colors.light, accent: '#00ff00' } } }
  const { c } = mountGlass(() => h(Icon, { name: 'plus', color: 'accent' }), { root })
  const img = first(c, 'image'), before = img.props.src
  root.emit('theme', { theme, scheme: 'light', contrast: false }); await nextTick()
  expect(img.props.src).not.toBe(before)
  expect(img.props.src).toBe(iconCanvas('plus', 24, [0, 1, 0, 1], 0.1, napiCanvas))
})
it('Icon: an unknown colour token and a string size are readable errors', () => {
  expect(mountGlass(() => h(Icon, { name: 'x', color: 'blu' })).errors[0]).toMatch(/\[Icon\.color\] 未知颜色 token "blu"/)
  expect(mountGlass(() => h(Icon, { name: 'x', size: '20' })).errors[0]).toMatch(/\[Icon\.size\] 类型应为 number，得到 string.*:prop/)
})
it('iconCanvas: every built-in icon draws something, centred on its 2× canvas; the cache is per name, size, colour, stroke and factory', () => {
  expect(ICON_NAMES).toEqual(['user', 'mail', 'lock', 'eye', 'check', 'x', 'arrow-right', 'apple', 'google',
    'eye-slash', 'chevron-left', 'chevron-right', 'chevron-up', 'chevron-down', 'plus', 'minus', 'search', 'gear', 'info', 'warning', 'star', 'heart'])
  const black: [number, number, number, number] = [0, 0, 0, 1]
  for (const name of ICON_NAMES) {
    const cv = iconCanvas(name, 24, black, 0.1, napiCanvas)
    const { data } = cv.getContext('2d').getImageData(0, 0, 48, 48)
    let ink = 0, sx = 0, sy = 0
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) { ink++; sx += (i >> 2) % 48; sy += Math.floor((i >> 2) / 48) }
    expect(ink, name).toBeGreaterThan(40)
    expect(Math.abs(sx / ink - 24), `${name} x centre`).toBeLessThan(8); expect(Math.abs(sy / ink - 24), `${name} y centre`).toBeLessThan(8)
  }
  const a = iconCanvas('heart', 20, black, 0.1, napiCanvas)
  expect(iconCanvas('heart', 20, black, 0.1, napiCanvas)).toBe(a)
  for (const other of [iconCanvas('star', 20, black, 0.1, napiCanvas), iconCanvas('heart', 21, black, 0.1, napiCanvas), iconCanvas('heart', 20, [1, 0, 0, 1], 0.1, napiCanvas),
    iconCanvas('heart', 20, black, 0.12, napiCanvas), iconCanvas('heart', 20, black, 0.1, (w, hh) => napiCanvas(w, hh))]) expect(other).not.toBe(a)
})
it('Stack: vertical with gap 8 by default; start/end/stretch map to flex values; children keep their order and keys', async () => {
  const { c } = mountGlass(() => h(Stack, null, () => [h(Box, { id: 'a' })]))
  expect(first(c, 'box').style).toEqual({ flexDirection: 'column', gap: 8 })
  const { c: c2 } = mountGlass(() => h(Stack, { align: 'stretch', justify: 'end', wrap: true }, () => [h(Box)]))
  expect(first(c2, 'box').style).toMatchObject({ alignItems: 'stretch', justifyContent: 'flex-end', flexWrap: 'wrap' })
  const order = ref(['a', 'b', 'c'])
  const { c: c3 } = mountGlass(() => h(Stack, { direction: 'z', style: { width: 40, height: 40 } }, () => order.value.map(k => h(Box, { key: k, id: k }))))
  const z = first(c3, 'box'), wrappers = [...z.children]
  expect(z.style).toEqual({ width: 40, height: 40 })
  order.value = ['c', 'a', 'b']; await nextTick()
  expect(z.children.map(w => w.children[0]!.id)).toEqual(['c', 'a', 'b'])
  for (const [i, w] of [wrappers[2], wrappers[0], wrappers[1]].entries()) expect(z.children[i]).toBe(w)   // moved, not rebuilt
})
it('Stack z: v-for fragments are flattened and v-if comments dropped, one wrapper per child', () => {
  const show = false
  const { c } = mountGlass(() => h(Stack, { direction: 'z' }, () => [h(Box, { id: 'base' }), show ? h(Box) : null, ...['p', 'q'].map(k => h(Box, { key: k, id: k }))]))
  expect(first(c, 'box').children.map(w => w.children[0]!.id)).toEqual(['base', 'p', 'q'])
})
it('Box renders its slot in a box and takes style, tw and class', () => {
  const { c } = mountGlass(() => h(Box, { id: 'b', tw: 'p-4', style: { bg: 'accent' } }, () => [h(Text, { value: 'in' })]))
  const b = first(c, 'box')
  expect(b.id).toBe('b'); expect(b.style).toEqual({ padding: 16, bg: 'accent' }); expect(first(b, 'text').props.value).toBe('in')
})
it('the primitives are registered with complete manifest metadata', () => {
  const byName = new Map(glassComponents().map(c => [c.glass.name, c.glass]))
  for (const name of ['Box', 'Text', 'Icon', 'Stack']) {
    const m = byName.get(name)!
    expect(m, name).toBeDefined()
    expect(m.description.length, name).toBeGreaterThan(10)
    expect(m.examples.length, name).toBeGreaterThanOrEqual(2); expect(m.examples.length, name).toBeLessThanOrEqual(3)
    for (const ex of m.examples) expect(ex, name).toMatch(new RegExp(`^<${name}[\\s>/]`))
    for (const [k, s] of Object.entries(m.props.shape)) expect((s as { description?: string }).description, `${name}.${k}`).toBeTruthy()
  }
  expect(byName.get('Icon')!.mistakes).toEqual(expect.arrayContaining([{ mistake: 'size="20" (a string)', fix: ':size="20"' }, { mistake: 'name="close"', fix: 'name="x"' }]))
})
