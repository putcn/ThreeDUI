import type { App, Component, ComponentPublicInstance } from '@vue/runtime-core'
import { Node } from '@glassui/core'
import type { CanvasLike } from '@glassui/text'
import type { Surface } from '@glassui/render'
import { createGlassRenderer } from './renderer'
import { GLASS_OPTIONS, GLASS_ROOT, GLASS_SURFACE } from './keys'
import type { GlassRoot } from './root'

export interface GlassAppOptions {
  root: GlassRoot
  /** An app whose provides (Pinia, i18n…), components, directives, mixins and global properties this one shares. */
  parent?: App
  /** `'frozen'`: transitions complete at once (tests, screenshots). Default `'live'`. */
  motion?: 'live' | 'frozen'
  /** Draw a marker with the message into the container when a render error reaches the app's error handler. Default true. */
  errorMarker?: boolean
  /** Makes the canvases components draw into (icons); default a DOM `<canvas>`. */
  createCanvas?: (w: number, h: number) => CanvasLike
}
/** `mount()`: a detached container (an app of `<Surface>`s only); `mount(surface)`: its root, the Surface provided; `mount(node)`: that node. */
export interface GlassApp extends Omit<App<Node>, 'mount'> { mount(target?: Surface | Node): ComponentPublicInstance }

const domCanvas = (w: number, h: number): CanvasLike => Object.assign(document.createElement('canvas'), { width: w, height: h }) as unknown as CanvasLike
const isSurface = (t: unknown): t is Surface => typeof t === 'object' && t !== null && 'model' in t && 'root' in t && (t as Surface).root instanceof Node

/**
 * A Vue app rendering into core nodes of `opts.root`'s Surfaces. It provides `GLASS_ROOT`, `GLASS_OPTIONS` and, at
 * mount, `GLASS_SURFACE`. Its error handler logs to the console and, unless `errorMarker: false`, shows the message in
 * the container (spec §9); setting `app.config.errorHandler` replaces it.
 */
export function createGlassApp(component: Component, opts: GlassAppOptions, rootProps?: Record<string, unknown>): GlassApp {
  const app = createGlassRenderer({ root: opts.root }).createApp(component, rootProps)
  app.provide(GLASS_ROOT, opts.root)
  app.provide(GLASS_OPTIONS, { motion: opts.motion ?? 'live', createCanvas: opts.createCanvas ?? domCanvas })
  if (opts.parent) {
    const from = opts.parent._context, to = app._context
    Object.setPrototypeOf(to.provides, from.provides)      // the parent's provides are visible; this app's own win
    Object.assign(to.components, from.components); Object.assign(to.directives, from.directives)
    Object.assign(to.config.globalProperties, from.config.globalProperties)
    to.mixins.push(...from.mixins)
  }
  let container: Node | null = null
  app.config.errorHandler = err => {
    console.error('[glassui]', err)
    if (opts.errorMarker !== false && container) showErrorMarker(container, err)
  }
  const mount = app.mount
  const glassApp = app as unknown as GlassApp
  glassApp.mount = target => {
    const surface = isSurface(target) ? target : null
    container = surface ? surface.root : target instanceof Node ? target : new Node('box', 'glass-app')
    app.provide(GLASS_SURFACE, surface)
    return mount(container)
  }
  return glassApp
}

/** The `glassui-error` text node in `container` (made on first use), showing `err`'s message. */
function showErrorMarker(container: Node, err: unknown): void {
  let n = container.children.find(c => c.id === 'glassui-error')
  if (!n) { n = new Node('text', 'glassui-error'); container.appendChild(n) }
  n.replaceStyle({ position: 'absolute', left: 8, top: 8, maxWidth: 600, padding: 8, bg: 'danger', color: '#ffffff', fontSize: 14, radius: 8 })
  n.setProp('value', `⚠ ${err instanceof Error ? err.message : String(err)}`)
}
