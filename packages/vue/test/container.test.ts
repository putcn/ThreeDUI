import { it, expect, vi, afterEach } from 'vitest'
import { defineComponent, h, nextTick, ref, type VNodeChild } from '@vue/runtime-core'
import { absoluteRect, defaultTheme, Node, Spring } from '@glassui/core'
import { createGlassApp } from '../src/app'
import { glassComponents } from '../src/define'
import { GlassTransition } from '../src/transition'
import { controlStyle } from '../src/control'
import { Box } from '../src/components/Box'
import { Button } from '../src/components/Button'
import { GlassContainer } from '../src/components/GlassContainer'
import { Stack } from '../src/components/Stack'
import { Surface } from '../src/components/Surface'
import { createFakeRoot, flush, type FakeRoot } from './fixtures/fake-root'
import { all, first, mountGlass } from './fixtures/mount'

afterEach(() => { vi.restoreAllMocks() })

/** The runtime's per-node state (private): a morph must leave none behind for a node no tick will see again. */
const tracked = (root: FakeRoot, n: Node): boolean => (root.anim as unknown as { state: Map<Node, unknown> }).state.has(n)
/** The springs the morph layer adds over a Button's own (`controlStyle`) transition. */
const MORPH = { x: 'smooth', y: 'smooth', width: 'smooth', height: 'smooth' }

/**
 * A 400 × 200 Surface of a fresh fake root with `App` mounted into it (live motion unless `motion`), laid out once. The
 * Buttons have labels only (no icons), so the default DOM canvas factory is never called.
 */
function mountSwap(render: () => VNodeChild, opts: { motion?: 'live' | 'frozen'; root?: FakeRoot } = {}) {
  const root = opts.root ?? createFakeRoot(), s = root.createSurface({ width: 400, height: 200 })
  const app = createGlassApp(defineComponent(() => render), { root, ...(opts.motion ? { motion: opts.motion } : {}) })
  app.mount(s as never); root.tick()
  return { root, s, app }
}

it('GlassContainer marks its box and lays children out with the gap', () => {
  const { c } = mountGlass(() => h(GlassContainer, { spacing: 20, gap: 6 }, () => [h(Button, { leadingIcon: 'plus', shape: 'circle' }), h(Button, { leadingIcon: 'minus', shape: 'circle' })]))
  const box = first(c, 'box')
  expect(box.props.glassContainer).toEqual({ spacing: 20 }); expect(box.style).toMatchObject({ flexDirection: 'row', gap: 6 })
})
it('GlassContainer defaults: spacing 16, a row, gap 8, centred; vertical is a column; a bad spacing names the prop', () => {
  const { c } = mountGlass(() => h(GlassContainer, () => [h(Button, { leadingIcon: 'plus', shape: 'circle' })]))
  const box = first(c, 'box')
  expect(box.props.glassContainer).toEqual({ spacing: 16 })
  expect(box.style).toEqual({ flexDirection: 'row', gap: 8, alignItems: 'center' })
  expect(all(box, 'glass')).toHaveLength(1)
  expect(first(mountGlass(() => h(GlassContainer, { direction: 'vertical' })).c, 'box').style).toMatchObject({ flexDirection: 'column' })
  expect(mountGlass(() => h(GlassContainer, { spacing: -4 })).errors[0]).toMatch(/^GlassUIError: \[GlassContainer\.spacing\]/)
  expect(mountGlass(() => h(GlassContainer, { direction: 'row' })).errors[0]).toMatch(/\[GlassContainer\.direction\].*你可能想要：horizontal/)
})
it('GlassContainer is registered with complete manifest metadata; it says a primary Button stands apart', () => {
  const m = glassComponents().find(g => g.glass.name === 'GlassContainer')!.glass
  expect(m.description.length).toBeGreaterThan(40); expect(m.description).toMatch(/glassProminent/)
  expect(m.examples.length).toBeGreaterThanOrEqual(2); expect(m.examples.length).toBeLessThanOrEqual(3)
  for (const e of m.examples) expect(e).toMatch(/<GlassContainer\b/)
  expect(Object.keys(m.props.shape)).toEqual(['spacing', 'direction', 'gap'])
  for (const [k, s] of Object.entries(m.props.shape)) expect((s as { description?: string }).description, `GlassContainer.${k}`).toMatch(/[一-鿿]/)
  expect(Object.keys(m.slots!)).toEqual(['default'])
  expect(m.mistakes!.some(x => /glassProminent/.test(x.mistake) && /单独.*玻璃/.test(x.fix))).toBe(true)
  const b = glassComponents().find(g => g.glass.name === 'Button')!.glass
  expect((b.props.shape.glassId as { description?: string }).description).toMatch(/500 ms.*形变/)
})

it('a glassId swap seeds the new node with the old rect and animates it to its own', async () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 400, height: 200 }), where = ref<'left' | 'right'>('left')
  const App = defineComponent(() => () => h(Stack, { direction: 'horizontal', style: { width: 400, justifyContent: 'space-between' } }, () => [
    where.value === 'left' ? h(Button, { key: 'l', glassId: 'go', label: 'Go' }) : h(Box, { key: 'lx' }),
    where.value === 'right' ? h(Button, { key: 'r', glassId: 'go', label: 'Go' }) : h(Box, { key: 'rx' }),
  ]))
  createGlassApp(App, { root }).mount(s as never); root.tick()
  const before = absoluteRect(first(s.root, 'glass'))
  where.value = 'right'; await nextTick(); root.tick()
  const moved = first(s.root, 'glass')
  // starts where the old one was: one frame (1/60 s) of the smooth spring from there (the brief's `toBeCloseTo(start, 0)`
  // cannot hold: the first tick both starts the channel and advances it, ≈ 9 pt of a 335 pt trip)
  const start = before.x - absoluteRect(moved.parent!).x
  const frame = new Spring(start, defaultTheme.springs.smooth); frame.set(moved.layout.x); frame.step(1 / 60)
  expect(moved.visual?.x).toBeCloseTo(frame.value, 3)
  expect(Math.abs(moved.visual!.x! - start)).toBeLessThan(Math.abs(moved.layout.x - start) * 0.05)
  expect(moved.style.transition).toEqual({ ...controlStyle().transition, ...MORPH })   // the morph layer's springs
  for (let i = 0; i < 120; i++) root.tick()
  expect(moved.visual).toBeNull()                                                     // settled at its own place
  await flush()
  expect(moved.style.transition).toEqual(controlStyle().transition)                   // the layer is off again
})
it('the morph seeds the width and height too, and keeps the springs the node has its own of', async () => {
  const where = ref<'a' | 'b'>('a')
  const { root, s } = mountSwap(() => h(Stack, { direction: 'horizontal', gap: 40 }, () => [
    where.value === 'a' ? h(Button, { key: 'a', glassId: 'go', label: 'Go', size: 'small' }) : h(Box, { key: 'ax' }),
    where.value === 'b' ? h(Button, { key: 'b', glassId: 'go', label: 'A longer label', size: 'large', style: { transition: { x: 'snappy' } } }) : h(Box, { key: 'bx' }),
  ]))
  const old = absoluteRect(first(s.root, 'glass'))
  const seed = vi.spyOn(root.anim, 'seed')
  where.value = 'b'; await nextTick()
  const moved = first(s.root, 'glass')
  expect(seed).toHaveBeenCalledTimes(1)
  expect(seed.mock.calls[0]![1]).toEqual({ x: old.x - absoluteRect(moved.parent!).x, y: old.y - absoluteRect(moved.parent!).y, width: old.width, height: old.height })
  expect(moved.style.transition).toMatchObject({ x: 'snappy', y: 'smooth', width: 'smooth', height: 'smooth' })   // its own x spring stays
  root.tick()
  expect(moved.visual?.width).toBeLessThan(moved.layout.width); expect(moved.visual?.height).toBeLessThan(moved.layout.height)   // grows from the small one
})
it('a glassId node in a removed subtree is matched by one in an inserted subtree, whichever the renderer meets first', async () => {
  // the new place comes first in the tree: its insert runs before the old place's remove, in the same flush
  const where = ref<'top' | 'bottom'>('bottom')
  const { root, s } = mountSwap(() => h(Stack, { gap: 20 }, () => [
    h(Box, { key: 'top' }, () => where.value === 'top' ? [h(Box, { key: 'wrap' }, () => [h(Button, { glassId: 'go', label: 'Go' })])] : []),
    h(Box, { key: 'bottom' }, () => where.value === 'bottom' ? [h(Box, { key: 'wrap' }, () => [h(Button, { glassId: 'go', label: 'Go' })])] : []),
  ]))
  const old = absoluteRect(first(s.root, 'glass'))
  where.value = 'top'; await nextTick(); root.tick(0)   // dt 0: the channels start but do not move
  const moved = first(s.root, 'glass'), origin = absoluteRect(moved.parent!)
  expect(moved.visual).toMatchObject({ y: old.y - origin.y })
  expect(old.y).toBeGreaterThan(absoluteRect(moved).y)
})
it('a glassId comes back within 500 ms only: a later one does not morph', async () => {
  let now = 1000
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const left = ref(true), right = ref(false)
  const { root, s } = mountSwap(() => h(Stack, { direction: 'horizontal', style: { width: 400, justifyContent: 'space-between' } }, () => [
    left.value ? h(Button, { key: 'l', glassId: 'go', label: 'Go' }) : h(Box, { key: 'lx' }),
    right.value ? h(Button, { key: 'r', glassId: 'go', label: 'Go' }) : h(Box, { key: 'rx' }),
  ]))
  const seed = vi.spyOn(root.anim, 'seed')
  left.value = false; await nextTick(); root.tick()
  now += 501
  right.value = true; await nextTick(); root.tick()
  expect(seed).not.toHaveBeenCalled()
  expect(first(s.root, 'glass').style.transition).toEqual(controlStyle().transition)
  right.value = false; await nextTick(); root.tick()
  now += 499
  left.value = true; await nextTick()
  expect(seed).toHaveBeenCalledTimes(1)
})
it('glassId matching stays in one Surface tree and one app', async () => {
  // the same app, the same glassId leaving the page Surface and coming up on a <Surface> of its own
  const here = ref(true)
  const { root } = mountSwap(() => h(Box, () => [
    here.value ? h(Button, { key: 'a', glassId: 'go', label: 'Go' }) : null,
    h(Surface, { layer: 'screen', width: 300, height: 100 }, () => [here.value ? null : h(Button, { key: 'b', glassId: 'go', label: 'Go' })]),
  ]))
  root.tick()
  const seed = vi.spyOn(root.anim, 'seed')
  here.value = false; await nextTick(); await nextTick()
  expect(all(root.surfaces[1]!.root, 'glass')).toHaveLength(1)
  expect(seed).not.toHaveBeenCalled()
  // another app on the same Surface: each app's renderer keeps its own glassIds
  const mine = ref(true), theirs = ref(false)
  const one = mountSwap(() => mine.value ? h(Button, { glassId: 'go', label: 'Go' }) : null)
  const slot = new Node('box'); one.s.root.appendChild(slot)
  createGlassApp(defineComponent(() => () => theirs.value ? h(Button, { glassId: 'go', label: 'Go' }) : null), { root: one.root }).mount(slot)
  one.root.tick()
  const seed1 = vi.spyOn(one.root.anim, 'seed')
  mine.value = false; theirs.value = true; await nextTick()
  expect(all(slot, 'glass')).toHaveLength(1); expect(seed1).not.toHaveBeenCalled()
})
it('no morph where nothing ticks the node or motion is frozen: no seed, no layer, nothing kept (seed guard)', async () => {
  const where = ref<'left' | 'right'>('left')
  const swap = () => h(Stack, { direction: 'horizontal' }, () => [
    where.value === 'left' ? h(Button, { key: 'l', glassId: 'go', label: 'Go' }) : h(Box, { key: 'lx' }),
    where.value === 'right' ? h(Button, { key: 'r', glassId: 'go', label: 'Go' }) : h(Box, { key: 'rx' }),
  ])
  // a detached container: no Surface ever ticks it, so a seed there would wait (and hold its state) forever
  const detached = mountGlass(swap), seed = vi.spyOn(detached.root.anim, 'seed')
  where.value = 'right'; await nextTick()
  const moved = first(detached.c, 'glass')
  expect(seed).not.toHaveBeenCalled(); expect(tracked(detached.root, moved)).toBe(false)
  expect(moved.style.transition).toEqual(controlStyle().transition)
  // frozen motion: transitions complete at once
  where.value = 'left'
  const frozen = mountSwap(swap, { motion: 'frozen' }), seedF = vi.spyOn(frozen.root.anim, 'seed')
  where.value = 'right'; await nextTick()
  expect(seedF).not.toHaveBeenCalled(); expect(first(frozen.s.root, 'glass').style.transition).toEqual(controlStyle().transition)
  // reduced motion: the same
  where.value = 'left'
  const reduced = mountSwap(swap), seedR = vi.spyOn(reduced.root.anim, 'seed')
  reduced.root.anim.reducedMotion = true
  where.value = 'right'; await nextTick()
  expect(seedR).not.toHaveBeenCalled()
})
it('a morphing node discarded before any tick leaves no state, waiter or layer behind; its successor starts from the first place (seed guard)', async () => {
  const where = ref<'left' | 'mid' | 'right'>('left')
  const { root, s } = mountSwap(() => h(Stack, { direction: 'horizontal', style: { width: 400, justifyContent: 'space-between' } }, () => [
    where.value === 'left' ? h(Button, { key: 'l', glassId: 'go', label: 'Go' }) : h(Box, { key: 'lx' }),
    where.value === 'mid' ? h(Button, { key: 'm', glassId: 'go', label: 'Go' }) : h(Box, { key: 'mx' }),
    where.value === 'right' ? h(Button, { key: 'r', glassId: 'go', label: 'Go' }) : h(Box, { key: 'rx' }),
  ]))
  const first0 = absoluteRect(first(s.root, 'glass'))
  where.value = 'mid'; await nextTick()
  const mid = first(s.root, 'glass')
  expect(tracked(root, mid)).toBe(true); expect(mid.style.transition).toMatchObject(MORPH)
  let settled = false
  void root.anim.whenSettled(mid).then(() => { settled = true })
  where.value = 'right'; await nextTick()               // gone before any tick laid it out
  const right = first(s.root, 'glass'), seed = vi.spyOn(root.anim, 'seed')
  root.tick(0); await flush()
  expect(right).not.toBe(mid)
  expect(tracked(root, mid)).toBe(false); expect(settled).toBe(true)
  expect(mid.style.transition).toEqual(controlStyle().transition)
  // the right one grows from where the discarded one would have started: the first place, not (0, 0)
  expect(right.visual?.x).toBeCloseTo(first0.x - absoluteRect(right.parent!).x, 5)
  expect(seed).not.toHaveBeenCalled()                    // (seeded in the flush above, before the spy)
  for (let i = 0; i < 150; i++) root.tick()
  await flush()
  expect(root.anim.active).toBe(0); expect(right.style.transition).toEqual(controlStyle().transition)
})
it('a swap back mid-morph starts from where the morph got to', async () => {
  const where = ref<'left' | 'right'>('left')
  const { root, s } = mountSwap(() => h(Stack, { direction: 'horizontal', style: { width: 400, justifyContent: 'space-between' } }, () => [
    where.value === 'left' ? h(Button, { key: 'l', glassId: 'go', label: 'Go' }) : h(Box, { key: 'lx' }),
    where.value === 'right' ? h(Button, { key: 'r', glassId: 'go', label: 'Go' }) : h(Box, { key: 'rx' }),
  ]))
  where.value = 'right'; await nextTick()
  for (let i = 0; i < 10; i++) root.tick()
  const flying = first(s.root, 'glass'), at = absoluteRect(flying.parent!).x + flying.visual!.x!
  expect(at).toBeGreaterThan(20); expect(at).toBeLessThan(flying.layout.x - 20)        // in flight
  where.value = 'left'; await nextTick(); root.tick(0)
  const back = first(s.root, 'glass')
  expect(back).not.toBe(flying); expect(back.visual?.x).toBeCloseTo(at - absoluteRect(back.parent!).x, 5)
})
it('a GlassTransition around the new node keeps working: its layer and the morph\'s compose, both come off', async () => {
  const where = ref<'left' | 'right'>('left'), events: string[] = []
  const { root, s } = mountSwap(() => h(Stack, { direction: 'horizontal', style: { width: 400, justifyContent: 'space-between' } }, () => [
    where.value === 'left' ? h(Button, { key: 'l', glassId: 'go', label: 'Go' }) : h(Box, { key: 'lx' }),
    where.value === 'right' ? h(GlassTransition, { key: 'r', appear: true, onAfterAppear: () => events.push('appeared') }, () => [h(Button, { glassId: 'go', label: 'Go' })]) : h(Box, { key: 'rx' }),
  ]))
  where.value = 'right'; await nextTick()
  const moved = first(s.root, 'glass')
  expect(moved.style).toMatchObject({ opacity: 0, scale: 0.9, transition: MORPH })      // the preset and the morph's springs
  root.tick(); await flush()
  expect(moved.visual?.x).toBeDefined()
  for (let i = 0; i < 150 && !events.length; i++) { root.tick(); await flush() }
  expect(events).toEqual(['appeared'])
  for (let i = 0; i < 5; i++) { root.tick(); await flush() }
  expect(moved.visual).toBeNull()
  expect(moved.style.opacity).toBeUndefined(); expect(moved.style.transition).toEqual(controlStyle().transition)
})
