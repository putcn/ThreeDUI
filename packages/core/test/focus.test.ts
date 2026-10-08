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
  it('orders focusables by tabIndex then tree order, skipping disabled', () => {
    const t = tree()
    expect(t.fm.focusables().map(n => n.id)).toEqual(['a', 'c', 'b'])
  })
  it('moves focus with Tab and Shift+Tab, wrapping, and emits focus/blur', () => {
    const t = tree(); const log: string[] = []
    for (const n of [t.a, t.b, t.c]) { t.d.on(n, 'focus', () => log.push(`focus:${n.id}`)); t.d.on(n, 'blur', () => log.push(`blur:${n.id}`)) }
    t.fm.key('Tab'); t.fm.key('Tab'); t.fm.key('Tab'); t.fm.key('Tab')
    expect(t.fm.current?.id).toBe('a')
    t.fm.key('Shift+Tab')
    expect(t.fm.current?.id).toBe('b')
    expect(log.slice(0, 4)).toEqual(['focus:a', 'blur:a', 'focus:c', 'blur:c'])
    expect(t.a.state.focused).toBe(false); expect(t.b.state.focused).toBe(true)
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
    expect(t.fm.focusables().map(n => n.id)).toEqual(['a', 'c', 'str', 'b'])
  })
  it('starts Shift+Tab from the last focusable, and clears focus when nothing is focusable', () => {
    const t = tree()
    t.fm.key('Shift+Tab')
    expect(t.fm.current?.id).toBe('b')
    for (const n of [t.a, t.b, t.c]) n.setState({ disabled: true })
    expect(() => t.fm.key('Tab')).not.toThrow()
    expect(t.fm.current).toBeNull(); expect(t.b.state.focused).toBe(false)
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
