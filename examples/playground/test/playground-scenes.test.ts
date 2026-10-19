import { describe, it, expect, vi } from 'vitest'
import { h, nextTick, ref } from 'vue'
import { absoluteRect, hitTest, type Node } from '@glassui/core'
import { mountGlass, mountInSurface, first } from '../../../packages/vue/test/fixtures/mount'
import { createFakeRoot, flush } from '../../../packages/vue/test/fixtures/fake-root'
import { fire } from '../../../packages/vue/test/fixtures/events'
import SignUpForm from '../src/scenes/SignUpForm.vue'
import SignUp from '../src/scenes/SignUp.vue'
import Both from '../src/scenes/Both.vue'
import Perf from '../src/scenes/Perf.vue'
import Gallery from '../src/gallery/Gallery.vue'

function find(root: Node, id: string): Node {
  let hit: Node | undefined
  root.walk(n => { if (n.id === id) hit = n })
  if (!hit) throw new Error(`missing ${id}`)
  return hit
}
const text = (n: Node): string => String(n.props.value ?? '') + n.children.map(text).join('')
const settle = async (m: ReturnType<typeof mountGlass>) => {
  for (let i = 0; i < 4; i++) { await nextTick(); m.root.tick(); await flush() }
}

describe('Vue playground scenes', () => {
  it('binds real sign-up fields and toggle actions to the submitted payload', async () => {
    const submit = vi.fn()
    const m = mountInSurface(() => h(SignUpForm, { onSubmit: submit }), { motion: 'frozen' })
    for (const [id, value] of [['name', 'Ada'], ['email', 'ada@example.com'], ['password', 'glass-2026']]) {
      fire(find(m.c, id!), 'focus')
      m.root.ime.fromProxy({ value: value!, selectionStart: value!.length, selectionEnd: value!.length, composition: null })
      await nextTick()
    }
    fire(first(find(m.c, 'terms'), 'glass'), 'click')
    fire(first(find(m.c, 'remember'), 'glass'), 'click')
    await nextTick()
    fire(find(m.c, 'submit'), 'click')
    expect(submit.mock.calls[0]?.[0]).toEqual({ name: 'Ada', email: 'ada@example.com', password: 'glass-2026', terms: false, remember: false })
    expect(m.errors).toEqual([])
    m.app.unmount()
  })

  it('keeps the remember ID on an actionable 136 × 62 target and its separate label toggles too', async () => {
    const submit = vi.fn()
    const m = mountInSurface(() => h(SignUpForm, { onSubmit: submit }), { motion: 'frozen' })
    m.surface.setSize(885, 1045); m.root.tick()
    const remember = find(m.c, 'remember'), r = absoluteRect(remember)
    expect(r).toMatchObject({ x: 676, y: 529, width: 136, height: 62 })
    const hit = hitTest(m.c, r.x + r.width / 2, r.y + r.height / 2)!
    m.surface.events.dispatch(hit, 'click', {}); await nextTick()
    fire(find(m.c, 'submit'), 'click'); expect(submit.mock.calls[0]?.[0].remember).toBe(false)
    const label = find(m.c, 'remember-label'), l = absoluteRect(label)
    m.surface.events.dispatch(hitTest(m.c, l.x + l.width / 2, l.y + l.height / 2)!, 'click', {}); await nextTick()
    fire(find(m.c, 'submit'), 'click'); expect(submit.mock.calls[1]?.[0].remember).toBe(true)
    expect(m.errors).toEqual([]); m.app.unmount()
  })

  it('shows reactive field errors and blocks submit while loading', async () => {
    const loading = ref(true), errors = ref({ email: 'Email already registered', password: 'Use 8 characters' }), submit = vi.fn()
    const m = mountInSurface(() => h(SignUpForm, { loading: loading.value, errors: errors.value, onSubmit: submit }), { motion: 'frozen' })
    expect(text(m.c)).toContain('Email already registered')
    expect(text(m.c)).toContain('Use 8 characters')
    fire(find(m.c, 'submit'), 'click'); expect(submit).not.toHaveBeenCalled()
    loading.value = false; errors.value = { email: '', password: '' }; await nextTick()
    expect(text(m.c)).not.toContain('Use 8 characters')
    fire(find(m.c, 'submit'), 'click'); expect(submit).toHaveBeenCalledOnce()
    expect(m.errors).toEqual([])
    m.app.unmount()
  })

  it('preserves the reference panel, IDs and field geometry using components', async () => {
    const m = mountGlass(() => h(SignUp, { viewport: { width: 1280, height: 900 } }), { motion: 'frozen' })
    await settle(m)
    const s = m.root.surfacesMade[0]!
    expect(s.created).toMatchObject({ width: 885, height: 1045, background: 'glass', cornerRadius: 48, layer: 'screen' })
    for (const id of ['name', 'email', 'password', 'terms', 'remember', 'submit', 'apple', 'google', 'close', 'signin']) expect(find(s.root, id)).toBeDefined()
    for (const [id, y] of [['name', 183], ['email', 293], ['password', 403]] as const) expect(absoluteRect(find(s.root, id))).toMatchObject({ x: 52, y, width: 760, height: 84 })
    for (const [id, x, y, width, height] of [['close', 782, 54, 52, 52], ['submit', 52, 633, 760, 84], ['apple', 60, 796, 365, 78], ['google', 440, 796, 365, 78]] as const) expect(absoluteRect(find(s.root, id))).toMatchObject({ x, y, width, height })
    expect(absoluteRect(find(s.root, 'signin').parent!)).toMatchObject({ x: 0, width: 885, y: 937, height: 30 })
    expect(m.errors).toEqual([])
    m.app.unmount()
  })

  it('combines the screen form with the original world card pose and working controls', async () => {
    const m = mountGlass(() => h(Both), { motion: 'frozen' }); await settle(m)
    expect(m.root.surfacesMade).toHaveLength(2)
    const s = m.root.surfacesMade[1]!
    expect(s.created).toMatchObject({ layer: 'world', width: 600, height: 360, background: 'glass' })
    expect(s.restPose.position).toEqual([2.2, 0.15, -2.2])
    fire(first(find(s.root, 'ambient'), 'glass'), 'click'); await nextTick()
    fire(find(s.root, 'continue'), 'click'); await nextTick()
    expect(text(s.root)).toContain('Continued')
    expect(m.errors).toEqual([]); m.app.unmount()
  })

  it('fits 100 variant buttons and 20 fused three-button toolbars inside 1280 × 900', async () => {
    const m = mountGlass(() => h(Perf), { motion: 'frozen' }); await settle(m)
    const s = m.root.surfacesMade[0]!
    for (let i = 0; i < 100; i++) {
      const r = absoluteRect(find(s.root, `perf-button-${i}`))
      expect(r.x).toBeGreaterThanOrEqual(0); expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.width).toBeLessThanOrEqual(1280); expect(r.y + r.height).toBeLessThanOrEqual(900)
    }
    for (let i = 0; i < 20; i++) {
      const toolbar = find(s.root, `perf-toolbar-${i}`)
      expect(toolbar.children.filter(n => n.type === 'glass')).toHaveLength(3)
      const r = absoluteRect(toolbar)
      expect(r.x + r.width).toBeLessThanOrEqual(1280); expect(r.y + r.height).toBeLessThanOrEqual(900)
    }
    expect(m.errors).toEqual([]); m.app.unmount()
  })

  it('makes six fixed gallery Blocks, honors initial focus and navigates with visible controls', async () => {
    const warn = vi.spyOn(console, 'warn')
    const m = mountGlass(() => h(Gallery, { initialFocus: 'inputs' }), { motion: 'frozen', root: createFakeRoot({ scheme: 'dark' }) }); await settle(m)
    const ids = ['primitives', 'buttons', 'toggles', 'inputs', 'dialog', 'containers']
    expect(m.root.surfacesMade).toHaveLength(6)
    expect(m.root.surfacesMade.every(s => s.created.background === 'glass')).toBe(true)
    const inputs = m.root.surfacesMade.find(s => { let yes = false; s.root.walk(n => { if (n.id === 'inputs') yes = true }); return yes })!
    expect(m.root.rigs[0]!.focus.mock.lastCall![0]).toBe(inputs)
    for (const id of ids) expect(m.root.surfacesMade.some(s => { let yes = false; s.root.walk(n => { if (n.id === id) yes = true }); return yes })).toBe(true)
    fire(find(inputs.root, 'gallery-inputs-to-dialog'), 'click'); await settle(m)
    const dialog = m.root.surfacesMade.find(s => { let yes = false; s.root.walk(n => { if (n.id === 'dialog') yes = true }); return yes })!
    expect(m.root.rigs[0]!.focus.mock.lastCall![0]).toBe(dialog)
    fire(find(dialog.root, 'open-dialog'), 'click'); await settle(m)
    expect(m.root.surfaces.length).toBeGreaterThan(6)
    expect(m.errors).toEqual([]); expect(warn).not.toHaveBeenCalled()
    m.app.unmount(); warn.mockRestore()
  })
})
