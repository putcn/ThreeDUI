import { HalfFloatType, LinearFilter, LinearSRGBColorSpace, NoBlending, RenderTarget, RGBAFormat, Texture, UnsignedByteType, Vector2 } from 'three'
import { MeshBasicNodeMaterial, QuadMesh, type Node, type Renderer, type TextureNode, type UniformNode } from 'three/webgpu'
import { float, texture, uniform, uv, vec2 } from 'three/tsl'
import { GlassUIError } from '@glassui/core'
import type { RendererLike } from '../surface/content'

const texelType = (type: 'byte' | 'half') => type === 'half' ? HalfFloatType : UnsignedByteType

/** One dual-Kawase pass: a full-screen triangle blurring `source` (RGBA) into the bound target. */
interface Pass { mesh: QuadMesh; material: MeshBasicNodeMaterial; source: TextureNode; texel: UniformNode<'vec2', Vector2> }

/**
 * The dual-Kawase kernels (Bjørge 2015) over `uv()`, both RGBA: the content is premultiplied colour + coverage, so
 * alpha blurs with it and is written straight (no blending). `texel` is the texel size of the pass's lower-resolution
 * side, `h` half of it. Down: the centre ×4 + the 4 diagonal taps at ±h, i.e. at the target texel's corners (a
 * source-texel offset would land them on the 4 texels the centre tap already averages: a plain 2×2 box), ÷8. Up: the 4
 * axis taps at ±1 source texel + the 4 diagonal taps at ±h ×2, ÷12. Every tap reads level 0 (the content RT has mips).
 */
function pass(kind: 'down' | 'up'): Pass {
  // a uv of its own: the taps (its `.sample` clones, which follow its value) carry no uv-matrix uniform
  const source = texture(new Texture(), uv(), float(0)), texel = uniform(new Vector2(1, 1))
  const p = uv(), h = texel.mul(0.5)
  const tap = (o: Node<'vec2'>, w: number) => source.sample(p.add(o)).mul(w)
  const diagonals = (w: number) => tap(vec2(h.x.negate(), h.y.negate()), w).add(tap(vec2(h.x, h.y.negate()), w)).add(tap(vec2(h.x.negate(), h.y), w)).add(tap(h, w))
  const k = kind === 'down'
    ? source.sample(p).mul(4).add(diagonals(1)).div(8)
    : tap(vec2(texel.x.negate(), 0), 1).add(tap(vec2(texel.x, 0), 1)).add(tap(vec2(0, texel.y.negate()), 1)).add(tap(vec2(0, texel.y), 1)).add(diagonals(2)).div(12)
  const m = new MeshBasicNodeMaterial()
  m.colorNode = k.rgb; m.opacityNode = k.a
  m.transparent = false; m.blending = NoBlending; m.depthTest = false; m.depthWrite = false; m.toneMapped = false
  return { mesh: new QuadMesh(m), material: m, source, texel }
}

/**
 * Spec §5.6 high tier: the content RT's blur pyramid, dual-Kawase on plain ping-pong targets (no MRT, no compute).
 * Level `i` is ⌈w/2^(i+1)⌉ × ⌈h/2^(i+1)⌉ (min 1), RGBA linear, no mips, and each level is about twice as wide a blur as
 * the one before (an RMS radius of ≈ 5, 10, 20, 41 content texels): the glass samples them by roughness.
 *
 * `render` (2·levels + 1 passes): down-samples the source through every level into one more, then up-samples each level,
 * finest first, from the next one's down-sample before that one is overwritten. (Up-sampling coarsest first, as the
 * classic chain does, would leave every level holding the deepest level's blur: one blur width, not a pyramid.)
 */
export class KawasePyramid {
  readonly levels: RenderTarget[] = []
  /** The last level's down-sample: only its up-sample reads it. */
  private readonly extra: RenderTarget
  private readonly down = pass('down')
  private readonly up = pass('up')

  constructor(levels = 4, type: 'byte' | 'half' = 'byte') {
    if (!Number.isInteger(levels) || levels < 1) throw new GlassUIError('KawasePyramid', `层数必须是不小于 1 的整数，实际为 ${levels}`)
    const target = () => new RenderTarget(1, 1, {
      format: RGBAFormat, type: texelType(type), minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false, colorSpace: LinearSRGBColorSpace, depthBuffer: false,
    })
    for (let i = 0; i < levels; i++) this.levels.push(target())
    this.extra = target()
  }

  get textures(): Texture[] { return this.levels.map(l => l.texture) }

  resize(width: number, height: number): void {
    let w = width, h = height
    for (const t of [...this.levels, this.extra]) {
      w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2))
      if (t.width !== w || t.height !== h) t.setSize(w, h)
    }
  }

  /** Switches the texel type (a quality change), keeping the texture objects; the targets re-allocate at the next render. True if it changed. */
  setType(type: 'byte' | 'half'): boolean {
    const t = texelType(type)
    if (this.extra.texture.type === t) return false
    for (const rt of [...this.levels, this.extra]) { rt.texture.type = t; rt.dispose() }
    return true
  }

  /** Restores the previous render target even when a pass throws. */
  render(renderer: RendererLike, source: Texture): void {
    const prev = renderer.getRenderTarget?.() ?? null
    const chain = [...this.levels, this.extra]
    try {
      let from = source
      for (const to of chain) { this.draw(renderer, this.down, from, to, to); from = to.texture }
      for (let i = 0; i < this.levels.length; i++) this.draw(renderer, this.up, chain[i + 1]!.texture, chain[i]!, chain[i + 1]!)
    } finally { renderer.setRenderTarget(prev) }
  }

  /** `small`: the pass's lower-resolution side (the target down, the source up), whose texel sizes the taps. */
  private draw(renderer: RendererLike, p: Pass, from: Texture, to: RenderTarget, small: RenderTarget): void {
    p.source.value = from
    p.texel.value.set(1 / small.width, 1 / small.height)
    renderer.setRenderTarget(to)
    p.mesh.render(renderer as unknown as Renderer)   // QuadMesh.render needs only `render(mesh, camera)`
  }

  dispose(): void {
    for (const t of [...this.levels, this.extra]) t.dispose()
    this.down.material.dispose(); this.up.material.dispose()
  }
}
