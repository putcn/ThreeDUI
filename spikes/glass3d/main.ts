// SPIKE: real-3D glass UI scene. ?webgl forces the WebGL2 backend. Drag to orbit.

import {
  Scene, PerspectiveCamera, PlaneGeometry, Mesh, Group, Color, Object3D,
  TorusKnotGeometry, SphereGeometry, IcosahedronGeometry, HemisphereLight,
  DirectionalLight, CanvasTexture, SRGBColorSpace, LinearFilter, Raycaster, Vector2,
  VSMShadowMap, Vector3,
} from 'three'
import { WebGPURenderer, MeshStandardNodeMaterial, MeshBasicNodeMaterial, PMREMGenerator } from 'three/webgpu'
import { Fn, uv, vec3, mix, smoothstep, length, vec2, float, viewportMipTexture } from 'three/tsl'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { createSlabGeometry } from './slab'
import { createGlass3DMaterial } from './glass'

const params = new URLSearchParams(location.search)
const forceWebGL = params.has('webgl')

const renderer = new WebGPURenderer({ antialias: true, forceWebGL })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = VSMShadowMap
document.body.appendChild(renderer.domElement)
await renderer.init()

const scene = new Scene()
const camera = new PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 50)
camera.position.set(0, 0.2, 7.2)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true

// environment for reflections
{
  const pmrem = new PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  scene.environmentIntensity = 0.5
}

// ---------- backdrop: lit pastel wall (receives shadows) + 3D objects ----------
{
  const wallMat = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 })
  wallMat.colorNode = Fn(() => {
    const q = uv()
    let c: any = mix(vec3(0.93, 0.90, 0.88), vec3(0.80, 0.84, 0.92), q.y)
    const blob = (cx: number, cy: number, rad: number, col: [number, number, number]) => {
      const d = length(q.sub(vec2(cx, cy)))
      c = mix(c, vec3(...col), float(1).sub(smoothstep(0, rad, d)).mul(0.85))
    }
    blob(0.15, 0.8, 0.45, [0.78, 0.70, 0.95])
    blob(0.85, 0.75, 0.40, [0.62, 0.86, 0.90])
    blob(0.70, 0.15, 0.45, [0.95, 0.72, 0.82])
    blob(0.25, 0.25, 0.35, [0.40, 0.38, 0.62])
    return c.mul(0.6)
  })()
  const wall = new Mesh(new PlaneGeometry(16, 11), wallMat)
  wall.position.z = -2.5
  wall.receiveShadow = true
  scene.add(wall)

  scene.add(new HemisphereLight(0xffffff, 0x8899bb, 0.35))
  const key = new DirectionalLight(0xffffff, 1.3)
  key.position.set(1.5, 4, 5)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.camera.left = -4; key.shadow.camera.right = 4
  key.shadow.camera.top = 4; key.shadow.camera.bottom = -4
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 14
  key.shadow.radius = 6
  key.shadow.blurSamples = 12
  key.shadow.bias = -0.0005
  key.shadow.intensity = 0.65
  scene.add(key)
  scene.add(key.target)

  const pastel = (hex: number) => new MeshStandardNodeMaterial({ color: new Color(hex), roughness: 0.35, metalness: 0.05 })
  const knot = new Mesh(new TorusKnotGeometry(0.55, 0.18, 160, 24), pastel(0x7a6cf0))
  knot.position.set(-2.4, 1.3, -1.7)
  const ball = new Mesh(new SphereGeometry(0.5, 48, 32), pastel(0xf2a35c))
  ball.position.set(1.7, -1.3, -0.7)
  const ico = new Mesh(new IcosahedronGeometry(0.45, 0), pastel(0x5fd3cf))
  ico.position.set(1.4, 1.6, -1.2)
  const objs = new Group()
  objs.add(knot, ball, ico)
  for (const o of objs.children) { o.castShadow = true; o.receiveShadow = true }
  scene.add(objs)
  ;(window as any).__objs = objs
}

// ---------- label helper (temporary Canvas2D text path) ----------
function label(text: string, opts: { size?: number; weight?: number; color?: string; width?: number; align?: CanvasTextAlign } = {}) {
  const size = opts.size ?? 0.16, weight = opts.weight ?? 600
  const pxPerUnit = 320
  const fontPx = size * pxPerUnit
  const cv = document.createElement('canvas')
  const ctx = cv.getContext('2d')!
  const font = `${weight} ${fontPx}px -apple-system, "SF Pro Text", "PingFang SC", system-ui, sans-serif`
  ctx.font = font
  const w = Math.ceil((opts.width ? opts.width * pxPerUnit : ctx.measureText(text).width + fontPx * 0.4))
  const h = Math.ceil(fontPx * 1.4)
  cv.width = w; cv.height = h
  ctx.font = font
  ctx.textBaseline = 'middle'
  ctx.textAlign = opts.align ?? 'center'
  ctx.fillStyle = opts.color ?? '#1c1c22'
  ctx.fillText(text, (opts.align ?? 'center') === 'left' ? fontPx * 0.2 : w / 2, h / 2)
  const tex = new CanvasTexture(cv)
  tex.colorSpace = SRGBColorSpace
  tex.minFilter = LinearFilter
  tex.generateMipmaps = false
  const mat = new MeshBasicNodeMaterial({ map: tex, transparent: true, depthWrite: false })
  return new Mesh(new PlaneGeometry(w / pxPerUnit, h / pxPerUnit), mat)
}

// ---------- glass UI: real slabs ----------
interface Item { mesh: Mesh; uniforms: ReturnType<typeof createGlass3DMaterial>['uniforms']; w: number; h: number; base: Vector3; pressT: number; hover: boolean; tiltX: number; tiltY: number }
const items: Item[] = []
;(window as any).__items = items

const panel = new Group()
panel.rotation.set(0, -0.28, 0)
scene.add(panel)

const panelBackdrop = viewportMipTexture()   // level 0: sees the world
const buttonBackdrop = viewportMipTexture()  // level 1: sees the panel too

function slab(parent: Object3D, w: number, h: number, x: number, y: number, z: number, o: {
  radius?: number; bezel?: number; thickness?: number; roughness?: number; tint?: Color; absorption?: number; dispersion?: number;
  backdrop?: ReturnType<typeof viewportMipTexture>; cornerExponent?: number; castShadow?: boolean; profile?: 'squircle' | 'circle'
} = {}) {
  const radius = o.radius ?? h / 2
  const cornerExponent = o.cornerExponent ?? (radius >= Math.min(w, h) / 2 - 1e-6 ? 2 : 4.5)
  const thickness = o.thickness ?? Math.min(w, h) * 0.09
  const bezel = o.bezel ?? Math.min(w, h) * 0.32
  const geo = createSlabGeometry({ width: w, height: h, radius, bezel, thickness, cornerExponent, profile: o.profile ?? 'circle' })
  const { material, uniforms } = createGlass3DMaterial({ thickness, roughness: o.roughness ?? 0.3, tint: o.tint, absorption: o.absorption ?? 0, dispersion: o.dispersion ?? 0.3, backdrop: o.backdrop ?? buttonBackdrop })
  const mesh = new Mesh(geo, material)
  mesh.position.set(x, y, z)
  mesh.castShadow = o.castShadow ?? true
  mesh.receiveShadow = true
  parent.add(mesh)
  const it: Item = { mesh, uniforms, w, h, base: new Vector3(x, y, z), pressT: 0, hover: false, tiltX: 0, tiltY: 0 }
  items.push(it)
  return { it, thickness }
}

const PW = 3.6, PH = 4.4
slab(panel, PW, PH, 0, 0, 0, { radius: 0.36, bezel: 0.30, thickness: 0.10, roughness: 0.8, backdrop: panelBackdrop, castShadow: true, profile: 'squircle' })
const PANEL_TOP = 0.10

const btn = (w: number, h: number, x: number, y: number, text: string, o: Parameters<typeof slab>[6] = {}, textColor = '#1c1c22') => {
  const { it, thickness } = slab(panel, w, h, x, y, PANEL_TOP + 0.06, { roughness: 0.12, ...o })
  if (text) {
    const l = label(text, { size: 0.14, color: textColor })
    l.position.set(0, 0, thickness + 0.004)   // local to the slab: moves with it
    l.renderOrder = 10
    it.mesh.add(l)
  }
  return it
}

const title = label('Liquid Glass', { size: 0.30, weight: 700, align: 'left', width: 2.6 })
title.position.set(-0.35, 1.72, PANEL_TOP + 0.004); title.renderOrder = 10; panel.add(title)
const sub = label('Search projects…', { size: 0.15, weight: 500, color: '#5a5a66', align: 'left', width: 2.6 })
sub.position.set(-0.35, 1.36, PANEL_TOP + 0.004); sub.renderOrder = 10; panel.add(sub)

btn(1.15, 0.46, -1.05, 0.75, 'Primary', { tint: new Color(0x6b63f5), absorption: 2.4, roughness: 0.3 }, '#ffffff')
btn(1.15, 0.46, 0.25, 0.75, 'Secondary', { tint: new Color(0x6ee7e0), absorption: 1.6, roughness: 0.25 })
btn(1.05, 0.46, -1.10, 0.10, 'Invite member')
btn(1.5, 0.46, 0.35, 0.10, 'Search projects…', { roughness: 0.15 }, '#4a4a58')
btn(1.9, 0.52, -0.65, -0.60, 'Create workspace…', { roughness: 0.3 }, '#2a2a33')
btn(0.9, 0.46, 0.95, -0.60, '', { tint: new Color(0x6b63f5), absorption: 2.4, roughness: 0.3 })
slab(panel, 0.36, 0.36, 0.95 + 0.2, -0.60, PANEL_TOP + 0.06 + 0.05, { roughness: 0.6, thickness: 0.05 })
const card = btn(1.5, 1.45, 0.35, -1.52, '', { radius: 0.3, bezel: 0.3, thickness: 0.07, roughness: 0.35, tint: new Color(0xb8a6f0), absorption: 0.8, profile: 'squircle' })
const cardText = label('Upgrade plan', { size: 0.14, color: '#2a2a33' })
cardText.position.set(0, -0.43, 0.07 + 0.004); cardText.renderOrder = 10; card.mesh.add(cardText)
slab(panel, 0.5, 0.5, 0.35, -1.35, PANEL_TOP + 0.06 + 0.07 + 0.02, { radius: 0.14, bezel: 0.16, thickness: 0.06, roughness: 0.55 })
slab(panel, 0.9, 0.9, -1.0, -1.55, PANEL_TOP + 0.06, { radius: 0.45, bezel: 0.3, thickness: 0.12, roughness: 0.03, dispersion: 0.8 })

// ---------- interaction: hover tilt + press (real transforms) ----------
const ray = new Raycaster()
const ndc = new Vector2()
let pressed: Item | null = null
function pick(e: PointerEvent) {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
  ray.setFromCamera(ndc, camera)
  const hits = ray.intersectObjects(items.map(i => i.mesh), false)
  for (const it of items) it.hover = false
  const hit = hits.find(h => h.object !== items[0].mesh)
  if (hit) {
    const it = items.find(i => i.mesh === hit.object)!
    it.hover = true
    const l = hit.uv!
    it.uniforms.touch.value.set(l.x - 0.5, l.y - 0.5)
    it.tiltX = -(l.y - 0.5) * 0.12
    it.tiltY = (l.x - 0.5) * 0.12
    return it
  }
  return null
}
renderer.domElement.addEventListener('pointermove', e => { pick(e) })
renderer.domElement.addEventListener('pointerdown', e => { pressed = pick(e); if (pressed) controls.enabled = false })
renderer.domElement.addEventListener('pointerup', () => { pressed = null; controls.enabled = true })

// ---------- loop ----------
const hud = document.getElementById('hud')!
let last = performance.now(), frames = 0, acc = 0
const spring = (cur: number, target: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-dt * 16))
renderer.setAnimationLoop(() => {
  const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now
  controls.update()
  const objs = (window as any).__objs as Group
  objs.rotation.y += dt * 0.25
  objs.children[0].rotation.x += dt * 0.4
  for (const it of items) {
    it.pressT = spring(it.pressT, it === pressed ? 1 : 0, dt)
    it.uniforms.press.value = it.pressT
    const hv = spring(it.mesh.userData.hv ?? 0, it.hover ? 1 : 0, dt); it.mesh.userData.hv = hv
    const s = 1 - it.pressT * 0.04
    it.mesh.scale.set(s, s, 1 - it.pressT * 0.3)
    it.mesh.rotation.set(it.tiltX * hv, it.tiltY * hv, 0)
    it.mesh.position.set(it.base.x, it.base.y, it.base.z + hv * 0.03 - it.pressT * 0.04)
  }
  renderer.render(scene, camera)
  frames++; acc += dt
  if (acc > 0.5) { hud.textContent = `${(renderer.backend as any).isWebGPUBackend ? 'WebGPU' : 'WebGL2'} backend · ${(frames / acc).toFixed(0)} fps · ${renderer.info.render.drawCalls} draws · ${renderer.info.render.triangles} tris · drag to orbit`; frames = 0; acc = 0 }
})

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})
