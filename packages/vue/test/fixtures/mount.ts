import { createCanvas } from '@napi-rs/canvas'
import { defineComponent, type VNodeChild } from '@vue/runtime-core'
import { Node, type NodeType } from '@glassui/core'
import type { CanvasLike } from '@glassui/text'
import type { Surface } from '@glassui/render'
import { createGlassApp, type GlassApp } from '../../src/app'
import { createFakeRoot, type FakeRoot, type FakeSurface } from './fake-root'

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

export interface MountedInSurface extends Mounted {
  /** The Surface the app is mounted into; `c` is its root. */
  surface: FakeSurface
}

/**
 * `render` mounted by `createGlassApp` into a fake Surface of 800 × 600 (screen layer, or `opts.layer`) of a fake root
 * (`opts.root`, else a new one), then one `root.tick()` (the layout). Motion and errors as `mountGlass`'s.
 */
export function mountInSurface(render: () => VNodeChild, opts: { root?: FakeRoot; motion?: 'live' | 'frozen'; layer?: 'screen' | 'world' } = {}): MountedInSurface {
  const root = opts.root ?? createFakeRoot(), errors: string[] = []
  const surface = root.createSurface({ layer: opts.layer ?? 'screen', width: 800, height: 600 }) as unknown as FakeSurface
  const app = createGlassApp(defineComponent(() => render), { root, createCanvas: napiCanvas, ...(opts.motion ? { motion: opts.motion } : {}) })
  app.config.errorHandler = e => { errors.push(String(e)) }
  app.mount(surface as unknown as Surface)
  root.tick()
  return { c: surface.root, errors, root, app, surface }
}

/** The node under `n` (depth-first, `n` included) whose `props.part` is `name`; throws when there is none. */
export function part(n: Node, name: string): Node {
  const hit = findPart(n, name)
  if (!hit) throw new Error(`no part "${name}" under <${n.type} id=${n.id}>`)
  return hit
}
function findPart(n: Node, name: string): Node | null {
  if (n.props.part === name) return n
  for (const c of n.children) { const hit = findPart(c, name); if (hit) return hit }
  return null
}
/** Every node under `n` (depth-first, `n` included) whose `props.part` is `name`. */
export function parts(n: Node, name: string, out: Node[] = []): Node[] {
  if (n.props.part === name) out.push(n)
  for (const c of n.children) parts(c, name, out)
  return out
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
