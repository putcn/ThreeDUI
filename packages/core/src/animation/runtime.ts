import type { GlassNumericKey, Node, Rect, VisualValues } from '../node'
import { effectiveStyle } from '../style/effective'
import { resolveColor, resolveRadius, type ColorScheme, type RGBA, type Theme } from '../style/theme'
import { resolveTextStyle } from '../style/text'
import { resolveGlass } from '../renderlist'
import { Spring, resolveSpring } from './spring'
import { ease, type Easing } from './easing'
import type { Style } from '../style/schema'

type Transition = NonNullable<Style['transition']>
type TransitionKey = keyof Transition

/** One scalar channel: a spring or a duration tween toward `to`. */
interface Channel { spring?: Spring; from?: number; to: number; t?: number; duration?: number; easing?: Easing; value: number }

interface NodeAnim {
  root: Node                            // the root the node was last seen under: only that root's tick may drop it
  targets: Map<string, number>          // channel id ("scale", "bg.0", "glass.thickness", …) → last seen target
  channels: Map<string, Channel>
}

/** How far `layout` sits inside a `w × h` parent at its nearest edge (as `buildRenderList` computes it). */
function inset(layout: Rect, w: number, h: number): number {
  return Math.max(0, Math.min(layout.x, layout.y, w - layout.x - layout.width, h - layout.y - layout.height))
}

const unit = (x: number): number => Math.max(0, Math.min(1, x))

/**
 * Keys a transition is configured for in the base style or in any state branch. Their targets are tracked even while
 * the branch is off, so switching it on has a recorded value to animate from.
 */
function transitionKeys(style: Style): Set<TransitionKey> {
  const keys = new Set<TransitionKey>()
  for (const t of [style.transition, style.hover?.transition, style.pressed?.transition, style.focused?.transition, style.disabled?.transition]) {
    if (t) for (const k of Object.keys(t) as TransitionKey[]) if (t[k] !== undefined) keys.add(k)
  }
  return keys
}

/**
 * Drives spec §4.4 transitions. Each tick it reads every transitioning node's *targets* (layout, style, state
 * branches, elevation/tilt), starts a channel per changed scalar and writes the blended values into `node.visual`.
 * A key is tracked when the base style or any state branch configures a transition for it. A change animates only
 * when the transition in effect now (the effective style's) has the key; otherwise it jumps. So a transition set only
 * in `pressed` animates the press, and the release (branch off) jumps.
 * Nodes are keyed by identity. One runtime can serve several surfaces (tick each root); a node that leaves its tree
 * loses its state on the next tick of the root it was last seen under.
 */
export class AnimationRuntime {
  /** `prefers-reduced-motion`: every change jumps, and channels in flight settle at once. */
  reducedMotion = false
  private state = new Map<Node, NodeAnim>()
  constructor(private theme: Theme, private scheme: ColorScheme) {}

  setTheme(theme: Theme, scheme: ColorScheme): void { this.theme = theme; this.scheme = scheme }
  get active(): number { let n = 0; for (const a of this.state.values()) n += a.channels.size; return n }
  reset(node: Node): void { this.state.delete(node); if (node.visual) node.setVisual(null) }

  /**
   * Drops the state of every node last seen under `root` and clears their visual values (a disposed surface's tree).
   */
  forget(root: Node): void {
    for (const [n, a] of [...this.state]) if (a.root === root) { this.state.delete(n); if (n.visual) n.setVisual(null) }
  }

  /**
   * Advances by `dt` seconds; returns true while any channel is still moving. Call it after layout: targets are read
   * from the fresh layout. `cornerRadius` is the radius a `concentric` root resolves against (the surface's corners,
   * as `buildRenderList` takes `SurfaceModel.cornerRadius`).
   */
  tick(root: Node, dt: number, cornerRadius = 0): boolean {
    const seen = new Set<Node>()
    let moving = false
    const visit = (n: Node, parentRadius: number, parentW: number, parentH: number): void => {
      const s = effectiveStyle(n)
      if (s.display === 'none') return
      const rect = n.layout
      const resolved = resolveRadius(s.radius, this.theme, rect.width, rect.height, parentRadius, inset(rect, parentW, parentH))
      const radius = Math.max(0, Math.min(resolved, rect.width / 2, rect.height / 2))   // clamped as buildRenderList draws it
      const keys = transitionKeys(n.style)
      if (keys.size > 0) {
        seen.add(n)
        moving = this.step(root, n, s, keys, radius, dt) || moving
      }
      for (const c of n.children) visit(c, radius, rect.width, rect.height)
    }
    visit(root, cornerRadius, root.layout.width, root.layout.height)
    for (const [n, a] of [...this.state]) if (a.root === root && !seen.has(n)) { this.state.delete(n); if (n.visual) n.setVisual(null) }
    return moving
  }

  /** The scalar targets of `n` for the tracked keys, flattened to channel ids. */
  private targets(n: Node, s: Style, keys: Set<TransitionKey>, radius: number): Map<string, number> {
    const t = new Map<string, number>()
    const rgba = (id: string, c: RGBA) => { t.set(`${id}.0`, c[0]); t.set(`${id}.1`, c[1]); t.set(`${id}.2`, c[2]); t.set(`${id}.3`, c[3]) }
    for (const k of keys) {
      switch (k) {
        case 'x': t.set('x', n.layout.x); break
        case 'y': t.set('y', n.layout.y); break
        case 'width': t.set('width', n.layout.width); break
        case 'height': t.set('height', n.layout.height); break
        case 'scale': t.set('scale', s.scale ?? 1); break
        case 'opacity': t.set('opacity', s.opacity ?? 1); break
        case 'elevation': t.set('elevation', n.elevation); break
        case 'tilt': t.set('tilt.x', n.tilt.x); t.set('tilt.y', n.tilt.y); break
        case 'radius': t.set('radius', radius); break
        case 'color': if (n.type === 'text') rgba('color', resolveTextStyle(n, this.theme, this.scheme).color); break
        case 'bg': if (s.bg && s.bg !== 'none' && s.bg !== 'glass' && s.bg !== 'glass-clear') rgba('bg', resolveColor(s.bg, this.theme, this.scheme)); break
        case 'glass': {
          if (!(n.type === 'glass' || s.bg === 'glass' || s.bg === 'glass-clear')) break
          const g = resolveGlass(s, n.layout, this.theme, this.scheme)
          const nums: Record<GlassNumericKey, number> = {
            thickness: g.thickness, fillet: g.fillet, filletBottom: g.filletBottom, scatter: g.scatter, lift: g.lift, edgeGlow: g.edgeGlow,
            ior: g.ior, dispersion: g.dispersion, roughness: g.roughness, absorption: g.absorption, glowStrength: g.glow?.strength ?? 0,
            envIntensity: g.envIntensity, specularIntensity: g.specularIntensity, innerGlow: g.innerGlow,
          }
          for (const [key, v] of Object.entries(nums)) t.set(`glass.${key}`, v)
          if (g.glow) rgba('glass.glowColor', g.glow.color)
          if (g.tint) rgba('glass.tint', g.tint)
          break
        }
      }
    }
    return t
  }

  private step(root: Node, n: Node, s: Style, keys: Set<TransitionKey>, radius: number, dt: number): boolean {
    const targets = this.targets(n, s, keys, radius)
    let anim = this.state.get(n)
    if (!anim) { this.state.set(n, { root, targets, channels: new Map() }); return false }   // first sight: record, no animation
    anim.root = root
    for (const [id, to] of targets) {
      const prev = anim.targets.get(id)
      anim.targets.set(id, to)
      if (prev === undefined || prev === to) continue
      const cfg = s.transition?.[id.split('.')[0] as TransitionKey]
      if (!cfg || this.reducedMotion) { anim.channels.delete(id); continue }   // no transition in effect for this key now: jump
      const spec = resolveSpring(cfg, this.theme)
      const ch = anim.channels.get(id)
      const from = ch ? ch.value : prev
      if ('stiffness' in spec) {
        // A fresh spring per retarget picks up the transition now in effect; carrying the velocity keeps the motion smooth.
        const sp = new Spring(from, spec); sp.velocity = ch?.spring?.velocity ?? 0; sp.set(to)
        anim.channels.set(id, { spring: sp, to, value: from })
      } else {
        anim.channels.set(id, { from, to, t: 0, duration: spec.duration, easing: spec.easing, value: from })
      }
    }
    for (const id of [...anim.targets.keys()]) if (!targets.has(id)) { anim.targets.delete(id); anim.channels.delete(id) }
    if (this.reducedMotion) anim.channels.clear()
    if (anim.channels.size === 0) { if (n.visual) n.setVisual(null); return false }
    // advance
    for (const [id, ch] of anim.channels) {
      if (ch.spring) { ch.value = ch.spring.step(dt); if (ch.spring.done) anim.channels.delete(id) }
      else {
        ch.t = (ch.t ?? 0) + dt
        const p = ch.duration! <= 0 ? 1 : Math.min(1, ch.t / ch.duration!)
        ch.value = ch.from! + (ch.to - ch.from!) * ease(ch.easing!, p)
        if (p >= 1) anim.channels.delete(id)
      }
    }
    if (anim.channels.size === 0) { n.setVisual(null); return false }
    n.setVisual(this.compose(anim))
    return true
  }

  /**
   * Visual values from the live channels (settled keys fall back to their targets so colours stay consistent).
   * Opacity and colour channels are clamped to 0..1: an underdamped spring overshoots, materials must not see it.
   */
  private compose(anim: NodeAnim): VisualValues {
    const v: VisualValues = {}
    const live = new Set([...anim.channels.keys()].map(id => id.split('.')[0]))
    const get = (id: string) => anim.channels.get(id)?.value ?? anim.targets.get(id)!
    const rgba = (id: string): RGBA => [unit(get(`${id}.0`)), unit(get(`${id}.1`)), unit(get(`${id}.2`)), unit(get(`${id}.3`))]
    for (const k of ['x', 'y', 'width', 'height', 'scale', 'opacity', 'elevation', 'radius'] as const) if (live.has(k)) v[k] = get(k)
    if (v.opacity !== undefined) v.opacity = unit(v.opacity)
    if (live.has('tilt')) v.tilt = { x: get('tilt.x'), y: get('tilt.y') }
    if (live.has('color')) v.color = rgba('color')
    if (live.has('bg')) v.bg = rgba('bg')
    if (live.has('glass')) {
      const g: NonNullable<VisualValues['glass']> = {}
      for (const [id] of anim.targets) {
        if (!id.startsWith('glass.')) continue
        const key = id.slice(6)
        if (key.startsWith('glowColor')) g.glowColor = rgba('glass.glowColor')
        else if (key.startsWith('tint')) g.tint = rgba('glass.tint')
        else g[key as GlassNumericKey] = get(id)
      }
      v.glass = g
    }
    return v
  }
}
