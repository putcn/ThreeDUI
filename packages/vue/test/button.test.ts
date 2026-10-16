import { it, expect, vi } from 'vitest'
import { defineComponent, h, nextTick, ref, shallowRef } from '@vue/runtime-core'
import { absoluteRect, defaultTheme, Node, resolveColor } from '@glassui/core'
import { glassComponents } from '../src/define'
import { Button } from '../src/components/Button'
import { Stack } from '../src/components/Stack'
import { Text } from '../src/components/Text'
import { Icon } from '../src/components/Icon'
import { Surface } from '../src/components/Surface'
import { controlStyle, tiltToward, useGlassControl } from '../src/control'
import { glowingTint, withAlpha } from '../src/colors'
import { iconCanvas } from '../src/icons'
import { createFakeRoot, flush } from './fixtures/fake-root'
import { all, first, mountGlass, napiCanvas } from './fixtures/mount'
import { fire } from './fixtures/events'
import { byId } from './fixtures/tree'

it('glassProminent is glowing glass with a white label; glass is clear', () => {
  const { c } = mountGlass(() => h(Stack, () => [h(Button, { variant: 'glassProminent', label: 'Create account', size: 'large' }), h(Button, { label: 'Cancel' })]))
  const [p, g] = all(c, 'glass')
  expect(p!.style.glass).toMatchObject({ glow: { color: 'accent', strength: 1.1 }, absorption: 1.4 })
  expect(p!.style.height).toBe(80); expect(first(p!, 'text').style.color).toBe('#ffffff')
  expect(g!.style.glass?.glow).toBeUndefined(); expect(g!.style.height).toBe(52)
})
it('press fires on click and Enter, not when disabled or loading', async () => {
  const got: string[] = [], disabled = ref(false), loading = ref(false)
  const { c } = mountGlass(() => h(Button, { label: 'Go', disabled: disabled.value, loading: loading.value, onPress: (e: { pointerType: string }) => got.push(e.pointerType) }))
  const b = first(c, 'glass')
  fire(b, 'click', { pointerType: 'mouse' }); fire(b, 'keydown', { key: 'Enter' })
  disabled.value = true; await nextTick(); fire(b, 'click')
  disabled.value = false; loading.value = true; await nextTick(); fire(b, 'click')
  expect(got).toEqual(['mouse', 'keyboard'])
  expect(b.props.busy).toBe(true)
})
it('Space presses visually on keydown and activates on keyup', () => {
  let n = 0
  const { c } = mountGlass(() => h(Button, { label: 'Go', onPress: () => n++ }))
  const b = first(c, 'glass')
  fire(b, 'keydown', { key: ' ' }); expect(b.state.pressed).toBe(true); expect(n).toBe(0)
  fire(b, 'keyup', { key: ' ' }); expect(b.state.pressed).toBe(false); expect(n).toBe(1)
})
it('hover lifts and tilts toward a mouse, never a finger; reduced motion keeps it flat', () => {
  const root = createFakeRoot()
  const { c } = mountGlass(() => h(Button, { label: 'Go' }), { root })
  const b = first(c, 'glass'); b.layout = { x: 0, y: 0, width: 200, height: 52 }
  fire(b, 'pointerenter', { pointerType: 'mouse' }); fire(b, 'pointermove', { pointerType: 'mouse', localX: 200, localY: 0 })
  expect(b.elevation).toBe(6); expect(Math.abs(b.tilt.y)).toBeCloseTo(0.052, 3); expect(Math.abs(b.tilt.x)).toBeCloseTo(0.052, 3)
  fire(b, 'pointerleave', { pointerType: 'mouse' }); expect(b.elevation).toBe(0); expect(b.tilt).toEqual({ x: 0, y: 0 })
  fire(b, 'pointerenter', { pointerType: 'touch' }); fire(b, 'pointermove', { pointerType: 'touch', localX: 200, localY: 0 }); expect(b.tilt).toEqual({ x: 0, y: 0 })
  root.anim.reducedMotion = true
  fire(b, 'pointermove', { pointerType: 'mouse', localX: 200, localY: 0 }); expect(b.tilt).toEqual({ x: 0, y: 0 })
})
it('rejects a circle with a label and an unknown variant', () => {
  expect(mountGlass(() => h(Button, { shape: 'circle', label: 'x' })).errors[0]).toMatch(/\[Button\.shape\] circle 只能放图标/)
  expect(mountGlass(() => h(Button, { variant: 'primary' })).errors[0]).toMatch(/\[Button\.variant\].*允许值：glass, glassProminent, filled, tinted, plain/)
})
it('loading dots: the middle one is bright with frozen motion', () => {
  const { c } = mountGlass(() => h(Button, { label: 'Go', loading: true }), { motion: 'frozen' })
  const dots = all(c, 'box').filter(n => n.props.dot !== undefined)
  expect(dots.map(d => d.style.opacity)).toEqual([0.35, 1, 0.35])
})

// ── beyond the brief's tests ──

it('colours: the glowing tint is the accent 15 % toward white (the playground\'s GLOWING.tint); withAlpha sets the alpha', () => {
  expect(glowingTint(defaultTheme, 'light')).toBe('#817af7')
  expect(glowingTint(defaultTheme, 'dark')).toBe('#9c96ff')
  expect(withAlpha('accent', 0.15, defaultTheme, 'light')).toBe('rgba(107, 99, 245, 0.15)')
  expect(withAlpha('#ff000080', 0.5, defaultTheme, 'light')).toBe('rgba(255, 0, 0, 0.5)')        // replaced, not multiplied
  expect(() => withAlpha('acent', 0.5, defaultTheme, 'light')).toThrow(/未知颜色 token "acent"/)
})
it('controlStyle: snappy springs for the press, lift and tilt, the press scale and the hover glint', () => {
  expect(controlStyle()).toEqual({
    transition: { scale: 'snappy', elevation: 'snappy', tilt: 'snappy' }, pressed: { scale: 0.96 }, hover: { glass: { specularIntensity: 1.35, edgeGlow: 1.1 } },
  })
  expect(controlStyle({ pressScale: 0.9 }).pressed).toEqual({ scale: 0.9 })
})
it('filled, tinted and plain are boxes with their fill, label colour and press', () => {
  const { c } = mountGlass(() => h(Stack, () => (['filled', 'tinted', 'plain'] as const).map(v => h(Button, { variant: v, label: v }))))
  expect(all(c, 'glass')).toHaveLength(0)
  const [f, t, p] = all(c, 'box').filter(n => n.props.tabIndex !== undefined)
  expect(f!.style).toMatchObject({ bg: 'accent', pressed: { scale: 0.96, opacity: 0.85 } }); expect(first(f!, 'text').style).toMatchObject({ color: '#ffffff', fontWeight: 600 })
  expect(t!.style.bg).toBe('rgba(107, 99, 245, 0.15)'); expect(t!.style.pressed).toEqual({ scale: 0.96 }); expect(first(t!, 'text').style.color).toBe('accent')
  expect(p!.style.bg).toBeUndefined(); expect(p!.style.pressed).toEqual({ scale: 0.96, opacity: 0.55 }); expect(first(p!, 'text').style.color).toBe('accent')
  // glass labels: the label colour at 600; glowing glass at 700
  const g = mountGlass(() => h(Stack, () => [h(Button, { label: 'a' }), h(Button, { label: 'b', variant: 'glassProminent' })])).c
  expect(all(g, 'text').map(n => [n.style.color, n.style.fontWeight])).toEqual([['label', 600], ['#ffffff', 700]])
})
it('sizes: height, font, padding, icon and gap from the table, the large one from the theme metrics', () => {
  const { c } = mountGlass(() => h(Stack, () => (['small', 'regular', 'large'] as const).map(s => h(Button, { size: s, label: s, leadingIcon: 'plus' }))))
  const rows = all(c, 'glass').map(b => {
    const row = first(b, 'box')
    return [b.style.height, first(b, 'text').style.fontSize, b.style.paddingX, first(b, 'image').style.width, row.style.gap]
  })
  const m = defaultTheme.metrics
  expect(rows).toEqual([[36, 15, 14, 18, 6], [52, 18, 20, 22, 8], [80, 25, m.controlPadding, m.icon, m.groupGap]])
  expect([m.controlPadding, m.icon, m.groupGap]).toEqual([26, 28, 12])
})
it('shapes: a capsule, a rounded rectangle at 23 % of its height, a square circle with no side padding', () => {
  const { c } = mountGlass(() => h(Stack, () => [
    h(Button, { label: 'a' }),
    ...(['small', 'regular', 'large'] as const).map(size => h(Button, { label: 'r', size, shape: 'roundedRectangle' })),
    h(Button, { shape: 'circle', leadingIcon: 'plus' }),
  ]))
  const [cap, s, r, l, circle] = all(c, 'glass')
  expect(cap!.style.radius).toBe('capsule')
  expect([s, r, l].map(b => b!.style.radius)).toEqual([8, 12, 18])
  expect(circle!.style).toMatchObject({ width: 52, height: 52, radius: 'capsule', paddingX: 0 })
})
it('disabled: the disabled state, out of the Tab order, dimmed, no hover or press look and no lift', async () => {
  const disabled = ref(true)
  const { c } = mountGlass(() => h(Button, { label: 'Go', disabled: disabled.value }))
  const b = first(c, 'glass')
  expect(b.state.disabled).toBe(true); expect(b.props.tabIndex).toBe(-1); expect(b.style.disabled).toEqual({ opacity: 0.4 })
  expect(b.style.pressed).toBeUndefined(); expect(b.style.hover).toBeUndefined()
  fire(b, 'pointerenter'); fire(b, 'pointermove', { localX: 10 }); expect(b.elevation).toBe(0)
  disabled.value = false; await nextTick()
  expect(b.state.disabled).toBe(false); expect(b.props.tabIndex).toBe(0); expect(b.style.pressed).toEqual({ scale: 0.96 })
})
it('disabling a hovered, Space-pressed Button drops its lift, tilt and press without activating', async () => {
  let n = 0
  const disabled = ref(false)
  const { c } = mountGlass(() => h(Button, { label: 'Go', disabled: disabled.value, onPress: () => n++ }))
  const b = first(c, 'glass'); b.layout = { x: 0, y: 0, width: 200, height: 52 }
  fire(b, 'pointerenter'); fire(b, 'pointermove', { localX: 200, localY: 0 }); fire(b, 'keydown', { key: ' ' })
  expect(b.elevation).toBe(6); expect(b.state.pressed).toBe(true)
  disabled.value = true; await nextTick()
  expect(b.elevation).toBe(0); expect(b.tilt).toEqual({ x: 0, y: 0 }); expect(b.state.pressed).toBe(false)
  fire(b, 'keyup', { key: ' ' }); expect(n).toBe(0)
})
it('Space: a keyup without its keydown does nothing; a blur releases the press without activating', () => {
  let n = 0
  const { c } = mountGlass(() => h(Button, { label: 'Go', onPress: () => n++ }))
  const b = first(c, 'glass')
  fire(b, 'keyup', { key: ' ' }); expect(n).toBe(0)
  fire(b, 'keydown', { key: ' ' }); fire(b, 'blur'); expect(b.state.pressed).toBe(false)
  fire(b, 'keyup', { key: ' ' }); expect(n).toBe(0)
  fire(b, 'keydown', { key: 'a' }); fire(b, 'keyup', { key: 'Enter' }); expect(n).toBe(0)     // other keys, and Enter's keyup, do nothing
})
it('the tilt turns the face to the pointer as a Card does: the edge under it recedes (one helper)', () => {
  const n = new Node('box'); n.layout = { x: 0, y: 0, width: 200, height: 100 }
  expect(tiltToward(n, { localX: 200, localY: 50 }, 0.1)).toEqual({ x: 0, y: 0.1 })     // right edge: +y
  expect(tiltToward(n, { localX: 100, localY: 0 }, 0.1)).toEqual({ x: -0.1, y: 0 })     // top edge: −x
  expect(tiltToward(n, { localX: -40, localY: 900 }, 0.1)).toEqual({ x: 0.1, y: -0.1 })  // clamped to the node
  expect(tiltToward(new Node('box'), { localX: 5, localY: 5 }, 0.1)).toEqual({ x: 0, y: 0 })   // no size: level
  const { c } = mountGlass(() => h(Button, { label: 'Go' }))
  const b = first(c, 'glass'); b.layout = { x: 0, y: 0, width: 200, height: 52 }
  fire(b, 'pointermove', { pointerType: 'pen', localX: 200, localY: 0 })                // top right; a pen hovers as a mouse
  expect(b.elevation).toBe(6); expect(b.tilt.x).toBeCloseTo(-3 * Math.PI / 180); expect(b.tilt.y).toBeCloseTo(3 * Math.PI / 180)
})
it('useGlassControl: `pressing` holds while a press is over the node or Space is down; tilt and lift options', () => {
  let ctl!: ReturnType<typeof useGlassControl>
  const Probe = defineComponent(() => {
    const el = shallowRef<Node>()
    ctl = useGlassControl(el, { disabled: ref(false), onActivate: () => {}, tilt: false, lift: 10 })
    return () => h('glass', { ref: el, ...ctl.handlers })
  })
  const { c } = mountGlass(() => h(Probe))
  const g = first(c, 'glass'); g.layout = { x: 0, y: 0, width: 100, height: 40 }
  fire(g, 'pointerenter'); fire(g, 'pointermove', { localX: 100 }); expect(g.elevation).toBe(10); expect(g.tilt).toEqual({ x: 0, y: 0 })
  fire(g, 'pointerdown'); expect(ctl.pressing.value).toBe(true)
  g.setState({ pressed: true })                                     // the tracker's press, held while the pointer drags off and back
  fire(g, 'pointerleave'); expect(ctl.pressing.value).toBe(false)
  fire(g, 'pointerenter'); expect(ctl.pressing.value).toBe(true)
  fire(g, 'pointerup'); expect(ctl.pressing.value).toBe(false)
  fire(g, 'pointerdown'); fire(g, 'pointercancel'); expect(ctl.pressing.value).toBe(false)
  fire(g, 'keydown', { key: ' ' }); expect(ctl.pressing.value).toBe(true)
  fire(g, 'keyup', { key: ' ' }); expect(ctl.pressing.value).toBe(false)
})
it('through a Surface: a press on the label clicks the Button and focuses it without the ring; Tab shows it, Enter and Space press', async () => {
  const root = createFakeRoot(), got: string[] = []
  mountGlass(() => h(Surface, { width: 400, height: 200 }, () => [h(Button, { id: 'go', label: 'Go', onPress: (e: { pointerType: string }) => got.push(e.pointerType) })]), { root })
  await flush(); root.tick()
  const s = root.surfacesMade[0]!, b = byId(s.root, 'go')!, r = absoluteRect(b), [x, y] = [r.x + r.width / 2, r.y + r.height / 2]
  s.pointer.down(x, y); s.focus.focusFromPointer(s.pointer.pressed)                    // as the render's pointer bridge does
  expect(s.pointer.pressed?.type).toBe('text'); expect(b.state.pressed).toBe(true); expect(b.elevation).toBe(6)
  s.pointer.up(x, y)
  expect(got).toEqual(['mouse']); expect(b.state).toMatchObject({ pressed: false, focused: true, focusVisible: false })
  s.focus.focus(null); s.focus.key('Tab'); expect(s.focus.current).toBe(b); expect(b.state.focusVisible).toBe(true)
  s.focus.key('Enter'); s.focus.key(' '); expect(b.state.pressed).toBe(true); s.focus.key(' ', false)
  expect(got).toEqual(['mouse', 'keyboard', 'keyboard'])
})
it('slots: the default slot replaces the label, leading and trailing replace the icons', () => {
  const { c } = mountGlass(() => h(Button, { label: 'x', leadingIcon: 'plus' }, {
    default: () => h(Text, { value: '自定义' }), leading: () => h(Icon, { name: 'star' }), trailing: () => h(Icon, { name: 'heart' }),
  }))
  const row = first(first(c, 'glass'), 'box')
  expect(all(row, 'text').map(t => t.props.value).filter(Boolean)).toEqual(['自定义'])     // less the slot fragments' empty anchors
  expect(all(row, 'image').map(i => i.props.src)).toEqual([
    iconCanvas('star', 24, resolveColor('label', defaultTheme, 'light'), 0.1, napiCanvas), iconCanvas('heart', 24, resolveColor('label', defaultTheme, 'light'), 0.1, napiCanvas),
  ])
})
it('the reference\'s primary action: the label then the arrow in white, centred, full width', () => {
  const { c } = mountGlass(() => h(Button, { variant: 'glassProminent', size: 'large', label: 'Create account', trailingIcon: 'arrow-right', fullWidth: true }))
  const b = first(c, 'glass'), row = first(b, 'box')
  expect(b.style).toMatchObject({ alignSelf: 'stretch', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', radius: 'capsule' })
  const parts = row.children.filter(n => n.type !== 'anchor')                           // the absent leading icon's placeholder
  expect(parts.map(n => n.type)).toEqual(['text', 'image'])
  expect(parts[1]!.props.src).toBe(iconCanvas('arrow-right', 28, [1, 1, 1, 1], 0.12, napiCanvas))
  expect(first(mountGlass(() => h(Button, { label: 'x' })).c, 'glass').style.alignSelf).toBeUndefined()
})
it('loading: the bright dot steps every 300 ms while live, over the hidden content; the timer ends with loading and on unmount', async () => {
  vi.useFakeTimers()
  try {
    const loading = ref(true)
    const { c, app } = mountGlass(() => h(Button, { label: 'Go', loading: loading.value }))
    const lit = (): boolean[] => all(c, 'box').filter(n => n.props.dot !== undefined).map(d => d.style.opacity === 1)
    expect(lit()).toEqual([true, false, false])
    vi.advanceTimersByTime(300); await nextTick(); expect(lit()).toEqual([false, true, false])
    vi.advanceTimersByTime(300); await nextTick(); expect(lit()).toEqual([false, false, true])
    vi.advanceTimersByTime(300); await nextTick(); expect(lit()).toEqual([true, false, false])
    // the label stays laid out, unseen, so the Button keeps its width
    const row = first(first(c, 'glass'), 'box')
    expect(row.style.opacity).toBe(0); expect(first(row, 'text').props.value).toBe('Go')
    loading.value = false; await nextTick()
    expect(vi.getTimerCount()).toBe(0); expect(lit()).toEqual([]); expect(row.style.opacity).toBeUndefined()
    loading.value = true; await nextTick(); expect(vi.getTimerCount()).toBe(1)
    app.unmount(); expect(vi.getTimerCount()).toBe(0)
    mountGlass(() => h(Button, { loading: true }), { motion: 'frozen' }); expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
it('a user style merges over the Button\'s own: a glass tint keeps the glow (Task 7 ruling)', () => {
  const { c } = mountGlass(() => h(Button, { variant: 'glassProminent', label: 'x', style: { width: 240, glass: { tint: '#ff3b30' } } }))
  const b = first(c, 'glass')
  expect(b.style.glass).toMatchObject({ glow: { color: 'accent', strength: 1.1 }, tint: '#ff3b30', absorption: 1.4 })
  expect(b.style).toMatchObject({ width: 240, height: 52 })
})
it('the colours follow the theme: a dark scheme re-tints glowing glass and the tinted fill', async () => {
  const root = createFakeRoot()
  const { c } = mountGlass(() => h(Stack, () => [h(Button, { label: 'a', variant: 'glassProminent' }), h(Button, { label: 'b', variant: 'tinted' })]), { root })
  root.emit('theme', { theme: root.theme, scheme: 'dark', contrast: false }); await nextTick()
  const glowing = first(c, 'glass'), tinted = all(c, 'box').find(n => n.props.tabIndex !== undefined)!
  expect(glowing.style.glass?.tint).toBe('#9c96ff'); expect(tinted.style.bg).toBe('rgba(138, 131, 255, 0.15)')
})
it('an unknown variant suggests the one meant; the glassId reaches the host', () => {
  expect(mountGlass(() => h(Button, { variant: 'primary' })).errors[0]).toMatch(/你可能想要：glassProminent$/)
  expect(mountGlass(() => h(Button, { variant: 'secondary' })).errors[0]).toMatch(/你可能想要：glass$/)
  expect(mountGlass(() => h(Button, { leadingIcon: 'close' })).errors[0]).toMatch(/\[Button\.leadingIcon\] 非法取值 "close".*你可能想要：x$/)   // Icon's aliases
  expect(first(mountGlass(() => h(Button, { label: 'Go', glassId: 'go' })).c, 'glass').props.glassId).toBe('go')
  expect(first(mountGlass(() => h(Button, { label: 'Go' })).c, 'glass').props).not.toHaveProperty('glassId')
})
it('Button is registered with complete manifest metadata', () => {
  const m = glassComponents().find(g => g.glass.name === 'Button')!.glass
  expect(m.description.length).toBeGreaterThan(40)
  expect(m.examples.length).toBeGreaterThanOrEqual(2); expect(m.examples.length).toBeLessThanOrEqual(3)
  for (const e of m.examples) expect(e).toMatch(/<Button\b/)
  expect(m.examples).toContain('<Button variant="glassProminent" size="large" label="Create account" trailing-icon="arrow-right" full-width @press="submit" />')
  for (const [k, s] of Object.entries(m.props.shape)) expect((s as { description?: string }).description, `Button.${k}`).toMatch(/[一-鿿]/)
  expect(Object.keys(m.events!)).toEqual(['press']); expect(Object.keys(m.slots!)).toEqual(['default', 'leading', 'trailing'])
  expect(m.mistakes!.length).toBeGreaterThan(0)
})
