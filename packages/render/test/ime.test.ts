import { describe, it, expect, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { Node } from '@glassui/core'
import { Object3D, PerspectiveCamera, Scene, Vector2, Vector3 } from 'three'
import { ImeBridge, type ImeField, type ImeState, type TextareaLike } from '../src/ime'
import { createUIRoot, type UIRenderer, type UIRoot } from '../src/root'
import type { Surface } from '../src/surface/surface'

type Listener = (e: any) => void
/** A listener table with `fire`, as a DOM `EventTarget` has (`listening` counts what is attached). */
function listenable() {
  const listeners = new Map<string, Set<Listener>>()
  return {
    listeners,
    addEventListener(t: string, fn: Listener) { let s = listeners.get(t); if (!s) listeners.set(t, s = new Set()); s.add(fn) },
    removeEventListener(t: string, fn: Listener) { listeners.get(t)?.delete(fn) },
    fire(t: string, e: unknown) { for (const fn of [...listeners.get(t) ?? []]) fn(e) },
    listening: (t: string) => listeners.get(t)?.size ?? 0,
  }
}

interface FakeArea extends TextareaLike {
  tag: string; attrs: Record<string, string>; style: Record<string, string>
  fire(type: string, e: unknown): void; listening(type: string): number
}
/** A proxy element: a value, a selection, attributes, style, events; `focus`/`blur` move the doc's `activeElement`. */
function fakeArea(tag: string, doc: { activeElement: unknown }): FakeArea {
  const ev = listenable()
  const t: FakeArea = {
    tag, value: '', selectionStart: 0, selectionEnd: 0, style: {}, attrs: {},
    setAttribute(k, v) { t.attrs[k] = v },
    addEventListener: ev.addEventListener, removeEventListener: ev.removeEventListener, fire: ev.fire, listening: ev.listening,
    focus() { doc.activeElement = t },
    blur() { if (doc.activeElement === t) { doc.activeElement = null; t.fire('blur', {}) } },
    setSelectionRange(a, b) { t.selectionStart = a; t.selectionEnd = b },
  }
  return t
}
function fakeDoc() {
  const doc = {
    created: [] as FakeArea[], activeElement: null as unknown, listeners: new Map<string, () => void>(),
    createElement(tag: string) { const t = fakeArea(tag, doc); doc.created.push(t); return t },
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
    addEventListener(t: string, fn: () => void) { doc.listeners.set(t, fn) }, removeEventListener(t: string) { doc.listeners.delete(t) },
  }
  return doc
}
function setup(opts: { kind?: ImeField['kind']; screenFromPoint?: UIRoot['screenFromPoint'] } = {}) {
  const doc = fakeDoc(), canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), focus: vi.fn(), ...listenable() }
  const viewport = listenable(), pointer = { setActive: vi.fn() }
  const changes: ImeState[] = [], keys: string[] = [], surfaceKeys: string[] = [], blurs: number[] = []
  const surface = { focus: { key: (k: string) => surfaceKeys.push(k) } } as unknown as Surface
  const field: ImeField = {
    surface, value: 'abc', selectionStart: 1, selectionEnd: 2, kind: opts.kind ?? 'text',
    caret: () => ({ x: 10, y: 20, height: 24 }),
    onChange: s => changes.push(s), onKey: e => { keys.push(e.key); return e.key === 'Enter' }, onBlur: () => blurs.push(1),
  }
  const bridge = new ImeBridge({ canvas, doc, viewport, pointer, screenFromPoint: opts.screenFromPoint ?? ((_s, x, y) => ({ x: x + 100, y: y + 50 })) })
  return { bridge, doc, field, changes, keys, surfaceKeys, blurs, canvas, viewport, pointer, surface }
}

describe('ImeBridge', () => {
  it('focus copies the field into the proxy, places it at the projected caret, and focuses it', () => {
    const { bridge, doc, field } = setup()                    // screenFromPoint: (s, x, y) => ({ x: x + 100, y: y + 50 })
    bridge.focus(field)
    const ta = doc.created[0]!
    expect(ta.value).toBe('abc'); expect([ta.selectionStart, ta.selectionEnd]).toEqual([1, 2])
    expect(ta.style.left).toBe('110px'); expect(ta.style.top).toBe('70px'); expect(ta.style.fontSize).toBe('24px')
    expect(doc.activeElement).toBe(ta)
  })
  it('edits flow back through onChange; composition reports its range', () => {
    const { bridge, doc, field, changes } = setup(); bridge.focus(field); const ta = doc.created[0]!
    ta.value = 'abXc'; ta.selectionStart = ta.selectionEnd = 3; ta.fire('input', {})
    ta.fire('compositionstart', {}); ta.value = 'abXnic'; ta.selectionStart = ta.selectionEnd = 5; ta.fire('compositionupdate', { data: 'ni' })
    ta.value = 'abX你c'; ta.selectionStart = ta.selectionEnd = 4; ta.fire('compositionend', { data: '你' })
    expect(changes).toEqual([
      { value: 'abXc', selectionStart: 3, selectionEnd: 3, composition: null },
      { value: 'abXnic', selectionStart: 5, selectionEnd: 5, composition: { start: 3, end: 5 } },
      { value: 'abX你c', selectionStart: 4, selectionEnd: 4, composition: null },
    ])
  })
  it('Tab moves focus in the Surface; Enter goes to the field; keys are not stolen while composing', () => {
    const { bridge, doc, field, keys, surfaceKeys } = setup(); bridge.focus(field); const ta = doc.created[0]!
    const tab = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() }; ta.fire('keydown', tab)
    expect(surfaceKeys).toEqual(['Tab']); expect(tab.preventDefault).toHaveBeenCalled()
    ta.fire('compositionstart', {}); ta.fire('keydown', { key: 'Enter', preventDefault: vi.fn() })
    expect(keys).toEqual([])
    ta.fire('compositionend', { data: '' }); const enter = { key: 'Enter', preventDefault: vi.fn() }; ta.fire('keydown', enter)
    expect(keys).toEqual(['Enter']); expect(enter.preventDefault).toHaveBeenCalled()
  })
  it('blur from outside calls onBlur; ImeBridge.blur does not, and hands focus back to the canvas', () => {
    const a = setup(); a.bridge.focus(a.field)
    a.doc.created[0]!.blur()                                     // the user clicked another page element
    expect(a.blurs).toEqual([1]); expect(a.bridge.active).toBeNull()
    const b = setup(); b.bridge.focus(b.field)
    b.bridge.blur(b.field)
    expect(b.blurs).toEqual([]); expect(b.canvas.focus).toHaveBeenCalled(); expect(b.bridge.active).toBeNull()
  })
  it('a world caret projects through the tilt (Review Focus 3)', () => {
    const camera = new PerspectiveCamera(50, 800 / 600, 0.1, 100); camera.position.set(0, 0, 5); camera.updateMatrixWorld()
    const plane = new Object3D(); plane.rotation.y = 0.5; plane.updateMatrixWorld()
    // a Surface stand-in: 400 × 300 pt at 244 pt per unit, its content plane = plane's local z = 0
    const toWorld = (x: number, y: number) => plane.localToWorld(new Vector3((x - 200) / 244, (150 - y) / 244, 0))
    const project = (_s: unknown, x: number, y: number) => { const p = toWorld(x, y).project(camera); return { x: (p.x + 1) / 2 * 800, y: (1 - p.y) / 2 * 600 } }
    const { bridge, doc, field } = setup({ screenFromPoint: project as never })
    bridge.focus(field)
    const want = project(null, 10, 20)
    expect(parseFloat(doc.created[0]!.style.left!)).toBeCloseTo(want.x, 0)
    expect(parseFloat(doc.created[0]!.style.top!)).toBeCloseTo(want.y, 0)
  })
  it('a password field uses an input of type password; a number field asks for the decimal keypad', () => {
    const p = setup({ kind: 'password' }); p.bridge.focus(p.field)
    expect(p.doc.created[0]!.tag).toBe('input'); expect(p.doc.created[0]!.attrs.type).toBe('password')
    const n = setup({ kind: 'number' }); n.bridge.focus(n.field)
    expect(n.doc.created[0]!.attrs.inputmode).toBe('decimal')
  })

  it('styles the proxy as spec §7.3 has it: invisible, fixed, out of the Tab order, no autocorrection', () => {
    const { bridge, doc, field } = setup(); bridge.focus(field)
    const ta = doc.created[0]!
    expect(ta.tag).toBe('textarea'); expect(doc.body.appendChild).toHaveBeenCalledWith(ta)
    expect(ta.style).toMatchObject({
      position: 'fixed', opacity: '0.01', caretColor: 'transparent', color: 'transparent', background: 'transparent', border: '0', outline: 'none',
      resize: 'none', overflow: 'hidden', whiteSpace: 'pre', padding: '0', margin: '0', width: '2px', height: '24px', fontSize: '24px', lineHeight: '1',
      zIndex: '2147483647', pointerEvents: 'none',
    })
    expect(ta.attrs).toMatchObject({ autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-hidden': 'true', enterkeyhint: 'done', tabindex: '-1', inputmode: 'text' })
  })
  it('the caret height is the projected distance between its top and bottom', () => {
    const { bridge, doc, field } = setup({ screenFromPoint: (_s, x, y) => ({ x: x * 0.5 + 100, y: y * 0.5 + 50 }) })   // half-size, as a far Surface
    bridge.focus(field)
    expect(doc.created[0]!.style).toMatchObject({ left: '105px', top: '60px', height: '12px', fontSize: '12px' })
  })
  it('the proxy sits at the caret in the page: the canvas offset is added', () => {
    const { bridge, doc, field, canvas } = setup()
    canvas.getBoundingClientRect = () => ({ left: 40, top: 30, width: 800, height: 600 })
    bridge.focus(field)
    expect(doc.created[0]!.style).toMatchObject({ left: '150px', top: '100px' })
  })
  it('a caret that cannot be projected (behind the camera) leaves the proxy where it was, and its height at the last good one', () => {
    let behind: 'none' | 'top' | 'bottom' = 'none', dx = 100
    const { bridge, doc, field } = setup({ screenFromPoint: (_s, x, y) => behind === 'top' && y === 20 ? null : behind === 'bottom' && y === 44 ? null : { x: x + dx, y: y + 50 } })
    bridge.focus(field); const ta = doc.created[0]!
    behind = 'top'; dx = 300; expect(() => bridge.reposition()).not.toThrow()
    expect(ta.style).toMatchObject({ left: '110px', top: '70px', height: '24px', fontSize: '24px' })
    behind = 'bottom'; bridge.reposition()                      // the top projects, the bottom does not
    expect(ta.style).toMatchObject({ left: '310px', top: '70px', height: '24px', fontSize: '24px' })
    // the first focus, with nothing projected yet: the caret's own height, in pt
    const b = setup({ screenFromPoint: (_s, _x, y) => y === 44 ? null : { x: 0, y: 0 } }); b.bridge.focus(b.field)
    expect(b.doc.created[0]!.style.height).toBe('24px')
  })
  it('reposition follows a caret on a moving Surface (the root calls it every tick)', () => {
    let dx = 100
    const { bridge, doc, field } = setup({ screenFromPoint: (_s, x, y) => ({ x: x + dx, y: y + 50 }) })
    bridge.focus(field)
    dx = 140; bridge.reposition()
    expect(doc.created[0]!.style.left).toBe('150px')
    field.caret = () => ({ x: 30, y: 20, height: 24 }); bridge.reposition()
    expect(doc.created[0]!.style.left).toBe('170px')
  })
  it('visualViewport resize and scroll re-place the proxy (a soft keyboard moves the canvas)', () => {
    const { bridge, doc, field, canvas, viewport } = setup(); bridge.focus(field)
    canvas.getBoundingClientRect = () => ({ left: 0, top: -120, width: 800, height: 600 })
    viewport.fire('resize', {}); expect(doc.created[0]!.style.top).toBe('-50px')
    canvas.getBoundingClientRect = () => ({ left: 0, top: -200, width: 800, height: 600 })
    viewport.fire('scroll', {}); expect(doc.created[0]!.style.top).toBe('-130px')
  })
  it('select, keyup and the document selectionchange report the selection; selectionchange only while the proxy has focus', () => {
    const { bridge, doc, field, changes } = setup(); bridge.focus(field); const ta = doc.created[0]!
    ta.selectionStart = 0; ta.selectionEnd = 3; ta.fire('select', {})
    ta.selectionStart = ta.selectionEnd = 2; ta.fire('keyup', { key: 'ArrowLeft' })
    ta.selectionStart = ta.selectionEnd = 1; doc.listeners.get('selectionchange')!()
    expect(changes.map(c => [c.selectionStart, c.selectionEnd])).toEqual([[0, 3], [2, 2], [1, 1]])
    doc.activeElement = null; doc.listeners.get('selectionchange')!()   // a selection elsewhere in the page
    expect(changes).toHaveLength(3)
  })
  it('during a composition every report carries its range (input and keyup do not drop it), clamped to the value', () => {
    const { bridge, doc, field, changes } = setup(); bridge.focus(field); const ta = doc.created[0]!
    ta.selectionStart = ta.selectionEnd = 3; ta.fire('compositionstart', {})
    ta.fire('compositionupdate', { data: 'n' })                 // before the DOM update: the value is still 'abc'
    ta.value = 'abcn'; ta.selectionStart = ta.selectionEnd = 4; ta.fire('input', {}); ta.fire('keyup', { key: 'n' })
    expect(changes.map(c => c.composition)).toEqual([{ start: 3, end: 3 }, { start: 3, end: 4 }, { start: 3, end: 4 }])
    expect(changes[1]).toMatchObject({ value: 'abcn', selectionStart: 4 })
  })
  it('keys the IME owns (isComposing, keyCode 229: Safari commits with Enter after compositionend) never reach the field', () => {
    const { bridge, doc, field, keys, surfaceKeys } = setup(); bridge.focus(field); const ta = doc.created[0]!
    const commit = { key: 'Enter', keyCode: 229, preventDefault: vi.fn() }; ta.fire('keydown', commit)
    const composing = { key: 'Tab', isComposing: true, preventDefault: vi.fn() }; ta.fire('keydown', composing)
    expect(keys).toEqual([]); expect(surfaceKeys).toEqual([])
    expect(commit.preventDefault).not.toHaveBeenCalled(); expect(composing.preventDefault).not.toHaveBeenCalled()
    const shiftTab = { key: 'Tab', shiftKey: true, preventDefault: vi.fn() }; ta.fire('keydown', shiftTab)
    expect(surfaceKeys).toEqual(['Shift+Tab'])
    const a = { key: 'a', preventDefault: vi.fn() }; ta.fire('keydown', a)   // not handled: typing goes on in the proxy
    expect(keys).toEqual(['a']); expect(a.preventDefault).not.toHaveBeenCalled()
  })
  it('onKey sees the modifiers as booleans', () => {
    const { bridge, doc, field } = setup(); const seen: unknown[] = []
    field.onKey = e => { seen.push(e); return false }
    bridge.focus(field); doc.created[0]!.fire('keydown', { key: 'z', metaKey: true, preventDefault: vi.fn() })
    expect(seen).toEqual([{ key: 'z', shiftKey: false, ctrlKey: false, metaKey: true, altKey: false }])
  })
  it('sync pushes the field to the proxy, but not during a composition, and not for another field', () => {
    const { bridge, doc, field } = setup(); bridge.focus(field); const ta = doc.created[0]!
    field.value = 'hello'; field.selectionStart = 2; field.selectionEnd = 4; bridge.sync(field)
    expect(ta.value).toBe('hello'); expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 4])
    ta.fire('compositionstart', {}); field.value = 'x'; bridge.sync(field)
    expect(ta.value).toBe('hello')
    ta.fire('compositionend', { data: '' })
    const other: ImeField = { ...field, value: 'other' }; bridge.sync(other)
    expect(ta.value).toBe('hello')
  })
  it('focusing the active field again re-copies it, except mid-composition (the IME keeps its text)', () => {
    const { bridge, doc, field, changes } = setup(); bridge.focus(field); const ta = doc.created[0]!
    ta.value = 'zz'; bridge.focus(field)
    expect(ta.value).toBe('abc')
    ta.selectionStart = ta.selectionEnd = 3; ta.fire('compositionstart', {}); ta.value = 'abcn'; ta.fire('compositionupdate', { data: 'n' })
    bridge.focus(field)
    expect(ta.value).toBe('abcn'); ta.fire('input', {})
    expect(changes.at(-1)!.composition).toEqual({ start: 3, end: 4 })
  })
  it('a window or tab switch keeps the field: the page still holds the proxy focused (I1)', () => {
    const { bridge, doc, field, blurs, changes } = setup(); bridge.focus(field); const ta = doc.created[0]!
    ta.value = 'abcd'; ta.fire('blur', {})                      // the window lost focus; activeElement is still the proxy
    expect(blurs).toEqual([]); expect(bridge.active).toBe(field); expect(ta.value).toBe('abcd')
    ta.selectionStart = ta.selectionEnd = 4; ta.fire('input', {})   // back in the window: typing goes on to the field
    expect(changes.at(-1)).toMatchObject({ value: 'abcd', selectionStart: 4 })
    ta.blur()                                                     // focus moved to another page element: that is leaving
    expect(blurs).toEqual([1]); expect(bridge.active).toBeNull()
  })
  it('a kind change on the same field mid-composition makes a fresh proxy that carries the field (M1)', () => {
    const { bridge, doc, field, keys } = setup(); bridge.focus(field); const ta = doc.created[0]!
    ta.selectionStart = ta.selectionEnd = 3; ta.fire('compositionstart', {}); ta.value = 'abcn'; ta.fire('compositionupdate', { data: 'n' })
    field.kind = 'password'; field.value = 'abcn'; field.selectionStart = field.selectionEnd = 4
    bridge.focus(field)
    const input = doc.created[1]!
    expect(input.tag).toBe('input'); expect(input.value).toBe('abcn'); expect([input.selectionStart, input.selectionEnd]).toEqual([4, 4])
    field.value = 'abcnx'; bridge.sync(field); expect(input.value).toBe('abcnx')   // not stuck composing
    const enter = { key: 'Enter', preventDefault: vi.fn() }; input.fire('keydown', enter)
    expect(keys).toEqual(['Enter'])
  })
  it('the last good caret height belongs to its field: another field starts from its own (M2)', () => {
    let bottomNull = false
    const { bridge, doc, field } = setup({ screenFromPoint: (_s, x, y) => bottomNull && y !== 20 ? null : { x: x * 0.5, y: y * 0.5 } })
    bridge.focus(field)
    expect(doc.created[0]!.style.height).toBe('12px')             // field: 24 pt, projected at half size
    const other: ImeField = { ...field, caret: () => ({ x: 10, y: 20, height: 30 }) }
    bottomNull = true; bridge.focus(other)
    expect(doc.created[0]!.style.height).toBe('30px')             // not the first field's 12
  })
  it('a blur that interrupts a composition reports its end first: the field never keeps a stale range (M3)', () => {
    const log: string[] = []
    const { bridge, doc, field, changes } = setup(); field.onBlur = () => log.push('blur')
    const push = field.onChange; field.onChange = s => { log.push(`change:${s.composition ? 'composing' : 'done'}`); push(s) }
    bridge.focus(field); const ta = doc.created[0]!
    ta.selectionStart = ta.selectionEnd = 3; ta.fire('compositionstart', {}); ta.value = 'abcni'; ta.selectionStart = ta.selectionEnd = 5; ta.fire('compositionupdate', { data: 'ni' })
    bridge.blur(field)
    expect(changes.at(-1)).toEqual({ value: 'abcni', selectionStart: 5, selectionEnd: 5, composition: null })
    // an outside blur mid-composition: the final report, then onBlur
    bridge.focus(field); log.length = 0
    ta.selectionStart = ta.selectionEnd = 3; ta.fire('compositionstart', {}); ta.value = 'abcn'; ta.selectionStart = ta.selectionEnd = 4; ta.fire('compositionupdate', { data: 'n' })
    ta.blur()
    expect(log).toEqual(['change:composing', 'change:done', 'blur'])
    // switching to another field mid-composition: the one left behind hears it end too
    const second: ImeField = { ...field, onChange: vi.fn() }
    bridge.focus(field); ta.fire('compositionstart', {}); ta.fire('compositionupdate', { data: 'x' }); log.length = 0
    bridge.focus(second)
    expect(log).toEqual(['change:done']); expect(second.onChange).not.toHaveBeenCalled()
  })
  it('events after blur belong to no field; blur of a field that is not active is a no-op; blur clears the proxy', () => {
    const { bridge, doc, field, changes, canvas } = setup(); bridge.focus(field); const ta = doc.created[0]!
    const other: ImeField = { ...field }; bridge.blur(other)
    expect(bridge.active).toBe(field); expect(canvas.focus).not.toHaveBeenCalled()
    bridge.blur(field)
    expect(ta.value).toBe('')                                      // nothing the user typed stays in the page
    ta.fire('input', {}); ta.fire('compositionend', { data: 'x' }); ta.fire('keydown', { key: 'Enter', preventDefault: vi.fn() })
    expect(changes).toEqual([])
  })
  it('a blur while the proxy does not hold the page focus does not take it for the canvas', () => {
    const { bridge, doc, field, canvas } = setup(); bridge.focus(field)
    doc.activeElement = { other: true }                          // focus already moved on (another page element has it)
    bridge.blur(field)
    expect(canvas.focus).not.toHaveBeenCalled(); expect(doc.activeElement).toEqual({ other: true })
  })
  it('a press on the canvas keeps the page focus on the proxy while a field is active (mousedown would focus the canvas)', () => {
    const { bridge, field, canvas } = setup()
    const before = { preventDefault: vi.fn() }; canvas.fire('mousedown', before)
    expect(before.preventDefault).not.toHaveBeenCalled()          // nothing being edited: the canvas takes focus and keys
    bridge.focus(field)
    const during = { preventDefault: vi.fn() }; canvas.fire('mousedown', during)
    expect(during.preventDefault).toHaveBeenCalled()
    bridge.blur(field)
    const after = { preventDefault: vi.fn() }; canvas.fire('mousedown', after)
    expect(after.preventDefault).not.toHaveBeenCalled()
  })
  it('focus makes the field\'s Surface the one that takes keys (PointerBridge.setActive)', () => {
    const { bridge, field, pointer, surface } = setup(); bridge.focus(field)
    expect(pointer.setActive).toHaveBeenLastCalledWith(surface)
  })
  it('focusing another field moves the proxy to it; a different kind swaps the element', () => {
    const { bridge, doc, field, changes } = setup(); bridge.focus(field)
    const ta = doc.created[0]!
    const second: ImeField = { ...field, value: 'second', selectionStart: 6, selectionEnd: 6, onChange: vi.fn() }
    bridge.focus(second)
    expect(doc.created).toHaveLength(1); expect(ta.value).toBe('second'); expect(bridge.active).toBe(second)
    const pw: ImeField = { ...field, kind: 'password', value: 'pw', onChange: vi.fn() }
    bridge.focus(pw)
    const input = doc.created[1]!
    expect(input.tag).toBe('input'); expect(doc.body.removeChild).toHaveBeenCalledWith(ta); expect(ta.listening('input')).toBe(0)
    expect(input.value).toBe('pw'); expect(doc.activeElement).toBe(input)
    ta.fire('input', {}); expect(changes).toEqual([])
    const num: ImeField = { ...field, kind: 'number', onChange: vi.fn() }
    bridge.focus(num)
    expect(doc.created[2]!.attrs.inputmode).toBe('decimal')
    bridge.focus(field)                                           // the same textarea serves text and number fields
    expect(doc.created).toHaveLength(3); expect(doc.created[2]!.attrs.inputmode).toBe('text')
  })
  it('a final report that throws finds the bridge done: the field let go, the proxy cleared, onBlur still called (N2)', () => {
    const boom = new Error('boom')
    /** `s`'s field mid-composition, its final report (composition: null) throwing after running `check`. */
    const composing = (s: ReturnType<typeof setup>, check: () => void) => {
      s.bridge.focus(s.field); const ta = s.doc.created[0]!
      ta.fire('compositionstart', {}); ta.value = 'abcn'; ta.fire('compositionupdate', { data: 'n' })
      s.field.onChange = st => { if (!st.composition) { check(); throw boom } }
      return ta
    }
    // ImeBridge.blur: the report comes once the field is let go and the canvas has the page focus back
    const a = setup(), ta = composing(a, () => { expect(a.bridge.active).toBeNull(); expect(a.canvas.focus).toHaveBeenCalled() })
    expect(() => a.bridge.blur(a.field)).toThrow(boom)
    expect(a.bridge.active).toBeNull(); expect(ta.value).toBe('')
    // an outside blur: the report, then onBlur even though the report threw
    const b = setup(), tb = composing(b, () => { expect(b.bridge.active).toBeNull() })
    expect(() => tb.blur()).toThrow(boom)
    expect(b.blurs).toEqual([1]); expect(b.bridge.active).toBeNull()
    // another field takes over: it is active, its value in the focused proxy, before the old one hears its end
    const c = setup(), second: ImeField = { ...c.field, value: 'second', selectionStart: 6, selectionEnd: 6, onChange: vi.fn() }
    const tc = composing(c, () => { expect(c.bridge.active).toBe(second) })
    expect(() => c.bridge.focus(second)).toThrow(boom)
    expect(c.bridge.active).toBe(second); expect(tc.value).toBe('second'); expect(c.doc.activeElement).toBe(tc)
    tc.value = 'secondx'; tc.fire('input', {}); expect(second.onChange).toHaveBeenCalledTimes(1)   // not stuck composing
    expect(vi.mocked(second.onChange).mock.calls[0]![0].composition).toBeNull()
  })
  it('page code that moved the focus while the window was in the background: the next reposition lets the field go (N3)', () => {
    const { bridge, doc, field, blurs, changes } = setup()
    let hasFocus = true
    const d = Object.assign(doc, { hasFocus: () => hasFocus })
    bridge.focus(field); const ta = d.created[0]!
    bridge.reposition()                                          // the proxy holds the page focus: nothing to decide
    expect(bridge.active).toBe(field)
    ta.fire('compositionstart', {}); ta.value = 'abcn'; ta.fire('compositionupdate', { data: 'n' })
    hasFocus = false; ta.fire('blur', {})                        // the window lost focus: the proxy is still the activeElement
    d.activeElement = { other: true }                            // page code focused another element meanwhile: no second blur comes
    bridge.reposition()                                          // still in the background: the page has not settled where focus is
    expect(bridge.active).toBe(field); expect(blurs).toEqual([])
    hasFocus = true; bridge.reposition()                         // back in the window, and the proxy is not focused: that is leaving
    expect(bridge.active).toBeNull(); expect(blurs).toEqual([1])
    expect(changes.at(-1)).toMatchObject({ value: 'abcn', composition: null })
    expect(ta.value).toBe('')
  })
  it('focus places the proxy while another element still has the page focus, and does not take that for leaving (N3)', () => {
    const { bridge, doc, field, blurs } = setup()
    const d = Object.assign(doc, { hasFocus: () => true }); d.activeElement = { other: true }
    bridge.focus(field)
    expect(bridge.active).toBe(field); expect(blurs).toEqual([])
    expect(d.activeElement).toBe(d.created[0]); expect(d.created[0]!.style.left).toBe('110px')
  })

  it('dispose removes the proxy and every listener it added (document, viewport, canvas)', () => {
    const { bridge, doc, field, canvas, viewport } = setup(); bridge.focus(field)
    const ta = doc.created[0]!
    expect(doc.listeners.has('selectionchange')).toBe(true); expect(viewport.listening('resize') + viewport.listening('scroll')).toBe(2); expect(canvas.listening('mousedown')).toBe(1)
    bridge.dispose()
    expect(doc.listeners.size).toBe(0); expect(viewport.listening('resize') + viewport.listening('scroll')).toBe(0); expect(canvas.listening('mousedown')).toBe(0)
    expect(doc.body.removeChild).toHaveBeenCalledWith(ta); expect(ta.listening('input') + ta.listening('keydown') + ta.listening('blur')).toBe(0)
    expect(bridge.active).toBeNull(); expect(ta.value).toBe('')
    bridge.focus(field)                                           // a disposed bridge does nothing
    expect(doc.created).toHaveLength(1); expect(bridge.active).toBeNull()
  })
})

/** A renderer stub (as root.test.ts's) whose canvas can take focus. */
function stubRenderer() {
  return {
    domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), addEventListener: vi.fn(), removeEventListener: vi.fn(), tabIndex: -1, focus: vi.fn(), style: { touchAction: 'auto' } },
    getSize: (t: Vector2) => t.set(800, 600), getPixelRatio: () => 1,
    shadowMap: { enabled: false, type: 0 } as UIRenderer['shadowMap'], autoClear: true,
    setRenderTarget: vi.fn(), render: vi.fn(), setClearColor: vi.fn(), getClearColor: vi.fn(c => c), getClearAlpha: () => 1,
    init: async () => {}, setAnimationLoop: vi.fn(), backend: { isWebGPUBackend: true },
  } satisfies UIRenderer
}
async function rootWithIme(ime = true) {
  const doc = fakeDoc(), renderer = stubRenderer(), camera = new PerspectiveCamera(50, 800 / 600, 0.1, 100)
  const root = await createUIRoot({
    renderer, scene: new Scene(), camera, environment: null, quality: 'minimal', createCanvas: ((w: number, h: number) => createCanvas(w, h)) as never,
    ...(ime ? { ime: { doc } } : {}),
  })
  return { root, doc, renderer, camera }
}
/** A field on `surface` whose caret is at (x, y) pt, 20 pt tall. */
function fieldOn(surface: Surface, x = 10, y = 20): ImeField & { blurs: number } {
  const f = { surface, value: '', selectionStart: 0, selectionEnd: 0, kind: 'text' as const, blurs: 0, caret: () => ({ x, y, height: 20 }), onChange() {}, onKey: () => false, onBlur() { f.blurs++ } }
  return f
}

describe('UIRoot.ime', () => {
  it('is null under Node without a document, and one lazily made bridge with ime: { doc }', async () => {
    const plain = (await rootWithIme(false)).root
    expect(plain.ime).toBeNull()
    const { root, doc } = await rootWithIme()
    expect(doc.listeners.size).toBe(0)                           // nothing made before the first access
    const ime = root.ime
    expect(ime).toBeInstanceOf(ImeBridge); expect(root.ime).toBe(ime)
    plain.dispose(); root.dispose()
  })
  it('tick re-places the proxy at the caret of a Surface that moves between ticks', async () => {
    const { root, doc } = await rootWithIme()
    const s = root.createSurface({ layer: 'world', width: 488, height: 244 }); s.position.set(0, 0, -5)
    root.tick(0)
    const ime = root.ime!; ime.focus(fieldOn(s))
    const ta = doc.created[0]!
    const at = (): [number, number] => { const p = root.screenFromPoint(s, 10, 20)!; return [p.x, p.y] }
    const before = at()
    expect(parseFloat(ta.style.left!)).toBeCloseTo(before[0], 6); expect(parseFloat(ta.style.top!)).toBeCloseTo(before[1], 6)
    s.position.set(0.6, -0.3, -4); root.tick(0)                 // no focus, sync or caret move: the tick alone re-places it
    const [x, y] = at()
    expect(Math.abs(x - before[0])).toBeGreaterThan(50); expect(Math.abs(y - before[1])).toBeGreaterThan(20)
    expect(parseFloat(ta.style.left!)).toBeCloseTo(x, 6); expect(parseFloat(ta.style.top!)).toBeCloseTo(y, 6)
    root.dispose()
  })
  it('removing the field\'s Surface blurs it; another Surface\'s removal does not', async () => {
    const { root, renderer } = await rootWithIme()
    const a = root.createSurface({ width: 200, height: 100 }), b = root.createSurface({ width: 200, height: 100, left: 300 })
    root.tick(0)
    const f = fieldOn(a); root.ime!.focus(f)
    root.removeSurface(b); expect(root.ime!.active).toBe(f)
    root.removeSurface(a)
    expect(root.ime!.active).toBeNull(); expect(f.blurs).toBe(0); expect(renderer.domElement.focus).toHaveBeenCalled()
    expect(() => root.tick(0)).not.toThrow()
    root.dispose()
  })
  it('a Surface disposed directly blurs its field too', async () => {
    const { root } = await rootWithIme()
    const a = root.createSurface({ width: 200, height: 100 }); root.tick(0)
    const f = fieldOn(a); root.ime!.focus(f)
    a.dispose()
    expect(root.ime!.active).toBeNull()
    root.dispose()
  })
  it('the proxy taking the page focus leaves the Surface\'s focus alone; after blur the canvas keys go on (Tab moves)', async () => {
    const { root, doc, renderer } = await rootWithIme()
    const s = root.createSurface({ width: 400, height: 200 })
    const one = new Node('glass', 'one'), two = new Node('glass', 'two')
    for (const [i, n] of [one, two].entries()) { n.setStyle({ position: 'absolute', left: 10 + i * 150, top: 10, width: 100, height: 40 }); n.setProp('tabIndex', 0); s.root.appendChild(n) }
    root.tick(0)
    s.focus.focus(one)
    const f = fieldOn(s); root.ime!.focus(f)
    expect(doc.activeElement).toBe(doc.created[0]); expect(s.focus.current).toBe(one); expect(root.pointer!.active).toBe(s)
    root.ime!.blur(f)
    expect(renderer.domElement.focus).toHaveBeenCalledWith({ preventScroll: true })
    root.pointer!.handle('keydown', { key: 'Tab', preventDefault: vi.fn() })
    expect(s.focus.current).toBe(two)
    root.dispose()
  })
  it('a caret that throws in tick is reported and its field blurred; the tick still ends (afterTick resolves) (M4)', async () => {
    const { root, renderer } = await rootWithIme()
    const s = root.createSurface({ width: 200, height: 100 }); root.tick(0)
    const f = fieldOn(s); root.ime!.focus(f)
    const boom = new Error('stale node'); f.caret = () => { throw boom }
    const errors: { surface: Surface | null; error: Error }[] = []; root.on('error', e => errors.push(e))
    let settled = false; void root.afterTick().then(() => { settled = true })
    expect(() => root.tick(0)).not.toThrow()
    await Promise.resolve()
    expect(settled).toBe(true)
    expect(errors).toEqual([{ surface: s, error: boom }])
    expect(root.ime!.active).toBeNull(); expect(f.blurs).toBe(0); expect(renderer.domElement.focus).toHaveBeenCalled()
    expect(() => root.tick(0)).not.toThrow(); expect(errors).toHaveLength(1)
    root.dispose()
  })
  it('an error listener that disposes the root while tick reports a throwing caret: the tick still ends (N1)', async () => {
    const { root } = await rootWithIme()
    const s = root.createSurface({ width: 200, height: 100 }); root.tick(0)
    const f = fieldOn(s); root.ime!.focus(f)
    f.caret = () => { throw new Error('stale node') }
    root.on('error', () => root.dispose())
    expect(() => root.tick(0)).not.toThrow()
    expect(root.ime).toBeNull(); expect(f.blurs).toBe(0)
  })
  it('dispose disposes the bridge (its listeners and proxy go) and ime is null after it', async () => {
    const { root, doc } = await rootWithIme()
    const s = root.createSurface({ width: 200, height: 100 }); root.tick(0)
    root.ime!.focus(fieldOn(s))
    root.dispose()
    expect(doc.listeners.size).toBe(0); expect(doc.body.removeChild).toHaveBeenCalledWith(doc.created[0])
    expect(root.ime).toBeNull()
  })
})
