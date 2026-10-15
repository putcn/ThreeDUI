import { vi } from 'vitest'
import {
  AnimationRuntime, createSurface as createModel, createYogaLayout, defaultTheme, EventDispatcher, FocusManager, PointerTracker, resolveTextStyle,
  type ColorScheme, type MeasureFn, type Node, type SurfaceModel, type Theme,
} from '@glassui/core'
import type { CreateSurfaceOptions, Surface, UIRootEventMap } from '@glassui/render'
import type { GlassRoot } from '../../src/root'
import { createFakeText } from './fake-text'

/** One yoga instance for every fake root (loading it is async; the engine serves several roots). */
const layout = await createYogaLayout()

export interface FakeVec3 { x: number; y: number; z: number; set(x: number, y: number, z: number): FakeVec3; setScalar(v: number): FakeVec3 }
const vec3 = (x: number, y: number, z: number): FakeVec3 => {
  const v: FakeVec3 = { x, y, z, set(a, b, c) { v.x = a; v.y = b; v.z = c; return v }, setScalar: s => v.set(s, s, s) }
  return v
}

/** The parts of a render `Surface` the Vue layer touches, over real core pieces (no three). */
export interface FakeSurface {
  readonly model: SurfaceModel; readonly root: Node
  readonly events: EventDispatcher; readonly pointer: PointerTracker; readonly focus: FocusManager
  readonly position: FakeVec3; readonly rotation: FakeVec3; readonly scale: FakeVec3
  billboard: boolean; trapFocus: boolean; interactive: boolean
  setSize(width: number, height: number): void
  dispose(): void
  readonly disposed: boolean
  /** Set by `markFailed`: the Surface stopped for good (the root's `tick` skips it), as a render Surface's. */
  readonly error: Error | null
  /** As `Surface.markFailed`: sets `error` and forgets the tree's animation state (its `whenSettled` promises resolve); the first failure stands. */
  markFailed(e: unknown): void
}

export interface FakeRoot extends GlassRoot {
  /** Lays out every live Surface, runs the animation runtime, then resolves the `afterTick` waiters; dt in seconds. */
  tick(dt?: number): void
  /** Emits a root event to the `on` listeners. */
  emit<K extends keyof UIRootEventMap>(type: K, e: UIRootEventMap[K]): void
  /** Every Surface `createSurface` made, removed ones included, in creation order. */
  readonly surfacesMade: FakeSurface[]
}

/**
 * A `GlassRoot` for tests: the default theme in `light`, a real `AnimationRuntime` and yoga layout, the monospace fake
 * text engine; its Surfaces are `FakeSurface`s (typed as `Surface` through the `GlassRoot` API).
 */
export function createFakeRoot(opts: { theme?: Theme; scheme?: ColorScheme } = {}): FakeRoot {
  const theme = opts.theme ?? defaultTheme, scheme = opts.scheme ?? 'light'
  const text = createFakeText(), anim = new AnimationRuntime(theme, scheme)
  const measure: MeasureFn = (n, maxWidth) => {
    const t = resolveTextStyle(n, theme, scheme)
    return text.measure({ text: String(n.props.value ?? ''), font: { family: t.family, size: t.size, weight: t.weight }, lineHeight: t.lineHeight, letterSpacing: t.letterSpacing, maxLines: t.maxLines, wrap: t.wrap }, { maxWidth })
  }
  const surfaces: FakeSurface[] = [], surfacesMade: FakeSurface[] = []
  let waiters: (() => void)[] = []
  const listeners = new Map<string, Set<(e: never) => void>>()

  const make = (o: CreateSurfaceOptions): FakeSurface => {
    const { layer = 'screen', fill: _fill, center: _center, left: _left, top: _top, interactive, castToWorld: _cast, contentScale: _scale, billboard, ...rest } = o
    const model = createModel(layer === 'screen' ? { ...rest, ptPerUnit: 1, placement: 'screen' } : { ...rest, placement: 'world' })
    const events = new EventDispatcher()
    let disposed = false, error: Error | null = null
    const s: FakeSurface = {
      model, root: model.root, events, pointer: new PointerTracker(model.root, events, theme), focus: new FocusManager(model.root, events),
      position: vec3(0, 0, 0), rotation: vec3(0, 0, 0), scale: vec3(1, 1, 1),
      billboard: billboard ?? false, trapFocus: false, interactive: interactive ?? true,
      setSize(w, h) { if (disposed) return; model.width = w; model.height = h; model.root.setStyle({ width: w, height: h }) },
      dispose() {
        if (disposed) return
        disposed = true
        anim.forget(model.root); layout.dispose(model.root)
        const i = surfaces.indexOf(s); if (i >= 0) surfaces.splice(i, 1)
      },
      get disposed() { return disposed },
      get error() { return error },
      markFailed(e) {
        if (error || disposed) return
        error = e instanceof Error ? e : new Error(String(e))
        anim.forget(model.root)
      },
    }
    surfaces.push(s); surfacesMade.push(s)
    return s
  }

  return {
    get theme() { return theme },
    get scheme() { return scheme },
    contrast: false,
    anim, text,
    surfaces: surfaces as unknown as readonly Surface[],
    pointer: { setActive: vi.fn(), active: null } as unknown as GlassRoot['pointer'],
    surfacesMade,
    createSurface: o => make(o) as unknown as Surface,
    removeSurface(s) { const f = s as unknown as FakeSurface; if (surfaces.includes(f)) f.dispose() },
    tick(dt = 1 / 60) {
      for (const s of [...surfaces]) {
        if (s.error) continue                             // a failed Surface never ticks again
        const root = s.root
        if (root.dirty.layout || root.dirty.tree) layout.compute(root, s.model.width, s.model.height, measure)
        anim.tick(root, dt, s.model.cornerRadius)
      }
      const w = waiters; waiters = []
      for (const resolve of w) resolve()
    },
    afterTick: () => new Promise<void>(resolve => { waiters.push(resolve) }),
    on(type, fn) {
      let set = listeners.get(type)
      if (!set) listeners.set(type, set = new Set())
      set.add(fn as (e: never) => void)
      return () => { set.delete(fn as (e: never) => void) }
    },
    emit(type, e) { for (const fn of [...listeners.get(type) ?? []]) (fn as (e: UIRootEventMap[typeof type]) => void)(e) },
    screenFromPoint: (s, x, y) => ({ x: x + s.position.x, y: y + s.position.y }),
  }
}

/** Lets the promise chains hanging off a tick (`afterTick`, `whenSettled`) run: two microtask turns. */
export const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }
