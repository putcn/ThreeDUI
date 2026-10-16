import {
  callWithAsyncErrorHandling, createRenderer, ErrorCodes, markRaw, normalizeClass, toRaw,
  type CreateAppFunction, type RendererOptions, type RootRenderFunction,
} from '@vue/runtime-core'
import { GlassUIError, Node, parseTw, UI_EVENT_TYPES, validateStyle, type NodeType, type Style, type UIEventType } from '@glassui/core'
import type { GlassRoot } from './root'

/** The elements a template can use (spec §8.1); `anchor` nodes are Vue's own (comments). */
export const HOST_TAGS = ['box', 'text', 'image', 'glass', 'scroll', 'portal'] as const
export type HostTag = (typeof HOST_TAGS)[number]
/** Style layers over a node's own style, lowest first: `control` < `morph` < `transition`. */
export type StyleLayer = 'control' | 'morph' | 'transition'

/**
 * What the props and the layers set on a node, its style is composed from (`compose`): `tw` and `class` parsed, `style`
 * validated (both when the prop is patched, so a bad value throws before anything changes), the layers as given.
 */
interface Raw { tw?: Style; class?: Style; style?: Style; layers: Partial<Record<StyleLayer, Style>> }
const raws = new WeakMap<Node, Raw>()
const rawOf = (n: Node): Raw => { let r = raws.get(n); if (!r) raws.set(n, r = { layers: {} }); return r }

/** State branches: two of them merge key by key (the later wins per key), as `effectiveStyle` lays them over the base. */
const BRANCHES: ReadonlySet<string> = new Set(['hover', 'pressed', 'focused', 'disabled'])
/** Partial objects that merge entry by entry, as in core's `effectiveStyle`. */
const NESTED: ReadonlySet<string> = new Set(['glass', 'transition'])

const isPlain = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null) return false
  const p: unknown = Object.getPrototypeOf(v)
  return p === Object.prototype || p === null
}
/** A deep copy of plain data (plain objects, arrays); anything else as it is. */
const copy = (v: unknown): unknown => Array.isArray(v) ? v.map(copy) : isPlain(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)])) : v

/** `a`'s entries, then `b`'s defined ones copied over them (a NESTED object's merge). */
function merge(a: unknown, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = isPlain(a) ? { ...a } : {}
  for (const [k, v] of Object.entries(b)) if (v !== undefined) out[k] = copy(v)
  return out
}

/**
 * `b` laid over `a` into a new style: `undefined` values are skipped, state branches merge key by key (recursively, so
 * their `glass` / `transition` too), `glass` / `transition` merge entry by entry, anything else replaces. Every value
 * taken from `b` is a deep copy: the node's style never shares an object with the props (a reactive style mutated in
 * place) or a layer, so `replaceStyle`'s deep comparison sees the change.
 */
function over(a: Record<string, unknown>, b: object | undefined): Record<string, unknown> {
  if (!b) return a
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue
    out[k] = BRANCHES.has(k) && isPlain(v) ? over(isPlain(out[k]) ? out[k] : {}, v) : NESTED.has(k) && isPlain(v) ? merge(out[k], v) : copy(v)
  }
  return out
}

/**
 * A component root's own `style` with the `style` its user passed (fallthrough) laid over it, as styles compose here:
 * state branches and `glass` / `transition` merge key by key, the user's values win, `undefined` is skipped. Unless
 * both are plain objects, the user's as given.
 */
export const mergeStyle = (own: unknown, user: unknown): unknown => isPlain(own) && isPlain(user) ? over(own, user) : user

/** Recomputes `n.style`: tw < class < style < control < morph < transition (`replaceStyle`: an equal style is a no-op). */
function compose(n: Node): void {
  const r = rawOf(n)
  let s: Record<string, unknown> = {}
  for (const part of [r.tw, r.class, r.style, r.layers.control, r.layers.morph, r.layers.transition]) s = over(s, part)
  n.replaceStyle(s as Style)
}

/**
 * Sets (or with `null` removes) one of `node`'s style layers and recomposes its style (tw < class < style < control <
 * morph < transition): composition (`useGlassControl`, the glassId morph, `GlassTransition`) styles a node without
 * fighting Vue's patches of its props or each other. The composition starts from the node's `tw` / `class` / `style`
 * props, so it is for nodes a glass renderer made (a style set directly with `setStyle` is replaced). Layers are not
 * validated.
 */
export function setStyleLayer(node: Node, layer: StyleLayer, style: Style | null): void {
  const r = rawOf(node)
  if (style) r.layers[layer] = style; else delete r.layers[layer]
  compose(node)
}

/** Nodes whose subtrees `nodeOps.remove` leaves in place (`holdContent`). */
const held = new WeakSet<Node>()
/**
 * Holds `n`'s subtree where it is: from now on the renderer's `remove` skips `n` and every node under it, so Vue still
 * unmounts the components there (their hooks run) while their nodes stay on screen. A Block holds its Surface's root as
 * it leaves, so its content flies away with it; the nodes go when the held Surface is disposed with them.
 */
export function holdContent(n: Node): void { held.add(toRaw(n)) }
/** Whether `n` or an ancestor of it is held (`holdContent`). */
export function isHeld(n: Node): boolean {
  for (let x: Node | null = toRaw(n); x; x = x.parent) if (held.has(x)) return true
  return false
}

/** Layout-neutral: Vue's anchors (comments) and empty text nodes take no space and no flex gap. */
const EMPTY: Style = { position: 'absolute', width: 0, height: 0 }
const EVENT_PROPS = UI_EVENT_TYPES.map(t => `on${t[0]!.toUpperCase()}${t.slice(1)}`)

export interface GlassRendererOptions {
  root: GlassRoot
  /**
   * Reports an error that must not be thrown: a Teleport target that is not there (`querySelector` runs inside Vue's
   * post-flush callbacks for `defer`, which do not catch). Default `console.error`; `createGlassApp` passes its app's
   * error handler (console + marker).
   */
  onError?: (err: unknown) => void
}

/**
 * A Vue renderer over core `Node`s (spec §8.1). `querySelector` (Teleport's `to`) looks through the containers its
 * apps are mounted in and every Surface of `root`: `#id` finds a node by id, a bare name a `portal` with that `name`;
 * a miss is reported as a `GlassUIError` through `opts.onError` (Vue itself only warns and drops the children) and
 * yields a detached placeholder. An error while mounting goes to `app.config.errorHandler` when one is set (Vue rethrows it from `mount`
 * otherwise), after the nodes the failed mount inserted into the container are taken out again.
 */
export function createGlassRenderer(opts: GlassRendererOptions): { render: RootRenderFunction<Node>; createApp: CreateAppFunction<Node> } {
  const { root } = opts
  const report = opts.onError ?? ((err: unknown) => { console.error('[glassui]', err) })
  const containers = new Set<Node>()
  const textNode = (t: string): Node => { const n = markRaw(new Node('text')); n.setProp('value', t); if (t === '') n.replaceStyle(EMPTY); return n }
  const searched = (): Node[] => [...containers, ...root.surfaces.map(s => s.root)]
  const find = (pred: (n: Node) => boolean): Node | null => {
    let hit: Node | null = null
    for (const r of searched()) { r.walk(n => { if (!hit && pred(n)) hit = n }); if (hit) break }
    return hit
  }
  /**
   * Teleport's `to`: `#id` or a portal's name. A miss is reported (with the portal names there are as the allowed
   * values), never thrown: a throw from a deferred Teleport's lookup would escape Vue's scheduler and stall it. It
   * yields a detached placeholder, not null: Vue mounts the children into it unseen (with null they stay unmounted and
   * every later patch of them throws), and a later change of `to` moves them to the new target.
   */
  const teleportTarget = (sel: string): Node => {
    const byId = sel.startsWith('#')
    const hit = byId ? find(n => n.id === sel.slice(1)) : find(n => n.type === 'portal' && n.props.name === sel)
    if (hit) return hit
    const names = new Set<string>()
    if (!byId) for (const r of searched()) r.walk(n => { if (n.type === 'portal' && typeof n.props.name === 'string') names.add(n.props.name) })
    const err = new GlassUIError('Teleport', `找不到目标 "${sel}"（to 可以是 Node、"#id" 或 portal 的 name，目标须在 Teleport 挂载前已在树中；与 Teleport 同一次渲染出来的 portal 要写成 <Teleport defer to="${sel}">）`, { allowed: [...names], got: sel })
    try { report(err) } catch (e) { console.error('[glassui] the error reporter threw:', e, 'reporting:', err) }   // never out of a lookup
    return markRaw(new Node('box'))
  }
  const ops: RendererOptions<Node, Node> = {
    createElement(tag, _ns, _is, props) {
      if (!(HOST_TAGS as readonly string[]).includes(tag)) throw new GlassUIError('renderer', `未知元素 <${tag}>`, { allowed: HOST_TAGS, got: tag })
      return markRaw(new Node(tag as NodeType, props?.id == null ? undefined : String(props.id)))
    },
    createText: textNode,
    createComment() { const n = markRaw(new Node('anchor')); n.replaceStyle(EMPTY); return n },
    setText(n, t) { n.setProp('value', t); n.replaceStyle(t === '' ? EMPTY : {}) },
    setElementText(el, t) {
      if (el.type === 'text') { el.setProp('value', t); return }
      for (const c of [...el.children]) c.remove()
      if (t !== '') el.appendChild(textNode(t))
    },
    // raw nodes only, whatever Vue hands over: a Teleport target held in a deep `ref` arrives as a reactive proxy, and a
    // proxy stored as a parent (or child) breaks the core's identity checks (`PointerTracker`'s `p === this.root`)
    insert(c, p, a) { toRaw(p).insertBefore(toRaw(c), a ? toRaw(a) : null) },
    remove(c) { const n = toRaw(c); if (!isHeld(n)) n.remove() },   // held content stays until its Surface goes
    parentNode: n => toRaw(n).parent,
    nextSibling(n) { const r = toRaw(n), p = r.parent; return p ? p.children[p.children.indexOf(r) + 1] ?? null : null },
    querySelector: teleportTarget,
    patchProp(el, key, _prev, next, _ns, instance) {
      if (/^on[A-Z]/.test(key)) {
        const type = key.slice(2).toLowerCase()
        if (!(UI_EVENT_TYPES as readonly string[]).includes(type)) throw new GlassUIError('renderer', `未知事件 "${key}"`, { allowed: EVENT_PROPS, got: key })
        // an array when Vue merges listeners (a component's own and its fallthrough `@click`); errors go to the app's handler
        const fns = (Array.isArray(next) ? next : [next]).filter((f): f is (...a: unknown[]) => unknown => typeof f === 'function')
        el.setHandler(type as UIEventType, fns.length ? e => { callWithAsyncErrorHandling(fns, instance ?? null, ErrorCodes.NATIVE_EVENT_HANDLER, [e]) } : null)
        return
      }
      if (key === 'style' || key === 'tw' || key === 'class') {
        // Vue normalises `class` (string, array or object) to a string, not `tw`; both resolve against the root's theme
        // as it is when they are set
        const src = key === 'style' ? next : normalizeClass(next)
        const v = src == null || src === '' ? undefined : key === 'style' ? validateStyle(src, 'style') : parseTw(src as string, root.theme, key)
        const r = rawOf(el)
        if (v) r[key] = v; else delete r[key]
        compose(el)
        return
      }
      // the id is the node's own (set at creation from the props); a changed `id` prop renames it
      if (key === 'id' && next != null && String(next) !== el.id) (el as { id: string }).id = String(next)
      if (key === 'disabled') el.setState({ disabled: next === '' || !!next })   // `<glass disabled>` passes ''
      el.setProp(key, next)
    },
  }
  const renderer = createRenderer<Node, Node>(ops)
  const render: RootRenderFunction<Node> = (vnode, container, ns) => {
    const raw = toRaw(container)
    if (vnode) containers.add(raw); else containers.delete(raw)
    renderer.render(vnode, raw, ns)
  }
  const createApp: CreateAppFunction<Node> = (component, props) => {
    const app = renderer.createApp(component, props)
    const { mount, unmount } = app
    let container: Node | null = null
    app.mount = (target, ...rest) => {
      if (!(target instanceof Node)) throw new GlassUIError('app.mount', '挂载目标必须是 Node（createGlassApp 的 mount 还接受 Surface）')
      const raw = toRaw(target)
      containers.add(container = raw)
      const before = new Set(raw.children)
      try { return mount(raw, ...rest) } catch (e) {
        // what a mount that failed half-way inserted (a fragment's first children); the instance mounts afresh on its next update
        for (const c of [...raw.children]) if (!before.has(c)) c.remove()
        const handler = app.config.errorHandler
        if (!handler) throw e
        handler(e, null, 'mount')
        return undefined as never   // nothing mounted: no instance
      }
    }
    app.unmount = () => { unmount(); if (container) containers.delete(container) }
    return app
  }
  return { render, createApp }
}
