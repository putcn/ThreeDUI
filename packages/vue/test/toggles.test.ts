import { it, expect } from 'vitest'
import { h, nextTick, ref } from '@vue/runtime-core'
import { absoluteRect, defaultTheme, resolveColor, type Node } from '@glassui/core'
import type { CanvasLike } from '@glassui/text'
import { glassComponents } from '../src/define'
import { Switch } from '../src/components/Switch'
import { Checkbox } from '../src/components/Checkbox'
import { Surface } from '../src/components/Surface'
import { Text } from '../src/components/Text'
import { controlStyle } from '../src/control'
import { glowingTint } from '../src/colors'
import { iconCanvas, knobCanvas } from '../src/icons'
import { createFakeRoot, flush } from './fixtures/fake-root'
import { all, first, mountGlass, napiCanvas } from './fixtures/mount'
import { bubble, fire } from './fixtures/events'
import { byId } from './fixtures/tree'

it('Switch toggles through v-model and moves the knob with a transition', async () => {
  const on = ref(false)
  const { c } = mountGlass(() => h(Switch, { checked: on.value, 'onUpdate:checked': (v: boolean) => { on.value = v } }))
  const sw = first(c, 'glass'), knob = first(sw, 'image')
  const offLeft = knob.style.left
  fire(sw, 'click'); await nextTick()
  expect(on.value).toBe(true)
  expect(knob.style.left).toBeGreaterThan(offLeft as number)
  expect(knob.style.transition).toMatchObject({ x: 'snappy' })
  expect(sw.style.glass).toMatchObject({ glow: { color: 'accent', strength: 1.1 } })
  fire(sw, 'keydown', { key: 'Enter' }); await nextTick(); expect(on.value).toBe(false)
  expect(sw.style.glass?.glow?.strength).toBe(0)
})
it('Switch knob stretches while pressed, keeping its outer edge', async () => {
  const { c } = mountGlass(() => h(Switch, { checked: true }))
  const sw = first(c, 'glass'), knob = first(sw, 'image')
  const right = (knob.style.left as number) + (knob.style.width as number)
  fire(sw, 'pointerdown', { pointerType: 'mouse' }); await nextTick()
  expect((knob.style.width as number)).toBeGreaterThan(48 + 8)
  expect((knob.style.left as number) + (knob.style.width as number)).toBe(right)
})
it('Checkbox shows a check, or a dash when indeterminate; the label toggles too', async () => {
  const v = ref(false)
  const { c } = mountGlass(() => h(Checkbox, { checked: v.value, label: '同意条款', 'onUpdate:checked': (x: boolean) => { v.value = x } }))
  expect(all(c, 'image')).toHaveLength(0)
  bubble(first(c, 'text'), 'click'); await nextTick()            // the label's click bubbles to the row's handler, as core dispatches it
  expect(v.value).toBe(true); expect(all(c, 'image')).toHaveLength(1)
  const d = mountGlass(() => h(Checkbox, { checked: false, indeterminate: true })).c
  expect(all(d, 'image')).toHaveLength(1)                       // the minus icon
})

// ── beyond the brief's tests ──

const KNOB_X = 136 / 2 - 7 - 48 / 2                              // 37: the knob centre's distance from the switch centre
/** A v-model'd Switch or Checkbox: the bound value and every `update:checked` / `change` it emitted, in order. */
function bound(comp: typeof Switch | typeof Checkbox, props: Record<string, unknown> = {}, opts: Parameters<typeof mountGlass>[1] = {}) {
  const value = ref(props.checked === true), got: string[] = []
  const m = mountGlass(() => h(comp, {
    ...props, checked: value.value,
    'onUpdate:checked': (x: boolean) => { got.push(`update:${x}`); value.value = x }, onChange: (x: boolean) => { got.push(`change:${x}`) },
  }), opts)
  return { ...m, value, got }
}

it('Switch geometry: the theme\'s 136 × 62 capsule; the knob decal is the 48 pt disc and 4 pt of shadow room, centred at W/2 ∓ 37', async () => {
  const { c, value } = bound(Switch)
  const sw = first(c, 'glass'), knob = first(sw, 'image')
  expect(sw.style).toMatchObject({ width: 136, height: 62, radius: 'capsule', flexShrink: 0 })
  expect(knob.style).toEqual({ position: 'absolute', left: 3, top: 3, width: 56, height: 56, transition: { x: 'snappy', width: 'snappy' } })
  expect((knob.style.left as number) + 28).toBe(136 / 2 - KNOB_X)
  expect(knob.props.src).toBe(knobCanvas(56, 48, napiCanvas))
  value.value = true; await nextTick()
  expect(knob.style).toMatchObject({ left: 77, width: 56 }); expect((knob.style.left as number) + 28).toBe(136 / 2 + KNOB_X)
})
it('Switch glass: on, the glowing tint and a glow split at the knob; off, the same glow at strength 0 split at the other knob, the tint white at no absorption (the untinted slab), so all of it animates smooth', async () => {
  const { c, value } = bound(Switch)
  const sw = first(c, 'glass')
  expect(sw.style.glass).toEqual({ glow: { color: 'accent', strength: 0, split: 0.5 - KNOB_X / 136 }, tint: '#ffffff', absorption: 0 })
  value.value = true; await nextTick()
  expect(sw.style.glass).toEqual({ glow: { color: 'accent', strength: 1.1, split: 0.5 + KNOB_X / 136 }, tint: glowingTint(defaultTheme, 'light'), absorption: 1.4 })
  expect(sw.style.transition).toEqual({ ...controlStyle().transition, glass: 'smooth' })
  expect(sw.style.hover).toEqual(controlStyle().hover); expect(sw.style.pressed).toEqual({ scale: 0.96 })
  expect(sw.props.tabIndex).toBe(0)
})
it('Switch on a live Surface: a toggle animates the glow\'s strength, split and tint and slides the knob', async () => {
  const root = createFakeRoot(), on = ref(false)
  mountGlass(() => h(Surface, { width: 400, height: 200 }, () => [h(Switch, { id: 'sw', checked: on.value })]), { root })
  await flush(); root.tick()
  const s = root.surfacesMade[0]!, sw = first(byId(s.root, 'sw')!, 'glass'), knob = first(sw, 'image')
  on.value = true; await nextTick(); root.tick()
  const g = sw.visual?.glass
  expect(g?.glowStrength).toBeGreaterThan(0); expect(g?.glowStrength).toBeLessThan(1.1)
  expect(g?.glowSplit).toBeGreaterThan(0.5 - KNOB_X / 136); expect(g?.glowSplit).toBeLessThan(0.5 + KNOB_X / 136)
  expect(g?.tint?.[0]).toBeGreaterThan(resolveColor(glowingTint(defaultTheme, 'light'), defaultTheme, 'light')[0]); expect(g?.tint?.[0]).toBeLessThan(1)
  expect(knob.visual?.x).toBeGreaterThan(3); expect(knob.visual?.x).toBeLessThan(77)
})
it('Switch knob: off, the stretch keeps the left edge; pressed, the decal is the capsule of the same height; released, the disc', async () => {
  const { c } = bound(Switch)
  const sw = first(c, 'glass'), knob = first(sw, 'image')
  fire(sw, 'pointerdown'); await nextTick()
  expect(knob.style).toMatchObject({ left: 3, width: 66, height: 56 })
  expect(knob.props.src).toBe(knobCanvas(56, 48, napiCanvas, 10))
  fire(sw, 'pointerup'); await nextTick()
  expect(knob.style).toMatchObject({ left: 3, width: 56 }); expect(knob.props.src).toBe(knobCanvas(56, 48, napiCanvas))
})
it('Switch: Space stretches and presses on keydown and toggles on keyup; a click on the label toggles; change follows update:checked', async () => {
  const { c, got } = bound(Switch, { label: '记住我' })
  const sw = first(c, 'glass'), knob = first(sw, 'image')
  fire(sw, 'keydown', { key: ' ' }); await nextTick()
  expect(sw.state.pressed).toBe(true); expect(knob.style.width).toBe(66); expect(got).toEqual([])
  fire(sw, 'keyup', { key: ' ' }); await nextTick()
  expect(sw.state.pressed).toBe(false); expect(knob.style).toMatchObject({ left: 77, width: 56 })
  bubble(first(c, 'text'), 'click'); await nextTick()
  fire(sw, 'click', { pointerType: 'touch' }); await nextTick()
  expect(got).toEqual(['update:true', 'change:true', 'update:false', 'change:false', 'update:true', 'change:true'])
})
it('Switch label: left of the switch, 16 pt away, right-aligned against it; the default slot replaces it', () => {
  const { c } = mountGlass(() => h(Switch, { label: 'Remember me' }))
  const row = c.children.find(n => n.type === 'box')!, [label, sw] = row.children.filter(n => n.type !== 'anchor')
  expect(row.style).toMatchObject({ flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 16 })
  expect(sw!.type).toBe('glass')
  const text = first(label!, 'text')
  expect(text.props.value).toBe('Remember me'); expect(text.style).toMatchObject({ fontSize: 20, fontWeight: 500, color: 'label', textAlign: 'right' })
  const s = mountGlass(() => h(Switch, { label: 'x' }, { default: () => h(Text, { value: '自定义' }) })).c
  expect(all(s, 'text').map(t => t.props.value).filter(Boolean)).toEqual(['自定义'])
  expect(all(mountGlass(() => h(Switch)).c, 'text').filter(t => t.props.value)).toEqual([])   // no label: the switch alone
})
it('disabled Switch and Checkbox: the row dims, the control leaves the Tab order, shows no hover or press, and nothing toggles it', async () => {
  for (const comp of [Switch, Checkbox]) {
    const disabled = ref(true), got: string[] = []
    const { c } = mountGlass(() => h(comp, { label: '不可用', disabled: disabled.value, 'onUpdate:checked': (x: boolean) => got.push(String(x)) }))
    const box = first(c, 'glass'), row = c.children.find(n => n.type === 'box')!
    expect(row.state.disabled).toBe(true); expect(row.style.disabled).toEqual({ opacity: 0.4 })
    expect(box.state.disabled).toBe(true); expect(box.props.tabIndex).toBe(-1); expect(box.style.disabled).toBeUndefined()
    expect(box.style.hover).toBeUndefined(); expect(box.style.pressed).toBeUndefined()
    bubble(box, 'click'); bubble(first(c, 'text'), 'click'); fire(box, 'keydown', { key: 'Enter' }); fire(box, 'keydown', { key: ' ' }); fire(box, 'keyup', { key: ' ' })
    fire(box, 'pointerdown'); await nextTick()
    expect(got).toEqual([]); expect(box.state.pressed).toBe(false)
    if (comp === Switch) expect(first(box, 'image').style.width).toBe(56)
    disabled.value = false; await nextTick()
    expect(row.state.disabled).toBe(false); expect(box.props.tabIndex).toBe(0); expect(box.style.pressed).toBeDefined()
    bubble(box, 'click'); expect(got).toEqual(['true'])
  }
})
it('Checkbox: the reference\'s 44 × 44 radius-12 clear glass (thickness 14, fillet 4, bottom 2), pressed to 0.9; the check in the accent at 30 pt, weight 0.14', () => {
  const { c } = mountGlass(() => h(Checkbox, { checked: true, label: 'I agree to the Terms & Privacy' }))
  const row = c.children.find(n => n.type === 'box')!, box = first(c, 'glass')
  expect(row.style).toMatchObject({ flexDirection: 'row', alignItems: 'center', gap: 16 })
  expect(row.children.filter(n => n.type !== 'anchor').map(n => n.type)).toEqual(['glass', 'box'])   // the box, then its label
  expect(box.style).toMatchObject({ width: 44, height: 44, radius: 12, flexShrink: 0, alignItems: 'center', justifyContent: 'center', glass: { thickness: 14, fillet: 4, filletBottom: 2 } })
  expect(box.style.glass?.glow).toBeUndefined()                 // clear glass, checked or not
  const ctl = controlStyle({ pressScale: 0.9 })
  expect(box.style.pressed).toEqual({ scale: 0.9 }); expect(box.style.hover).toEqual(ctl.hover); expect(box.style.transition).toEqual(ctl.transition)
  expect(first(box, 'image').props.src).toBe(iconCanvas('check', 30, resolveColor('accent', defaultTheme, 'light'), 0.14, napiCanvas))
  expect(first(row, 'text').style).toMatchObject({ fontSize: 20, fontWeight: 500, color: 'label' })
  const d = mountGlass(() => h(Checkbox, { checked: true, indeterminate: true })).c
  expect(first(first(d, 'glass'), 'image').props.src).toBe(iconCanvas('minus', 30, resolveColor('accent', defaultTheme, 'light'), 0.14, napiCanvas))
})
it('Checkbox: a click on the box, Enter and Space toggle it; from indeterminate a toggle emits checked true, whatever checked was', async () => {
  const { c, got } = bound(Checkbox)
  const box = first(c, 'glass')
  bubble(box, 'click'); await nextTick()
  fire(box, 'keydown', { key: 'Enter' }); await nextTick()
  fire(box, 'keydown', { key: ' ' }); expect(box.state.pressed).toBe(true)
  fire(box, 'keyup', { key: ' ' }); await nextTick()
  expect(got).toEqual(['update:true', 'change:true', 'update:false', 'change:false', 'update:true', 'change:true'])
  for (const checked of [false, true]) {
    const p = bound(Checkbox, { checked, indeterminate: true })
    bubble(first(p.c, 'glass'), 'click'); expect(p.got).toEqual(['update:true', 'change:true'])
  }
})
it('through a Surface: a press on the Checkbox label clicks the row and toggles it once; the check scales in through GlassTransition', async () => {
  const root = createFakeRoot(), v = ref(false)
  mountGlass(() => h(Surface, { width: 500, height: 200 }, () => [h(Checkbox, { id: 'cb', label: '我已阅读并同意服务条款', checked: v.value, 'onUpdate:checked': (x: boolean) => { v.value = x } })]), { root })
  await flush(); root.tick()
  const s = root.surfacesMade[0]!, row = byId(s.root, 'cb')!, label = first(row, 'text'), r = absoluteRect(label)
  s.pointer.down(r.x + r.width / 2, r.y + r.height / 2); s.pointer.up(r.x + r.width / 2, r.y + r.height / 2)
  expect(v.value).toBe(true)
  await nextTick()
  const check: Node = first(first(row, 'glass'), 'image')
  expect(check.style).toMatchObject({ opacity: 0, scale: 0.9 })   // the scale preset, until the next tick records it
  root.tick(); await flush(); root.tick()
  expect(check.visual?.scale).toBeGreaterThan(0.9); expect(check.visual?.scale).toBeLessThan(1)
})
it('the colours follow the theme: a dark scheme re-tints an on Switch and re-colours the check', async () => {
  const root = createFakeRoot()
  const { c } = mountGlass(() => [h(Switch, { checked: true }), h(Checkbox, { checked: true })], { root })
  root.emit('theme', { theme: root.theme, scheme: 'dark', contrast: false }); await nextTick()
  const [sw, box] = all(c, 'glass')
  expect(sw!.style.glass?.tint).toBe('#9c96ff')
  expect(first(box!, 'image').props.src).toBe(iconCanvas('check', 30, resolveColor('accent', defaultTheme, 'dark'), 0.14, napiCanvas))
})
it('readable errors: a wrong type, and v-model on the wrong name', () => {
  expect(mountGlass(() => h(Switch, { checked: 'yes' })).errors[0]).toMatch(/\[Switch\.checked\]/)
  expect(mountGlass(() => h(Checkbox, { modelValue: true })).errors[0]).toMatch(/\[Checkbox\] 未知属性 "modelValue".*checked/)
})
it('knobCanvas: a white disc with a soft shadow on its 2× canvas; stretched, a capsule as tall; cached per arguments and factory', () => {
  const px = (cv: CanvasLike, x: number, y: number): number[] => [...cv.getContext('2d').getImageData(Math.round(x * 2), Math.round(y * 2), 1, 1).data]   // at pt (x, y)
  const disc = knobCanvas(56, 48, napiCanvas), pill = knobCanvas(56, 48, napiCanvas, 10)
  expect([disc.width, disc.height]).toEqual([112, 112]); expect([pill.width, pill.height]).toEqual([132, 112])
  expect(px(disc, 28, 28)).toEqual([255, 255, 255, 255])
  expect(px(disc, 6, 6)[3]).toBeLessThan(80)                    // outside the disc: at most a faint shadow
  expect(px(pill, 33, 5)).toEqual([255, 255, 255, 255])         // the capsule's flat top, 1 pt inside its edge
  expect(px(pill, 5, 28)).toEqual([255, 255, 255, 255])         // its round left end
  expect(knobCanvas(56, 48, napiCanvas)).toBe(disc); expect(knobCanvas(56, 48, napiCanvas, 10)).toBe(pill)
  expect(knobCanvas(56, 48, (w, hh) => napiCanvas(w, hh))).not.toBe(disc)
})
it('Switch and Checkbox are registered with complete manifest metadata', () => {
  for (const name of ['Switch', 'Checkbox']) {
    const m = glassComponents().find(g => g.glass.name === name)!.glass
    expect(m.description.length).toBeGreaterThan(40)
    expect(m.examples.length).toBeGreaterThanOrEqual(2); expect(m.examples.length).toBeLessThanOrEqual(3)
    for (const e of m.examples) expect(e).toMatch(new RegExp(`<${name}\\b`))
    expect(m.examples.some(e => e.includes('v-model:checked'))).toBe(true)
    for (const [k, s] of Object.entries(m.props.shape)) expect((s as { description?: string }).description, `${name}.${k}`).toMatch(/[一-鿿]/)
    expect(Object.keys(m.events!)).toEqual(['update:checked', 'change']); expect(Object.keys(m.slots!)).toEqual(['default'])
    expect(JSON.stringify(m.mistakes)).toMatch(/v-model:checked/)
  }
})
