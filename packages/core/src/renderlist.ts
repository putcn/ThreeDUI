import type { Node, Rect } from './node'
import type { Style } from './style/schema'
import { effectiveStyle } from './style/effective'
import { resolveColor, resolveFontSize, resolveRadius, type ColorScheme, type RGBA, type Theme } from './style/theme'
import { absoluteRect } from './events/hit'
import type { SurfaceModel } from './surface'

// Render lists are plain data for the render package (spec §5.6 step 1). Rects are Surface pt; `z` is the node's
// pre-order index over the visible tree (root 0); `elevation` is the node's own plus every ancestor's;
// `clip` is the intersection of the rects of `overflow: hidden|scroll` and `scroll` ancestors, absent when none.

export interface ResolvedGlass { thickness: number; fillet: number; filletBottom: number; profile: 'fillet' | 'lens'; scatter: number; lift: number; edgeGlow: number; ior: number; dispersion: number; roughness: number; tint: RGBA | null; absorption: number; glow: { color: RGBA; strength: number; split?: number } | null; cornerExponent: number }
export interface PanelInstance { node: Node; rect: Rect; radius: number; color: RGBA; border?: { width: number; color: RGBA }; clip?: Rect; z: number; elevation: number; opacity: number }
export interface GlassInstance { node: Node; rect: Rect; radius: number; z: number; elevation: number; params: ResolvedGlass; clip?: Rect }
/** `maxLines`, `lineHeight`, `letterSpacing` and `wrap` are present only when the style sets them. */
export interface TextInstance { node: Node; rect: Rect; text: string; font: { family: string; size: number; weight: number }; color: RGBA; align: 'left' | 'center' | 'right'; maxLines?: number; lineHeight?: number; letterSpacing?: number; wrap?: boolean; z: number; elevation: number; clip?: Rect }
/** Rides on its glass node: `rim` just above it (`z + 0.5`), `pool` just below it (`z - 0.25`), same elevation and clip. */
export interface DecorationInstance { node: Node; kind: 'rim' | 'pool'; rect: Rect; radius: number; color: RGBA; strength: number; z: number; elevation: number; clip?: Rect }
export interface ImageInstance { node: Node; rect: Rect; src: unknown; radius: number; z: number; elevation: number; clip?: Rect }
export interface RenderList { panels: PanelInstance[]; glass: GlassInstance[]; text: TextInstance[]; decorations: DecorationInstance[]; images: ImageInstance[] }

/** `o` without its `undefined` entries, so optional fields stay absent under exactOptionalPropertyTypes. */
function defined<T extends Record<string, unknown>>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> }
}

function intersect(a: Rect | undefined, b: Rect): Rect {
  if (!a) return b
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) }
}

/** How far `layout` sits inside a `width × height` parent at its nearest edge: the gap a concentric radius subtracts. */
function inset(layout: Rect, width: number, height: number): number {
  return Math.max(0, Math.min(layout.x, layout.y, width - layout.x - layout.width, height - layout.y - layout.height))
}

function resolveGlass(s: Style, theme: Theme, scheme: ColorScheme): ResolvedGlass {
  const g = s.glass ?? {}
  const d = theme.glass
  const clear = g.variant !== undefined ? g.variant === 'clear' : s.bg === 'glass-clear'
  return {
    thickness: g.thickness ?? d.thickness, fillet: g.fillet ?? d.fillet, filletBottom: g.filletBottom ?? d.filletBottom, profile: g.profile ?? 'fillet',
    scatter: g.scatter ?? (clear ? 0.02 : d.scatter), lift: g.lift ?? d.lift, edgeGlow: g.edgeGlow ?? d.edgeGlow,
    ior: g.ior ?? d.ior, dispersion: g.dispersion ?? d.dispersion, roughness: g.roughness ?? d.roughness,
    tint: g.tint ? resolveColor(g.tint, theme, scheme) : null, absorption: g.absorption ?? 0,
    glow: g.glow ? { color: resolveColor(g.glow.color, theme, scheme), strength: g.glow.strength, ...defined({ split: g.glow.split }) } : null,
    // Spec §5.2: 4–5 approximates Apple's continuous corners; a capsule is circular (2).
    cornerExponent: g.cornerExponent ?? (s.radius === 'capsule' ? 2 : 4.5),
  }
}

/**
 * Walks `surface.root` in pre-order and emits its draw data. Each node's effective style (state branches merged)
 * decides what it draws: glass (`type: 'glass'` or `bg: 'glass' | 'glass-clear'`) with a `rim` and a `pool`
 * decoration; a panel for any other `bg` colour or a border; text for `text` nodes (`props.value`); an image for
 * `image` nodes (`props.src`). `display: 'none'` skips the subtree. Radii are clamped to half the shorter side;
 * `concentric` resolves against the parent's radius (the root's parent is the surface's `cornerRadius`).
 * Unknown tokens throw `GlassUIError`.
 */
export function buildRenderList(surface: SurfaceModel, theme: Theme, scheme: ColorScheme): RenderList {
  const rl: RenderList = { panels: [], glass: [], text: [], decorations: [], images: [] }
  let z = 0
  const visit = (n: Node, clip: Rect | undefined, parentElevation: number, parentRadius: number, parentW: number, parentH: number): void => {
    const s = effectiveStyle(n)
    if (s.display === 'none') return
    const rect = absoluteRect(n)
    const myZ = z++
    const elevation = parentElevation + n.elevation
    const resolved = resolveRadius(s.radius, theme, rect.width, rect.height, parentRadius, inset(n.layout, parentW, parentH))
    const radius = Math.max(0, Math.min(resolved, rect.width / 2, rect.height / 2))
    const clipped = defined({ clip })
    if (n.type === 'glass' || s.bg === 'glass' || s.bg === 'glass-clear') {
      const params = resolveGlass(s, theme, scheme)
      rl.glass.push({ node: n, rect, radius, z: myZ, elevation, params, ...clipped })
      rl.decorations.push(
        { node: n, kind: 'rim', rect, radius, color: [1, 1, 1, 1], strength: 1, z: myZ + 0.5, elevation, ...clipped },
        { node: n, kind: 'pool', rect, radius, color: params.glow ? params.glow.color : [1, 1, 1, 1], strength: params.glow ? 0.5 : 0.28, z: myZ - 0.25, elevation, ...clipped },
      )
    } else if ((s.bg !== undefined && s.bg !== 'none') || s.border) {
      const color: RGBA = s.bg !== undefined && s.bg !== 'none' ? resolveColor(s.bg, theme, scheme) : [0, 0, 0, 0]
      const border = s.border && { width: s.border.width, color: resolveColor(s.border.color, theme, scheme) }
      rl.panels.push({ node: n, rect, radius, color, ...defined({ border }), ...clipped, z: myZ, elevation, opacity: s.opacity ?? 1 })
    }
    if (n.type === 'text') {
      rl.text.push({
        node: n, rect, text: String(n.props.value ?? ''),
        font: { family: s.font ?? 'system', size: resolveFontSize(s.fontSize, theme), weight: s.fontWeight ?? 500 },
        color: resolveColor(s.color ?? 'label', theme, scheme), align: s.textAlign ?? 'left',
        ...defined({ maxLines: s.maxLines, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing, wrap: s.wrap }),
        z: myZ, elevation, ...clipped,
      })
    }
    if (n.type === 'image') rl.images.push({ node: n, rect, src: n.props.src, radius, z: myZ, elevation, ...clipped })
    const childClip = s.overflow === 'hidden' || s.overflow === 'scroll' || n.type === 'scroll' ? intersect(clip, rect) : clip
    for (const c of n.children) visit(c, childClip, elevation, radius, rect.width, rect.height)
  }
  visit(surface.root, undefined, 0, surface.cornerRadius, surface.width, surface.height)
  return rl
}
