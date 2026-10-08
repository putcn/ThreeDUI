// GlassUI playground: the sign-up form (a screen-layer Surface) and a world-layer Surface over a host three.js scene.
//   ?scene=signup|world|both  (default both)   ?quality=high|medium|low|minimal  (default auto)   ?webgl  (force WebGL2)
// Drag the background to orbit (not in ?scene=signup); the form stays put, the world Surface moves with the scene.

import { Color, PerspectiveCamera, Raycaster, Scene, Vector2 } from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { createUIRoot, hitSurfaces, QUALITY, type QualityTier, type Surface, type UIRoot } from '@glassui/render'
import { createHostLights, createWall } from './wall'
import { buildSignup, SIGNUP } from './signup'
import { buildWorld } from './world'

/** What the visual harness (Task 24) reads: `ready` resolves to the root once the first frame has rendered. */
export interface PlaygroundHandle { ready: Promise<UIRoot>; root?: UIRoot; surfaces?: Surface[] }
declare global { interface Window { __glassui?: PlaygroundHandle } }

type SceneMode = 'signup' | 'world' | 'both'
const params = new URLSearchParams(location.search)
const forceWebGL = params.has('webgl')
const sceneParam = params.get('scene')
const mode: SceneMode = sceneParam === 'signup' || sceneParam === 'world' ? sceneParam : 'both'
const qualityParam = params.get('quality')
const isTier = (q: string | null): q is QualityTier => q !== null && Object.hasOwn(QUALITY, q)
const quality: QualityTier | 'auto' = isTier(qualityParam) ? qualityParam : 'auto'
if (sceneParam !== null && sceneParam !== mode) console.warn(`[playground] unknown ?scene=${sceneParam}; using "both"`)
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

const orbit = mode !== 'signup'
const controls = new OrbitControls(camera, renderer.domElement)
controls.target.set(0, -0.05, 0)
controls.enableDamping = true
controls.enabled = orbit

const hud = document.getElementById('hud')
const showError = (e: unknown): void => {
  console.error('[playground]', e)
  if (hud) { hud.className = 'hud error'; hud.textContent = e instanceof Error ? e.message : String(e) }
}

const handle: PlaygroundHandle = { ready: start() }
window.__glassui = handle
handle.ready.catch(showError)

async function start(): Promise<UIRoot> {
  const root = await createUIRoot({ renderer, scene: hostScene, camera, quality })
  root.on('error', e => console.error('[glassui]', e.surface.name, e.error))
  const surfaces: Surface[] = []
  if (mode !== 'world') {
    const form = buildSignup(root)
    surfaces.push(form)
    fit(form)
    addEventListener('resize', () => fit(form))
  }
  if (mode !== 'signup') surfaces.push(buildWorld(root))
  handle.root = root
  handle.surfaces = surfaces
  guardOrbit(root)

  /** Keeps the 885 × 1045 form fully visible: scaled down to the viewport (never up) and centred. */
  function fit(s: Surface): void {
    const k = Math.min(1, (innerHeight - 40) / SIGNUP.height, (innerWidth - 40) / SIGNUP.width)
    s.scale.setScalar(Math.max(0.1, k))
    root.screen.place(s, { left: (innerWidth - SIGNUP.width * s.scale.x) / 2, top: (innerHeight - SIGNUP.height * s.scale.y) / 2 })
  }

  // The host's loop: `root.frame` ticks the UI and renders the host scene, then the UI over it.
  let frames = 0, acc = 0, last = performance.now()
  await new Promise<void>((resolve, reject) => {
    let first = true
    void renderer.setAnimationLoop(t => {
      try {
        controls.enableZoom = !root.pointer?.hovered   // a wheel over a Surface is the UI's
        controls.update()
        root.frame(t)
      } catch (e) {
        void renderer.setAnimationLoop(null)
        if (first) reject(e); else showError(e)
        return
      }
      if (first) { first = false; resolve() }
      const now = performance.now()
      frames++; acc += (now - last) / 1000; last = now
      if (acc > 0.5 && hud) {
        const fps = (frames / acc).toFixed(0), draws = renderer.info.render.drawCalls
        hud.textContent = `${root.backend} · ${fps} fps · ${draws} UI draws · ${root.quality.tier} · ${surfaces.length} surface${surfaces.length === 1 ? '' : 's'}${orbit ? ' · drag to orbit' : ''}`
        frames = 0; acc = 0
      }
    })
  })
  return root
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
