// GlassUI playground: the sign-up form (a screen-layer Surface) and a world-layer Surface over a host three.js scene,
// and the @glassui/vue component gallery (a full-screen screen-layer Surface).
//   ?scene=signup|world|both|gallery  (default both)   ?quality=high|medium|low|minimal  (default auto)   ?webgl  (force WebGL2)
//   ?hud=0  (no HUD: the visual harness's screenshots must not hold the live fps text; an error still shows)
//   ?motion=frozen|live  (default live; frozen: the gallery's transitions complete at once, for screenshots)
// Drag the background to orbit (world and both only); the form stays put, the world Surface moves with the scene.

import { Color, PerspectiveCamera, Raycaster, Scene, Vector2 } from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { absoluteRect, type Node, type Rect } from '@glassui/core'
import { createUIRoot, QUALITY, type QualityTier, type Surface, type UIRoot } from '@glassui/render'
// the orbit guard's own raycast and the host scene's studio environment: no public equivalents
import { createStudioEnvironment, hitSurfaces } from '@glassui/render/internal'
import { createGlassApp } from '@glassui/vue'
import Gallery from './gallery/Gallery.vue'
import { createHostLights, createWall } from './wall'
import { buildSignup, SIGNUP } from './signup'
import { buildWorld } from './world'

/**
 * What the visual harness reads: `ready` resolves to the root once the first frame has been drawn; `rectOf(id)` is the
 * CSS px box (from the canvas's top-left) of the node with that id in any Surface — the bounding box of its four
 * projected corners, and `cx, cy` its projected centre (where the harness hovers and presses). Null when there is no
 * such node, a corner or the centre is behind the camera, or the centre is off the canvas. Clipping by `scroll` or
 * `overflow: hidden` ancestors is not considered: a node scrolled out of view still has a rect.
 */
export interface NodeRect extends Rect { cx: number; cy: number }
export interface PlaygroundHandle { ready: Promise<UIRoot>; renderer: WebGPURenderer; root?: UIRoot; surfaces?: Surface[]; rectOf(id: string): NodeRect | null }
declare global { interface Window { __glassui?: PlaygroundHandle } }

const SCENES = ['signup', 'world', 'both', 'gallery'] as const
type SceneMode = (typeof SCENES)[number]
const params = new URLSearchParams(location.search)
const forceWebGL = params.has('webgl')
const sceneParam = params.get('scene')
const mode: SceneMode = SCENES.find(s => s === sceneParam) ?? 'both'
const motion = params.get('motion') === 'frozen' ? 'frozen' : 'live'
const qualityParam = params.get('quality')
const isTier = (q: string | null): q is QualityTier => q !== null && Object.hasOwn(QUALITY, q)
const quality: QualityTier | 'auto' = isTier(qualityParam) ? qualityParam : 'auto'
const liveHud = params.get('hud') !== '0'
if (sceneParam !== null && sceneParam !== mode) console.warn(`[playground] unknown ?scene=${sceneParam}; using "both"`)
if (params.has('motion') && params.get('motion') !== motion) console.warn(`[playground] unknown ?motion=${params.get('motion')}; using "live"`)
if (qualityParam !== null && qualityParam !== 'auto' && !isTier(qualityParam)) console.warn(`[playground] unknown ?quality=${qualityParam}; using "auto"`)

const renderer = new WebGPURenderer({ antialias: true, forceWebGL })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)

const hostScene = new Scene()
hostScene.background = new Color(0xd9d4d2)   // only seen past the wall's edges when orbiting far
const camera = new PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 50)
camera.position.set(0, 0.55, 7.3)
camera.lookAt(0, -0.05, 0)
hostScene.add(createWall(), ...createHostLights())

const orbit = mode === 'world' || mode === 'both'
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, -0.05, 0)
controls.enableDamping = true
controls.enabled = orbit

const hud = document.getElementById('hud')
if (hud) hud.hidden = !liveHud
/** Where the live status (fps, paused) goes: nowhere under `?hud=0`. */
const stats = liveHud ? hud : null
const showError = (e: unknown): void => {
  console.error('[playground]', e)
  if (hud) { hud.hidden = false; hud.className = 'hud error'; hud.textContent = e instanceof Error ? e.message : String(e) }
}

// `handle` exists before `start()` runs, since `start()` writes `root` and `surfaces` into it; `ready` joins it after
const handle: Omit<PlaygroundHandle, 'ready'> = { renderer, rectOf }
const ready = start()
window.__glassui = Object.assign(handle, { ready })
ready.catch(showError)

async function start(): Promise<UIRoot> {
  const root = await createUIRoot({ renderer, scene: hostScene, camera, quality })
  // The spike's host lighting (spikes/glass3d/main.ts): the studio environment at 0.45 on the wall as well as the UI.
  // The renderer is initialised now (the PMREM needs it). The root runs in its default 'overlay' mode, which never
  // touches the host scene's environment (only 'shared' fills an empty one), so nothing else sets it. The playground
  // has no teardown: the texture lives as long as the page.
  hostScene.environment = createStudioEnvironment(renderer)
  hostScene.environmentIntensity = 0.45
  root.on('error', e => console.error('[glassui]', e.surface?.name ?? '(no Surface)', e.error))
  const surfaces: Surface[] = []
  if (mode === 'signup' || mode === 'both') {
    const form = buildSignup(root)
    surfaces.push(form)
    fit(form)
    addEventListener('resize', () => fit(form))
  }
  if (mode === 'world' || mode === 'both') surfaces.push(buildWorld(root))
  if (mode === 'gallery') {
    // a full-screen screen Surface (`fill` keeps it the viewport's size) with no slab: the gallery over the wall
    const page = root.createSurface({ fill: true, width: innerWidth, height: innerHeight, background: 'none' })
    createGlassApp(Gallery, { root, motion }).mount(page)
    surfaces.push(page)
  }
  handle.root = root
  handle.surfaces = surfaces
  guardOrbit(root)

  /** Keeps the 885 × 1045 form fully visible: scaled down to the viewport (never up) and centred. */
  function fit(s: Surface): void {
    const k = Math.min(1, (innerHeight - 40) / SIGNUP.height, (innerWidth - 40) / SIGNUP.width)
    s.scale.setScalar(Math.max(0.1, k))
    root.screen.place(s, { left: (innerWidth - SIGNUP.width * s.scale.x) / 2, top: (innerHeight - SIGNUP.height * s.scale.y) / 2 })
  }

  // The first frame is drawn here, not on the first animation frame: `ready` must not depend on rAF (a hidden or
  // occluded tab gets none), and it then resolves with shaders compiled and the first content passes drawn.
  const step = (t: number): void => {
    controls.enableZoom = !root.pointer?.hovered   // a wheel over a Surface is the UI's
    controls.update()
    root.frame(t)                                    // ticks the UI and renders the host scene, then the UI over it
  }
  step(performance.now())

  // The host's loop. `info` resets per animation frame, so the draw count covers the whole frame: content passes,
  // shadow map, host scene and UI scene.
  let frames = 0, acc = 0, last = performance.now()
  // a hidden (or fully occluded) tab gets no animation frames: say so rather than leave a stale fps on screen, and
  // start the next reading afresh
  const notePaused = (): void => {
    if (document.visibilityState === 'hidden' && stats) stats.textContent = `${root.backend} · paused: the tab is hidden (no animation frames)`
  }
  document.addEventListener('visibilitychange', () => { frames = 0; acc = 0; last = performance.now(); notePaused() })
  notePaused()
  void renderer.setAnimationLoop(t => {
    try { step(t) } catch (e) { void renderer.setAnimationLoop(null); showError(e); return }
    const now = performance.now()
    frames++; acc += (now - last) / 1000; last = now
    if (acc > 0.5 && stats) {
      const fps = (frames / acc).toFixed(0), draws = renderer.info.render.drawCalls
      stats.textContent = `${root.backend} · ${fps} fps · ${draws} draws · ${root.quality.tier} · ${surfaces.length} surface${surfaces.length === 1 ? '' : 's'}${orbit ? ' · drag to orbit' : ''}`
      frames = 0; acc = 0
    }
  })
  return root
}

/** See `PlaygroundHandle.rectOf`: the node's Surface-pt rect (`absoluteRect`), its corners and centre projected (`screenFromPoint`). */
function rectOf(id: string): NodeRect | null {
  const root = handle.root
  if (!root) return null
  const find = (n: Node): Node | null => {
    if (n.id === id) return n
    for (const c of n.children) { const hit = find(c); if (hit) return hit }
    return null
  }
  for (const s of root.surfaces) {
    const node = find(s.root)
    if (!node) continue
    const r = absoluteRect(node)
    const xs: number[] = [], ys: number[] = []
    for (const [x, y] of [[r.x, r.y], [r.x + r.width, r.y], [r.x, r.y + r.height], [r.x + r.width, r.y + r.height]] as const) {
      const p = root.screenFromPoint(s, x, y)
      if (!p) return null
      xs.push(p.x); ys.push(p.y)
    }
    const c = root.screenFromPoint(s, r.x + r.width / 2, r.y + r.height / 2), canvas = renderer.domElement.getBoundingClientRect()
    if (!c || !(c.x >= 0 && c.x < canvas.width && c.y >= 0 && c.y < canvas.height)) return null
    const left = Math.min(...xs), top = Math.min(...ys)
    return { x: left, y: top, width: Math.max(...xs) - left, height: Math.max(...ys) - top, cx: c.x, cy: c.y }
  }
  return null
}

/**
 * OrbitControls and the pointer bridge both listen on the canvas. A press that lands on a Surface belongs to the UI:
 * decide at the press, before OrbitControls sees it (a capture listener on `window` runs ahead of the canvas's own),
 * and give the controls back when it ends. Deciding per press, not per frame, keeps an orbit drag that passes over the
 * world Surface going.
 */
function guardOrbit(root: UIRoot): void {
  if (!orbit) return
  const canvas = renderer.domElement, raycaster = new Raycaster(), ndc = new Vector2()
  addEventListener('pointerdown', e => {
    if (e.target !== canvas || !e.isPrimary) return
    const r = canvas.getBoundingClientRect()
    ndc.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1)
    raycaster.setFromCamera(ndc, camera)
    controls.enabled = !hitSurfaces(raycaster, root.surfaces)
  }, { capture: true })
  const release = (e: PointerEvent): void => { if (e.isPrimary) controls.enabled = true }
  addEventListener('pointerup', release)
  addEventListener('pointercancel', release)
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})
