import type { DecorationInstance, FusedGlassInstance, GlassInstance, ImageInstance, Node, PanelInstance, RenderList, TextInstance } from '@glassui/core'

export interface Partition {
  content: { panels: PanelInstance[]; shadows: DecorationInstance[]; pools: DecorationInstance[]; text: TextInstance[]; images: ImageInstance[] }
  foreground: { rims: DecorationInstance[]; panels: PanelInstance[]; text: TextInstance[]; images: ImageInstance[] }
  /** Each foreground item's node (rims: their own glass node) → the nearest glass at or above it (a fused member's own). */
  glassOf: Map<Node, GlassInstance>
  /** Each fused member → its cluster, while clusters draw fused (empty with `fuse: false`). */
  fusedOf: Map<GlassInstance, FusedGlassInstance>
}

/**
 * Spec §5.1/§5.6: non-glass content is drawn into the Surface's content RT; whatever sits *on* a glass element (its
 * descendants) is drawn in 3D on top of the slab. Pools and shadows lie under the glass (content), rims ride on top
 * (foreground). Panels (a box's background or border) ride their glass as its text does (spatial spec §11.8). So does
 * a glass node's own focus ring (glass draws no panel of its own, `buildRenderList`, so a panel whose node is glass is
 * that ring): it rides that glass's top face, as its rim does, so it stays registered with the raised control however
 * the perspective sees it; on the plane under the glass, a raised Button's ring drew offset from it (Task 10 V1).
 * O(n): every node's nearest glass (or none) is memoised, so each ancestor chain is walked once.
 *
 * Glass containers (spec §5.2): every fused member counts as glass, so what sits on it rides on top as on any glass.
 * While its cluster draws fused (`opts.fuse`, default true; false in the 'fill' glass mode, which draws the members
 * alone) it rides on the fused slab: `liftFor` lifts it onto the slab's top (`fusedOf`).
 */
export function partition(rl: RenderList, opts: { fuse?: boolean } = {}): Partition {
  const glass = new Map<Node, GlassInstance>(), fusedOf = new Map<GlassInstance, FusedGlassInstance>()
  for (const g of rl.glass) glass.set(g.node, g)
  for (const f of rl.fused) for (const m of f.members) { glass.set(m.node, m); if (opts.fuse !== false) fusedOf.set(m, f) }
  const memo = new Map<Node, GlassInstance | null>()
  const glassOf = new Map<Node, GlassInstance>()
  const nearest = (n: Node): GlassInstance | null => {
    const path: Node[] = []
    let found: GlassInstance | null = null
    for (let p: Node | null = n; p; p = p.parent) {
      const m = memo.get(p)
      if (m !== undefined) { found = m; break }
      path.push(p)
      const g = glass.get(p)
      if (g) { found = g; break }
    }
    for (const q of path) memo.set(q, found)
    if (found) glassOf.set(n, found)
    return found
  }
  const out: Partition = { content: { panels: [], shadows: [], pools: [], text: [], images: [] }, foreground: { rims: [], panels: [], text: [], images: [] }, glassOf, fusedOf }
  for (const d of rl.decorations) {
    if (d.kind === 'pool') out.content.pools.push(d)
    else if (d.kind === 'shadow') out.content.shadows.push(d)
    else { out.foreground.rims.push(d); nearest(d.node) }
  }
  for (const p of rl.panels) (nearest(p.node) ? out.foreground.panels : out.content.panels).push(p)
  for (const t of rl.text) (nearest(t.node) ? out.foreground.text : out.content.text).push(t)
  for (const i of rl.images) (nearest(i.node) ? out.foreground.images : out.content.images).push(i)
  return out
}

/**
 * How far above its own elevation a foreground item is lifted (0 for content-layer items): the thickness of the glass
 * it rides on; on a fused member, up to the fused slab's top — the cluster's elevation (its tallest member's) plus its
 * thickness, less the member's own elevation (which the item's composed elevation already holds). So a resting
 * member's label stays on the slab when a hovered neighbour raises it.
 */
export function liftFor(p: Partition, node: Node): number {
  const g = p.glassOf.get(node)
  if (!g) return 0
  const f = p.fusedOf.get(g)
  return f ? f.elevation + f.params.thickness - g.elevation : g.params.thickness
}

/** The halves of `splitNested`: the glass by nesting, and the fused clusters by the nesting of their members. */
export interface NestedSplit { outer: GlassInstance[]; inner: GlassInstance[]; outerFused: FusedGlassInstance[]; innerFused: FusedGlassInstance[] }

/**
 * Spatial spec §2.4: `glass` split by nesting, each half in list order. An instance is inner when one of its node's
 * ancestors is another instance's node, at any depth (a third level is inner too: only two levels are told apart);
 * the rest are outer. A fused cluster's members count as glass nodes too (glass inside a member is inner), and a
 * cluster is inner when its first member is (they share the container, with no glass between it and them).
 */
export function splitNested(glass: readonly GlassInstance[], fused: readonly FusedGlassInstance[] = []): NestedSplit {
  const nodes = new Set(glass.map(g => g.node))
  for (const f of fused) for (const m of f.members) nodes.add(m.node)
  const nested = (n: Node): boolean => { for (let p = n.parent; p; p = p.parent) if (nodes.has(p)) return true; return false }
  const out: NestedSplit = { outer: [], inner: [], outerFused: [], innerFused: [] }
  for (const g of glass) (nested(g.node) ? out.inner : out.outer).push(g)
  for (const f of fused) (f.members[0] && nested(f.members[0].node) ? out.innerFused : out.outerFused).push(f)
  return out
}
