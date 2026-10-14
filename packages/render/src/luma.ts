import { DataTexture, FloatType, LinearSRGBColorSpace, NearestFilter, NoBlending, RenderTarget, RGBAFormat, Texture, UnsignedByteType, Vector2 } from 'three'
import { MeshBasicNodeMaterial, QuadMesh, type Node, type Renderer, type TextureNode, type UniformNode } from 'three/webgpu'
import { dot, float, log2, max, mix, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl'
import { GlassUIError, type GlassInstance } from '@glassui/core'
import type { GlassMaterial } from './glass/material'
import type { RendererLike } from './surface/content'

/** Spec §5.3: the time constant (s) of the backdrop luma's smoothing. */
export const LUMA_TAU = 0.2
/**
 * How long (frame time, s) the pass keeps running after the content RT last changed: 5τ, by when the smoothed luma is
 * within e^−5 ≈ 0.7 % of the new backdrop. Without it a change on a frame that is not followed by animation (an image
 * that loads, an edit) would move the luma by one step (1 − e^(−dt/τ), 8 % at 60 Hz) and leave it there.
 */
export const LUMA_SETTLE = 5 * LUMA_TAU

/** A glass element's footprint in content-RT uv (v = 0 at the top row). */
export interface LumaRect { u: number; v: number; w: number; h: number }

/**
 * Spec §5.3 adaptive darkening's input: one texel per glass element holding the time-smoothed mean Rec. 709 luminance
 * of the content behind it. Texel `i` of a `maxCount × 1` RGBA8 target averages 9 taps (a 3 × 3 grid of cell centres)
 * over rect `i` (a `maxCount × 1` float `DataTexture` carries the rects) at the source mip level
 * `log2(max(w·W, h·H)) − 1` (≥ 0; the rect is about 2 texels across there), then blends it with the previous result by
 * `1 − e^(−dt/τ)`. Two targets ping-pong (no compute); the first render after a `setRects` that changed the data writes
 * through.
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
  private readonly blend = uniform(1)
  private readonly sourceSize: UniformNode<'vec2', Vector2> = uniform(new Vector2(1, 1))

  constructor(readonly maxCount = 256) {
    if (!Number.isInteger(maxCount) || maxCount < 1) throw new GlassUIError('LumaPass', `maxCount 必须是不小于 1 的整数，实际为 ${maxCount}`)
    this.rectData = new Float32Array(maxCount * 4)
    this.rectTexture = new DataTexture(this.rectData, maxCount, 1, RGBAFormat, FloatType)
    this.rectTexture.minFilter = NearestFilter; this.rectTexture.magFilter = NearestFilter
    const target = () => new RenderTarget(maxCount, 1, {
      format: RGBAFormat, type: UnsignedByteType, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false, colorSpace: LinearSRGBColorSpace, depthBuffer: false,
    })
    this.targets = [target(), target()]

    // texel i's row position; nearest reads land on texel i of the rect texture and of the previous result
    const at = vec2(uv().x, 0.5)
    const r = texture(this.rectTexture, at, float(0))                          // u, v, w, h of this texel's element
    this.previous = texture(this.targets[0].texture, at, float(0))
    // a uv of its own: the taps (its `.sample` clones, which follow its value) carry no uv-matrix uniform
    this.source = texture(new Texture(), uv(), float(0))
    // the floor of 1 keeps log2 off 0 (an unused texel's empty rect) and changes no level ≥ 0
    const lod = max(log2(max(r.z.mul(this.sourceSize.x), r.w.mul(this.sourceSize.y), 1)).sub(1), 0)
    let sum: Node<'float'> = float(0)
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
      const p = vec2(r.x.add(r.z.mul((i + 0.5) / 3)), r.y.add(r.w.mul((j + 0.5) / 3)))
      sum = sum.add(dot(this.source.sample(p).level(lod).rgb, vec3(0.2126, 0.7152, 0.0722)))
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

  /** Packs `rects` (texel `i` = rect `i`); when that changes the data, the next render writes through instead of blending. */
  setRects(rects: readonly LumaRect[]): void {
    if (rects.length > this.maxCount) throw new GlassUIError('LumaPass.setRects', `${rects.length} 个矩形超过 maxCount（${this.maxCount}）`)
    const d = this.rectData
    let changed = rects.length !== this.rects
    rects.forEach((r, i) => {
      for (const [k, v] of [r.u, r.v, r.w, r.h].entries()) {
        const f = Math.fround(v)
        if (d[i * 4 + k] !== f) { d[i * 4 + k] = f; changed = true }
      }
    })
    if (!changed) return
    this.rects = rects.length
    this.rectTexture.needsUpdate = true
    this.first = true
  }

  /** Measures `source` (its image's size sets the mip level) into the other target; restores the previous render target even when it throws. */
  render(renderer: RendererLike, source: Texture, dt: number): void {
    const prev = renderer.getRenderTarget?.() ?? null
    const next = 1 - this.current
    this.source.value = source
    this.previous.value = this.targets[this.current]!.texture
    const img = source.image as { width?: number; height?: number } | null
    this.sourceSize.value.set(img?.width ?? 1, img?.height ?? 1)
    this.blend.value = this.first ? 1 : 1 - Math.exp(-dt / LUMA_TAU)
    try {
      renderer.setRenderTarget(this.targets[next]!)
      this.mesh.render(renderer as unknown as Renderer)   // QuadMesh.render needs only `render(mesh, camera)`
    } finally { renderer.setRenderTarget(prev) }
    this.current = next; this.first = false
  }

  dispose(): void {
    for (const t of this.targets) t.dispose()
    this.rectTexture.dispose(); this.material.dispose()
  }
}

const adaptiveClear = (g: GlassInstance) => g.params.variant === 'clear' && g.params.adaptive

/**
 * A Surface's luma bookkeeping, so the Surface only forwards: the `LumaPass` (made on first need, doubled when the glass
 * outgrows it), its rects, when it runs, and pointing the element glass at its result.
 *
 * Rects: every glass instance's untransformed rect (non-adaptive ones too: the glass's luma index is its instance index,
 * read only for clear + adaptive glass), in the glass batch's instance order (`GlassBatch.update`'s stable sort by z),
 * in content uv: `(x/W, y/H, w/W, h/H)` for a `W × H` pt Surface. The content RT's v = 0 is its top row, as the glass
 * samples it (`planeUV`), and layout rects are y-down from the Surface's top, so no flip.
 */
export class SurfaceLuma {
  private lumaPass: LumaPass | null = null
  private materials: readonly GlassMaterial[] = []
  /** The glass list and Surface size the rects were packed from. */
  private glass: readonly GlassInstance[] | null = null
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
   * Each `prepare`, after the content pass: when any of `glass` is clear + adaptive, measures `source` when the content
   * was `redrawn` and on every frame for `LUMA_SETTLE` of frame time after it; never on a quiet frame past that: its
   * inputs (the content RT, the rects) have not changed since, and the smoothing has settled.
   */
  update(renderer: RendererLike, glass: readonly GlassInstance[], size: { width: number; height: number }, source: Texture, dt: number, redrawn: boolean): void {
    this.settle = redrawn ? LUMA_SETTLE : this.settle - dt
    if (this.settle <= 0 || !glass.some(adaptiveClear)) return
    const pass = this.fit(glass.length)
    if (glass !== this.glass || size.width !== this.width || size.height !== this.height) {
      const { width: W, height: H } = size
      pass.setRects([...glass].sort((a, b) => a.z - b.z).map(({ rect: r }) => ({ u: r.x / W, v: r.y / H, w: r.width / W, h: r.height / H })))
      this.glass = glass; this.width = W; this.height = H
    }
    pass.render(renderer, source, dt)
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
