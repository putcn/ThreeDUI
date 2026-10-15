import { describe, it, expect } from 'vitest'
import { h, nextTick, reactive, ref, Teleport, Fragment, defineComponent } from '@vue/runtime-core'
import { Node } from '@glassui/core'
import { createGlassRenderer, setStyleLayer } from '../src/renderer'
import { createFakeRoot } from './fixtures/fake-root'
import { tree } from './fixtures/tree'

const mount = (comp: unknown) => {
  const root = createFakeRoot(), container = new Node('box', 'c')
  const app = createGlassRenderer({ root }).createApp(comp as never)
  const errors: unknown[] = []; app.config.errorHandler = e => { errors.push(e) }
  app.mount(container)
  return { root, container, app, errors }
}

describe('nodeOps', () => {
  it('creates host nodes, text and anchors; v-if and v-for keep keyed identity', async () => {
    const show = ref(true), items = ref(['a', 'b', 'c'])
    const { container } = mount(() => h('box', { id: 'outer' }, [
      show.value ? h('text', { id: 't' }, 'hello') : null,
      ...items.value.map(k => h('glass', { key: k, id: k })),
    ]))
    expect(tree(container)).toEqual({ type: 'box', id: 'c', children: [{ type: 'box', id: 'outer', children: [
      { type: 'text', id: 't', value: 'hello' }, { type: 'glass', id: 'a' }, { type: 'glass', id: 'b' }, { type: 'glass', id: 'c' }] }] })
    const b = container.children[0]!.children.find(n => n.id === 'b')!
    items.value = ['c', 'b', 'a']; show.value = false; await nextTick()
    expect(tree(container).children![0]!.children!.map(c => c.id)).toEqual(['c', 'b', 'a'])
    expect(container.children[0]!.children.find(n => n.id === 'b')).toBe(b)          // same Node: moved, not recreated
  })
  it('empty text anchors take no layout space', () => {
    const { container } = mount(() => h(Fragment, [h('box', { id: 'x' })]))
    const anchors = container.children.filter(n => n.type === 'text')
    expect(anchors.length).toBeGreaterThan(0)
    expect(anchors.every(n => n.style.position === 'absolute')).toBe(true)
  })
  it('an unknown element names the allowed tags', () => {
    const { errors } = mount(() => h('div'))
    expect(String(errors[0])).toMatch(/\[renderer\] 未知元素 <div>.*允许值：box, text, image, glass, scroll, portal/)
  })
  it('on* props become element handlers; an unknown event type is an error', async () => {
    const got: string[] = []
    const { container } = mount(() => h('glass', { id: 'g', onClick: () => got.push('click'), onPress: () => got.push('press') }))
    const g = container.children.find(n => n.id === 'g')!
    g.handlers.get('click')!({} as never); g.handlers.get('press')!({} as never)
    expect(got).toEqual(['click', 'press'])
    const bad = mount(() => h('box', { onClik: () => {} }))
    expect(String(bad.errors[0])).toMatch(/\[renderer\] 未知事件 "onClik".*你可能想要：onClick/)
  })
  it('merged listeners (own + fallthrough) all run; a throwing handler reaches the error handler', () => {
    const got: string[] = []
    const Btn = defineComponent(() => () => h('glass', { id: 'g', onClick: () => got.push('own') }))
    const { container, errors } = mount(() => h(Btn, { onClick: () => { got.push('user'); throw new Error('oops') } }))
    container.children.find(n => n.id === 'g')!.handlers.get('click')!({} as never)
    expect(got).toEqual(['own', 'user']); expect(String(errors[0])).toMatch(/oops/)
  })
  it('host nodes are never made reactive: a template ref holds the node itself', () => {
    const el = ref<Node | null>(null)
    const { container } = mount(defineComponent(() => () => h('box', { id: 'b', ref: el })))
    expect(el.value).toBe(container.children.find(n => n.id === 'b'))
  })
  it('style, tw and class merge (style wins); an equal re-render leaves the node clean (Review Focus 1)', async () => {
    const pad = ref(8), bump = ref(0)
    let renders = 0
    const { container } = mount(() => {
      void bump.value; renders++
      // every render: fresh objects with the same content (style with nested glass and a state branch, a rebuilt tw
      // string, an inline handler)
      return h('glass', {
        id: 'b', tw: ['flex-row', 'p-2'].join(' '), class: 'items-center', onClick: () => {},
        style: { padding: pad.value, bg: 'fill', glass: { thickness: 4, glow: { color: 'accent', strength: 1 } }, hover: { scale: 1.02, glass: { lift: 0.3 } } },
      })
    })
    const b = container.children.find(n => n.id === 'b')!
    expect(b.style).toMatchObject({ flexDirection: 'row', alignItems: 'center', padding: 8, bg: 'fill', hover: { scale: 1.02, glass: { lift: 0.3 } } })
    const clean = { layout: false, paint: false, text: false, tree: false }
    b.dirty = { ...clean }
    const before = renders
    bump.value++; await nextTick()                        // re-render, same content
    expect(renders).toBe(before + 1)
    expect(b.dirty).toEqual(clean)
    pad.value = 12; await nextTick()
    expect(b.style.padding).toBe(12); expect(b.dirty.layout).toBe(true)
  })
  it('a style layer composes over the props and survives patches', async () => {
    const w = ref(100)
    const { container } = mount(() => h('box', { id: 'b', style: { width: w.value, opacity: 1 } }))
    const b = container.children.find(n => n.id === 'b')!
    setStyleLayer(b, 'transition', { opacity: 0 })
    w.value = 120; await nextTick()
    expect(b.style).toMatchObject({ width: 120, opacity: 0 })
    setStyleLayer(b, 'transition', null)
    expect(b.style.opacity).toBe(1)
  })
  it('state branches and glass merge key by key across tw, style and the layers; tw takes class forms', () => {
    const { container } = mount(() => h('glass', { id: 'g', tw: ['hover:bg-accent', { 'p-2': true, 'p-4': false }], style: { hover: { scale: 1.02 }, glass: { thickness: 4, lift: 0.2 } } }))
    const g = container.children.find(n => n.id === 'g')!
    setStyleLayer(g, 'control', { glass: { lift: 0.5 }, hover: { opacity: 0.9 } })
    expect(g.style.hover).toEqual({ bg: 'accent', scale: 1.02, opacity: 0.9 })
    expect(g.style.glass).toEqual({ thickness: 4, lift: 0.5 }); expect(g.style.padding).toBe(8)
  })
  it('a nested style object mutated in place still reaches the node (the node never shares it)', async () => {
    const st = reactive({ width: 80, glass: { thickness: 4 } }), bump = ref(0)
    const { container } = mount(() => { void bump.value; return h('glass', { id: 'g', style: st }) })
    const g = container.children.find(n => n.id === 'g')!
    st.glass.thickness = 10; bump.value++; await nextTick()                   // same reactive object, nested field changed
    expect(g.style.glass).toEqual({ thickness: 10 })
    const layer = { glass: { lift: 0.3, glow: { color: 'accent', strength: 1 } } }
    setStyleLayer(g, 'control', layer)
    layer.glass.lift = 0.6; layer.glass.glow.strength = 2
    expect(g.style.glass).toEqual({ thickness: 10, lift: 0.3, glow: { color: 'accent', strength: 1 } })   // not aliased
    setStyleLayer(g, 'control', layer)                                         // the same object again, mutated
    expect(g.style.glass).toEqual({ thickness: 10, lift: 0.6, glow: { color: 'accent', strength: 2 } })
  })
  it('an invalid style reports the prop path', () => {
    const { errors } = mount(() => h('box', { style: { pading: 4 } }))
    expect(String(errors[0])).toMatch(/\[style\] 未知键 "pading".*你可能想要：padding/)
  })
  it('a bad style or class patch keeps the last good style; layers still compose', async () => {
    const st = ref<Record<string, unknown>>({ width: 10 }), cls = ref('p-2')
    const { container, errors } = mount(() => h('box', { id: 'b', class: cls.value, style: st.value }))
    const b = container.children.find(n => n.id === 'b')!
    st.value = { widht: 20 }; await nextTick()
    cls.value = 'p-2 itms-center'; await nextTick()
    expect(errors.map(String)).toEqual([expect.stringMatching(/\[style\] 未知键 "widht"/), expect.stringMatching(/\[class\] 未知 class "itms-center"/)])
    expect(b.style).toEqual({ padding: 8, width: 10 })
    setStyleLayer(b, 'control', { opacity: 0.5 })
    expect(b.style).toEqual({ padding: 8, width: 10, opacity: 0.5 })
  })
  it('element text replaces the children of a non-text node; disabled sets the state', async () => {
    const label = ref('hi'), off = ref(true)
    const { container } = mount(() => h('box', { id: 'b', disabled: off.value }, label.value))
    const b = container.children.find(n => n.id === 'b')!
    expect(tree(b).children).toEqual([{ type: 'text', value: 'hi' }])
    expect(b.state.disabled).toBe(true); expect(b.props.disabled).toBe(true)
    label.value = ''; off.value = false; await nextTick()
    expect(b.children).toEqual([]); expect(b.state.disabled).toBe(false)
  })
  it('Teleport moves children to a portal by name and to a node object', async () => {
    const target = new Node('box', 'target')
    const C = defineComponent(() => () => h('box', [
      h('portal', { name: 'overlay' }),
      h(Teleport, { to: 'overlay', defer: true }, [h('text', { id: 'in-portal' }, 'a')]),   // the portal is rendered by this component: `defer` (Vue 3.5)
      h(Teleport, { to: target }, [h('text', { id: 'in-target' }, 'b')]),
    ]))
    const { container } = mount(C); await nextTick()
    const portal = container.children[0]!.children.find(n => n.type === 'portal')!
    expect(tree(portal).children!.map(c => c.id)).toEqual(['in-portal'])
    expect(tree(target).children!.map(c => c.id)).toEqual(['in-target'])
  })
  it('Teleport finds a target by #id in a Surface', async () => {
    const root = createFakeRoot(), s = root.createSurface({ width: 100, height: 100 })
    const dest = new Node('box', 'dest'); s.root.appendChild(dest)
    const app = createGlassRenderer({ root }).createApp(() => h(Teleport, { to: '#dest' }, [h('box', { id: 'moved' })]))
    app.mount(new Node('box'))
    expect(dest.children.map(n => n.id)).toContain('moved')
  })
  it('a Teleport target that is not there is an error: the defer hint, and a suggestion among the portals', () => {
    const missing = mount(() => h('box', [h('portal', { name: 'overlay' }), h(Teleport, { to: 'overlay' }, [h('box')])]))   // same pass, no defer
    expect(String(missing.errors[0])).toMatch(/\[Teleport\] 找不到目标 "overlay".*<Teleport defer to="overlay">/)
    const root = createFakeRoot(), s = root.createSurface({ width: 100, height: 100 })
    const portal = new Node('portal'); portal.setProp('name', 'overlay'); s.root.appendChild(portal)
    const app = createGlassRenderer({ root }).createApp(() => h(Teleport, { to: 'overlya' }, [h('box')]))
    const errors: unknown[] = []; app.config.errorHandler = e => { errors.push(e) }
    app.mount(new Node('box'))
    expect(String(errors[0])).toMatch(/\[Teleport\] 找不到目标 "overlya".*允许值：overlay。你可能想要：overlay/)
    expect(String(mount(() => h(Teleport, { to: '#nope' }, [h('box')])).errors[0])).toMatch(/\[Teleport\] 找不到目标 "#nope"/)
  })
  it('removing a focused, pressed node reconciles focus and releases the press (Review Focus 2)', async () => {
    const show = ref(true), clicks: string[] = []
    const { root, container } = mount(() => h('box', show.value ? [h('glass', { id: 'g', tabIndex: 0, style: { width: 40, height: 40 }, onClick: () => clicks.push('g') })] : []))
    const s = root.createSurface({ width: 100, height: 100 })
    s.root.appendChild(container)                         // the app's tree inside a Surface
    root.tick()                                           // laid out: g at 0,0 40×40
    const g = container.children[0]!.children.find(n => n.id === 'g')!
    s.pointer.down(10, 10); s.focus.focusFromPointer(s.pointer.pressed)   // a real press, as the pointer bridge does it
    expect(s.pointer.pressed).toBe(g); expect(g.state.pressed).toBe(true); expect(s.focus.current).toBe(g)
    show.value = false; await nextTick()
    expect(g.parent).toBeNull()
    s.focus.reconcile()
    expect(s.focus.current).toBeNull(); expect(g.state.focused).toBe(false)
    expect(() => root.tick()).not.toThrow()
    s.pointer.up(10, 10)                                  // the press ends on what is under the pointer now
    expect(s.pointer.pressed).toBeNull(); expect(g.state.pressed).toBe(false)
    const stuck: string[] = []; s.root.walk(n => { if (n.state.pressed) stuck.push(n.id) })
    expect(stuck).toEqual([]); expect(clicks).toEqual([])   // no click on a node that left the tree
    expect(() => root.tick()).not.toThrow()
  })
})
