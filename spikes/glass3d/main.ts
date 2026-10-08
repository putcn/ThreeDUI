// SPIKE: real-3D glass UI, layout reproduced from the reference screenshot.
// Reference is 1024×1280; panel ≈ 885×1045 px centred at (512, 642). 1 unit ≈ 244 px.
// ?webgl forces the WebGL2 backend. Drag to orbit.

import {
  Scene, PerspectiveCamera, PlaneGeometry, Mesh, Group, Color, Object3D, TorusGeometry,
  HemisphereLight, DirectionalLight, Raycaster, Vector2, VSMShadowMap, Vector3, BackSide,
} from 'three'
import { WebGPURenderer, MeshStandardNodeMaterial, PMREMGenerator } from 'three/webgpu'
import { Fn, uv, vec3, mix, smoothstep, length, vec2, float, viewportMipTexture, reflector } from 'three/tsl'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { createSlabGeometry } from './slab'
import { createGlass3DMaterial } from './glass'
import { createStudioScene } from './studio'
import { label, icon, roundedRect, circle, glow, rimDecal, type IconName } from './text'

const params = new URLSearchParams(location.search)
const forceWebGL = params.has('webgl')

const renderer = new WebGPURenderer({ antialias: true, forceWebGL })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
renderer.shadowMap.enabled = true
renderer.shadowMap.type = VSMShadowMap
renderer.shadowMap.transmitted = true
document.body.appendChild(renderer.domElement)
await renderer.init()

const scene = new Scene()
const camera = new PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 50)
camera.position.set(0, 0.55, 7.3)
camera.lookAt(0, -0.05, 0)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true

{
  const pmrem = new PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(createStudioScene(), 0.02).texture
  scene.environmentIntensity = 0.45
}

// ---------- backdrop: soft wall, no shadows on it ----------
let key!: DirectionalLight
{
  const wallMat = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 })
  wallMat.colorNode = Fn(() => {
    const q = uv()
    let c: any = mix(vec3(0.90, 0.86, 0.84), vec3(0.80, 0.84, 0.92), q.y)
    const blob = (cx: number, cy: number, rad: number, col: [number, number, number], a = 0.85) => {
      const d = length(q.sub(vec2(cx, cy)))
      c = mix(c, vec3(...col), float(1).sub(smoothstep(0, rad, d)).mul(a))
    }
    blob(0.18, 0.90, 0.45, [0.98, 0.95, 0.90])
    blob(0.86, 0.80, 0.40, [0.72, 0.88, 0.92])
    blob(0.78, 0.12, 0.45, [0.96, 0.78, 0.86])
    blob(0.18, 0.18, 0.42, [0.42, 0.40, 0.62])
    blob(0.55, 0.55, 0.30, [0.84, 0.80, 0.95], 0.5)
    // diagonal light beam across the wall (as in the reference) so refraction has gradients to bend
    const beam = q.x.mul(0.55).add(q.y.mul(0.85))
    c = mix(c, vec3(1.0, 0.98, 0.95), smoothstep(0.55, 0.75, beam).mul(float(1).sub(smoothstep(0.95, 1.2, beam))).mul(0.8))
    c = mix(c, vec3(0.30, 0.28, 0.36), smoothstep(0.45, 0.2, beam).mul(0.6))
    const vign = float(1).sub(smoothstep(0.4, 1.0, length(q.sub(vec2(0.45, 0.62))).mul(0.9)))
    return c.mul(0.95).mul(float(0.8).add(vign.mul(0.25)))
  })()
  const wall = new Mesh(new PlaneGeometry(16, 11), wallMat)
  wall.position.z = -2.5
  scene.add(wall)

  scene.add(new HemisphereLight(0xffffff, 0x8899bb, 0.65))
  key = new DirectionalLight(0xffffff, 1.8)
  key.position.set(-0.9, 3.0, 5.0)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.camera.left = -4; key.shadow.camera.right = 4
  key.shadow.camera.top = 4; key.shadow.camera.bottom = -4
  key.shadow.camera.near = 0.5; key.shadow.camera.far = 14
  key.shadow.radius = 7
  key.shadow.blurSamples = 16
  key.shadow.bias = -0.0005
  key.shadow.intensity = 0.55
  scene.add(key)
  scene.add(key.target)
}

// ---------- glass primitives ----------
interface Item { mesh: Mesh; uniforms: ReturnType<typeof createGlass3DMaterial>['uniforms']; base: Vector3; pressT: number; hover: boolean; tiltX: number; tiltY: number; interactive: boolean }
const items: Item[] = []
;(window as any).__items = items

const panel = new Group()
scene.add(panel)

const panelBackdrop = viewportMipTexture()   // sees the world
const buttonBackdrop = viewportMipTexture()  // sees the panel (used by back faces)
const frontBackdrop = viewportMipTexture()   // sees panel + back faces (used by front faces)

type SlabOpts = {
  radius?: number; fillet?: number; filletBottom?: number; bezel?: number; thickness?: number; profile?: 'fillet' | 'squircle' | 'circle'; edgeGlow?: number; twoSided?: boolean; innerGlow?: { color: Color; strength: number; split?: number }; rim?: number
  roughness?: number; scatter?: number; diffuse?: number; lift?: number; env?: number; specularRoughness?: number
  tint?: Color; absorption?: number; dispersion?: number; iridescence?: number; backdrop?: ReturnType<typeof viewportMipTexture>
  cornerExponent?: number; castShadow?: boolean; shadowOpacity?: number; interactive?: boolean; reflection?: { node: any; strength: number }
}
function slab(parent: Object3D, w: number, h: number, x: number, y: number, z: number, o: SlabOpts = {}) {
  const radius = o.radius ?? h / 2
  const cornerExponent = o.cornerExponent ?? (radius >= Math.min(w, h) / 2 - 1e-6 ? 2 : 4.5)
  const thickness = o.thickness ?? Math.min(w, h) * 0.22
  const fillet = o.fillet ?? thickness * 0.45
  const filletBottom = o.filletBottom ?? (o.twoSided ? thickness * 0.3 : 0)
  const geo = createSlabGeometry({ width: w, height: h, radius, thickness, fillet, filletBottom, bezel: o.bezel, cornerExponent, profile: o.profile ?? 'fillet' })
  const matOpts = {
    thickness, roughness: o.roughness ?? 0.3, scatter: o.scatter, diffuse: o.diffuse, lift: o.lift, envIntensity: o.env, specularRoughness: o.specularRoughness,
    tint: o.tint, absorption: o.absorption ?? 0, dispersion: o.dispersion ?? 0.3, iridescence: o.iridescence, edgeGlow: o.edgeGlow, innerGlow: o.innerGlow,
    shadowOpacity: o.shadowOpacity, reflection: o.reflection,
  }
  const { material, uniforms } = createGlass3DMaterial({ ...matOpts, backdrop: o.backdrop ?? (o.twoSided ? frontBackdrop : buttonBackdrop) })
  const mesh = new Mesh(geo, material)
  mesh.position.set(x, y, z)
  mesh.castShadow = o.castShadow ?? true
  mesh.receiveShadow = true
  mesh.renderOrder = o.twoSided ? 2 : 1
  parent.add(mesh)
  if (o.twoSided) {
    // back faces first: inner edges reflect/refract, front faces then sample a backdrop that includes them
    const back = new Mesh(geo, createGlass3DMaterial({ ...matOpts, side: BackSide, backdrop: buttonBackdrop, reflection: undefined }).material)
    back.renderOrder = 1
    back.castShadow = false
    mesh.add(back)
  }
  const it: Item = { mesh, uniforms, base: new Vector3(x, y, z), pressT: 0, hover: false, tiltX: 0, tiltY: 0, interactive: o.interactive ?? true }
  items.push(it)
  return { mesh, thickness, it }
}

// reference px → panel units
const U = (px: number) => px / 244
const X = (px: number) => (px - 512) / 244
const Y = (py: number) => (642 - py) / 244

// ---------- panel: frosted, slightly glossy, reflects what sits on it ----------
const refl = reflector({ resolutionScale: 0.5, generateMipmaps: true, bounces: false })
const PANEL = slab(panel, U(885), U(1045), 0, 0, 0, {
  radius: U(48), thickness: 0.10, fillet: 0.03, profile: 'fillet',
  roughness: 0.4, scatter: 0.12, diffuse: 1.0, lift: 0.07, specularRoughness: 0.3, env: 1.0, iridescence: 0.15, edgeGlow: 0.3,
  backdrop: panelBackdrop, castShadow: false, interactive: false,
  reflection: { node: refl.level(2.5), strength: 0.18 },
})
refl.target.position.z = PANEL.thickness          // mirror plane = panel top surface (+Z)
PANEL.mesh.add(refl.target)
const TOP = 0.10
const LIFT = 0.04

// style presets (measured from the reference)
const WHITE: SlabOpts = { roughness: 0.06, scatter: 0.05, diffuse: 0.5, lift: 0.10, env: 2.2, iridescence: 0.5, dispersion: 0.8, specularRoughness: 0.07, edgeGlow: 0.8, twoSided: true, thickness: U(18), fillet: U(10), filletBottom: U(6), dispersion: 1.0 }
const BLUE = new Color(0x6b63f5), CYAN = new Color(0x74e2dc), LAVENDER = new Color(0xc2b3f3), ORANGE = '#f2a340'
const GLOWING = (color: Color, strength = 0.7, split?: number): SlabOpts => ({ tint: color.clone().lerp(new Color(1, 1, 1), 0.15), absorption: 1.4, innerGlow: { color, strength, split }, roughness: 0.1, scatter: 0.06, diffuse: 0.4, lift: 0.0, env: 1.6, iridescence: 0, dispersion: 0.6, specularRoughness: 0.08, edgeGlow: 0.5, twoSided: true, thickness: U(18), fillet: U(10), filletBottom: U(6) })
const TINTED = (tint: Color, absorption: number, solid = false): SlabOpts => ({ tint, absorption, roughness: solid ? 0.5 : 0.15, scatter: solid ? 0.6 : 0.1, diffuse: solid ? 0.8 : 0.5, env: 1.5, iridescence: 0, dispersion: 0.6, specularRoughness: 0.1, edgeGlow: 0.4, twoSided: !solid, thickness: U(18), fillet: U(10), filletBottom: solid ? 0 : U(6) })

function pill(w: number, h: number, cx: number, cy: number, o: SlabOpts = {}, z = TOP + LIFT) {
  const opts = { ...WHITE, ...o }
  const col = opts.tint ? '#' + opts.tint.getHexString() : '#ffffff'
  const g = glow(U(w + 24), U(h + 28), col, opts.tint ? 0.5 : 0.28)
  g.position.set(X(cx), Y(cy + 9), TOP + 0.003)
  panel.add(g)
  const r = slab(panel, U(w), U(h), X(cx), Y(cy), z, opts)
  put(r.mesh, rimDecal(U(w), U(h), opts.radius ?? U(h) / 2, opts.rim ?? 1), 0, 0, r.thickness, 0.002)
  return r
}
/** place a flat quad on a slab's top surface; dx/dy in reference px relative to the slab centre */
function put(parent: Mesh, m: Mesh, dx: number, dy: number, thickness: number, lift = 0.004) {
  m.position.set(U(dx), U(-dy), thickness + lift)
  parent.add(m)
  return m
}
/** flat checkbox box: white rounded square with a soft shadow and a check */
function checkbox(parent: Mesh, size: number, dx: number, dy: number, thickness: number, checkColor: string) {
  put(parent, roundedRect(U(size), U(size), U(size * 0.22), '#ffffff', { shadow: 0.012, edge: 'rgba(0,0,0,0.06)' }), dx, dy, thickness)
  put(parent, icon('check', U(size * 0.72), checkColor, 0.13), dx, dy, thickness, 0.006)
}

// header
put(PANEL.mesh, label('Liquid Glass', { size: U(46), weight: 700, align: 'left' }), 122 - 512, 190 - 642, TOP)
put(PANEL.mesh, label('Search projects…', { size: U(24), weight: 500, color: '#6a6a78', align: 'left' }), 122 - 512, 237 - 642, TOP)
for (const [cx, name] of [[806, 'arrow-left'], [878, 'plus']] as [number, IconName][]) {
  const b = pill(52, 52, cx, 200, { scatter: 0.5 })
  put(b.mesh, icon(name, U(26), '#4a4a58'), 0, 0, b.thickness)
}
// row 1
{
  const p = pill(214, 80, 229, 350, GLOWING(BLUE, 1.1))
  put(p.mesh, label('Primary', { size: U(24), color: '#ffffff' }), 0, 0, p.thickness)
  const s = pill(216, 80, 490, 350, GLOWING(CYAN, 0.9))
  put(s.mesh, label('Secondary', { size: U(24), color: '#1c2a2a' }), 0, 0, s.thickness)
  const q = pill(255, 86, 778, 356)
  put(q.mesh, label('Search projects…', { size: U(22), weight: 500, color: '#3a3a48' }), 0, 0, q.thickness)
  put(q.mesh, circle(U(14), '#5fd6d0'), 870 - 778, 328 - 356, q.thickness)
}
// row 2
{
  const c = pill(476, 78, 360, 508)
  put(c.mesh, label('Create workspace…', { size: U(24), color: '#1c1c22' }), -60, 0, c.thickness)
  put(c.mesh, circle(U(64), '#6b63f5', { shadow: 0.012 }), 552 - 360, 0, c.thickness, 0.004)
  put(c.mesh, icon('search', U(30), '#ffffff', 0.11), 552 - 360, 0, c.thickness, 0.006)
  const sel = pill(255, 78, 778, 513)
  put(sel.mesh, label('Select', { size: U(24), color: '#1c1c22' }), -55, 0, sel.thickness)
  put(sel.mesh, icon('arrow-right', U(30), '#1c1c22'), 865 - 778, 0, sel.thickness)
}
// row 3
{
  const f = pill(220, 76, 232, 650)
  checkbox(f.mesh, 40, 160 - 232, 0, f.thickness, '#6b63f5')
  put(f.mesh, label('field', { size: U(22), weight: 500, color: '#3a3a48' }), 222 - 232, 0, f.thickness)
  const t = pill(210, 76, 493, 650)
  checkbox(t.mesh, 40, 428 - 493, 0, t.thickness, '#1c1c22')
  put(t.mesh, label('text', { size: U(22), weight: 500, color: '#3a3a48' }), 530 - 493, 0, t.thickness)
  const modal = pill(255, 78, 778, 690)
  put(modal.mesh, label('Modal', { size: U(24), color: '#1c1c22' }), 720 - 778, 0, modal.thickness)
  put(modal.mesh, roundedRect(U(72), U(50), U(25), '#dfe3ea', { shadow: 0.012, edge: 'rgba(0,0,0,0.06)' }), 858 - 778, 0, modal.thickness, 0.004)
  put(modal.mesh, icon('menu', U(30), '#3a3a48'), 858 - 778, 0, modal.thickness, 0.006)
}
// row 4
{
  const sw = pill(220, 76, 232, 780)
  put(sw.mesh, icon('arrow-right', U(30), '#1c1c22'), 160 - 232, 0, sw.thickness)
  put(sw.mesh, label('switch', { size: U(22), weight: 500, color: '#3a3a48' }), 225 - 232, 0, sw.thickness)
  put(sw.mesh, circle(U(36), '#ffffff', { alpha: 0.55, edge: 'rgba(0,0,0,0.08)' }), 305 - 232, 0, sw.thickness)
  const inv = pill(210, 76, 493, 780)
  put(inv.mesh, label('Invite member', { size: U(23), color: '#1c1c22' }), 0, 0, inv.thickness)
}
// card
{
  const card = pill(250, 300, 780, 950, { ...GLOWING(LAVENDER, 0.7), radius: U(34), thickness: U(16), fillet: U(8), filletBottom: U(5) })
  put(card.mesh, label('Plan details', { size: U(16), weight: 600, color: '#5a5470', align: 'left' }), 690 - 780, 835 - 950, card.thickness)
  put(card.mesh, roundedRect(U(75), U(75), U(16), '#ffffff', { shadow: 0.02, edge: 'rgba(0,0,0,0.05)' }), 0, 940 - 950, card.thickness)
  put(card.mesh, icon('check', U(50), '#6b63f5', 0.13), 0, 940 - 950, card.thickness, 0.006)
  const up = slab(card.mesh, U(200), U(52), 0, U(-(1057 - 950)), card.thickness + 0.005, { ...WHITE, twoSided: false, thickness: 0.03, scatter: 0.9, diffuse: 1.1, lift: 0.25, iridescence: 0, edgeGlow: 0.1 })
  put(up.mesh, label('Upgrade plan', { size: U(22), color: '#1c1c22' }), 0, 0, up.thickness)
}
// ring (3D glass torus) + flat tile inside
{
  const { material } = createGlass3DMaterial({ thickness: U(36), roughness: 0.02, scatter: 0.0, dispersion: 1, iridescence: 1.0, envIntensity: 2.6, tint: new Color(0xe4d8ff), absorption: 0.35, edgeGlow: 0.6, backdrop: frontBackdrop })
  const ring = new Mesh(new TorusGeometry(U(96), U(18), 24, 128), material)
  ring.position.set(X(230), Y(985), TOP + LIFT + U(18))
  ring.castShadow = true; ring.receiveShadow = true
  panel.add(ring)
  put(PANEL.mesh, roundedRect(U(70), U(70), U(16), '#ffffff', { shadow: 0.02, edge: 'rgba(0,0,0,0.05)' }), 230 - 512, 985 - 642, TOP)
  put(PANEL.mesh, icon('check', U(44), '#1c1c22', 0.13), 230 - 512, 985 - 642, TOP, 0.006)
}
// toggle (3D track, flat knob) + output
{
  const tg = pill(210, 70, 490, 920, GLOWING(BLUE, 1.1, 0.58))
  put(tg.mesh, circle(U(60), ORANGE, { shadow: 0.015 }), 497 - 490, 0, tg.thickness)
  const out = pill(210, 70, 490, 1058)
  put(out.mesh, label('Output', { size: U(22), weight: 500, color: '#3a3a48' }), 455 - 490, 0, out.thickness)
  put(out.mesh, icon('x', U(28), '#3a3a48'), 562 - 490, 0, out.thickness)
}

// ---------- interaction: hover tilt + press (real transforms) ----------
const ray = new Raycaster()
const ndc = new Vector2()
let pressed: Item | null = null
const interactive = () => items.filter(i => i.interactive)
function pick(e: PointerEvent) {
  ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1)
  ray.setFromCamera(ndc, camera)
  const hits = ray.intersectObjects(interactive().map(i => i.mesh), false)
  for (const it of items) it.hover = false
  const hit = hits[0]
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
  for (const it of items) {
    if (!it.interactive) continue
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
;(window as any).__dbg = { scene, key, refl }
