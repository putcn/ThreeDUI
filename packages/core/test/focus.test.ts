import { describe, it, expect } from 'vitest'
import { Node } from '../src/node'
import { EventDispatcher } from '../src/events/dispatch'
import { FocusManager } from '../src/focus'

function tree() {
  const root = new Node('box', 'root'), d = new EventDispatcher()
  const a = new Node('box', 'a'), b = new Node('box', 'b'), c = new Node('box', 'c'), dis = new Node('box', 'dis')
  a.setProp('tabIndex', 0); b.setProp('tabIndex', 2); c.setProp('tabIndex', 1); dis.setProp('tabIndex', 0); dis.setState({ disabled: true })
  root.appendChild(a); root.appendChild(b); root.appendChild(c); root.appendChild(dis)
  return { root, d, a, b, c, dis, fm: new FocusManager(root, d) }
}

describe('FocusManager', () => {
  it('orders focusables as the DOM does: positive tabIndex ascending, then tabIndex 0 in tree order, skipping disabled', () => {
    const t = tree()
    expect(t.fm.focusables().map(n => n.id)).toEqual(['c', 'b', 'a'])
  })
  it('keeps tree order among equal positive tabIndex values and among zeros, nested nodes included', () => {
    const t = tree()
    const group = new Node('box', 'group'), z2 = new Node('box', 'z2'), c2 = new Node('box', 'c2'), neg = new Node('box', 'neg')
    group.setProp('tabIndex', 0); z2.setProp('tabIndex', 0); c2.setProp('tabIndex', 1); neg.setProp('tabIndex', -1)
    group.appendChild(c2); group.appendChild(z2)
    t.root.insertBefore(group, t.a); t.root.appendChild(neg)
    expect(t.fm.focusables().map(n => n.id)).toEqual(['c2', 'c', 'b', 'group', 'z2', 'a'])
  })
  it('moves focus with Tab and Shift+Tab, wrapping, and emits focus/blur', () => {
    const t = tree(); const log: string[] = []
    for (const n of [t.a, t.b, t.c]) { t.d.on(n, 'focus', () => log.push(`focus:${n.id}`)); t.d.on(n, 'blur', () => log.push(`blur:${n.id}`)) }
    t.fm.key('Tab'); t.fm.key('Tab'); t.fm.key('Tab'); t.fm.key('Tab')
    expect(t.fm.current?.id).toBe('c')
    t.fm.key('Shift+Tab')
    expect(t.fm.current?.id).toBe('a')
    expect(log.slice(0, 4)).toEqual(['focus:c', 'blur:c', 'focus:b', 'blur:b'])
    expect(t.c.state.focused).toBe(false); expect(t.a.state.focused).toBe(true)
  })
  it('routes other keys to the focused node', () => {
    const t = tree(); let got = ''
    t.d.on(t.a, 'keydown', e => { got = e.key ?? '' })
    t.fm.focus(t.a); t.fm.key('Enter')
    expect(got).toBe('Enter')
  })
  it('drops focus without throwing when the focused node is removed', () => {
    const t = tree(); let blurred = false
    t.d.on(t.a, 'blur', () => { blurred = true })
    t.fm.focus(t.a); t.a.remove(); t.fm.reconcile()
    expect(t.fm.current).toBeNull(); expect(blurred).toBe(true)
    expect(() => t.fm.key('Tab')).not.toThrow()
  })
})

describe('FocusManager edge cases', () => {
  it('skips display none subtrees and tabIndex values that are not numbers', () => {
    const t = tree()
    const panel = new Node('box', 'panel'), inner = new Node('box', 'inner'), nul = new Node('box', 'nul'), str = new Node('box', 'str')
    panel.setStyle({ display: 'none' }); inner.setProp('tabIndex', 0); panel.appendChild(inner)
    nul.setProp('tabIndex', null); str.setProp('tabIndex', '1')   // null is what a renderer sets when a prop is removed
    t.root.appendChild(panel); t.root.appendChild(nul); t.root.appendChild(str)
    expect(t.fm.focusables().map(n => n.id)).toEqual(['c', 'str', 'b', 'a'])
  })
  it('starts Shift+Tab from the last focusable, and clears focus when nothing is focusable', () => {
    const t = tree()
    t.fm.key('Shift+Tab')
    expect(t.fm.current?.id).toBe('a')
    for (const n of [t.a, t.b, t.c]) n.setState({ disabled: true })
    expect(() => t.fm.key('Tab')).not.toThrow()
    expect(t.fm.current).toBeNull(); expect(t.a.state.focused).toBe(false)
  })
  it('refuses detached, disabled or hidden nodes and drops focus when the focused node becomes one', () => {
    const t = tree(); const stray = new Node('box', 'stray'); stray.setProp('tabIndex', 0)
    t.fm.focus(stray); t.fm.focus(t.dis)
    expect(t.fm.current).toBeNull(); expect([stray.state.focused, t.dis.state.focused]).toEqual([false, false])

    t.fm.focus(t.a); t.a.setState({ disabled: true }); t.fm.reconcile()
    expect(t.fm.current).toBeNull(); expect(t.a.state.focused).toBe(false)

    let target = ''
    t.d.on(t.root, 'keydown', e => { target = e.target.id })
    t.fm.focus(t.c); t.root.setStyle({ display: 'none' })
    t.fm.key('Enter')   // reconciles first, so the key reaches the root, not the hidden node
    expect(target).toBe('root'); expect(t.fm.current).toBeNull(); expect(t.c.state.focused).toBe(false)
  })
  it('reads the effective style: a state branch with display none hides a node and its subtree', () => {
    const t = tree()
    const group = new Node('box', 'group'), inner = new Node('box', 'inner'); inner.setProp('tabIndex', 0)
    group.appendChild(inner); t.root.appendChild(group)
    group.setStyle({ hover: { display: 'none' } }); t.a.setStyle({ hover: { display: 'none' } })
    expect(t.fm.focusables()).toContain(inner)
    t.fm.focus(inner)
    group.setState({ hover: true })
    expect(t.fm.focusables()).not.toContain(inner)
    t.fm.reconcile()
    expect(t.fm.current).toBeNull()
    t.fm.focus(inner)
    expect(t.fm.current).toBeNull()
    t.a.setState({ hover: true })
    expect(t.fm.focusables()).not.toContain(t.a)
  })
  it('changes focused through setState, so focus and blur mark the nodes dirty', () => {
    const t = tree()
    t.root.walk(n => { n.dirty = { layout: false, paint: false, text: false, tree: false } })
    t.fm.focus(t.a)
    expect([t.a.state.focused, t.a.dirty.paint, t.root.dirty.paint]).toEqual([true, true, true])
    t.fm.focus(t.b)
    expect([t.a.state.focused, t.b.state.focused, t.b.dirty.paint]).toEqual([false, true, true])
  })
  it('focusFromPointer focuses the nearest node with a tabIndex, without the ring; keys focus with it', () => {
    const d = new EventDispatcher(), root = new Node('box')
    const field = new Node('glass'); field.setProp('tabIndex', 0)
    const icon = new Node('image'); field.appendChild(icon); root.appendChild(field)
    const plain = new Node('box'); root.appendChild(plain)
    const f = new FocusManager(root, d)
    f.focusFromPointer(icon)
    expect(f.current).toBe(field); expect(field.state.focused).toBe(true); expect(field.state.focusVisible).toBe(false)
    f.focusFromPointer(plain)
    expect(f.current).toBeNull(); expect(field.state.focused).toBe(false)
    f.key('Tab')
    expect(f.current).toBe(field); expect(field.state.focusVisible).toBe(true)
    f.focus(null)
    expect(field.state.focusVisible).toBe(false)
  })
  it('focusFromPointer skips disabled nodes and counts tabIndex -1 as focusable (DOM tabindex)', () => {
    const d = new EventDispatcher(), root = new Node('box')
    const outer = new Node('box'); outer.setProp('tabIndex', -1)
    const inner = new Node('box'); inner.setProp('tabIndex', 0); inner.setState({ disabled: true })
    outer.appendChild(inner); root.appendChild(outer)
    const f = new FocusManager(root, d)
    f.focusFromPointer(inner)
    expect(f.current).toBe(outer)
  })
  it('focus(node) shows the ring after keys and hides it after a press, unless told; visible follows each focus change', () => {
    const t = tree()
    t.fm.focus(t.a)                                                    // nothing yet: no ring
    expect(t.a.state.focusVisible).toBe(false)
    t.fm.focus(t.b, { visible: true })
    expect([t.a.state.focusVisible, t.b.state.focusVisible]).toEqual([false, true])
    t.fm.next()                                                        // keys: the ring, and so is a focus() after them
    expect(t.fm.current).toBe(t.a); expect(t.a.state.focusVisible).toBe(true); expect(t.b.state.focusVisible).toBe(false)
    t.fm.focus(t.c)
    expect(t.c.state.focusVisible).toBe(true)
    t.fm.focusFromPointer(t.b)                                         // a press: no ring, and none for a focus() after it
    expect([t.b.state.focused, t.b.state.focusVisible, t.c.state.focusVisible]).toEqual([true, false, false])
    t.fm.focus(t.a)
    expect(t.a.state.focusVisible).toBe(false)
    t.fm.prev()
    expect(t.fm.current).toBe(t.b); expect(t.b.state.focusVisible).toBe(true)
    t.fm.focusFromPointer(null)                                        // a press on nothing blurs
    expect(t.fm.current).toBeNull(); expect(t.b.state.focusVisible).toBe(false)
  })
  it('focusFromPointer stops at the root and ignores a hidden or detached press target', () => {
    const t = tree()
    const outside = new Node('box', 'outside'); outside.setProp('tabIndex', 0)
    const inner = new Node('box', 'inner'); outside.appendChild(t.root); t.root.appendChild(inner)
    t.fm.focus(t.a)
    t.fm.focusFromPointer(inner)                                       // the root's own parent is outside the tree
    expect(t.fm.current).toBeNull()
    const stray = new Node('box', 'stray'); stray.setProp('tabIndex', 0)
    t.fm.focusFromPointer(stray)
    expect(t.fm.current).toBeNull(); expect(stray.state.focused).toBe(false)
  })
  it('lets a blur listener move focus elsewhere and keeps state consistent', () => {
    const t = tree(); const log: string[] = []
    for (const n of [t.a, t.b, t.c]) { t.d.on(n, 'focus', () => log.push(`focus:${n.id}`)); t.d.on(n, 'blur', () => log.push(`blur:${n.id}`)) }
    t.fm.focus(t.a)
    t.d.on(t.a, 'blur', () => t.fm.focus(t.c))
    t.fm.focus(t.b)
    expect(t.fm.current?.id).toBe('c')
    expect(log).toEqual(['focus:a', 'blur:a', 'focus:c'])
    expect([t.a, t.b, t.c].map(n => n.state.focused)).toEqual([false, false, true])
  })
})
