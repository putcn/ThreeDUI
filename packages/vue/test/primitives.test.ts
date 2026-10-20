import { it, expect, vi } from 'vitest'
import { createCommentVNode, createTextVNode, Fragment, h, nextTick, ref } from '@vue/runtime-core'
import { createCanvas } from '@napi-rs/canvas'
import { defaultTheme, hitTest, resolveColor, type Theme } from '@glassui/core'
import { SystemFontEngine } from '@glassui/text'
import { createGlassApp } from '../src/app'
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
  // a run's edge spaces become no-break spaces, which the text engine keeps (fix round 1, D13): brief expected 'A '
  expect(row.children.map(n => n.props.value)).toEqual(['A\u00a0', 'link'])
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
  expect(mountGlass(() => h(Text, null, () => [h('box')])).errors[0]).toMatch(/\[Text\.default\] 默认插槽只能是纯文本/)
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
    'eye-slash', 'chevron-left', 'chevron-right', 'chevron-up', 'chevron-down', 'plus', 'minus', 'search', 'gear', 'info', 'warning', 'star', 'heart',
    'grid', 'chart', 'list', 'map', 'cube', 'inbox', 'refresh', 'logout'])
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

// ── fix round 1 ──

it('a bad fragment is reported at its field: wrong type, missing key, unknown key with a suggestion (B1)', () => {
  expect(mountGlass(() => h(Text, { value: [{ text: 'a', weight: '600' }] })).errors[0]).toMatch(/\[Text\.value\.0\.weight\] 类型应为 number，得到 string（模板里数字和布尔值要写成 :prop="…"）$/)
  expect(mountGlass(() => h(Text, { value: [{ txt: 'a' }] })).errors[0]).toMatch(/\[Text\.value\.0\.text\] 缺少必填属性/)
  expect(mountGlass(() => h(Text, { value: [{ text: 'a' }, { text: 'b', colour: 'red' }] })).errors[0]).toMatch(/\[Text\.value\.1\] 未知属性 "colour"。允许值：text, color, weight, size。你可能想要：color$/)
})
it('out-of-range numbers read in Chinese with their bounds; a custom message is kept (C5)', () => {
  expect(mountGlass(() => h(Text, { value: 'x', weight: 1000 })).errors[0]).toMatch(/\[Text\.weight\] 超出范围（100–900），得到 1000$/)
  expect(mountGlass(() => h(Icon, { name: 'x', weight: 0.9 })).errors[0]).toMatch(/\[Icon\.weight\] 超出范围（0–0\.5），得到 0\.9$/)
  expect(mountGlass(() => h(Text, { value: 'x', maxLines: 0 })).errors[0]).toMatch(/\[Text\.maxLines\] 不能小于 1，得到 0$/)
  expect(mountGlass(() => h(Stack, { gap: -1 })).errors[0]).toMatch(/\[Stack\.gap\] 不能小于 0，得到 -1$/)
  expect(mountGlass(() => h(Text, { value: [{ text: 'a', size: -3 }] })).errors[0]).toMatch(/\[Text\.value\.0\.size\] 应大于 0，得到 -3$/)
})
it('Stack: a tw / class layout class that its props would override is an error naming the prop to use (B2)', () => {
  const err = (attrs: Record<string, unknown>) => mountGlass(() => h(Stack, attrs, () => [h(Box)])).errors[0]
  expect(err({ tw: 'gap-4' })).toMatch(/\[Stack\.tw\] "gap-4" 与 Stack 的 gap 属性冲突.*：用 :gap="16"$/)
  expect(err({ class: ['p-2', 'flex-row'] })).toMatch(/\[Stack\.class\] "flex-row" 与 Stack 的 direction 属性冲突.*用 direction="horizontal"$/)
  expect(err({ tw: 'p-4 items-center' })).toMatch(/\[Stack\.tw\] "items-center" 与 Stack 的 align 属性冲突.*用 align="center"$/)
  expect(err({ tw: 'justify-between' })).toMatch(/用 justify="between"$/)
  expect(err({ tw: 'flex-wrap' })).toMatch(/\[Stack\.tw\] "flex-wrap" 与 Stack 的 wrap 属性冲突.*用 wrap（布尔属性）$/)
  const ok = mountGlass(() => h(Stack, { tw: 'p-4 bg-accent rounded-lg' }, () => [h(Box)]))
  expect(ok.errors).toEqual([]); expect(first(ok.c, 'box').style).toMatchObject({ padding: 16, bg: 'accent', radius: 'lg', flexDirection: 'column', gap: 8 })
})
it('Stack z: the pointer passes through a layer\'s empty area to the layer below (B3)', () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 200, height: 200 })
  const app = createGlassApp({ render: () => h(Stack, { direction: 'z', style: { width: 100, height: 100 } }, () => [
    h(Box, { id: 'base', tw: 'w-full h-full' }),
    h(Box, { id: 'badge', style: { width: 20, height: 20 } }),
  ]) }, { root, createCanvas: napiCanvas })
  app.mount(s as never); root.tick()
  expect(hitTest(s.root, 80, 80)!.id).toBe('base')     // outside the badge: through the top layer's empty area
  expect(hitTest(s.root, 10, 10)!.id).toBe('badge')
})
it('Stack z: inside a pointerEvents \'none\' Box no layer is hit; the layer boxes are \'box-none\' and the children keep their own style', () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 200, height: 200 })
  const app = createGlassApp({ render: () => h(Box, { id: 'off', style: { pointerEvents: 'none' } }, () => [
    h(Stack, { direction: 'z', style: { width: 100, height: 100 } }, () => [
      h(Box, { id: 'base', tw: 'w-full h-full' }),
      h(Box, { id: 'badge', style: { width: 20, height: 20 } }),
    ]),
  ]) }, { root, createCanvas: napiCanvas })
  app.mount(s as never); root.tick()
  expect(hitTest(s.root, 80, 80)!.id).toBe(s.root.id)  // the base layer inherits 'none' from the Box above the Stack
  expect(hitTest(s.root, 10, 10)!.id).toBe(s.root.id)  // the badge too
  const z = first(s.root, 'box').children[0]!
  expect(z.children.map(w => w.style.pointerEvents)).toEqual(['box-none', 'box-none'])
  expect(z.children.map(w => w.children[0]!.style)).toEqual([{ width: '100%', height: '100%' }, { width: 20, height: 20 }])   // nothing injected
})
it('Text: a slot\'s edge whitespace is trimmed (template condensing); value and a slot together are an error (C4)', () => {
  expect(first(mountGlass(() => h(Text, null, () => ['\n  很长的说明文字', ' 第二行  \n'])).c, 'text').props.value).toBe('很长的说明文字 第二行')
  expect(mountGlass(() => h(Text, { value: 'a' }, () => 'b')).errors[0]).toMatch(/\[Text\] value 和默认插槽不能同时给出：二选一/)
})
it('Text: value with a slot that renders nothing (a template comment, empty, whitespace, a false v-if) is no error; with content it is', () => {
  // `<Text value="x"><!-- note --></Text>` in a dev build: the slot yields a comment vnode
  for (const slot of [() => [createCommentVNode(' note ')], () => [], () => null, () => ['\n  ', createTextVNode(' ')], () => [false, h(Fragment, [])]]) {
    const { c, errors } = mountGlass(() => h(Text, { value: 'x' }, slot))
    expect(errors).toEqual([]); expect(first(c, 'text').props.value).toBe('x')
  }
  for (const slot of [() => [createCommentVNode('c'), ' y '], () => [h(Fragment, [createTextVNode('y')])], () => [h(Icon, { name: 'star' })]]) {
    expect(mountGlass(() => h(Text, { value: 'x' }, slot)).errors).toEqual([expect.stringMatching(/\[Text\] value 和默认插槽不能同时给出：二选一/)])
  }
})
it('Stack z: a v-if branch key and a v-for item key never collide; a keyed reorder in the v-for moves its layers (C6)', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const show = ref(true), order = ref([0, 1])
  // as a template compiles `<Box v-if="show" /><Box v-for="k in order" :key="k" />`: the v-if branch is keyed 0
  const { c, errors } = mountGlass(() => h(Stack, { direction: 'z', style: { width: 10, height: 10 } }, () => [
    show.value ? h(Box, { key: 0, id: 'top' }) : null, h(Fragment, order.value.map(k => h(Box, { key: k, id: `f${k}` }))),
  ]))
  const z = first(c, 'box'), ids = () => z.children.map(w => w.children[0]!.id), [, w0, w1] = z.children
  expect(ids()).toEqual(['top', 'f0', 'f1'])
  show.value = false; await nextTick()
  expect(ids()).toEqual(['f0', 'f1']); expect(z.children[0]).toBe(w0); expect(z.children[1]).toBe(w1)   // not top's layer renamed
  order.value = [1, 0]; await nextTick()
  expect(ids()).toEqual(['f1', 'f0']); expect(z.children[0]).toBe(w1); expect(z.children[1]).toBe(w0)
  expect(errors).toEqual([]); expect(warn).not.toHaveBeenCalled()
  warn.mockRestore()
})
it('Icon: a name from another icon set suggests ours (C9)', () => {
  expect(mountGlass(() => h(Icon, { name: 'close' })).errors[0]).toMatch(/\[Icon\.name\] 非法取值 "close"。允许值：user, mail,.*logout。你可能想要：x$/)
  expect(mountGlass(() => h(Icon, { name: 'Settings' })).errors[0]).toMatch(/你可能想要：gear$/)
  expect(mountGlass(() => h(Icon, { name: 'constructor' })).errors[0]).toMatch(/\[Icon\.name\] 非法取值 "constructor"。允许值：[^。]*$/)   // own entries only
})
it('Text: fragments with maxLines are an error (C12)', () => {
  expect(mountGlass(() => h(Text, { value: [{ text: 'a' }], maxLines: 2 })).errors[0]).toMatch(/\[Text\.maxLines\] 片段数组不支持 maxLines/)
})
it('the text engine keeps a no-break space at a run\'s end, where it hangs an ordinary one (D13)', () => {
  const engine = new SystemFontEngine({ createCanvas: (w, hh) => createCanvas(w, hh) as never, pageSize: 256 })
  const run = (text: string) => ({ text, font: { family: 'sans-serif', size: 20, weight: 400 } })
  const a = engine.measure(run('A'), {}).width
  expect(engine.measure(run('A '), {}).width).toBe(a)                         // why the runs need it
  expect(engine.measure(run('A '), {}).width).toBeGreaterThan(a + 2)       // a space's advance
  expect(engine.measure(run(' A'), {}).width).toBeGreaterThan(a + 2)
  expect(engine.layout(run('A '), undefined, 'left').map(g => g.char)).toEqual(['A'])   // drawn as a gap
  const { c } = mountGlass(() => h(Text, { value: [{ text: '状态 ' }, { text: '  ·  ' }, { text: 'a b' }] }))
  expect(first(c, 'box').children.map(n => n.props.value)).toEqual(['状态 ', '  ·  ', 'a b'])
})
