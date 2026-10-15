import { it, expect, vi } from 'vitest'
import { defineComponent, h, inject, nextTick, ref } from '@vue/runtime-core'
import { Node } from '@glassui/core'
import { createGlassApp } from '../src/app'
import { createGlassRenderer } from '../src/renderer'
import { GLASS_OPTIONS, GLASS_ROOT, GLASS_SURFACE } from '../src/keys'
import { createFakeRoot } from './fixtures/fake-root'

it('mount(surface) mounts into its root and provides it; mount() uses a detached container', async () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 200, height: 100 })
  let seen: unknown
  const App = defineComponent(() => { seen = inject(GLASS_SURFACE); return () => h('box', { id: 'x' }) })
  createGlassApp(App, { root }).mount(s as never)
  expect(seen).toBe(s); expect(s.root.children.map(n => n.id)).toEqual(['x'])
  const a2 = createGlassApp(defineComponent(() => () => h('box', { id: 'y' })), { root })
  expect(() => a2.mount()).not.toThrow()
})
it('provides the root and the options (motion live, a canvas factory) by default', () => {
  const root = createFakeRoot(), canvas = vi.fn()
  let got: unknown[] = []
  const App = defineComponent(() => { got = [inject(GLASS_ROOT), inject(GLASS_OPTIONS), inject(GLASS_SURFACE)]; return () => null })
  createGlassApp(App, { root }).mount(new Node('box'))
  expect(got[0]).toBe(root); expect(got[1]).toMatchObject({ motion: 'live' }); expect(got[2]).toBeNull()
  createGlassApp(App, { root, motion: 'frozen', createCanvas: canvas }).mount()
  expect(got[1]).toEqual({ motion: 'frozen', createCanvas: canvas })
})
it('parent sharing copies provides, components and global properties', () => {
  const parent = createGlassRenderer({ root: createFakeRoot() }).createApp({})
  parent.provide('store', 42); parent.component('Hello', defineComponent(() => () => null)); parent.config.globalProperties.$t = (k: string) => k
  let got: unknown
  const App = defineComponent(() => { got = inject('store'); return () => null })
  const app = createGlassApp(App, { root: createFakeRoot(), parent })
  app.mount()
  expect(got).toBe(42); expect(app.component('Hello')).toBeDefined(); expect(app.config.globalProperties.$t).toBeDefined()
})
it('a render error reaches the console and leaves a marker in the container', () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  const app = createGlassApp(defineComponent(() => () => h('nope')), { root: createFakeRoot() })
  const container = new Node('box')
  app.mount(container)
  expect(err).toHaveBeenCalled()
  expect(container.children.some(n => n.id === 'glassui-error' && String(n.props.value).includes('未知元素'))).toBe(true)
  err.mockRestore()
})
it('an error in a later render also reaches the console and the marker', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  const tag = ref('box'), container = new Node('box')
  createGlassApp(defineComponent(() => () => h(tag.value)), { root: createFakeRoot() }).mount(container)
  expect(err).not.toHaveBeenCalled()
  tag.value = 'div'; await nextTick()
  expect(err).toHaveBeenCalled()
  expect(container.children.find(n => n.id === 'glassui-error')?.props.value).toMatch(/未知元素 <div>/)
  err.mockRestore()
})
it('errorMarker: false logs without a marker', () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  const container = new Node('box')
  createGlassApp(defineComponent(() => () => h('nope')), { root: createFakeRoot(), errorMarker: false }).mount(container)
  expect(err).toHaveBeenCalled(); expect(container.children.some(n => n.id === 'glassui-error')).toBe(false)
  err.mockRestore()
})
