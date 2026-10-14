import type { Node } from '../node'

/**
 * Measures a leaf `text` node, in pt. `maxWidth` is the width it may take, or `undefined` when unconstrained.
 * Non-finite or negative results are treated as 0.
 */
export type MeasureFn = (node: Node, maxWidth: number | undefined) => { width: number; height: number }

export interface LayoutEngine {
  /**
   * Lays out `root`'s subtree in a `width` × `height` pt viewport (a non-finite size means unconstrained),
   * writes every node's `layout` (relative to its parent) and clears its `layout`, `tree` and `text` dirty flags.
   * `measure` sizes `text` leaves; without it they lay out as empty boxes.
   * Releases the resources of the nodes `root`'s previous compute laid out that have left its tree since (removed
   * subtrees), unless another root's compute took them meanwhile (a subtree moved between roots).
   */
  compute(root: Node, width: number, height: number, measure?: MeasureFn): void
  /**
   * Releases the engine's resources for `root`'s subtree and, when `root` was a compute root, for the nodes its last
   * compute laid out that have left its tree since; call it for subtrees that are dropped.
   */
  dispose(root: Node): void
  /** Debug: the layout nodes currently allocated (yoga's live wasm nodes). */
  readonly liveNodes: number
}
