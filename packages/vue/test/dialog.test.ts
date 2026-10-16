import { it, expect } from 'vitest'
import { defineComponent, h, nextTick, ref, shallowRef } from '@vue/runtime-core'
import { defaultTheme, Spring, type Node } from '@glassui/core'
import type { Surface } from '@glassui/render'
import { glassComponents } from '../src/define'
import { useSurfaceRef } from '../src/inject'
import { useSpring, type SpringValue } from '../src/spring'
import { Dialog } from '../src/components/Dialog'
import { Text } from '../src/components/Text'
import { Button } from '../src/components/Button'
import { Input } from '../src/components/Input'
import { Stack } from '../src/components/Stack'
import { Space } from '../src/components/Space'
import { Block } from '../src/components/Block'
import { createFakeRoot, flush, type FakeRoot, type FakeSurface } from './fixtures/fake-root'
import { all, first, mountGlass, mountInSurface } from './fixtures/mount'
import { bubble, fire } from './fixtures/events'
import { byId } from './fixtures/tree'

/** The Dialog's two Surfaces (the last panel made, and the backdrop made just before it). */
const made = (root: FakeRoot): { backdrop: FakeSurface; panel: FakeSurface } => {
  const panel = root.surfacesMade.filter(s => s.created.center === true).at(-1)!
  return { backdrop: root.surfacesMade[root.surfacesMade.indexOf(panel) - 1]!, panel }
}
/** A fake Surface where the root's API takes a render one. */
const real = (s: FakeSurface): Surface => s as unknown as Surface
/** Ticks (with flushes) until `done()` or 200 ticks. */
async function tickUntil(root: FakeRoot, done: () => boolean, dt = 1 / 60): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) { root.tick(dt); await flush() }
}

// ── the brief's tests ──

it('opening creates a backdrop and a centred glass panel holding the slots', async () => {
  const open = ref(false), { root } = mountGlass(() => h(Dialog, { open: open.value, title: '删除项目？' }, { default: () => h(Text, { value: '此操作不可撤销。' }), footer: () => h(Button, { label: '删除', variant: 'filled' }) }), { motion: 'frozen' })
  open.value = true; await nextTick()
  const [backdrop, panel] = root.surfacesMade
  expect(backdrop!.created).toMatchObject({ layer: 'screen', fill: true, background: 'none' })
  expect(panel!.created).toMatchObject({ layer: 'screen', center: true, background: 'glass', cornerRadius: 32, width: 480 })
  expect(all(panel!.root, 'text').map(t => t.props.value)).toEqual(expect.arrayContaining(['删除项目？', '此操作不可撤销。', '删除']))
  root.tick(); await flush()
  expect(panel!.model.height).toBeGreaterThan(100)                       // measured from the content
})
it('Escape, a backdrop click and v-model all close; the surfaces go away', async () => {
  for (const how of ['escape', 'backdrop', 'model'] as const) {
    const open = ref(true), closes: string[] = []
    const { root } = mountGlass(() => h(Dialog, { open: open.value, title: 't', 'onUpdate:open': (v: boolean) => { open.value = v }, onClose: () => closes.push(how) },
      { default: () => h(Text, { value: 'x' }) }), { motion: 'frozen' })
    await nextTick()
    const [backdrop, panel] = root.surfacesMade
    if (how === 'escape') fire(panel!.root, 'keydown', { key: 'Escape' })
    if (how === 'backdrop') fire(backdrop!.root, 'click', { pointerType: 'mouse' })
    if (how === 'model') open.value = false
    await nextTick(); root.tick(); await flush()
    expect(open.value).toBe(false)
    expect(closes).toEqual(how === 'model' ? [] : [how])          // `close` reports a dismissal, not a parent's v-model change
    expect(root.surfaces).toEqual([])
  }
})
it('closeOnBackdrop and closeOnEscape can be turned off', async () => {
  const open = ref(true)
  const { root } = mountGlass(() => h(Dialog, { open: open.value, closeOnBackdrop: false, closeOnEscape: false, 'onUpdate:open': (v: boolean) => { open.value = v } }), { motion: 'frozen' })
  await nextTick()
  const [backdrop, panel] = root.surfacesMade
  fire(panel!.root, 'keydown', { key: 'Escape' }); fire(backdrop!.root, 'click', { pointerType: 'mouse' }); await nextTick()
  expect(open.value).toBe(true)
})
it('focus is trapped in the panel while open and restored on close', async () => {
  const open = ref(false)
  const { root, c } = mountGlass(() => h(Stack, () => [
    h(Button, { id: 'opener', label: 'Open', onPress: () => { open.value = true } }),
    h(Dialog, { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } }, { default: () => h(Input, { modelValue: '' }), footer: () => h(Button, { id: 'ok', label: 'OK' }) }),
  ]), { motion: 'frozen' })
  const host = root.createSurface({ width: 800, height: 600 }); host.root.appendChild(c)
  const opener = byId(c, 'opener')!
  host.focus.focus(opener); root.pointer!.active = host
  open.value = true; await nextTick(); root.tick(); await flush()
  const panel = root.surfacesMade.find(s => s.created.center)!
  expect(panel.trapFocus).toBe(true); expect(root.pointer!.setActive).toHaveBeenLastCalledWith(panel)
  expect(panel.focus.current?.type).toBe('glass')                     // the Input's host, the first focusable
  open.value = false; await nextTick(); root.tick(); await flush()
  expect(root.pointer!.setActive).toHaveBeenLastCalledWith(host); expect(host.focus.current).toBe(opener)
})
it('open and close in the same frame leaves no surfaces (Review Focus 4)', async () => {
  const open = ref(false), { root } = mountGlass(() => h(Dialog, { open: open.value }), { motion: 'live' })
  open.value = true; await nextTick(); open.value = false; await nextTick()
  for (let i = 0; i < 200 && root.surfaces.length; i++) { root.tick(); await flush() }
  expect(root.surfaces).toEqual([])
})

// ── the spatial note (spatial spec §7) ──

it('in a Space, closing gives the keys back to the focused Block, whose trap stays on', async () => {
  const root = createFakeRoot(), open = ref(false)
  const m = mountGlass(() => h(Space, null, () => [h(Block, { name: 'a', width: 488, height: 400 }, () => [
    h(Button, { id: 'opener', label: '打开' }),
    h(Dialog, { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } }, { default: () => h(Text, { value: '在空间里' }), footer: () => h(Button, { label: '好' }) }),
  ])]), { root, motion: 'frozen' })
  await flush()
  const block = root.surfacesMade[0]!
  expect(block.trapFocus).toBe(true); expect(root.pointer!.setActive).toHaveBeenLastCalledWith(block)
  const opener = byId(block.root, 'opener')!
  block.focus.focus(opener)
  open.value = true; await nextTick(); root.tick(); await flush()
  const { panel } = made(root)
  expect(root.pointer!.setActive).toHaveBeenLastCalledWith(panel)
  fire(panel.root, 'keydown', { key: 'Escape' }); await nextTick(); root.tick(); await flush()
  expect(open.value).toBe(false)
  expect(root.pointer!.setActive).toHaveBeenLastCalledWith(block); expect(block.trapFocus).toBe(true)
  expect(block.focus.current).toBe(opener)
  expect(root.surfaces).toEqual([block]); expect(m.errors).toEqual([])
})

// ── focus, keys and the IME ──

it('a blur listener refocusing through useSurfaceRef finds no Surface once the Dialog closes (the Task 9 carry)', async () => {
  // the content stops seeing the panel before the panel's focus is blurred: a focus trap of its own that refocuses on
  // blur cannot land back in the panel, which would leave two focused nodes (one there, the opener's)
  const Sticky = defineComponent(() => {
    const surface = useSurfaceRef(), el = shallowRef<Node | null>(null)
    return () => h('box', { ref: el, id: 'sticky', tabIndex: 0, style: { height: 20 }, onBlur: () => { const n = el.value; if (n) surface.value?.focus.focus(n) } })
  })
  const open = ref(false)
  const { root, c } = mountGlass(() => h(Stack, () => [
    h(Button, { id: 'opener', label: 'Open' }),
    h(Dialog, { open: open.value }, { default: () => h(Sticky) }),
  ]), { motion: 'live' })
  const host = root.createSurface({ width: 800, height: 600 }); host.root.appendChild(c)
  const opener = byId(c, 'opener')!
  host.focus.focus(opener); root.pointer!.active = host
  open.value = true; await nextTick(); root.tick(); await flush()
  const { panel } = made(root)
  expect(panel.focus.current?.id).toBe('sticky')
  open.value = false; await nextTick()
  expect(panel.focus.current).toBeNull()                               // the blur stood
  expect(root.pointer!.setActive).toHaveBeenLastCalledWith(host); expect(host.focus.current).toBe(opener)
  await tickUntil(root, () => panel.disposed)
  expect(panel.disposed).toBe(true); expect(panel.focus.current).toBeNull()
})
it('closing while the Input composes lets the IME go, then gives the opener its keys and focus back', async () => {
  const open = ref(true), text = ref('')
  const { root, c, errors } = mountGlass(() => h(Stack, () => [
    h(Button, { id: 'opener', label: 'Open' }),
    h(Dialog, { open: open.value, title: '重命名' }, { default: () => h(Input, { modelValue: text.value, 'onUpdate:modelValue': (v: string) => { text.value = v } }) }),
  ]), { motion: 'live' })
  const host = root.createSurface({ width: 800, height: 600 }); host.root.appendChild(c)
  await nextTick(); root.tick(); await flush()
  const { panel } = made(root)
  const field = root.ime.active!
  expect(field.surface).toBe(panel)                                    // the Input sees the panel as its Surface
  root.ime.fromProxy({ value: 'ni', selectionStart: 2, selectionEnd: 2, composition: { start: 0, end: 2 } }); await nextTick()
  expect(root.pointer!.active).toBe(panel)
  open.value = false; await nextTick(); await nextTick()
  expect(root.ime.active).toBeNull(); expect(root.ime.blurred).toContain(field)
  expect(panel.disposed).toBe(false)                                   // still leaving
  expect(root.pointer!.setActive).toHaveBeenLastCalledWith(null)       // nothing held the keys before it opened
  await tickUntil(root, () => root.surfaces.length === 1)
  expect(root.surfaces).toEqual([host]); expect(errors).toEqual([])
})
it('Escape on a focused footer Button bubbles to the panel root and closes', async () => {
  const open = ref(true)
  const { root } = mountGlass(() => h(Dialog, { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } }, { footer: () => h(Button, { id: 'ok', label: '好' }) }), { motion: 'frozen' })
  await nextTick()
  const { panel } = made(root)
  bubble(byId(panel.root, 'ok')!, 'keydown', { key: 'Escape' }); await nextTick()
  expect(open.value).toBe(false)
})
it('Escape typed into the Input it focused on open closes it in one press (the keydown goes on up from the field)', async () => {
  const open = ref(true), closes: number[] = []
  const { root } = mountGlass(() => h(Dialog, { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v }, onClose: () => closes.push(1) }, { default: () => h(Input, { modelValue: '' }) }), { motion: 'frozen' })
  await nextTick()
  const field = root.ime.active!
  expect(field.onKey({ key: 'Escape', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })).toBe(true)
  await nextTick()
  expect(closes).toEqual([1]); expect(open.value).toBe(false); expect(root.ime.active).toBeNull()
})
it('a press on the backdrop that does not close gives the keys back to the panel', async () => {
  const open = ref(true)
  const { root } = mountGlass(() => h(Dialog, { open: open.value, closeOnBackdrop: false }), { motion: 'frozen' })
  await nextTick()
  const { backdrop, panel } = made(root)
  root.pointer!.active = real(backdrop)                                // the pointer bridge gives a pressed Surface the keys
  fire(backdrop.root, 'pointerup', { pointerType: 'mouse' })
  expect(root.pointer!.setActive).toHaveBeenLastCalledWith(panel)
  root.pointer!.active = real(backdrop)
  fire(backdrop.root, 'pointercancel', { pointerType: 'touch' })
  expect(root.pointer!.setActive).toHaveBeenLastCalledWith(panel)
  fire(backdrop.root, 'click', { pointerType: 'mouse' }); await nextTick()
  expect(panel.disposed).toBe(false)
})
it('Escape while a press on the backdrop holds the keys closes too', async () => {
  const open = ref(true)
  const { root } = mountGlass(() => h(Dialog, { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } }), { motion: 'frozen' })
  await nextTick()
  fire(made(root).backdrop.root, 'keydown', { key: 'Escape' }); await nextTick()
  expect(open.value).toBe(false); expect(root.surfaces).toEqual([])
})
it('keys taken elsewhere while it was open are left there on close', async () => {
  const open = ref(true), { root } = mountGlass(() => h(Dialog, { open: open.value }), { motion: 'frozen' })
  await nextTick()
  const other = root.createSurface({ width: 100, height: 100 })
  root.pointer!.setActive(other)                                       // e.g. a Space moved its focus meanwhile
  const calls = (root.pointer!.setActive as unknown as { mock: { calls: unknown[] } }).mock.calls.length
  open.value = false; await nextTick()
  expect((root.pointer!.setActive as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(calls)
  expect(root.pointer!.active).toBe(other)
})

// ── the panel's size and motion ──

it('the panel stays hidden (scale 0) until measured, then springs 0.9 → 1 and fades in; leave reverses, then both go', async () => {
  const open = ref(false)
  const { root } = mountInSurface(() => h(Dialog, { open: open.value, title: '标题' }, { default: () => h(Text, { value: '内容' }) }), { motion: 'live' })
  open.value = true; await nextTick()
  const { backdrop, panel } = made(root)
  expect(panel.scale.x).toBe(0); expect(panel.opacity).toBe(0)
  expect(backdrop.castShadows).toBe(false); expect(panel.castShadows).toBe(false)   // floating over everything: no shadow onto the scene
  expect(backdrop.root.style).toMatchObject({ bg: 'scrim', opacity: 1, transition: { opacity: 'smooth' } })
  root.tick(); await flush()                                           // laid out: measured
  expect(panel.model.height).toBeGreaterThan(100)
  expect(panel.scale.x).toBeCloseTo(0.9); expect(panel.opacity).toBe(0)
  root.tick(); await flush()
  expect(panel.scale.x).toBeGreaterThan(0.9); expect(panel.opacity).toBeGreaterThan(0)
  await tickUntil(root, () => panel.scale.x === 1)
  expect(panel.scale.x).toBe(1); expect(panel.opacity).toBe(1)
  expect(backdrop.root.visual?.opacity).toBeGreaterThan(0.5)         // the scrim's smooth fade is a little slower
  await tickUntil(root, () => (backdrop.root.visual?.opacity ?? 1) === 1)
  open.value = false; await nextTick()
  expect(panel.interactive).toBe(false); expect(backdrop.interactive).toBe(false); expect(backdrop.root.style.opacity).toBe(0)
  root.tick(); await flush(); root.tick(); await flush()
  expect(panel.disposed).toBe(false); expect(panel.scale.x).toBeLessThan(1); expect(panel.scale.x).toBeGreaterThan(0.9)
  expect(all(panel.root, 'text').filter(t => t.props.value !== '').length).toBe(2)   // the content leaves with the panel
  await tickUntil(root, () => panel.disposed)
  expect(panel.disposed).toBe(true); expect(backdrop.disposed).toBe(true); expect(all(panel.root, 'text').filter(t => t.props.value !== '')).toEqual([])
})
it('opening again during the leave turns the same Surfaces back', async () => {
  const open = ref(true)
  const { root } = mountInSurface(() => h(Dialog, { open: open.value }, { default: () => h(Text, { value: '内容' }) }), { motion: 'live' })
  await nextTick(); await tickUntil(root, () => made(root).panel.scale.x === 1)
  const { backdrop, panel } = made(root), count = root.surfacesMade.length
  open.value = false; await nextTick(); root.tick(); await flush()
  open.value = true; await nextTick()
  expect(panel.interactive).toBe(true); expect(backdrop.interactive).toBe(true); expect(backdrop.root.style.opacity).toBe(1)
  expect(root.pointer!.setActive).toHaveBeenLastCalledWith(panel)
  await tickUntil(root, () => panel.scale.x === 1)
  for (let i = 0; i < 30; i++) { root.tick(); await flush() }
  expect(panel.disposed).toBe(false); expect(panel.scale.x).toBe(1); expect(root.surfacesMade.length).toBe(count)
})
it('the panel follows its content and its width', async () => {
  const open = ref(true), lines = ref(['一行']), width = ref(480)
  const { root } = mountGlass(() => h(Dialog, { open: open.value, width: width.value }, { default: () => lines.value.map(l => h(Text, { key: l, value: l })) }), { motion: 'frozen' })
  await nextTick(); root.tick(); await flush()
  const { panel } = made(root), h1 = panel.model.height
  const column = first(panel.root, 'box')
  expect(h1).toBeCloseTo(column.layout.height)
  expect(column.style).toMatchObject({ flexDirection: 'column', padding: 28, gap: 20, flexShrink: 0 })
  lines.value = ['一行', '两行', '三行']; await nextTick(); root.tick(); await flush()
  expect(panel.model.height).toBeGreaterThan(h1); expect(panel.model.height).toBeCloseTo(column.layout.height)
  width.value = 360; await nextTick(); root.tick(); await flush()
  expect(panel.model.width).toBe(360)
})
it('tw, class, style and id fall through to the content column', async () => {
  const { root } = mountGlass(() => h(Dialog, { open: true, id: 'dlg', style: { gap: 8 }, tw: 'items-center' }, { default: () => h(Text, { value: 'x' }) }), { motion: 'frozen' })
  await nextTick()
  const column = byId(made(root).panel.root, 'dlg')!
  expect(column.style).toMatchObject({ flexDirection: 'column', padding: 28, gap: 8, alignItems: 'center' })
})
it('the title is 22 pt bold, the footer a right-aligned row with gap 12', async () => {
  const { root } = mountGlass(() => h(Dialog, { open: true, title: '标题' }, { footer: () => [h(Button, { label: '取消' }), h(Button, { label: '好' })] }), { motion: 'frozen' })
  await nextTick()
  const { panel } = made(root), column = first(panel.root, 'box')
  const title = column.children.find(n => n.type === 'text')!
  expect(title.props.value).toBe('标题'); expect(title.style).toMatchObject({ fontSize: 22, fontWeight: 700 })
  const row = column.children.at(-1)!
  expect(row.style).toMatchObject({ flexDirection: 'row', gap: 12, justifyContent: 'flex-end' })
  expect(all(row, 'text').map(t => t.props.value)).toEqual(['取消', '好'])
})

// ── teardown ──

it('unmounting the Dialog while open removes both Surfaces at once and gives the keys back', async () => {
  const show = ref(true), open = ref(true)
  const { root, c, errors } = mountGlass(() => h(Stack, () => [
    h(Button, { id: 'opener', label: 'Open' }),
    show.value ? h(Dialog, { open: open.value }, { default: () => h(Input, { modelValue: '' }) }) : null,
  ]), { motion: 'live' })
  const host = root.createSurface({ width: 800, height: 600 }); host.root.appendChild(c)
  await nextTick(); root.tick(); await flush()
  const { backdrop, panel } = made(root), field = root.ime.active!, listeners = root.listenerCount('theme')
  expect(field).not.toBeNull()
  show.value = false; await nextTick()
  expect(backdrop.disposed).toBe(true); expect(panel.disposed).toBe(true)
  expect(root.ime.active).toBeNull(); expect(root.surfaces).toEqual([host])
  for (let i = 0; i < 10; i++) { root.tick(); await flush() }         // no loop left running on the gone Surfaces
  expect(errors).toEqual([]); expect(root.listenerCount('theme')).toBe(listeners - 2)   // the Input's (useTheme, useScheme) went with it
})
it('unmounting it mid-leave ends the leave; nothing is left behind', async () => {
  const show = ref(true), open = ref(true)
  const { root, errors } = mountInSurface(() => show.value ? h(Dialog, { open: open.value }, { default: () => h(Text, { value: 'x' }) }) : null, { motion: 'live' })
  await nextTick(); root.tick(); await flush(); root.tick(); await flush()
  const { panel } = made(root)
  open.value = false; await nextTick(); root.tick(); await flush()
  expect(panel.disposed).toBe(false)
  show.value = false; await nextTick()
  expect(panel.disposed).toBe(true); expect(root.surfaces.length).toBe(1)
  for (let i = 0; i < 10; i++) { root.tick(); await flush() }
  expect(errors).toEqual([])
})
it('a disposed root (no Surfaces left, its afterTick at once) ends the measure loop and the spring without spinning', async () => {
  const { root } = mountGlass(() => h(Dialog, { open: true }, { default: () => h(Text, { value: 'x' }) }), { motion: 'live' })
  await nextTick(); root.tick(); await flush(); root.tick(); await flush()
  const { panel } = made(root)
  expect(panel.scale.x).toBeGreaterThan(0.9); expect(panel.scale.x).toBeLessThan(1)   // measured, springing in
  for (const s of [...root.surfaces]) root.removeSurface(s)                          // as the root's dispose does
  let calls = 0
  // as a disposed root's afterTick (bounded here, so a spin fails the test instead of hanging it)
  root.afterTick = () => ++calls > 50 ? new Promise<number>(() => {}) : Promise.resolve(0)
  root.tick(); for (let i = 0; i < 10; i++) await flush()                         // the waiting measure and step run once
  expect(calls).toBe(0)
})

// ── useSpring ──

it('useSpring steps once per root tick by that tick\'s dt and resolves true when it rests', async () => {
  const seen: number[] = []
  let s!: SpringValue
  const C = defineComponent(() => { s = useSpring(0.9, { spring: 'snappy', onStep: v => seen.push(v) }); return () => null })
  const { root } = mountInSurface(() => h(C), { motion: 'live' })
  const done = s.to(1)
  let settled: boolean | undefined
  void done.then(v => { settled = v })
  const ref = new Spring(0.9, defaultTheme.springs.snappy); ref.set(1)
  root.tick(0.05); await flush()
  expect(s.value).toBeCloseTo(ref.step(0.05), 10); expect(seen).toEqual([s.value])
  root.tick(0.02); await flush()
  expect(s.value).toBeCloseTo(ref.step(0.02), 10)
  await tickUntil(root, () => settled !== undefined)
  expect(settled).toBe(true); expect(s.value).toBe(1); expect(seen.at(-1)).toBe(1)
})
it('useSpring: a retarget resolves the older call false; jump rests at once; frozen motion jumps', async () => {
  const seen: number[] = []
  let s!: SpringValue
  const C = defineComponent(() => { s = useSpring(0, { spring: 'snappy', onStep: v => seen.push(v) }); return () => null })
  const { root } = mountInSurface(() => h(C), { motion: 'live' })
  const results: boolean[] = []
  void s.to(1).then(v => results.push(v))
  root.tick(); await flush()
  void s.to(0).then(v => results.push(v)); await flush()
  expect(results).toEqual([false])
  s.jump(0.5); await flush()
  expect(results).toEqual([false, false]); expect(s.value).toBe(0.5); expect(seen.at(-1)).toBe(0.5)

  let f!: SpringValue
  const F = defineComponent(() => { f = useSpring(0, { spring: 'snappy', onStep: () => {} }); return () => null })
  mountInSurface(() => h(F), { motion: 'frozen' })
  let ok: boolean | undefined
  void f.to(1).then(v => { ok = v }); await flush()
  expect(f.value).toBe(1); expect(ok).toBe(true)
})
it('useSpring under reduced motion jumps; its scope ending resolves a running call false', async () => {
  let s!: SpringValue
  const show = ref(true)
  const C = defineComponent(() => { s = useSpring(0, { spring: 'smooth', onStep: () => {} }); return () => null })
  const { root } = mountInSurface(() => show.value ? h(C) : null, { motion: 'live' })
  root.anim.reducedMotion = true
  void s.to(1); expect(s.value).toBe(1)
  root.anim.reducedMotion = false
  let r: boolean | undefined
  void s.to(0).then(v => { r = v })
  show.value = false; await nextTick(); await flush()
  expect(r).toBe(false)
  root.tick(); await flush(); expect(s.value).toBe(1)                  // nothing steps it any more
})

// ── the manifest ──

it('Dialog is registered with complete manifest metadata', () => {
  const m = glassComponents().find(g => g.glass.name === 'Dialog')!.glass
  expect(m.description.length).toBeGreaterThan(40)
  expect(m.examples.length).toBeGreaterThanOrEqual(2); expect(m.examples.length).toBeLessThanOrEqual(3)
  for (const e of m.examples) expect(e).toMatch(/<Dialog\b/)
  for (const [k, s] of Object.entries(m.props.shape)) expect((s as { description?: string }).description, `Dialog.${k}`).toMatch(/[一-鿿]/)
  expect(Object.keys(m.props.shape)).toEqual(['open', 'title', 'width', 'closeOnBackdrop', 'closeOnEscape'])
  expect(Object.keys(m.events!)).toEqual(['update:open', 'close']); expect(Object.keys(m.slots!)).toEqual(['default', 'footer'])
  expect(m.mistakes!.length).toBeGreaterThan(0)
})
