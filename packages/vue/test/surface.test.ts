import { it, expect } from 'vitest'
import { defineComponent, h, isReadonly, nextTick, ref, shallowRef, watch, type Ref } from '@vue/runtime-core'
import { createGlassApp } from '../src/app'
import { glassComponents } from '../src/define'
import { useSurface, useSurfaceRef } from '../src/inject'
import { Surface, ScreenLayer, WorldLayer } from '../src/components/Surface'
import { Text } from '../src/components/Text'
import { createFakeRoot } from './fixtures/fake-root'
import { mountGlass, napiCanvas } from './fixtures/mount'
import { byId, tree } from './fixtures/tree'

it('creates a world Surface, teleports its slot into it, and applies the transform', async () => {
  const root = createFakeRoot()
  const pos = ref<[number, number, number]>([0, 1.5, -2])
  mountGlass(() => h(Surface, { width: 400, height: 300, position: pos.value, rotation: [0, -0.3, 0], background: 'glass' }, () => [h(Text, { value: 'hi' })]), { root })
  const s = root.surfacesMade[0]!
  expect(s.model).toMatchObject({ width: 400, height: 300, background: 'glass', placement: 'world' })
  expect([s.position.x, s.position.y, s.position.z]).toEqual([0, 1.5, -2]); expect(s.rotation.y).toBeCloseTo(-0.3)
  // brief: first(s.root, 'text').props.value — but Vue 3.5 puts the Teleport's empty `targetStart` text anchor first
  expect(tree(s.root).children).toEqual([{ type: 'text', value: 'hi' }])
  pos.value = [1, 1, 1]; await nextTick(); expect(s.position.x).toBe(1)
})
it('ScreenLayer makes its Surfaces screen Surfaces; fill/left/top/center pass through', () => {
  const root = createFakeRoot()
  mountGlass(() => h(ScreenLayer, () => [h(Surface, { width: 200, height: 100, center: true })]), { root })
  expect(root.surfacesMade[0]!.created).toMatchObject({ layer: 'screen', center: true })
})
it('unmounting removes the Surface; a size change resizes it', async () => {
  const root = createFakeRoot(), show = ref(true), w = ref(200)
  mountGlass(() => show.value ? h(Surface, { width: w.value, height: 100 }) : null, { root })
  const s = root.surfacesMade[0]!
  w.value = 300; await nextTick(); expect(s.model.width).toBe(300)
  show.value = false; await nextTick(); expect(s.disposed).toBe(true); expect(root.surfaces).not.toContain(s)
})
it('children see their Surface through useSurface', () => {
  const root = createFakeRoot(); let seen: unknown
  const Probe = defineComponent(() => { seen = useSurface(); return () => null })
  mountGlass(() => h(Surface, { width: 10, height: 10 }, () => [h(Probe)]), { root })
  expect(seen).toBe(root.surfacesMade[0])
})

// ── beyond the brief's four ──

it('passes the look and placement options through, absent ones absent; WorldLayer and an explicit layer pick the layer', () => {
  const root = createFakeRoot()
  const { errors } = mountGlass(() => [
    h(Surface, { width: 300, height: 200, background: 'fill', radius: 24, ptPerUnit: 300, contentScale: 2, billboard: true, interactive: false }),
    h(ScreenLayer, () => [h(Surface, { width: 100, height: 50, left: 12, top: 34 }), h(Surface, { width: 100, height: 50, fill: true }), h(WorldLayer, () => [h(Surface, { width: 10, height: 10 })])]),
    h(WorldLayer, () => [h(Surface, { layer: 'screen', width: 10, height: 10 })]),
  ], { root })
  expect(errors).toEqual([])
  const [world, screen, filled, inner, explicit] = root.surfacesMade
  expect(world!.created).toEqual({ layer: 'world', width: 300, height: 200, background: 'fill', cornerRadius: 24, ptPerUnit: 300, contentScale: 2, billboard: true, interactive: false })
  expect(world!.billboard).toBe(true); expect(world!.interactive).toBe(false)
  expect(screen!.created).toEqual({ layer: 'screen', width: 100, height: 50, background: 'none', cornerRadius: 0, billboard: false, interactive: true, left: 12, top: 34 })
  expect(filled!.created).toMatchObject({ layer: 'screen', fill: true })
  expect(inner!.created.layer).toBe('world')            // the nearest layer component wins
  expect(explicit!.created.layer).toBe('screen')        // the prop wins over the layer component
})
it('castShadows reaches the Surface (default true) and changes in place, without making it again', async () => {
  const root = createFakeRoot(), casts = ref(false)
  const { errors } = mountGlass(() => [h(Surface, { width: 300, height: 170, background: 'glass', castShadows: casts.value }), h(Surface, { width: 10, height: 10 })], { root })
  expect(errors).toEqual([])
  const [panel, plain] = root.surfacesMade
  expect(panel!.castShadows).toBe(false); expect(plain!.castShadows).toBe(true)
  casts.value = true; await nextTick()
  expect(root.surfacesMade).toHaveLength(2); expect(panel!.castShadows).toBe(true)
})
it('a placement, background or creation-fixed look change recreates the Surface and moves the content; size, transform, billboard and interactive do not', async () => {
  const root = createFakeRoot(), props = ref<Record<string, unknown>>({ layer: 'screen', width: 200, height: 100 })
  const { errors } = mountGlass(() => h(Surface, props.value, () => [h(Text, { id: 'in', value: 'in' })]), { root })
  const surfaces = (): number => root.surfacesMade.length
  const update = async (patch: Record<string, unknown>): Promise<void> => { props.value = { ...props.value, ...patch }; await nextTick() }
  await update({ width: 300, height: 120, rotation: [0, 0.1, 0], scale: 2, interactive: false })
  expect(surfaces()).toBe(1)
  const a = root.surfacesMade[0]!
  expect([a.model.width, a.model.height, a.rotation.y, a.scale.x, a.interactive]).toEqual([300, 120, 0.1, 2, false])
  for (const patch of [{ center: true }, { center: false, left: 10 }, { top: 5 }, { fill: true }, { background: 'glass' }, { radius: 12 }, { contentScale: 2 }, { layer: 'world', fill: undefined, left: undefined, top: undefined, center: undefined }, { ptPerUnit: 100 }]) {
    const before = surfaces(), old = root.surfacesMade[before - 1]!
    await update(patch)
    expect(surfaces(), JSON.stringify(patch)).toBe(before + 1)
    const now = root.surfacesMade[before]!
    expect(old.disposed).toBe(true); expect(root.surfaces).toEqual([now])
    expect(byId(now.root, 'in')?.props.value).toBe('in'); expect(byId(old.root, 'in')).toBeNull()
    expect([now.rotation.y, now.scale.x, now.interactive]).toEqual([0.1, 2, false])   // the transform and flags follow
  }
  expect(root.surfacesMade.at(-1)!.created).toMatchObject({ layer: 'world', background: 'glass', cornerRadius: 12, contentScale: 2, ptPerUnit: 100, width: 300, height: 120 })
  await update({ billboard: true, position: [1, 2, 3] })
  expect(surfaces()).toBe(10); expect(root.surfacesMade[9]!.billboard).toBe(true); expect(root.surfacesMade[9]!.position.z).toBe(3)
  expect(errors).toEqual([])
})
it('a fill Surface keeps the size its layer gives it: width and height are only its initial size', async () => {
  const root = createFakeRoot(), on = ref(true)
  mountGlass(() => h(ScreenLayer, () => [h(Surface, { width: 200, height: 100, fill: true, interactive: on.value })]), { root })
  const s = root.surfacesMade[0]!
  s.setSize(1280, 900)                                  // as the screen layer does for the viewport
  on.value = false; await nextTick()
  expect([s.model.width, s.model.height, s.interactive]).toEqual([1280, 900, false])
})
it('later reads of useSurface see a recreated Surface; the provided ref is not reactive-wrapped', async () => {
  const root = createFakeRoot(), bg = ref('none'), late = ref(false), seen: unknown[] = []
  const Probe = defineComponent(() => { seen.push(useSurface()); return () => null })
  mountGlass(() => h(Surface, { width: 10, height: 10, background: bg.value }, () => [h(Probe), late.value ? h(Probe) : null]), { root })
  bg.value = 'glass'; await nextTick()
  late.value = true; await nextTick()
  expect(seen).toEqual([root.surfacesMade[0], root.surfacesMade[1]])
  expect(seen[1]).toBe(root.surfacesMade[1])
})
it('a recreated Surface keeps the focus (ring as it was) and the keys; the press and hover are released (Review Focus 2)', async () => {
  const root = createFakeRoot(), bg = ref('none'), show = ref(true), events: string[] = []
  const on = (t: string) => () => { events.push(t) }
  mountGlass(() => h(Surface, { layer: 'screen', width: 100, height: 100, background: bg.value }, () => [
    show.value ? h('glass', { id: 'g', tabIndex: 0, style: { width: 40, height: 40 }, onFocus: on('focus'), onBlur: on('blur'), onPointercancel: on('pointercancel'), onPointerleave: on('pointerleave') }) : null,
  ]), { root })
  root.tick()
  const [a] = root.surfacesMade, g = byId(a!.root, 'g')!
  root.pointer!.setActive(a as never)                     // the keys go to it, as after a press
  a!.focus.next()                                         // keyboard focus: the ring shows
  a!.pointer.move(10, 10); a!.pointer.down(10, 10)        // hovered and pressed (a drag in progress)
  expect(g.state).toMatchObject({ focused: true, focusVisible: true, hover: true, pressed: true })
  events.length = 0
  bg.value = 'glass'; await nextTick()
  const b = root.surfacesMade[1]!
  expect(byId(b.root, 'g')).toBe(g)
  expect(b.focus.current).toBe(g); expect(g.state).toMatchObject({ focused: true, focusVisible: true, hover: false, pressed: false })
  expect(root.pointer!.active).toBe(b)                    // Tab and keys carry on in the new Surface
  expect(events).toEqual(['pointercancel', 'pointerleave', 'blur', 'focus'])
  b.focus.focus(null)                                     // the new focus manager owns it: blurring clears it
  expect(g.state).toMatchObject({ focused: false, focusVisible: false })
  // focus from a press has no ring, and keeps none; keys elsewhere stay elsewhere
  b.focus.focusFromPointer(g); root.pointer!.setActive(null)
  bg.value = 'fill'; await nextTick()
  const c = root.surfacesMade[2]!
  expect(c.focus.current).toBe(g); expect(g.state).toMatchObject({ focused: true, focusVisible: false }); expect(root.pointer!.active).toBeNull()
  // a focused node removed in the same update is not focused again
  bg.value = 'none'; show.value = false; await nextTick()
  const d = root.surfacesMade[3]!
  expect(d.focus.current).toBeNull(); expect(g.state.focused).toBe(false); expect(g.parent).toBeNull()
})
it('unmounting a Surface blurs its focused node and cancels its press while the content is still mounted', async () => {
  const root = createFakeRoot(), show = ref(true), events: string[] = []
  mountGlass(() => show.value ? h(Surface, { layer: 'screen', width: 100, height: 100 }, () => [
    h('glass', { id: 'g', tabIndex: 0, style: { width: 40, height: 40 }, onBlur: () => { events.push('blur') }, onPointercancel: () => { events.push('pointercancel') } }),
  ]) : null, { root })
  root.tick()
  const s = root.surfacesMade[0]!, g = byId(s.root, 'g')!
  s.focus.next(); s.pointer.down(10, 10)
  show.value = false; await nextTick()
  expect(events).toEqual(['pointercancel', 'blur'])
  expect(g.state).toMatchObject({ focused: false, pressed: false, hover: false }); expect(s.disposed).toBe(true)
})
it('useSurfaceRef follows a recreated Surface; useSurface is the one at call time', async () => {
  const root = createFakeRoot(), bg = ref('none'), seen: unknown[] = []
  let live: Readonly<Ref<unknown>> | undefined, once: unknown
  const Probe = defineComponent(() => { live = useSurfaceRef(); once = useSurface(); watch(live, v => { seen.push(v) }); return () => null })
  mountGlass(() => h(Surface, { width: 10, height: 10, background: bg.value }, () => [h(Probe)]), { root })
  const [a] = root.surfacesMade
  expect(live!.value).toBe(a)
  bg.value = 'glass'; await nextTick()
  const b = root.surfacesMade[1]
  expect(live!.value).toBe(b); expect(once).toBe(a); expect(seen).toEqual([b])
  expect(isReadonly(live)).toBe(true)
  // outside a <Surface>: the Surface the app was mounted on, or null in a detached container
  const s = root.createSurface({ width: 10, height: 10 })
  createGlassApp(Probe, { root, createCanvas: napiCanvas }).mount(s)
  expect(live!.value).toBe(s)
  mountGlass(() => h(Probe))
  expect(live!.value).toBeNull()
})
it('a Surface failure reaches @error; the listener leaves with the Surface, recreated or unmounted', async () => {
  const root = createFakeRoot(), bg = ref('none'), show = ref(true), got: unknown[] = []
  mountGlass(() => show.value ? h(Surface, { width: 10, height: 10, background: bg.value, onError: (e: unknown) => { got.push(e) } }) : null, { root })
  const a = root.surfacesMade[0]!
  expect(a.listenerCount('error')).toBe(1)
  a.markFailed(new Error('boom'))
  expect(got).toEqual([a.error]); expect(String(got[0])).toMatch(/boom/)
  bg.value = 'glass'; await nextTick()
  const b = root.surfacesMade[1]!
  expect(a.listenerCount('error')).toBe(0); expect(b.listenerCount('error')).toBe(1)
  show.value = false; await nextTick()
  expect(b.disposed).toBe(true); expect(b.listenerCount('error')).toBe(0)
  expect(got).toHaveLength(1)
})
it('a layer-specific prop on the other layer, an unknown background and a bad size are readable errors (Review Focus 5)', () => {
  const err = (render: () => unknown): string => { const root = createFakeRoot(); const { errors } = mountGlass(render as never, { root }); expect(root.surfaces).toEqual([]); return errors.join('\n') }
  expect(err(() => h(Surface, { width: 10, height: 10, fill: true }))).toMatch(/\[Surface\.fill\] 只用于屏幕层.*layer="screen".*<ScreenLayer>/)
  expect(err(() => h(WorldLayer, () => [h(Surface, { width: 10, height: 10, left: 4 })]))).toMatch(/\[Surface\.left\] 只用于屏幕层/)
  expect(err(() => h(ScreenLayer, () => [h(Surface, { width: 10, height: 10, position: [0, 0, 0] })]))).toMatch(/\[Surface\.position\] 只用于世界层.*fill、center 或 left \/ top/)
  expect(err(() => h(Surface, { layer: 'screen', width: 10, height: 10, ptPerUnit: 100 }))).toMatch(/\[Surface\.ptPerUnit\] 只用于世界层.*1 pt = 1 CSS px/)
  expect(err(() => h(Surface, { layer: 'screen', width: 10, height: 10, billboard: true }))).toMatch(/\[Surface\.billboard\] 只用于世界层/)
  expect(err(() => h(Surface, { width: 10, height: 10, background: 'glas' }))).toMatch(/\[Surface\.background\] 未知背景 "glas".*你可能想要：glass/)
  expect(err(() => h(Surface, { width: 10, height: 10, background: '#12' }))).toMatch(/\[Surface\.background\] 非法颜色 "#12"/)
  expect(err(() => h(Surface, { width: '400', height: 10 }))).toMatch(/\[Surface\.width\]/)
  expect(err(() => h(Surface, { width: 10, height: 10, rotation: [0, 1] }))).toMatch(/\[Surface\.rotation\]/)
  expect(err(() => h(Surface, { width: 10, height: 10, shadow: true }))).toMatch(/\[Surface\] 未知属性 "shadow"/)
})
it('Surface and the layer components render no node of their own: tw, class, style, id or a listener is an error, not dropped', () => {
  const err = (render: () => unknown): string => mountGlass(render as never).errors.join('\n')
  expect(err(() => h(Surface, { width: 10, height: 10, tw: 'p-4' }))).toMatch(/\[Surface\.tw\] Surface 不接受 tw（它自己不渲染节点，tw 无处可放）：写在内容里的元素上，如 <Box>/)
  expect(err(() => h(Surface, { width: 10, height: 10, style: { padding: 4 } }))).toMatch(/\[Surface\.style\]/)
  expect(err(() => h(Surface, { width: 10, height: 10, onClick: () => {} }))).toMatch(/\[Surface\.onClick\]/)
  expect(err(() => h(ScreenLayer, { class: 'p-4' }, () => []))).toMatch(/\[ScreenLayer\.class\] ScreenLayer 不接受 class/)
  expect(err(() => h(WorldLayer, { id: 'w' }, () => []))).toMatch(/\[WorldLayer\.id\]/)
  expect(err(() => h(Surface, { width: 10, height: 10, onError: () => {} }))).toBe('')   // its own event is no attribute
})
it('props that turn invalid keep the Surface; fixed, they apply again without recreating it', async () => {
  const root = createFakeRoot(), w = ref<unknown>(100)
  const { errors } = mountGlass(() => h(Surface, { width: w.value, height: 10 }), { root })
  const s = root.surfacesMade[0]!
  w.value = -1; await nextTick()
  expect(errors.join('\n')).toMatch(/\[Surface\.width\]/); expect(s.model.width).toBe(100); expect(s.disposed).toBe(false)
  w.value = 120; await nextTick()
  expect(root.surfacesMade).toHaveLength(1); expect(s.model.width).toBe(120)
})
it('invalid props at first create nothing; once fixed the Surface is made', async () => {
  const root = createFakeRoot(), w = ref<unknown>('wide')
  const { errors } = mountGlass(() => h(Surface, { width: w.value, height: 10 }, () => [h(Text, { id: 'in', value: 'in' })]), { root })
  expect(errors.join('\n')).toMatch(/\[Surface\.width\]/); expect(root.surfacesMade).toHaveLength(0)
  w.value = 50; await nextTick()
  expect(root.surfacesMade).toHaveLength(1); expect(byId(root.surfacesMade[0]!.root, 'in')).not.toBeNull()
})
it('a Surface held in a deep ref by its user still hands out raw nodes (markRaw)', () => {
  const root = createFakeRoot(), held = ref<unknown>(null)
  const Probe = defineComponent(() => { held.value = useSurface(); return () => null })
  mountGlass(() => h(Surface, { width: 10, height: 10 }, () => [h(Probe)]), { root })
  expect(held.value).toBe(root.surfacesMade[0])       // not a reactive proxy of it
  expect(shallowRef(held.value).value).toBe(root.surfacesMade[0])
})
it('Surface, ScreenLayer and WorldLayer are registered with complete manifest metadata', () => {
  for (const name of ['Surface', 'ScreenLayer', 'WorldLayer']) {
    const c = glassComponents().find(g => g.glass.name === name)!
    expect(c, name).toBeDefined()
    expect(c.glass.description.length).toBeGreaterThan(20); expect(c.glass.examples.length).toBeGreaterThanOrEqual(2)
    for (const [k, s] of Object.entries(c.glass.props.shape)) expect((s as { description?: string }).description, `${name}.${k}`).toBeTruthy()
  }
  const surface = glassComponents().find(g => g.glass.name === 'Surface')!.glass
  expect(surface.events).toEqual({ error: { payload: 'Error', description: expect.any(String) } })
  expect(surface.description).toMatch(/shadow/)          // not in phase 1, and it says so
})
