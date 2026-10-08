// SPIKE: real-3D glass UI, layout reproduced from the reference screenshot.
// Reference is 1024×1280; panel ≈ 885×1045 px centred at (512, 642). 1 unit ≈ 244 px.
// ?webgl forces the WebGL2 backend. Drag to orbit.

import {
  Scene, PerspectiveCamera, PlaneGeometry, Mesh, Group, Color, Object3D,
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
  radius?: number; fillet?: number; filletBottom?: number; bezel?: number; thickness?: number; profile?: 'fillet' | 'squircle' | 'circle'; edgeGlow?: number; twoSided?: boolean; innerGlow?: { color: Color; strength: number; split?: number; softness?: number }; rim?: number
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
const WHITE: SlabOpts = { roughness: 0.06, scatter: 0.05, diffuse: 0.5, lift: 0.10, env: 2.2, iridescence: 0.5, dispersion: 0.8, specularRoughness: 0.07, edgeGlow: 0.8, twoSided: true, thickness: U(16), fillet: U(5), filletBottom: U(3), dispersion: 1.0 }
const BLUE = new Color(0x6b63f5)
const GLOWING = (color: Color, strength = 0.7, split?: number, softness?: number): SlabOpts => ({ tint: color.clone().lerp(new Color(1, 1, 1), 0.15), absorption: 1.4, innerGlow: { color, strength, split, softness }, roughness: 0.1, scatter: 0.06, diffuse: 0.4, lift: 0.0, env: 1.6, iridescence: 0, dispersion: 0.6, specularRoughness: 0.08, edgeGlow: 0.5, twoSided: true, thickness: U(16), fillet: U(5), filletBottom: U(3) })
const TINTED = (tint: Color, absorption: number, solid = false): SlabOpts => ({ tint, absorption, roughness: solid ? 0.5 : 0.15, scatter: solid ? 0.6 : 0.1, diffuse: solid ? 0.8 : 0.5, env: 1.5, iridescence: 0, dispersion: 0.6, specularRoughness: 0.1, edgeGlow: 0.4, twoSided: !solid, thickness: U(16), fillet: U(5), filletBottom: solid ? 0 : U(3) })

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

// ---------- sign-up form (reference coordinate system: 1024 px wide, panel 885×1045 centred at 512,642) ----------
const INK = '#1c1c22', MUTED = '#6a6a78', HINT = '#8a8a98'
put(PANEL.mesh, label('Create your account', { size: U(44), weight: 700, align: 'left' }), 122 - 512, 192 - 642, TOP)
put(PANEL.mesh, label('Start your 14-day free trial. No credit card needed.', { size: U(22), weight: 500, color: MUTED, align: 'left' }), 122 - 512, 240 - 642, TOP)
{
  const close = pill(52, 52, 878, 200, { scatter: 0.5 })
  put(close.mesh, icon('x', U(24), '#4a4a58'), 0, 0, close.thickness)
}
// inputs: full width 760 px, centre x = 502
const input = (cy: number, iconName: IconName, placeholder: string, trailing?: IconName) => {
  const f = pill(760, 84, 502, cy)
  const L = 122, R = 882, PAD = 26, ICON = 28, GAP = 14
  put(f.mesh, icon(iconName, U(ICON), HINT, 0.1), L + PAD + ICON / 2 - 502, 0, f.thickness)
  put(f.mesh, label(placeholder, { size: U(23), weight: 500, color: HINT, align: 'left' }), L + PAD + ICON + GAP - 502, 0, f.thickness)
  if (trailing) put(f.mesh, icon(trailing, U(ICON), HINT, 0.1), R - PAD - ICON / 2 - 502, 0, f.thickness)
  return f
}
input(345, 'user', 'Full name')
input(455, 'mail', 'Email address')
input(565, 'lock', 'Password', 'eye')
// terms: crystal checkbox button + text on the panel; remember-me toggle right-aligned with the inputs
{
  const L = 122, R = 882
  const cb = pill(44, 44, L + 22, 680, { radius: U(12), thickness: U(14), fillet: U(4), filletBottom: U(2) })
  put(cb.mesh, icon('check', U(30), '#6b63f5', 0.14), 0, 0, cb.thickness)
  put(PANEL.mesh, label('I agree to the Terms & Privacy', { size: U(21), weight: 500, color: '#3a3a48', align: 'left' }), L + 44 + 16 - 512, 680 - 642, TOP)
  const TW = 136, TH = 62, KNOB = 48
  const tcx = R - TW / 2
  const KNOB_X = TW / 2 - 7 - KNOB / 2
  const tg = pill(TW, TH, tcx, 680, GLOWING(BLUE, 1.1, 0.5 + KNOB_X / TW, 0.012))
  put(tg.mesh, circle(U(KNOB), '#ffffff', { shadow: 0.014 }), KNOB_X, 0, tg.thickness)
  const lbl = label('Remember me', { size: U(20), weight: 500, color: '#3a3a48' })
  const lblW = lbl.geometry.parameters.width / U(1)
  put(PANEL.mesh, lbl, tcx - TW / 2 - 16 - lblW / 2 - 512, 680 - 642, TOP)
}
// primary action
{
  const go = pill(760, 84, 502, 795, GLOWING(BLUE, 1.15))
  put(go.mesh, label('Create account', { size: U(25), weight: 700, color: '#ffffff' }), -20, 0, go.thickness)
  put(go.mesh, icon('arrow-right', U(28), '#ffffff', 0.12), 104, 0, go.thickness)
}
put(PANEL.mesh, label('or continue with', { size: U(19), weight: 500, color: HINT }), 0, 878 - 642, TOP)
// social sign-in
{
  const apple = pill(365, 78, 312, 955)
  put(apple.mesh, icon('apple', U(30), INK), -48, 0, apple.thickness)
  put(apple.mesh, label('Apple', { size: U(23), color: INK }), 16, 0, apple.thickness)
  const google = pill(365, 78, 692, 955)
  put(google.mesh, icon('google', U(30), INK, 0.12), -56, 0, google.thickness)
  put(google.mesh, label('Google', { size: U(23), color: INK }), 14, 0, google.thickness)
}
put(PANEL.mesh, label('Already have an account?', { size: U(20), weight: 500, color: MUTED }), -60, 1072 - 642, TOP)
put(PANEL.mesh, label('Sign in', { size: U(20), weight: 700, color: '#5b52f0' }), 112, 1072 - 642, TOP)

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
