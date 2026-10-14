import { DataTexture, FloatType, HalfFloatType, LinearFilter, LinearSRGBColorSpace, NearestFilter, NoBlending, RenderTarget, RGBAFormat, Texture, UnsignedByteType, Vector2, Vector3, type Camera, type Object3D } from 'three'
import { MeshBasicNodeMaterial, QuadMesh, type Node, type Renderer, type TextureNode, type UniformNode } from 'three/webgpu'
import { dot, float, log2, max, mix, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl'
import { GlassUIError, type GlassInstance } from '@glassui/core'
import { SLAB_BEHIND } from './glass/frost'
import type { GlassMaterial, ScreenCapture } from './glass/material'
import type { RendererLike } from './surface/content'
import { surfaceToLocal, type SurfaceDims } from './units'

/** Spec §5.3: the time constant (s) of the backdrop luma's smoothing. */
export const LUMA_TAU = 0.2
/**
 * How long (frame time, s) the pass keeps running after the content RT last changed: 5τ, by when the smoothed luma is
 * within e^−5 ≈ 0.7 % of the new backdrop. Without it a change on a frame that is not followed by animation (an image
 * that loads, an edit) would move the luma by one step (1 − e^(−dt/τ), 8 % at 60 Hz) and leave it there.
 */
export const LUMA_SETTLE = 5 * LUMA_TAU

/** A glass element's footprint in content-RT uv (v = 0 at the top row), or in screen uv (v = 0 at the top). */
export interface LumaRect { u: number; v: number; w: number; h: number }

/** The coarse level a 3 × 3 tap grid over `rect` reads in a `size` texture: about 2 texels across (≥ 0). */
function gridLevel(rect: Node<'vec4'>, size: UniformNode<'vec2', Vector2>): Node<'float'> {
  // the floor of 1 keeps log2 off 0 (an unused texel's empty rect) and changes no level ≥ 0
  return max(log2(max(rect.z.mul(size.x), rect.w.mul(size.y), 1)).sub(1), 0)
}

/**
 * Spec §5.3 adaptive darkening's input: one texel per glass element holding the time-smoothed mean Rec. 709 luminance
 * of what the glass shows behind it. Texel `i` of a `maxCount × 1` half-float target averages 9 taps (a 3 × 3 grid of
 * cell centres) over content rect `i` at the content's mip level `log2(max(w·W, h·H)) − 1` (≥ 0; the rect is about 2
 * texels across there), then blends it with the previous result by `1 − e^(−dt/τ)`. Two targets ping-pong (no
 * compute); the first render after a `setRects` that changed the data writes through.
 *
 * A glass Surface's element glass shows what is behind its content plane where the content is transparent: the
 * premultiplied content plus `(1 − a)` × the slab capture, frosted as the slab frosts it (`SLAB_BEHIND`). Given that
 * capture (`render`'s `screen`), each tap adds it the same way, sampled at the matching tap of screen rect `i` (the
 * element's projected bbox, `setScreenRects`) at its grid level, never finer than the frost's. Without one the term is 0.
 *
 * The rects ride in one `maxCount × 2` float `DataTexture`: row 0 the content rects, row 1 the screen rects.
 */
export class LumaPass {
  readonly rectTexture: DataTexture
  private readonly rectData: Float32Array
  private readonly targets: [RenderTarget, RenderTarget]
  /** The target holding the latest result. */
  private current = 0
  private rects = 0
  private first = true
  private readonly material = new MeshBasicNodeMaterial()
  private readonly mesh: QuadMesh
  private readonly source: TextureNode
  private readonly previous: TextureNode
  private readonly screen: TextureNode
  /** The screen node's value without a capture: filterable as a capture copy is, so the kernel compiles the same. */
  private readonly noScreen: DataTexture
  private readonly blend = uniform(1)
  /** 1 with a screen capture, 0 without. */
  private readonly behind = uniform(0)
  private readonly sourceSize: UniformNode<'vec2', Vector2> = uniform(new Vector2(1, 1))
  private readonly screenSize: UniformNode<'vec2', Vector2> = uniform(new Vector2(1, 1))

  constructor(readonly maxCount = 256) {
    if (!Number.isInteger(maxCount) || maxCount < 1) throw new GlassUIError('LumaPass', `maxCount 必须是不小于 1 的整数，实际为 ${maxCount}`)
    this.rectData = new Float32Array(maxCount * 2 * 4)
    this.rectTexture = new DataTexture(this.rectData, maxCount, 2, RGBAFormat, FloatType)
    this.rectTexture.minFilter = NearestFilter; this.rectTexture.magFilter = NearestFilter
    const target = () => new RenderTarget(maxCount, 1, {
      format: RGBAFormat, type: HalfFloatType, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false, colorSpace: LinearSRGBColorSpace, depthBuffer: false,
    })
    this.targets = [target(), target()]
    this.noScreen = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat, UnsignedByteType)
    this.noScreen.minFilter = LinearFilter; this.noScreen.magFilter = LinearFilter; this.noScreen.needsUpdate = true

    // texel i's column; nearest reads land on texel i of each rect row and of the previous result
    const x = uv().x
    const r = texture(this.rectTexture, vec2(x, 0.25), float(0))              // row 0: u, v, w, h in content uv
    const sr = texture(this.rectTexture, vec2(x, 0.75), float(0))             // row 1: the same in screen uv
    this.previous = texture(this.targets[0].texture, vec2(x, 0.5), float(0))
    // a uv of their own: the taps (`.sample` clones, which follow the base's value) carry no uv-matrix uniform
    this.source = texture(new Texture(), uv(), float(0))
    this.screen = texture(this.noScreen, uv(), float(0))
    const lod = gridLevel(r, this.sourceSize)
    const screenLod = max(gridLevel(sr, this.screenSize), SLAB_BEHIND.level)
    let sum: Node<'float'> = float(0)
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const fx = (i + 0.5) / 3, fy = (j + 0.5) / 3
      const c = this.source.sample(vec2(r.x.add(r.z.mul(fx)), r.y.add(r.w.mul(fy)))).level(lod)
      const under = this.screen.sample(vec2(sr.x.add(sr.z.mul(fx)), sr.y.add(sr.w.mul(fy)))).level(screenLod).rgb
      // premultiplied content over the frosted screen, as the element glass composites them
      const seen = c.rgb.add(mix(under, vec3(1, 1, 1), SLAB_BEHIND.lift).mul(float(1).sub(c.a).mul(this.behind)))
      sum = sum.add(dot(seen, vec3(0.2126, 0.7152, 0.0722)))
    }
    const l = mix(this.previous.r, sum.div(9), this.blend)
    const m = this.material
    m.colorNode = vec4(l, l, l, 1)
    m.transparent = false; m.blending = NoBlending; m.depthTest = false; m.depthWrite = false; m.toneMapped = false
    this.mesh = new QuadMesh(m)
  }

  /** Rects packed by the last `setRects` (texels past it hold stale rects nobody reads). */
  get count(): number { return this.rects }
  /** The latest result: texel `i` = element `i`'s smoothed backdrop luma. A different texture after every `render`. */
  get texture(): Texture { return this.targets[this.current]!.texture }

  /** Packs content `rects` (texel `i` = rect `i`); when that changes the data, the next render writes through instead of blending. */
  setRects(rects: readonly LumaRect[]): void {
    if (this.pack('setRects', 0, rects)) { this.rects = rects.length; this.first = true }
  }

  /** Packs screen `rects` (texel `i`'s in screen uv); they follow the camera, so a change keeps the smoothing. */
  setScreenRects(rects: readonly LumaRect[]): void { this.pack('setScreenRects', 1, rects) }

  /** Writes `rects` into `row` (re-uploading only when it changed); true if it did. */
  private pack(scope: string, row: 0 | 1, rects: readonly LumaRect[]): boolean {
    if (rects.length > this.maxCount) throw new GlassUIError(`LumaPass.${scope}`, `${rects.length} 个矩形超过 maxCount（${this.maxCount}）`)
    const d = this.rectData, o = row * this.maxCount * 4
    let changed = row === 0 && rects.length !== this.rects
    rects.forEach((r, i) => {
      for (const [k, v] of [r.u, r.v, r.w, r.h].entries()) {
        const f = Math.fround(v)
        if (d[o + i * 4 + k] !== f) { d[o + i * 4 + k] = f; changed = true }
      }
    })
    if (changed) this.rectTexture.needsUpdate = true
    return changed
  }

  /**
   * Measures `source` (its image's size sets the mip level) and, with a `screen` capture copy (a glass Surface's, with
   * mips), the frosted screen behind it into the other target; restores the previous render target even when it throws.
   */
  render(renderer: RendererLike, source: Texture, dt: number, screen: Texture | null = null): void {
    const prev = renderer.getRenderTarget?.() ?? null
    const next = 1 - this.current
    this.source.value = source
    this.previous.value = this.targets[this.current]!.texture
    this.screen.value = screen ?? this.noScreen
    this.behind.value = screen ? 1 : 0
    const size = (t: Texture, v: Vector2) => { const img = t.image as { width?: number; height?: number } | null; v.set(img?.width ?? 1, img?.height ?? 1) }
    size(source, this.sourceSize.value); size(screen ?? this.noScreen, this.screenSize.value)
    this.blend.value = this.first ? 1 : 1 - Math.exp(-dt / LUMA_TAU)
    try {
      renderer.setRenderTarget(this.targets[next]!)
      this.mesh.render(renderer as unknown as Renderer)   // QuadMesh.render needs only `render(mesh, camera)`
    } finally { renderer.setRenderTarget(prev) }
    this.current = next; this.first = false
  }

  dispose(): void {
    for (const t of this.targets) t.dispose()
    this.rectTexture.dispose(); this.noScreen.dispose(); this.material.dispose()
  }
}

const adaptiveClear = (g: GlassInstance) => g.params.variant === 'clear' && g.params.adaptive

/** A glass Surface's view of what is behind its content plane. */
export interface LumaBehind {
  /** The slab's screen capture: its `latest` copy (the previous frame's screen behind the Surface) is read. */
  capture: ScreenCapture
  /** The camera the Surface is drawn with; its matrices current. */
  camera: Camera
  /** The content plane; its `matrixWorld` current. */
  plane: Object3D
}

/** One `SurfaceLuma.update`'s inputs. */
export interface LumaFrame {
  renderer: RendererLike
  /** The last render list's glass. */
  glass: readonly GlassInstance[]
  surface: SurfaceDims
  /** The content RT's texture. */
  content: Texture
  dt: number
  /** The content RT was redrawn this frame. */
  redrawn: boolean
  /** A glass Surface's (with a camera): what its element glass shows where the content is transparent. */
  behind?: LumaBehind
}

const corner = new Vector3()
/**
 * The screen-uv bbox (v = 0 at the top, as the glass's `screenUVOf`) of rect `r`'s four corners on the content plane,
 * clamped to the screen.
 */
export function screenRect(r: GlassInstance['rect'], s: SurfaceDims, { camera, plane }: Pick<LumaBehind, 'camera' | 'plane'>): LumaRect {
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity
  for (const [x, y] of [[r.x, r.y], [r.x + r.width, r.y], [r.x, r.y + r.height], [r.x + r.width, r.y + r.height]] as const) {
    const [lx, ly] = surfaceToLocal(x, y, s)
    corner.set(lx, ly, 0).applyMatrix4(plane.matrixWorld).project(camera)
    const u = (corner.x + 1) / 2, v = (1 - corner.y) / 2
    u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v)
  }
  const clamp = (t: number) => Math.min(1, Math.max(0, t))
  u0 = clamp(u0); v0 = clamp(v0)
  return { u: u0, v: v0, w: clamp(u1) - u0, h: clamp(v1) - v0 }
}

/**
 * A Surface's luma bookkeeping, so the Surface only forwards: the `LumaPass` (made on first need, doubled when the glass
 * outgrows it), its rects, when it runs, and pointing the element glass at its result.
 *
 * Rects: every glass instance's untransformed rect (non-adaptive ones too: the glass's luma index is its instance index,
 * read only for clear + adaptive glass), in the glass batch's instance order (`GlassBatch.update`'s stable sort by z),
 * in content uv: `(x/W, y/H, w/W, h/H)` for a `W × H` pt Surface. The content RT's v = 0 is its top row, as the glass
 * samples it (`planeUV`), and layout rects are y-down from the Surface's top, so no flip. With `behind`, also each
 * rect's projected screen bbox (`screenRect`), every frame.
 */
export class SurfaceLuma {
  private lumaPass: LumaPass | null = null
  private materials: readonly GlassMaterial[] = []
  /** The glass list and Surface size the content rects were packed from, and that list in instance order. */
  private glass: readonly GlassInstance[] | null = null
  private sorted: readonly GlassInstance[] = []
  private width = 0
  private height = 0
  /** Frame time left in the settle window (`LUMA_SETTLE`). */
  private settle = 0

  constructor(private readonly initialCount = 256) {}

  get pass(): LumaPass | null { return this.lumaPass }

  /**
   * The element glass to feed (after every glass rebuild: new materials start on 1×1 black, "never darken"); points
   * them at the current result at once. `count` is the texture's width (`maxCount`): the glass samples texel `i` at
   * `(i + ½) / count`.
   */
  attach(materials: readonly GlassMaterial[]): void {
    this.materials = materials
    this.feed()
  }

  /**
   * Each `prepare`, after the content pass, when any of `glass` is clear + adaptive. With `behind` it measures every
   * frame: the screen behind a glass Surface changes without any redraw (the host animates, the camera moves).
   * Otherwise only when the content was `redrawn` and on every frame for `LUMA_SETTLE` of frame time after it; never on
   * a quiet frame past that: its inputs (the content RT, the rects) have not changed since, and the smoothing has settled.
   */
  update(f: LumaFrame): void {
    this.settle = f.redrawn ? LUMA_SETTLE : this.settle - f.dt
    if (!(f.behind || this.settle > 0) || !f.glass.some(adaptiveClear)) return
    const pass = this.fit(f.glass.length), s = f.surface
    if (f.glass !== this.glass || s.width !== this.width || s.height !== this.height) {
      this.sorted = [...f.glass].sort((a, b) => a.z - b.z)
      pass.setRects(this.sorted.map(({ rect: r }) => ({ u: r.x / s.width, v: r.y / s.height, w: r.width / s.width, h: r.height / s.height })))
      this.glass = f.glass; this.width = s.width; this.height = s.height
    }
    const behind = f.behind
    if (behind) pass.setScreenRects(this.sorted.map(g => screenRect(g.rect, s, behind)))
    pass.render(f.renderer, f.content, f.dt, behind?.capture.latest ?? null)
    this.feed()
  }

  /** The pass, with room for `n` rects: a new one at double the capacity until it fits (the rects are packed anew). */
  private fit(n: number): LumaPass {
    const have = this.lumaPass
    if (have && have.maxCount >= n) return have
    let cap = have?.maxCount ?? this.initialCount
    while (cap < n) cap *= 2
    have?.dispose()
    this.glass = null
    return this.lumaPass = new LumaPass(cap)
  }

  private feed(): void {
    const pass = this.lumaPass
    if (pass) for (const m of this.materials) m.setLuma(pass.texture, pass.maxCount)
  }

  dispose(): void { this.lumaPass?.dispose(); this.lumaPass = null }
}
