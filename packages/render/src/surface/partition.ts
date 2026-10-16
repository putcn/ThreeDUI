import type { DecorationInstance, GlassInstance, ImageInstance, Node, PanelInstance, RenderList, TextInstance } from '@glassui/core'

export interface Partition {
  content: { panels: PanelInstance[]; shadows: DecorationInstance[]; pools: DecorationInstance[]; text: TextInstance[]; images: ImageInstance[] }
  foreground: { rims: DecorationInstance[]; text: TextInstance[]; images: ImageInstance[] }
  /** Each foreground item's node (rims: their own glass node) → the nearest glass at or above it. */
  glassOf: Map<Node, GlassInstance>
}

/**
 * Spec §5.1/§5.6: non-glass content is drawn into the Surface's content RT; whatever sits *on* a glass element (its
 * descendants) is drawn in 3D on top of the slab. Pools and shadows lie under the glass (content), rims ride on top
 * (foreground).
 * O(n): every node's nearest glass (or none) is memoised, so each ancestor chain is walked once.
 */
export function partition(rl: RenderList): Partition {
  const glass = new Map<Node, GlassInstance>()
  for (const g of rl.glass) glass.set(g.node, g)
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
  const out: Partition = { content: { panels: [...rl.panels], shadows: [], pools: [], text: [], images: [] }, foreground: { rims: [], text: [], images: [] }, glassOf }
  for (const d of rl.decorations) {
    if (d.kind === 'pool') out.content.pools.push(d)
    else if (d.kind === 'shadow') out.content.shadows.push(d)
    else { out.foreground.rims.push(d); nearest(d.node) }
  }
  for (const t of rl.text) (nearest(t.node) ? out.foreground.text : out.content.text).push(t)
  for (const i of rl.images) (nearest(i.node) ? out.foreground.images : out.content.images).push(i)
  return out
}

/** The thickness of the glass a foreground item rides on (0 for content-layer items). */
export function liftFor(p: Partition, node: Node): number { return p.glassOf.get(node)?.params.thickness ?? 0 }

/**
 * Spatial spec §2.4: `glass` split by nesting, each half in list order. An instance is inner when one of its node's
 * ancestors is another instance's node, at any depth (a third level is inner too: only two levels are told apart);
 * the rest are outer.
 */
export function splitNested(glass: readonly GlassInstance[]): { outer: GlassInstance[]; inner: GlassInstance[] } {
  const nodes = new Set(glass.map(g => g.node))
  const out = { outer: [] as GlassInstance[], inner: [] as GlassInstance[] }
  for (const g of glass) {
    let nested = false
    for (let p = g.node.parent; p && !nested; p = p.parent) nested = nodes.has(p)
    ;(nested ? out.inner : out.outer).push(g)
  }
  return out
}
