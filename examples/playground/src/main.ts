// GlassUI playground: the sign-up form (a screen-layer Surface) and a world-layer Surface over a host three.js scene,
// the @glassui/vue component gallery (a screen-layer column, with a world-layer panel beside it), and the spatial scene
// (the 云仓 WMS dashboard preview: glass Blocks on an arc, the camera springing to the focused one).
//   ?scene=signup|world|both|gallery|spatial  (default both)   ?focus=<Block name>  (spatial: the first focus)   ?quality=high|medium|low|minimal  (default auto)   ?webgl  (force WebGL2)
//   ?hud=0  (no HUD: the visual harness's screenshots must not hold the live fps text; an error still shows)
//   ?motion=frozen|live  (default live; frozen: transitions, Block flights and the camera complete at once, no parallax: for screenshots)
// Drag the background to orbit (world and both only); the form stays put, the world Surface moves with the scene. The
// spatial scene's Space drives the camera itself (no orbit there); click an unfocused Block to focus it.

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
import { ARC, WALL, wallSpan } from './scenes/spatial-arc'
import { createCurvedWall, createHostLights, createWall } from './wall'
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

const SCENES = ['signup', 'world', 'both', 'gallery', 'spatial'] as const
/**
 * The gallery's column width in CSS px: 68 % of the viewport, but on wide viewports no more than half the width plus
 * 0.3 × the height (where the world panel's left edge lands, which scales with the height); Gallery.vue's world panel
 * stands in the rest.
 */
const galleryColumn = (): number => Math.round(Math.min(innerWidth * 0.68, innerWidth / 2 + innerHeight * 0.30))
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
// the canvas's right button belongs to the UI (the network map turns on a right drag): no browser menu over it; nor does
// a trackpad pinch (a wheel with ctrl) zoom the page over it: the wheel still reaches the UI (the map zooms)
renderer.domElement.addEventListener('contextmenu', e => { e.preventDefault() })
renderer.domElement.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault() }, { passive: false })

const hostScene = new Scene()
hostScene.background = new Color(0xd9d4d2)   // only seen past the wall's edges when orbiting far
const camera = new PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 50)
camera.position.set(0, 0.55, 7.3)
camera.lookAt(0, -0.05, 0)
// the spatial scene's camera swings round its arc: its backdrop is a curved wall round the arc, added once the Blocks
// stand (`spatialWall`)
if (mode !== 'spatial') hostScene.add(createWall())
hostScene.add(...createHostLights())

const orbit = mode === 'world' || mode === 'both'
// none in the spatial scene: its Space's camera rig writes the camera pose every tick, and OrbitControls' update (its
// `lookAt`) would fight it
const controls = mode === 'spatial' ? null : new OrbitControls(camera, renderer.domElement)
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
    // a screen Surface with no slab, the gallery over the wall: a full-height column on the left, kept at that size on
    // resize. Not the whole viewport: the gallery's world-layer panel (Gallery.vue) stands in the strip to its right,
    // where a full-width page would cover it and, its scroll root taking the pointer everywhere, catch its hover and clicks.
    const column = (): [number, number] => [galleryColumn(), innerHeight]
    const [width, height] = column()
    const page = root.createSurface({ left: 0, top: 0, width, height, background: 'none' })
    createGlassApp(Gallery, { root, motion }).mount(page)
    addEventListener('resize', () => page.setSize(...column()))
    surfaces.push(page, ...root.surfaces.filter(s => s !== page))   // and the Surfaces the gallery made (its world panel)
  }
  if (mode === 'spatial') {
    // detached: everything teleports into the Blocks' own Surfaces
    createGlassApp(Spatial, { root, motion }, { initialFocus: params.get('focus') ?? undefined }).mount()
    surfaces.push(...root.surfaces)
    hostScene.add(spatialWall(surfaces))
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
    if (controls) {
      controls.enableZoom = !root.pointer?.hovered   // a wheel over a Surface is the UI's
      controls.update()
    }
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

/**
 * The spatial scene's backdrop: a curved wall about the arc's centre (0, 0, ARC.radius), `WALL.out` past the arc,
 * spanning the Blocks' arc angles (read off their rest poses, the network's and the twin's explicit ones included: they
 * stand on the arc too, so they follow a retuned arc) plus `WALL.margin` on each side (spatial-arc.ts). At the WMS arc
 * (radius 10, four Blocks) that is −34° to 134°: an arc of about 41 units, its pastel repeating along it at one
 * density (createCurvedWall: u one every 32 units, seamless), so no view sees the colour run out.
 */
function spatialWall(blocks: readonly Surface[]): Mesh {
  return createCurvedWall({ center: [0, 0, ARC.radius], radius: ARC.radius + WALL.out, ...wallSpan(blocks.map(s => -s.restPose.rotation[1])), height: WALL.height })
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
