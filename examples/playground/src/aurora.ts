import { BackSide, LinearFilter, LinearSRGBColorSpace, OrthographicCamera, PlaneGeometry, RGBAFormat, RenderTarget, Scene, SphereGeometry, Vector2, Vector3, type Mesh as ThreeMesh } from 'three'
import { Mesh, MeshBasicNodeMaterial, type Node, type Renderer } from 'three/webgpu'
import { abs, dot, floor, fract, float, length, mix, sin, smoothstep, texture, uniform, uv, vec2, vec3 } from 'three/tsl'

export const AURORA = { rt: [512, 256] as const, octaves: 3, speed: 0.12, strength: 0.26, rate: 15, frozenTime: 20, lighten: 0.08 } as const

export interface AuroraDome {
  readonly mesh: ThreeMesh
  update(renderer: Renderer, nowSec: number, mode: 'live' | 'frozen' | 'reduced'): boolean
  dispose(): void
}

type RGB = readonly [number, number, number]
const hash = (p: Node<'vec2'>) => fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453))
function noise(p: Node<'vec2'>) {
  const i = floor(p), f = fract(p), u = f.mul(f).mul(float(3).sub(f.mul(2)))
  const a = hash(i), b = hash(i.add(vec2(1, 0))), c = hash(i.add(vec2(0, 1))), d = hash(i.add(vec2(1, 1)))
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y)
}
function fbm(p: Node<'vec2'>) {
  let value: Node<'float'> = float(0), weight = 0.5, q: Node<'vec2'> = p
  for (let i = 0; i < AURORA.octaves; i++) { value = value.add(noise(q).mul(weight)); q = q.mul(2).add(vec2(13.7, 7.1)); weight *= 0.5 }
  return value
}
function basePastel(q: ReturnType<typeof uv>) {
  let c = mix(vec3(0.56, 0.62, 0.72), vec3(0.61, 0.67, 0.78), q.y)
  const blob = (cx: number, cy: number, radius: number, color: RGB, alpha = 0.85) => {
    const d = length(q.sub(vec2(cx, cy)))
    c = mix(c, vec3(...color), float(1).sub(smoothstep(0, radius, d)).mul(alpha))
  }
  blob(0.18, 0.90, 0.45, [0.91, 0.89, 0.94], 0.44)
  blob(0.86, 0.80, 0.40, [0.74, 0.88, 0.91], 0.55)
  blob(0.78, 0.12, 0.45, [0.86, 0.80, 0.91], 0.34)
  blob(0.55, 0.55, 0.30, [0.80, 0.78, 0.94], 0.38)
  const beam = q.x.mul(0.55).add(q.y.mul(0.85))
  c = mix(c, vec3(0.96, 0.96, 0.99), smoothstep(0.55, 0.75, beam).mul(float(1).sub(smoothstep(0.95, 1.2, beam))).mul(0.20))
  return mix(c, vec3(1), AURORA.lighten)
}

function baseNight(q: ReturnType<typeof uv>) {
  let c = mix(vec3(0.006, 0.017, 0.034), vec3(0.018, 0.042, 0.067), q.y)
  const horizon = float(1).sub(smoothstep(0.1, 0.49, q.y)).mul(0.42)
  c = mix(c, vec3(0.035, 0.071, 0.086), horizon)
  const distantGlow = float(1).sub(smoothstep(0.0, 0.42, length(q.sub(vec2(0.62, 0.54)))))
  return mix(c, vec3(0.055, 0.074, 0.12), distantGlow.mul(0.16))
}

function auroraMaterial(scheme: 'light' | 'dark') {
  const time = uniform(0), material = new MeshBasicNodeMaterial(), q = uv()
  let c = scheme === 'dark' ? baseNight(q) : basePastel(q)
  const bands: readonly { y: number; width: number; seed: number; color: RGB }[] = scheme === 'dark' ? [] : [
    { y: 0.54, width: 0.10, seed: 1.7, color: [0.62, 0.88, 0.96] },
    { y: 0.69, width: 0.08, seed: 8.2, color: [0.80, 0.74, 0.98] },
    { y: 0.78, width: 0.10, seed: 15.4, color: [0.99, 0.87, 0.74] },
  ]
  for (const band of bands) {
    const p = vec2(q.x.mul(2.8).add(band.seed), q.y.mul(2.4).add(band.seed * 0.37))
    const t = time.mul(AURORA.speed), n = fbm(p.add(vec2(t.mul(0.32), t.mul(0.055))))
    const filament = noise(vec2(q.x.mul(52).add(band.seed), q.y.mul(1.8).add(t.mul(0.18)))).mul(0.12)
    const centre = float(band.y).add(n.sub(0.5).mul(0.18)).add(filament.sub(0.06))
    const d = abs(q.y.sub(centre)), body = float(1).sub(smoothstep(band.width * 0.25, band.width, d))
    const veil = float(1).sub(smoothstep(band.width * 1.1, band.width * 2.2, d)).mul(0.24)
    const strength = body.add(veil).mul(scheme === 'dark' ? 0.14 : AURORA.strength).mul(float(0.45).add(n.mul(0.55)))
    c = mix(c, vec3(...band.color), strength)
  }
  material.colorNode = c
  material.toneMapped = false
  return { material, time }
}

export function createAuroraDome(opts: { center: [number, number, number]; radius: number; yaw: [number, number]; pitch: [number, number]; scheme?: 'light' | 'dark'; size?: [number, number] }): AuroraDome {
  const size = opts.size ?? AURORA.rt
  const target = new RenderTarget(size[0], size[1], { format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false, colorSpace: LinearSRGBColorSpace, depthBuffer: false, stencilBuffer: false })
  const pass = auroraMaterial(opts.scheme ?? 'light'), quad = new Mesh(new PlaneGeometry(2, 2), pass.material)
  const passScene = new Scene(); passScene.add(quad)
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 2); camera.position.z = 1
  const mapMaterial = new MeshBasicNodeMaterial()
  mapMaterial.colorNode = texture(target.texture, uv()).rgb
  mapMaterial.side = BackSide; mapMaterial.fog = false; mapMaterial.toneMapped = false
  // SphereGeometry's x/z convention makes yaw = 3π/2 − φ (yaw 0 points along −z).
  const phiStart = 3 * Math.PI / 2 - opts.yaw[1], phiLength = opts.yaw[1] - opts.yaw[0]
  const thetaStart = Math.PI / 2 - opts.pitch[1], thetaLength = opts.pitch[1] - opts.pitch[0]
  const geometry = new SphereGeometry(opts.radius, Math.max(32, Math.ceil(phiLength * 128)), Math.max(16, Math.ceil(thetaLength * 128)), phiStart, phiLength, thetaStart, thetaLength)
  const mesh = new Mesh(geometry, mapMaterial)
  mesh.position.set(...opts.center); mesh.castShadow = false; mesh.receiveShadow = false; mesh.name = 'aurora-dome'
  let renderedAt = -Infinity, lastMode: 'live' | 'frozen' | 'reduced' | undefined
  const update = (renderer: Renderer, nowSec: number, mode: 'live' | 'frozen' | 'reduced'): boolean => {
    const changedMode = mode !== lastMode
    if (mode === 'live' && renderedAt !== -Infinity && nowSec - renderedAt < 1 / AURORA.rate) return false
    if (mode !== 'live' && !changedMode) return false
    pass.time.value = mode === 'frozen' ? AURORA.frozenTime : nowSec
    const previous = renderer.getRenderTarget()
    try { renderer.setRenderTarget(target); renderer.render(passScene, camera) }
    finally { renderer.setRenderTarget(previous) }
    renderedAt = nowSec; lastMode = mode
    return true
  }
  return { mesh, update, dispose: () => { geometry.dispose(); mapMaterial.dispose(); target.dispose(); pass.material.dispose(); quad.geometry.dispose() } }
}
