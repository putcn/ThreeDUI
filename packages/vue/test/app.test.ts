import { it, expect, vi } from 'vitest'
import { defineComponent, h, inject, nextTick, onMounted, ref, Teleport } from '@vue/runtime-core'
import { Node } from '@glassui/core'
import { createGlassApp } from '../src/app'
import { createGlassRenderer } from '../src/renderer'
import { GLASS_OPTIONS, GLASS_ROOT, GLASS_SURFACE } from '../src/keys'
import { createFakeRoot } from './fixtures/fake-root'
import { tree } from './fixtures/tree'

it('mount(surface) mounts into its root and provides it; mount() uses a detached container', async () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 200, height: 100 })
  let seen: unknown
  const App = defineComponent(() => { seen = inject(GLASS_SURFACE); return () => h('box', { id: 'x' }) })
  createGlassApp(App, { root }).mount(s as never)
  expect(seen).toBe(s); expect(s.root.children.map(n => n.id)).toEqual(['x'])
  const a2 = createGlassApp(defineComponent(() => () => h('box', { id: 'y' })), { root })
  expect(() => a2.mount()).not.toThrow()
})
it('mount() rejects any other target instead of falling back to a detached container', () => {
  const app = createGlassApp(defineComponent(() => () => null), { root: createFakeRoot() })
  expect(() => app.mount('#app')).toThrow(/\[createGlassApp\.mount\] 挂载目标必须是 Surface、Node 或省略.*"#app".*允许值：Surface, Node, undefined/)
  expect(() => app.mount({} as never)).toThrow(/\[createGlassApp\.mount\].*"\[object Object\]"/)
})
it('chainable App methods keep the GlassApp type (mount(surface) after use/provide compiles)', () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 10, height: 10 })
  let seen: unknown
  const App = defineComponent(() => { seen = inject('k'); return () => h('box', { id: 'z' }) })
  createGlassApp(App, { root }).use({ install() {} }).provide('k', 1).mount(s)
  expect(seen).toBe(1); expect(s.root.children.map(n => n.id)).toEqual(['z'])
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
it('a glass app as the parent: no Vue warning, the child sees its own Surface and the parent\'s provides', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const root = createFakeRoot(), s1 = root.createSurface({ width: 10, height: 10 }), s2 = root.createSurface({ width: 10, height: 10 })
  const parent = createGlassApp(defineComponent(() => () => null), { root }).provide('store', 7)
  parent.mount(s1)
  let seen: unknown[] = []
  const Child = defineComponent(() => { seen = [inject(GLASS_SURFACE), inject('store')]; return () => null })
  createGlassApp(Child, { root, parent }).mount(s2)
  expect(warn).not.toHaveBeenCalled()
  expect(seen).toEqual([s2, 7])
  warn.mockRestore()
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
it('a first mount that fails half-way leaves only the marker; fixing the cause mounts one clean tree', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  const bad = ref(true), container = new Node('box')
  const app = createGlassApp(defineComponent(() => () => [h('box', { id: 'first' }), bad.value ? h('nope') : h('box', { id: 'second' })]), { root: createFakeRoot() })
  expect(app.mount(container)).toBeUndefined()
  expect(container.children.map(n => n.id)).toEqual(['glassui-error'])   // the fragment's anchors and 'first' are gone
  bad.value = false; await nextTick()
  expect(tree(container).children!.map(c => c.id)).toEqual(['glassui-error', 'first', 'second'])
  err.mockRestore()
})
it('a deferred Teleport whose target is missing at mount is reported (console + marker); the tree stays and keeps updating', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {}), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const root = createFakeRoot(), n = ref(0), container = new Node('box')
  createGlassApp(defineComponent(() => () => h('box', { id: 'outer' }, [
    h('text', { id: 'count' }, String(n.value)), h(Teleport, { to: 'nope', defer: true }, [h('box', { id: 'lost' })]), h('box', { id: 'after' }),
  ])), { root }).mount(container)
  expect(err).toHaveBeenCalledWith('[glassui]', expect.objectContaining({ message: expect.stringMatching(/\[Teleport\] 找不到目标 "nope".*defer/) }))
  expect(tree(container).children!.map(c => c.id)).toEqual(['outer', 'glassui-error'])
  expect(tree(container).children![0]!.children!.map(c => c.id)).toEqual(['count', 'after'])
  expect(container.children.find(c => c.id === 'glassui-error')!.props.value).toMatch(/找不到目标 "nope"/)
  n.value = 1; await nextTick()                           // later updates still render
  expect(container.children[0]!.children.find(c => c.id === 'count')!.props.value).toBe('1')
  let mounted = false                                     // and a later app's post-flush hooks still run
  createGlassApp(defineComponent(() => { onMounted(() => { mounted = true }); return () => null }), { root }).mount()
  expect(mounted).toBe(true)
  err.mockRestore(); warn.mockRestore()
})
it('errorMarker: false logs without a marker', () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  const container = new Node('box')
  createGlassApp(defineComponent(() => () => h('nope')), { root: createFakeRoot(), errorMarker: false }).mount(container)
  expect(err).toHaveBeenCalled(); expect(container.children.some(n => n.id === 'glassui-error')).toBe(false)
  err.mockRestore()
})
