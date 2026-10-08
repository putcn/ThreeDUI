import { describe, it, expect, beforeAll } from 'vitest'
import { Node, createSurface, createYogaLayout, buildRenderList, defaultTheme as theme, type GlassInstance, type LayoutEngine, type RenderList, type TextInstance } from '@glassui/core'
import { partition, liftFor } from '../src/surface/partition'

let engine: LayoutEngine
beforeAll(async () => { engine = await createYogaLayout() })

describe('partition', () => {
  it('puts children of glass in the foreground, everything else in the content layer', () => {
    const s = createSurface({ id: 'p', width: 400, height: 300 })
    const card = new Node('box', 'card'); card.setStyle({ bg: 'fill', padding: 10 })
    const title = new Node('text', 'title'); title.setProp('value', 'Hi')
    const btn = new Node('glass', 'btn'); btn.setStyle({ width: 120, height: 40, glass: { thickness: 9 } })
    const label = new Node('text', 'label'); label.setProp('value', 'Go')
    const wrap = new Node('box', 'wrap'); const icon = new Node('image', 'icon'); icon.setProp('src', 'x.png')
    s.root.appendChild(card); card.appendChild(title); card.appendChild(btn); btn.appendChild(wrap); wrap.appendChild(icon); btn.appendChild(label)
    engine.compute(s.root, 400, 300, () => ({ width: 20, height: 20 }))
    const p = partition(buildRenderList(s, theme, 'light'))
    expect(p.content.panels.map(x => x.node.id)).toEqual(['card'])
    expect(p.content.text.map(x => x.node.id)).toEqual(['title'])
    expect(p.foreground.text.map(x => x.node.id)).toEqual(['label'])
    expect(p.foreground.images.map(x => x.node.id)).toEqual(['icon'])
    expect(p.content.pools).toHaveLength(1); expect(p.foreground.rims).toHaveLength(1)
    expect(liftFor(p, label)).toBe(9); expect(liftFor(p, icon)).toBe(9); expect(liftFor(p, title)).toBe(0); expect(liftFor(p, btn)).toBe(9)
  })

  // Hand-built lists: partition only reads `node`, `params.thickness` and `kind`, so the fixtures carry just those.
  const glassAt = (node: Node, thickness: number) => ({ node, params: { thickness } }) as unknown as GlassInstance
  const textAt = (node: Node) => ({ node }) as unknown as TextInstance
  const list = (glass: GlassInstance[], text: TextInstance[]): RenderList => ({ panels: [], glass, text, decorations: [], images: [] })

  it('lifts a foreground item by the nearest glass when glass nests', () => {
    const outer = new Node('glass', 'outer'), inner = new Node('glass', 'inner'), a = new Node('text', 'a'), b = new Node('text', 'b')
    outer.appendChild(a); outer.appendChild(inner); inner.appendChild(b)
    const p = partition(list([glassAt(outer, 4), glassAt(inner, 7)], [textAt(a), textAt(b)]))
    expect(p.foreground.text.map(x => x.node.id)).toEqual(['a', 'b'])
    expect(liftFor(p, a)).toBe(4); expect(liftFor(p, b)).toBe(7)
    expect([...p.glassOf.keys()].map(n => n.id)).toEqual(['a', 'b'])
  })

  it('walks each ancestor chain once however many items share it', () => {
    const depth = 300
    const g = new Node('glass', 'g'), lonely = new Node('box', 'lonely')
    let tip = g, tip2 = lonely
    for (let i = 0; i < depth; i++) { const n = new Node('box', `b${i}`); tip.appendChild(n); tip = n; const m = new Node('box', `c${i}`); tip2.appendChild(m); tip2 = m }
    const leaves: Node[] = []
    for (let i = 0; i < depth; i++) { const t = new Node('text', `t${i}`); (i % 2 ? tip : tip2).appendChild(t); leaves.push(t) }
    let reads = 0
    const all: Node[] = []
    const collect = (n: Node) => { all.push(n); n.children.forEach(collect) }
    collect(g); collect(lonely)
    for (const n of all) { const parent = n.parent; Object.defineProperty(n, 'parent', { get: () => (reads++, parent) }) }
    const p = partition(list([glassAt(g, 5)], leaves.map(textAt)))
    expect(p.foreground.text).toHaveLength(depth / 2); expect(p.content.text).toHaveLength(depth / 2)
    expect(reads).toBeLessThanOrEqual(all.length) // the uncached walk would read ~depth² parents
  })
})
