import { DataTexture, FloatType, HalfFloatType, LinearFilter, LinearSRGBColorSpace, NearestFilter, NoBlending, RenderTarget, RGBAFormat, Texture, UnsignedByteType, Vector2, type Camera, type Object3D } from 'three'
import { MeshBasicNodeMaterial, QuadMesh, type Node, type Renderer, type TextureNode, type UniformNode } from 'three/webgpu'
import { dot, float, log2, max, min, mix, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl'
import { GlassUIError, type GlassInstance } from '@glassui/core'
import { SLAB_BEHIND } from './glass/frost'
import type { GlassMaterial, ScreenCapture } from './glass/material'
import type { RendererLike } from './surface/content'
import { surfaceToLocal, type SurfaceDims } from './units'
import { projectPolygon } from './project'

/** Spec §5.3: the time constant (s) of the backdrop luma's smoothing. */
export const LUMA_TAU = 0.2
/**
 * How long (frame time, s) the pass keeps running after the content RT last changed: 5τ, by when the smoothed luma is
 * within e^−5 ≈ 0.7 % of the new backdrop. Without it a change on a frame that is not followed by animation (an image
 * that loads, an edit) would move the luma by one step (1 − e^(−dt/τ), 8 % at 60 Hz) and leave it there.
 */
export const LUMA_SETTLE = 5 * LUMA_TAU

/** How element glass sees the capture behind its content plane: its mip level (a floor for the pass) and lift toward white. */
export interface LumaFrost { readonly level: number; readonly lift: number }

/** A glass element's footprint in content-RT uv (v = 0 at the top row), or in screen uv (v = 0 at the top). */
export interface LumaRect { u: number; v: number; w: number; h: number }

/**
 * The level a 3 × 3 tap grid over `rect` reads in a `size` texture, from the rect's SHORT side `s` (texels): a texel of
 * `s/6`, so each tap's trilinear footprint (about ±1 texel) spans its own third of the short side and stays inside the
 * rect. (A texel of `s/3` reaches half a third past the edge from the outer taps; one sized by the long side, far past
 * it: an elongated rect's taps would average what surrounds it.) The long side is under-sampled instead.
 */
function gridLevel(rect: Node<'vec4'>, size: UniformNode<'vec2', Vector2>): Node<'float'> {
  // log2(max(x, 1)) = max(log2 x, 0); it also keeps log2 off 0 (an unused texel's empty rect)
  return log2(max(min(rect.z.mul(size.x), rect.w.mul(size.y)).div(6), 1))
}

/**
 * Spec §5.3 adaptive darkening's input: one texel per glass element holding the time-smoothed mean Rec. 709 luminance
 * of what the glass shows behind it. Texel `i` of a `maxCount × 1` half-float target averages 9 taps (a 3 × 3 grid of
 * cell centres) over content rect `i` at the content's mip level `max(log2(min(w·W, h·H) / 6), 0)` (`gridLevel`),
 * then blends it with the previous result by `1 − e^(−dt/τ)`. Two targets ping-pong (no compute); the first render
 * after a `setRects` that changed the data writes through.
 *
 * Element glass on a glass or `'none'` Surface shows what is behind its content plane where the content is
 * transparent: the premultiplied content plus `(1 − a)` × the capture of it, frosted as the glass sees it (`LumaFrost`:
 * through the slab's frost, `SLAB_BEHIND`, on a glass Surface; unfrosted on a `'none'` one). Given that capture
 * (`render`'s `screen`) and its frost, each tap adds it the same way, sampled at the matching tap of screen rect `i`
 * (the element's projected bbox, `setScreenRects`) at its grid level, never finer than the frost's. Without one the
 * term is 0.
 *
 * The rects ride in one `maxCount × 2` float `DataTexture`: row 0 the content rects, row 1 the screen rects. The pass is
 * a full-screen triangle drawn with `NoBlending`: it writes every texel of its target, so it needs no clear, whatever
 * the host's `renderer.autoClear`.
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
  /** The screen's frost (`LumaFrost`): the floor of its taps' level, and its lift. */
  private readonly frostLevel = uniform(SLAB_BEHIND.level)
  private readonly frostLift = uniform(SLAB_BEHIND.lift)
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
    const screenLod = max(gridLevel(sr, this.screenSize), this.frostLevel)
    let sum: Node<'float'> = float(0)
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const fx = (i + 0.5) / 3, fy = (j + 0.5) / 3
      const c = this.source.sample(vec2(r.x.add(r.z.mul(fx)), r.y.add(r.w.mul(fy)))).level(lod)
      const under = this.screen.sample(vec2(sr.x.add(sr.z.mul(fx)), sr.y.add(sr.w.mul(fy)))).level(screenLod).rgb
      // premultiplied content over the frosted screen, as the element glass composites them
      const seen = c.rgb.add(mix(under, vec3(1, 1, 1), this.frostLift).mul(float(1).sub(c.a).mul(this.behind)))
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

  /**
   * Writes `rects` into `row` (re-uploading only when it changed); true if it did. A non-finite number is written as 0:
   * the kernel's smoothing blends with its previous result, so one NaN reaching the GPU would never wash out.
   */
  private pack(scope: string, row: 0 | 1, rects: readonly LumaRect[]): boolean {
    if (rects.length > this.maxCount) throw new GlassUIError(`LumaPass.${scope}`, `${rects.length} 个矩形超过 maxCount（${this.maxCount}）`)
    const d = this.rectData, o = row * this.maxCount * 4
    let changed = row === 0 && rects.length !== this.rects
    rects.forEach((r, i) => {
      for (const [k, v] of [r.u, r.v, r.w, r.h].entries()) {
        const f = Number.isFinite(v) ? Math.fround(v) : 0
        if (d[o + i * 4 + k] !== f) { d[o + i * 4 + k] = f; changed = true }
      }
    })
    if (changed) this.rectTexture.needsUpdate = true
    return changed
  }

  /**
   * Measures `source` (its image's size sets the mip level) and, with a `screen` capture copy (with mips), the screen
   * behind it seen through `frost` (default the slab's) into the other target; restores the previous render target even
   * when it throws.
   */
  render(renderer: RendererLike, source: Texture, dt: number, screen: Texture | null = null, frost: LumaFrost = SLAB_BEHIND): void {
    const prev = renderer.getRenderTarget?.() ?? null
    const next = 1 - this.current
    this.source.value = source
    this.previous.value = this.targets[this.current]!.texture
    this.screen.value = screen ?? this.noScreen
    this.behind.value = screen ? 1 : 0
    this.frostLevel.value = frost.level; this.frostLift.value = frost.lift
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

/** A glass or `'none'` Surface's view of what is behind its content plane. */
export interface LumaBehind {
  /** The slab's screen capture, or a `'none'` Surface's behind-capture: its `latest` copy (the previous frame's screen behind the Surface) is read. */
  capture: ScreenCapture
  /** The camera the Surface is drawn with; its matrices current. */
  camera: Camera
  /** The content plane; its `matrixWorld` current. */
  plane: Object3D
  /** How the element glass sees the capture; default the slab's frost (`SLAB_BEHIND`). */
  frost?: LumaFrost
}

/** One `SurfaceLuma.update`'s inputs. */
export interface LumaFrame {
  renderer: RendererLike
  /** The last render list's glass. */
  glass: readonly GlassInstance[]
  /**
   * Glass drawn by other batches (fused slabs: one instance each over its shapes' bounds), in their luma order: texel
   * `glass.length + j` is `extra[j]`'s, after the element glass's (`GlassBatch.update`'s `lumaBase`). Default none.
   */
  extra?: readonly GlassInstance[]
  surface: SurfaceDims
  /** The content RT's texture. */
  content: Texture
  dt: number
  /** The content RT was redrawn this frame. */
  redrawn: boolean
  /** A glass or `'none'` Surface's (with a camera and a capture): what its element glass shows where the content is transparent. */
  behind?: LumaBehind
}

const NO_GLASS: readonly GlassInstance[] = Object.freeze([])

/** The zero rect: what an element wholly behind the camera measures (a defined value, read by no visible glass). */
const NO_RECT: LumaRect = Object.freeze({ u: 0, v: 0, w: 0, h: 0 })
/**
 * The screen-uv bbox (v = 0 at the top, as the glass's `screenUVOf`) of rect `r`'s four corners on the content plane,
 * clamped to the screen. Projected by `projectPolygon`, so a rect through the camera plane never mirrors (it reaches
 * the screen edge toward the camera) and one wholly behind the camera is `NO_RECT`; never a non-finite number.
 */
export function screenRect(r: GlassInstance['rect'], s: SurfaceDims, { camera, plane }: Pick<LumaBehind, 'camera' | 'plane'>): LumaRect {
  const corners = ([[r.x, r.y], [r.x + r.width, r.y], [r.x + r.width, r.y + r.height], [r.x, r.y + r.height]] as const).map(([x, y]) => surfaceToLocal(x, y, s))
  const b = projectPolygon(corners, plane.matrixWorld, camera)
  if (!b) return NO_RECT
  const clamp = (t: number) => Math.min(1, Math.max(0, t))
  const u0 = clamp((b.minX + 1) / 2), u1 = clamp((b.maxX + 1) / 2), v0 = clamp((1 - b.maxY) / 2), v1 = clamp((1 - b.minY) / 2)
  return { u: u0, v: v0, w: u1 - u0, h: v1 - v0 }
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
  private extra: readonly GlassInstance[] | null = null
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
   * frame: the screen behind a glass or 'none' Surface changes without any redraw (the host animates, the camera moves).
   * Otherwise only when the content was `redrawn` and on every frame for `LUMA_SETTLE` of frame time after it; never on
   * a quiet frame past that: its inputs (the content RT, the rects) have not changed since, and the smoothing has settled.
   */
  update(f: LumaFrame): void {
    this.settle = f.redrawn ? LUMA_SETTLE : this.settle - f.dt
    const extra = f.extra ?? NO_GLASS
    if (!(f.behind || this.settle > 0) || !(f.glass.some(adaptiveClear) || extra.some(adaptiveClear))) return
    const pass = this.fit(f.glass.length + extra.length), s = f.surface
    if (f.glass !== this.glass || extra !== this.extra || s.width !== this.width || s.height !== this.height) {
      this.sorted = [...f.glass].sort((a, b) => a.z - b.z).concat(extra)
      pass.setRects(this.sorted.map(({ rect: r }) => ({ u: r.x / s.width, v: r.y / s.height, w: r.width / s.width, h: r.height / s.height })))
      this.glass = f.glass; this.extra = extra; this.width = s.width; this.height = s.height
    }
    const behind = f.behind
    if (behind) pass.setScreenRects(this.sorted.map(g => screenRect(g.rect, s, behind)))
    pass.render(f.renderer, f.content, f.dt, behind?.capture.latest ?? null, behind?.frost ?? SLAB_BEHIND)
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
