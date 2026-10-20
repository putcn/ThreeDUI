// Canvas-only Vue playground. ?scene=signup|world|both|gallery|perf|spatial; ?focus=<Block name> (gallery/spatial).
// ?scheme=light|dark, ?motion=frozen|live, ?quality=high|medium|low|minimal|auto, ?webgl, ?hud=0.
// Only world/both use OrbitControls; gallery/spatial give their camera to Space.

import { nextTick } from 'vue'
import { Color, PerspectiveCamera, Raycaster, Scene, Vector2, type Mesh } from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { absoluteRect, type Node, type Rect } from '@glassui/core'
import { createUIRoot, QUALITY, type QualityTier, type Surface, type UIRoot } from '@glassui/render'
// the orbit guard's own raycast and the host scene's studio environment: no public equivalents
import { createStudioEnvironment, hitSurfaces } from '@glassui/render/internal'
import { createGlassApp } from '@glassui/vue'
import Gallery from './gallery/Gallery.vue'
import Spatial from './scenes/Spatial.vue'
import { DOME, GRID, WALL, domeSpan } from './scenes/spatial-grid'
import { createAuroraDome } from './aurora'
import { createCurvedWall, createHostLights, createWall } from './wall'
import SignUp from './scenes/SignUp.vue'
import World from './scenes/World.vue'
import Both from './scenes/Both.vue'
import Perf from './scenes/Perf.vue'
import { playgroundTheme } from './theme'
import { createFrameStats, createSceneHarness, imeFocused } from './harness'

/**
 * What the visual harness reads: `ready` resolves to the root once the first frame has been drawn; `rectOf(id)` is the
 * CSS px box (from the canvas's top-left) of the node with that id in any Surface — the bounding box of its four
 * projected corners, and `cx, cy` its projected centre (where the harness hovers and presses). Null when there is no
 * such node, a corner or the centre is behind the camera, or the centre is off the canvas. Clipping by `scroll` or
 * `overflow: hidden` ancestors is not considered: a node scrolled out of view still has a rect.
 */
export interface NodeRect extends Rect { cx: number; cy: number }
export interface PlaygroundHandle { ready: Promise<UIRoot>; renderer: WebGPURenderer; root?: UIRoot; surfaces?: readonly Surface[]; rectOf(id: string): NodeRect | null; stats(): { frameMs: number; draws: number }; ime(): boolean; focus(): string | null; idle(): Promise<void> }
declare global { interface Window { __glassui?: PlaygroundHandle } }
declare global { interface Window { __glassuiSpatialFocus?: () => string | null } }

const SCENES = ['signup', 'world', 'both', 'gallery', 'perf', 'spatial'] as const
type SceneMode = (typeof SCENES)[number]
const params = new URLSearchParams(location.search)
const scheme = params.get('scheme') === 'dark' ? 'dark' : 'light'
const forceWebGL = params.has('webgl')
const sceneParam = params.get('scene')
const mode: SceneMode = SCENES.find(s => s === sceneParam) ?? 'both'
const motion = params.get('motion') === 'frozen' ? 'frozen' : 'live'
const stageParam = params.get('stage'), initialStage = stageParam === 'login' || stageParam === 'overview' ? stageParam : undefined
if (stageParam !== null && initialStage === undefined) console.warn(`[playground] unknown ?stage=${stageParam}; using the login flow`)
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
// the canvas's right button belongs to the UI (the network map turns on a right drag): no browser menu over it; nor does
// a trackpad pinch (a wheel with ctrl) zoom the page over it: the wheel still reaches the UI (the map zooms)
renderer.domElement.addEventListener('contextmenu', e => { e.preventDefault() })
renderer.domElement.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault() }, { passive: false })

const hostScene = new Scene()
hostScene.background = new Color(scheme === 'dark' ? 0x17161e : 0xd9d4d2)   // only seen past the wall's edges when orbiting far
const camera = new PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 50)
camera.position.set(0, 0.55, 7.3)
camera.lookAt(0, -0.05, 0)
// the spatial scene's camera swings round its arc: its backdrop is a curved wall round the arc, added once the Blocks
// stand (`spatialWall`)
if (mode !== 'spatial' && mode !== 'gallery') hostScene.add(createWall(scheme))
hostScene.add(...createHostLights())

const orbit = mode === 'world' || mode === 'both'
// No orbit controller in either Space scene: its Space's camera rig writes the camera pose every tick, and OrbitControls' update (its
// `lookAt`) would fight it
const controls = mode === 'spatial' || mode === 'gallery' ? null : new OrbitControls(camera, renderer.domElement)
if (controls) {
  controls.target.set(0, -0.05, 0)
  controls.enableDamping = true
  controls.enabled = orbit
}

const hud = document.getElementById('hud')
if (hud) hud.hidden = !liveHud
/** Where the live status (fps, paused) goes: nowhere under `?hud=0`. */
const stats = liveHud ? hud : null
const showError = (e: unknown): void => {
  console.error('[playground]', e)
  if (hud) { hud.hidden = false; hud.className = 'hud error'; hud.textContent = e instanceof Error ? e.message : String(e) }
}

// `handle` exists before `start()` runs, since `start()` writes `root` and `surfaces` into it; `ready` joins it after
const frameStats = createFrameStats()
let sceneHarness: ReturnType<typeof createSceneHarness> | undefined
const handle: Omit<PlaygroundHandle, 'ready'> = { renderer, rectOf, stats: frameStats.read, ime: () => imeFocused(handle.root?.ime ?? null, document.activeElement), focus: () => mode === 'spatial' ? window.__glassuiSpatialFocus?.() ?? null : sceneHarness?.focus() ?? null, idle: async () => { await ready; await sceneHarness?.idle() } }
const ready = start()
window.__glassui = Object.assign(handle, { ready })
ready.catch(showError)

async function start(): Promise<UIRoot> {
  const root = await createUIRoot({ renderer, scene: hostScene, camera, quality, theme: playgroundTheme() })
  // The spike's host lighting (spikes/glass3d/main.ts): the studio environment at 0.45 on the wall as well as the UI.
  // The renderer is initialised now (the PMREM needs it). The root runs in its default 'overlay' mode, which never
  // touches the host scene's environment (only 'shared' fills an empty one), so nothing else sets it. The playground
  // has no teardown: the texture lives as long as the page.
  hostScene.environment = createStudioEnvironment(renderer)
  hostScene.environmentIntensity = 0.45
  // Set scheme before Vue components read their first tokens.
  root.setScheme(scheme)
  root.on('error', e => console.error('[glassui]', e.surface?.name ?? '(no Surface)', e.error))
  const scenes = { signup: SignUp, world: World, both: Both, gallery: Gallery, perf: Perf, spatial: Spatial }
  createGlassApp(scenes[mode], { root, motion }, mode === 'gallery' ? { initialFocus: params.get('focus') ?? undefined } : mode === 'spatial' ? { ...(params.has('focus') ? { initialFocus: params.get('focus')! } : {}), ...(initialStage ? { initialStage } : {}) } : undefined).mount()
  // Vue's initial post-flush effects register Blocks and send the camera rig to the requested focus.
  await nextTick()
  const aurora = mode === 'spatial' ? createAuroraDome({ center: [0, 0, GRID.radius], radius: GRID.radius + DOME.out, ...domeSpan() }) : null
  if (aurora) hostScene.add(aurora.mesh)
  if (mode === 'gallery') {
    const angles = root.surfaces.map(s => Math.atan2(s.restPose.position[0], 10 - s.restPose.position[2]))
    hostScene.add(createCurvedWall({ center: [0, 0, 10], radius: 10 + WALL.out, from: Math.min(...angles) - WALL.margin, to: Math.max(...angles) + WALL.margin, height: WALL.height, scheme }))
  }
  handle.root = root
  // A live getter: opening a Dialog adds panel/scrim Surfaces after startup.
  Object.defineProperty(handle, 'surfaces', { get: () => root.surfaces })
  const names = mode === 'spatial' ? ['orders', 'dashboard', 'network', 'inbound', 'twin', 'settings'] : mode === 'gallery' ? ['primitives', 'buttons', 'toggles', 'inputs', 'dialog', 'containers'] : []
  sceneHarness = createSceneHarness(root, new Map(root.surfaces.flatMap((s, i) => names[i] ? [[s, names[i]!] as const] : [])))
  sceneHarness.focus()
  guardOrbit(root)

  // The first frame is drawn here, not on the first animation frame: `ready` must not depend on rAF (a hidden or
  // occluded tab gets none), and it then resolves with shaders compiled and the first content passes drawn.
  let lastInput = performance.now(), idleSince: number | null = null, lastPaced = -Infinity, pacedActive = false
  const noteInput = (): void => { lastInput = performance.now(); idleSince = null; pacedActive = false }
  if (mode === 'spatial') for (const type of ['pointermove', 'pointerdown', 'wheel', 'keydown'] as const) renderer.domElement.addEventListener(type, noteInput)
  const step = (t: number): boolean => {
    if (controls) {
      controls.enableZoom = !root.pointer?.hovered   // a wheel over a Surface is the UI's
      controls.update()
    }
    const idle = mode === 'spatial' && root.idle && t - lastInput >= 2000
    if (idle) { idleSince ??= t } else idleSince = null
    const paced = idle && idleSince !== null && t - idleSince >= 2000
    if (paced && t - lastPaced < 1000 / 15) {
      pacedActive = true
      return false
    }
    const visualMode = motion === 'frozen' ? 'frozen' : root.anim.reducedMotion ? 'reduced' : 'live'
    aurora?.update(renderer as unknown as import('three/webgpu').Renderer, t / 1000, visualMode)
    if (paced) root.frame(t, { paced: true })
    else root.frame(t)                               // ticks the UI, draws the host scene, then the UI
    if (paced) { lastPaced = t; pacedActive = true }
    else if (!idle) pacedActive = false
    sceneHarness?.focus()                          // retain Block focus while a screen Dialog owns the keys
    return true
  }
  step(performance.now())
  frameStats.record(performance.now(), renderer.info.render.drawCalls)
  frameStats.resetIntervals()

  // The host's loop. `info` resets per animation frame, so the draw count covers the whole frame: content passes,
  // shadow map, host scene and UI scene.
  let frames = 0, acc = 0, last = performance.now()
  // a hidden (or fully occluded) tab gets no animation frames: say so rather than leave a stale fps on screen, and
  // start the next reading afresh
  const notePaused = (): void => {
    if (document.visibilityState === 'hidden' && stats) stats.textContent = `${root.backend} · paused: the tab is hidden (no animation frames)`
  }
  document.addEventListener('visibilitychange', () => { frameStats.resetIntervals(); frames = 0; acc = 0; last = performance.now(); notePaused() })
  notePaused()
  void renderer.setAnimationLoop(t => {
    let drawn: boolean
    try { drawn = step(t) } catch (e) { void renderer.setAnimationLoop(null); showError(e); return }
    if (!drawn) return
    frameStats.record(t, renderer.info.render.drawCalls)
    const now = performance.now()
    frames++; acc += (now - last) / 1000; last = now
    if (acc > 0.5 && stats) {
      const fps = (frames / acc).toFixed(0), draws = renderer.info.render.drawCalls
      stats.textContent = pacedActive
        ? `${root.backend} · idle 15 fps · ${draws} draws · ${root.quality.tier} · ${root.surfaces.length} surfaces`
        : `${root.backend} · ${fps} fps · ${draws} draws · ${root.quality.tier} · ${root.surfaces.length} surface${root.surfaces.length === 1 ? '' : 's'}${orbit ? ' · drag to orbit' : ''}`
      frames = 0; acc = 0
    }
  })
  return root
}

/**
 * The spatial scene's backdrop: a curved wall about the arc's centre (0, 0, ARC.radius), `WALL.out` past the arc,
 * spanning the Blocks' arc angles (from their rest positions about the arc's centre, `arcAngleOf`: a rotation read back
 * past 90° of yaw, as the twin's is, decomposes otherwise; the network's and the twin's explicit poses stand on the arc
 * too, so they follow a retuned arc) plus `WALL.margin` on each side (spatial-arc.ts). At the WMS arc
 * (radius 10, four Blocks) that is −34° to 134°: an arc of about 41 units, its pastel repeating along it at one
 * density (createCurvedWall: u one every 32 units, seamless), so no view sees the colour run out.
 */
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
  if (!orbit || !controls) return
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
