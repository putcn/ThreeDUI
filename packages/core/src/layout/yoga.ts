// Enums come from `yoga-layout/load` too: the package root instantiates a second wasm copy with a top-level await.
import {
  loadYoga, Align, Direction, Display, Edge, FlexDirection, Gutter, Justify, MeasureMode, Overflow, PositionType, Wrap,
  type Node as YNode, type Yoga,
} from 'yoga-layout/load'
import type { Node } from '../node'
import type { Length, Style } from '../style/schema'
import { effectiveStyle } from '../style/effective'
import type { LayoutEngine, MeasureFn } from './engine'
export type { LayoutEngine, MeasureFn } from './engine'

const FLEX_DIRECTION: Record<NonNullable<Style['flexDirection']>, FlexDirection> = {
  row: FlexDirection.Row, column: FlexDirection.Column, 'row-reverse': FlexDirection.RowReverse, 'column-reverse': FlexDirection.ColumnReverse,
}
const JUSTIFY: Record<NonNullable<Style['justifyContent']>, Justify> = {
  'flex-start': Justify.FlexStart, center: Justify.Center, 'flex-end': Justify.FlexEnd,
  'space-between': Justify.SpaceBetween, 'space-around': Justify.SpaceAround, 'space-evenly': Justify.SpaceEvenly,
}
const ALIGN: Record<NonNullable<Style['alignItems'] | Style['alignSelf']>, Align> = {
  auto: Align.Auto, 'flex-start': Align.FlexStart, center: Align.Center, 'flex-end': Align.FlexEnd, stretch: Align.Stretch, baseline: Align.Baseline,
}
const OVERFLOW: Record<NonNullable<Style['overflow']>, Overflow> = { visible: Overflow.Visible, hidden: Overflow.Hidden, scroll: Overflow.Scroll }

// Yoga itself resolves the shorthands: a specific edge beats Horizontal/Vertical, which beat All.
const BOX_EDGES = [[Edge.All, ''], [Edge.Horizontal, 'X'], [Edge.Vertical, 'Y'], [Edge.Top, 'Top'], [Edge.Right, 'Right'], [Edge.Bottom, 'Bottom'], [Edge.Left, 'Left']] as const
const INSET_EDGES = [[Edge.All, 'inset'], [Edge.Top, 'top'], [Edge.Right, 'right'], [Edge.Bottom, 'bottom'], [Edge.Left, 'left']] as const

/** Yoga has no `auto` min/max size; CSS `min-*: auto` is the default and `max-*` has no auto, so both mean unset. */
const noAuto = (v: Length | undefined): Exclude<Length, 'auto'> | undefined => (v === 'auto' ? undefined : v)
const finite = (v: number): number => (Number.isFinite(v) ? v : 0)
const extent = (v: number): number => (Number.isFinite(v) && v > 0 ? v : 0)
/** A viewport size for yoga: non-finite means unconstrained (`undefined`), negative means empty. */
const available = (v: number): number | undefined => (Number.isFinite(v) ? Math.max(0, v) : undefined)

/**
 * Writes every layout property on each sync, `undefined` restoring yoga's default, so an unset key never lingers.
 * Yoga only dirties a node when a value actually changes, so re-writing unchanged values keeps its cache.
 */
function applyStyle(y: YNode, s: Style): void {
  y.setDisplay(s.display === 'none' ? Display.None : Display.Flex)
  y.setPositionType(s.position === 'absolute' ? PositionType.Absolute : PositionType.Relative)
  y.setFlexDirection(FLEX_DIRECTION[s.flexDirection ?? 'column'])
  y.setJustifyContent(JUSTIFY[s.justifyContent ?? 'flex-start'])
  y.setAlignItems(ALIGN[s.alignItems ?? 'stretch'])
  y.setAlignSelf(ALIGN[s.alignSelf ?? 'auto'])
  y.setFlexWrap(s.flexWrap === 'wrap' ? Wrap.Wrap : Wrap.NoWrap)
  y.setOverflow(OVERFLOW[s.overflow ?? 'visible'])
  // An unset flexGrow lets yoga fall back to `flex`; flexShrink defaults to 1 as in CSS.
  y.setFlex(s.flex); y.setFlexGrow(s.flexGrow); y.setFlexShrink(s.flexShrink ?? 1)
  y.setFlexBasis(s.flexBasis)
  y.setWidth(s.width); y.setHeight(s.height)
  y.setMinWidth(noAuto(s.minWidth)); y.setMaxWidth(noAuto(s.maxWidth))
  y.setMinHeight(noAuto(s.minHeight)); y.setMaxHeight(noAuto(s.maxHeight))
  y.setAspectRatio(s.aspectRatio)
  for (const [edge, suffix] of BOX_EDGES) { y.setPadding(edge, s[`padding${suffix}`]); y.setMargin(edge, s[`margin${suffix}`]) }
  for (const [edge, key] of INSET_EDGES) { const v = s[key]; if (v === 'auto') y.setPositionAuto(edge); else y.setPosition(edge, v) }
  y.setGap(Gutter.All, s.gap); y.setGap(Gutter.Row, s.rowGap); y.setGap(Gutter.Column, s.columnGap)
}

interface Entry {
  readonly y: YNode
  /** The yoga children as last attached, compared by identity to detect tree changes. */
  kids: YNode[]
  /** Whether a measure callback is attached (yoga cannot be asked). */
  measured: boolean
  /** The root whose compute last synced the node: only that root's next compute may free it (`sweep`). */
  owner: Node
}

class YogaLayout implements LayoutEngine {
  private readonly entries = new WeakMap<Node, Entry>()
  /**
   * Per compute root, the nodes its last compute synced: what its next compute frees when they are gone from its tree
   * (`sweep`). Weak like `entries`, so a root dropped without `dispose` leaves no JS behind (its yoga nodes leak).
   */
  private readonly synced = new WeakMap<Node, Set<Node>>()
  private live = 0
  /** The measure function of the compute in progress; yoga calls measure callbacks only inside calculateLayout. */
  private measure: MeasureFn | undefined

  constructor(private readonly yoga: Yoga) {}

  get liveNodes(): number { return this.live }

  compute(root: Node, width: number, height: number, measure?: MeasureFn): void {
    const visited = new Set<Node>()
    this.measure = measure
    try {
      this.sync(root, root, visited).calculateLayout(available(width), available(height), Direction.LTR)
    } catch (e) {
      // a partial sync frees nothing, but what it reached (new entries included) stays tracked for the next sweep
      const prev = this.synced.get(root)
      if (prev) for (const n of visited) prev.add(n)
      else this.synced.set(root, visited)
      throw e
    } finally {
      this.measure = undefined
    }
    this.sweep(root, visited)
    root.walk(n => {
      const l = this.entries.get(n)!.y.getComputedLayout()   // sync() created an entry for every node
      n.layout = { x: finite(l.left), y: finite(l.top), width: extent(l.width), height: extent(l.height) }
      n.dirty.layout = false; n.dirty.tree = false; n.dirty.text = false
    })
  }

  dispose(root: Node): void {
    // Freeing a yoga node detaches it from its yoga parent; that parent's next sync sees the changed kids and re-attaches.
    root.walk(n => this.free(n))
    // a compute root: also what its last compute synced that has left its tree since (no sweep came for it)
    const prev = this.synced.get(root)
    if (prev) { this.synced.delete(root); for (const n of prev) if (this.entries.get(n)?.owner === root) this.free(n) }
  }

  /**
   * Frees the yoga nodes of the nodes `root`'s previous compute synced and this one (`visited`) did not reach: removed
   * subtrees. A node another root's compute synced since (a subtree moved between roots) is that root's now: kept.
   */
  private sweep(root: Node, visited: Set<Node>): void {
    const prev = this.synced.get(root)
    this.synced.set(root, visited)
    if (prev) for (const n of prev) if (!visited.has(n) && this.entries.get(n)?.owner === root) this.free(n)
  }

  /** Frees `n`'s yoga node, if it has one. A later sync of `n` makes a new one. */
  private free(n: Node): void {
    const e = this.entries.get(n)
    if (!e) return
    e.y.free(); this.entries.delete(n); this.live--
  }

  /** Brings `n`'s yoga node (and its subtree's) up to date for `root`'s compute, recording each node in `visited`. */
  private sync(n: Node, root: Node, visited: Set<Node>): YNode {
    const e = this.entries.get(n) ?? this.create(n, root)
    e.owner = root; visited.add(n)
    const { y } = e
    applyStyle(y, effectiveStyle(n))   // state branches included: Node.setState marks layout when one sets a layout key
    const wantsMeasure = n.type === 'text' && n.children.length === 0 && this.measure !== undefined
    // Yoga forbids children under a measured node, so drop the callback before any can be attached.
    if (e.measured && !wantsMeasure) { y.markDirty(); y.unsetMeasureFunc(); e.measured = false }

    // Reconcile by identity rather than dirty.tree: that also catches moves between parents and disposed children.
    const kids = n.children.map(c => this.sync(c, root, visited))
    if (kids.length !== e.kids.length || kids.some((k, i) => k !== e.kids[i])) {
      while (y.getChildCount() > 0) y.removeChild(y.getChild(0))
      kids.forEach((k, i) => {
        k.getParent()?.removeChild(k)   // a moved node may still sit under its old parent, which syncs later
        y.insertChild(k, i)
      })
      e.kids = kids
    }

    if (wantsMeasure) {
      if (!e.measured) { y.setMeasureFunc((w, mode) => this.measureText(n, w, mode)); e.measured = true; y.markDirty() }
      // setStyle/setState (font, size…) mark only `layout`, setProp marks `text`; either can change the measured size.
      else if (n.dirty.layout || n.dirty.text) y.markDirty()
    }
    return y
  }

  private create(n: Node, owner: Node): Entry {
    const e: Entry = { y: this.yoga.Node.create(), kids: [], measured: false, owner }
    this.entries.set(n, e); this.live++
    return e
  }

  private measureText(n: Node, width: number, mode: MeasureMode): { width: number; height: number } {
    const maxWidth = mode === MeasureMode.Undefined || !Number.isFinite(width) ? undefined : Math.max(0, width)
    const m = this.measure?.(n, maxWidth) ?? { width: 0, height: 0 }
    const w = extent(m.width)
    return { width: maxWidth === undefined ? w : Math.min(w, maxWidth), height: extent(m.height) }
  }
}

export async function createYogaLayout(): Promise<LayoutEngine> {
  return new YogaLayout(await loadYoga())
}
