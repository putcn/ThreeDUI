import { Color, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, LinearSRGBColorSpace, OrthographicCamera, RenderTarget, RGBAFormat, Scene, UnsignedByteType, type Camera, type Object3D, type Texture } from 'three'
import type { SurfaceDims } from '../units'

/** RT pixels for a Surface projected to `projectedPx` CSS px: integer steps avoid per-frame jitter; never 0; capped. */
export function contentRTSize(projectedPx: { width: number; height: number }, dpr: number, opts: { cap?: number; step?: number; scale?: number } = {}): { width: number; height: number } {
  const { cap = 4096, step = 64, scale = 1 } = opts
  const fit = (v: number) => { const px = v * dpr * scale; if (!(px > 0)) return 1; return Math.max(1, Math.min(cap, Math.ceil(px / step) * step)) }
  return { width: fit(projectedPx.width), height: fit(projectedPx.height) }
}

/** The subset of `WebGPURenderer` the render passes call (so tests can pass a stub). */
export interface RendererLike {
  setRenderTarget(rt: RenderTarget | null): void
  getRenderTarget?(): RenderTarget | null
  render(scene: Object3D, camera: Camera): unknown
  setClearColor?(color: Color | number, alpha?: number): void
  getClearColor?(target: Color): Color
  getClearAlpha?(): number
}

/**
 * Spec §5.6 step 2: the Surface's non-glass content, drawn orthographically in Surface-local units into a mipmapped RT.
 * Premultiplied by construction: transparent clears are (0,0,0) at alpha 0, colour backgrounds clear at alpha 1; panels,
 * glyphs and images blend over it (alpha One/OneMinusSrcAlpha), pools add colour with "over" coverage; composite it premultiplied.
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

  /** Restores the previous target and clear colour/alpha even when `render` throws (e.g. before the backend is initialised). */
  render(renderer: RendererLike, clear: { color: Color; alpha: number }): void {
    const prevTarget = renderer.getRenderTarget?.() ?? null
    const prevAlpha = renderer.getClearAlpha?.() ?? 1
    renderer.getClearColor?.(this.prevColor)
    renderer.setClearColor?.(clear.color, clear.alpha)
    try {
      renderer.setRenderTarget(this.target)
      renderer.render(this.scene, this.camera)
    } finally {
      renderer.setRenderTarget(prevTarget)
      renderer.setClearColor?.(this.prevColor, prevAlpha)
    }
  }

  dispose(): void { this.target.dispose() }
}
