import { apply, IDENTITY, multiply, scaleAbout, type Mat2D } from './transform2d'
import type { Node, Rect, VisualValues } from './node'
import { GlassUIError } from './errors'
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
/**
 * Rides on its glass node: `rim` just above it, `pool` just below it (see `sortKey`), same elevation, transform, opacity
 * and clip; `radius` and `cornerExponent` are the glass's, so the rim's outline follows the glass's silhouette.
 * `shadow` (spatial spec §11.7): black, strength 1, sorted 0.05 under its pool, for glass that stands above the face it
 * sits on. Its `elevation` is that height, not the composed one: the composed elevation minus the nearest glass
 * ancestor's top (that glass's composed elevation + its thickness), or minus 0 (the Surface plane) without one; it is
 * emitted only when that is above 0. The render package offsets it along the light by it.
 */
export interface DecorationInstance extends InstanceTransform { node: Node; kind: 'rim' | 'pool' | 'shadow'; rect: Rect; radius: number; cornerExponent: number; color: RGBA; strength: number; z: number; clip?: ClipRect }
export interface ImageInstance extends InstanceTransform { node: Node; rect: Rect; src: unknown; radius: number; z: number; clip?: ClipRect }
/** An axis-aligned rounded rect in Surface pt, already through its instance's transform. */
export interface GlassShape { x: number; y: number; width: number; height: number; radius: number }
/**
 * A cluster of glass that a glass container (`props.glassContainer`, spec §5.2) fuses into one slab: `node` is the
 * container; `members` the clustered glass instances in list order (their rims dropped, their pools and shadows kept);
 * `shapes` their rects through their own transforms (a pressed member's shrinks), in the same order; `spacing` the
 * container's. `elevation` is the tallest member's (a hovered member lifts the whole slab), and `params` that member's
 * (its hover glint shows on the slab it lifts; on a tie, a pressed member's, then a hovered one's, then the first's),
 * but for the slab's geometry — `thickness`, `fillet`, `filletBottom` and `profile` stay the first member's, so the
 * slab neither changes height nor rebuilds when the hover moves along it — and with no `glow` and no `tint` (no
 * member's target has either: an animated leftover on one must not light the whole slab). `opacity` is the members' largest (one
 * fading in or out does not dim the others); `scale`, `z` and `clip` are the first member's; `rect` the shapes'
 * bounds; `transform` is `IDENTITY` (the shapes are already transformed) and `tilt` 0 (tilts do not compose: a
 * member's hover tilt has no slab of its own to bend).
 */
export interface FusedGlassInstance extends InstanceTransform { node: Node; members: GlassInstance[]; shapes: GlassShape[]; spacing: number; params: ResolvedGlass; rect: Rect; z: number; clip?: ClipRect }
export interface RenderList { panels: PanelInstance[]; glass: GlassInstance[]; text: TextInstance[]; decorations: DecorationInstance[]; images: ImageInstance[]; fused: FusedGlassInstance[] }

/**
 * Draw order inside one node: pool (below the glass), glass (or panel), content (the node's own text or image), rim
 * (on top). A node's layers stay within ±0.5 of its pre-order index, so its children (later indices) draw above its rim.
 */
export function sortKey(z: number, layer: 'pool' | 'glass' | 'content' | 'rim'): number {
  return z + (layer === 'pool' ? -0.25 : layer === 'glass' ? 0 : layer === 'content' ? 0.25 : 0.5)
}

/** How far a raised glass node's `shadow` decoration sorts under its pool: inside the node's ±0.5, over its parent. */
const SHADOW_Z_BELOW_POOL = 0.05

/**
 * The focus-visible ring (spec §7.2): a border `width` pt wide, `offset` pt outside the node's shape (its radius grown
 * by as much), in the `color` token; drawn as a panel sorted in the node's pool layer (under its children). The
 * render package draws a glass node's ring on that glass's top face, with its rim.
 */
export const FOCUS_RING = { width: 2.5, offset: 3, color: 'accent' } as const

/** The light pool under glass (spec §5.5: its transmitted halo, in the glow colour or white): its strength clear and glowing. */
const POOL = { clear: 0.28, glow: 0.5 } as const

/**
 * The pool under glass with `glow`: clear glass's (white at `POOL.clear`), moving to the glow's colour at `POOL.glow`
 * as the glow's strength rises to 1 (a glow of 1 or more pools in full). A glow of strength 0 (a switch that is off)
 * pools exactly as clear glass does, and a glow fading in or out (its animated strength) moves the pool with it.
 */
function poolOf(glow: ResolvedGlass['glow']): { color: RGBA; strength: number } {
  const w = glow ? Math.min(1, Math.max(0, glow.strength)) : 0
  const c = glow?.color ?? [1, 1, 1, 1]
  // c·w + 1·(1 − w): exactly white at w = 0 and exactly the glow colour at w = 1
  const mix = (v: number, from: number): number => v * w + from * (1 - w)
  return { color: [mix(c[0], 1), mix(c[1], 1), mix(c[2], 1), mix(c[3], 1)], strength: mix(POOL.glow, POOL.clear) }
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
    glow: glowColor && glowStrength !== undefined ? { color: glowColor, strength: glowStrength, ...defined({ split: o.glowSplit ?? g.glow?.split }) } : null,
    // Spec §5.2: 4–5 approximates Apple's continuous corners; a capsule is circular (2).
    cornerExponent: g.cornerExponent ?? (s.radius === 'capsule' ? 2 : 4.5),
    envIntensity: o.envIntensity ?? g.envIntensity ?? d.envIntensity, specularIntensity: o.specularIntensity ?? g.specularIntensity ?? d.specularIntensity,
    innerGlow: o.innerGlow ?? g.innerGlow ?? d.innerGlow, adaptive: g.adaptive ?? d.adaptive, variant,
  }
}

/** A glass container's pending members: the glass whose nearest container it is, each with its rim. */
interface Container { node: Node; spacing: number; members: { glass: GlassInstance; rim: DecorationInstance; fusible: boolean }[] }

/** `n`'s `props.glassContainer` spacing (pt), or null when it is no container (absent, null or false). */
function containerSpacing(n: Node): number | null {
  const c = n.props.glassContainer
  if (c === undefined || c === null || c === false) return null
  const spacing = typeof c === 'object' ? (c as { spacing?: unknown }).spacing : undefined
  if (typeof spacing !== 'number' || !Number.isFinite(spacing) || spacing < 0) {
    // the value in the reason, as core's other single-value errors (GlassUIError prints `got` only beside `allowed`)
    const v = typeof c === 'object' ? spacing : c, got = typeof v === 'number' ? String(v) : String(JSON.stringify(v))
    throw new GlassUIError('glassContainer.spacing', `必须是不小于 0 的有限数（pt），得到 ${got}${typeof c === 'object' ? '' : '（glassContainer 写成 { spacing: 16 }）'}`)
  }
  return spacing
}

/**
 * `g`'s rect through its own transform, about its transformed centre (core composes scales about centres, which keep
 * it axis-aligned; any other transform gets its bounds), its radius scaled with it.
 */
function shapeOf(g: GlassInstance): GlassShape {
  const t = g.transform, r = g.rect
  const [cx, cy] = apply(t, r.x + r.width / 2, r.y + r.height / 2)
  const width = r.width * Math.abs(t.a) + r.height * Math.abs(t.c), height = r.width * Math.abs(t.b) + r.height * Math.abs(t.d)
  return { x: cx - width / 2, y: cy - height / 2, width, height, radius: g.radius * Math.sqrt(Math.abs(t.a * t.d - t.b * t.c)) }
}

/**
 * The distance between two rounded rects (0 when they touch or overlap): each is its core rect (inset by its radius,
 * clamped to half its shorter side as the fused outline clamps it) grown by a disc of that radius, so it is the
 * distance between the cores less both radii. The fused outline joins two shapes exactly when this is under the
 * spacing (`fusedOutline` in the render package): two circles placed diagonally are as far apart as their arcs are.
 */
function gapBetween(p: GlassShape, q: GlassShape): number {
  const rp = Math.max(0, Math.min(p.radius, p.width / 2, p.height / 2)), rq = Math.max(0, Math.min(q.radius, q.width / 2, q.height / 2))
  const dx = Math.max(0, (q.x + rq) - (p.x + p.width - rp), (p.x + rp) - (q.x + q.width - rq))
  const dy = Math.max(0, (q.y + rq) - (p.y + p.height - rp), (p.y + rp) - (q.y + q.height - rq))
  return Math.max(0, Math.sqrt(dx * dx + dy * dy) - rp - rq)
}

/**
 * Whether a member's look lets it fuse: no glow (none, or of strength 0: a Switch that is off) and no tint. A glowing
 * or tinted member (a primary Button, a checked Switch, a selected item) stays single glass with its own rim and pool:
 * the slab has one look over its whole outline, and a glow or its split there would smear across the other members.
 * Decided on the effective style's targets (as `resolveGlass` reads them without the animated values), not on the
 * animated glow or tint: a glow springing through 0 under a snappy or bouncy spring would flip the membership, and
 * rebuild the slab, several times a second.
 */
const fusible = (s: Style): boolean => {
  const g = s.glass
  return (!g?.glow || g.glow.strength <= 0) && !g?.tint
}

/** How a member ranks among the members sharing the slab's elevation: a pressed one, then a hovered one, leads it. */
const leadRank = (g: GlassInstance): number => g.node.state.pressed ? 2 : g.node.state.hover ? 1 : 0

/**
 * Clusters a container's members (spec §5.2): two join when the gap between their shapes (`shapeOf`, `gapBetween`) is
 * under its spacing (as the fused outline joins them), they share a variant and both can fuse (`fusible`),
 * transitively; a member with an empty or non-finite shape joins none, nor does one that cannot fuse (so a cluster
 * splits around it when that leaves a wider gap). Each cluster of two or more becomes one `FusedGlassInstance` in
 * `out` (in the order of its first member), its members' glass and rims put in `drop`.
 */
function cluster(c: Container, out: FusedGlassInstance[], drop: Set<GlassInstance | DecorationInstance>): void {
  const ms = c.members, n = ms.length
  if (n < 2) return
  const shapes = ms.map(m => shapeOf(m.glass))
  const ok = shapes.map((s, i) => [s.x, s.y, s.width, s.height, s.radius].every(Number.isFinite) && s.width > 0 && s.height > 0 && ms[i]!.fusible)
  const up = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => { while (up[i] !== i) { up[i] = up[up[i]!]!; i = up[i]! } return i }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (!ok[i] || !ok[j] || ms[i]!.glass.params.variant !== ms[j]!.glass.params.variant) continue
    if (gapBetween(shapes[i]!, shapes[j]!) < c.spacing) { const a = find(i), b = find(j); if (a !== b) up[Math.max(a, b)] = Math.min(a, b) }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) { const r = find(i), g = groups.get(r); if (g) g.push(i); else groups.set(r, [i]) }   // roots are their sets' least index: groups in first-member order
  for (const idx of groups.values()) {
    if (idx.length < 2) continue
    const members = idx.map(i => ms[i]!.glass), sh = idx.map(i => shapes[i]!), first = members[0]!
    for (const i of idx) { drop.add(ms[i]!.glass); drop.add(ms[i]!.rim) }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const s of sh) { x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x + s.width); y1 = Math.max(y1, s.y + s.height) }
    // the member that lifts the slab leads its look; the slab's geometry stays the first member's
    let lead = first, opacity = first.opacity
    for (const m of members) {
      if (m.elevation > lead.elevation || (m.elevation === lead.elevation && leadRank(m) > leadRank(lead))) lead = m
      opacity = Math.max(opacity, m.opacity)
    }
    const f = first.params
    // no glow and no tint: every member's target has neither (`fusible`), so a glow or tint still springing away on one
    // of them (its animated values) never smears across the whole slab
    const params: ResolvedGlass = { ...lead.params, thickness: f.thickness, fillet: f.fillet, filletBottom: f.filletBottom, profile: f.profile, glow: null, tint: null }
    out.push({
      node: c.node, members, shapes: sh, spacing: c.spacing, params, rect: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, z: first.z,
      elevation: lead.elevation, scale: first.scale, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity, ...defined({ clip: first.clip }),
    })
  }
}

/**
 * Walks `surface.root` in pre-order and emits its draw data. Each node's effective style (state branches merged)
 * decides what it draws: glass (`type: 'glass'` or `bg: 'glass' | 'glass-clear'`) with a `rim` and a `pool`
 * decoration, and a `shadow` one when it stands above the face it sits on (see `DecorationInstance`); a panel for any
 * other `bg` colour or a border; text for `text` nodes (`props.value`); an image for `image` nodes (`props.src`); a
 * `FOCUS_RING` panel for a node with `state.focused && state.focusVisible`, unless `props.focusRing === false` (a
 * component that draws its own). `display: 'none'` skips the subtree. Radii are clamped to half the shorter side;
 * `concentric` resolves against the parent's radius (the root's parent is the surface's `cornerRadius`).
 * A node's `visual` values, while it animates, replace its layout rect (its children follow the visual rect) and the
 * style targets they cover. Unknown tokens throw `GlassUIError`.
 *
 * Glass containers (spec §5.2): a node with `props.glassContainer = { spacing }` (pt, finite, ≥ 0; anything else throws
 * a `GlassUIError`; null or false is no container) collects the glass whose nearest container it is, glass nested in
 * glass aside (that rides on its glass, as it does anywhere). After its subtree it clusters them (`cluster`: closer than
 * the spacing, of one variant, neither glowing nor tinted): a cluster of one stays plain glass with its rim and pool; a
 * larger one becomes a `FusedGlassInstance` in `fused`, its members leaving `glass` and their rims leaving
 * `decorations` (the fused slab's own edges are lit by its shell), their pools and shadows kept. A container nested in
 * another completes, and lists its clusters, first.
 */
export function buildRenderList(surface: SurfaceModel, theme: Theme, scheme: ColorScheme): RenderList {
  const rl: RenderList = { panels: [], glass: [], text: [], decorations: [], images: [], fused: [] }
  /** The fused members' glass and rims, taken out of `glass` and `decorations` at the end. */
  const drop = new Set<GlassInstance | DecorationInstance>()
  let z = 0
  /**
   * `parent.face`: the height (pt) of the face the node stands on, its nearest glass ancestor's top, else 0;
   * `parent.container`: the glass container that collects the node if it is glass (none inside glass).
   */
  const visit = (n: Node, originX: number, originY: number, clip: ClipRect | undefined, parent: { elevation: number; scale: number; transform: Mat2D; opacity: number; radius: number; w: number; h: number; face: number; container: Container | null }): void => {
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
    let face = parent.face
    const isGlass = n.type === 'glass' || s.bg === 'glass' || s.bg === 'glass-clear'
    if (isGlass) {
      const params = resolveGlass(s, rect, theme, scheme, v?.glass)
      const glass: GlassInstance = { ...base, radius, z: sortKey(myZ, 'glass'), params }
      const rim: DecorationInstance = { ...base, kind: 'rim', radius, cornerExponent: params.cornerExponent, color: [1, 1, 1, 1], strength: 1, z: sortKey(myZ, 'rim') }
      rl.glass.push(glass)
      rl.decorations.push(rim, { ...base, kind: 'pool', radius, cornerExponent: params.cornerExponent, ...poolOf(params.glow), z: sortKey(myZ, 'pool') })
      parent.container?.members.push({ glass, rim, fusible: fusible(s) })
      const height = elevation - parent.face   // the shadow falls on the face it stands on
      if (height > 0) rl.decorations.push({ ...base, elevation: height, kind: 'shadow', radius, cornerExponent: params.cornerExponent, color: [0, 0, 0, 1], strength: 1, z: sortKey(myZ, 'pool') - SHADOW_Z_BELOW_POOL })
      face = elevation + params.thickness
    } else if ((s.bg !== undefined && s.bg !== 'none') || s.border) {
      const color: RGBA = v?.bg ?? (s.bg !== undefined && s.bg !== 'none' ? resolveColor(s.bg, theme, scheme) : [0, 0, 0, 0])
      const border = s.border && { width: s.border.width, color: resolveColor(s.border.color, theme, scheme) }
      rl.panels.push({ ...base, radius, color, ...defined({ border }), z: sortKey(myZ, 'glass') })
    }
    if (n.state.focused && n.state.focusVisible && n.props.focusRing !== false) {
      const o = FOCUS_RING.offset
      rl.panels.push({
        ...base, rect: { x: rect.x - o, y: rect.y - o, width: rect.width + 2 * o, height: rect.height + 2 * o }, radius: radius + o,
        color: [0, 0, 0, 0], border: { width: FOCUS_RING.width, color: resolveColor(FOCUS_RING.color, theme, scheme) }, z: sortKey(myZ, 'pool'),
      })
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
    const spacing = containerSpacing(n)
    const own: Container | null = spacing !== null ? { node: n, spacing, members: [] } : null
    const container = own ?? (isGlass ? null : parent.container)
    for (const c of n.children) visit(c, rect.x - o.x, rect.y - o.y, childClip, { elevation, scale, transform, opacity, radius, w: rect.width, h: rect.height, face, container })
    if (own) cluster(own, rl.fused, drop)
  }
  visit(surface.root, 0, 0, undefined, { elevation: 0, scale: 1, transform: IDENTITY, opacity: 1, radius: surface.cornerRadius, w: surface.width, h: surface.height, face: 0, container: null })
  if (drop.size) {
    rl.glass = rl.glass.filter(g => !drop.has(g))
    rl.decorations = rl.decorations.filter(d => !drop.has(d))
  }
  return rl
}
