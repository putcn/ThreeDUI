import { createCanvas } from '@napi-rs/canvas'
import { defineComponent, type VNodeChild } from '@vue/runtime-core'
import { Node, type NodeType } from '@glassui/core'
import type { CanvasLike } from '@glassui/text'
import { createGlassApp, type GlassApp } from '../../src/app'
import { createFakeRoot, type FakeRoot } from './fake-root'

/** A canvas factory over `@napi-rs/canvas` (what `createGlassApp`'s `createCanvas` takes in Node). */
export const napiCanvas = (w: number, h: number): CanvasLike => createCanvas(w, h) as unknown as CanvasLike

export interface Mounted {
  /** The container the app is mounted into (a detached `box`). */
  c: Node
  /** What reached the app's error handler, as strings, in order. */
  errors: string[]
  root: FakeRoot
  app: GlassApp
}

/**
 * `render` mounted by `createGlassApp` into a detached container: a fake root (`opts.root`, else a new one), a
 * `@napi-rs/canvas` canvas factory, motion `opts.motion` (default `'live'`), and an error handler that collects the
 * errors (so nothing reaches the console).
 */
export function mountGlass(render: () => VNodeChild, opts: { root?: FakeRoot; motion?: 'live' | 'frozen' } = {}): Mounted {
  const root = opts.root ?? createFakeRoot(), errors: string[] = []
  const app = createGlassApp(defineComponent(() => render), { root, createCanvas: napiCanvas, ...(opts.motion ? { motion: opts.motion } : {}) })
  app.config.errorHandler = e => { errors.push(String(e)) }
  const c = new Node('box')
  app.mount(c)
  return { c, errors, root, app }
}

/** The first node of `type` under `n` (depth-first, `n` itself excluded); throws when there is none. */
export function first(n: Node, type: NodeType): Node {
  const hit = find(n, type)
  if (!hit) throw new Error(`no <${type}> under <${n.type} id=${n.id}>`)
  return hit
}
function find(n: Node, type: NodeType): Node | null {
  for (const c of n.children) { if (c.type === type) return c; const hit = find(c, type); if (hit) return hit }
  return null
}
/** Every node of `type` under `n`, depth-first (`n` itself excluded). */
export function all(n: Node, type: NodeType, out: Node[] = []): Node[] {
  for (const c of n.children) { if (c.type === type) out.push(c); all(c, type, out) }
  return out
}
