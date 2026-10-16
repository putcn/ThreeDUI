import { Box3, Frustum, Group, Matrix4, Quaternion, Scene, Vector2, Vector3, VSMShadowMap, type OrthographicCamera, type PerspectiveCamera, type Texture } from 'three'
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
import { CameraRig, type CameraRigOptions } from './rig'
import { BarChart } from './chart/bar'
import { SurfaceChart } from './chart/surface'
import { BarMatrix } from './chart/matrix'

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
  /**
   * A Surface failed (it stopped drawing: `Surface.markFailed`), or, with `surface: null`, a render of the UI threw and
   * no Surface reproduced it (`render` / `renderUI`). Without a listener the root logs it (`console.error`).
   */
  error: { surface: Surface | null; error: Error }
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
   * child of `world` (`ptPerUnit` default 244; `billboard` faces the camera). `Surface.dispose` on it also removes it
   * from the root (as `removeSurface` does). Throws a `GlassUIError` after `dispose`.
   */
  createSurface(opts: CreateSurfaceOptions): Surface
  /**
   * Drops the Surface from the root (its list entry, pointer state and screen placement) and disposes it; a no-op for
   * one that is not (any more) the root's.
   */
  removeSurface(surface: Surface): void
  /**
   * A `CameraRig` on the root's camera (spatial spec §2.2): `focus` springs the camera square-on to a world Surface's rest
   * pose, with pointer parallax; each `tick` updates it after the Surfaces' motion and before the screen layer follows
   * the camera, with the viewport's aspect (`renderer.getSize`) and `anim.reducedMotion`; while it has a target the
   * lights take its `lightPose` (§11.1: anchored in space, no parallax, lagging a focus change), else the camera's pose.
   * While it lives it writes the camera every tick: no other controller may drive the camera meanwhile. One live rig per
   * root (a second throws a readable `GlassUIError` until the first is disposed); a perspective camera only; throws
   * after `dispose`, which disposes the rig.
   */
  createCameraRig(opts?: CameraRigOptions): CameraRig
  /**
   * A new bar chart (spatial spec §2.5), for `Surface.attach3D` with its `update` as the attachment's. It is the
   * caller's: the root neither holds nor disposes it (`BarChart.dispose`). Throws after `dispose`.
   */
  createBarChart(): BarChart
  /**
   * A new outbound heat surface (spatial spec §12.1), for `Surface.attach3D` with its `update` as the attachment's; its
   * labels are drawn on the root's canvases (`createCanvas`, default DOM ones). It is the caller's: the root neither
   * holds nor disposes it (`SurfaceChart.dispose`). Throws after `dispose`.
   */
  createSurfaceChart(): SurfaceChart
  /**
   * A new zone × category stock matrix (spatial spec §12.2), for `Surface.attach3D` with its `update` as the
   * attachment's; its labels are drawn on the root's canvases (`createCanvas`, default DOM ones). It is the caller's: the
   * root neither holds nor disposes it (`BarMatrix.dispose`). Throws after `dispose`.
   */
  createBarMatrix(): BarMatrix
  /**
   * Swaps the theme: the shared context's theme and text measure, the animation runtime's theme, then every Surface
   * restyled (`Surface.restyle`: fills, an opaque background, the glass, every node marked); emits `'theme'`. A theme
   * without `colors.light` / `colors.dark` tables throws a `GlassUIError` and changes nothing. A no-op after `dispose`.
   */
  setTheme(theme: Theme): void
  /**
   * Swaps the colour scheme (dark mode) as `setTheme` swaps the theme; a no-op for the current scheme, and after
   * `dispose`. Anything but `'light'` / `'dark'` throws a `GlassUIError` and changes nothing.
   */
  setScheme(scheme: ColorScheme): void
  /**
   * Surface motion, the camera rig, view culling, layout, animation, content passes, draw order and the shadow fit; `dt`
   * in seconds. Surface motion steps, then the camera rig (`createCameraRig`) moves the camera, and billboard world
   * Surfaces turn to face it, before any matrix is read; a world Surface out of view (`Surface.culled`) or faded out is
   * neither drawn nor prepared, its content redrawn when it shows again. Each shown Surface is handed the key light's
   * direction in its own frame (`Surface.setLightDirection`: its drop shadows) before it ticks. `prepare` is told
   * whether the camera (its pose or projection), the Surface or its animation moved (the content RT's settle-to-shrink);
   * a Surface's motion re-fits the shadows while it runs. Ends by resolving the `afterTick` promises. A no-op after
   * `dispose`.
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
   *
   * Render isolation (spec §9): a throw from the draw that holds the UI (the UI scene; shared: the host scene) does not
   * propagate. The root draws that scene again with each shown Surface's `layer` alone (the others hidden, then
   * restored) and fails (`Surface.markFailed`) every Surface that throws so, each emitting `'error'`; when none does, or
   * when the scene throws with every Surface hidden (the fault is not a Surface's), it emits `'error'` with `surface:
   * null` and fails none. The next frame draws the Surfaces left. Overlay's host-scene draw is the host's: its throw
   * propagates. After any throw the renderer's render target is put back as it was before the draw. A no-op after
   * `dispose`.
   */
  render(): void
  /**
   * Overlay: the UI scene alone, over what the host drew this frame (`autoClear` false for the call, then the host's
   * value again), with `render`'s isolation; a no-op when shared, and after `dispose`.
   */
  renderUI(): void
  /**
   * `tick` (dt from the scheduler, clamped) + `render`. `nowMs` (default `performance.now()`): the same clock on every
   * call, e.g. the animation loop's. With `quality: 'auto'` each frame also feeds the quality controller, relative to
   * the display's refresh (`FrameSampler`: a dropped refresh counts its interval, a frame that met it its CPU time), so
   * `'auto'` assumes a continuous loop — `autoTick(true)` or a host rAF loop calling `frame` every refresh. An explicit
   * tier never samples. A no-op after `dispose`.
   */
  frame(nowMs?: number): void
  /**
   * `true`: `renderer.setAnimationLoop(t => root.frame(t))`; `false`: clears the loop if (and only if) this installed it.
   * A no-op after `dispose` (which cleared a loop it installed).
   */
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
 * Each `tick`: every Surface's motion steps (`Surface.stepMotion`); the camera rig, if there is one, moves the camera
 * (`createCameraRig`); the screen layer follows the camera, the lights the rig's light pose (`CameraRig.lightPose`)
 * while it has one, else the camera;
 * billboard world Surfaces turn to face it; world Surfaces out of the view frustum are culled (`Surface.culled`); every
 * shown Surface is handed the direction toward the key light in its own frame, for its drop shadows
 * (`Surface.setLightDirection`, spatial spec §11.7); every Surface ticks; glyphs evicted by a later Surface's are re-laid
 * out; draw orders are assigned (screen Surfaces above world ones, nearer above farther); the content passes of the
 * shown Surfaces draw (a hidden one's wait for it to show again); the key light's shadow camera is re-fitted to every
 * shown Surface when the lights, a Surface's pose or its glass changed, or a Surface's motion runs (the map redraws
 * only then: a camera move alone redraws nothing unless the lights follow it or it turns a billboard); `afterTick`
 * waiters resolve.
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

  const createCanvas = opts.createCanvas ?? domCanvas
  const text = opts.text ?? new SystemFontEngine({ createCanvas })
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

  /**
   * Drops the root's references to `s` (its list entry, the pointer's capture and hover, its screen placement, its
   * last pose); false when it is not (any more) this root's. `removeSurface` and a direct `Surface.dispose` both end here.
   */
  function forgetSurface(s: Surface): boolean {
    const i = surfaces.indexOf(s)
    if (i < 0) return false
    surfaces.splice(i, 1)
    pointer?.forget(s); screen.unplace(s); lastPose.delete(s); lastSeen.delete(s)
    return true
  }

  const listeners: { [K in keyof UIRootEventMap]: Set<(e: UIRootEventMap[K]) => void> } = { quality: new Set(), error: new Set(), theme: new Set() }
  function emit<K extends keyof UIRootEventMap>(type: K, e: UIRootEventMap[K]): void {
    for (const fn of [...listeners[type]]) try { fn(e) } catch (err) { console.error(`[glassui] a "${type}" listener threw:`, err) }
  }
  /** `'error'` to its listeners; with none, to the console (spec §9: a failure is never silent). */
  function reportError(surface: Surface | null, error: Error): void {
    if (listeners.error.size) emit('error', { surface, error })
    else console.error('[glassui]', surface?.name ?? '(no Surface)', error)
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

  const toError = (e: unknown): Error => e instanceof Error ? e : new Error(String(e))

  /**
   * `renderer.render(target, camera)`; a throw puts the render target back as it was, then propagates. three r186's
   * `_renderScene` binds its internal framebuffer target (sRGB output) and restores the output one only after its object
   * loop, so a throw inside the loop (a node build failure) leaves it bound: every later draw would land offscreen with
   * no output pass, and the canvas would freeze. (On success three restores it itself.)
   */
  function renderRestoring(target: Scene): void {
    const prev = renderer.getRenderTarget?.() ?? null
    try { renderer.render(target, camera) } catch (e) { renderer.setRenderTarget(prev); throw e }
  }

  /** `renderer.render(target, camera)`, with a throw isolated (`isolate`) instead of propagating. */
  function draw(target: Scene): void {
    try { renderRestoring(target) } catch (e) { isolate(target, e) }
  }

  /**
   * Render isolation (spec §9): drawing `target` threw `e`. Draws it again with each shown Surface's `layer` alone (the
   * others hidden, restored in `finally`) and fails (`markFailed`) the Surfaces whose draw throws; each emits `'error'`
   * through the listener `createSurface` added. When none throws alone, or `target` throws with every Surface hidden
   * (then none is to blame: a lost device, the lights, a shared host's own objects), emits `'error'` with `surface:
   * null` instead. Never throws.
   */
  function isolate(target: Scene, e: unknown): void {
    const shown = surfaces.filter(s => s.visible && !s.error)
    const was = shown.map(s => s.layer.visible)
    /** Draws `target` with only `only`'s layer shown among `shown` (null: none of them); what that threw, or null. */
    const alone = (only: Surface | null): Error | null => {
      shown.forEach(s => { if (s !== only) s.layer.visible = false })
      try { renderRestoring(target); return null }
      catch (err) { return toError(err) }
      finally { shown.forEach((s, i) => { s.layer.visible = was[i]! }) }
    }
    const culprits: [Surface, Error][] = []
    if (shown.length && alone(null) === null) for (const s of shown) { const err = alone(s); if (err) culprits.push([s, err]) }
    if (!culprits.length) { reportError(null, toError(e)); return }
    for (const [s, err] of culprits) s.markFailed(err)   // a no-op on one an earlier culprit's listener disposed
  }

  const size = new Vector2(), v = new Vector3(), camPos = new Vector3(), union = new Box3(), point = new Vector3(), view = new Vector3()
  const qCam = new Quaternion(), qParent = new Quaternion(), qSurface = new Quaternion(), toKey = new Vector3(), local = new Vector3()
  const lastCamera = new Matrix4(), lastProjection = new Matrix4(), lastLight = new Matrix4(), lastPose = new WeakMap<Surface, Matrix4>()
  /** Each Surface's `matrixWorld` at its last `prepare` (whether it moved since: the content RT's settle count). */
  const lastSeen = new WeakMap<Surface, Matrix4>()
  const frustum = new Frustum(), viewProjection = new Matrix4()
  let lastFitted = -1, looping = false, disposed = false
  /** The last `createCameraRig`'s (a disposed one stays until the next). */
  let rig: CameraRig | null = null
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
   * went away; the fit marks the map for redraw. A Surface faded out (opacity 0) or culled draws nothing: it is left out.
   */
  function fitShadows(changed: boolean): void {
    const drawn = surfaces.filter(s => !s.error && s.visible && s.layer.visible)
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
      if (disposed) throw new GlassUIError('UIRoot.createSurface', 'root 已经 dispose')
      const { layer = 'screen', fill, center, left, top, ...rest } = o
      const s = new Surface(layer === 'screen' ? { ...rest, ptPerUnit: 1, placement: 'screen' } : { ...rest, placement: 'world' }, ctx)
      s.addEventListener('error', e => reportError(s, e.error))
      s.addEventListener('dispose', () => { forgetSurface(s) })   // disposed directly: it leaves the root too
      if (layer === 'screen') screen.place(s, fill ? { fill: true } : center ? { center: true } : { left: left ?? 0, top: top ?? 0 })
      else world.add(s)
      surfaces.push(s)
      return s
    },
    removeSurface(s) { if (forgetSurface(s)) s.dispose() },
    createCameraRig(o) {
      const scope = 'UIRoot.createCameraRig'
      if (disposed) throw new GlassUIError(scope, 'root 已经 dispose')
      if (rig && !rig.disposed) throw new GlassUIError(scope, '这个 root 已经有一个 CameraRig：先 dispose 旧的')
      if (!('isPerspectiveCamera' in camera && camera.isPerspectiveCamera)) throw new GlassUIError(scope, 'CameraRig 只支持 PerspectiveCamera')
      // the aspect from `size`: `tick` reads the renderer's size just before it updates the rig
      rig = new CameraRig({ camera, canvas, aspect: () => size.x / size.y, reducedMotion: () => anim.reducedMotion }, o)
      return rig
    },
    createBarChart() {
      if (disposed) throw new GlassUIError('UIRoot.createBarChart', 'root 已经 dispose')
      return new BarChart()
    },
    createSurfaceChart() {
      if (disposed) throw new GlassUIError('UIRoot.createSurfaceChart', 'root 已经 dispose')
      return new SurfaceChart({ createCanvas })
    },
    createBarMatrix() {
      if (disposed) throw new GlassUIError('UIRoot.createBarMatrix', 'root 已经 dispose')
      return new BarMatrix({ createCanvas })
    },
    tick(dt) {
      if (disposed) return
      // the Surfaces' own motion first: every matrix read below sees this tick's pose
      const animating = new Set<Surface>()
      for (const s of surfaces) if (s.stepMotion(dt)) animating.add(s)
      renderer.getSize(size)
      // the camera rig aims at the Surfaces' rest poses with this size's aspect; the screen layer follows it
      if (rig && !rig.disposed) rig.update(dt)
      screen.update(camera, { width: size.x, height: size.y })   // also brings camera.matrixWorld up to date
      // the lights: anchored where the rig focuses (no parallax, lagging a focus change), or else on the camera; either
      // way the key light stays top-left-front of that pose
      const lit = rig && !rig.disposed ? rig.lightPose : null
      if (lit) { lights.group.position.copy(lit.position); lights.group.quaternion.copy(lit.quaternion) }
      else { camera.getWorldPosition(lights.group.position); camera.getWorldQuaternion(lights.group.quaternion) }
      lights.group.updateMatrixWorld(true)
      // the shadow fit follows the lights, not the view: the map is the light's view of the Surfaces (a camera move
      // that turns a billboard is caught by its pose in `fitShadows`); the content RTs follow the camera's pose and
      // projection (a zoom, a new aspect)
      const cameraMoved = !lastCamera.equals(camera.matrixWorld) || !lastProjection.equals(camera.projectionMatrix)
      let changed = !lastLight.equals(lights.group.matrixWorld)
      lastCamera.copy(camera.matrixWorld); lastProjection.copy(camera.projectionMatrix); lastLight.copy(lights.group.matrixWorld)
      camera.getWorldQuaternion(qCam)
      for (const s of surfaces) {
        if (s.model.placement !== 'world') continue
        // a billboard's world rotation is the camera's: its local one undoes its parent's
        if (s.billboard) s.quaternion.copy(s.parent ? s.parent.getWorldQuaternion(qParent).invert() : qParent.identity()).multiply(qCam)
        s.updateWorldMatrix(true, true)
      }
      // view culling: a world Surface whose bounds miss the view frustum draws, captures and prepares nothing this tick;
      // one leaving or coming back refits the shadows (a swap in one tick keeps the drawn count, so it alone would not)
      frustum.setFromProjectionMatrix(viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse), camera.coordinateSystem, camera.reversedDepth)
      for (const s of surfaces) {
        if (s.model.placement !== 'world') continue
        const culled = !frustum.intersectsBox(s.glassBounds.applyMatrix4(s.matrixWorld))
        if (culled !== s.culled) { s.culled = culled; changed = true }
      }
      // the drop shadows (spatial §11.7): every shown Surface gets the key light's direction in its own frame (a screen
      // Surface's is the camera's); a hidden one gets it when it shows again, before its content redraws. The key is a
      // directional light: one direction for all, from its target toward it (as its shadow map is aimed)
      lights.key.getWorldPosition(toKey).sub(lights.key.target.getWorldPosition(v)).normalize()
      for (const s of surfaces) {
        if (s.error || !s.layer.visible) continue
        s.setLightDirection(local.copy(toKey).applyQuaternion(s.getWorldQuaternion(qSurface).invert()))
      }
      const epoch = text.atlas.epoch
      each(s => s.tick(dt))
      // the pages are shared: a later Surface's glyphs may have evicted an earlier one's this tick
      if (text.atlas.epoch !== epoch) each(s => s.refreshText())
      // rebuilt or animating (its nodes, or its own motion: a fading glass's shadow fades with it); a hidden Surface's
      // content waits for it to show again
      for (const s of surfaces) if (!s.error && s.layer.visible && (s.contentDirty || s.needsFrame || animating.has(s))) changed = true
      assignDrawOrders()
      const dpr = renderer.getPixelRatio()
      each(s => {
        if (!s.layer.visible) return   // faded out or culled: its content stays dirty and redraws when it shows again
        // moving (the camera, the Surface, or its animation): the content RT may grow but not shrink (`rtTarget`)
        const last = lastSeen.get(s), moved = !last || !last.equals(s.matrixWorld)
        if (last) last.copy(s.matrixWorld); else lastSeen.set(s, s.matrixWorld.clone())
        // a glass Surface's luma projects its glass with the camera
        s.prepare(renderer, projectedPx(s), dpr, camera, cameraMoved || moved || animating.has(s))
      })
      fitShadows(changed)
      settleAfterTick()
    },
    setTheme(t) { if (disposed) return; checkTheme('UIRoot.setTheme', t); theme = t; restyleAll() },
    setScheme(sc) { if (disposed) return; checkScheme('UIRoot.setScheme', sc); if (sc !== scheme) { scheme = sc; restyleAll() } },
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
      if (disposed) return
      if (mode === 'shared') { draw(scene); return }
      const hostAutoClear = renderer.autoClear
      renderer.autoClear = true
      try {
        renderRestoring(scene)   // the host's: its throw propagates, the render target put back
        root.renderUI()
      } finally { renderer.autoClear = hostAutoClear }
    },
    renderUI() {
      if (disposed || mode === 'shared') return
      const hostAutoClear = renderer.autoClear
      renderer.autoClear = false   // over the host's colour and depth
      try { draw(uiScene) } finally { renderer.autoClear = hostAutoClear }
    },
    frame(nowMs) {
      if (disposed) return
      const now = nowMs ?? performance.now()
      const t0 = performance.now()
      root.tick(scheduler.dt(now))
      root.render()
      if (!adaptive) return
      const sample = frames.sample(now, performance.now() - t0)   // refresh-relative: see FrameSampler
      if (sample !== null) quality.sample(sample)
    },
    autoTick(on) {
      if (disposed) return   // its loop is cleared; a later one is the host's
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
      if (looping) { looping = false; renderer.setAnimationLoop?.(null) }   // only a loop `autoTick` installed: the host may run its own
      pointer?.detach()
      rig?.dispose()
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
