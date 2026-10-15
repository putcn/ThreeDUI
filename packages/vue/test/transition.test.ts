import { it, expect } from 'vitest'
import { defineComponent, h, nextTick, ref, type Ref } from '@vue/runtime-core'
import { Node, type Style } from '@glassui/core'
import { createGlassApp } from '../src/app'
import { GlassTransition } from '../src/transition'
import { createFakeRoot, flush, type FakeSurface } from './fixtures/fake-root'
import { byId } from './fixtures/tree'

it('enter animates from the preset to the node style, then calls done once', async () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 200, height: 200 })
  const show = ref(false), after: string[] = []
  const App = defineComponent(() => () => h(GlassTransition, { onAfterEnter: () => after.push('entered') }, () => show.value ? [h('glass', { id: 'g', style: { width: 80, height: 40 } })] : []))
  createGlassApp(App, { root }).mount(s as never)
  show.value = true; await nextTick()
  const g = byId(s.root, 'g')!                        // fixture helper (tree.ts): depth-first find by id
  expect(g.style.opacity).toBe(0)
  root.tick(); await flush()                           // records the from-values; the layer comes off
  expect(g.style.opacity).toBeUndefined()
  for (let i = 0; i < 120 && !after.length; i++) { root.tick(); await flush() }
  expect(after).toEqual(['entered'])
})
it('leave cancels a running enter: done runs once, the node goes away (Review Focus 4)', async () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 200, height: 200 })
  const show = ref(false), events: string[] = []
  const App = defineComponent(() => () => h(GlassTransition, { onAfterEnter: () => events.push('entered'), onAfterLeave: () => events.push('left') },
    () => show.value ? [h('glass', { id: 'g', style: { width: 80, height: 40 } })] : []))
  createGlassApp(App, { root }).mount(s as never)
  show.value = true; await nextTick()
  root.tick(); await flush(); root.tick(); await flush()   // the enter is running
  show.value = false; await nextTick()
  for (let i = 0; i < 200 && byId(s.root, 'g'); i++) { root.tick(); await flush() }
  expect(byId(s.root, 'g')).toBeNull()
  for (let i = 0; i < 10; i++) { root.tick(); await flush() }
  expect(events).toEqual(['left'])                     // the cancelled enter never reported
})
it('frozen motion completes synchronously', async () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 200, height: 200 })
  const show = ref(false), events: string[] = []
  const App = defineComponent(() => () => h(GlassTransition, { onAfterEnter: () => events.push('entered') },
    () => show.value ? [h('glass', { id: 'g', style: { width: 80, height: 40, opacity: 1 } })] : []))
  createGlassApp(App, { root, motion: 'frozen' }).mount(s as never)
  show.value = true; await nextTick()
  expect(byId(s.root, 'g')!.style.opacity).toBe(1); expect(events).toEqual(['entered'])
})

/** A GlassTransition around a `v-if` glass (`id: 'g'`) mounted on `target`; `events` records the after-hooks. */
function setup(target: 'surface' | 'detached', opts: { preset?: string; style?: Style; appear?: boolean; show?: boolean } = {}) {
  const root = createFakeRoot(), s = root.createSurface({ width: 200, height: 200 }) as unknown as FakeSurface
  const show: Ref<boolean> = ref(opts.show ?? false), events: string[] = [], el = ref<Node | null>(null)
  const props = { ...(opts.preset ? { preset: opts.preset } : {}), appear: opts.appear ?? false, onAfterEnter: () => events.push('entered'), onAfterLeave: () => events.push('left') }
  const App = defineComponent(() => () => h(GlassTransition, props as never,   // `preset` may be a wrong one on purpose
    () => show.value ? [h('glass', { id: 'g', ref: el, style: { width: 80, height: 40, ...opts.style } })] : []))
  const errors: string[] = []
  const app = createGlassApp(App, { root }); app.config.errorHandler = e => { errors.push(String(e)) }
  app.mount(target === 'surface' ? s as never : undefined)
  return { root, s, show, events, el, errors }
}
const until = async (root: ReturnType<typeof createFakeRoot>, done: () => boolean, max = 200) => { for (let i = 0; i < max && !done(); i++) { root.tick(); await flush() } }

it('appear runs the enter on the first mount', async () => {
  const { root, s, events } = setup('surface', { appear: true, show: true })
  expect(byId(s.root, 'g')!.style).toMatchObject({ opacity: 0, scale: 0.9, glass: { ior: 1, dispersion: 0, roughness: 0.35 } })
  await until(root, () => events.length > 0)
  expect(events).toEqual(['entered']); expect(byId(s.root, 'g')!.style).toEqual({ width: 80, height: 40 })
})
it('the presets: fade animates opacity only, scale opacity and scale; the user\'s own transition entries win', async () => {
  const fade = setup('surface', { preset: 'fade' })
  fade.show.value = true; await nextTick()
  expect(byId(fade.s.root, 'g')!.style).toEqual({ width: 80, height: 40, opacity: 0, transition: { opacity: 'smooth', scale: 'smooth', glass: 'smooth' } })
  const scale = setup('surface', { preset: 'scale', style: { transition: { opacity: 'snappy', width: 'bouncy' } } })
  scale.show.value = true; await nextTick()
  expect(byId(scale.s.root, 'g')!.style).toEqual({ width: 80, height: 40, opacity: 0, scale: 0.9, transition: { opacity: 'snappy', scale: 'smooth', glass: 'smooth', width: 'bouncy' } })
  await until(scale.root, () => scale.events.length > 0)
  expect(scale.events).toEqual(['entered']); expect(byId(scale.s.root, 'g')!.style.transition).toEqual({ opacity: 'snappy', width: 'bouncy' })
})
it('an unknown preset is a readable error', async () => {
  const { show, errors } = setup('surface', { preset: 'slide' })
  show.value = true; await nextTick()
  expect(errors[0]).toMatch(/\[GlassTransition\.preset\] 非法取值 "slide"。允许值：glass, fade, scale/)
})
it('enter in a detached container (no Surface ticks it) completes synchronously, without a layer', async () => {
  const { show, events, el } = setup('detached')
  show.value = true; await nextTick()
  expect(events).toEqual(['entered']); expect(el.value!.style).toEqual({ width: 80, height: 40 })
  show.value = false; await nextTick()
  expect(events).toEqual(['entered', 'left']); expect(el.value).toBeNull()
})
for (const how of ['fails', 'is disposed'] as const) {
  it(`a Surface that ${how} mid-enter: the enter completes and a later leave removes the node at once`, async () => {
    const { root, s, show, events } = setup('surface')
    show.value = true; await nextTick()
    root.tick(); await flush(); root.tick(); await flush()   // the enter is running
    const g = byId(s.root, 'g')!
    if (how === 'fails') s.markFailed(new Error('lost device')); else root.removeSurface(s as never)
    await flush()
    expect(events).toEqual(['entered']); expect(g.style).toEqual({ width: 80, height: 40 })
    show.value = false; await nextTick()                   // no tick: none will come for this Surface
    expect(byId(s.root, 'g')).toBeNull(); expect(events).toEqual(['entered', 'left'])
  })
  it(`a Surface that ${how} mid-leave: the leave completes, the node goes away`, async () => {
    const { root, s, show, events } = setup('surface', { show: true })
    show.value = false; await nextTick()
    root.tick(); await flush(); root.tick(); await flush()   // the leave is running
    const g = byId(s.root, 'g')!
    expect(g.style.opacity).toBe(0)
    if (how === 'fails') s.markFailed(new Error('lost device')); else root.removeSurface(s as never)
    await flush()
    expect(byId(s.root, 'g')).toBeNull(); expect(events).toEqual(['left']); expect(g.style).toEqual({ width: 80, height: 40 })
  })
}
it('a Surface that fails before the first tick of a leave: the next root tick completes it', async () => {
  const { root, s, show, events } = setup('surface', { show: true })
  show.value = false; await nextTick()                     // waiting for the tick that records the from-values
  s.markFailed(new Error('lost device'))
  root.tick(); await flush()
  expect(byId(s.root, 'g')).toBeNull(); expect(events).toEqual(['left'])
})
it('a leave re-entered before it finishes: the re-entered node enters, the leaving one goes away once', async () => {
  const { root, s, show, events } = setup('surface', { show: true })
  show.value = false; await nextTick()
  root.tick(); await flush()
  show.value = true; await nextTick()                      // v-if: a new node enters, the leaving one is removed
  await until(root, () => events.includes('entered'))
  for (let i = 0; i < 10; i++) { root.tick(); await flush() }
  const gs: Node[] = []; s.root.walk(n => { if (n.id === 'g') gs.push(n) })
  expect(gs).toHaveLength(1); expect(events).toEqual(['left', 'entered'])
})
it('a leave from a settled node animates (the runtime first records where it is), it does not jump', async () => {
  const { root, s, show } = setup('surface', { show: true })
  root.tick(); root.tick()                                 // shown and settled, no transition of its own: untracked
  const g = byId(s.root, 'g')!
  show.value = false; await nextTick()
  const seen: number[] = []
  for (let i = 0; i < 200 && byId(s.root, 'g'); i++) { root.tick(); await flush(); seen.push(g.visual?.opacity ?? g.style.opacity ?? 1) }
  expect(byId(s.root, 'g')).toBeNull()
  expect(seen.some(o => o > 0.05 && o < 0.95)).toBe(true)   // in between: it faded
})
it('open and close within one frame: the node is never drawn in its own style (Review Focus 4)', async () => {
  const { root, s, show, events } = setup('surface')
  show.value = true; await nextTick()
  const g = byId(s.root, 'g')!
  show.value = false; await nextTick()                     // no tick saw it yet
  const seen: number[] = []
  for (let i = 0; i < 200 && byId(s.root, 'g'); i++) { seen.push(g.visual?.opacity ?? g.style.opacity ?? 1); root.tick(); await flush() }
  expect(byId(s.root, 'g')).toBeNull(); expect(events).toEqual(['left'])
  expect(seen.every(o => o === 0)).toBe(true)
})

it('the user\'s own enter/leave hooks run with ours: before*, enter and leave (with the node), the cancelled ones', async () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 200, height: 200 })
  const show = ref(false), calls: string[] = []
  const log = (name: string) => (el: Node, done?: unknown) => { calls.push(`${name}:${el.id}${done === undefined ? '' : ':done'}`) }
  const App = defineComponent(() => () => h(GlassTransition, {
    onBeforeEnter: log('beforeEnter'), onEnter: log('enter'), onAfterEnter: log('afterEnter'), onEnterCancelled: log('enterCancelled'),
    onBeforeLeave: log('beforeLeave'), onLeave: log('leave'), onAfterLeave: log('afterLeave'),
  } as never, () => show.value ? [h('glass', { id: 'g', style: { width: 80, height: 40 } })] : []))
  createGlassApp(App, { root }).mount(s as never)
  show.value = true; await nextTick()
  root.tick(); await flush()                                // the enter is running
  show.value = false; await nextTick()                      // the leave cancels it
  await until(root, () => !byId(s.root, 'g'))
  expect(calls).toEqual(['beforeEnter:g', 'enter:g', 'enterCancelled:g', 'beforeLeave:g', 'leave:g', 'afterLeave:g'])
})
it('mode out-in: the old node leaves first, then the new one enters; done once each', async () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 200, height: 200 })
  const which = ref<'a' | 'b'>('a'), events: string[] = []
  const App = defineComponent(() => () => h(GlassTransition, { mode: 'out-in', onAfterEnter: (el: Node) => events.push(`entered:${el.id}`), onAfterLeave: (el: Node) => events.push(`left:${el.id}`) } as never,
    () => [h('glass', { key: which.value, id: which.value, style: { width: 80, height: 40 } })]))
  createGlassApp(App, { root }).mount(s as never)
  const ids = () => { const out: string[] = []; s.root.walk(n => { if (n.id === 'a' || n.id === 'b') out.push(n.id) }); return out }
  which.value = 'b'; await nextTick()
  expect(ids()).toEqual(['a'])                              // b waits for a's leave
  root.tick(); await flush(); root.tick(); await flush()
  expect(ids()).toEqual(['a'])
  await until(root, () => events.includes('entered:b'))
  for (let i = 0; i < 10; i++) { root.tick(); await flush() }
  expect(events).toEqual(['left:a', 'entered:b']); expect(ids()).toEqual(['b'])
})
it('frozen: the user\'s hooks keep Vue\'s order (enter before after-enter); on appear their onAppear replaces onEnter', async () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 200, height: 200 })
  const show = ref(true), calls: string[] = []
  const log = (name: string) => (el: Node) => { calls.push(`${name}:${el.id}`) }
  const App = defineComponent(() => () => h(GlassTransition, {
    appear: true, onBeforeEnter: log('beforeEnter'), onEnter: log('enter'), onAppear: log('appear'), onAfterEnter: log('afterEnter'),
    onBeforeLeave: log('beforeLeave'), onLeave: log('leave'), onAfterLeave: log('afterLeave'),
  } as never, () => show.value ? [h('glass', { id: 'g', style: { width: 80, height: 40 } })] : []))
  createGlassApp(App, { root, motion: 'frozen' }).mount(s as never)
  expect(calls).toEqual(['beforeEnter:g', 'appear:g', 'afterEnter:g'])
  show.value = false; await nextTick()
  show.value = true; await nextTick()
  expect(calls.slice(3)).toEqual(['beforeLeave:g', 'leave:g', 'afterLeave:g', 'beforeEnter:g', 'enter:g', 'afterEnter:g'])
})
it('live appear with the user\'s onAppear: ours still animates, theirs runs too', async () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 200, height: 200 })
  const calls: string[] = []
  const App = defineComponent(() => () => h(GlassTransition, { appear: true, onAppear: (el: Node) => { calls.push(`appear:${el.id}`) }, onAfterAppear: (el: Node) => { calls.push(`afterAppear:${el.id}`) } } as never,
    () => [h('glass', { id: 'g', style: { width: 80, height: 40 } })]))
  createGlassApp(App, { root }).mount(s as never)
  expect(calls).toEqual(['appear:g']); expect(byId(s.root, 'g')!.style.opacity).toBe(0)
  await until(root, () => calls.length > 1)
  expect(calls).toEqual(['appear:g', 'afterAppear:g']); expect(byId(s.root, 'g')!.style.opacity).toBeUndefined()
})
