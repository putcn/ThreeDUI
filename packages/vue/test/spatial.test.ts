import { it, expect, vi } from 'vitest'
import { h, nextTick, ref } from '@vue/runtime-core'
import { absoluteRect, buildRenderList, defaultTheme } from '@glassui/core'
import { glassComponents } from '../src/define'
import { arcSlots, type ArcSlot } from '../src/spatial/arc'
import { Space } from '../src/components/Space'
import { Block } from '../src/components/Block'
import { Card } from '../src/components/Card'
import { Box } from '../src/components/Box'
import { Stack } from '../src/components/Stack'
import { Text } from '../src/components/Text'
import { Surface } from '../src/components/Surface'
import { createFakeRoot, flush, type FakeSurface } from './fixtures/fake-root'
import { first, mountGlass } from './fixtures/mount'
import { byId, tree } from './fixtures/tree'

const blocks = (names: string[], extra: Record<string, unknown> = {}) => names.map(n => h(Block, { key: n, name: n, width: 488, height: 244, ...extra }, () => [h(Text, { value: n })]))
const snap = (s: FakeSurface) => JSON.stringify(tree(s.root))
/** Where an unfocused Block on `slot` rests (9I): RECEDE's (0, 0, −0.4) turned into the slot's frame (about y). */
const receded = (slot: ArcSlot): [number, number, number] => { const ry = slot.rotation[1]; return [slot.position[0] - 0.4 * Math.sin(ry), slot.position[1], slot.position[2] - 0.4 * Math.cos(ry)] }

it('arcSlots: first at the origin, then rightwards along the arc, facing its centre', () => {
  const [a, b] = arcSlots([2, 2], 7, 0.5), t = 2.5 / 7
  expect(a!.position).toEqual([0, 0, 0])
  expect(b!.position[0]).toBeCloseTo(7 * Math.sin(t)); expect(b!.position[2]).toBeCloseTo(7 - 7 * Math.cos(t)); expect(b!.rotation[1]).toBeCloseTo(-t)
})
it('Blocks are world glass Surfaces on the arc, entering from behind', () => {
  const root = createFakeRoot()
  mountGlass(() => h(Space, null, () => blocks(['a', 'b'])), { root })
  const [a, b] = root.surfacesMade
  expect(a!.created).toMatchObject({ layer: 'world', background: 'glass', cornerRadius: 48, width: 488, height: 244 })
  const slot = arcSlots([2, 2], 7, 0.5)[1]!
  expect(b!.position.x).toBeCloseTo(receded(slot)[0]); expect(b!.rotation.y).toBeCloseTo(slot.rotation[1])   // unfocused: receded (9I)
  expect(a!.animations[0]).toMatchObject({ from: { position: [0, 0, -1.2], scale: [0.92, 0.92, 0.92], opacity: 0 }, target: { position: [0, 0, 0], opacity: 1 }, opts: { immediate: false } })
})
it('a leaving Block keeps its content until its flight ends, then goes; slots stay by name', async () => {
  const root = createFakeRoot(), show = ref(true)
  mountGlass(() => h(Space, null, () => [show.value ? blocks(['a'])[0] : null, blocks(['b'])[0]]), { root })
  const [a, b] = root.surfacesMade, bx = b!.position.x
  show.value = false; await nextTick()
  expect(a!.disposed).toBe(false); expect(a!.interactive).toBe(false); expect(snap(a!)).toContain('"a"')
  expect(a!.animations.at(-1)!.target).toMatchObject({ position: [0, 0, -1.5], scale: [0.9, 0.9, 0.9], opacity: 0 })   // 9I: a scale per axis
  root.tick(); await flush(); expect(a!.disposed).toBe(true)
  show.value = true; await nextTick()
  const a2 = root.surfacesMade.at(-1)!; expect(a2.position.x).toBeCloseTo(0); expect(b!.position.x).toBe(bx)
})
it('toggling off and on within one flight leaves exactly one Surface for the Block', async () => {
  const root = createFakeRoot(), show = ref(true)
  mountGlass(() => h(Space, null, () => [show.value ? blocks(['a'])[0] : null]), { root })
  show.value = false; await nextTick(); show.value = true; await nextTick()
  root.tick(); await flush(); expect(root.surfaces.length).toBe(1)
})
it('focus drives the rig and the keys', async () => {
  const root = createFakeRoot(), focus = ref('a')
  mountGlass(() => h(Space, { focus: focus.value }, () => blocks(['a', 'b'])), { root })
  await flush()
  const [a, b] = root.surfacesMade, rig = root.rigs[0]!
  expect(rig.focus).toHaveBeenCalledWith(a, { immediate: true })
  focus.value = 'b'; await nextTick(); await flush()
  expect(rig.focus).toHaveBeenLastCalledWith(b, { immediate: false })
  expect(root.pointer!.setActive).toHaveBeenLastCalledWith(b); expect(b!.trapFocus).toBe(true); expect(a!.trapFocus).toBe(false)
})
it('frozen motion: everything immediate, no parallax; camera=false: no rig', async () => {
  const root = createFakeRoot()
  mountGlass(() => h(Space, null, () => blocks(['a'])), { root, motion: 'frozen' }); await flush()
  expect(root.surfacesMade[0]!.animations[0]!.opts).toMatchObject({ immediate: true }); expect(root.rigs[0]!.parallax).toBe(false)
  const r2 = createFakeRoot(); mountGlass(() => h(Space, { camera: false }, () => blocks(['a'])), { root: r2 }); await flush()
  expect(r2.rigs.length).toBe(0)
})
it('a press on an unfocused Block only asks for focus; its content gets no press and no hover', async () => {
  const root = createFakeRoot(), asked: string[] = [], pressed = vi.fn()
  mountGlass(() => h(Space, { focus: 'a', 'onUpdate:focus': (n: string) => asked.push(n) }, () => [
    blocks(['a'])[0],
    h(Block, { name: 'b', width: 488, height: 244 }, () => [h(Box, { id: 'btn', style: { width: 100, height: 40, bg: 'accent' }, onPointerdown: pressed })]),
  ]), { root })
  root.tick(); const b = root.surfacesMade[1]!
  b.pointer.move(60, 60); expect(byId(b.root, 'btn')!.state.hover).toBe(false)
  b.pointer.down(60, 60); expect(pressed).not.toHaveBeenCalled(); expect(asked).toEqual(['b'])
})
it('uncontrolled: the first Block is focused, and a press moves focus', async () => {
  const root = createFakeRoot()
  mountGlass(() => h(Space, null, () => blocks(['a', 'b'])), { root }); root.tick(); await flush()
  const [, b] = root.surfacesMade, rig = root.rigs[0]!
  b!.pointer.down(10, 10); await nextTick(); await flush()
  expect(rig.focus).toHaveBeenLastCalledWith(b, { immediate: false })
})
it('reports the mistakes an agent makes', async () => {
  expect(mountGlass(() => blocks(['a'])[0]).errors[0]).toMatch(/\[Block\] 必须放在 <Space> 里/)
  expect(mountGlass(() => h(Space, null, () => blocks(['a', 'a']))).errors.join()).toMatch(/重名的 Block "a"/)
  const m = mountGlass(() => h(Space, { focus: 'landng' }, () => blocks(['login', 'landing']))); await flush()
  expect(m.errors.join()).toMatch(/\[Space\.focus\].*"landng".*你可能想要：landing/)
  expect(mountGlass(() => h(Space, null, () => [h(Box)])).errors[0]).toMatch(/\[Space\] 插槽里只能放 <Block>/)
  expect(mountGlass(() => h(Space, null, () => blocks(['a'], { enterFrom: { opacity: 2 } }))).errors[0]).toMatch(/\[Block\.enterFrom/)
})
it('warns once when the content is taller than the Block', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}), root = createFakeRoot()
  mountGlass(() => h(Space, null, () => [h(Block, { name: 'a', width: 300, height: 100 }, () => [h(Box, { style: { height: 300 } })])]), { root })
  root.tick(); await flush(); root.tick(); await flush()
  expect(warn.mock.calls.filter(c => /\[Block "a"\] 内容高 .*超出 block 高 100pt/.test(String(c[0])))).toHaveLength(1)
  warn.mockRestore()
})
it('Card: a nested glass box, 24 pt corners, with a title; style overrides', () => {
  const { c } = mountGlass(() => h(Card, { title: '本周活跃', style: { padding: 16 } }, () => [h(Text, { value: '12' })]))
  const card = first(c, 'box')
  // fix round 1 (CP3 ruling): radius 'xl' (24 pt) instead of the brief's 'concentric'
  expect(card.style).toMatchObject({ bg: 'glass', radius: 'xl', gap: 12, padding: 16, glass: { thickness: 12 } })
  expect(tree(card).children![0]).toMatchObject({ type: 'text', value: '本周活跃' })
})
it('unmounting the Space mid-flight disposes the rig and, after the flights, every Surface', async () => {
  const root = createFakeRoot(), { app } = mountGlass(() => h(Space, null, () => blocks(['a', 'b'])), { root }); await flush()
  app.unmount(); expect(root.rigs[0]!.dispose).toHaveBeenCalled()
  root.tick(); await flush(); expect(root.surfaces.length).toBe(0)
})

// ── beyond the brief's tests ──

it('a controlled focus whose Block leaves is reported, and the rig stays put (ruling 1)', async () => {
  const root = createFakeRoot(), show = ref(true)
  const m = mountGlass(() => h(Space, { focus: 'a' }, () => [show.value ? blocks(['a'])[0] : null, blocks(['b'])[0]]), { root }); await flush()
  const rig = root.rigs[0]!, calls = rig.focus.mock.calls.length
  expect(m.errors).toEqual([])
  show.value = false; await nextTick(); await flush()
  expect(m.errors.join()).toMatch(/\[Space\.focus\] 没有名为 "a" 的 Block。允许值：b/)
  expect(rig.focus.mock.calls.length).toBe(calls)
})
it('once focused, a Block lets the press and the hover through to its content', async () => {
  const root = createFakeRoot(), pressed = vi.fn()
  mountGlass(() => h(Space, null, () => [
    blocks(['a'])[0],
    h(Block, { name: 'b', width: 488, height: 244 }, () => [h(Box, { id: 'btn', style: { width: 100, height: 40, bg: 'accent' }, onPointerdown: pressed })]),
  ]), { root })
  root.tick(); const b = root.surfacesMade[1]!
  b.pointer.down(60, 60); b.pointer.up(60, 60); expect(pressed).not.toHaveBeenCalled()      // the first press focuses b
  await nextTick(); root.tick()
  b.pointer.move(61, 61); expect(byId(b.root, 'btn')!.state.hover).toBe(true)
  b.pointer.down(61, 61); expect(pressed).toHaveBeenCalledOnce()
})
it('camera and parallax apply live: off disposes the rig; on makes one that snaps to the focus', async () => {
  const root = createFakeRoot(), camera = ref(true), parallax = ref(true)
  mountGlass(() => h(Space, { camera: camera.value, parallax: parallax.value }, () => blocks(['a'])), { root }); await flush()
  const [a] = root.surfacesMade
  expect(root.rigs[0]!.parallax).toBe(true)
  parallax.value = false; await nextTick(); expect(root.rigs[0]!.parallax).toBe(false)
  camera.value = false; await nextTick(); expect(root.rigs[0]!.disposed).toBe(true)
  camera.value = true; await nextTick()
  expect(root.rigs).toHaveLength(2); expect(root.rigs[1]!.focus).toHaveBeenCalledWith(a, { immediate: true }); expect(root.rigs[1]!.parallax).toBe(false)
})
it('a focus on a Block that joins in the same update counts as there (spatial spec §5)', async () => {
  const root = createFakeRoot(), page = ref('a')
  const m = mountGlass(() => h(Space, { focus: page.value }, () => [blocks(['a'])[0], page.value === 'b' ? blocks(['b'])[0] : null]), { root }); await flush()
  page.value = 'b'; await nextTick(); await flush()
  expect(m.errors).toEqual([])
  expect(root.rigs[0]!.focus).toHaveBeenLastCalledWith(root.surfacesMade[1], { immediate: false })
})
it('uncontrolled: a pressed Block that leaves hands the focus to the first Block still there', async () => {
  const root = createFakeRoot(), show = ref(true)
  const m = mountGlass(() => h(Space, null, () => [blocks(['a'])[0], show.value ? blocks(['b'])[0] : null, blocks(['c'])[0]]), { root })
  root.tick(); await flush()
  const [a, b] = root.surfacesMade, rig = root.rigs[0]!
  b!.pointer.down(10, 10); await nextTick(); await flush()
  expect(rig.focus).toHaveBeenLastCalledWith(b, { immediate: false })
  show.value = false; await nextTick(); await flush()
  expect(rig.focus).toHaveBeenLastCalledWith(a, { immediate: false }); expect(a!.trapFocus).toBe(true); expect(m.errors).toEqual([])
})
it('a Block with its own position stands off the arc; a rest-pose change springs it there', async () => {
  const root = createFakeRoot(), pos = ref<[number, number, number]>([0, 2, -1]), w = ref(488)
  mountGlass(() => h(Space, { focus: 'free' }, () => [                          // 9I: the others recede
    h(Block, { name: 'a', width: w.value, height: 244 }),
    h(Block, { name: 'free', width: 488, height: 244, position: pos.value, rotation: [0, 0.5, 0] }),
    h(Block, { name: 'c', width: 488, height: 244 }),
  ]), { root })
  const [a, free, c] = root.surfacesMade
  expect(c!.position.x).toBeCloseTo(receded(arcSlots([2, 2], 7, 0.5)[1]!)[0])     // `free` takes no slot
  expect([free!.position.x, free!.position.y, free!.position.z, free!.rotation.y]).toEqual([0, 2, -1, 0.5])
  expect(free!.animations[0]!.from.position[2]).toBeCloseTo(-1 - 1.2 * Math.cos(0.5))   // enterFrom in the Block's own frame
  pos.value = [1, 2, -1]; w.value = 976; await nextTick()
  expect(free!.animations.at(-1)!.target).toMatchObject({ position: [1, 2, -1] })
  expect(c!.animations.at(-1)!.target.position![0]).toBeCloseTo(receded(arcSlots([4, 2], 7, 0.5)[1]!)[0])   // a wider `a` moves `c` on
  expect(a!.model.width).toBe(976); expect(a!.animations).toHaveLength(1)    // a's own slot is unchanged: no flight
})
it('a Card has 24 pt corners in any layout; a concentric child still resolves against the Block', () => {
  const root = createFakeRoot()
  mountGlass(() => h(Space, null, () => [h(Block, { name: 'a', width: 880, height: 620, radius: 56 }, () => [
    h(Card, { id: 'direct' }),
    h(Stack, { direction: 'horizontal', gap: 16 }, () => [h(Card, { id: 'row1', style: { flexGrow: 1 } }), h(Card, { id: 'row2', style: { flexGrow: 1 } })]),
    h(Card, { id: 'concentric', style: { radius: 'concentric' } }),
    h(Card, { id: 'own', style: { radius: 10 } }),
  ])]), { root })
  root.tick()
  const radius = Object.fromEntries(buildRenderList(root.surfacesMade[0]!.model, defaultTheme, 'light').glass.map(g => [g.node.id, g.radius]))
  // the Block's content box carries its radius: a concentric child gets 56 − the 40 pt padding
  expect(radius).toEqual({ direct: 24, row1: 24, row2: 24, concentric: 16, own: 10 })
})
it('a renamed Block registers under its new name; a rename onto a taken name is reported and keeps the old one', async () => {
  const root = createFakeRoot(), name = ref('a'), focus = ref('b')
  const m = mountGlass(() => h(Space, { focus: focus.value }, () => [h(Block, { key: 'k', name: name.value, width: 488, height: 244 }), blocks(['b'])[0]]), { root }); await flush()
  const [a, b] = root.surfacesMade, rig = root.rigs[0]!
  name.value = 'a2'; await nextTick(); await flush()
  focus.value = 'a'; await nextTick(); await flush()
  expect(m.errors.join()).toMatch(/\[Space\.focus\] 没有名为 "a" 的 Block。允许值：b, a2/)     // 'a' left, 'a2' joined
  m.errors.length = 0
  focus.value = 'a2'; await nextTick(); await flush()
  expect(m.errors).toEqual([]); expect(rig.focus).toHaveBeenLastCalledWith(a, { immediate: false })
  name.value = 'b'; await nextTick(); await flush()
  expect(m.errors.join()).toMatch(/\[Block\.name\] 重名的 Block "b"/)
  m.errors.length = 0
  focus.value = 'b'; await nextTick(); await flush()
  focus.value = 'a2'; await nextTick(); await flush()                          // still registered as a2
  expect(m.errors).toEqual([]); expect(rig.focus).toHaveBeenLastCalledWith(a, { immediate: false })
  expect(rig.focus.mock.calls.map(c => c[0])).toEqual([b, a, b, a])
})
it('Block.background: an unknown colour is reported with the allowed values; nothing is made, or the Block stays', async () => {
  const root = createFakeRoot()
  const bad = mountGlass(() => h(Space, null, () => blocks(['a'], { background: 'glas' })), { root })
  expect(bad.errors[0]).toMatch(/\[Block\.background\] 未知背景 "glas".*允许值：none, glass, .*你可能想要：glass/)
  expect(root.surfacesMade).toHaveLength(0)
  const r2 = createFakeRoot(), bg = ref('glass')
  const m = mountGlass(() => h(Space, null, () => blocks(['a'], { background: bg.value })), { root: r2 })
  bg.value = 'fil'; await nextTick()
  expect(m.errors.join()).toMatch(/\[Block\.background\] 未知背景 "fil".*你可能想要：fill/)
  expect(r2.surfacesMade).toHaveLength(1); expect(r2.surfacesMade[0]!.disposed).toBe(false)
})
it('Space, Block and Card are registered with complete manifest metadata', () => {
  for (const name of ['Space', 'Block', 'Card']) {
    const c = glassComponents().find(g => g.glass.name === name)!
    expect(c, name).toBeDefined()
    expect(c.glass.description.length).toBeGreaterThan(40); expect(c.glass.examples.length).toBeGreaterThanOrEqual(2); expect(c.glass.examples.length).toBeLessThanOrEqual(3)
    expect(c.glass.mistakes!.length).toBeGreaterThan(0)
    for (const [k, s] of Object.entries(c.glass.props.shape)) expect((s as { description?: string }).description, `${name}.${k}`).toMatch(/[一-鿿]/)
  }
  const mistakes = (name: string): string => JSON.stringify(glassComponents().find(g => g.glass.name === name)!.glass.mistakes)
  expect(mistakes('Space')).toMatch(/OrbitControls/); expect(mistakes('Space')).toMatch(/focus/)
  expect(mistakes('Block')).toMatch(/Space 外/); expect(mistakes('Block')).toMatch(/:width=\\"400\\"/); expect(mistakes('Block')).toMatch(/pointerEvents: 'auto'/)
  expect(mistakes('Card')).toMatch(/玻璃 Box/)
  for (const e of glassComponents().find(g => g.glass.name === 'Block')!.glass.examples) expect(e).toMatch(/^<Space\b[^]*<\/Space>$/)   // never the first mistake
})

// ── Task 9I: depth ──

it('unfocused Blocks recede; focus brings one forward', async () => {
  const root = createFakeRoot(), focus = ref('a')
  mountGlass(() => h(Space, { focus: focus.value }, () => blocks(['a', 'b'])), { root }); await flush()
  const [a, b] = root.surfacesMade, slotB = arcSlots([2, 2], 7, 0.5)[1]!
  expect(a!.animations.at(-1)!.target).toMatchObject({ position: [0, 0, 0], scale: [1, 1, 1] })
  const tb = b!.animations.at(-1)!.target as { position: number[]; scale: number[] }
  expect(tb.scale).toEqual([0.96, 0.96, 0.96])
  const ry = slotB.rotation[1], back = [-0.4 * Math.sin(ry), 0, -0.4 * Math.cos(ry)]          // (0, 0, −0.4) rotated about y
  expect(tb.position[0]).toBeCloseTo(slotB.position[0] + back[0]!); expect(tb.position[2]).toBeCloseTo(slotB.position[2] + back[2]!)
  focus.value = 'b'; await nextTick(); await flush()
  expect(b!.animations.at(-1)!.target).toMatchObject({ scale: [1, 1, 1] }); expect((a!.animations.at(-1)!.target as { scale: number[] }).scale).toEqual([0.96, 0.96, 0.96])
})
it('Cards rise in, staggered; frozen stands them at once', async () => {
  vi.useFakeTimers()
  try {
    const root = createFakeRoot()
    mountGlass(() => h(Space, null, () => [h(Block, { name: 'a', width: 600, height: 400 }, () => [h(Card, { id: 'c0' }), h(Card, { id: 'c1' })])]), { root }); await flush()
    const s = root.surfacesMade[0]!, c0 = byId(s.root, 'c0')!, c1 = byId(s.root, 'c1')!
    // adjusted (9I): the stagger starts once a tick has recorded the Cards at 0, so the runtime animates the rise
    expect(c0.elevation).toBe(0); root.tick(); await flush(); expect(c0.elevation).toBe(0)
    vi.advanceTimersByTime(10); expect(c0.elevation).toBe(24); expect(c1.elevation).toBe(0)
    vi.advanceTimersByTime(60); expect(c1.elevation).toBe(24)
  } finally { vi.useRealTimers() }
  const r2 = createFakeRoot()
  mountGlass(() => h(Space, null, () => [h(Block, { name: 'a', width: 600, height: 400 }, () => [h(Card, { id: 'c0' })])]), { root: r2, motion: 'frozen' }); await flush()
  expect(byId(r2.surfacesMade[0]!.root, 'c0')!.elevation).toBe(24)
})
it('a Card on the focused Block lifts and tilts toward the pointer, and settles on leave', async () => {
  const root = createFakeRoot()
  mountGlass(() => h(Space, null, () => [h(Block, { name: 'a', width: 600, height: 400 }, () => [h(Card, { id: 'c', style: { width: 200, height: 100 } })])]), { root, motion: 'frozen' })
  await flush(); root.tick()
  const s = root.surfacesMade[0]!, c = byId(s.root, 'c')!, r = absoluteRect(c)
  s.pointer.move(r.x + r.width - 1, r.y + r.height / 2)                           // right edge, middle
  expect(c.elevation).toBe(40); expect(c.tilt.y).toBeGreaterThan(0.06); expect(Math.abs(c.tilt.x)).toBeLessThan(0.01)
  s.pointer.move(-50, -50); expect(c.elevation).toBe(24); expect(c.tilt).toEqual({ x: 0, y: 0 })
})
it('reduced motion lifts without tilting; a Card on an unfocused Block takes no hover', async () => {
  const root = createFakeRoot(); root.anim.reducedMotion = true
  const card = (id: string) => h(Card, { id, style: { width: 200, height: 100 } })
  mountGlass(() => h(Space, { focus: 'a' }, () => [
    h(Block, { name: 'a', width: 600, height: 400 }, () => [card('ca')]),
    h(Block, { name: 'b', width: 600, height: 400 }, () => [card('cb')]),
  ]), { root, motion: 'frozen' })
  await flush(); root.tick()
  const [a, b] = root.surfacesMade, ca = byId(a!.root, 'ca')!, cb = byId(b!.root, 'cb')!
  // adjusted (9I): 30 pt down rather than 10, below the Card's 24 pt corner (`hitTest` leaves the rounded corner out)
  const ra = absoluteRect(ca); a!.pointer.move(ra.x + ra.width - 1, ra.y + 30)
  expect(ca.elevation).toBe(40); expect(ca.tilt).toEqual({ x: 0, y: 0 })
  const rb = absoluteRect(cb); b!.pointer.move(rb.x + rb.width - 1, rb.y + 30)
  expect(cb.elevation).toBe(24)                                                  // unfocused: its content takes no pointer
})

// ── beyond the 9I brief's tests ──

it('a Block that enters unfocused enters from behind its receded pose; a frozen focus change is immediate', async () => {
  const root = createFakeRoot(), focus = ref('a')
  mountGlass(() => h(Space, { focus: focus.value }, () => blocks(['a', 'b'])), { root, motion: 'frozen' }); await flush()
  const [a, b] = root.surfacesMade, slot = arcSlots([2, 2], 7, 0.5)[1]!, ry = slot.rotation[1]
  expect(b!.animations[0]!.from.position[2]).toBeCloseTo(receded(slot)[2]! - 1.2 * Math.cos(ry))     // enterFrom on top of RECEDE
  expect(b!.animations[0]!.from.scale).toEqual([0.96 * 0.92, 0.96 * 0.92, 0.96 * 0.92])
  focus.value = 'b'; await nextTick()
  expect(a!.animations.at(-1)).toMatchObject({ target: { scale: [0.96, 0.96, 0.96] }, opts: { immediate: true } })
  expect(b!.animations.at(-1)).toMatchObject({ target: { position: slot.position, scale: [1, 1, 1] }, opts: { immediate: true } })
})
it('a hovered Card turns its face to the pointer on both axes; a user listener and transition merge with its own', async () => {
  const root = createFakeRoot(), moved = vi.fn()
  mountGlass(() => h(Space, null, () => [h(Block, { name: 'a', width: 600, height: 400 }, () => [
    h(Card, { id: 'c', style: { width: 200, height: 100, transition: { elevation: 'bouncy' } }, onPointermove: moved }),
  ])]), { root, motion: 'frozen' })
  await flush(); root.tick()
  const s = root.surfacesMade[0]!, c = byId(s.root, 'c')!, r = absoluteRect(c)
  expect(c.style.transition).toEqual({ elevation: 'bouncy', tilt: 'snappy' })
  // top, towards the left: the top edge and the left edge recede (−x, −y), as the right edge does for +y
  s.pointer.move(r.x + 30, r.y + 2)
  expect(c.elevation).toBe(40); expect(c.tilt.x).toBeLessThan(-0.06); expect(c.tilt.y).toBeLessThan(-0.04)
  expect(moved).toHaveBeenCalledOnce()
})
it('a hovered Card settles when its Block loses the focus under a still pointer', async () => {
  const root = createFakeRoot(), focus = ref('a')
  mountGlass(() => h(Space, { focus: focus.value }, () => [
    h(Block, { name: 'a', width: 600, height: 400 }, () => [h(Card, { id: 'c', style: { width: 200, height: 100 } })]),
    blocks(['b'])[0],
  ]), { root, motion: 'frozen' })
  await flush(); root.tick()
  const s = root.surfacesMade[0]!, c = byId(s.root, 'c')!, r = absoluteRect(c)
  s.pointer.move(r.x + r.width - 1, r.y + r.height / 2); expect(c.elevation).toBe(40)
  focus.value = 'b'; await nextTick()
  expect(c.elevation).toBe(24); expect(c.tilt).toEqual({ x: 0, y: 0 })
})
it('a move that still reaches a Card on an unfocused Block (a child reopening the pointer) does not lift it', async () => {
  const root = createFakeRoot()
  mountGlass(() => h(Space, { focus: 'a' }, () => [
    blocks(['a'])[0],
    h(Block, { name: 'b', width: 600, height: 400 }, () => [h(Card, { id: 'c' }, () => [h(Box, { id: 'open', style: { width: 100, height: 40, pointerEvents: 'auto' } })])]),
  ]), { root, motion: 'frozen' })
  await flush(); root.tick()
  const b = root.surfacesMade[1]!, r = absoluteRect(byId(b.root, 'open')!)
  b.pointer.move(r.x + 50, r.y + 20)
  expect(b.pointer.hovered?.id).toBe('open'); expect(byId(b.root, 'c')!.elevation).toBe(24)
})
it('the rise-in waits for a tick so it animates; a hovered Card stays up; a later Card starts a new wave; unmounting leaves no timer', async () => {
  vi.useFakeTimers()
  try {
    const root = createFakeRoot(), more = ref(false), sized = { width: 200, height: 100 }
    const { app } = mountGlass(() => h(Space, null, () => [h(Block, { name: 'a', width: 600, height: 400 }, () => [
      h(Card, { id: 'c0' }), h(Card, { id: 'c1', style: sized }), h(Card, { id: 'c2' }), more.value ? h(Card, { id: 'late' }) : null,
    ])]), { root }); await flush()
    const s = root.surfacesMade[0]!, c0 = byId(s.root, 'c0')!, c1 = byId(s.root, 'c1')!, c2 = byId(s.root, 'c2')!
    vi.advanceTimersByTime(10); expect(c0.elevation).toBe(0)                    // no tick has recorded the Cards at 0 yet
    root.tick(); await flush(); vi.advanceTimersByTime(10); expect(c0.elevation).toBe(24)
    root.tick(); expect(c0.visual?.elevation).toBeGreaterThan(0); expect(c0.visual!.elevation).toBeLessThan(24)   // so it animates up
    const r = absoluteRect(c1); s.pointer.move(r.x + r.width / 2, r.y + r.height / 2); expect(c1.elevation).toBe(40)   // hovered before it rises
    vi.advanceTimersByTime(60); expect(c1.elevation).toBe(40)
    more.value = true; await nextTick(); root.tick(); await flush()
    const late = byId(s.root, 'late')!
    vi.advanceTimersByTime(10); expect(late.elevation).toBe(24); expect(c2.elevation).toBe(0)     // first of its own wave
    app.unmount(); expect(vi.getTimerCount()).toBe(0)
    vi.advanceTimersByTime(1000); expect(c2.elevation).toBe(0)
  } finally { vi.useRealTimers() }
})
it('reduced motion stands Cards at once; a Card outside a Block floats, rises first and lifts on hover', async () => {
  vi.useFakeTimers()
  try {
    const r1 = createFakeRoot(); r1.anim.reducedMotion = true
    mountGlass(() => h(Space, null, () => [h(Block, { name: 'a', width: 600, height: 400 }, () => [h(Card, { id: 'c0' }), h(Card, { id: 'c1' })])]), { root: r1 }); await flush()
    expect(byId(r1.surfacesMade[0]!.root, 'c1')!.elevation).toBe(24); expect(vi.getTimerCount()).toBe(0)
    const r2 = createFakeRoot()
    mountGlass(() => h(Surface, { width: 400, height: 300 }, () => [h(Card, { id: 'g', style: { width: 200, height: 100 } })]), { root: r2 }); await flush()
    const s = r2.surfacesMade[0]!, g = byId(s.root, 'g')!
    r2.tick(); await flush(); expect(g.elevation).toBe(0)
    vi.advanceTimersByTime(1); expect(g.elevation).toBe(24)
    const r = absoluteRect(g); s.pointer.move(r.x + r.width - 1, r.y + r.height / 2)
    expect(g.elevation).toBe(40); expect(g.tilt.y).toBeGreaterThan(0.06)
  } finally { vi.useRealTimers() }
})
it('the manifest: Block no longer calls Card concentric, a one-Card Block is no mistake, Card describes its depth', () => {
  const meta = (name: string) => glassComponents().find(g => g.glass.name === name)!.glass
  const block = meta('Block'), card = meta('Card')
  expect(block.description).not.toMatch(/同心/); expect((block.props.shape.radius as { description?: string }).description).not.toMatch(/Card 用 radius: concentric/)
  expect(JSON.stringify(card.mistakes)).not.toMatch(/整个 Block 的内容/)
  expect(card.description).toMatch(/24 pt/); expect(card.description).toMatch(/40 pt/); expect(card.description).toMatch(/60 ms/); expect(card.description).toMatch(/减少动态效果/)
  expect(block.description).toMatch(/0\.96/)
})
