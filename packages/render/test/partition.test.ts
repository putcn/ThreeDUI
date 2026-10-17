import { describe, it, expect, beforeAll } from 'vitest'
import { Node, createSurface, createYogaLayout, buildRenderList, defaultTheme as theme, type GlassInstance, type LayoutEngine, type RenderList, type TextInstance } from '@glassui/core'
import { partition, liftFor, splitNested } from '../src/surface/partition'

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
    expect(p.content.shadows).toEqual([])                                    // not raised: no shadow
  })
  it('puts a raised glass\'s shadow in the content layer, beside its pool', () => {
    const s = createSurface({ id: 'p', width: 400, height: 300 })
    const card = new Node('glass', 'card'); card.setStyle({ width: 200, height: 120 }); card.elevation = 24
    s.root.appendChild(card); engine.compute(s.root, 400, 300, () => ({ width: 20, height: 20 }))
    const p = partition(buildRenderList(s, theme, 'light'))
    expect(p.content.shadows.map(d => [d.kind, d.node.id])).toEqual([['shadow', 'card']])
    expect(p.content.pools.map(d => d.kind)).toEqual(['pool']); expect(p.foreground.rims.map(d => d.kind)).toEqual(['rim'])
  })

  it('spatial §11.8: a panel inside glass rides it (foreground, mapped in glassOf); a glass node\'s own focus ring rides its own top face (Task 10 V1); a panel on the plate stays content', () => {
    const s = createSurface({ id: 'p', width: 400, height: 300 })
    const plate = new Node('box', 'plate'); plate.setStyle({ width: 100, height: 40, bg: 'fill' })
    const card = new Node('glass', 'card'); card.setStyle({ width: 240, height: 120, padding: 10, glass: { thickness: 12 } }); card.elevation = 24
    const chip = new Node('box', 'chip'); chip.setStyle({ width: 60, height: 22, bg: 'accent' })
    const label = new Node('text', 'label'); label.setProp('value', '已发货')
    const field = new Node('box', 'field'); field.setStyle({ width: 80, height: 30, border: { width: 1, color: 'separator' } })
    s.root.appendChild(plate); s.root.appendChild(card); card.appendChild(chip); chip.appendChild(label); card.appendChild(field)
    card.setState({ focused: true, focusVisible: true }); field.setState({ focused: true, focusVisible: true })
    engine.compute(s.root, 400, 300, () => ({ width: 20, height: 20 }))
    const rl = buildRenderList(s, theme, 'light')
    const p = partition(rl)
    // the card's ring: its node is the glass itself (glass draws no panel of its own), its rect outside the glass's
    const cardRing = rl.panels.find(x => x.node === card)!
    expect(cardRing.rect.width).toBeGreaterThan(card.layout.width); expect(cardRing.border?.width).toBe(2.5)
    expect(p.content.panels.map(x => x.node.id)).toEqual(['plate'])
    // the card's own ring rides the card's top face, registered with the glass rather than the plate under it; the
    // chip's background, the field's border and the field's own focus ring (a box, not glass) ride the card too
    expect(p.foreground.panels.map(x => x.node.id)).toEqual(['card', 'chip', 'field', 'field'])
    expect(p.foreground.panels).toContain(cardRing)
    for (const n of [card, chip, field]) expect(p.glassOf.get(n)?.node).toBe(card)
    expect(liftFor(p, card)).toBe(12)
    expect(p.glassOf.has(plate)).toBe(false)
    expect(liftFor(p, chip)).toBe(12); expect(liftFor(p, label)).toBe(12); expect(liftFor(p, plate)).toBe(0)
    expect(p.content.panels.length + p.foreground.panels.length).toBe(rl.panels.length)   // every panel, once
  })

  // Hand-built lists: partition only reads `node`, `params.thickness` and `kind`, so the fixtures carry just those.
  const glassAt = (node: Node, thickness: number) => ({ node, params: { thickness } }) as unknown as GlassInstance
  const textAt = (node: Node) => ({ node }) as unknown as TextInstance
  const list = (glass: GlassInstance[], text: TextInstance[]): RenderList => ({ panels: [], glass, text, decorations: [], images: [], fused: [] })

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

  it('splitNested: glass under glass is inner, at any depth', () => {
    const a = new Node('box'), b = new Node('box'), c = new Node('box'), d = new Node('box')
    a.appendChild(b); b.appendChild(c)
    const g = (node: Node) => ({ node } as GlassInstance)
    const { outer, inner } = splitNested([g(a), g(b), g(c), g(d)])
    expect(outer.map(i => i.node)).toEqual([a, d]); expect(inner.map(i => i.node)).toEqual([b, c])
  })

  /** A container of two glass capsules 10 pt apart (`a` raised `raise` pt), each with a label, inside `card` glass or not. */
  function container(opts: { raise?: number; inCard?: boolean } = {}) {
    const s = createSurface({ id: 'c', width: 400, height: 200 })
    const box = new Node('box', 'box'); box.setProp('glassContainer', { spacing: 16 }); box.setStyle({ position: 'absolute', left: 10, top: 10, width: 300, height: 100 })
    const at = (id: string, left: number) => {
      const g = new Node('glass', id); g.setStyle({ position: 'absolute', left, top: 0, width: 80, height: 40, radius: 'capsule', glass: { thickness: id === 'a' ? 8 : 5 } })
      const t = new Node('text', `${id}-label`); t.setProp('value', id); g.appendChild(t); box.appendChild(g)
      return { g, t }
    }
    const a = at('a', 0), b = at('b', 90)
    a.g.elevation = opts.raise ?? 0
    const knob = new Node('glass', 'knob'); knob.setStyle({ position: 'absolute', left: 4, top: 4, width: 10, height: 10 }); b.g.appendChild(knob)
    if (opts.inCard) { const card = new Node('glass', 'card'); card.setStyle({ width: 400, height: 200 }); card.appendChild(box); s.root.appendChild(card) } else s.root.appendChild(box)
    engine.compute(s.root, 400, 200, () => ({ width: 20, height: 20 }))
    return { rl: buildRenderList(s, theme, 'light'), a, b, knob }
  }
  it('glass containers: a fused member is glass to what rides on it, lifted onto the slab\'s top (the cluster\'s elevation + thickness); with fuse: false onto its own', () => {
    const { rl, a, b } = container({ raise: 6 })
    const p = partition(rl)
    expect(p.foreground.text.map(x => x.node.id).sort()).toEqual(['a-label', 'b-label'])
    expect(p.glassOf.get(b.t)!.node).toBe(b.g); expect(p.fusedOf.get(p.glassOf.get(b.t)!)).toBe(rl.fused[0])
    // the slab: elevation 6 (a's), thickness 8 (a's params); a's label already carries a's 6, b's none
    expect(liftFor(p, a.t)).toBe(8); expect(liftFor(p, b.t)).toBe(14)
    const own = partition(rl, { fuse: false })
    expect(own.fusedOf.size).toBe(0); expect(liftFor(own, a.t)).toBe(8); expect(liftFor(own, b.t)).toBe(5)
  })
  it('splitNested with fused clusters: their members count as glass (glass in one is inner); a cluster inside glass is inner', () => {
    const top = container(), n = splitNested(top.rl.glass, top.rl.fused)
    expect(n.outerFused).toEqual(top.rl.fused); expect(n.innerFused).toEqual([])
    expect(n.inner.map(g => g.node)).toEqual([top.knob]); expect(n.outer).toEqual([])
    const carded = container({ inCard: true }), m = splitNested(carded.rl.glass, carded.rl.fused)
    expect(m.innerFused).toEqual(carded.rl.fused); expect(m.outerFused).toEqual([])
    expect(m.outer.map(g => g.node.id)).toEqual(['card']); expect(m.inner.map(g => g.node.id)).toEqual(['knob'])
  })
})
