import { IDENTITY, multiply, scaleAbout, type Mat2D } from './transform2d'
import type { Node, Rect, VisualValues } from './node'
import type { Style } from './style/schema'
import { effectiveStyle } from './style/effective'
import { resolveColor, resolveRadius, type ColorScheme, type RGBA, type Theme } from './style/theme'
import { resolveTextStyle } from './style/text'
import { scrollOffset } from './events/hit'
import type { SurfaceModel } from './surface'

// Render lists are plain data for the render package (spec §5.6 step 1). Rects are Surface pt and untransformed: each
// node's layout (or its visual values while it animates) offset by its ancestors' rects, minus `scroll` offsets; the
// instance's `transform` places them. `z` is `sortKey` of the node's pre-order index over the visible tree (root 0);
// `elevation`, `scale`, `transform` and `opacity` compose down the tree (see InstanceTransform); `clip` is the
// intersection of the rects of `overflow: hidden|scroll` and `scroll` ancestors, absent when none.

/**
 * A clip region in the clipping ancestor's untransformed surface-pt space, carried with that ancestor's `transform`:
 * the intersected ancestor rects, rounded by the innermost clipping ancestor's (clamped) radius.
 */
export interface ClipRect extends Rect { radius: number; transform: Mat2D }

/** Render-time placement every instance carries; layout ignores it. */
export interface InstanceTransform {
  /** The node's own `elevation` plus every ancestor's, pt. */
  elevation: number
  /** The product of the effective `scale` from the root down (kept for LOD decisions; placement uses `transform`). */
  scale: number
  /** Composed affine: each ancestor's scale about its own rect centre, then this node's. `rect` is untransformed. */
  transform: Mat2D
  /** This node's own tilt (radians); tilts do not compose. */
  tilt: { x: number; y: number }
  /** The product of the effective `opacity` from the root down, 0..1. */
  opacity: number
}

export interface ResolvedGlass { thickness: number; fillet: number; filletBottom: number; profile: 'fillet' | 'lens'; scatter: number; lift: number; edgeGlow: number; ior: number; dispersion: number; roughness: number; tint: RGBA | null; absorption: number; glow: { color: RGBA; strength: number; split?: number } | null; cornerExponent: number; envIntensity: number; specularIntensity: number; innerGlow: number; adaptive: boolean; variant: 'regular' | 'clear' }
export interface PanelInstance extends InstanceTransform { node: Node; rect: Rect; radius: number; color: RGBA; border?: { width: number; color: RGBA }; clip?: ClipRect; z: number }
export interface GlassInstance extends InstanceTransform { node: Node; rect: Rect; radius: number; z: number; params: ResolvedGlass; clip?: ClipRect }
/**
 * `rect` is the content box (the node's rect minus its padding). Typography comes from `resolveTextStyle`:
 * `lineHeight` and `letterSpacing` are pt; `maxLines` is present only when the style sets it.
 */
export interface TextInstance extends InstanceTransform { node: Node; rect: Rect; text: string; font: { family: string; size: number; weight: number }; color: RGBA; align: 'left' | 'center' | 'right'; lineHeight: number; letterSpacing: number; wrap: boolean; maxLines?: number; z: number; clip?: ClipRect }
/** Rides on its glass node: `rim` just above it, `pool` just below it (see `sortKey`), same elevation, transform, opacity and clip. */
export interface DecorationInstance extends InstanceTransform { node: Node; kind: 'rim' | 'pool'; rect: Rect; radius: number; color: RGBA; strength: number; z: number; clip?: ClipRect }
export interface ImageInstance extends InstanceTransform { node: Node; rect: Rect; src: unknown; radius: number; z: number; clip?: ClipRect }
export interface RenderList { panels: PanelInstance[]; glass: GlassInstance[]; text: TextInstance[]; decorations: DecorationInstance[]; images: ImageInstance[] }

/**
 * Draw order inside one node: pool (below the glass), glass (or panel), content (the node's own text or image), rim
 * (on top). A node's layers stay within ±0.5 of its pre-order index, so its children (later indices) draw above its rim.
 */
export function sortKey(z: number, layer: 'pool' | 'glass' | 'content' | 'rim'): number {
  return z + (layer === 'pool' ? -0.25 : layer === 'glass' ? 0 : layer === 'content' ? 0.25 : 0.5)
}

/** `o` without its `undefined` entries, so optional fields stay absent under exactOptionalPropertyTypes. */
function defined<T extends Record<string, unknown>>(o: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> }
}

/**
 * The clip for the children of a clipping node at `b` with corner `radius` and composed `transform`, inside the
 * inherited clip `a`. Two clips under different transforms are approximated by intersecting their untransformed rects
 * and keeping the innermost transform: nested scaled clips are rare in UI, and this keeps the fragment-side test to
 * one rounded rect.
 */
function clipTo(a: ClipRect | undefined, b: Rect, radius: number, transform: Mat2D): ClipRect {
  if (!a) return { x: b.x, y: b.y, width: b.width, height: b.height, radius, transform }
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y), radius, transform }
}

/** `r` minus the padding `s` sets, resolved as yoga does: a specific edge, then X/Y, then `padding`. */
function contentBox(r: Rect, s: Style): Rect {
  const left = s.paddingLeft ?? s.paddingX ?? s.padding ?? 0, right = s.paddingRight ?? s.paddingX ?? s.padding ?? 0
  const top = s.paddingTop ?? s.paddingY ?? s.padding ?? 0, bottom = s.paddingBottom ?? s.paddingY ?? s.padding ?? 0
  return { x: r.x + left, y: r.y + top, width: Math.max(0, r.width - left - right), height: Math.max(0, r.height - top - bottom) }
}

/** How far `layout` sits inside a `width × height` parent at its nearest edge: the gap a concentric radius subtracts. */
function inset(layout: Rect, width: number, height: number): number {
  return Math.max(0, Math.min(layout.x, layout.y, width - layout.x - layout.width, height - layout.y - layout.height))
}

/**
 * The glass params for a node with style `s` drawn at `rect`; unset slab geometry scales with the rect's shorter side.
 * `v` (the node's animated glass values) wins over the style for every key it sets; `v.tint: null` clears the tint.
 */
export function resolveGlass(s: Style, rect: Rect, theme: Theme, scheme: ColorScheme, v?: VisualValues['glass']): ResolvedGlass {
  const g = s.glass ?? {}
  const d = theme.glass
  const minSide = Math.min(rect.width, rect.height)
  const variant = g.variant ?? (s.bg === 'glass-clear' ? 'clear' : d.variant)   // explicit, else glass-clear, else the theme's
  const o = v ?? {}
  const glowColor = o.glowColor ?? (g.glow ? resolveColor(g.glow.color, theme, scheme) : null)
  const glowStrength = o.glowStrength ?? g.glow?.strength
  return {
    thickness: o.thickness ?? g.thickness ?? minSide * d.thicknessRatio, fillet: o.fillet ?? g.fillet ?? minSide * d.filletRatio,
    filletBottom: o.filletBottom ?? g.filletBottom ?? minSide * d.filletBottomRatio, profile: g.profile ?? 'fillet',
    scatter: o.scatter ?? g.scatter ?? (variant === 'clear' ? 0.02 : d.scatter), lift: o.lift ?? g.lift ?? d.lift, edgeGlow: o.edgeGlow ?? g.edgeGlow ?? d.edgeGlow,
    ior: o.ior ?? g.ior ?? d.ior, dispersion: o.dispersion ?? g.dispersion ?? d.dispersion, roughness: o.roughness ?? g.roughness ?? d.roughness,
    tint: o.tint !== undefined ? o.tint : g.tint ? resolveColor(g.tint, theme, scheme) : null, absorption: o.absorption ?? g.absorption ?? 0,
    glow: glowColor && glowStrength !== undefined ? { color: glowColor, strength: glowStrength, ...defined({ split: g.glow?.split }) } : null,
    // Spec §5.2: 4–5 approximates Apple's continuous corners; a capsule is circular (2).
    cornerExponent: g.cornerExponent ?? (s.radius === 'capsule' ? 2 : 4.5),
    envIntensity: o.envIntensity ?? g.envIntensity ?? d.envIntensity, specularIntensity: o.specularIntensity ?? g.specularIntensity ?? d.specularIntensity,
    innerGlow: o.innerGlow ?? g.innerGlow ?? d.innerGlow, adaptive: g.adaptive ?? d.adaptive, variant,
  }
}

/**
 * Walks `surface.root` in pre-order and emits its draw data. Each node's effective style (state branches merged)
 * decides what it draws: glass (`type: 'glass'` or `bg: 'glass' | 'glass-clear'`) with a `rim` and a `pool`
 * decoration; a panel for any other `bg` colour or a border; text for `text` nodes (`props.value`); an image for
 * `image` nodes (`props.src`). `display: 'none'` skips the subtree. Radii are clamped to half the shorter side;
 * `concentric` resolves against the parent's radius (the root's parent is the surface's `cornerRadius`).
 * A node's `visual` values, while it animates, replace its layout rect (its children follow the visual rect) and the
 * style targets they cover. Unknown tokens throw `GlassUIError`.
 */
export function buildRenderList(surface: SurfaceModel, theme: Theme, scheme: ColorScheme): RenderList {
  const rl: RenderList = { panels: [], glass: [], text: [], decorations: [], images: [] }
  let z = 0
  const visit = (n: Node, originX: number, originY: number, clip: ClipRect | undefined, parent: { elevation: number; scale: number; transform: Mat2D; opacity: number; radius: number; w: number; h: number }): void => {
    const s = effectiveStyle(n)
    if (s.display === 'none') return
    const v = n.visual
    const layout = { x: v?.x ?? n.layout.x, y: v?.y ?? n.layout.y, width: v?.width ?? n.layout.width, height: v?.height ?? n.layout.height }
    const rect: Rect = { x: originX + layout.x, y: originY + layout.y, width: layout.width, height: layout.height }
    const myZ = z++
    const elevation = parent.elevation + (v?.elevation ?? n.elevation)
    const ownScale = v?.scale ?? s.scale ?? 1
    const scale = parent.scale * ownScale
    const transform = ownScale === 1 ? parent.transform : multiply(parent.transform, scaleAbout(rect.x + rect.width / 2, rect.y + rect.height / 2, ownScale))
    const opacity = parent.opacity * (v?.opacity ?? s.opacity ?? 1)
    const ownTilt = v?.tilt ?? n.tilt
    const tilt = { x: ownTilt.x, y: ownTilt.y }   // a copy: `n.tilt` is a read-only view of the node's own state
    const resolved = v?.radius ?? resolveRadius(s.radius, theme, rect.width, rect.height, parent.radius, inset(layout, parent.w, parent.h))
    const radius = Math.max(0, Math.min(resolved, rect.width / 2, rect.height / 2))
    const base = { node: n, rect, elevation, scale, transform, tilt, opacity, ...defined({ clip }) }
    if (n.type === 'glass' || s.bg === 'glass' || s.bg === 'glass-clear') {
      const params = resolveGlass(s, rect, theme, scheme, v?.glass)
      rl.glass.push({ ...base, radius, z: sortKey(myZ, 'glass'), params })
      rl.decorations.push(
        { ...base, kind: 'rim', radius, color: [1, 1, 1, 1], strength: 1, z: sortKey(myZ, 'rim') },
        { ...base, kind: 'pool', radius, color: params.glow ? params.glow.color : [1, 1, 1, 1], strength: params.glow ? 0.5 : 0.28, z: sortKey(myZ, 'pool') },
      )
    } else if ((s.bg !== undefined && s.bg !== 'none') || s.border) {
      const color: RGBA = v?.bg ?? (s.bg !== undefined && s.bg !== 'none' ? resolveColor(s.bg, theme, scheme) : [0, 0, 0, 0])
      const border = s.border && { width: s.border.width, color: resolveColor(s.border.color, theme, scheme) }
      rl.panels.push({ ...base, radius, color, ...defined({ border }), z: sortKey(myZ, 'glass') })
    }
    if (n.type === 'text') {
      const t = resolveTextStyle(n, theme, scheme)
      rl.text.push({
        ...base, rect: contentBox(rect, s), text: String(n.props.value ?? ''),
        font: { family: t.family, size: t.size, weight: t.weight }, color: v?.color ?? t.color, align: t.align,
        lineHeight: t.lineHeight, letterSpacing: t.letterSpacing, wrap: t.wrap, ...defined({ maxLines: t.maxLines }),
        z: sortKey(myZ, 'content'),
      })
    }
    if (n.type === 'image') rl.images.push({ ...base, src: n.props.src, radius, z: sortKey(myZ, 'content') })
    const childClip = s.overflow === 'hidden' || s.overflow === 'scroll' || n.type === 'scroll' ? clipTo(clip, rect, radius, transform) : clip
    const o = scrollOffset(n)
    for (const c of n.children) visit(c, rect.x - o.x, rect.y - o.y, childClip, { elevation, scale, transform, opacity, radius, w: rect.width, h: rect.height })
  }
  visit(surface.root, 0, 0, undefined, { elevation: 0, scale: 1, transform: IDENTITY, opacity: 1, radius: surface.cornerRadius, w: surface.width, h: surface.height })
  return rl
}
