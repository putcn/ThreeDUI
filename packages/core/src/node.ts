import { LAYOUT_KEYS, TEXT_LAYOUT_KEYS, type Style } from './style/schema'
import { GlassUIError } from './errors'
import type { RGBA } from './style/theme'

export type NodeType = 'box' | 'text' | 'image' | 'glass' | 'scroll' | 'portal' | 'anchor'
export interface Rect { x: number; y: number; width: number; height: number }
export interface DirtyFlags { layout: boolean; paint: boolean; text: boolean; tree: boolean }
export interface NodeState { hover: boolean; pressed: boolean; focused: boolean; disabled: boolean }

/** Glass numbers the animation runtime can drive (`glow.strength` as `glowStrength`). */
export type GlassNumericKey = 'thickness' | 'fillet' | 'filletBottom' | 'scatter' | 'lift' | 'edgeGlow' | 'ior' | 'dispersion' | 'roughness' | 'absorption' | 'glowStrength' | 'envIntensity' | 'specularIntensity' | 'innerGlow'

/**
 * Animated "visual values" (spec §4.4): what the render list draws instead of the node's layout/style targets while a
 * transition is in flight. Absolute values, not deltas; `x`/`y`/`width`/`height` replace `layout`. Written only by
 * `AnimationRuntime`; `null` when nothing is animating, so steady-state nodes cost nothing.
 */
export interface VisualValues {
  x?: number; y?: number; width?: number; height?: number
  scale?: number; opacity?: number; elevation?: number; tilt?: { x: number; y: number }
  color?: RGBA; bg?: RGBA; radius?: number
  glass?: Partial<Record<GlassNumericKey, number>> & { glowColor?: RGBA; tint?: RGBA | null }
}

let nextId = 1

const STATES = ['hover', 'pressed', 'focused', 'disabled'] as const

/** Whether switching `branch` on or off can move or resize a node of `type`: it sets a layout key to a value. */
function changesLayout(branch: Style[keyof NodeState], type: NodeType): boolean {
  if (!branch) return false
  return Object.entries(branch).some(([k, v]) => v !== undefined && (LAYOUT_KEYS.has(k) || (type === 'text' && TEXT_LAYOUT_KEYS.has(k))))
}

export class Node {
  readonly id: string
  readonly type: NodeType
  parent: Node | null = null
  readonly children: Node[] = []
  props: Record<string, unknown> = {}
  style: Style = {} as Style
  layout: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private readonly st: NodeState = { hover: false, pressed: false, focused: false, disabled: false }
  private el = 0
  private tl = { x: 0, y: 0 }
  /** Animated overrides, see `VisualValues`; set through `setVisual`. */
  visual: VisualValues | null = null
  dirty: DirtyFlags = { layout: true, paint: true, text: true, tree: true }

  constructor(type: NodeType, id?: string) {
    this.type = type
    this.id = id ?? `${type}-${nextId++}`
  }

  get root(): Node { let n: Node = this; while (n.parent) n = n.parent; return n }

  /** Interaction state; change it with `setState`, which keeps the dirty flags right. */
  get state(): Readonly<NodeState> { return this.st }

  /** Lift along the Surface normal, pt (spec §3.3). Not laid out; assigning a new value marks `paint`. */
  get elevation(): number { return this.el }
  set elevation(v: number) { if (v !== this.el) { this.el = v; this.markDirty('paint') } }
  /** Hover tilt in radians about x and y. Read-only out, copied in; assigning marks `paint` when either component changes. */
  get tilt(): Readonly<{ x: number; y: number }> { return this.tl }
  set tilt(v: { x: number; y: number }) { if (v.x !== this.tl.x || v.y !== this.tl.y) { this.tl = { x: v.x, y: v.y }; this.markDirty('paint') } }

  setVisual(v: VisualValues | null): void { this.visual = v; this.markDirty('paint') }

  appendChild(child: Node): void { this.insertBefore(child, null) }

  insertBefore(child: Node, ref: Node | null): void {
    // Validate everything before mutating, so a failed call leaves the tree unchanged.
    if (ref === child) throw new GlassUIError('Node.insertBefore', 'ref 不能是 child 自身')
    for (let n: Node | null = this; n; n = n.parent) {
      if (n === child) throw new GlassUIError('Node.insertBefore', '不能把祖先节点插入其后代（会形成环）')
    }
    if (ref && ref.parent !== this) throw new GlassUIError('Node.insertBefore', `ref ${ref.id} 不是 ${this.id} 的子节点`)
    if (child.parent) child.parent.removeChild(child)
    const idx = ref ? this.children.indexOf(ref) : -1
    if (idx < 0) this.children.push(child); else this.children.splice(idx, 0, child)
    child.parent = this
    this.markDirty('tree'); this.markDirty('layout'); this.markDirty('paint')
  }

  removeChild(child: Node): void {
    const idx = this.children.indexOf(child)
    if (idx < 0) return
    this.children.splice(idx, 1)
    child.parent = null
    this.markDirty('tree'); this.markDirty('layout'); this.markDirty('paint')
  }

  remove(): void { this.parent?.removeChild(this) }

  setStyle(partial: Partial<Style>): void {
    this.style = { ...this.style, ...partial }
    this.markDirty('layout'); this.markDirty('paint')
  }

  /**
   * Sets the given state flags. An actual change marks `paint`; it also marks `layout` when a state branch being
   * switched on or off sets a layout key (`LAYOUT_KEYS`, plus typography on `text` nodes, which changes the measure).
   */
  setState(partial: Partial<NodeState>): void {
    let changed = false, layout = false
    for (const k of STATES) {
      const v = partial[k]
      if (v === undefined || v === this.st[k]) continue
      this.st[k] = v
      changed = true
      layout ||= changesLayout(this.style[k], this.type)
    }
    if (changed) this.markDirty('paint')
    if (layout) this.markDirty('layout')
  }

  setProp(key: string, value: unknown): void {
    this.props = { ...this.props, [key]: value }
    this.markDirty('paint')
    if (this.type === 'text') { this.markDirty('text'); this.markDirty('layout') }
  }

  /** `layout`, `paint` and `tree` also mark every ancestor, so a frame can start its checks at the root; `text` stays local. */
  markDirty(flag: keyof DirtyFlags): void {
    this.dirty[flag] = true
    if (flag === 'layout' || flag === 'paint' || flag === 'tree') {
      for (let p = this.parent; p; p = p.parent) { if (p.dirty[flag]) break; p.dirty[flag] = true }
    }
  }

  walk(fn: (n: Node) => void): void { fn(this); for (const c of this.children) c.walk(fn) }
}
