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
    expect(root.dirty.paint).toBe(false)
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
