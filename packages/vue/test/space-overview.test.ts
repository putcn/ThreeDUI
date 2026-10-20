import { it, expect, vi } from 'vitest'
import { h, nextTick, ref } from '@vue/runtime-core'
import type { Node } from '@glassui/core'
import type { CameraRig, KeyGesture, WheelGesture } from '@glassui/render'
import { Space } from '../src/components/Space'
import { Block } from '../src/components/Block'
import { createFakeRoot, flush, type FakeRig } from './fixtures/fake-root'
import { mountGlass } from './fixtures/mount'
import { bubble } from './fixtures/events'

const names = ['orders', 'dashboard', 'network', 'receiving', 'twin', 'settings']
const blocks = () => names.map(name => h(Block, { key: name, name, width: 488, height: 244 }))
const wheel = (deltaY: number, surface: unknown, ctrlKey = true): WheelGesture => ({ deltaX: 0, deltaY, ctrlKey, metaKey: false, surface: surface as never, screenX: 0, screenY: 0 })
const key = (key: string, surface: unknown, extra: Partial<KeyGesture> = {}): KeyGesture => ({ key, type: 'keydown', shiftKey: false, surface: surface as never, focused: null, ...extra })

it('overview frames every Block and standby uses distance 1.25 with opacity 0.35', async () => {
  const root = createFakeRoot(), focus = ref<string | null>(null), standby = ref(false)
  mountGlass(() => h(Space, { focus: focus.value, overview: true, layout: 'grid', columns: 3, standby: standby.value }, () => blocks()), { root }); await flush()
  expect(root.rigs[0]!.frame).toHaveBeenLastCalledWith(root.surfacesMade, { immediate: true, distanceScale: 1, parallax: 3 })
  standby.value = true; await nextTick(); await flush()
  expect(root.rigs[0]!.frame).toHaveBeenLastCalledWith(root.surfacesMade, { immediate: false, distanceScale: 1.25, parallax: 3 })
  expect(root.surfacesMade.every(s => s.opacity === 0.35)).toBe(true)
})
it('overview click requests focus and suppresses interaction with Block content', async () => {
  const root = createFakeRoot(), focus = ref<string | null>(null), onFocus = vi.fn()
  mountGlass(() => h(Space, { focus: focus.value, overview: true, 'onUpdate:focus': (n: string | null) => { onFocus(n); focus.value = n } }, () => blocks()), { root }); await flush()
  const target = root.surfacesMade[1]!
  root.tick(); target.pointer.down(20, 20)
  expect(onFocus).toHaveBeenCalledWith('dashboard')
  const hasBlockedContent = (node: Node | null): boolean => !!node && (node.style.pointerEvents === 'none' || node.children.some(child => hasBlockedContent(child)))
  expect(hasBlockedContent(target.root)).toBe(true)
})
it('Ctrl-wheel accumulates within 300 ms; positive returns to overview and negative over a Block focuses it', async () => {
  vi.useFakeTimers()
  try {
    const root = createFakeRoot(), focus = ref<string | null>('dashboard')
    mountGlass(() => h(Space, { focus: focus.value, overview: true, layout: 'grid', columns: 3, 'onUpdate:focus': (n: string | null) => { focus.value = n } }, () => blocks()), { root }); await flush()
    const interceptor = root.wheelInterceptors[0]!
    expect(interceptor(wheel(20, null))).toBe(true); vi.advanceTimersByTime(200); interceptor(wheel(25, null)); await nextTick()
    expect(focus.value).toBe(null)
    interceptor(wheel(-50, root.surfacesMade[4]!)); await nextTick(); expect(focus.value).toBe('twin')
    expect(interceptor(wheel(50, null, false))).toBe(false)
  } finally { vi.useRealTimers() }
})
it('overview Tab, grid arrows and Enter select Blocks; Escape is guarded in focus mode', async () => {
  const root = createFakeRoot(), focus = ref<string | null>(null)
  mountGlass(() => h(Space, { focus: focus.value, overview: true, layout: 'grid', columns: 3, 'onUpdate:focus': (n: string | null) => { focus.value = n } }, () => blocks()), { root }); await flush()
  const keys = root.keyInterceptors[0]!, surface = root.surfacesMade[0]!
  expect(keys(key('Tab', null))).toBe(true)
  expect(root.surfacesMade[0]!.position.z).toBeGreaterThan(0)
  keys(key('ArrowRight', null)); keys(key('ArrowDown', null)); expect(root.surfacesMade[4]!.position.z).toBeGreaterThan(0)
  keys(key('Enter', null)); await nextTick(); expect(focus.value).toBe('twin')
  expect(keys(key('Escape', root.surfacesMade[4]!))).toBe(true); expect(focus.value).toBe(null)
  expect(keys(key('Escape', root.surfacesMade[4]!, { focused: { props: { textField: true } } as never }))).toBe(false)
  expect(keys(key('Escape', root.surfacesMade[0]!))).toBe(false)
  Object.defineProperty(root.ime, 'composing', { configurable: true, value: true })
  expect(keys(key('Escape', root.surfacesMade[4]!))).toBe(false)
})
it('arrive waits for rig.frame to resolve true and removing a Block reframes the rest', async () => {
  const root = createFakeRoot(), focus = ref<string | null>(null), show = ref(true), arrive = vi.fn()
  let finish!: (ok: boolean) => void
  const createRig = root.createCameraRig.bind(root)
  vi.spyOn(root, 'createCameraRig').mockImplementation(() => {
    const rig = createRig() as unknown as FakeRig
    rig.frame.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve }))
    return rig as unknown as CameraRig
  })
  const { app } = mountGlass(() => h(Space, { focus: focus.value, overview: true, layout: 'grid', columns: 3, onArrive: arrive }, () => [blocks()[0], show.value ? blocks()[1] : null]), { root })
  const rig = root.rigs[0]!
  await flush(); expect(arrive).not.toHaveBeenCalled()
  finish(true); await flush(); expect(arrive).toHaveBeenCalledWith(null)
  const calls = rig.frame.mock.calls.length
  show.value = false; await nextTick(); await flush()
  expect(rig.frame).toHaveBeenCalledTimes(calls + 1)
  app.unmount()
})
it('invalid cross-props are readable; standby with focus warns once', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(mountGlass(() => h(Space, { layout: 'grid' }, () => blocks())).errors.join()).toMatch(/\[Space\.columns\].*必须给 columns/)
  expect(mountGlass(() => h(Space, { focus: null }, () => blocks())).errors.join()).toMatch(/\[Space\.focus\].*只有 overview 为 true/)
  const root = createFakeRoot(); mountGlass(() => h(Space, { focus: 'orders', overview: true, standby: true }, () => blocks()), { root })
  expect(warn).toHaveBeenCalledWith('[Space] standby 只在总览（focus 为 null）时生效')
  warn.mockRestore()
})
it('unbound focus starts at the first Block, Escape returns to overview and a press focuses another Block', async () => {
  const root = createFakeRoot(), updates: (string | null)[] = []
  mountGlass(() => h(Space, { overview: true, 'onUpdate:focus': (n: string | null) => updates.push(n) }, () => blocks()), { root }); await flush()
  expect(root.rigs[0]!.frame).not.toHaveBeenCalled()
  const keys = root.keyInterceptors[0]!
  expect(keys(key('Escape', root.surfacesMade[0]!))).toBe(true)
  expect(updates).toEqual([null])
  root.tick(); root.surfacesMade[2]!.pointer.down(60, 60); await nextTick(); await flush()
  expect(updates.at(-1)).toBe('network')
})
