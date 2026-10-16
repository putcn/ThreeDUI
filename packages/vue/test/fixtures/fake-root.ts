import { vi, type Mock } from 'vitest'
import {
  AnimationRuntime, createSurface as createModel, createYogaLayout, defaultTheme, EventDispatcher, FocusManager, GlassUIError, PointerTracker, resolveTextStyle,
  type ColorScheme, type MeasureFn, type Node, type SurfaceModel, type Theme,
} from '@glassui/core'
import type { Attach3DOptions, BarChart, BarChartData, BarMatrix, BarMatrixData, BarMatrixLabels, CameraRig, GridCell, CreateSurfaceOptions, PoseSpring, Surface, SurfaceCell, SurfaceChart, SurfaceChartData, SurfaceChartLabels, SurfacePose, UIRootEventMap, Viewport3DContext } from '@glassui/render'
import type { GlassRoot } from '../../src/root'
import { createFakeText } from './fake-text'

/** One yoga instance for every fake root (loading it is async; the engine serves several roots). */
const layout = await createYogaLayout()

export interface FakeVec3 { x: number; y: number; z: number; set(x: number, y: number, z: number): FakeVec3; setScalar(v: number): FakeVec3 }
const vec3 = (x: number, y: number, z: number): FakeVec3 => {
  const v: FakeVec3 = { x, y, z, set(a, b, c) { v.x = a; v.y = b; v.z = c; return v }, setScalar: s => v.set(s, s, s) }
  return v
}

type Triple = [number, number, number]
/** One `animateTo` call on a `FakeSurface`: its target and options, and the pose it started from. */
export interface FakeAnimation {
  target: SurfacePose
  opts: { spring?: PoseSpring; immediate?: boolean }
  from: { position: Triple; scale: Triple; opacity: number }
}

/** One `attach3D` call on a `FakeSurface` that has not been detached: what it was given. */
export interface FakeAttachment { node: Node; object: unknown; opts: Attach3DOptions }

/** A Surface event, as a render `Surface` (an Object3D) dispatches it. */
export type FakeSurfaceEvent = { type: 'error'; error: Error } | { type: 'dispose' }
type FakeListener = (e: FakeSurfaceEvent) => void

/** The parts of a render `Surface` the Vue layer touches, over real core pieces (no three). */
export interface FakeSurface {
  readonly model: SurfaceModel; readonly root: Node
  /** The options `createSurface` was called with. */
  readonly created: CreateSurfaceOptions
  readonly events: EventDispatcher; readonly pointer: PointerTracker; readonly focus: FocusManager
  readonly position: FakeVec3; readonly rotation: FakeVec3; readonly scale: FakeVec3
  billboard: boolean; trapFocus: boolean; interactive: boolean
  /** As `Surface.castShadows` (default true): only recorded. */
  castShadows: boolean
  /** The whole Surface's opacity (default 1); `animateTo` sets it at once. */
  opacity: number
  /** The current pose (`animateTo` applies its target at once, so it is also where the animation ends). */
  readonly restPose: { position: Triple; rotation: Triple; scale: Triple; opacity: number }
  /**
   * Records the call in `animations` (with the pose it starts from), applies `target` at once, and resolves at the next
   * root `tick`: true, or false when the Surface has been disposed by then.
   */
  animateTo(target: SurfacePose, opts?: { spring?: PoseSpring; immediate?: boolean }): Promise<boolean>
  /** Every `animateTo` call, in order. */
  readonly animations: FakeAnimation[]
  setSize(width: number, height: number): void
  /**
   * Records `{ node, object, opts }` in `attached` and returns the detach, which removes the record; on a screen
   * Surface it throws the render error instead (`[Surface.attach3D] 只能挂在世界层 Surface 上`).
   */
  attach3D(node: Node, object: unknown, opts?: Attach3DOptions): () => void
  /** The attachments not detached yet, in attach order. */
  readonly attached: FakeAttachment[]
  dispose(): void
  readonly disposed: boolean
  /** Set by `markFailed`: the Surface stopped for good (the root's `tick` skips it), as a render Surface's. */
  readonly error: Error | null
  /**
   * As `Surface.markFailed`: sets `error`, forgets the tree's animation state (its `whenSettled` promises resolve) and
   * dispatches `{ type: 'error', error }`; the first failure stands, a disposed Surface ignores it.
   */
  markFailed(e: unknown): void
  /** Object3D's event API, for `'error'` and `'dispose'` (dispatched once, at the end of `dispose`). */
  addEventListener(type: FakeSurfaceEvent['type'], fn: FakeListener): void
  removeEventListener(type: FakeSurfaceEvent['type'], fn: FakeListener): void
  /** How many listeners of `type` are attached now. */
  listenerCount(type: FakeSurfaceEvent['type']): number
}

/** The fake root's `CameraRig`: `focus` resolves `true` at once, `dispose` sets `disposed`; both are spies. */
export interface FakeRig {
  focus: Mock<(target: Surface, opts?: { immediate?: boolean }) => Promise<boolean>>
  dispose: Mock<() => void>
  parallax: boolean
  disposed: boolean
}

/** The fake root's `BarChart`: every method a spy (`update` returns false: nothing moves), no bars. */
export interface FakeChart {
  set: Mock<(data: BarChartData) => void>
  hover: Mock<(index: number | null) => void>
  update: Mock<(dt: number, ctx: Viewport3DContext) => boolean>
  dispose: Mock<() => void>
  bars: BarChart['bars']
}

/**
 * The fake root's `SurfaceChart`: every method a spy (`update` returns false: nothing moves). `cellAt` reads a point
 * `[col, row, z]` as that cell (rounded), and a negative col or row as off the grid (null); `riseFor(w, h)` is a
 * stand-in, min(w, h) + 40.
 */
export interface FakeSurfaceChart {
  set: Mock<(data: SurfaceChartData) => void>
  labels: Mock<(l: SurfaceChartLabels) => void>
  hover: Mock<(cell: SurfaceCell | null) => void>
  cellAt: Mock<(point: readonly [number, number, number]) => SurfaceCell | null>
  riseFor: Mock<(width: number, height: number) => number>
  update: Mock<(dt: number, ctx: Viewport3DContext) => boolean>
  dispose: Mock<() => void>
}

/**
 * The fake root's `BarMatrix`: every method a spy (`update` returns false: nothing moves), no bars; `riseFor(w, h)` is
 * a stand-in, min(w, h) + 40.
 */
export interface FakeBarMatrix {
  set: Mock<(data: BarMatrixData) => void>
  labels: Mock<(l: BarMatrixLabels) => void>
  hover: Mock<(cell: GridCell | null) => void>
  riseFor: Mock<(width: number, height: number) => number>
  update: Mock<(dt: number, ctx: Viewport3DContext) => boolean>
  dispose: Mock<() => void>
  bars: BarMatrix['bars']
}

export interface FakeRoot extends GlassRoot {
  /** Lays out every live Surface, runs the animation runtime, then resolves the `afterTick` waiters and the pending `animateTo` promises; dt in seconds. */
  tick(dt?: number): void
  /** Emits a root event to the `on` listeners. */
  emit<K extends keyof UIRootEventMap>(type: K, e: UIRootEventMap[K]): void
  /** How many `on` listeners of `type` are subscribed now. */
  listenerCount(type: keyof UIRootEventMap): number
  /** Every Surface `createSurface` made, removed ones included, in creation order. */
  readonly surfacesMade: FakeSurface[]
  /** Every rig `createCameraRig` made, disposed ones included, in creation order. */
  readonly rigs: FakeRig[]
  /** Every chart `createBarChart` made, in creation order. */
  readonly charts: FakeChart[]
  /** Every chart `createSurfaceChart` made, in creation order. */
  readonly surfaceCharts: FakeSurfaceChart[]
  /** Every matrix `createBarMatrix` made, in creation order. */
  readonly barMatrices: FakeBarMatrix[]
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
  const surfaces: FakeSurface[] = [], surfacesMade: FakeSurface[] = [], rigs: FakeRig[] = [], charts: FakeChart[] = [], surfaceCharts: FakeSurfaceChart[] = [], barMatrices: FakeBarMatrix[] = []
  /** The pointer bridge's key target, as `PointerBridge`: `setActive` sets it, removing its Surface clears it. */
  const bridge: { active: FakeSurface | null; setActive(s: FakeSurface | null): void } = { active: null, setActive: vi.fn((s: FakeSurface | null) => { bridge.active = s }) }
  let waiters: (() => void)[] = []
  const listeners = new Map<string, Set<(e: never) => void>>()

  const make = (o: CreateSurfaceOptions): FakeSurface => {
    const { layer = 'screen', fill: _fill, center: _center, left: _left, top: _top, interactive, castToWorld: _cast, castShadows, contentScale: _scale, billboard, ...rest } = o
    const model = createModel(layer === 'screen' ? { ...rest, ptPerUnit: 1, placement: 'screen' } : { ...rest, placement: 'world' })
    const events = new EventDispatcher(), listeners = new Map<string, Set<FakeListener>>()
    const dispatch = (e: FakeSurfaceEvent): void => { for (const fn of [...listeners.get(e.type) ?? []]) fn(e) }
    let disposed = false, error: Error | null = null
    const xyz = (v: FakeVec3): Triple => [v.x, v.y, v.z]
    const s: FakeSurface = {
      model, root: model.root, created: { ...o }, events, pointer: new PointerTracker(model.root, events, theme), focus: new FocusManager(model.root, events),
      position: vec3(0, 0, 0), rotation: vec3(0, 0, 0), scale: vec3(1, 1, 1),
      billboard: billboard ?? false, trapFocus: false, interactive: interactive ?? true, castShadows: castShadows ?? true,
      opacity: 1, animations: [], attached: [],
      get restPose() { return { position: xyz(s.position), rotation: xyz(s.rotation), scale: xyz(s.scale), opacity: s.opacity } },
      animateTo(target, opts = {}) {
        s.animations.push({ target, opts, from: { position: xyz(s.position), scale: xyz(s.scale), opacity: s.opacity } })
        const { position, rotation, scale, opacity } = target
        if (position) s.position.set(...position)
        if (rotation) s.rotation.set(...rotation)
        if (scale !== undefined) { if (typeof scale === 'number') s.scale.setScalar(scale); else s.scale.set(...scale) }
        if (opacity !== undefined) s.opacity = opacity
        return new Promise<boolean>(resolve => { waiters.push(() => { resolve(!disposed) }) })
      },
      setSize(w, h) { if (disposed) return; model.width = w; model.height = h; model.root.setStyle({ width: w, height: h }) },
      attach3D(node, object, opts = {}) {
        if (model.placement === 'screen') throw new GlassUIError('Surface.attach3D', '只能挂在世界层 Surface 上')
        const record: FakeAttachment = { node, object, opts }
        s.attached.push(record)
        return () => { const i = s.attached.indexOf(record); if (i >= 0) s.attached.splice(i, 1) }
      },
      dispose() {
        if (disposed) return
        disposed = true
        anim.forget(model.root); layout.dispose(model.root)
        const i = surfaces.indexOf(s); if (i >= 0) surfaces.splice(i, 1)
        dispatch({ type: 'dispose' })
      },
      get disposed() { return disposed },
      get error() { return error },
      markFailed(e) {
        if (error || disposed) return
        error = e instanceof Error ? e : new Error(String(e))
        anim.forget(model.root)
        dispatch({ type: 'error', error })
      },
      addEventListener(type, fn) { let set = listeners.get(type); if (!set) listeners.set(type, set = new Set()); set.add(fn) },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn) },
      listenerCount: type => listeners.get(type)?.size ?? 0,
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
    pointer: bridge as unknown as GlassRoot['pointer'],
    ime: null,
    surfacesMade, rigs, charts, surfaceCharts, barMatrices,
    createSurface: o => make(o) as unknown as Surface,
    createCameraRig() {
      const rig: FakeRig = { focus: vi.fn(async () => true), dispose: vi.fn(() => { rig.disposed = true }), parallax: true, disposed: false }
      rigs.push(rig)
      return rig as unknown as CameraRig
    },
    createBarChart() {
      const chart: FakeChart = { set: vi.fn(), hover: vi.fn(), update: vi.fn(() => false), dispose: vi.fn(), bars: [] }
      charts.push(chart)
      return chart as unknown as BarChart
    },
    createSurfaceChart() {
      const cellAt = vi.fn(([col, row]: readonly [number, number, number]): SurfaceCell | null => (col < 0 || row < 0 ? null : { row: Math.round(row), col: Math.round(col) }))
      const riseFor = vi.fn((w: number, h: number) => Math.min(w, h) + 40)
      const chart: FakeSurfaceChart = { set: vi.fn(), labels: vi.fn(), hover: vi.fn(), cellAt, riseFor, update: vi.fn(() => false), dispose: vi.fn() }
      surfaceCharts.push(chart)
      return chart as unknown as SurfaceChart
    },
    createBarMatrix() {
      const matrix: FakeBarMatrix = { set: vi.fn(), labels: vi.fn(), hover: vi.fn(), riseFor: vi.fn((w: number, h: number) => Math.min(w, h) + 40), update: vi.fn(() => false), dispose: vi.fn(), bars: [] }
      barMatrices.push(matrix)
      return matrix as unknown as BarMatrix
    },
    removeSurface(s) {
      const f = s as unknown as FakeSurface
      if (!surfaces.includes(f)) return
      if (bridge.active === f) bridge.active = null   // as PointerBridge.forget
      f.dispose()
    },
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
    listenerCount: type => listeners.get(type)?.size ?? 0,
    screenFromPoint: (s, x, y) => ({ x: x + s.position.x, y: y + s.position.y }),
  }
}

/** Lets the promise chains hanging off a tick (`afterTick`, `whenSettled`) run: two microtask turns. */
export const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve() }
