// SPIKE (throwaway): scene harness for the liquid glass material.
// ?webgl forces the WebGL2 backend. Drag to orbit.

import {
  Scene, PerspectiveCamera, PlaneGeometry, Mesh, Group, Color, Object3D,
  TorusKnotGeometry, SphereGeometry, IcosahedronGeometry, HemisphereLight,
  DirectionalLight, CanvasTexture, SRGBColorSpace, LinearFilter, Raycaster, Vector2,
} from 'three'
import { WebGPURenderer, MeshStandardNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu'
import { Fn, uv, vec3, mix, smoothstep, length, vec2, float, viewportMipTexture } from 'three/tsl'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { createGlassMaterial, createShadowMaterial } from './glass'

const params = new URLSearchParams(location.search)
const forceWebGL = params.has('webgl')

const renderer = new WebGPURenderer({ antialias: true, forceWebGL })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)

const scene = new Scene()
const camera = new PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 50)
camera.position.set(0, 0.2, 7.2)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
controls.target.set(0, 0, 0)

// ---------- backdrop: procedural pastel wall + a few 3D objects ----------
{
  const wallMat = new MeshBasicNodeMaterial()
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
    // dark band to make refraction/dispersion visible
    const band = smoothstep(0.03, 0.0, length(vec2(q.x.sub(0.5), 0))).mul(0.0)
    return c.sub(band)
  })()
  const wall = new Mesh(new PlaneGeometry(16, 11), wallMat)
  wall.position.z = -2.5
  scene.add(wall)

  scene.add(new HemisphereLight(0xffffff, 0x8899bb, 1.2))
  const dir = new DirectionalLight(0xffffff, 2.0)
  dir.position.set(2, 4, 3)
  scene.add(dir)

  const pastel = (hex: number) => new MeshStandardNodeMaterial({ color: new Color(hex), roughness: 0.35, metalness: 0.05 })
  const knot = new Mesh(new TorusKnotGeometry(0.55, 0.18, 160, 24), pastel(0x7a6cf0))
  knot.position.set(-2.4, 1.3, -1.7)
  const ball = new Mesh(new SphereGeometry(0.5, 48, 32), pastel(0xf2a35c))
  ball.position.set(1.7, -1.3, -0.7)
  const ico = new Mesh(new IcosahedronGeometry(0.45, 0), pastel(0x5fd3cf))
  ico.position.set(1.4, 1.6, -1.2)
  const objs = new Group()
  objs.add(knot, ball, ico)
  scene.add(objs)
  ;(window as any).__objs = objs
}

// ---------- label helper: Canvas2D text → texture quad (temporary text path) ----------
function label(text: string, opts: { size?: number; weight?: number; color?: string; width?: number; align?: CanvasTextAlign } = {}) {
  const size = opts.size ?? 0.16, weight = opts.weight ?? 600
  const pxPerUnit = 320
  const fontPx = size * pxPerUnit
  const cv = document.createElement('canvas')
  const ctx = cv.getContext('2d')!
  ctx.font = `${weight} ${fontPx}px -apple-system, "SF Pro Text", "PingFang SC", system-ui, sans-serif`
  const w = Math.ceil((opts.width ? opts.width * pxPerUnit : ctx.measureText(text).width + fontPx * 0.4))
  const h = Math.ceil(fontPx * 1.4)
  cv.width = w; cv.height = h
  ctx.font = `${weight} ${fontPx}px -apple-system, "SF Pro Text", "PingFang SC", system-ui, sans-serif`
  ctx.textBaseline = 'middle'
  ctx.textAlign = opts.align ?? 'center'
  ctx.fillStyle = opts.color ?? '#1c1c22'
  const x = (opts.align ?? 'center') === 'left' ? fontPx * 0.2 : w / 2
  ctx.fillText(text, x, h / 2)
  const tex = new CanvasTexture(cv)
  tex.colorSpace = SRGBColorSpace
  tex.minFilter = LinearFilter
  tex.generateMipmaps = false
  const mat = new MeshBasicNodeMaterial({ map: tex, transparent: true, depthWrite: false })
  const m = new Mesh(new PlaneGeometry(w / pxPerUnit, h / pxPerUnit), mat)
  return m
}

// ---------- glass UI ----------
interface GlassItem { mesh: Mesh; uniforms: ReturnType<typeof createGlassMaterial>['uniforms']; w: number; h: number; pressT: number; hover: boolean }
const items: GlassItem[] = []
;(window as any).__items = items

function glassQuad(parent: Object3D, w: number, h: number, x: number, y: number, z: number, opts: Partial<Parameters<typeof createGlassMaterial>[0]> & { shadow?: boolean } = {}) {
  const { shadow = true, ...rest } = opts
  const radius = rest.radius ?? h / 2
  const cornerExponent = rest.cornerExponent ?? (radius >= Math.min(w, h) / 2 - 1e-6 ? 2 : 4.5)
  const { material, uniforms } = createGlassMaterial({ width: w, height: h, radius, cornerExponent, ...rest })
  const mesh = new Mesh(new PlaneGeometry(w, h), material)
  mesh.position.set(x, y, z)
  parent.add(mesh)
  if (shadow) {
    const s1 = createShadowMaterial({ width: w, height: h, radius, cornerExponent, sigma: 0.05, alpha: 0.18, pad: 0.2 })
    const sh1 = new Mesh(new PlaneGeometry(...s1.quadSize), s1.material)
    sh1.position.set(x, y - 0.03, z - 0.012)
    parent.add(sh1)
    const s2 = createShadowMaterial({ width: w, height: h, radius, cornerExponent, sigma: 0.28, alpha: 0.10, pad: 0.9 })
    const sh2 = new Mesh(new PlaneGeometry(...s2.quadSize), s2.material)
    sh2.position.set(x, y - 0.12, z - 0.013)
    parent.add(sh2)
  }
  const item: GlassItem = { mesh, uniforms, w, h, pressT: 0, hover: false }
  items.push(item)
  return item
}

const panel = new Group()
panel.position.set(0, 0, 0)
panel.rotation.set(0, -0.28, 0)
scene.add(panel)

// backdrop capture shared by the panel (level 0 of the stack)
const panelBackdrop = viewportMipTexture()
const PW = 3.6, PH = 4.4
glassQuad(panel, PW, PH, 0, 0, 0, { radius: 0.36, bezel: 0.22, thickness: 0.10, frost: 0.75, brightness: 0.14, backdrop: panelBackdrop })

// a second capture node, updated when the first button draws → buttons see the panel glass
const buttonBackdrop = viewportMipTexture()
const btn = (w: number, h: number, x: number, y: number, text: string, extra: Partial<Parameters<typeof createGlassMaterial>[0]> = {}, textColor = '#1c1c22') => {
  const it = glassQuad(panel, w, h, x, y, 0.06, { bezel: h * 0.34, thickness: 0.045, frost: 0.25, backdrop: buttonBackdrop, ...extra })
  it.mesh.renderOrder = 2
  const l = label(text, { size: 0.14, color: textColor })
  l.position.set(x, y, 0.075)
  l.renderOrder = 3
  panel.add(l)
  return it
}

const title = label('Liquid Glass', { size: 0.30, weight: 700, align: 'left', width: 2.6 })
title.position.set(-0.3 - 0.05, 1.72, 0.07); title.renderOrder = 3; panel.add(title)
const sub = label('Search projects…', { size: 0.15, weight: 500, color: '#5a5a66', align: 'left', width: 2.6 })
sub.position.set(-0.35, 1.36, 0.07); sub.renderOrder = 3; panel.add(sub)

btn(1.15, 0.46, -1.05, 0.75, 'Primary', { tint: new Color(0x6b63f5), tintStrength: 0.9, frost: 0.4 }, '#ffffff')
btn(1.15, 0.46, 0.25, 0.75, 'Secondary', { tint: new Color(0x6ee7e0), tintStrength: 0.65 })
btn(1.05, 0.46, -1.10, 0.10, 'Invite member')
btn(1.5, 0.46, 0.35, 0.10, 'Search projects…', { frost: 0.15, brightness: 0.06 }, '#4a4a58')
btn(1.9, 0.52, -0.65, -0.60, 'Create workspace…', { frost: 0.3 }, '#2a2a33')
// a toggle: pill + knob
const toggle = btn(0.9, 0.46, 0.95, -0.60, '', { tint: new Color(0x6b63f5), tintStrength: 0.85 })
const knob = glassQuad(panel, 0.36, 0.36, 0.95 + 0.2, -0.60, 0.11, { radius: 0.18, bezel: 0.13, thickness: 0.04, frost: 0.1, brightness: 0.5, backdrop: buttonBackdrop, shadow: true })
knob.mesh.renderOrder = 3
// a tall card
const card = btn(1.5, 1.45, 0.35, -1.52, '', { radius: 0.3, bezel: 0.26, thickness: 0.06, frost: 0.45, tint: new Color(0xb8a6f0), tintStrength: 0.35 })
const cardText = label('Upgrade plan', { size: 0.14, color: '#2a2a33' })
cardText.position.set(0.35, -1.95, 0.075); cardText.renderOrder = 3; panel.add(cardText)
const check = glassQuad(panel, 0.5, 0.5, 0.35, -1.35, 0.11, { radius: 0.14, bezel: 0.15, thickness: 0.04, frost: 0.2, brightness: 0.45, backdrop: buttonBackdrop })
check.mesh.renderOrder = 3
const ring = glassQuad(panel, 0.9, 0.9, -1.0, -1.55, 0.06, { radius: 0.45, bezel: 0.40, thickness: 0.09, frost: 0.2, dispersion: 0.06, backdrop: buttonBackdrop })
ring.mesh.renderOrder = 2
void card; void toggle

// ---------- interaction: hover/press via raycast ----------
const ray = new Raycaster()
const ndc = new Vector2()
let pressed: GlassItem | null = null
function pick(e: PointerEvent) {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
  ray.setFromCamera(ndc, camera)
  const hits = ray.intersectObjects(items.map(i => i.mesh), false)
  for (const it of items) it.hover = false
  const hit = hits.find(h => (h.object as Mesh) !== items[0].mesh)
  if (hit) {
    const it = items.find(i => i.mesh === hit.object)!
    it.hover = true
    const l = hit.uv!
    it.uniforms.touch.value.set((l.x - 0.5) * it.w, (l.y - 0.5) * it.h)
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
function spring(cur: number, target: number, dt: number) { return cur + (target - cur) * (1 - Math.exp(-dt * 18)) }
renderer.setAnimationLoop(() => {
  const now = performance.now(), dt = Math.min(0.05, (now - last) / 1000); last = now
  controls.update()
  const objs = (window as any).__objs as Group
  objs.rotation.y += dt * 0.25
  objs.children[0].rotation.x += dt * 0.4
  for (const it of items) {
    it.pressT = spring(it.pressT, it === pressed ? 1 : 0, dt)
    it.uniforms.press.value = it.pressT
    it.uniforms.hover.value = spring(it.uniforms.hover.value, it.hover ? 1 : 0, dt)
    const s = 1 - it.pressT * 0.04
    it.mesh.scale.set(s, s, 1)
  }
  renderer.render(scene, camera)
  frames++; acc += dt
  if (acc > 0.5) { hud.textContent = `${(renderer.backend as any).isWebGPUBackend ? 'WebGPU' : 'WebGL2'} backend · ${(frames / acc).toFixed(0)} fps · ${renderer.info.render.drawCalls} draws · drag to orbit`; frames = 0; acc = 0 }
})

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})
