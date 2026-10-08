import { Box3, Group, Matrix4, Scene, Vector2, Vector3, VSMShadowMap, type OrthographicCamera, type PerspectiveCamera, type Texture } from 'three'
import { AnimationRuntime, createYogaLayout, defaultTheme, GlassUIError, type ColorScheme, type Theme } from '@glassui/core'
import { SystemFontEngine, type CanvasFactory, type TextEngine } from '@glassui/text'
import { Surface, type SurfaceContext, type SurfaceOptions } from './surface/surface'
import { ScreenLayer } from './surface/screen'
import type { RendererLike } from './surface/content'
import { createMeasureFn } from './text/measure'
import { AtlasPages } from './text/pages'
import { createStudioEnvironment, createUILights, fitShadowCamera, UI_ENV_INTENSITY } from './lighting/lights'
import { PointerBridge, type CanvasLike } from './pointer'
import { defaultTier, QUALITY, QualityController, type QualityProfile, type QualityTier } from './quality'
import { FrameScheduler } from './scheduler'

/** The subset of `WebGPURenderer` the root drives (so tests can pass a stub). */
export interface UIRenderer extends RendererLike {
  domElement: CanvasLike & { width?: number; height?: number; style?: { touchAction: string } }
  /** CSS px. */
  getSize(target: Vector2): Vector2
  getPixelRatio(): number
  shadowMap: { enabled: boolean; type: number; transmitted?: boolean }
  autoClear: boolean
  init?(): Promise<unknown>
  setAnimationLoop?(fn: ((time: number) => void) | null): unknown
  /** `object &`: three's `Backend` type declares no `isWebGPUBackend` (only the WebGPU backend has it), and a type of optional fields alone would reject it. */
  backend?: object & { isWebGPUBackend?: boolean }
  isWebGPURenderer?: boolean
}

export interface UIRootOptions {
  renderer: UIRenderer; scene: Scene; camera: PerspectiveCamera | OrthographicCamera
  theme?: Theme; scheme?: ColorScheme
  /** `'auto'` (default): from the device (touch → medium, reduced transparency → minimal) and adapting to frame time; a tier: fixed. */
  quality?: QualityTier | 'auto'
  /** Default: a `SystemFontEngine` over `createCanvas` (default: DOM canvases). */
  text?: TextEngine; createCanvas?: CanvasFactory
  /** Default `'studio'` (a PMREM, needs `renderer.init`); `null` skips it (tests). */
  environment?: 'studio' | Texture | null
  /** Default `'overlay'`: the UI has its own scene, drawn after the host's with its camera and depth. */
  mode?: 'overlay' | 'shared'
  /** Default true: DOM pointer/wheel (and, with `keyboard`, key) events on the canvas. */
  pointer?: boolean; keyboard?: boolean
  /** Default: the `prefers-reduced-motion` / `prefers-reduced-transparency` media queries, where available. */
  reducedMotion?: boolean; reducedTransparency?: boolean
}

export type CreateSurfaceOptions = SurfaceOptions & { layer?: 'screen' | 'world'; fill?: boolean; left?: number; top?: number }

export interface UIRootEventMap {
  quality: { tier: QualityTier; prev: QualityTier; profile: QualityProfile }
  /** A Surface failed a frame (it stopped drawing). */
  error: { surface: Surface; error: Error }
}

export interface UIRoot {
  readonly screen: ScreenLayer; readonly world: Group; readonly uiScene: Scene
  readonly lights: ReturnType<typeof createUILights>; readonly theme: Theme; readonly scheme: ColorScheme
  readonly text: TextEngine; readonly quality: QualityController; readonly anim: AnimationRuntime
  readonly surfaces: readonly Surface[]; readonly pointer: PointerBridge | null
  readonly backend: 'webgpu' | 'webgl2' | 'unknown'
  /** `layer: 'screen'` (default): pt = CSS px, `fill` or at `left/top`; `'world'`: a child of `world` (`ptPerUnit` default 244). */
  createSurface(opts: CreateSurfaceOptions): Surface
  removeSurface(surface: Surface): void
  /** Layout, animation, content passes, draw order and the shadow fit; `dt` in seconds. */
  tick(dt: number): void
  /**
   * Overlay: the host scene (cleared: `autoClear = true`), then the UI scene over it without clearing (shared depth);
   * `renderer.autoClear` is true again afterwards, whatever it was — a host must not rely on it being false. Shared:
   * the host scene, the UI being in it.
   */
  render(): void
  /** Overlay: the UI scene alone, over what the host drew this frame (`autoClear` false for the call, then true); a no-op when shared. */
  renderUI(): void
  /** `tick` (dt from the scheduler) + `render` (+ the quality sample with `quality: 'auto'`); `nowMs` default `performance.now()`. */
  frame(nowMs?: number): void
  autoTick(on: boolean): void
  on<K extends keyof UIRootEventMap>(type: K, fn: (e: UIRootEventMap[K]) => void): () => void
  dispose(): void
}

/** Screen Surfaces' draw orders start here; world ones take 1 (farthest) up to just below it. */
const SCREEN_ORDER = 1000
const CORNERS = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const

const media = (q: string): boolean => typeof matchMedia === 'function' && matchMedia(q).matches
const domCanvas: CanvasFactory = (width, height) => Object.assign(document.createElement('canvas'), { width, height }) as unknown as ReturnType<CanvasFactory>

/**
 * Spec §3.1: the UI on top of a host three.js app. `'overlay'` (default) keeps the UI in its own `uiScene` — screen
 * layer, world layer, the UI lights and environment — drawn after the host scene with the host's camera (its near/far
 * apply) into the same depth buffer, so world Surfaces and host geometry occlude each other, and the UI's lights and
 * shadows touch only the UI. `'shared'` puts the layers and lights into the host scene (its environment is set only if
 * it has none). Rejects with a readable `GlassUIError` when the renderer cannot initialise.
 *
 * Each `tick`: the screen layer and the lights follow the camera; every Surface ticks; glyphs evicted by a later
 * Surface's are re-laid out; draw orders are assigned (screen Surfaces above world ones, nearer above farther); the
 * content passes draw; the key light's shadow camera is re-fitted to every Surface when the camera, a Surface's pose or
 * its glass changed (the map redraws only then).
 */
export async function createUIRoot(opts: UIRootOptions): Promise<UIRoot> {
  const { renderer, scene, camera } = opts
  try { await renderer.init?.() } catch (e) {
    throw new GlassUIError('createUIRoot', `渲染后端初始化失败（WebGPU 与 WebGL2 都不可用）：${e instanceof Error ? e.message : String(e)}`)
  }
  const backend: UIRoot['backend'] = renderer.backend ? (renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2') : 'unknown'
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = VSMShadowMap; renderer.shadowMap.transmitted = true

  const theme = opts.theme ?? defaultTheme, scheme = opts.scheme ?? 'light'
  const reducedTransparency = opts.reducedTransparency ?? media('(prefers-reduced-transparency: reduce)')
  const touch = typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0
  const tier = opts.quality ?? 'auto', adaptive = tier === 'auto'
  // auto: the cap ignores the pin, so clearing reduced transparency can raise quality again; a fixed tier is its own cap
  const quality = tier === 'auto'
    ? new QualityController({ initial: defaultTier({ touch, reducedTransparency }), cap: defaultTier({ touch, reducedTransparency: false }), reducedTransparency })
    : new QualityController({ initial: tier, reducedTransparency })

  const text = opts.text ?? new SystemFontEngine({ createCanvas: opts.createCanvas ?? domCanvas })
  const anim = new AnimationRuntime(theme, scheme)
  anim.reducedMotion = opts.reducedMotion ?? media('(prefers-reduced-motion: reduce)')
  const pages = new AtlasPages(text.atlas)
  const ctx: SurfaceContext = { theme, scheme, layout: await createYogaLayout(), measure: createMeasureFn(text, theme, scheme), anim, text, pages, quality: quality.profile }

  const mode = opts.mode ?? 'overlay'
  const uiScene = new Scene(); uiScene.name = 'glassui'
  const host = mode === 'overlay' ? uiScene : scene
  const screen = new ScreenLayer()
  const world = new Group(); world.name = 'ui-world'
  const lights = createUILights({ shadowMap: quality.profile.shadowMap })
  host.add(screen, world, lights.group)

  // the studio PMREM needs an initialised WebGPURenderer (its `init` resolved above)
  const envOpt = opts.environment === undefined ? 'studio' : opts.environment
  const ownEnv = envOpt === 'studio' && renderer.init ? createStudioEnvironment(renderer) : null
  const env = envOpt === 'studio' ? ownEnv : envOpt
  const hostEnv = mode === 'shared' && env !== null && !scene.environment ? { intensity: scene.environmentIntensity } : null
  if (env) { uiScene.environment = env; uiScene.environmentIntensity = UI_ENV_INTENSITY }
  if (env && hostEnv) { scene.environment = env; scene.environmentIntensity = UI_ENV_INTENSITY }

  const surfaces: Surface[] = []
  const canvas = renderer.domElement
  const pointer = opts.pointer === false ? null : new PointerBridge({ canvas, camera, surfaces: () => surfaces, keyboard: opts.keyboard !== false })
  const touchAction = canvas.style?.touchAction
  if (pointer) {
    pointer.attach()
    if (canvas.style) canvas.style.touchAction = 'none'   // touch drags go to the UI, not to page scrolling/zoom
  }

  const listeners: { [K in keyof UIRootEventMap]: Set<(e: UIRootEventMap[K]) => void> } = { quality: new Set(), error: new Set() }
  function emit<K extends keyof UIRootEventMap>(type: K, e: UIRootEventMap[K]): void {
    for (const fn of [...listeners[type]]) try { fn(e) } catch (err) { console.error(`[glassui] a "${type}" listener threw:`, err) }
  }

  const offQuality = quality.onChange((tier, prev) => {
    const profile = QUALITY[tier]   // not `quality.profile`: a listener may have moved on already (queued delivery)
    ctx.quality = profile
    for (const s of surfaces) s.setQuality(profile)
    lights.key.shadow.mapSize.set(profile.shadowMap, profile.shadowMap)   // three's shadow node resizes its maps from it
    lights.key.shadow.needsUpdate = true
    emit('quality', { tier, prev, profile })
  })

  const size = new Vector2(), v = new Vector3(), camPos = new Vector3(), union = new Box3()
  const lastCamera = new Matrix4(), lastPose = new WeakMap<Surface, Matrix4>()
  let lastFitted = -1, looping = false, disposed = false
  const scheduler = new FrameScheduler()

  /** CSS px the Surface covers: screen ones their scaled size; world ones the bounds of their projected content quad. */
  function projectedPx(s: Surface): { width: number; height: number } {
    if (s.model.placement === 'screen') return { width: s.model.width * s.scale.x, height: s.model.height * s.scale.y }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const [x, y] of CORNERS) {
      v.set(x, y, 0).applyMatrix4(s.contentMesh.matrixWorld).project(camera)
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y)
    }
    return { width: (maxX - minX) / 2 * size.x, height: (maxY - minY) / 2 * size.y }
  }

  /** Screen Surfaces `SCREEN_ORDER + i` in placement order; world ones 1 (farthest) up, equidistant ones in list order. */
  function assignDrawOrders(): void {
    let i = 0
    for (const s of screen.surfaces) s.drawOrder = SCREEN_ORDER + i++
    camera.getWorldPosition(camPos)
    surfaces.filter(s => s.model.placement === 'world').map((s, i) => ({ s, i, d: s.getWorldPosition(v).distanceToSquared(camPos) }))
      .sort((a, b) => b.d - a.d || a.i - b.i)
      .forEach(({ s }, k) => { s.drawOrder = Math.min(SCREEN_ORDER - 1, k + 1) })
  }

  /**
   * Re-fits the key light's shadow camera to every drawn Surface (screen and world together, so the margin is
   * proportional to their union: screen Surfaces are tiny in world units) when `changed` or a Surface moved, appeared or
   * went away; the fit marks the map for redraw.
   */
  function fitShadows(changed: boolean): void {
    const drawn = surfaces.filter(s => !s.error && s.visible)
    for (const s of drawn) {
      const last = lastPose.get(s)
      if (!last) { lastPose.set(s, s.matrixWorld.clone()); changed = true } else if (!last.equals(s.matrixWorld)) { last.copy(s.matrixWorld); changed = true }
    }
    if (drawn.length !== lastFitted) changed = true
    lastFitted = drawn.length
    if (!changed) return
    const boxes = drawn.map(s => s.glassBounds.applyMatrix4(s.matrixWorld))   // glassBounds is a fresh, Surface-local box
    union.makeEmpty(); for (const b of boxes) union.union(b)
    const extent = union.isEmpty() ? 0 : Math.max(...union.getSize(v).toArray())
    fitShadowCamera(lights.key, boxes, Math.max(1e-3, 0.05 * extent))
  }

  const root: UIRoot = {
    screen, world, uiScene, lights, theme, scheme, text, quality, anim, surfaces, pointer, backend,
    createSurface(o) {
      const { layer = 'screen', fill, left, top, ...rest } = o
      const s = new Surface(layer === 'screen' ? { ...rest, ptPerUnit: 1, placement: 'screen' } : { ...rest, placement: 'world' }, ctx)
      s.addEventListener('error', e => emit('error', { surface: s, error: e.error }))
      if (layer === 'screen') screen.place(s, fill ? { fill: true } : { left: left ?? 0, top: top ?? 0 })
      else world.add(s)
      surfaces.push(s)
      return s
    },
    removeSurface(s) {
      const i = surfaces.indexOf(s)
      if (i < 0) return
      surfaces.splice(i, 1)
      pointer?.forget(s); screen.unplace(s); lastPose.delete(s)
      s.dispose()
    },
    tick(dt) {
      renderer.getSize(size)
      screen.update(camera, { width: size.x, height: size.y })   // also brings camera.matrixWorld up to date
      camera.getWorldPosition(lights.group.position); camera.getWorldQuaternion(lights.group.quaternion)
      lights.group.updateMatrixWorld(true)                         // the key light stays top-left-front of the view
      let changed = !lastCamera.equals(camera.matrixWorld)
      lastCamera.copy(camera.matrixWorld)
      for (const s of surfaces) if (s.model.placement === 'world') s.updateWorldMatrix(true, true)
      const epoch = text.atlas.epoch
      for (const s of surfaces) s.tick(dt)
      // the pages are shared: a later Surface's glyphs may have evicted an earlier one's this tick
      if (text.atlas.epoch !== epoch) for (const s of surfaces) s.refreshText()
      for (const s of surfaces) if (!s.error && (s.contentDirty || s.needsFrame)) changed = true   // rebuilt or animating
      assignDrawOrders()
      const dpr = renderer.getPixelRatio()
      for (const s of surfaces) s.prepare(renderer, projectedPx(s), dpr)
      fitShadows(changed)
    },
    render() {
      if (mode === 'shared') { renderer.render(scene, camera); return }
      renderer.autoClear = true
      renderer.render(scene, camera)
      root.renderUI()
    },
    renderUI() {
      if (mode === 'shared') return
      renderer.autoClear = false   // over the host's colour and depth
      try { renderer.render(uiScene, camera) } finally { renderer.autoClear = true }
    },
    frame(nowMs) {
      root.tick(scheduler.dt(nowMs ?? performance.now()))
      const t0 = performance.now()
      root.render()
      if (adaptive) quality.sample(performance.now() - t0)
    },
    autoTick(on) {
      if (!renderer.setAnimationLoop) throw new GlassUIError('UIRoot.autoTick', '渲染器没有 setAnimationLoop：请在宿主的渲染循环里调用 root.frame()')
      looping = on
      renderer.setAnimationLoop(on ? t => root.frame(t) : null)
    },
    on(type, fn) {
      const set = listeners[type] as Set<typeof fn>
      set.add(fn)
      return () => { set.delete(fn) }
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (looping) renderer.setAnimationLoop?.(null)   // only a loop `autoTick` installed: the host may run its own
      pointer?.detach()
      if (pointer && canvas.style && touchAction !== undefined) canvas.style.touchAction = touchAction
      for (const s of [...surfaces]) root.removeSurface(s)
      offQuality()
      listeners.quality.clear(); listeners.error.clear()
      pages.dispose()
      lights.key.dispose(); lights.hemi.dispose()
      screen.removeFromParent(); world.removeFromParent(); lights.group.removeFromParent()
      if (hostEnv) { scene.environment = null; scene.environmentIntensity = hostEnv.intensity }
      ownEnv?.dispose()
    },
  }
  return root
}
