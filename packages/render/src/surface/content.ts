import { Color, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, LinearSRGBColorSpace, OrthographicCamera, RenderTarget, RGBAFormat, Scene, UnsignedByteType, type Camera, type Object3D, type Texture } from 'three'
import type { SurfaceDims } from '../units'

/** RT pixels for a Surface projected to `projectedPx` CSS px: integer steps avoid per-frame jitter; never 0; capped. */
export function contentRTSize(projectedPx: { width: number; height: number }, dpr: number, opts: { cap?: number; step?: number; scale?: number } = {}): { width: number; height: number } {
  const { cap = 4096, step = 64, scale = 1 } = opts
  const fit = (v: number) => { const px = v * dpr * scale; if (!(px > 0)) return 1; return Math.max(1, Math.min(cap, Math.ceil(px / step) * step)) }
  return { width: fit(projectedPx.width), height: fit(projectedPx.height) }
}

/** Frames a Surface and the camera must hold still before its content RT shrinks to what it needs (`rtTarget`). */
export const RT_SETTLE_FRAMES = 30

/**
 * The content RT's next size, per axis, from the size it `have`s and the size it `need`s (`contentRTSize`; spatial spec
 * §2.1): a `fresh` RT (the Surface's first `prepare`) gets exactly `need`; a growth gets `need` × 1.25 rounded up to
 * `step` (at most `cap`), so a Surface flying closer re-allocates at most once per 25 % instead of every step; a
 * shrink waits until `settled` (`RT_SETTLE_FRAMES` still frames), then goes to exactly `need`; otherwise `have` stays.
 */
export function rtTarget(have: { width: number; height: number }, need: { width: number; height: number }, opts: { settled: boolean; fresh: boolean; step?: number; cap?: number }): { width: number; height: number } {
  const { settled, fresh, step = 64, cap = 4096 } = opts
  const axis = (h: number, n: number): number =>
    fresh || n === h ? n : n > h ? Math.min(cap, Math.ceil(n * 1.25 / step) * step) : settled ? n : h
  return { width: axis(have.width, need.width), height: axis(have.height, need.height) }
}

/** The subset of `WebGPURenderer` the render passes call (so tests can pass a stub). */
export interface RendererLike {
  setRenderTarget(rt: RenderTarget | null): void
  getRenderTarget?(): RenderTarget | null
  render(scene: Object3D, camera: Camera): unknown
  setClearColor?(color: Color | number, alpha?: number): void
  getClearColor?(target: Color): Color
  getClearAlpha?(): number
  /** three clears a target at the start of a `render` only while these are true (`ContentPass` sets them for its own call). */
  autoClear?: boolean
  autoClearColor?: boolean
}

type AutoClear = Pick<RendererLike, 'autoClear' | 'autoClearColor'>
/** Sets `renderer`'s colour auto-clear for one call and puts the host's flags back (a flag it lacked stays absent). */
function withAutoClear<T>(renderer: AutoClear, fn: () => T): T {
  const had = { clear: renderer.autoClear, color: renderer.autoClearColor }
  renderer.autoClear = true; renderer.autoClearColor = true
  try { return fn() } finally {
    if (had.clear === undefined) delete renderer.autoClear; else renderer.autoClear = had.clear
    if (had.color === undefined) delete renderer.autoClearColor; else renderer.autoClearColor = had.color
  }
}

/**
 * Spec §5.6 step 2: the Surface's non-glass content, drawn orthographically in Surface-local units into a mipmapped RT.
 * Premultiplied by construction: transparent clears are (0,0,0) at alpha 0, colour backgrounds clear at alpha 1; panels,
 * shadows, glyphs and images blend over it (alpha One/OneMinusSrcAlpha), pools add colour with "over" coverage;
 * composite it premultiplied.
 */
export class ContentPass {
  readonly scene = new Scene()
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, -10, 10)
  readonly target: RenderTarget
  private prevColor = new Color()
  constructor(opts: { type?: 'byte' | 'half' } = {}) {
    this.target = new RenderTarget(1, 1, {
      format: RGBAFormat, type: opts.type === 'half' ? HalfFloatType : UnsignedByteType,
      generateMipmaps: true, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter, colorSpace: LinearSRGBColorSpace, depthBuffer: false,
    })
  }
  get texture(): Texture { return this.target.texture }
  /** The target's size in texels. */
  get width(): number { return this.target.width }
  get height(): number { return this.target.height }

  /**
   * Switches the texel type (a quality change). The texture stays the same object, so materials keep sampling it; the
   * target is disposed so the backend re-allocates it, in the new type, at its next render. True if it changed.
   */
  setType(type: 'byte' | 'half'): boolean {
    const t = type === 'half' ? HalfFloatType : UnsignedByteType
    if (this.target.texture.type === t) return false
    this.target.texture.type = t
    this.target.dispose()
    return true
  }

  resize(width: number, height: number): boolean {
    if (this.target.width === width && this.target.height === height) return false
    this.target.setSize(width, height)
    return true
  }

  /**
   * The ortho view of the Surface rect in units. Its depth range is sized to the Surface, not fixed: content under
   * tilted glass (a pool) leaves the plane by up to half its diagonal, and at 1 pt per unit (screen Surfaces) a fixed
   * ±10 units would clip a tilt of a few degrees across a wide control — a sharp edge where the pool is cut off.
   */
  setView(s: SurfaceDims): void {
    const w = s.width / s.ptPerUnit, h = s.height / s.ptPerUnit, depth = Math.hypot(w, h) + 1
    this.camera.left = -w / 2; this.camera.right = w / 2; this.camera.top = h / 2; this.camera.bottom = -h / 2
    this.camera.position.z = 0; this.camera.near = -depth; this.camera.far = depth
    this.camera.updateProjectionMatrix()
  }

  /**
   * Clears the target to `clear` and draws the content. The clear does not depend on the host: three clears a target
   * only while `renderer.autoClear` (and `autoClearColor`) is true, so both are forced on for this call and put back
   * after. Restores the previous target, clear colour/alpha and those flags even when `render` throws (e.g. before the
   * backend is initialised).
   */
  render(renderer: RendererLike, clear: { color: Color; alpha: number }): void {
    const prevTarget = renderer.getRenderTarget?.() ?? null
    const prevAlpha = renderer.getClearAlpha?.() ?? 1
    renderer.getClearColor?.(this.prevColor)
    renderer.setClearColor?.(clear.color, clear.alpha)
    try {
      renderer.setRenderTarget(this.target)
      withAutoClear(renderer, () => renderer.render(this.scene, this.camera))
    } finally {
      renderer.setRenderTarget(prevTarget)
      renderer.setClearColor?.(this.prevColor, prevAlpha)
    }
  }

  dispose(): void { this.target.dispose() }
}
