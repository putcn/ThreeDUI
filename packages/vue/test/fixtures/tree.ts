import type { Node, NodeType, Style } from '@glassui/core'

/** A compact snapshot of a node tree: auto-generated ids (`box-12`), empty styles and empty child lists are left out. */
export interface Snap { type: NodeType; id?: string; value?: unknown; style?: Style; children?: Snap[] }

/** Anchors and empty text nodes (Vue's fragment / `v-if` placeholders): layout-neutral. */
const hidden = (n: Node): boolean => n.type === 'anchor' || (n.type === 'text' && n.props.value === '')

/** `n`'s snapshot; anchors and empty text nodes are omitted unless `opts.anchors`. */
export function tree(n: Node, opts: { anchors?: boolean } = {}): Snap {
  const out: Snap = { type: n.type }
  if (!new RegExp(`^${n.type}-\\d+$`).test(n.id)) out.id = n.id
  if (n.props.value !== undefined) out.value = n.props.value
  if (Object.keys(n.style).length) out.style = n.style
  const kids = n.children.filter(c => opts.anchors || !hidden(c)).map(c => tree(c, opts))
  if (kids.length) out.children = kids
  return out
}
