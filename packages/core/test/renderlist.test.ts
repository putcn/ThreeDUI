import { describe, it, expect, beforeAll } from 'vitest'
import { Node } from '../src/node'
import { createYogaLayout, type LayoutEngine } from '../src/layout/yoga'
import { createSurface } from '../src/surface'
import { buildRenderList, type RenderList } from '../src/renderlist'
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
    expect(rl.decorations.map(d => d.kind).sort()).toEqual(['pool', 'rim'])
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
    expect(rl.text[0]!.z).toBe(3)
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

  it('gives capsules a circular corner exponent unless one is set', () => {
    const s = layout(surface(
      box('glass', 'pill', { width: 100, height: 40, radius: 'capsule' }),
      box('glass', 'squircle', { width: 100, height: 40, radius: 'capsule', glass: { cornerExponent: 5 } }),
    ))
    expect(buildRenderList(s, theme, 'light').glass.map(g => g.params.cornerExponent)).toEqual([2, 5])
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
    expect(rl.decorations.filter(d => d.node.id === 'b').map(d => d.elevation)).toEqual([2, 2])
  })

  it('clips to the intersection of overflow hidden/scroll ancestors and scroll nodes, decorations included', () => {
    const g = box('glass', 'g', { left: 0, top: 50, width: 80, height: 40 })
    const img = box('image', 'img', { left: 0, top: 0, width: 30, height: 30 }); img.setProp('src', 'a.png')
    const list = box('scroll', 'list', { left: 10, top: 10, width: 100, height: 100, radius: 10 }, g, img); list.setProp('scrollY', 30)
    const side = box('box', 'side', { left: 200, top: 0, width: 20, height: 20, bg: 'fill' })
    const outer = box('box', 'outer', { left: 50, top: 0, width: 300, height: 60, radius: 20, overflow: 'scroll' }, list, side)
    const rl = buildRenderList(layout(surface(outer)), theme, 'light')
    const clip = { x: 60, y: 10, width: 100, height: 50, radius: 10 }   // the inner rect intersection, the innermost radius
    expect(rl.panels.find(p => p.node.id === 'side')!.clip).toEqual({ x: 50, y: 0, width: 300, height: 60, radius: 20 })
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
      color: resolveColor('label', theme, 'dark'), align: 'left', lineHeight: 22, letterSpacing: 0, wrap: true, z: 1, elevation: 0, scale: 1,
    })
    expect(rl.text[1]).toMatchObject({
      text: '', font: { family: 'mono', size: theme.fontSize.sm, weight: 700 }, color: resolveColor('accent', theme, 'dark'),
      maxLines: 2, lineHeight: 20, letterSpacing: 0.5, wrap: false,   // 1.4 × 14 pt = 19.6
    })
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
