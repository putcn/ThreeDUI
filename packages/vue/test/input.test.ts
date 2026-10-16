import { it, expect, vi } from 'vitest'
import { h, nextTick, ref } from '@vue/runtime-core'
import { absoluteRect, defaultTheme, hitTest, resolveColor, resolveTextStyle } from '@glassui/core'
import { glassComponents } from '../src/define'
import { Input } from '../src/components/Input'
import { Surface } from '../src/components/Surface'
import { Icon } from '../src/components/Icon'
import { controlStyle } from '../src/control'
import { withAlpha } from '../src/colors'
import { iconCanvas } from '../src/icons'
import { createFakeRoot, flush, type FakeSurface } from './fixtures/fake-root'
import { CW } from './fixtures/fake-text'
import { all, first, mountGlass, mountInSurface, napiCanvas, part, parts } from './fixtures/mount'
import { fire } from './fixtures/events'
import { byId } from './fixtures/tree'

/** The `part` of the node the pointer at (x, y) lands on in `s` (its own, or the nearest ancestor's that has one). */
function hitPart(s: FakeSurface, x: number, y: number): unknown {
  for (let n = hitTest(s.root, x, y); n; n = n.parent) if (n.props.part !== undefined) return n.props.part
  return null
}

// ── the brief's tests ──

it('focus attaches the IME at the caret; typing updates v-model; Enter submits', async () => {
  const v = ref(''), submitted: string[] = []
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: v.value, placeholder: '邮箱', 'onUpdate:modelValue': (x: string) => { v.value = x }, onSubmit: (x: string) => submitted.push(x) }))
  const host = first(c, 'glass'); surface.focus.focus(host); await nextTick()
  const field = root.ime.active!
  expect(field.kind).toBe('text')
  field.onChange({ value: 'a@b', selectionStart: 3, selectionEnd: 3, composition: null }); await nextTick()
  expect(v.value).toBe('a@b'); expect(first(c, 'text').props.value).toBe('a@b')
  expect(field.onKey({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })).toBe(true)
  expect(submitted).toEqual(['a@b'])
})
it('shows the placeholder only when empty and not composing; draws the composition underline', async () => {
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: '', placeholder: '邮箱', style: { width: 300 } }))
  expect(part(c, 'text').props.value).toBe('邮箱'); expect(part(c, 'text').style.color).toBe('tertiaryLabel')
  surface.focus.focus(first(c, 'glass')); await nextTick()
  root.ime.active!.onChange({ value: 'ni', selectionStart: 2, selectionEnd: 2, composition: { start: 0, end: 2 } }); await nextTick(); root.tick()
  expect(part(c, 'text').props.value).toBe('ni'); expect(part(c, 'text').style.color).toBe('label')
  expect(part(c, 'composition').style).toMatchObject({ left: 0, width: 2 * CW, height: 1.5 })
})
it('the caret follows the selection and the field scrolls to keep it (and a composition) visible (Review Focus 3)', async () => {
  const long = 'x'.repeat(30)                                   // 30 · CW = 324 pt, wider than the 260 pt field
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: long, style: { width: 300 } }))
  surface.focus.focus(first(c, 'glass')); await nextTick()
  const f = root.ime.active!
  f.onChange({ value: long, selectionStart: 30, selectionEnd: 30, composition: null }); await nextTick(); root.tick()
  expect(part(c, 'field').layout.width).toBeCloseTo(260)
  expect(part(c, 'text').style.left).toBeCloseTo(-(30 * CW - 260 + 2))
  expect(part(c, 'caret').style.left).toBeCloseTo(260 - 2)
  f.onChange({ value: long, selectionStart: 0, selectionEnd: 0, composition: null }); await nextTick(); root.tick()
  expect(part(c, 'text').style.left).toBeCloseTo(0)
  const typed = long + 'nihao'                                  // a composition running past the right edge
  f.onChange({ value: typed, selectionStart: 35, selectionEnd: 35, composition: { start: 30, end: 35 } }); await nextTick(); root.tick()
  expect(part(c, 'text').style.left).toBeCloseTo(-(35 * CW - 260 + 2))
})
it('number fields reject letters and emit numbers', async () => {
  const emitted: unknown[] = []
  const { c, root, surface } = mountInSurface(() => h(Input, { type: 'number', modelValue: null, 'onUpdate:modelValue': (x: unknown) => emitted.push(x), style: { width: 300 } }))
  surface.focus.focus(first(c, 'glass')); await nextTick()
  const f = root.ime.active!
  expect(f.kind).toBe('number')
  f.onChange({ value: 'a', selectionStart: 1, selectionEnd: 1, composition: null }); await nextTick()
  expect(emitted).toEqual([]); expect(root.ime.synced.at(-1)).toMatchObject({ value: '', selectionStart: 0, selectionEnd: 0 })
  f.onChange({ value: '-', selectionStart: 1, selectionEnd: 1, composition: null }); await nextTick()
  f.onChange({ value: '-1.5', selectionStart: 4, selectionEnd: 4, composition: null }); await nextTick()
  expect(emitted).toEqual([null, -1.5])
})
it('password fields mask, and the eye toggle reveals', async () => {
  const { c } = mountInSurface(() => h(Input, { type: 'password', modelValue: 'abcd', style: { width: 300 } }))
  expect(part(c, 'text').props.value).toBe('••••')
  fire(part(c, 'eye'), 'click'); await nextTick()
  expect(part(c, 'text').props.value).toBe('abcd')
})
it('clicking places the caret; dblclick selects a word', async () => {
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: 'hello world', style: { width: 300 } }))
  surface.focus.focus(first(c, 'glass')); await nextTick(); root.tick()
  fire(part(c, 'field'), 'pointerdown', { localX: 2.4 * CW, localY: 5, pointerType: 'mouse' }); await nextTick()
  expect(root.ime.synced.at(-1)).toMatchObject({ selectionStart: 2, selectionEnd: 2 })
  fire(part(c, 'field'), 'dblclick', { localX: 8 * CW, localY: 5, pointerType: 'mouse' }); await nextTick()
  expect(root.ime.synced.at(-1)).toMatchObject({ selectionStart: 6, selectionEnd: 11 })
})
it('unmounting while composing detaches the IME (Review Focus 2)', async () => {
  const show = ref(true)
  const { c, root, surface } = mountInSurface(() => show.value ? h(Input, { modelValue: '', style: { width: 300 } }) : null)
  surface.focus.focus(first(c, 'glass')); await nextTick()
  const f = root.ime.active!
  f.onChange({ value: 'ni', selectionStart: 2, selectionEnd: 2, composition: { start: 0, end: 2 } })
  show.value = false; await nextTick()
  expect(root.ime.blurred).toContain(f); expect(root.ime.active).toBeNull()
  expect(() => root.tick()).not.toThrow()
})
it('the caret blinks with live motion and is steady when frozen', async () => {
  vi.useFakeTimers()
  try {
    const live = mountInSurface(() => h(Input, { modelValue: 'a', style: { width: 300 } }))
    live.surface.focus.focus(first(live.c, 'glass')); await nextTick()
    const op = () => part(live.c, 'caret').style.opacity
    expect(op()).toBe(1); vi.advanceTimersByTime(530); await nextTick(); expect(op()).toBe(0)
    vi.advanceTimersByTime(530); await nextTick(); expect(op()).toBe(1)
    const frozen = mountInSurface(() => h(Input, { modelValue: 'a', style: { width: 300 } }), { motion: 'frozen' })
    frozen.surface.focus.focus(first(frozen.c, 'glass')); await nextTick()
    vi.advanceTimersByTime(2000); await nextTick(); expect(part(frozen.c, 'caret').style.opacity).toBe(1)
  } finally { vi.useRealTimers() }
})

// ── beyond the brief's tests ──

const KEY = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false } as const

it('spatial §7: on a world Surface the IME proxy follows the projected caret every tick, the Surface moving with no edit', async () => {
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: 'abc', style: { width: 300 } }), { layer: 'world' })
  surface.focus.focus(first(c, 'glass')); await nextTick(); root.tick()
  const f = root.ime.active!, r = absoluteRect(part(c, 'field'))
  const at = root.ime.placed!                                   // the fake projection: Surface pt + the Surface's position
  expect(at.x).toBeCloseTo(r.x + 3 * CW); expect(at.y).toBeCloseTo(r.y)
  surface.position.set(40, -25, 0); root.tick()                 // the rig or a drag moves the Surface: no caret move
  expect(root.ime.placed!.x).toBeCloseTo(at.x + 40); expect(root.ime.placed!.y).toBeCloseTo(at.y - 25)
  f.onChange({ value: 'abcd', selectionStart: 4, selectionEnd: 4, composition: null }); await nextTick(); root.tick()
  expect(root.ime.placed!.x).toBeCloseTo(at.x + 40 + CW)
  expect(f.caret()).toEqual({ x: r.x + 4 * CW, y: r.y, height: 22 })
})
it('the caret rect is the text node\'s own geometry: its resolved type, the field\'s place, less the scroll', async () => {
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: 'x'.repeat(30), style: { width: 300 } }))
  surface.focus.focus(first(c, 'glass')); await nextTick(); root.tick()
  const t = resolveTextStyle(part(c, 'text'), defaultTheme, 'light')
  expect(t).toMatchObject({ family: 'system-ui', size: 18, weight: 500, lineHeight: 22, letterSpacing: 0, wrap: false, maxLines: 1 })
  const r = absoluteRect(part(c, 'field'))
  expect(r.height).toBe(22)
  expect(part(c, 'text').layout.width).toBeCloseTo(30 * CW)     // its own width, wider than the field (drawn whole, then clipped)
  expect(root.ime.active!.caret()).toEqual({ x: r.x + 260 - 2, y: r.y, height: 22 })
  const caret = part(c, 'caret')
  expect(caret.style).toMatchObject({ position: 'absolute', width: 2, height: 0.9 * 22, top: (22 - 0.9 * 22) / 2, bg: 'accent', radius: 1 })
})
it('a field whose width changes after a layout scrolls again to keep the caret in view', async () => {
  const width = ref(300), long = 'x'.repeat(30)
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: long, style: { width: width.value } }))
  surface.focus.focus(first(c, 'glass')); await nextTick(); root.tick()
  expect(part(c, 'text').style.left).toBeCloseTo(-(30 * CW - 260 + 2))
  width.value = 200; await nextTick(); root.tick(); await nextTick()   // the tick lays out 160 pt and reads the caret
  expect(part(c, 'field').layout.width).toBeCloseTo(160)
  expect(part(c, 'text').style.left).toBeCloseTo(-(30 * CW - 160 + 2))
  expect(part(c, 'caret').style.left).toBeCloseTo(160 - 2)
})
it('deleting at the end of a scrolled value scrolls back: the text never ends short of the right edge', async () => {
  const long = 'x'.repeat(30)
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: long, style: { width: 300 } }))
  surface.focus.focus(first(c, 'glass')); await nextTick(); root.tick()
  const f = root.ime.active!
  f.onChange({ value: 'x'.repeat(26), selectionStart: 26, selectionEnd: 26, composition: null }); await nextTick()
  expect(part(c, 'text').style.left).toBeCloseTo(-(26 * CW - 260 + 2))
  f.onChange({ value: 'x'.repeat(10), selectionStart: 10, selectionEnd: 10, composition: null }); await nextTick()
  expect(part(c, 'text').style.left).toBe(0)
})
it('focus and blur: each emitted as it happens, the IME taking and letting go of the field; the scroll goes back to the start', async () => {
  const got: string[] = []
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: 'x'.repeat(30), style: { width: 300 }, onFocus: () => got.push('focus'), onBlur: () => got.push('blur') }))
  const host = first(c, 'glass')
  surface.focus.focus(host)
  expect(got).toEqual(['focus']); const f = root.ime.active!
  await nextTick(); expect(part(c, 'text').style.left).toBeLessThan(0)
  surface.focus.focus(null)
  expect(root.ime.blurred).toEqual([f]); expect(root.ime.active).toBeNull(); expect(got).toEqual(['focus', 'blur'])
  await nextTick()
  expect(part(c, 'text').style.left).toBe(0); expect(parts(c, 'caret')).toEqual([])
})
it('Tab from one Input to the next: the first blurs, then the next is focused and the IME has its field', async () => {
  const got: string[] = []
  const { root, surface } = mountInSurface(() => [
    h(Input, { modelValue: 'a', onFocus: () => got.push('a:focus'), onBlur: () => got.push('a:blur') }),
    h(Input, { modelValue: 'b', onFocus: () => got.push('b:focus'), onBlur: () => got.push('b:blur') }),
  ])
  surface.focus.key('Tab'); const a = root.ime.active!
  surface.focus.key('Tab'); const b = root.ime.active!
  expect(got).toEqual(['a:focus', 'a:blur', 'b:focus']); expect(a.value).toBe('a'); expect(b.value).toBe('b')
  expect(root.ime.blurred).toEqual([a])
})
it('Task 9 carry: a Surface made again mid-composition keeps the field, its composition and the proxy; no blur, no focus', async () => {
  const root = createFakeRoot(), radius = ref(0), got: string[] = []
  mountGlass(() => h(Surface, { layer: 'screen', width: 400, height: 200, radius: radius.value }, () => [
    h(Input, { id: 'in', modelValue: '', style: { width: 300 }, onFocus: () => got.push('focus'), onBlur: () => got.push('blur') }),
  ]), { root })
  await flush(); root.tick()
  const s0 = root.surfacesMade[0]!, host = byId(s0.root, 'in')!
  s0.focus.focus(host); await nextTick()
  const f = root.ime.active!
  expect(f.surface).toBe(s0)
  f.onChange({ value: 'ni', selectionStart: 2, selectionEnd: 2, composition: { start: 0, end: 2 } }); await nextTick()
  radius.value = 12; await nextTick(); await flush(); root.tick()   // a placement prop: the render Surface is made again
  const s1 = root.surfacesMade[1]!
  expect(s0.disposed).toBe(true); expect(s1.focus.current).toBe(host)
  expect(root.ime.blurred).toEqual([]); expect(root.ime.active).toBe(f); expect(f.surface).toBe(s1)
  expect(got).toEqual(['focus'])
  expect(part(host, 'text').props.value).toBe('ni'); expect(part(host, 'composition').style.width).toBe(2 * CW)
  expect(root.ime.placed).toEqual(root.screenFromPoint(f.surface, f.caret().x, f.caret().y))   // projected through the new one
  s1.focus.focus(null); await nextTick()                        // a real blur afterwards
  expect(root.ime.blurred).toEqual([f]); expect(got).toEqual(['focus', 'blur'])
})
it('removing the Input\'s Surface for good lets the IME go (the content unmounts with it)', async () => {
  const root = createFakeRoot(), show = ref(true)
  mountGlass(() => show.value ? h(Surface, { layer: 'screen', width: 400, height: 200 }, () => [h(Input, { id: 'in', modelValue: 'a' })]) : null, { root })
  await flush(); root.tick()
  const s0 = root.surfacesMade[0]!; s0.focus.focus(byId(s0.root, 'in')!); await nextTick()
  const f = root.ime.active!
  show.value = false; await nextTick(); await flush()
  expect(root.ime.blurred).toContain(f); expect(root.ime.active).toBeNull()
  expect(() => root.tick()).not.toThrow()
})
it('Escape blurs; Enter submits a number field\'s number; other keys are the proxy\'s', async () => {
  const submitted: unknown[] = []
  const { c, root, surface } = mountInSurface(() => h(Input, { type: 'number', modelValue: 2.5, onSubmit: (x: unknown) => submitted.push(x) }))
  surface.focus.focus(first(c, 'glass')); await nextTick()
  const f = root.ime.active!
  expect([f.value, f.selectionStart, f.selectionEnd]).toEqual(['2.5', 3, 3])
  expect(f.onKey({ key: 'Enter', ...KEY })).toBe(true); expect(submitted).toEqual([2.5])
  expect(f.onKey({ key: 'a', ...KEY })).toBe(false); expect(f.onKey({ key: 'ArrowLeft', ...KEY })).toBe(false)
  expect(f.onKey({ key: 'Escape', ...KEY })).toBe(true)
  expect(surface.focus.current).toBeNull(); await nextTick(); expect(root.ime.active).toBeNull()
})
it('Tab focus selects all (as a native field); a press keeps the caret it placed', async () => {
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: 'hello' }))
  surface.focus.key('Tab'); await nextTick()
  expect(root.ime.active).toMatchObject({ selectionStart: 0, selectionEnd: 5 })
  expect(parts(c, 'selection')).toHaveLength(1); expect(parts(c, 'caret')).toEqual([])
  surface.focus.focus(null); await nextTick()
  fire(part(c, 'field'), 'pointerdown', { localX: 2 * CW, localY: 5 }); surface.focus.focusFromPointer(part(c, 'text')); await nextTick()
  expect(root.ime.active).toMatchObject({ selectionStart: 2, selectionEnd: 2 })
})
it('an outside v-model change re-syncs the proxy; mid-composition nothing is emitted, and an outside change waits for its end', async () => {
  const v = ref('hello'), got: string[] = []
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: v.value, 'onUpdate:modelValue': (x: string) => { got.push(x); v.value = x } }))
  surface.focus.focus(first(c, 'glass')); await nextTick()
  const f = root.ime.active!
  v.value = 'world!'; await nextTick()
  expect(root.ime.synced.at(-1)).toEqual({ value: 'world!', selectionStart: 6, selectionEnd: 6, composition: null })
  expect(part(c, 'text').props.value).toBe('world!')
  f.onChange({ value: 'world!ni', selectionStart: 8, selectionEnd: 8, composition: { start: 6, end: 8 } }); await nextTick()
  expect(got).toEqual([])                                       // as Vue's v-model on an <input>: not mid-composition
  f.onChange({ value: 'world!你', selectionStart: 7, selectionEnd: 7, composition: null }); await nextTick()
  expect(got).toEqual(['world!你'])
  const synced = root.ime.synced.length
  f.onChange({ value: 'world!你h', selectionStart: 8, selectionEnd: 8, composition: { start: 7, end: 8 } }); await nextTick()
  v.value = 'reset'; await nextTick()                           // the app sets it while the IME composes
  expect(part(c, 'text').props.value).toBe('world!你h'); expect(root.ime.synced).toHaveLength(synced)
  f.onChange({ value: 'world!你好', selectionStart: 8, selectionEnd: 8, composition: null }); await nextTick()
  expect(v.value).toBe('reset'); expect(part(c, 'text').props.value).toBe('reset')   // the app's value wins, as on a native input
  expect(root.ime.synced.at(-1)).toEqual({ value: 'reset', selectionStart: 5, selectionEnd: 5, composition: null })
  expect(got).toEqual(['world!你'])
})
it('the clear button empties the value and keeps focus; a number field clears to null', async () => {
  const v = ref<string | number | null>('abc')
  const { c, root, surface } = mountInSurface(() => h(Input, { clearable: true, modelValue: v.value, 'onUpdate:modelValue': (x: string) => { v.value = x } }))
  const host = first(c, 'glass'); surface.focus.focus(host); await nextTick()
  const f = root.ime.active!
  fire(part(c, 'clear'), 'click'); await nextTick()
  expect(v.value).toBe(''); expect(root.ime.synced.at(-1)).toMatchObject({ value: '', selectionStart: 0, selectionEnd: 0 })
  expect(surface.focus.current).toBe(host); expect(root.ime.active).toBe(f)
  expect(parts(c, 'clear')).toEqual([])                        // nothing to clear
  const n = ref<number | null>(3)
  const m = mountInSurface(() => h(Input, { type: 'number', clearable: true, modelValue: n.value, 'onUpdate:modelValue': (x: number | null) => { n.value = x } }))
  fire(part(m.c, 'clear'), 'click'); await nextTick()
  expect(n.value).toBeNull()
})
it('a pasted line break becomes a space, and the proxy takes the one-line text', async () => {
  const v = ref('')
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: v.value, 'onUpdate:modelValue': (x: string) => { v.value = x } }))
  surface.focus.focus(first(c, 'glass')); await nextTick()
  root.ime.active!.onChange({ value: 'first\r\nsecond\n', selectionStart: 14, selectionEnd: 14, composition: null }); await nextTick()
  expect(v.value).toBe('first second ')
  expect(root.ime.synced.at(-1)).toEqual({ value: 'first second ', selectionStart: 13, selectionEnd: 13, composition: null })
})
it('maxLength cuts a paste to what fits and refuses typing past it; a composition may run past it until its commit', async () => {
  const v = ref('ab')
  const { c, root, surface } = mountInSurface(() => h(Input, { maxLength: 4, modelValue: v.value, 'onUpdate:modelValue': (x: string) => { v.value = x } }))
  surface.focus.focus(first(c, 'glass')); await nextTick()
  const f = root.ime.active!
  f.onChange({ value: 'abXYZ', selectionStart: 5, selectionEnd: 5, composition: null }); await nextTick()
  expect(v.value).toBe('abXY'); expect(root.ime.synced.at(-1)).toMatchObject({ value: 'abXY', selectionStart: 4, selectionEnd: 4 })
  f.onChange({ value: 'abXYQ', selectionStart: 5, selectionEnd: 5, composition: null }); await nextTick()
  expect(v.value).toBe('abXY'); expect(root.ime.synced.at(-1)).toMatchObject({ value: 'abXY', selectionStart: 4, selectionEnd: 4 })
  f.onChange({ value: 'abXYni', selectionStart: 6, selectionEnd: 6, composition: { start: 4, end: 6 } }); await nextTick()
  expect(part(c, 'text').props.value).toBe('abXYni')
  f.onChange({ value: 'abXY你', selectionStart: 5, selectionEnd: 5, composition: null }); await nextTick()
  expect(v.value).toBe('abXY'); expect(part(c, 'text').props.value).toBe('abXY')
  expect(root.ime.synced.at(-1)).toMatchObject({ value: 'abXY', selectionStart: 4, selectionEnd: 4 })
})
it('a number field refuses a composition of letters but takes the IME\'s full-width digits and 。', async () => {
  const emitted: unknown[] = []
  const { c, root, surface } = mountInSurface(() => h(Input, { type: 'number', modelValue: 1, 'onUpdate:modelValue': (x: unknown) => emitted.push(x) }))
  surface.focus.focus(first(c, 'glass')); await nextTick()
  const f = root.ime.active!
  f.onChange({ value: '1n', selectionStart: 2, selectionEnd: 2, composition: { start: 1, end: 2 } }); await nextTick()
  expect(part(c, 'text').props.value).toBe('1'); expect(parts(c, 'composition')).toEqual([])
  f.onChange({ value: '1你', selectionStart: 2, selectionEnd: 2, composition: null }); await nextTick()
  expect(root.ime.synced.at(-1)).toMatchObject({ value: '1', selectionStart: 1, selectionEnd: 1 }); expect(emitted).toEqual([])
  f.onChange({ value: '1。５', selectionStart: 3, selectionEnd: 3, composition: null }); await nextTick()
  expect(emitted).toEqual([1.5]); expect(root.ime.synced.at(-1)).toMatchObject({ value: '1.5', selectionStart: 3 })
})
it('a mouse drag over the field extends the selection while pressed; the moves reach it through the host', async () => {
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: 'hello world', style: { width: 300 } }))
  const host = first(c, 'glass'); surface.focus.focus(host); await nextTick(); root.tick()
  const field = part(c, 'field'), fx = absoluteRect(field).x
  fire(field, 'pointerdown', { localX: 1 * CW, localY: 5 }); field.setState({ pressed: true })   // the tracker presses the path
  fire(host, 'pointermove', { x: fx + 4 * CW, y: 0 }); await nextTick()
  expect(root.ime.synced.at(-1)).toMatchObject({ selectionStart: 1, selectionEnd: 4 })
  const sel = part(c, 'selection')
  expect(sel.style).toMatchObject({ position: 'absolute', left: CW, top: 0, width: 3 * CW, height: 22, bg: withAlpha('accent', 0.25, defaultTheme, 'light') })
  expect(parts(c, 'caret')).toEqual([])                        // no caret over a selection
  fire(host, 'pointermove', { x: fx - 50, y: 0 }); await nextTick()       // past the field's left edge: to the start
  expect(root.ime.synced.at(-1)).toMatchObject({ selectionStart: 0, selectionEnd: 1 })
  field.setState({ pressed: false }); const n = root.ime.synced.length
  fire(host, 'pointermove', { x: fx + 8 * CW, y: 0 })            // released: a hover move selects nothing
  expect(root.ime.synced).toHaveLength(n)
  fire(field, 'pointerdown', { localX: 3 * CW, localY: 5, pointerType: 'touch' }); field.setState({ pressed: true })
  fire(host, 'pointermove', { x: fx + 8 * CW, y: 0, pointerType: 'touch' })   // a finger places the caret; it does not drag-select
  expect(root.ime.synced.at(-1)).toMatchObject({ selectionStart: 3, selectionEnd: 3 })
})
it('a backward drag keeps its end in view: the proxy reporting the selection back does not scroll to the other end', async () => {
  const long = 'x'.repeat(40)
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: long, style: { width: 300 } }))
  const host = first(c, 'glass'); surface.focus.focus(host); await nextTick(); root.tick()
  const f = root.ime.active!, field = part(c, 'field'), fx = absoluteRect(field).x
  const scroll = () => -(part(c, 'text').style.left as number)
  expect(scroll()).toBeCloseTo(40 * CW - 260 + 2)                // the caret at the end
  fire(field, 'pointerdown', { localX: 258, localY: 5 }); field.setState({ pressed: true })
  fire(host, 'pointermove', { x: fx - 30, y: 0 }); await nextTick()   // dragged out past the left edge
  const s = root.ime.synced.at(-1)!, after = scroll()
  expect(s.selectionStart).toBeLessThan(s.selectionEnd); expect(after).toBeLessThan(40 * CW - 260 + 2)
  f.onChange(s); await nextTick()                               // the proxy's selectionchange: the same selection
  expect(scroll()).toBeCloseTo(after)
})
it('a password double-click selects it all; its kind stays password when revealed; the eye shows which way it goes', async () => {
  const { c, root, surface } = mountInSurface(() => h(Input, { type: 'password', modelValue: 'ab cd', style: { width: 300 } }))
  surface.focus.focus(first(c, 'glass')); await nextTick()
  fire(part(c, 'field'), 'dblclick', { localX: 1 * CW, localY: 5 })
  expect(root.ime.synced.at(-1)).toMatchObject({ selectionStart: 0, selectionEnd: 5 })
  const eyeSrc = () => first(part(c, 'eye'), 'image').props.src
  const tertiary = resolveColor('tertiaryLabel', defaultTheme, 'light')
  expect(eyeSrc()).toBe(iconCanvas('eye', 22, tertiary, 0.1, napiCanvas))
  fire(part(c, 'eye'), 'click'); await nextTick()
  expect(eyeSrc()).toBe(iconCanvas('eye-slash', 22, tertiary, 0.1, napiCanvas))
  expect(root.ime.active!.kind).toBe('password'); expect(part(c, 'text').props.value).toBe('ab cd')
})
it('a type change while focused hands the IME the field again (the proxy element swaps)', async () => {
  const type = ref<'text' | 'password'>('text')
  const { c, root, surface } = mountInSurface(() => h(Input, { type: type.value, modelValue: 'abc' }))
  surface.focus.focus(first(c, 'glass')); await nextTick()
  const f = root.ime.active!
  type.value = 'password'; await nextTick()
  expect(root.ime.focused).toEqual([f, f]); expect(f.kind).toBe('password')
})
it('touch: the tap that focuses the Input hands the proxy the page focus again in its click (a soft keyboard opens only in a gesture)', async () => {
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: 'abc' }))
  const host = first(c, 'glass')
  fire(host, 'pointerdown', { pointerType: 'touch' }); surface.focus.focusFromPointer(host)   // as the render's bridge: press, then focus
  const f = root.ime.active!
  expect(root.ime.focused).toEqual([f]); expect(root.ime.blurred).toEqual([])
  fire(host, 'click', { pointerType: 'touch' })                 // the tap's pointerup: blurred, then focused again
  expect(root.ime.blurred).toEqual([f]); expect(root.ime.focused).toEqual([f, f]); expect(root.ime.active).toBe(f)
  fire(host, 'pointerdown', { pointerType: 'touch' }); fire(host, 'click', { pointerType: 'touch' })   // already editing
  fire(host, 'pointerdown', { pointerType: 'mouse' }); fire(host, 'click', { pointerType: 'mouse' })
  expect(root.ime.focused).toHaveLength(2); expect(surface.focus.current).toBe(host)
})
it('disabled: dimmed, out of the Tab order, no hover, presses do nothing; disabling a focused Input blurs it', async () => {
  const disabled = ref(true)
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: 'abc', disabled: disabled.value }))
  const host = first(c, 'glass')
  expect(host.props.tabIndex).toBe(-1); expect(host.state.disabled).toBe(true)
  expect(host.style.disabled).toEqual({ opacity: 0.4 }); expect(host.style.hover).toBeUndefined()
  fire(part(c, 'field'), 'pointerdown', { localX: CW, localY: 5 }); expect(root.ime.synced).toEqual([])
  surface.focus.focus(host); expect(surface.focus.current).toBeNull()
  disabled.value = false; await nextTick()
  expect(host.props.tabIndex).toBe(0); expect(host.style.hover).toEqual(controlStyle().hover)
  surface.focus.focus(host); await nextTick(); expect(root.ime.active).not.toBeNull()
  disabled.value = true; await nextTick(); await nextTick()
  expect(surface.focus.current).toBeNull(); expect(root.ime.active).toBeNull()
})
it('the host: a clear glass capsule, the controls\' hover lift, tilt and glint but no press look, no key activation', async () => {
  const { c } = mountInSurface(() => h(Input, { modelValue: 'abc', style: { width: 300 } }))
  const host = first(c, 'glass')
  expect(host.style).toMatchObject({ height: 52, radius: 'capsule', flexDirection: 'row', alignItems: 'center', paddingX: 20, gap: 10 })
  expect(host.style.glass).toBeUndefined(); expect(host.style.pressed).toBeUndefined()
  expect(host.style.transition).toEqual(controlStyle().transition); expect(host.style.hover).toEqual(controlStyle().hover)
  expect(host.props.tabIndex).toBe(0)
  fire(host, 'pointerenter'); fire(host, 'pointermove', { localX: 280, localY: 26 })
  expect(host.elevation).toBe(6); expect(host.tilt.y).toBeGreaterThan(0)
  for (const t of ['keydown', 'keyup'] as const) expect(host.handlers.has(t)).toBe(false)
  expect(host.style.pressed).toBeUndefined()
})
it('sizes: small 36 / 15 / 14 / 18 / 8, regular 52 / 18 / 20 / 22 / 10, large the reference\'s field (84, 23 at 500, the theme\'s metrics)', () => {
  const tertiary = resolveColor('tertiaryLabel', defaultTheme, 'light')
  for (const [size, height, font, padX, icon, gap] of [['small', 36, 15, 14, 18, 8], ['regular', 52, 18, 20, 22, 10], ['large', 84, 23, 26, 28, 14]] as const) {
    const { c } = mountInSurface(() => h(Input, { size, leadingIcon: 'mail', placeholder: 'Email address', style: { width: 600 } }))
    const host = first(c, 'glass'), text = part(c, 'text')
    expect(host.style, size).toMatchObject({ height, paddingX: padX, gap })
    expect(text.style, size).toMatchObject({ fontSize: font, fontWeight: 500, color: 'tertiaryLabel' })
    expect(part(c, 'field').layout.height, size).toBe(Math.round(1.2 * font))
    const img = first(host, 'image')
    expect(img.props.src, size).toBe(iconCanvas('mail', icon, tertiary, 0.1, napiCanvas))
    expect(img.layout.width).toBe(icon)
  }
  const m = defaultTheme.metrics
  expect([m.controlPadding, m.icon, m.iconGap]).toEqual([26, 28, 14])
})
it('slots: leading replaces the icon, trailing sits before the clear button and the eye', () => {
  const { c } = mountInSurface(() => h(Input, { type: 'password', clearable: true, modelValue: 'x', leadingIcon: 'mail' }, {
    leading: () => h(Icon, { name: 'lock', size: 22 }), trailing: () => h(Icon, { name: 'info', size: 22 }),
  }))
  const host = first(c, 'glass'), kids = host.children.filter(n => n.type !== 'anchor' && !(n.type === 'text' && n.props.value === ''))
  expect(kids.map(n => n.type === 'image' ? 'image' : n.props.part ?? n.type)).toEqual(['image', 'field', 'image', 'clear', 'eye'])
  expect(all(host, 'image')[0]!.props.src).toBe(iconCanvas('lock', 22, resolveColor('label', defaultTheme, 'light'), 0.1, napiCanvas))
})
it('unmounting a focused Input clears its blink timer and lets the IME go', async () => {
  vi.useFakeTimers()
  try {
    const show = ref(true)
    const { c, root, surface } = mountInSurface(() => show.value ? h(Input, { modelValue: 'a' }) : null)
    surface.focus.focus(first(c, 'glass')); await nextTick()
    expect(vi.getTimerCount()).toBe(1)
    show.value = false; await nextTick()
    expect(vi.getTimerCount()).toBe(0); expect(root.ime.active).toBeNull()
  } finally { vi.useRealTimers() }
})
it('a final report during teardown (the bridge cuts the composition as the Input unmounts) is taken without error', async () => {
  const show = ref(true), errors: unknown[] = []
  const { c, root, surface } = mountInSurface(() => show.value ? h(Input, { modelValue: '', onBlur: () => {} }) : null)
  surface.focus.focus(first(c, 'glass')); await nextTick()
  const f = root.ime.active!
  f.onChange({ value: 'ni', selectionStart: 2, selectionEnd: 2, composition: { start: 0, end: 2 } }); await nextTick()
  root.ime.blur = function (this: typeof root.ime, g) {   // as the real bridge: the cut composition reported after letting go
    this.blurred.push(g); if (this.active === g) this.active = null
    try { g.onChange({ value: 'ni', selectionStart: 2, selectionEnd: 2, composition: null }) } catch (e) { errors.push(e) }
  }
  show.value = false; await nextTick(); root.tick()
  expect(errors).toEqual([]); expect(root.ime.active).toBeNull()
})
it('is registered with complete manifest metadata; a wrong prop is a readable error', () => {
  const m = glassComponents().find(g => g.glass.name === 'Input')!.glass
  expect(m.description.length).toBeGreaterThan(40)
  expect(m.examples.length).toBeGreaterThanOrEqual(2); expect(m.examples.length).toBeLessThanOrEqual(3)
  for (const e of m.examples) expect(e).toMatch(/<Input\b/)
  for (const [k, s] of Object.entries(m.props.shape)) expect((s as { description?: string }).description, k).toMatch(/[一-鿿]/)
  expect(Object.keys(m.events!)).toEqual(['update:modelValue', 'submit', 'focus', 'blur']); expect(Object.keys(m.slots!)).toEqual(['leading', 'trailing'])
  expect(mountGlass(() => h(Input, { type: 'email' })).errors[0]).toMatch(/\[Input\.type\].*你可能想要：text$/)
  expect(mountGlass(() => h(Input, { label: '邮箱' })).errors[0]).toMatch(/\[Input\] 未知属性 "label"/)
})

// ── fix round 1 ──

it('V1: a double-click on an unfocused Input selects the word, through the tracker and click-to-focus; the field\'s parts never take the pointer', async () => {
  for (const at of [8, 8.05, 6]) {                              // on boundaries, where the first click's caret appears under the pointer
    const { c, root, surface: s } = mountInSurface(() => h(Input, { modelValue: 'hello world', style: { width: 300 } }))
    const r = absoluteRect(part(c, 'field')), x = r.x + at * CW, y = r.y + 5
    const click = () => { s.pointer.down(x, y); s.focus.focusFromPointer(s.pointer.pressed); s.pointer.up(x, y) }   // as the render's bridge
    click(); await nextTick(); root.tick()
    expect(s.focus.current).toBe(first(c, 'glass')); expect(root.ime.active).toMatchObject({ selectionStart: Math.round(at), selectionEnd: Math.round(at) })
    expect(hitPart(s, x, y)).toBe('field')                      // the caret just placed under the pointer does not take the hit
    click(); await nextTick()
    expect(root.ime.active, `at ${at}`).toMatchObject({ selectionStart: 6, selectionEnd: 11 })
    expect(root.ime.synced.at(-1)).toMatchObject({ selectionStart: 6, selectionEnd: 11 })
  }
  // the selection panel and a composition's underline do not take it either
  const { c, root, surface: s } = mountInSurface(() => h(Input, { modelValue: 'hello world', style: { width: 300 } }))
  s.focus.focus(first(c, 'glass')); await nextTick()
  root.ime.active!.onChange({ value: 'hello world', selectionStart: 0, selectionEnd: 5, composition: null }); await nextTick(); root.tick()
  const r = absoluteRect(part(c, 'field'))
  expect(hitPart(s, r.x + 2 * CW, r.y + 5)).toBe('field')
  root.ime.active!.onChange({ value: 'hello worldni', selectionStart: 13, selectionEnd: 13, composition: { start: 11, end: 13 } }); await nextTick(); root.tick()
  expect(hitPart(s, r.x + 12 * CW, r.y + 22 - 1)).toBe('field')
})
it('M1: an outside change during a composition whose commit is refused is applied then, and the next keystroke is the user\'s', async () => {
  const v = ref<number | null>(1)
  const { c, root, surface } = mountInSurface(() => h(Input, { type: 'number', modelValue: v.value, 'onUpdate:modelValue': (x: number | null) => { v.value = x } }))
  surface.focus.focus(first(c, 'glass')); await nextTick()
  root.ime.fromProxy({ value: '1n', selectionStart: 2, selectionEnd: 2, composition: { start: 1, end: 2 } }); await nextTick()
  v.value = 5; await nextTick()                                  // the app sets it while the IME composes
  expect(part(c, 'text').props.value).toBe('1')
  root.ime.fromProxy({ value: '1你', selectionStart: 2, selectionEnd: 2, composition: null }); await nextTick()   // refused (not a number)
  expect(part(c, 'text').props.value).toBe('5'); expect(root.ime.synced.at(-1)).toMatchObject({ value: '5', selectionStart: 1, selectionEnd: 1 })
  root.ime.fromProxy({ value: '56', selectionStart: 2, selectionEnd: 2, composition: null }); await nextTick()
  expect(v.value).toBe(56); expect(part(c, 'text').props.value).toBe('56')
})
it('M2: the clear button does nothing while the IME composes (the proxy would keep its text); after the commit it clears', async () => {
  const v = ref('abc')
  const { c, root, surface } = mountInSurface(() => h(Input, { clearable: true, modelValue: v.value, 'onUpdate:modelValue': (x: string) => { v.value = x } }))
  surface.focus.focus(first(c, 'glass')); await nextTick()
  root.ime.fromProxy({ value: 'abcni', selectionStart: 5, selectionEnd: 5, composition: { start: 3, end: 5 } }); await nextTick()
  const synced = root.ime.synced.length
  fire(part(c, 'clear'), 'click'); await nextTick()
  expect(part(c, 'text').props.value).toBe('abcni'); expect(v.value).toBe('abc'); expect(root.ime.synced).toHaveLength(synced)
  root.ime.fromProxy({ value: 'abcnih', selectionStart: 6, selectionEnd: 6, composition: { start: 3, end: 6 } })
  root.ime.fromProxy({ value: 'abc你好', selectionStart: 5, selectionEnd: 5, composition: null }); await nextTick()
  expect(v.value).toBe('abc你好')
  fire(part(c, 'clear'), 'click'); await nextTick()
  expect(v.value).toBe(''); expect(root.ime.synced.at(-1)).toMatchObject({ value: '', selectionStart: 0, selectionEnd: 0 })
})
it('M6: an outside value is shown as an edit would leave it: on one line, held to maxLength, a number field\'s format', async () => {
  const v = ref<string | number | null>('one\ntwo')
  const { c, root, surface } = mountInSurface(() => h(Input, { maxLength: 5, modelValue: v.value }))
  expect(part(c, 'text').props.value).toBe('one t')
  surface.focus.focus(first(c, 'glass')); await nextTick()
  v.value = 'a\r\nb'; await nextTick()
  expect(part(c, 'text').props.value).toBe('a b'); expect(root.ime.synced.at(-1)).toMatchObject({ value: 'a b', selectionStart: 3, selectionEnd: 3 })
  const n = ref<unknown>(1e21)
  const m = mountInSurface(() => h(Input, { type: 'number', modelValue: n.value as number }))
  expect(part(m.c, 'text').props.value).toBe('1000000000000000000000')
  n.value = '１２。５'; await nextTick(); expect(part(m.c, 'text').props.value).toBe('12.5')
  n.value = 'abc'; await nextTick(); expect(part(m.c, 'text').props.value).toBe('')
})
it('M7: one composing flag: a press or double-click while the IME composes text a number field refused is ignored too', async () => {
  const { c, root, surface } = mountInSurface(() => h(Input, { type: 'number', modelValue: 12, style: { width: 300 } }))
  surface.focus.focus(first(c, 'glass')); await nextTick(); root.tick()
  root.ime.fromProxy({ value: '12n', selectionStart: 3, selectionEnd: 3, composition: { start: 2, end: 3 } }); await nextTick()
  expect(parts(c, 'composition')).toEqual([])                   // refused: nothing composing shows, yet the IME composes
  const f = root.ime.active!
  fire(part(c, 'field'), 'pointerdown', { localX: 0, localY: 5 })
  fire(part(c, 'field'), 'dblclick', { localX: 0, localY: 5 })
  expect([f.selectionStart, f.selectionEnd]).toEqual([2, 2])
})
