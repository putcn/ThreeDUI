import { it, expect, vi } from 'vitest'
import { defineComponent, Fragment, h, nextTick, provide, ref, shallowRef, type VNode } from '@vue/runtime-core'
import { z } from 'zod'
import { Node } from '@glassui/core'
import { createGlassApp } from '../src/app'
import { createGlassRenderer } from '../src/renderer'
import { defineGlassComponent, glassComponents } from '../src/define'
import { useCanvasFactory, useMotion, useRoot, useScheme, useSurface } from '../src/inject'
import { GLASS_SURFACE } from '../src/keys'
import { createFakeRoot } from './fixtures/fake-root'
import { byId } from './fixtures/tree'

const Btn = defineGlassComponent({
  name: 'Btn', description: 'test',
  props: z.object({ variant: z.enum(['glass', 'filled']).default('glass').describe('look'), size: z.number().default(10).describe('pt'), disabled: z.boolean().default(false).describe('off') }),
  events: { press: { payload: '{}', description: 'pressed' } }, examples: ['<Btn />', '<Btn variant="filled" />'],
}, (p) => () => h('box', { id: 'btn', style: { width: p.value.size } }))

const run = (vnode: () => VNode) => {
  const errors: string[] = []
  const app = createGlassApp(defineComponent(() => vnode), { root: createFakeRoot() })
  app.config.errorHandler = e => { errors.push(String(e)) }
  const c = new Node('box'); app.mount(c)
  return { c, errors }
}

it('validates props with readable errors and suggestions (Review Focus 5)', () => {
  expect(run(() => h(Btn, { variant: 'filed' })).errors[0]).toMatch(/\[Btn\.variant\] 非法取值 "filed"。允许值：glass, filled。你可能想要：filled/)
  expect(run(() => h(Btn, { size: '12' })).errors[0]).toMatch(/\[Btn\.size\] 类型应为 number，得到 string.*:prop/)
  expect(run(() => h(Btn, { colour: 'red' })).errors[0]).toMatch(/\[Btn\] 未知属性 "colour"/)
})
it('casts boolean attributes and applies zod defaults', () => {
  const { c } = run(() => h(Btn, { disabled: '' }))            // <Btn disabled> in a template
  expect(c.children[0]!.style.width).toBe(10)
})
it('registers the component with its metadata', () => {
  expect(glassComponents().map(c => c.glass.name)).toContain('Btn')
})
it('useRoot outside a glass app is a readable error', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})   // Vue: the failed setup leaves no render function
  const { errors } = (() => { const app = createGlassRenderer({ root: createFakeRoot() }).createApp(defineComponent(() => { useRoot(); return () => null })); const errs: string[] = []; app.config.errorHandler = e => { errs.push(String(e)) }; app.mount(new Node('box')); return { errors: errs } })()
  expect(errors[0]).toMatch(/\[useRoot\] 组件必须在 createGlassApp/)
  warn.mockRestore()
})

/** A probe of what the props parse to (and how often the setup's render runs). */
const Probe = defineGlassComponent({
  name: 'Probe', description: 'test',
  props: z.object({
    on: z.boolean().optional().describe('flag'), n: z.number().describe('required number'), kind: z.enum(['a', 'b']).optional().describe('kind'),
    value: z.union([z.string(), z.array(z.string())]).optional().describe('text or lines'), min: z.number().min(0, '不能为负数').optional().describe('≥ 0'),
  }),
  examples: ['<Probe :n="1" />'],
}, (p) => () => h('text', { id: 'probe' }, JSON.stringify(p.value)))
const probed = (c: Node) => JSON.parse(String(byId(c, 'probe')!.props.value)) as Record<string, unknown>

it('boolean props: absent stays absent (zod decides), present-as-attribute is true; other props pass through as given', () => {
  expect(probed(run(() => h(Probe, { n: 1 })).c)).toEqual({ n: 1 })
  expect(probed(run(() => h(Probe, { n: 1, on: '' })).c)).toEqual({ n: 1, on: true })
  expect(probed(run(() => h(Probe, { n: 1, on: false, kind: 'b', value: ['x'] })).c)).toEqual({ n: 1, on: false, kind: 'b', value: ['x'] })
})
it('unknown props list the schema keys with a suggestion; missing, union and refinement failures read well; Vue adds no warning', () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  expect(run(() => h(Btn, { sise: 12 })).errors[0]).toMatch(/^GlassUIError: \[Btn\] 未知属性 "sise"。允许值：variant, size, disabled。你可能想要：size$/)
  expect(run(() => h(Probe, {})).errors[0]).toMatch(/\[Probe\.n\] 缺少必填属性（类型应为 number）/)
  expect(run(() => h(Probe, { n: 1, value: 3 })).errors[0]).toMatch(/\[Probe\.value\] 类型应为 string \| array，得到 number/)
  expect(run(() => h(Probe, { n: 1, min: -1 })).errors[0]).toMatch(/\[Probe\.min\] 不能为负数/)
  expect(run(() => h(Probe, { n: 1, on: 'yes' })).errors[0]).toMatch(/\[Probe\.on\] 类型应为 boolean，得到 string（模板里数字和布尔值要写成 :prop="…"）/)
  expect(warn).not.toHaveBeenCalled()                    // no "Invalid prop" (the boolean's type check is zod's), no "missing render function" (setup threw)
  warn.mockRestore()
})
it('invalid props are reported on every render while they stay invalid, and the component recovers once they are fixed', async () => {
  const size = ref<unknown>('12')
  const Counter = defineGlassComponent({ name: 'Counter', description: 'test', props: z.object({ size: z.number().describe('pt') }), examples: ['<Counter :size="1" />'] },
    (p) => () => h('box', { id: 'cnt', style: { width: p.value.size } }))
  const { c, errors } = run(() => h(Counter, { size: size.value }))
  size.value = 'x'; await nextTick()                     // still invalid, differently
  expect(errors.map(e => e.replace(/^GlassUIError: /, ''))).toEqual([
    expect.stringMatching(/^\[Counter\.size\] 类型应为 number，得到 string/), expect.stringMatching(/^\[Counter\.size\] 类型应为 number，得到 string/)])
  size.value = 12; await nextTick()
  expect(byId(c, 'cnt')!.style.width).toBe(12); expect(errors).toHaveLength(2)
})
it('an invalid prop read by a re-render that the props did not cause is still the readable error, never a TypeError', async () => {
  const bump = ref(0)
  const Live = defineGlassComponent({ name: 'Live', description: 'test', props: z.object({ size: z.number().describe('pt') }), slots: { default: 'content' }, examples: ['<Live :size="1" />'] },
    (p, { slots }) => () => h('box', { style: { width: p.value.size } }, slots.default?.()))
  // a slot: every render of the parent updates Live, with the same (invalid) props
  const { errors } = run(() => { void bump.value; return h(Live, { size: 'big' }, () => [h('text', 'x')]) })
  bump.value++; await nextTick(); bump.value++; await nextTick()
  expect(errors).toHaveLength(3)
  for (const e of errors) expect(e).toMatch(/^GlassUIError: \[Live\.size\] 类型应为 number，得到 string/)
})
it('an unknown attribute that appears on a later render is reported too', async () => {
  const extra = ref<Record<string, unknown>>({})
  const { errors } = run(() => h(Btn, { ...extra.value }))
  expect(errors).toEqual([])
  extra.value = { colour: 'red' }; await nextTick()
  expect(errors[0]).toMatch(/\[Btn\] 未知属性 "colour"/)
})
it('declared events are emitted, not passed through as attributes', () => {
  const got: unknown[] = []
  const Emitter = defineGlassComponent({ name: 'Emitter', description: 'test', props: z.object({}), events: { press: { payload: '{ x: number }', description: 'pressed' } }, examples: ['<Emitter @press="go" />'] },
    (_p, { emit }) => () => h('glass', { id: 'e', onClick: () => emit('press', { x: 1 }) }))
  const { c, errors } = run(() => h(Emitter, { onPress: (e: unknown) => got.push(e) }))
  byId(c, 'e')!.handlers.get('click')!({} as never)
  expect(errors).toEqual([]); expect(got).toEqual([{ x: 1 }]); expect(byId(c, 'e')!.handlers.has('press')).toBe(false)
})

// Fallthrough (controller ruling): the component's own tw / style / handlers survive the user's.
const Shell = defineGlassComponent({ name: 'Shell', description: 'test', props: z.object({}), examples: ['<Shell />'] },
  (_p) => () => h('glass', { id: 'shell', tw: 'p-2 flex-row', class: 'items-start', style: { width: 80, glass: { thickness: 4, glow: { color: 'accent', strength: 1.1 } }, hover: { scale: 1.02, glass: { lift: 0.3 } } } }))

it('fallthrough: the user\'s tw is appended to the component\'s (both apply, the user\'s wins a conflict); class likewise', () => {
  const { c } = run(() => h(Shell, { tw: 'p-4 justify-center', class: 'items-center' }))
  expect(byId(c, 'shell')!.style).toMatchObject({ flexDirection: 'row', justifyContent: 'center', padding: 16, alignItems: 'center' })
})
it('fallthrough: a user style merges key by key into the component\'s, nested glass and state branches included', () => {
  const { c } = run(() => h(Shell, { style: { height: 30, glass: { tint: '#f00' }, hover: { glass: { lift: 0.5 } } } }))
  expect(byId(c, 'shell')!.style).toMatchObject({
    width: 80, height: 30, glass: { thickness: 4, glow: { color: 'accent', strength: 1.1 }, tint: '#f00' }, hover: { scale: 1.02, glass: { lift: 0.5 } },
  })
})
it('fallthrough: the user\'s onClick and the component\'s own both run; id is set', () => {
  const got: string[] = []
  const Own = defineGlassComponent({ name: 'Own', description: 'test', props: z.object({}), examples: ['<Own />'] },
    () => () => h('glass', { onClick: () => got.push('own') }))
  const { c, errors } = run(() => h(Own, { id: 'mine', onClick: () => got.push('user') }))
  byId(c, 'mine')!.handlers.get('click')!({} as never)
  expect(errors).toEqual([]); expect(got).toEqual(['own', 'user'])
})
it('fallthrough through a component root keeps the inner component\'s own style; a Fragment root takes none and does not throw', () => {
  const Outer = defineGlassComponent({ name: 'Outer', description: 'test', props: z.object({}), examples: ['<Outer />'] },
    () => () => h(Shell, { style: { height: 20 } }))
  const { c } = run(() => h(Outer, { style: { glass: { tint: '#0f0' } }, tw: 'p-4' }))
  expect(byId(c, 'shell')!.style).toMatchObject({ width: 80, height: 20, padding: 16, glass: { thickness: 4, glow: { color: 'accent', strength: 1.1 }, tint: '#0f0' } })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const Frag = defineGlassComponent({ name: 'Frag', description: 'test', props: z.object({}), examples: ['<Frag />'] },
    () => () => h(Fragment, [h('box', { id: 'f1' }), h('box', { id: 'f2' })]))
  const f = run(() => h(Frag, { id: 'x', tw: 'p-4' }))
  expect(f.errors).toEqual([]); expect(warn).not.toHaveBeenCalled()
  expect(byId(f.c, 'f1')!.style.padding).toBeUndefined(); expect(byId(f.c, 'x')).toBeNull()
  warn.mockRestore()
})
it('an equal re-render with fallthrough attributes leaves the node clean (Review Focus 1)', async () => {
  const bump = ref(0)
  const { c } = run(() => { void bump.value; return h(Shell, { tw: 'p-4', style: { glass: { tint: '#f00' } }, onClick: () => {} }) })
  const n = byId(c, 'shell')!, clean = { layout: false, paint: false, text: false, tree: false }
  n.dirty = { ...clean }
  bump.value++; await nextTick()
  expect(n.dirty).toEqual(clean)
})

it('useScheme follows the root\'s theme event and stops listening on unmount', async () => {
  const root = createFakeRoot(), show = ref(true), seen: string[] = []
  const Scheme = defineComponent(() => { const s = useScheme(); return () => { seen.push(s.value); return null } })
  createGlassApp(defineComponent(() => () => show.value ? h(Scheme) : null), { root }).mount(new Node('box'))
  root.emit('theme', { theme: root.theme, scheme: 'dark', contrast: false }); await nextTick()
  expect(seen).toEqual(['light', 'dark'])
  show.value = false; await nextTick()
  root.emit('theme', { theme: root.theme, scheme: 'light', contrast: false }); await nextTick()
  expect(seen).toEqual(['light', 'dark'])
})
it('useSurface reads the provided Surface (unwrapping a ref), useMotion and useCanvasFactory the app options', () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 10, height: 10 }), canvas = vi.fn()
  let got: unknown[] = []
  const Read = defineComponent(() => { got = [useSurface(), useMotion(), useCanvasFactory()]; return () => null })
  createGlassApp(Read, { root, motion: 'frozen', createCanvas: canvas }).mount(s)
  expect(got).toEqual([s, 'frozen', canvas])
  const other = root.createSurface({ width: 10, height: 10 })
  const Wrap = defineComponent(() => { provide(GLASS_SURFACE, shallowRef(other) as never); return () => h(Read) })
  createGlassApp(Wrap, { root }).mount()
  expect(got[0]).toBe(other); expect(got[1]).toBe('live')
})
