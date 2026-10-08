import type { Node } from './node'
import type { EventDispatcher } from './events/dispatch'
import { effectiveStyle } from './style/effective'

/** `props.tabIndex` as a number (numeric strings allowed); NaN when absent, `null`, boolean or blank. */
function tabIndexOf(n: Node): number {
  const v = n.props.tabIndex
  return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? Number(v) : NaN
}

/**
 * Keyboard focus for the tree under `root`.
 * Tab order follows the DOM: nodes with a positive `props.tabIndex` first, ascending (equal values in tree order),
 * then the nodes with `tabIndex` 0 in tree order; negative or missing values stay out of the Tab order.
 * Disabled nodes and `display: 'none'` subtrees (read from the effective style, so state branches count) are skipped.
 * `focus()` also takes nodes without a tabIndex (like the DOM's `tabIndex = -1`), but never one that is detached,
 * disabled or hidden. `state.focused` is updated (through `Node.setState`) before `blur`/`focus` (which do not
 * bubble) are dispatched; a `blur` listener that moves focus elsewhere wins over the focus change that blurred it.
 */
export class FocusManager {
  private cur: Node | null = null

  constructor(private readonly root: Node, private readonly d: EventDispatcher) {}

  get current(): Node | null { return this.cur }

  focusables(): Node[] {
    const out: { n: Node; tab: number }[] = []
    const visit = (n: Node): void => {
      if (effectiveStyle(n).display === 'none') return   // hides the whole subtree
      const tab = tabIndexOf(n)
      if (Number.isFinite(tab) && tab >= 0 && !n.state.disabled) out.push({ n, tab })
      for (const c of n.children) visit(c)
    }
    visit(this.root)
    const positive = out.filter(o => o.tab > 0).sort((a, b) => a.tab - b.tab)   // sort is stable: ties keep tree order
    return [...positive, ...out.filter(o => o.tab === 0)].map(o => o.n)
  }

  /** `blur` on the old node, then `focus` on `node`; `null` just blurs. A no-op for nodes that cannot take focus. */
  focus(node: Node | null): void {
    if (node === this.cur || (node && !this.canFocus(node))) return
    const old = this.cur
    if (old) {
      this.cur = null; old.setState({ focused: false })
      this.d.dispatch(old, 'blur')
    }
    // A blur listener may have focused another node, or made `node` unfocusable.
    if (!node || this.cur || !this.canFocus(node)) return
    this.cur = node; node.setState({ focused: true })
    this.d.dispatch(node, 'focus')
  }

  /** From nothing focused (or a node outside the Tab order), Tab starts at the first node and Shift+Tab at the last. */
  private step(dir: 1 | -1): Node | null {
    const list = this.focusables()
    if (!list.length) { this.focus(null); return null }
    const i = this.cur ? list.indexOf(this.cur) : -1
    this.focus(i < 0 ? list[dir > 0 ? 0 : list.length - 1]! : list[(i + dir + list.length) % list.length]!)
    return this.cur
  }
  next(): Node | null { return this.step(1) }
  prev(): Node | null { return this.step(-1) }

  /**
   * Tab / Shift+Tab (on down) move focus; other keys go to the focused node as keydown/keyup, else to the root.
   * Reconciles first, so a key never reaches a node that has been removed, disabled or hidden.
   */
  key(key: string, down = true): void {
    this.reconcile()
    if (down && key === 'Tab') { this.next(); return }
    if (down && key === 'Shift+Tab') { this.prev(); return }
    this.d.dispatch(this.cur ?? this.root, down ? 'keydown' : 'keyup', { key })
  }

  /** Call after tree or state changes: if the focused node was removed, disabled or hidden, blurs it and clears focus. */
  reconcile(): void {
    if (this.cur && !this.canFocus(this.cur)) this.focus(null)
  }

  /** In this tree, enabled, and not inside a `display: 'none'` subtree. */
  private canFocus(n: Node): boolean {
    if (n.state.disabled) return false
    for (let p: Node | null = n; p; p = p.parent) {
      if (effectiveStyle(p).display === 'none') return false
      if (p === this.root) return true
    }
    return false
  }
}
