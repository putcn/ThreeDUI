import type { Style } from './style/schema'   // created in Task 4; until then declare `export type Style = Record<string, unknown>` in a stub file
import { GlassUIError } from './errors'

export type NodeType = 'box' | 'text' | 'image' | 'glass' | 'scroll' | 'portal' | 'anchor'
export interface Rect { x: number; y: number; width: number; height: number }
export interface DirtyFlags { layout: boolean; paint: boolean; text: boolean; tree: boolean }
export interface NodeState { hover: boolean; pressed: boolean; focused: boolean; disabled: boolean }

let nextId = 1

export class Node {
  readonly id: string
  readonly type: NodeType
  parent: Node | null = null
  readonly children: Node[] = []
  props: Record<string, unknown> = {}
  style: Style = {} as Style
  layout: Rect = { x: 0, y: 0, width: 0, height: 0 }
  state: NodeState = { hover: false, pressed: false, focused: false, disabled: false }
  elevation = 0
  tilt = { x: 0, y: 0 }
  dirty: DirtyFlags = { layout: true, paint: true, text: true, tree: true }

  constructor(type: NodeType, id?: string) {
    this.type = type
    this.id = id ?? `${type}-${nextId++}`
  }

  get root(): Node { let n: Node = this; while (n.parent) n = n.parent; return n }

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
    this.markDirty('tree'); this.markDirty('layout')
  }

  removeChild(child: Node): void {
    const idx = this.children.indexOf(child)
    if (idx < 0) return
    this.children.splice(idx, 1)
    child.parent = null
    this.markDirty('tree'); this.markDirty('layout')
  }

  remove(): void { this.parent?.removeChild(this) }

  setStyle(partial: Partial<Style>): void {
    this.style = { ...this.style, ...partial }
    this.markDirty('layout'); this.markDirty('paint')
  }

  setProp(key: string, value: unknown): void {
    this.props = { ...this.props, [key]: value }
    this.markDirty('paint')
    if (this.type === 'text') { this.markDirty('text'); this.markDirty('layout') }
  }

  markDirty(flag: keyof DirtyFlags): void {
    this.dirty[flag] = true
    if (flag === 'layout' || flag === 'tree') {
      for (let p = this.parent; p; p = p.parent) { if (p.dirty[flag]) break; p.dirty[flag] = true }
    }
  }

  walk(fn: (n: Node) => void): void { fn(this); for (const c of this.children) c.walk(fn) }
}
