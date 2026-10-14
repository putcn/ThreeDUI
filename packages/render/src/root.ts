import { Box3, Group, Matrix4, Quaternion, Scene, Vector2, Vector3, VSMShadowMap, type OrthographicCamera, type PerspectiveCamera, type Texture } from 'three'
import { AnimationRuntime, createYogaLayout, defaultTheme, GlassUIError, type ColorScheme, type Theme } from '@glassui/core'
import { SystemFontEngine, type CanvasFactory, type TextEngine } from '@glassui/text'
import { Surface, type SurfaceContext, type SurfaceOptions } from './surface/surface'
import { ScreenLayer } from './surface/screen'
import type { RendererLike } from './surface/content'
import { createMeasureFn } from './text/measure'
import { AtlasPages } from './text/pages'
import { createStudioEnvironment, createUILights, fitShadowCamera, UI_ENV_INTENSITY } from './lighting/lights'
import { PointerBridge, type CanvasLike } from './pointer'
import { checkQualityTier, defaultTier, QUALITY, QualityController, type QualityProfile, type QualityTier } from './quality'
import { FrameSampler, FrameScheduler } from './scheduler'
import { projectPolygon } from './project'

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
  /**
   * `'auto'` (default): from the device (touch → medium, reduced transparency → minimal) and adapting to frame time; a
   * tier: fixed. Anything else rejects with a `GlassUIError` naming the allowed values.
   */
  quality?: QualityTier | 'auto'
  /** Default: a `SystemFontEngine` over `createCanvas` (default: DOM canvases). */
  text?: TextEngine; createCanvas?: CanvasFactory
  /** Default `'studio'` (a PMREM, needs `renderer.init`); `null` skips it (tests). */
  environment?: 'studio' | Texture | null
  /** Default `'overlay'`: the UI has its own scene, drawn after the host's with its camera and depth. */
  mode?: 'overlay' | 'shared'
  /** Default true: DOM pointer/wheel (and, with `keyboard`, key) events on the canvas. */
  pointer?: boolean; keyboard?: boolean
  /**
   * Default: the `prefers-reduced-motion` / `prefers-reduced-transparency` / `prefers-contrast: more` media queries,
   * where available, followed live (their `change` events, until `dispose`): reduced transparency pins `minimal`
   * (`quality.setReducedTransparency`), reduced motion sets `anim.reducedMotion`, increased contrast (spec §8.3:
   * black/white solid + border) pins `minimal` too and switches its fills to `fillColors(theme, scheme, { contrast: true })`
   * (white or black, a `label` border). The pin holds while either reduced transparency or increased contrast is on.
   * An explicit value is fixed: its query is not read or followed.
   */
  reducedMotion?: boolean; reducedTransparency?: boolean; increasedContrast?: boolean
}

/**
 * A Surface and where it goes. Screen layer: `fill` (sized to the viewport) wins over `center` (its scaled rect
 * centred), which wins over `left/top` (its scaled top-left, CSS px; default 0, 0).
 */
export type CreateSurfaceOptions = SurfaceOptions & { layer?: 'screen' | 'world'; fill?: boolean; center?: boolean; left?: number; top?: number }

export interface UIRootEventMap {
  quality: { tier: QualityTier; prev: QualityTier; profile: Readonly<QualityProfile> }
  /** A Surface failed a frame (it stopped drawing). */
  error: { surface: Surface; error: Error }
  /**
   * `setTheme` / `setScheme` swapped the theme or scheme, or increased contrast turned on or off (the media query, live);
   * every Surface has been rebuilt for it.
   */
  theme: { theme: Theme; scheme: ColorScheme; contrast: boolean }
}

export interface UIRoot {
  readonly screen: ScreenLayer; readonly world: Group; readonly uiScene: Scene
  readonly lights: ReturnType<typeof createUILights>
  /** The current theme and scheme (`setTheme`, `setScheme`). */
  readonly theme: Theme; readonly scheme: ColorScheme
  /** Increased contrast is on (`UIRootOptions.increasedContrast`, or the media query's current value). */
  readonly contrast: boolean
  readonly text: TextEngine; readonly quality: QualityController; readonly anim: AnimationRuntime
  readonly surfaces: readonly Surface[]; readonly pointer: PointerBridge | null
  readonly backend: 'webgpu' | 'webgl2' | 'unknown'
  /**
   * `layer: 'screen'` (default): pt = CSS px, `fill`, `center` or at `left/top` (`CreateSurfaceOptions`); `'world'`: a
   * child of `world` (`ptPerUnit` default 244; `billboard` faces the camera).
   */
  createSurface(opts: CreateSurfaceOptions): Surface
  removeSurface(surface: Surface): void
  /**
   * Swaps the theme: the shared context's theme and text measure, the animation runtime's theme, then every Surface
   * restyled (`Surface.restyle`: fills, an opaque background, the glass, every node marked); emits `'theme'`. A theme
   * without `colors.light` / `colors.dark` tables throws a `GlassUIError` and changes nothing.
   */
  setTheme(theme: Theme): void
  /**
   * Swaps the colour scheme (dark mode) as `setTheme` swaps the theme; a no-op for the current scheme. Anything but
   * `'light'` / `'dark'` throws a `GlassUIError` and changes nothing.
   */
  setScheme(scheme: ColorScheme): void
  /**
   * Layout, animation, content passes, draw order and the shadow fit; `dt` in seconds. Billboard world Surfaces turn to
   * face the camera before their matrices are read. Ends by resolving the `afterTick` promises.
   */
  tick(dt: number): void
  /**
   * Resolves at the end of the next `tick` (after the content passes and the shadow fit): layout and the render list
   * are current then (e.g. to place an IME proxy at a caret). `dispose` resolves any still pending; after it, at once.
   */
  afterTick(): Promise<void>
  /**
   * Surface pt (x, y) on its content plane (`Surface.worldFromPoint`), projected through the camera to CSS px from the
   * canvas's top-left; null when the point is behind the camera (view-space z ≥ 0). A point past the far plane (or
   * nearer than the near one) still projects. Reads the matrices as the last `tick` left them.
   */
  screenFromPoint(surface: Surface, x: number, y: number): { x: number; y: number } | null
  /**
   * Overlay: the host scene (cleared: `autoClear` true for that draw), then the UI scene over it without clearing
   * (shared depth); `renderer.autoClear` is put back to the host's value afterwards, also when a draw throws. Shared:
   * the host scene, the UI being in it, with the host's own `autoClear`.
   */
  render(): void
  /**
   * Overlay: the UI scene alone, over what the host drew this frame (`autoClear` false for the call, then the host's
   * value again); a no-op when shared.
   */
  renderUI(): void
  /**
   * `tick` (dt from the scheduler, clamped) + `render`. `nowMs` (default `performance.now()`): the same clock on every
   * call, e.g. the animation loop's. With `quality: 'auto'` each frame also feeds the quality controller, relative to
   * the display's refresh (`FrameSampler`: a dropped refresh counts its interval, a frame that met it its CPU time), so
   * `'auto'` assumes a continuous loop — `autoTick(true)` or a host rAF loop calling `frame` every refresh. An explicit
   * tier never samples.
   */
  frame(nowMs?: number): void
  /** `true`: `renderer.setAnimationLoop(t => root.frame(t))`; `false`: clears the loop if (and only if) this installed it. */
  autoTick(on: boolean): void
  on<K extends keyof UIRootEventMap>(type: K, fn: (e: UIRootEventMap[K]) => void): () => void
  dispose(): void
}

/** Screen Surfaces' draw orders start here; world ones take 1 (farthest) up to just below it. */
const SCREEN_ORDER = 1000
/** The content quad's corners (a unit `PlaneGeometry`, scaled to the Surface), in polygon order. */
const CORNERS = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)', REDUCED_TRANSPARENCY = '(prefers-reduced-transparency: reduce)', INCREASED_CONTRAST = '(prefers-contrast: more)'
/** The media query's list where the environment has `matchMedia` (not under Node). */
const media = (q: string): MediaQueryList | null => typeof matchMedia === 'function' ? matchMedia(q) : null
const SCHEMES: readonly ColorScheme[] = ['light', 'dark']
/** Throws a readable `GlassUIError` (scope `scope`) unless `s` is a colour scheme. */
function checkScheme(scope: string, s: unknown): void {
  if (!(SCHEMES as readonly unknown[]).includes(s)) throw new GlassUIError(scope, `未知的配色方案 "${String(s)}"`, { allowed: SCHEMES, got: String(s) })
}
/** Throws a readable `GlassUIError` (scope `scope`) unless `t` has `colors.light` and `colors.dark` tables (every token's home). */
function checkTheme(scope: string, t: unknown): void {
  const colors = (t as { colors?: unknown } | null | undefined)?.colors as { light?: unknown; dark?: unknown } | null | undefined
  const table = (v: unknown): boolean => typeof v === 'object' && v !== null
  if (!table(colors) || !table(colors!.light) || !table(colors!.dark)) throw new GlassUIError(scope, '主题缺少颜色表：需要 colors.light 与 colors.dark 两个对象（例如 { ...defaultTheme, colors: { light: {…}, dark: {…} } }）')
}
const domCanvas: CanvasFactory = (width, height) => Object.assign(document.createElement('canvas'), { width, height }) as unknown as ReturnType<CanvasFactory>

/**
 * Spec §3.1: the UI on top of a host three.js app. `'overlay'` (default) keeps the UI in its own `uiScene` — screen
 * layer, world layer, the UI lights and environment — drawn after the host scene with the host's camera (its near/far
 * apply) into the same depth buffer, so world Surfaces and host geometry occlude each other; the UI's lights, in that
 * scene, light and shadow only the UI. `'shared'` puts the layers and lights into the host scene (its environment is set
 * only if it has none). Rejects with a readable `GlassUIError` when the renderer cannot initialise, or on an unknown
 * `quality`.
 *
 * The renderer is shared, though: in either mode the root switches its shadow map to VSM with transmitted shadows
 * (`shadowMap.enabled = true`, `type = VSMShadowMap`, `transmitted = true`). three keeps these per renderer, not per
 * scene, so the host's own shadows are affected too (they become VSM, transmitted). Saving and restoring the host's
 * settings is planned; `dispose` leaves them as the root set them.
 *
 * Each `tick`: the screen layer and the lights follow the camera; billboard world Surfaces turn to face it; every
 * Surface ticks; glyphs evicted by a later Surface's are re-laid out; draw orders are assigned (screen Surfaces above
 * world ones, nearer above farther); the content passes draw; the key light's shadow camera is re-fitted to every
 * Surface when the camera, a Surface's pose or its glass changed (the map redraws only then); `afterTick` waiters resolve.
 */
export async function createUIRoot(opts: UIRootOptions): Promise<UIRoot> {
  const { renderer, scene, camera } = opts
  // before touching the renderer
  if (opts.quality !== undefined) checkQualityTier('createUIRoot.quality', opts.quality, true)
  if (opts.scheme !== undefined) checkScheme('createUIRoot.scheme', opts.scheme)
  if (opts.theme !== undefined) checkTheme('createUIRoot.theme', opts.theme)
  try { await renderer.init?.() } catch (e) {
    throw new GlassUIError('createUIRoot', `渲染后端初始化失败（WebGPU 与 WebGL2 都不可用）：${e instanceof Error ? e.message : String(e)}`)
  }
  const backend: UIRoot['backend'] = renderer.backend ? (renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2') : 'unknown'
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = VSMShadowMap; renderer.shadowMap.transmitted = true

  let theme = opts.theme ?? defaultTheme, scheme = opts.scheme ?? 'light'
  // an explicit option is fixed; without one the media query decides, and keeps deciding (subscribed below)
  const transparencyQuery = opts.reducedTransparency === undefined ? media(REDUCED_TRANSPARENCY) : null
  const motionQuery = opts.reducedMotion === undefined ? media(REDUCED_MOTION) : null
  const contrastQuery = opts.increasedContrast === undefined ? media(INCREASED_CONTRAST) : null
  // the live values: reduced transparency and increased contrast both pin minimal (spec §8.3)
  let transparency = opts.reducedTransparency ?? transparencyQuery?.matches ?? false
  let contrast = opts.increasedContrast ?? contrastQuery?.matches ?? false
  const pinned = transparency || contrast
  const touch = typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0
  const tier = opts.quality ?? 'auto', adaptive = tier === 'auto'
  // auto: the cap ignores the pin, so clearing the pin can raise quality again; a fixed tier is its own cap
  const quality = tier === 'auto'
    ? new QualityController({ initial: defaultTier({ touch, reducedTransparency: pinned }), cap: defaultTier({ touch, reducedTransparency: false }), reducedTransparency: pinned })
    : new QualityController({ initial: tier, reducedTransparency: pinned })

  const text = opts.text ?? new SystemFontEngine({ createCanvas: opts.createCanvas ?? domCanvas })
  const anim = new AnimationRuntime(theme, scheme)
  anim.reducedMotion = opts.reducedMotion ?? motionQuery?.matches ?? false
  const pages = new AtlasPages(text.atlas)
  const ctx: SurfaceContext = { theme, scheme, layout: await createYogaLayout(), measure: createMeasureFn(text, theme, scheme), anim, text, pages, quality: quality.profile, contrast }

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

  /**
   * Calls `fn` on a snapshot of the Surfaces, skipping any removed meanwhile: a Surface that fails emits `'error'`
   * synchronously, and a listener may remove it (or another) while the loop runs.
   */
  function each(fn: (s: Surface) => void): void { for (const s of [...surfaces]) if (surfaces.includes(s)) fn(s) }

  const listeners: { [K in keyof UIRootEventMap]: Set<(e: UIRootEventMap[K]) => void> } = { quality: new Set(), error: new Set(), theme: new Set() }
  function emit<K extends keyof UIRootEventMap>(type: K, e: UIRootEventMap[K]): void {
    for (const fn of [...listeners[type]]) try { fn(e) } catch (err) { console.error(`[glassui] a "${type}" listener threw:`, err) }
  }

  const offQuality = quality.onChange((tier, prev) => {
    const profile = QUALITY[tier]   // not `quality.profile`: a listener may have moved on already (queued delivery)
    ctx.quality = profile
    each(s => s.setQuality(profile))
    lights.key.shadow.mapSize.set(profile.shadowMap, profile.shadowMap)   // three's shadow node resizes its maps from it
    lights.key.shadow.needsUpdate = true
    emit('quality', { tier, prev, profile })
  })

  // the media queries, live: a user toggling the OS setting pins/unpins minimal or stops/starts the springs
  const stopMedia: (() => void)[] = []
  function follow(list: MediaQueryList | null, apply: (matches: boolean) => void): void {
    if (!list?.addEventListener) return
    const onChange = (e: { matches: boolean }): void => apply(e.matches)
    list.addEventListener('change', onChange)
    stopMedia.push(() => list.removeEventListener('change', onChange))
  }
  const pin = (): void => quality.setReducedTransparency(transparency || contrast)
  follow(transparencyQuery, on => { transparency = on; pin() })
  follow(motionQuery, on => { anim.reducedMotion = on })
  // one glass rebuild per Surface: a tier change (the pin) rebuilds them all with the new fills (`setQuality`); else restyle
  follow(contrastQuery, on => {
    contrast = on; ctx.contrast = on
    const tier = quality.tier
    pin()
    if (quality.tier === tier) each(s => s.restyle())
    emit('theme', { theme, scheme, contrast })
  })

  /** The shared context and the animation runtime take the current theme and scheme; every Surface restyles; `'theme'`. */
  function restyleAll(): void {
    ctx.theme = theme; ctx.scheme = scheme; ctx.measure = createMeasureFn(text, theme, scheme)
    anim.setTheme(theme, scheme)
    each(s => s.restyle())
    emit('theme', { theme, scheme, contrast })
  }

  /** Resolved (and dropped) at the end of every `tick`, and by `dispose`. */
  const afterTickWaiters: (() => void)[] = []
  function settleAfterTick(): void { for (const resolve of afterTickWaiters.splice(0)) resolve() }

  const size = new Vector2(), v = new Vector3(), camPos = new Vector3(), union = new Box3(), point = new Vector3(), view = new Vector3()
  const qCam = new Quaternion(), qParent = new Quaternion()
  const lastCamera = new Matrix4(), lastPose = new WeakMap<Surface, Matrix4>()
  let lastFitted = -1, looping = false, disposed = false
  const scheduler = new FrameScheduler(), frames = new FrameSampler()

  /**
   * CSS px the Surface covers: screen ones their scaled size; world ones the bounds of their projected content quad
   * (`projectPolygon`): all of it when it is in front of the camera (so a Surface larger than the screen keeps one texel
   * per CSS px), at most the viewport when it straddles the camera plane, nothing (a 1 × 1 RT) when it is behind.
   */
  function projectedPx(s: Surface): { width: number; height: number } {
    if (s.model.placement === 'screen') return { width: s.model.width * s.scale.x, height: s.model.height * s.scale.y }
    const b = projectPolygon(CORNERS, s.contentMesh.matrixWorld, camera)
    return b ? { width: (b.maxX - b.minX) / 2 * size.x, height: (b.maxY - b.minY) / 2 * size.y } : { width: 0, height: 0 }
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
    screen, world, uiScene, lights, text, quality, anim, surfaces, pointer, backend,
    get theme() { return theme },
    get scheme() { return scheme },
    get contrast() { return contrast },
    createSurface(o) {
      const { layer = 'screen', fill, center, left, top, ...rest } = o
      const s = new Surface(layer === 'screen' ? { ...rest, ptPerUnit: 1, placement: 'screen' } : { ...rest, placement: 'world' }, ctx)
      s.addEventListener('error', e => emit('error', { surface: s, error: e.error }))
      if (layer === 'screen') screen.place(s, fill ? { fill: true } : center ? { center: true } : { left: left ?? 0, top: top ?? 0 })
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
      camera.getWorldQuaternion(qCam)
      for (const s of surfaces) {
        if (s.model.placement !== 'world') continue
        // a billboard's world rotation is the camera's: its local one undoes its parent's
        if (s.billboard) s.quaternion.copy(s.parent ? s.parent.getWorldQuaternion(qParent).invert() : qParent.identity()).multiply(qCam)
        s.updateWorldMatrix(true, true)
      }
      const epoch = text.atlas.epoch
      each(s => s.tick(dt))
      // the pages are shared: a later Surface's glyphs may have evicted an earlier one's this tick
      if (text.atlas.epoch !== epoch) each(s => s.refreshText())
      for (const s of surfaces) if (!s.error && (s.contentDirty || s.needsFrame)) changed = true   // rebuilt or animating
      assignDrawOrders()
      const dpr = renderer.getPixelRatio()
      each(s => s.prepare(renderer, projectedPx(s), dpr, camera))   // a glass Surface's luma projects its glass with it
      fitShadows(changed)
      settleAfterTick()
    },
    setTheme(t) { checkTheme('UIRoot.setTheme', t); theme = t; restyleAll() },
    setScheme(sc) { checkScheme('UIRoot.setScheme', sc); if (sc !== scheme) { scheme = sc; restyleAll() } },
    afterTick() {
      if (disposed) return Promise.resolve()   // no tick will come
      return new Promise<void>(resolve => { afterTickWaiters.push(resolve) })
    },
    screenFromPoint(s, x, y) {
      s.worldFromPoint(x, y, point)
      // behind the camera: view-space z ≥ 0 (the camera looks down −z), whatever the backend's depth convention; a
      // point past the far plane still projects (a caret there still has a place on screen)
      if (!(view.copy(point).applyMatrix4(camera.matrixWorldInverse).z < 0)) return null
      const p = point.project(camera)
      const r = canvas.getBoundingClientRect()
      return { x: (p.x + 1) / 2 * r.width, y: (1 - p.y) / 2 * r.height }
    },
    render() {
      if (mode === 'shared') { renderer.render(scene, camera); return }
      const hostAutoClear = renderer.autoClear
      renderer.autoClear = true
      try {
        renderer.render(scene, camera)
        root.renderUI()
      } finally { renderer.autoClear = hostAutoClear }
    },
    renderUI() {
      if (mode === 'shared') return
      const hostAutoClear = renderer.autoClear
      renderer.autoClear = false   // over the host's colour and depth
      try { renderer.render(uiScene, camera) } finally { renderer.autoClear = hostAutoClear }
    },
    frame(nowMs) {
      const now = nowMs ?? performance.now()
      const t0 = performance.now()
      root.tick(scheduler.dt(now))
      root.render()
      if (!adaptive) return
      const sample = frames.sample(now, performance.now() - t0)   // refresh-relative: see FrameSampler
      if (sample !== null) quality.sample(sample)
    },
    autoTick(on) {
      if (!renderer.setAnimationLoop) throw new GlassUIError('UIRoot.autoTick', '渲染器没有 setAnimationLoop：请在宿主的渲染循环里调用 root.frame()')
      if (on) { looping = true; renderer.setAnimationLoop(t => root.frame(t)) }
      else if (looping) { looping = false; renderer.setAnimationLoop(null) }   // never the host's own loop
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
      for (const stop of stopMedia) stop()
      if (pointer && canvas.style && touchAction !== undefined) canvas.style.touchAction = touchAction
      for (const s of [...surfaces]) root.removeSurface(s)
      offQuality()
      settleAfterTick()   // no tick will come: an `await root.afterTick()` must not hang
      listeners.quality.clear(); listeners.error.clear(); listeners.theme.clear()
      pages.dispose()
      lights.key.dispose(); lights.hemi.dispose()
      screen.removeFromParent(); world.removeFromParent(); lights.group.removeFromParent()
      if (hostEnv) { scene.environment = null; scene.environmentIntensity = hostEnv.intensity }
      ownEnv?.dispose()
    },
  }
  return root
}
