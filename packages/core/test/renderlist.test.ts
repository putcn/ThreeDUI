import { describe, it, expect, beforeAll } from 'vitest'
import { Node } from '../src/node'
import { createYogaLayout, type LayoutEngine } from '../src/layout/yoga'
import { createSurface } from '../src/surface'
import { buildRenderList, sortKey, FOCUS_RING, type RenderList } from '../src/renderlist'
import { IDENTITY, apply } from '../src/transform2d'
import { effectiveStyle } from '../src/style/effective'
import { defaultTheme as theme, resolveColor } from '../src/style/theme'
import type { Style } from '../src/style/schema'

let engine: LayoutEngine
beforeAll(async () => { engine = await createYogaLayout() })

function form() {
  const s = createSurface({ id: 's', width: 400, height: 300 })
  const card = new Node('box', 'card'); card.setStyle({ position: 'absolute', left: 20, top: 20, width: 200, height: 100, bg: 'fill', radius: 'lg', overflow: 'hidden' })
  const btn = new Node('glass', 'btn'); btn.setStyle({ position: 'absolute', left: 10, top: 10, width: 120, height: 40, radius: 'capsule', glass: { glow: { color: 'accent', strength: 1.1 } } }); btn.elevation = 4
  const label = new Node('text', 'label'); label.setProp('value', '创建账号'); label.setStyle({ color: 'fill', fontSize: 'base', textAlign: 'center', width: '100%', height: '100%' })
  const hidden = new Node('box', 'hidden'); hidden.setStyle({ display: 'none', bg: 'accent' })
  s.root.appendChild(card); card.appendChild(btn); btn.appendChild(label); s.root.appendChild(hidden)
  engine.compute(s.root, 400, 300, () => ({ width: 80, height: 22 }))
  return { s, card, btn, label }
}

describe('buildRenderList', () => {
  it('emits panels, glass with decorations, and text with accumulated elevation and clips', () => {
    const { s } = form()
    const rl = buildRenderList(s, theme, 'light')
    expect(rl.panels.map(p => p.node.id)).toEqual(['card'])
    expect(rl.panels[0]).toMatchObject({ rect: { x: 20, y: 20, width: 200, height: 100 }, radius: theme.radius.lg, elevation: 0 })
    expect(rl.glass).toHaveLength(1)
    expect(rl.glass[0]).toMatchObject({ rect: { x: 30, y: 30, width: 120, height: 40 }, radius: 20, elevation: 4, clip: { x: 20, y: 20, width: 200, height: 100, radius: theme.radius.lg } })
    expect(rl.glass[0]!.params.glow).toMatchObject({ strength: 1.1 }); expect(rl.glass[0]!.params.fillet).toBeCloseTo(40 * 0.06)
    expect(rl.decorations.map(d => d.kind).sort()).toEqual(['pool', 'rim', 'shadow'])   // raised 4 pt: it casts a shadow
    expect(rl.text[0]).toMatchObject({ text: '创建账号', align: 'center', elevation: 4 })
    expect(rl.text[0]!.z).toBeGreaterThan(rl.glass[0]!.z)
  })
  it('skips display:none subtrees', () => {
    const rl = buildRenderList(form().s, theme, 'light')
    expect(rl.panels.find(p => p.node.id === 'hidden')).toBeUndefined()
  })
  it('applies state branches before resolving', () => {
    const { s, card } = form()
    card.setStyle({ hover: { opacity: 0.5 } }); card.setState({ hover: true })
    expect(buildRenderList(s, theme, 'light').panels[0]!.opacity).toBe(0.5)
  })
})

/** A surface whose children are absolutely placed, laid out with a fixed text measure. */
function surface(...children: Node[]) {
  const s = createSurface({ id: 't', width: 400, height: 300 })
  for (const c of children) s.root.appendChild(c)
  return s
}
function box(type: Node['type'], id: string, style: Style, ...children: Node[]): Node {
  const n = new Node(type, id); n.setStyle({ position: 'absolute', ...style })
  for (const c of children) n.appendChild(c)
  return n
}
const layout = (s: ReturnType<typeof surface>) => { engine.compute(s.root, s.width, s.height, () => ({ width: 80, height: 22 })); return s }

describe('buildRenderList rules', () => {
  it('numbers z in pre-order over the visible tree only, root first', () => {
    const rl = buildRenderList(form().s, theme, 'light')
    expect(rl.panels[0]!.z).toBe(1)   // root 0, card 1
    expect(rl.glass[0]!.z).toBe(2)
    expect(rl.text[0]!.z).toBe(sortKey(3, 'content'))
    const s = layout(surface(
      box('box', 'gone', { display: 'none' }, box('box', 'inner', { bg: 'fill' })),
      box('box', 'after', { bg: 'fill' }),
    ))
    expect(buildRenderList(s, theme, 'light').panels.map(p => [p.node.id, p.z])).toEqual([['after', 1]])
  })

  it('accumulates elevation down the tree', () => {
    const inner = box('box', 'inner', { bg: 'fill', width: 10, height: 10 }); inner.elevation = 1
    const outer = box('box', 'outer', { bg: 'fill', width: 50, height: 50 }, box('box', 'mid', { width: 20, height: 20 }, inner)); outer.elevation = 2
    const rl = buildRenderList(layout(surface(outer)), theme, 'light')
    expect(rl.panels.map(p => [p.node.id, p.elevation])).toEqual([['outer', 2], ['inner', 3]])
  })

  it('treats bg glass/glass-clear boxes as glass, and resolves clear vs tinted pools', () => {
    const s = layout(surface(
      box('box', 'clear', { bg: 'glass-clear', left: 0, width: 100, height: 40, radius: 12 }),
      box('box', 'tinted', { bg: 'glass', left: 120, width: 100, height: 40, glass: { glow: { color: 'accent', strength: 1 } } }),
      box('glass', 'plain', { left: 240, width: 100, height: 40, glass: { variant: 'clear' } }),
      box('box', 'forced', { bg: 'glass-clear', top: 60, width: 100, height: 40, glass: { variant: 'regular' } }),
    ))
    const rl = buildRenderList(s, theme, 'light')
    expect(rl.panels).toEqual([])
    expect(rl.glass.map(g => [g.node.id, g.params.variant, g.params.scatter])).toEqual([
      ['clear', 'clear', 0.02], ['tinted', 'regular', theme.glass.scatter], ['plain', 'clear', 0.02], ['forced', 'regular', theme.glass.scatter],
    ])
    const pool = (id: string) => rl.decorations.find(d => d.kind === 'pool' && d.node.id === id)!
    expect(pool('clear')).toMatchObject({ color: [1, 1, 1, 1], strength: 0.28, radius: 12 })
    expect(pool('tinted')).toMatchObject({ color: resolveColor('accent', theme, 'light'), strength: 0.5 })
    const tinted = rl.glass.find(g => g.node.id === 'tinted')!
    expect(tinted.params).toEqual({
      thickness: expect.closeTo(8), fillet: expect.closeTo(2.4), filletBottom: expect.closeTo(1.6), profile: 'fillet',   // 100 × 40
      scatter: theme.glass.scatter, lift: theme.glass.lift, edgeGlow: theme.glass.edgeGlow, ior: theme.glass.ior,
      dispersion: theme.glass.dispersion, roughness: theme.glass.roughness, tint: null, absorption: 0,
      glow: { color: resolveColor('accent', theme, 'light'), strength: 1 }, cornerExponent: 4.5,
      envIntensity: 1, specularIntensity: 1, innerGlow: 0, adaptive: true, variant: 'regular',
    })
  })

  it('scales glass thickness and fillets with the shorter side (spec §5.2) unless the style sets them', () => {
    const s = layout(surface(
      box('glass', 'button', { left: 0, width: 240, height: 80 }),
      box('glass', 'tall', { left: 250, width: 60, height: 200 }),
      box('glass', 'set', { top: 210, width: 240, height: 80, glass: { thickness: 10 } }),
    ))
    const params = (t: typeof theme, id: string) => buildRenderList(s, t, 'light').glass.find(g => g.node.id === id)!.params
    const geometry = (t: typeof theme, id: string) => { const p = params(t, id); return [p.thickness, p.fillet, p.filletBottom] }
    const close = (got: number[], want: number[]) => want.forEach((w, i) => expect(got[i]).toBeCloseTo(w))
    close(geometry(theme, 'button'), [16, 4.8, 3.2])   // the spec's 80 pt reference button
    close(geometry(theme, 'tall'), [12, 3.6, 2.4])     // the width is the shorter side
    close(geometry(theme, 'set'), [10, 4.8, 3.2])      // an explicit value wins, per parameter
    const thin = { ...theme, glass: { ...theme.glass, thicknessRatio: 0.1, filletRatio: 0.05, filletBottomRatio: 0.02 } }
    close(geometry(thin, 'button'), [8, 4, 1.6])
  })

  it('takes glass defaults, including the variant, from the theme', () => {
    const custom = { ...theme, glass: { ...theme.glass, variant: 'clear' as const, envIntensity: 0.7, specularIntensity: 1.5, innerGlow: 0.2, adaptive: false } }
    const s = layout(surface(box('box', 'g', { bg: 'glass', width: 100, height: 40 })))
    expect(buildRenderList(s, custom, 'light').glass[0]!.params).toMatchObject({
      variant: 'clear', scatter: 0.02, envIntensity: 0.7, specularIntensity: 1.5, innerGlow: 0.2, adaptive: false,
    })
  })

  it('resolves explicit glass params, tint and glow split in the given scheme', () => {
    const s = layout(surface(box('glass', 'g', { width: 100, height: 40, glass: {
      thickness: 9, fillet: 2, filletBottom: 1, profile: 'lens', scatter: 0.3, lift: 0.2, edgeGlow: 0.1, ior: 1.33,
      dispersion: 0, roughness: 0.5, tint: 'accent', absorption: 0.4, glow: { color: '#ff0000', strength: 0.7, split: 0.5 }, cornerExponent: 3,
      envIntensity: 0.5, specularIntensity: 2, innerGlow: 0.3, adaptive: false, variant: 'clear',
    } })))
    expect(buildRenderList(s, theme, 'dark').glass[0]!.params).toEqual({
      thickness: 9, fillet: 2, filletBottom: 1, profile: 'lens', scatter: 0.3, lift: 0.2, edgeGlow: 0.1, ior: 1.33,
      dispersion: 0, roughness: 0.5, tint: resolveColor('accent', theme, 'dark'), absorption: 0.4,
      glow: { color: [1, 0, 0, 1], strength: 0.7, split: 0.5 }, cornerExponent: 3,
      envIntensity: 0.5, specularIntensity: 2, innerGlow: 0.3, adaptive: false, variant: 'clear',
    })
  })

  it('pools a glow by its strength: at 0 as clear glass (white, 0.28: an off switch), from 1 up in its colour at 0.5, in between in between', () => {
    const glow = (id: string, left: number, strength: number) => box('glass', id, { left, width: 100, height: 40, glass: { glow: { color: 'accent', strength } } })
    const s = layout(surface(glow('off', 0, 0), glow('half', 110, 0.5), glow('one', 220, 1), glow('on', 330, 1.1), box('glass', 'clear', { left: 440, width: 100, height: 40 })))
    const rl = buildRenderList(s, theme, 'light')
    const pool = (id: string) => rl.decorations.find(d => d.kind === 'pool' && d.node.id === id)!
    const accent = resolveColor('accent', theme, 'light')
    expect(pool('off')).toMatchObject({ color: [1, 1, 1, 1], strength: 0.28 })
    expect(pool('off').color).toEqual(pool('clear').color); expect(pool('off').strength).toBe(pool('clear').strength)
    for (const id of ['one', 'on']) expect(pool(id)).toMatchObject({ color: accent, strength: 0.5 })
    expect(pool('half').strength).toBeCloseTo(0.39, 12)
    pool('half').color.forEach((c, i) => expect(c).toBeCloseTo((accent[i]! + 1) / 2, 12))
    // a glow animating out (its visual strength) pools by where it has got to
    const off = s.root.children[0]!; off.setVisual({ glass: { glowStrength: 0.25 } })
    expect(buildRenderList(s, theme, 'light').decorations.find(d => d.kind === 'pool' && d.node === off)!.strength).toBeCloseTo(0.335, 12)
  })

  it('gives capsules a circular corner exponent unless one is set; rim and pool carry their glass\'s exponent', () => {
    const s = layout(surface(
      box('glass', 'pill', { width: 100, height: 40, radius: 'capsule' }),
      box('glass', 'squircle', { width: 100, height: 40, radius: 'capsule', glass: { cornerExponent: 5 } }),
      box('glass', 'round', { width: 100, height: 40, radius: 20 }),   // a capsule's radius, not written 'capsule': 4.5
    ))
    const rl = buildRenderList(s, theme, 'light')
    expect(rl.glass.map(g => g.params.cornerExponent)).toEqual([2, 5, 4.5])
    const of = (kind: 'rim' | 'pool') => rl.glass.map(g => rl.decorations.find(d => d.kind === kind && d.node === g.node)!.cornerExponent)
    expect(of('rim')).toEqual([2, 5, 4.5]); expect(of('pool')).toEqual([2, 5, 4.5])
  })

  it('layers each glass node as pool < glass < rim < its children, with no ties between neighbours', () => {
    const a = box('glass', 'a', { left: 0, width: 50, height: 40 }, box('text', 'a-label', { width: 50, height: 20 }))
    const b = box('glass', 'b', { left: 60, width: 50, height: 40 }); b.elevation = 2
    const c = box('glass', 'c', { left: 120, width: 50, height: 40 })
    const rl = buildRenderList(layout(surface(a, b, c)), theme, 'light')
    const z = (kind: string, id: string) => rl.decorations.find(d => d.kind === kind && d.node.id === id)!.z
    const glassZ = (id: string) => rl.glass.find(g => g.node.id === id)!.z
    expect(z('pool', 'a')).toBeLessThan(glassZ('a'))
    expect(glassZ('a')).toBeLessThan(z('rim', 'a'))
    expect(z('rim', 'a')).toBeLessThan(rl.text[0]!.z)
    expect(rl.text[0]!.z).toBeLessThan(z('pool', 'b'))
    expect(z('pool', 'b')).toBeLessThan(glassZ('b'))
    expect(z('rim', 'b')).toBeLessThan(z('pool', 'c'))   // adjacent siblings: b's rim stays under c's pool
    expect(rl.text[0]!.z).toBeLessThan(z('shadow', 'b')); expect(z('shadow', 'b')).toBeLessThan(z('pool', 'b'))   // raised: its shadow under its pool
    expect(rl.decorations.filter(d => d.node.id === 'b').map(d => d.elevation)).toEqual([2, 2, 2])
  })

  it('gives raised glass one black shadow just under its pool, with its shape, placement and elevation (spatial §11.7)', () => {
    const btn = box('glass', 'btn', { left: 10, top: 10, width: 80, height: 32, radius: 'capsule' }); btn.elevation = 8
    const card = box('glass', 'card', { left: 20, top: 20, width: 200, height: 120, radius: 16, overflow: 'hidden', opacity: 0.8, scale: 0.9, glass: { thickness: 3 } }, btn); card.elevation = 24
    card.tilt = { x: 0.05, y: -0.03 }
    const flat = box('glass', 'flat', { left: 240, top: 20, width: 100, height: 40 })
    const rl = buildRenderList(layout(surface(card, flat)), theme, 'light')
    const of = (kind: string, id: string) => rl.decorations.filter(d => d.kind === kind && d.node.id === id)
    const glass = (id: string) => rl.glass.find(g => g.node.id === id)!
    const g = glass('card'), shadows = of('shadow', 'card')
    expect(shadows).toHaveLength(1)
    expect(shadows[0]).toMatchObject({
      rect: g.rect, radius: g.radius, cornerExponent: g.params.cornerExponent, transform: g.transform, tilt: g.tilt, opacity: g.opacity, scale: g.scale,
      elevation: 24, color: [0, 0, 0, 1], strength: 1,
    })
    expect(shadows[0]).not.toHaveProperty('clip')                                     // no clipping ancestor
    expect(shadows[0]!.z).toBeCloseTo(sortKey(g.z, 'pool') - 0.05, 12)
    expect(shadows[0]!.z).toBeLessThan(of('pool', 'card')[0]!.z); expect(shadows[0]!.z).toBeGreaterThan(g.z - 0.5)
    expect(of('shadow', 'flat')).toEqual([])                                          // not raised: no shadow
    // glass lifted off raised glass casts its own, as high as it stands above that glass's top face: its composed
    // elevation (24 + 8) minus the card's top (its composed elevation 24 + its thickness 3) = 5; clipped as the glass is
    const b = glass('btn'), nested = of('shadow', 'btn')
    expect(b.elevation).toBe(32)
    expect(nested).toHaveLength(1)
    expect(nested[0]).toMatchObject({ rect: b.rect, radius: b.radius, cornerExponent: 2, elevation: 24 + 8 - (24 + 3), clip: b.clip, opacity: b.opacity, transform: b.transform })
    expect(nested[0]!.z).toBeCloseTo(sortKey(b.z, 'pool') - 0.05, 12)
  })

  it('a shadow falls on the face its glass sits on: the nearest glass ancestor\'s top, else the Surface plane', () => {
    // shadow elevation = composed elevation − (nearest glass ancestor's composed elevation + its thickness); without a
    // glass ancestor, the composed elevation. Emitted only above 0. Card: raised 24, 10 thick, so its top is at 34
    const flush = box('glass', 'flush', { left: 10, top: 10, width: 60, height: 30 })                           // own 0: 24 − 34
    const low = box('glass', 'low', { left: 80, top: 10, width: 60, height: 30 }); low.elevation = 8             // 32 − 34 = −2
    const high = box('glass', 'high', { left: 10, top: 60, width: 60, height: 30 }); high.elevation = 12         // 36 − 34 = 2
    const wrap = box('box', 'wrap', { left: 80, top: 60, width: 100, height: 50 }, box('glass', 'deep', { width: 40, height: 20 }))
    wrap.elevation = 16                                                               // a box between: still the card's face, 40 − 34 = 6
    const card = box('glass', 'card', { left: 20, top: 20, width: 240, height: 160, glass: { thickness: 10 } }, flush, low, high, wrap); card.elevation = 24
    const lifted = box('box', 'lifted', { left: 280, top: 20, width: 100, height: 100 }, box('glass', 'onBox', { width: 40, height: 20 })); lifted.elevation = 6
    const rl = buildRenderList(layout(surface(card, lifted)), theme, 'light')
    const shadows = Object.fromEntries(rl.decorations.filter(d => d.kind === 'shadow').map(d => [d.node.id, d.elevation]))
    expect(shadows).toEqual({ card: 24, high: 2, deep: 6, onBox: 6 })                  // a raised box is no glass: the plane
    expect(rl.glass.find(g => g.node.id === 'flush')!.elevation).toBe(24)              // its glass keeps the composed elevation
  })

  it('clips to the intersection of overflow hidden/scroll ancestors and scroll nodes, decorations included', () => {
    const g = box('glass', 'g', { left: 0, top: 50, width: 80, height: 40 })
    const img = box('image', 'img', { left: 0, top: 0, width: 30, height: 30 }); img.setProp('src', 'a.png')
    const list = box('scroll', 'list', { left: 10, top: 10, width: 100, height: 100, radius: 10 }, g, img); list.setProp('scrollY', 30)
    const side = box('box', 'side', { left: 200, top: 0, width: 20, height: 20, bg: 'fill' })
    const outer = box('box', 'outer', { left: 50, top: 0, width: 300, height: 60, radius: 20, overflow: 'scroll' }, list, side)
    const rl = buildRenderList(layout(surface(outer)), theme, 'light')
    const clip = { x: 60, y: 10, width: 100, height: 50, radius: 10, transform: IDENTITY }   // the inner rect intersection, the innermost radius
    expect(rl.panels.find(p => p.node.id === 'side')!.clip).toEqual({ x: 50, y: 0, width: 300, height: 60, radius: 20, transform: IDENTITY })
    expect(rl.glass[0]).toMatchObject({ rect: { x: 60, y: 30, width: 80, height: 40 }, clip })
    expect(rl.decorations.map(d => d.clip)).toEqual([clip, clip])
    expect(rl.images[0]).toMatchObject({ src: 'a.png', rect: { x: 60, y: -20, width: 30, height: 30 }, clip, elevation: 0 })
  })

  it('carries each node\'s effective scale (default 1) on all its instances, without touching layout', () => {
    const btn = box('glass', 'btn', { width: 120, height: 40, pressed: { scale: 0.96 } })
    const label = box('text', 'label', { top: 50, width: 50, height: 20, scale: 1.1 })
    const panel = box('box', 'panel', { top: 80, width: 50, height: 20, bg: 'fill', hover: { scale: 1.03 } })
    const img = box('image', 'img', { top: 110, width: 20, height: 20 })
    const s = layout(surface(btn, label, panel, img))
    const scales = (rl: RenderList) => [
      rl.glass[0]!.scale, ...rl.decorations.map(d => d.scale), rl.text[0]!.scale, rl.panels[0]!.scale, rl.images[0]!.scale,
    ]
    expect(scales(buildRenderList(s, theme, 'light'))).toEqual([1, 1, 1, 1.1, 1, 1])
    btn.setState({ pressed: true }); panel.setState({ hover: true })
    expect(scales(buildRenderList(s, theme, 'light'))).toEqual([0.96, 0.96, 0.96, 1.1, 1.03, 1])
    expect(s.root.dirty.layout).toBe(false)   // a render-time transform: no new layout
  })

  it('multiplies scale down the tree, so a pressed button shrinks its label too', () => {
    const label = box('text', 'label', { width: 50, height: 20 })
    const btn = box('glass', 'btn', { width: 120, height: 40, pressed: { scale: 0.96 } }, label)
    const inner = box('box', 'inner', { width: 20, height: 20, bg: 'fill', scale: 0.5 })
    const outer = box('box', 'outer', { top: 50, width: 50, height: 50, bg: 'fill', scale: 0.5 }, inner)
    const s = layout(surface(btn, outer))
    btn.setState({ pressed: true })
    const rl = buildRenderList(s, theme, 'light')
    expect(rl.glass[0]!.scale).toBeCloseTo(0.96)
    expect(rl.text[0]!.scale).toBeCloseTo(0.96)
    expect(rl.decorations.map(d => d.scale)).toEqual([0.96, 0.96])
    expect(rl.panels.map(p => [p.node.id, p.scale])).toEqual([['outer', 0.5], ['inner', 0.25]])
  })

  it('leaves clip absent outside clipping ancestors', () => {
    const rl = buildRenderList(layout(surface(box('box', 'p', { bg: 'fill', width: 10, height: 10 }))), theme, 'light')
    expect(rl.panels[0]).not.toHaveProperty('clip')
    expect(rl.panels[0]).not.toHaveProperty('border')
  })

  it('emits a transparent panel for a border without a background', () => {
    const s = layout(surface(box('box', 'outline', { width: 50, height: 20, border: { width: 1, color: 'separator' } })))
    expect(buildRenderList(s, theme, 'light').panels[0]).toMatchObject({
      color: [0, 0, 0, 0], border: { width: 1, color: resolveColor('separator', theme, 'light') },
    })
  })

  it('resolves concentric radii against the parent, the root against the surface corner', () => {
    const s = createSurface({ width: 200, height: 100, cornerRadius: 30 })
    s.root.setStyle({ padding: 6, radius: 'concentric', bg: 'fill' })
    const card = new Node('box', 'card'); card.setStyle({ flexGrow: 1, padding: 8, radius: 'concentric', bg: 'fill' })
    const btn = new Node('box', 'btn'); btn.setStyle({ height: 40, radius: 'concentric', bg: 'accent' })
    s.root.appendChild(card); card.appendChild(btn)
    layout(s)
    expect(buildRenderList(s, theme, 'light').panels.map(p => p.radius)).toEqual([30, 24, 16])
  })

  it('clamps radii to half the shorter side', () => {
    const s = layout(surface(box('box', 'thin', { width: 100, height: 10, radius: 'xl', bg: 'fill' })))
    expect(buildRenderList(s, theme, 'light').panels[0]!.radius).toBe(5)
  })

  it('gives text its content box: the effective padding, specific edges over X/Y over all', () => {
    const t = box('text', 't', { left: 10, top: 20, width: 100, height: 40, padding: 8 })
    const mixed = box('text', 'mixed', { left: 0, top: 100, width: 100, height: 40, padding: 2, paddingX: 4, paddingTop: 6, paddingRight: 1 })
    // Layout reads the effective style too: the focused padding grows the auto-height box around the 22 pt measure.
    const grown = box('text', 'grown', { left: 0, top: 200, width: 100, focused: { paddingY: 10 } }); grown.setState({ focused: true })
    const s = layout(surface(t, mixed, grown))
    expect(grown.layout.height).toBe(42)
    expect(buildRenderList(s, theme, 'light').text.map(x => x.rect)).toEqual([
      { x: 18, y: 28, width: 84, height: 24 },
      { x: 4, y: 106, width: 95, height: 32 },
      { x: 0, y: 210, width: 100, height: 22 },
    ])
    t.setStyle({ hover: { padding: 10 } }); t.setState({ hover: true })
    layout(s)
    expect(buildRenderList(s, theme, 'light').text[0]!.rect).toEqual({ x: 20, y: 30, width: 80, height: 20 })
  })

  it('resolves text with resolveTextStyle: lineHeight in pt, letterSpacing and wrap always, maxLines only when set', () => {
    const plain = box('text', 'plain', { width: 50, height: 20 }); plain.setProp('value', 'Hi')
    const styled = box('text', 'styled', { width: 50, height: 20, font: 'mono', fontSize: 'sm', fontWeight: 700, color: 'accent', maxLines: 2, lineHeight: 1.4, letterSpacing: 0.5, wrap: false })
    const rl = buildRenderList(layout(surface(plain, styled)), theme, 'dark')
    expect(rl.text[0]).toEqual({
      node: plain, rect: plain.layout, text: 'Hi', font: { family: 'system-ui', size: theme.fontSize.base, weight: 400 },
      color: resolveColor('label', theme, 'dark'), align: 'left', lineHeight: 22, letterSpacing: 0, wrap: true, z: sortKey(1, 'content'),
      elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1,
    })
    expect(rl.text[1]).toMatchObject({
      text: '', font: { family: 'mono', size: theme.fontSize.sm, weight: 700 }, color: resolveColor('accent', theme, 'dark'),
      maxLines: 2, lineHeight: 20, letterSpacing: 0.5, wrap: false,   // 1.4 × 14 pt = 19.6
    })
  })
})

describe('focus ring (Plan 3 seams)', () => {
  it('draws the focus ring around a visibly focused node, outside its rect', () => {
    const s = createSurface({ width: 200, height: 100 })
    const b = new Node('glass', 'b'); b.setStyle({ position: 'absolute', left: 20, top: 20, width: 100, height: 40, radius: 8 })
    b.setState({ focused: true, focusVisible: true })
    s.root.appendChild(b); layout(s)
    const ring = buildRenderList(s, theme, 'light').panels.find(p => p.node === b)!
    expect(ring.rect).toEqual({ x: 17, y: 17, width: 106, height: 46 })
    expect(ring.radius).toBe(11); expect(ring.color).toEqual([0, 0, 0, 0])
    expect(ring.border).toEqual({ width: FOCUS_RING.width, color: resolveColor('accent', theme, 'light') })
    b.setState({ focusVisible: false })
    expect(buildRenderList(s, theme, 'light').panels.find(p => p.node === b)).toBeUndefined()
    b.setState({ focusVisible: true }); b.setProp('focusRing', false)
    expect(buildRenderList(s, theme, 'light').panels.find(p => p.node === b)).toBeUndefined()
  })
  it('sits in the node\'s pool layer with its transform, opacity and clip, beside its own panel; focusVisible alone draws nothing', () => {
    const b = box('box', 'b', { left: 10, top: 10, width: 60, height: 30, bg: 'fill', radius: 'capsule', scale: 0.5, opacity: 0.5 })
    const card = box('box', 'card', { left: 0, top: 0, width: 100, height: 100, overflow: 'hidden' }, b)
    const s = layout(surface(card))
    b.setState({ focused: true, focusVisible: true })
    const [own, ring] = buildRenderList(s, theme, 'light').panels.filter(p => p.node === b)
    expect(ring!.z).toBe(sortKey(own!.z, 'pool')); expect(ring!.radius).toBe(15 + FOCUS_RING.offset)
    expect([ring!.transform, ring!.opacity, ring!.clip]).toEqual([own!.transform, own!.opacity, own!.clip])
    b.setState({ focused: false })
    expect(buildRenderList(s, theme, 'light').panels.filter(p => p.node === b)).toHaveLength(1)
  })
})

describe('effectiveStyle', () => {
  it('returns the base style without branches when no state applies', () => {
    const n = new Node('box'); n.setStyle({ opacity: 0.9, hover: { opacity: 0.5 } })
    expect(effectiveStyle(n)).toEqual({ opacity: 0.9 })
  })

  it('merges hover, focused, pressed, then disabled', () => {
    const n = new Node('box')
    n.setStyle({ bg: 'fill', opacity: 1, hover: { bg: 'accent', opacity: 0.9 }, focused: { opacity: 0.8 }, pressed: { opacity: 0.7, color: 'label' }, disabled: { opacity: 0.3 } })
    n.setState({ hover: true, focused: true })
    expect(effectiveStyle(n)).toEqual({ bg: 'accent', opacity: 0.8 })
    n.setState({ pressed: true })
    expect(effectiveStyle(n)).toEqual({ bg: 'accent', opacity: 0.7, color: 'label' })
    n.setState({ disabled: true })
    expect(effectiveStyle(n)).toEqual({ bg: 'accent', opacity: 0.3, color: 'label' })
  })

  it('merges glass and transition key by key, and ignores undefined branch values', () => {
    const n = new Node('glass')
    n.setStyle({
      opacity: 0.9, glass: { thickness: 20, glow: { color: 'accent', strength: 1.1 } }, transition: { opacity: 'snappy' },
      hover: { opacity: undefined, glass: { lift: 0.3, thickness: undefined }, transition: { scale: 'bouncy' } },
      pressed: { glass: { glow: null } },
    })
    n.setState({ hover: true })
    expect(effectiveStyle(n)).toEqual({
      opacity: 0.9, glass: { thickness: 20, glow: { color: 'accent', strength: 1.1 }, lift: 0.3 }, transition: { opacity: 'snappy', scale: 'bouncy' },
    })
    n.setState({ pressed: true })
    expect(effectiveStyle(n).glass).toEqual({ thickness: 20, glow: null, lift: 0.3 })
    expect(n.style.glass).toEqual({ thickness: 20, glow: { color: 'accent', strength: 1.1 } })
    const bare = new Node('glass'); bare.setStyle({ focused: { glass: { lift: 0.2, thickness: undefined } } }); bare.setState({ focused: true })
    expect(effectiveStyle(bare).glass).not.toHaveProperty('thickness')
  })
})

describe('createSurface', () => {
  it('fills defaults and sizes the root', () => {
    const s = createSurface({ id: 'main', width: 320, height: 200 })
    expect(s).toMatchObject({ id: 'main', width: 320, height: 200, ptPerUnit: 244, placement: 'screen', background: 'none', cornerRadius: 0 })
    expect(s.root.id).toBe('main-root')
    expect(s.root.type).toBe('box')
    expect(s.root.style).toEqual({ width: 320, height: 200 })
    expect(createSurface({ width: 1, height: 1 }).id).toMatch(/^surface-\d+$/)
    expect(createSurface({ width: 1, height: 1, placement: 'world', background: 'glass', ptPerUnit: 100, cornerRadius: 12 }))
      .toMatchObject({ placement: 'world', background: 'glass', ptPerUnit: 100, cornerRadius: 12 })
  })
})

describe('transform, opacity and clip composition (Plan 2 seams)', () => {
  function tree() {
    const s = createSurface({ id: 't', width: 400, height: 400 })
    const outer = new Node('box', 'outer'); outer.setStyle({ position: 'absolute', left: 100, top: 100, width: 200, height: 200, bg: 'fill', scale: 0.5, opacity: 0.5, overflow: 'hidden', radius: 20 })
    const inner = new Node('box', 'inner'); inner.setStyle({ position: 'absolute', left: 50, top: 50, width: 100, height: 100, bg: 'accent', scale: 2, opacity: 0.5 })
    const glass = new Node('glass', 'g'); glass.setStyle({ position: 'absolute', left: 0, top: 0, width: 40, height: 40 }); glass.tilt = { x: 0.1, y: 0 }
    const label = new Node('text', 'l'); label.setProp('value', 'x')
    s.root.appendChild(outer); outer.appendChild(inner); inner.appendChild(glass); glass.appendChild(label)
    engine.compute(s.root, 400, 400, () => ({ width: 10, height: 10 }))
    return { s, outer, inner, glass, label }
  }
  it('composes scale about each node centre down the chain', () => {
    const { s } = tree()
    const rl = buildRenderList(s, theme, 'light')
    const outer = rl.panels.find(p => p.node.id === 'outer')!, inner = rl.panels.find(p => p.node.id === 'inner')!
    // outer: 200×200 at (100,100), centre (200,200), scale .5 → its own corner maps to (150,150)
    expect(apply(outer.transform, 100, 100)).toEqual([150, 150])
    // inner: 100×100 at (150,150), centre (200,200): scale 2 about its centre, then outer's .5 about (200,200) → net 1 about (200,200)
    expect(apply(inner.transform, 150, 150)).toEqual([150, 150])
    expect(inner.scale).toBe(1)
  })
  it('multiplies opacity down the tree and carries tilt', () => {
    const { s } = tree()
    const rl = buildRenderList(s, theme, 'light')
    expect(rl.panels.find(p => p.node.id === 'inner')!.opacity).toBeCloseTo(0.25)
    expect(rl.glass[0]!.opacity).toBeCloseTo(0.25)
    expect(rl.text[0]!.opacity).toBeCloseTo(0.25)
    expect(rl.glass[0]!.tilt).toEqual({ x: 0.1, y: 0 })
    expect(rl.text[0]!.tilt).toEqual({ x: 0, y: 0 })
  })
  it('clips carry the clipping ancestor transform and stay in its untransformed space', () => {
    const { s } = tree()
    const rl = buildRenderList(s, theme, 'light')
    const inner = rl.panels.find(p => p.node.id === 'inner')!
    expect(inner.clip).toMatchObject({ x: 100, y: 100, width: 200, height: 200, radius: 20 })
    expect(apply(inner.clip!.transform, 100, 100)).toEqual([150, 150])
  })
  it('orders pool < glass < content < rim within one node and uses sortKey', () => {
    const { s } = tree()
    const rl = buildRenderList(s, theme, 'light')
    const g = rl.glass[0]!, pool = rl.decorations.find(d => d.kind === 'pool')!, rim = rl.decorations.find(d => d.kind === 'rim')!
    expect(pool.z).toBe(sortKey(g.z, 'pool')); expect(rim.z).toBe(sortKey(g.z, 'rim'))
    expect(rl.text[0]!.z).toBe(sortKey(g.z + 1, 'content'))        // the label is the glass node's only child: next pre-order index
    expect(pool.z).toBeLessThan(g.z); expect(g.z).toBeLessThan(sortKey(g.z, 'content')); expect(sortKey(g.z, 'content')).toBeLessThan(rim.z)
    // The label is another node: its content, at the next pre-order index, draws above the glass's rim (as in Plan 1).
    expect(rim.z).toBeLessThan(rl.text[0]!.z)
  })
  it('reads visual values instead of style and layout targets', () => {
    const { s, outer, inner } = tree()
    outer.setVisual({ x: 110, y: 100, scale: 1, opacity: 1 })
    inner.setVisual({ bg: [0, 1, 0, 1], radius: 7, elevation: 3 })
    const rl = buildRenderList(s, theme, 'light')
    const o = rl.panels.find(p => p.node.id === 'outer')!, i = rl.panels.find(p => p.node.id === 'inner')!
    expect(o.rect.x).toBe(110); expect(o.scale).toBe(1)
    expect(i.rect.x).toBe(160)                       // child follows the parent's visual position
    expect(i.color).toEqual([0, 1, 0, 1]); expect(i.radius).toBe(7); expect(i.elevation).toBe(3)
    expect(i.opacity).toBeCloseTo(0.5)               // own .5 × parent's visual 1
  })
  it('visual glass values override resolved glass params', () => {
    const { s, glass } = tree()
    glass.setStyle({ glass: { glow: { color: 'accent', strength: 1 } } })
    glass.setVisual({ glass: { glowStrength: 0.25, thickness: 3, glowColor: [1, 0, 0, 1] } })
    const rl = buildRenderList(s, theme, 'light')
    expect(rl.glass[0]!.params.glow).toEqual({ color: [1, 0, 0, 1], strength: 0.25 })
    expect(rl.glass[0]!.params.thickness).toBe(3)
  })
})

describe('glass containers (GlassContainer, spec §5.2)', () => {
  /** An absolutely placed `w × h` glass node at (left, top), a capsule. */
  const glass = (left: number, top: number, width: number, height: number, id?: string): Node => {
    const n = new Node('glass', id); n.setStyle({ position: 'absolute', left, top, width, height, radius: 'capsule' }); return n
  }
  const layoutOf = (s: ReturnType<typeof createSurface>) => engine.compute(s.root, s.width, s.height, () => ({ width: 80, height: 22 }))

  it('fuses glass within spacing under a glassContainer, keeps the rest single', () => {
    const s = createSurface({ width: 400, height: 100 })
    const box = new Node('box'); box.setProp('glassContainer', { spacing: 16 }); box.setStyle({ width: 400, height: 100, flexDirection: 'row' })
    const a = glass(0, 0, 80, 40), b = glass(90, 0, 80, 40), c = glass(300, 0, 80, 40)    // a–b gap 10 ≤ 16, c far
    box.appendChild(a); box.appendChild(b); box.appendChild(c); s.root.appendChild(box); layoutOf(s)
    const rl = buildRenderList(s, theme, 'light')
    expect(rl.fused).toHaveLength(1); expect(rl.fused[0]!.members.map(m => m.node)).toEqual([a, b])
    expect(rl.glass.map(g => g.node)).toEqual([c])
    expect(rl.decorations.filter(d => d.kind === 'rim').map(d => d.node)).toEqual([c])
    expect(rl.decorations.filter(d => d.kind === 'pool').map(d => d.node).sort()).toEqual([a, b, c].sort())
  })
  it('a pressed member fuses with its shrunken shape', () => {
    const s = createSurface({ width: 400, height: 100 })
    const box = new Node('box'); box.setProp('glassContainer', { spacing: 16 }); box.setStyle({ width: 400, height: 100 })
    const a = glass(0, 0, 80, 40), b = glass(90, 0, 80, 40); box.appendChild(a); box.appendChild(b); s.root.appendChild(box); layoutOf(s)
    a.setVisual({ scale: 0.9 })
    const f = buildRenderList(s, theme, 'light').fused[0]!
    expect(f.shapes[0]).toMatchObject({ x: 4, y: 2, width: 72, height: 36 })          // 80 × 40 at (0, 0) scaled 0.9 about its centre
    expect(f.shapes[1]).toMatchObject({ x: 90, y: 0, width: 80, height: 40 })
    expect(f.shapes[0]!.radius).toBeCloseTo(18); expect(f.shapes[1]!.radius).toBe(20)  // capsule radii, scaled with their shapes
  })
  it('the fused instance: the container\'s node, the first member\'s clip, z and slab geometry, the raised member\'s elevation and look, untransformed and untilted', () => {
    const s = createSurface({ width: 400, height: 100 })
    const clip = new Node('box', 'clip'); clip.setStyle({ position: 'absolute', left: 0, top: 0, width: 300, height: 100, overflow: 'hidden' })
    const box = new Node('box', 'box'); box.setProp('glassContainer', { spacing: 16 }); box.setStyle({ position: 'absolute', left: 10, top: 20, width: 300, height: 60, opacity: 0.5 })
    const a = glass(0, 0, 80, 40, 'a'), b = glass(90, 10, 60, 30, 'b')
    a.setStyle({ glass: { thickness: 7 } }); b.elevation = 6; b.tilt = { x: 0.05, y: 0 }
    box.appendChild(a); box.appendChild(b); clip.appendChild(box); s.root.appendChild(clip); layoutOf(s)
    const rl = buildRenderList(s, theme, 'light')
    const f = rl.fused[0]!, [ma, mb] = f.members
    expect(f.node).toBe(box); expect(f.spacing).toBe(16)
    expect(f.params).toEqual({ ...mb!.params, thickness: 7, fillet: ma!.params.fillet, filletBottom: ma!.params.filletBottom, profile: ma!.params.profile })   // b lifts the slab
    expect(f.elevation).toBe(6); expect(mb!.elevation).toBe(6); expect(ma!.elevation).toBe(0)
    expect(f.opacity).toBe(0.5); expect(f.z).toBe(ma!.z); expect(f.clip).toEqual(ma!.clip); expect(f.clip).toMatchObject({ x: 0, y: 0, width: 300, height: 100 })
    expect(f.transform).toEqual(IDENTITY); expect(f.tilt).toEqual({ x: 0, y: 0 }); expect(f.scale).toBe(1)
    expect(f.rect).toEqual({ x: 10, y: 20, width: 150, height: 40 })                  // the shapes' bounds
    expect(mb!.tilt).toEqual({ x: 0.05, y: 0 })                                       // the member keeps its own
    expect(rl.decorations.filter(d => d.kind === 'shadow').map(d => d.node)).toEqual([b])   // members keep their shadows
  })
  it('joins transitively; an unrelated layout keeps no fused list', () => {
    const s = createSurface({ width: 400, height: 100 })
    const box = new Node('box'); box.setProp('glassContainer', { spacing: 12 }); box.setStyle({ width: 400, height: 100 })
    const a = glass(0, 0, 40, 40), b = glass(50, 0, 40, 40), c = glass(100, 0, 40, 40), d = glass(200, 0, 40, 40), e = glass(250, 0, 40, 40)
    for (const n of [a, b, c, d, e]) box.appendChild(n)
    s.root.appendChild(box); layoutOf(s)
    const rl = buildRenderList(s, theme, 'light')
    expect(rl.fused.map(f => f.members.map(m => m.node))).toEqual([[a, b, c], [d, e]])   // a–c 60 apart, joined through b
    expect(rl.glass).toEqual([])
    const plain = createSurface({ width: 400, height: 100 }); plain.root.appendChild(glass(0, 0, 40, 40)); plain.root.appendChild(glass(45, 0, 40, 40)); layoutOf(plain)
    const none = buildRenderList(plain, theme, 'light')
    expect(none.fused).toEqual([]); expect(none.glass).toHaveLength(2)
  })
  it('the gap is the distance between the shapes, rounded corners included, and must be under the spacing (as the fused outline joins them)', () => {
    const s = createSurface({ width: 400, height: 200 })
    const box = new Node('box'); box.setProp('glassContainer', { spacing: 16 }); box.setStyle({ width: 400, height: 200 })
    const a = glass(0, 0, 40, 40), b = glass(52, 52, 40, 40)           // squares 12 × 12 apart: 17 pt > 16
    for (const n of [a, b]) n.setStyle({ radius: 0 })
    box.appendChild(a); box.appendChild(b); s.root.appendChild(box); layoutOf(s)
    expect(buildRenderList(s, theme, 'light').fused).toEqual([])
    b.setStyle({ left: 50, top: 50 }); layoutOf(s)                      // 10 × 10: 14 pt
    expect(buildRenderList(s, theme, 'light').fused).toHaveLength(1)
    // 44 pt circles 8 × 8 apart diagonally: their bounds 11.3 pt apart, their arcs 29.5 (the outline would not bridge them)
    const c = glass(0, 0, 44, 44), d = glass(52, 52, 44, 44)
    box.removeChild(a); box.removeChild(b); box.appendChild(c); box.appendChild(d); layoutOf(s)
    expect(buildRenderList(s, theme, 'light').fused).toEqual([])
    d.setStyle({ left: 36, top: 36 }); layoutOf(s)                      // centres 50.9 apart: arcs 6.9 apart
    expect(buildRenderList(s, theme, 'light').fused).toHaveLength(1)
    // exactly the spacing apart: not joined (the outline would only pinch there)
    d.setStyle({ left: 60, top: 0 }); layoutOf(s)
    expect(buildRenderList(s, theme, 'light').fused).toEqual([])
    d.setStyle({ left: 59 }); layoutOf(s)                               // 15 pt (layout rounds to whole pt)
    expect(buildRenderList(s, theme, 'light').fused).toHaveLength(1)
  })
  it('only plain members fuse: a glowing or tinted one (a primary Button) stays single with its rim and glow, and the cluster splits around it', () => {
    const s = createSurface({ width: 400, height: 100 })
    const box = new Node('box'); box.setProp('glassContainer', { spacing: 16 }); box.setStyle({ width: 400, height: 100 })
    const a = glass(0, 0, 80, 40, 'a'), p = glass(90, 0, 80, 40, 'primary'), c = glass(180, 0, 80, 40, 'c')
    p.setStyle({ glass: { glow: { color: 'accent', strength: 1.1 }, tint: 'accent', absorption: 1.4 } })
    box.appendChild(a); box.appendChild(p); box.appendChild(c); s.root.appendChild(box); layoutOf(s)
    let rl = buildRenderList(s, theme, 'light')
    expect(rl.fused).toEqual([])                                                       // a and c are 100 pt apart without it
    expect(rl.glass.map(g => g.node.id)).toEqual(['a', 'primary', 'c'])
    expect(rl.decorations.filter(d => d.kind === 'rim').map(d => d.node.id)).toEqual(['a', 'primary', 'c'])
    expect(rl.glass[1]!.params.glow).toMatchObject({ strength: 1.1 })
    // beside two plain ones: they fuse, it stays single
    p.setStyle({ left: 180 }); c.setStyle({ left: 90 }); layoutOf(s)
    rl = buildRenderList(s, theme, 'light')
    expect(rl.fused.map(f => f.members.map(m => m.node.id))).toEqual([['a', 'c']])
    expect(rl.glass.map(g => g.node.id)).toEqual(['primary']); expect(rl.decorations.filter(d => d.kind === 'rim').map(d => d.node.id)).toEqual(['primary'])
    // tinted alone, or a variant of its own, keeps it single too; a glow of strength 0 (a Switch that is off) fuses
    p.setStyle({ glass: { tint: 'accent' } })
    expect(buildRenderList(s, theme, 'light').fused[0]!.members.map(m => m.node.id)).toEqual(['a', 'c'])
    p.setStyle({ glass: { variant: 'clear' } })
    expect(buildRenderList(s, theme, 'light').fused[0]!.members.map(m => m.node.id)).toEqual(['a', 'c'])
    p.setStyle({ glass: { glow: { color: 'accent', strength: 0 } } })
    expect(buildRenderList(s, theme, 'light').fused[0]!.members.map(m => m.node.id)).toEqual(['a', 'primary', 'c'])
  })
  it('membership follows the style\'s target glow and tint, not the animated values (a glow springing through 0 flips nothing)', () => {
    const s = createSurface({ width: 400, height: 100 })
    const box = new Node('box'); box.setProp('glassContainer', { spacing: 16 }); box.setStyle({ width: 400, height: 100 })
    const a = glass(0, 0, 80, 40, 'a'), b = glass(90, 0, 80, 40, 'b')
    box.appendChild(a); box.appendChild(b); s.root.appendChild(box); layoutOf(s)
    const fused = () => buildRenderList(s, theme, 'light').fused.map(f => f.members.map(m => m.node.id))
    // turning on: the target glows, its spring is still at (or overshooting below) 0: it stands apart from the start
    b.setStyle({ glass: { glow: { color: 'accent', strength: 1.1 } } })
    for (const v of [0, -0.08]) { b.setVisual({ glass: { glowStrength: v } }); expect(fused()).toEqual([]) }
    // turning off: the target has no glow (or strength 0), the spring still glows: it fuses at once
    b.setStyle({ glass: { glow: { color: 'accent', strength: 0 } } }); b.setVisual({ glass: { glowStrength: 0.6 } })
    expect(fused()).toEqual([['a', 'b']])
    b.setStyle({ glass: {} }); expect(fused()).toEqual([['a', 'b']])
    // the tint likewise: an animated tint on an untinted target fuses, a cleared one on a tinted target does not
    b.setVisual({ glass: { tint: [1, 1, 1, 0.3] } }); expect(fused()).toEqual([['a', 'b']])
    b.setStyle({ glass: { tint: 'accent' } }); b.setVisual({ glass: { tint: null } }); expect(fused()).toEqual([])
  })
  it('the member that lifts the slab leads its look (a hover glint on any member shows on the slab); a pressed or hovered one leads a tie; opacity is the largest', () => {
    const s = createSurface({ width: 400, height: 100 })
    const box = new Node('box'); box.setProp('glassContainer', { spacing: 16 }); box.setStyle({ width: 400, height: 100 })
    const a = glass(0, 0, 80, 40, 'a'), b = glass(90, 0, 60, 30, 'b'), c = glass(160, 0, 80, 40, 'c')
    for (const n of [a, b, c]) n.setStyle({ hover: { glass: { specularIntensity: 1.35, edgeGlow: 1.1 } } })
    box.appendChild(a); box.appendChild(b); box.appendChild(c); s.root.appendChild(box); layoutOf(s)
    const slab = () => buildRenderList(s, theme, 'light').fused[0]!
    expect(slab().params.specularIntensity).toBe(theme.glass.specularIntensity)        // at rest: the first member's
    b.setState({ hover: true }); b.elevation = 6
    let f = slab()
    expect(f.elevation).toBe(6); expect(f.params.specularIntensity).toBe(1.35); expect(f.params.edgeGlow).toBe(1.1)   // b's glint
    expect(f.params.thickness).toBe(f.members[0]!.params.thickness); expect(f.params.thickness).not.toBe(f.members[1]!.params.thickness)   // the slab keeps a's height
    b.elevation = 0                                                                    // a tie: the hovered member leads
    expect(slab().params.specularIntensity).toBe(1.35)
    b.setState({ hover: false }); c.setState({ pressed: true }); c.setStyle({ pressed: { glass: { edgeGlow: 0.5 } } })
    expect(slab().params.edgeGlow).toBe(0.5)                                           // the pressed one
    c.setState({ pressed: false }); a.setStyle({ opacity: 0.4 }); b.setStyle({ opacity: 0.7 })
    f = slab()
    expect(f.params).toBe(f.members[0]!.params); expect(f.opacity).toBe(1)              // c's (the largest)
  })
  it('glass inside a member rides on it (not a member); a nested container takes its own glass', () => {
    const s = createSurface({ width: 400, height: 200 })
    const box = new Node('box', 'outer'); box.setProp('glassContainer', { spacing: 16 }); box.setStyle({ width: 400, height: 200 })
    const a = glass(0, 0, 100, 60, 'a'), b = glass(110, 0, 100, 60, 'b')
    const knob = glass(10, 10, 20, 20, 'knob'); a.appendChild(knob)
    const inner = new Node('box', 'inner'); inner.setProp('glassContainer', { spacing: 4 }); inner.setStyle({ position: 'absolute', left: 0, top: 100, width: 400, height: 60 })
    const c = glass(0, 0, 40, 40, 'c'), d = glass(42, 0, 40, 40, 'd')
    inner.appendChild(c); inner.appendChild(d)
    box.appendChild(a); box.appendChild(b); box.appendChild(inner); s.root.appendChild(box); layoutOf(s)
    const rl = buildRenderList(s, theme, 'light')
    expect(rl.fused.map(f => [f.node.id, f.members.map(m => m.node.id)])).toEqual([['inner', ['c', 'd']], ['outer', ['a', 'b']]])
    expect(rl.glass.map(g => g.node.id)).toEqual(['knob'])
    expect(rl.decorations.filter(dd => dd.kind === 'rim').map(dd => dd.node.id)).toEqual(['knob'])
  })
  it('an empty member stays single; a bad spacing throws a GlassUIError naming the prop', () => {
    const s = createSurface({ width: 400, height: 100 })
    const box = new Node('box'); box.setProp('glassContainer', { spacing: 16 }); box.setStyle({ width: 400, height: 100 })
    const a = glass(0, 0, 40, 40), b = glass(44, 0, 0, 40)
    box.appendChild(a); box.appendChild(b); s.root.appendChild(box); layoutOf(s)
    expect(buildRenderList(s, theme, 'light').fused).toEqual([])
    // the bad value is in the message (GlassUIError prints `got` only beside `allowed`), as core's other single-value errors
    for (const [bad, got] of [[{ spacing: -1 }, '-1'], [{ spacing: Number.NaN }, 'NaN'], [{ spacing: '16' }, '"16"'], [{}, 'undefined'], [16, '16（glassContainer 写成 { spacing: 16 }）']] as const) {
      box.setProp('glassContainer', bad)
      expect(() => buildRenderList(s, theme, 'light')).toThrow(`[glassContainer.spacing] 必须是不小于 0 的有限数（pt），得到 ${got}`)
    }
    box.setProp('glassContainer', null)
    expect(buildRenderList(s, theme, 'light').glass).toHaveLength(2)
  })
})
