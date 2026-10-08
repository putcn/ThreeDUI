import type { Node, Rect } from '../node'
import type { Style } from '../style/schema'
import { effectiveStyle } from '../style/effective'
import { defaultTheme, resolveRadius, type Theme } from '../style/theme'
import { GlassUIError } from '../errors'
import { IDENTITY, apply, invert, multiply, scaleAbout, type Mat2D } from '../transform2d'

const finiteOr0 = (v: unknown): number => { const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0 }

/** How far a `scroll` node shifts its children: `props.scrollX/scrollY` (non-finite counts as 0). */
export function scrollOffset(n: Node): { x: number; y: number } {
  return n.type === 'scroll' ? { x: finiteOr0(n.props.scrollX), y: finiteOr0(n.props.scrollY) } : { x: 0, y: 0 }
}

/** The node's rect in Surface pt: its layout plus every ancestor's, minus the scroll offsets of `scroll` ancestors. */
export function absoluteRect(node: Node): Rect {
  let x = node.layout.x, y = node.layout.y
  for (let p = node.parent; p; p = p.parent) {
    const o = scrollOffset(p)
    x += p.layout.x - o.x; y += p.layout.y - o.y
  }
  return { x, y, width: node.layout.width, height: node.layout.height }
}

/**
 * Whether (x, y) lies in `r` with corners rounded by `radius`, clamped to half the shorter side (the largest that fits).
 * Edges are half-open (right and bottom excluded), so zero-size nodes are never hit and abutting siblings never overlap.
 */
function insideRounded(r: Rect, radius: number, x: number, y: number): boolean {
  if (!(x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)) return false   // also rejects NaN
  const rad = Math.min(radius, r.width / 2, r.height / 2)
  if (!(rad > 0)) return true
  const cx = Math.max(r.x + rad, Math.min(x, r.x + r.width - rad))
  const cy = Math.max(r.y + rad, Math.min(y, r.y + r.height - rad))
  return (x - cx) ** 2 + (y - cy) ** 2 <= rad * rad
}

function clips(n: Node, s: Style): boolean { return s.overflow === 'hidden' || s.overflow === 'scroll' || n.type === 'scroll' }

/** How far `layout` sits inside a `width × height` parent at its nearest edge: the gap a concentric radius subtracts. */
function inset(layout: Rect, width: number, height: number): number {
  return Math.max(0, Math.min(layout.x, layout.y, width - layout.x - layout.width, height - layout.y - layout.height))
}

/** `m`'s inverse, or null when `m` is singular (e.g. a `scale` of 0 mid-animation): such a node has no footprint. */
function inverseOrNull(m: Mat2D): Mat2D | null {
  try { return invert(m) } catch (e) { if (e instanceof GlassUIError) return null; throw e }
}

/**
 * Topmost node under (x, y) in Surface pt within `root`'s subtree, or null.
 * Later siblings are above earlier ones and children above their parent. `display: 'none'` hides a whole subtree;
 * `overflow: hidden|scroll` and `scroll` nodes clip their descendants to their own rounded shape.
 * `pointerEvents` inherits as in CSS: `'none'` makes a node and its descendants transparent to the pointer,
 * and a descendant that sets `'auto'` becomes hittable again. Radius tokens resolve against `theme`, and an
 * unknown token throws a GlassUIError like every theme lookup. Each node's effective style is read (its active state
 * branches applied, e.g. `hover: { display: 'none' }`), and `root`'s own ancestors are not consulted.
 * Geometry mirrors `buildRenderList`: a node's `visual` values replace its layout rect and radius; `concentric` resolves
 * against the parent's (clamped) radius minus the node's inset (`root`'s parent radius counts as 0); and the point is
 * mapped through the inverse of the composed `scale` transform (style or visual, about each node's rect centre, children
 * inheriting it) before the rounded-rect test. A node whose composed transform is singular is skipped with its subtree.
 */
export function hitTest(root: Node, x: number, y: number, theme: Theme = defaultTheme): Node | null {
  type Parent = { transform: Mat2D; radius: number; w: number; h: number; pointerEvents: Style['pointerEvents'] }
  const visit = (n: Node, originX: number, originY: number, parent: Parent): Node | null => {
    const s = effectiveStyle(n)
    if (s.display === 'none') return null
    const v = n.visual
    const layout: Rect = { x: v?.x ?? n.layout.x, y: v?.y ?? n.layout.y, width: v?.width ?? n.layout.width, height: v?.height ?? n.layout.height }
    const r: Rect = { x: originX + layout.x, y: originY + layout.y, width: layout.width, height: layout.height }
    const ownScale = v?.scale ?? s.scale ?? 1
    const transform = ownScale === 1 ? parent.transform : multiply(parent.transform, scaleAbout(r.x + r.width / 2, r.y + r.height / 2, ownScale))
    const inverse = inverseOrNull(transform)
    if (!inverse) return null
    const [lx, ly] = apply(inverse, x, y)
    const resolved = v?.radius ?? resolveRadius(s.radius, theme, r.width, r.height, parent.radius, inset(layout, parent.w, parent.h))
    const radius = Math.max(0, Math.min(resolved, r.width / 2, r.height / 2))
    const inside = insideRounded(r, radius, lx, ly)
    if (clips(n, s) && !inside) return null
    const pointerEvents = s.pointerEvents ?? parent.pointerEvents
    const o = scrollOffset(n)
    for (let i = n.children.length - 1; i >= 0; i--) {
      const hit = visit(n.children[i]!, r.x - o.x, r.y - o.y, { transform, radius, w: r.width, h: r.height, pointerEvents })
      if (hit) return hit
    }
    return inside && pointerEvents !== 'none' ? n : null
  }
  const r = absoluteRect(root)
  return visit(root, r.x - root.layout.x, r.y - root.layout.y, { transform: IDENTITY, radius: 0, w: root.layout.width, h: root.layout.height, pointerEvents: 'auto' })
}
