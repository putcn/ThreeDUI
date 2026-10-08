import { describe, it, expect, beforeAll } from 'vitest'
import { Node } from '../src/node'
import { createYogaLayout, type LayoutEngine, type MeasureFn } from '../src/layout/yoga'

let engine: LayoutEngine
beforeAll(async () => { engine = await createYogaLayout() })

function box(style: Parameters<Node['setStyle']>[0], id?: string) { const n = new Node('box', id); n.setStyle(style); return n }

describe('YogaLayout', () => {
  it('lays out a padded row with gap', () => {
    const root = box({ flexDirection: 'row', padding: 10, gap: 5, width: 200, height: 100 }, 'root')
    const a = box({ width: 50, height: '100%' }, 'a'), b = box({ flexGrow: 1 }, 'b')
    root.appendChild(a); root.appendChild(b)
    engine.compute(root, 200, 100)
    expect(a.layout).toEqual({ x: 10, y: 10, width: 50, height: 80 })
    expect(b.layout).toEqual({ x: 65, y: 10, width: 125, height: 80 })
    expect(root.dirty.layout).toBe(false)
  })
  it('positions absolute children with inset and respects display none', () => {
    const root = box({ width: 100, height: 100 }, 'root')
    const abs = box({ position: 'absolute', right: 0, bottom: 0, width: 20, height: 20 }, 'abs')
    const gone = box({ display: 'none', width: 50, height: 50 }, 'gone')
    root.appendChild(gone); root.appendChild(abs)
    engine.compute(root, 100, 100)
    expect(abs.layout).toEqual({ x: 80, y: 80, width: 20, height: 20 })
    expect(gone.layout.width).toBe(0)
  })
  it('measures text nodes through the measure callback', () => {
    const root = box({ flexDirection: 'column', width: 120 }, 'root')
    const t = new Node('text', 't'); t.setProp('value', 'hello world')
    root.appendChild(t)
    engine.compute(root, 120, 500, (node, maxWidth) => ({ width: Math.min(300, maxWidth ?? 300), height: 40 }))
    expect(t.layout).toEqual({ x: 0, y: 0, width: 120, height: 40 })
  })
  it('never yields NaN or negative sizes for degenerate inputs', () => {
    const root = box({ width: 0, height: 0, padding: 30 }, 'root')
    const c = box({ width: 10, height: 10 }, 'c')
    root.appendChild(c)
    engine.compute(root, 0, 0)
    for (const n of [root, c]) for (const v of Object.values(n.layout)) { expect(Number.isFinite(v)).toBe(true) }
    expect(root.layout.width).toBeGreaterThanOrEqual(0)
  })
  it('re-layout after a style change moves siblings', () => {
    const root = box({ flexDirection: 'row', width: 100, height: 10 }, 'root')
    const a = box({ width: 10, height: 10 }, 'a'), b = box({ width: 10, height: 10 }, 'b')
    root.appendChild(a); root.appendChild(b)
    engine.compute(root, 100, 10)
    a.setStyle({ width: 30 })
    engine.compute(root, 100, 10)
    expect(b.layout.x).toBe(30)
    engine.dispose(root)
  })

  it('honours the flex shorthand', () => {
    const root = box({ flexDirection: 'row', width: 100, height: 10 }, 'root')
    const a = box({ flex: 1 }, 'a'), b = box({ width: 20 }, 'b')
    root.appendChild(a); root.appendChild(b)
    engine.compute(root, 100, 10)
    expect(a.layout.width).toBe(80)
    expect(b.layout.x).toBe(80)
  })
  it('reverts a property to its default when its style key is unset', () => {
    const root = box({ flexDirection: 'row', width: 100, height: 10 }, 'root')
    const a = box({ width: 30, marginLeft: 5, minWidth: 'auto', paddingX: 4 }, 'a')
    root.appendChild(a)
    engine.compute(root, 100, 10)
    expect(a.layout).toEqual({ x: 5, y: 0, width: 30, height: 10 })
    a.setStyle({ width: undefined, marginLeft: undefined })
    engine.compute(root, 100, 10)
    expect(a.layout).toEqual({ x: 0, y: 0, width: 8, height: 10 })
  })
  it('treats inset "auto" as CSS does: the opposite edge places the box', () => {
    const root = box({ width: 100, height: 100 }, 'root')
    const abs = box({ position: 'absolute', inset: 0, top: 'auto', left: 'auto', width: 20, height: 20 }, 'abs')
    root.appendChild(abs)
    engine.compute(root, 100, 100)
    expect(abs.layout).toEqual({ x: 80, y: 80, width: 20, height: 20 })
  })
  it('moves a node into a container that is laid out before its old one', () => {
    const root = box({ flexDirection: 'row', width: 100, height: 20 }, 'root')
    const left = box({ width: 50 }, 'left'), right = box({ width: 50 }, 'right')
    const c = box({ width: 10, height: 10 }, 'c')
    root.appendChild(left); root.appendChild(right); right.appendChild(c)
    engine.compute(root, 100, 20)
    left.appendChild(c)
    engine.compute(root, 100, 20)
    expect(c.layout).toEqual({ x: 0, y: 0, width: 10, height: 10 })
    expect(right.layout).toEqual({ x: 50, y: 0, width: 50, height: 20 })
    engine.dispose(root)
  })
  it('re-measures text when its value or style changes, and only then', () => {
    const root = box({ width: 120 }, 'root')
    const t = new Node('text', 't'); t.setProp('value', 'hi')
    root.appendChild(t)
    let calls = 0
    const measure: MeasureFn = (n) => { calls++; return { width: 30, height: String(n.props.value).length * Number(n.style.fontSize ?? 10) } }
    engine.compute(root, 120, 100, measure)
    expect(t.layout.height).toBe(20)
    const settled = calls
    engine.compute(root, 120, 100, measure)
    expect(calls).toBe(settled)
    t.setProp('value', 'hey')
    engine.compute(root, 120, 100, measure)
    expect(t.layout.height).toBe(30)
    t.setStyle({ fontSize: 20 })
    engine.compute(root, 120, 100, measure)
    expect(t.layout.height).toBe(60)
  })
  it('treats a non-finite viewport as unconstrained and a negative one as empty', () => {
    const root = box({ flexDirection: 'row' }, 'root')
    root.appendChild(box({ width: 40, height: 15 }, 'c'))
    engine.compute(root, Infinity, NaN)
    expect(root.layout).toEqual({ x: 0, y: 0, width: 40, height: 15 })
    engine.compute(root, -10, -10)
    expect(root.layout).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })
  it('lays a tree out again after dispose', () => {
    const root = box({ flexDirection: 'row', width: 100, height: 10 }, 'root')
    const a = box({ width: 10 }, 'a'), b = box({ width: 10 }, 'b')
    root.appendChild(a); root.appendChild(b)
    engine.compute(root, 100, 10)
    engine.dispose(a)
    engine.compute(root, 100, 10)
    expect(b.layout.x).toBe(10)
    engine.dispose(root)
    engine.compute(root, 100, 10)
    expect(b.layout.x).toBe(10)
  })
})
