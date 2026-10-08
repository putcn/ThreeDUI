import { describe, it, expect } from 'vitest'
import { Node } from '../src/node'
import { GlassUIError } from '../src/errors'

describe('Node tree', () => {
  it('appends, inserts before, and removes children while keeping parent pointers', () => {
    const root = new Node('box', 'root')
    const a = new Node('box', 'a'), b = new Node('text', 'b'), c = new Node('box', 'c')
    root.appendChild(a); root.appendChild(c)
    root.insertBefore(b, c)
    expect(root.children.map(n => n.id)).toEqual(['a', 'b', 'c'])
    expect(b.parent).toBe(root)
    root.removeChild(b)
    expect(root.children.map(n => n.id)).toEqual(['a', 'c'])
    expect(b.parent).toBeNull()
  })
  it('moving a node between parents detaches it from the old parent', () => {
    const p1 = new Node('box'), p2 = new Node('box'), x = new Node('box', 'x')
    p1.appendChild(x); p2.appendChild(x)
    expect(p1.children).toHaveLength(0)
    expect(p2.children[0]).toBe(x)
  })
  it('dirty flags propagate layout and tree changes to the root', () => {
    const root = new Node('box'), child = new Node('box')
    root.appendChild(child)
    root.dirty = { layout: false, paint: false, text: false, tree: false }
    child.dirty = { layout: false, paint: false, text: false, tree: false }
    child.setStyle({ width: 10 })
    expect(child.dirty.layout).toBe(true)
    expect(root.dirty.layout).toBe(true)
    expect(root.dirty.paint).toBe(true)   // paint propagates too: a repaint signal for the frame loop
    expect(root.dirty.text).toBe(false)
    for (const n of [root, child]) n.dirty = { layout: false, paint: false, text: false, tree: false }
    child.setProp('label', 'x')   // not a text node: repaints, never re-lays out
    expect([child.dirty.paint, root.dirty.paint]).toEqual([true, true])
    expect([child.dirty.layout, root.dirty.layout]).toEqual([false, false])
  })
  it('setState marks paint up the tree, and layout only when a toggled branch sets a layout key', () => {
    const root = new Node('box', 'root'), child = new Node('box', 'child'), label = new Node('text', 'label')
    root.appendChild(child); child.appendChild(label)
    const clean = () => { for (const n of [root, child, label]) n.dirty = { layout: false, paint: false, text: false, tree: false } }
    child.setStyle({ hover: { opacity: 0.5, width: undefined }, pressed: { width: 100 }, focused: { fontSize: 20 } })
    label.setStyle({ hover: { fontSize: 20 } })
    clean()
    child.setState({ hover: true })
    expect(child.state).toEqual({ hover: true, pressed: false, focused: false, disabled: false })
    expect([child.dirty.paint, root.dirty.paint, label.dirty.paint]).toEqual([true, true, false])
    expect([child.dirty.layout, root.dirty.layout]).toEqual([false, false])   // an undefined value is not a layout key
    clean()
    child.setState({ pressed: true })
    expect([child.dirty.layout, root.dirty.layout]).toEqual([true, true])
    clean()
    child.setState({ pressed: false })   // switching a branch off re-lays out too
    expect([child.dirty.layout, root.dirty.layout]).toEqual([true, true])
    clean()
    child.setState({ hover: true, pressed: false })   // no actual change: nothing is dirty
    expect([child.dirty, root.dirty]).toEqual([{ layout: false, paint: false, text: false, tree: false }, { layout: false, paint: false, text: false, tree: false }])
    child.setState({ focused: true })   // typography on a box does not change its layout…
    expect(child.dirty.layout).toBe(false)
    label.setState({ hover: true })     // …but on a text node it changes the measured size
    expect([label.dirty.layout, root.dirty.layout]).toEqual([true, true])
  })
  it('setProp on a text node marks text dirty; walk visits pre-order', () => {
    const root = new Node('box', 'r'), t = new Node('text', 't'), b = new Node('box', 'b')
    root.appendChild(t); root.appendChild(b)
    t.setProp('value', 'hi')
    expect(t.dirty.text).toBe(true)
    const seen: string[] = []
    root.walk(n => seen.push(n.id))
    expect(seen).toEqual(['r', 't', 'b'])
    expect(b.root).toBe(root)
  })
  it('generates unique ids when none is given', () => {
    expect(new Node('box').id).not.toBe(new Node('box').id)
  })
  it('insertBefore(x, x) throws a GlassUIError and leaves x in place', () => {
    const p = new Node('box', 'p'), x = new Node('box', 'x')
    p.appendChild(x)
    expect(() => p.insertBefore(x, x)).toThrow(GlassUIError)
    expect(() => p.insertBefore(x, x)).toThrow('[Node.insertBefore] ref 不能是 child 自身')
    expect(p.children).toEqual([x])
    expect(x.parent).toBe(p)
  })
  it('insertBefore with a ref that is not a child throws and leaves the tree unchanged', () => {
    const old = new Node('box', 'old'), p = new Node('box', 'p')
    const x = new Node('box', 'x'), stranger = new Node('box', 's')
    old.appendChild(x)
    expect(() => p.insertBefore(x, stranger)).toThrow(GlassUIError)
    expect(old.children).toEqual([x])
    expect(x.parent).toBe(old)
    expect(p.children).toHaveLength(0)
  })
  it('refuses to insert a node into itself or its own descendant', () => {
    const a = new Node('box', 'a'), b = new Node('box', 'b'), c = new Node('box', 'c')
    a.appendChild(b); b.appendChild(c)
    expect(() => c.appendChild(a)).toThrow(GlassUIError)
    expect(() => c.appendChild(a)).toThrow('[Node.insertBefore] 不能把祖先节点插入其后代（会形成环）')
    expect(() => a.appendChild(a)).toThrow(GlassUIError)
    expect(a.parent).toBeNull()
    expect(b.children).toEqual([c])
    expect(c.root).toBe(a)
  })
})

describe('paint signals (Plan 2 seams)', () => {
  it('insertBefore and removeChild mark paint on the parent chain', () => {
    const root = new Node('box', 'r'); const a = new Node('box', 'a'); const b = new Node('box', 'b')
    root.appendChild(a); root.dirty.paint = false; a.dirty.paint = false
    a.appendChild(b)
    expect(a.dirty.paint).toBe(true); expect(root.dirty.paint).toBe(true)
    root.dirty.paint = false; a.dirty.paint = false
    a.removeChild(b)
    expect(a.dirty.paint).toBe(true); expect(root.dirty.paint).toBe(true)
  })
  it('elevation and tilt are accessors that mark paint', () => {
    const root = new Node('box', 'r'); const a = new Node('glass', 'a'); root.appendChild(a)
    root.dirty.paint = false; a.dirty.paint = false
    a.elevation = 4
    expect(a.elevation).toBe(4); expect(root.dirty.paint).toBe(true)
    root.dirty.paint = false; a.dirty.paint = false
    a.tilt = { x: 0.1, y: 0 }
    expect(a.tilt).toEqual({ x: 0.1, y: 0 }); expect(a.dirty.paint).toBe(true)
    a.dirty.paint = false
    a.elevation = 4   // same value: no signal
    expect(a.dirty.paint).toBe(false)
  })
  it('tilt is copied in and read-only out, so it cannot change behind the paint signal', () => {
    const a = new Node('glass', 'a'); const t = { x: 0.1, y: 0.2 }
    a.tilt = t; t.x = 0.5
    expect(a.tilt).toEqual({ x: 0.1, y: 0.2 })
    a.dirty.paint = false
    a.tilt = { x: 0.1, y: 0.2 }   // equal value: no signal
    expect(a.dirty.paint).toBe(false)
    // @ts-expect-error -- the getter is Readonly; write through the setter so paint is marked
    const mutate = (): void => { a.tilt.x = 0.3 }
    expect(mutate).toBeTypeOf('function')
  })
  it('visual values default to null and setVisual marks paint', () => {
    const a = new Node('box', 'a')
    expect(a.visual).toBeNull()
    a.dirty.paint = false
    a.setVisual({ scale: 0.96, opacity: 0.5 })
    expect(a.visual).toEqual({ scale: 0.96, opacity: 0.5 }); expect(a.dirty.paint).toBe(true)
    a.dirty.paint = false
    a.setVisual(null)
    expect(a.visual).toBeNull(); expect(a.dirty.paint).toBe(true)
  })
})
