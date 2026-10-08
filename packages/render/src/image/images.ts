import { Matrix4, Mesh, NoColorSpace, Object3D, Texture, TextureLoader, type InstancedBufferGeometry } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { texture, float, fwidth, smoothstep, max } from 'three/tsl'
import type { ImageInstance, Node } from '@glassui/core'
import { srgbToLinearNode } from '../color'
import { flatVertex, AA_MARGIN_PT, type SurfaceUniforms } from '../flat'
import { sdfNode } from '../panel/sdf'
import { cornerExponentFor } from '../panel/batch'
import { InstanceBuffer } from '../instances'
import { createQuadGeometry } from '../quad'
import { instanceMatrix, writeClip, writeMatrixRows } from '../transform'
import { surfaceToLocal, type SurfaceDims } from '../units'

/** An image node's `src`: a URL, a three `Texture`, or any `TexImageSource` (`HTMLImageElement`, `ImageBitmap`, canvas). */
export type ImageSource = string | Texture | { width: number; height: number }

/**
 * Turns an image's `src` into the texture it shows. `ImageSet` disposes the texture when its image goes away or
 * changes `src`, unless the texture is the `src` itself (a caller's `Texture`): a loader returns a texture of its own
 * per call, never one it shares.
 */
export type ImageLoader = (src: ImageSource) => Texture

/**
 * Per-instance vec4 attributes of an image: `iRect` (cx, cy, w, h; units), `iShape` (radius; units, cornerExponent,
 * opacity, 0), then the matrix rows and the clip (transform.ts).
 */
export const IMAGE_ATTRS = ['iRect', 'iShape', 'iMat0', 'iMat1', 'iMat2', 'iClipRect', 'iClipInv', 'iClipT'] as const

const isTexture = (src: ImageSource): src is Texture => (src as Texture).isTexture === true
const isImageBitmap = (src: ImageSource) => typeof ImageBitmap !== 'undefined' && src instanceof ImageBitmap

let textureLoader: TextureLoader | undefined
/** The textures `defaultImageLoader` made: untagged sRGB bytes, which `createImageMaterial` decodes itself. */
const srgbBytes = new WeakSet<Texture>()
/**
 * A `Texture` src as is (the caller owns it, colour space and alpha mode included); an element in a new texture marked
 * for upload; a URL through three's `TextureLoader` (the texture is returned at once and filled when the image arrives).
 *
 * The textures it makes are premultiplied on upload (both backends honour `premultiplyAlpha`), so filtering and mipmaps
 * weight colour by alpha: straight, an opaque texel next to a transparent (black) one filters to half its colour at half
 * alpha, a dark fringe. An `ImageBitmap` stays straight: WebGL ignores the unpack flags for one (its alpha mode is fixed
 * when it is created). They are untagged (`NoColorSpace`, raw sRGB bytes) on purpose: the browser premultiplies the
 * encoded bytes, and a hardware sRGB texture would decode that product, decode(c·a) ≠ decode(c)·a, darkening every
 * partially transparent texel (an antialiased edge); `createImageMaterial` divides alpha out first, then decodes.
 */
export const defaultImageLoader: ImageLoader = src => {
  if (isTexture(src)) return src
  let t: Texture
  if (typeof src === 'string') t = (textureLoader ??= new TextureLoader()).load(src)
  else { t = new Texture(src); t.needsUpdate = true }
  t.colorSpace = NoColorSpace
  t.premultiplyAlpha = !isImageBitmap(src)
  srgbBytes.add(t)
  return t
}

/**
 * An image quad: the texture stretched over the rect, cut to its rounded corners by the superellipse SDF, unlit and
 * alpha-blended (normal blending of a straight linear colour: the content RT is premultiplied by construction).
 * Opacity = coverage × sample alpha × instance opacity, coverage antialiased over ±0.75 px (`fwidth`); the quad extends
 * `AA_MARGIN_PT` beyond the rect so the outer half of the ramp is rasterised, and the clip discards.
 *
 * The colour, by the texture's state when the material is made: a premultiplied texture's sample has alpha divided out
 * (as the panel does). A texture `defaultImageLoader` made holds untagged sRGB bytes and is decoded to linear after that
 * division (exact at texels, see `defaultImageLoader`). Any other texture follows three's colour-space semantics: the
 * hardware decodes an `SRGBColorSpace` one, and a `NoColorSpace` one (a render target's, a `DataTexture`) is read raw.
 * A caller's `SRGBColorSpace` + `premultiplyAlpha` texture is therefore taken as linear-premultiplied (three's semantics:
 * the decoded sample is divided by alpha).
 *
 * The geometry's `uv` spans the grown quad, so the rect's uv is `q / size + 0.5`: u runs left → right and v bottom →
 * top (q.y is up), which is upright as both backends upload images flipped (`flipY`, three's default: the image's top
 * row at v = 1). The margin samples just past [0, 1] (clamped to the edge by the default wrap), where coverage is at
 * most ½ and falling. `texture(tex, uv)` rather than `texture(tex).sample(uv)`: the latter applies the texture's uv
 * matrix (a uniform and a multiply per fragment).
 *
 * Varyings: `flatVertex`'s three + `iShape` = 4.
 */
export function createImageMaterial(g: InstancedBufferGeometry, su: SurfaceUniforms, tex: Texture): MeshBasicNodeMaterial {
  const fv = flatVertex(g, su, { marginPt: AA_MARGIN_PT })
  const shape = fv.pack('iShape')
  const radius = shape.x, n = shape.y, opacity = shape.z

  const m = new MeshBasicNodeMaterial()
  m.transparent = true; m.depthWrite = false; m.toneMapped = false
  m.lights = false   // unlit outright, as the panel material: a lit basic material costs a `v_positionView` varying
  m.positionNode = fv.position
  m.maskNode = fv.mask   // the material discards where the mask is false

  const d = sdfNode(fv.q, fv.size.mul(0.5), radius, n)
  // floored so edge0 < edge1 where d is flat across a pixel (smoothstep is undefined otherwise)
  const aa = max(fwidth(d), 1e-6).mul(0.75)
  const cover = float(1).sub(smoothstep(aa.negate(), aa, d))
  const sample = texture(tex, fv.q.div(fv.size).add(0.5))
  const rgb = tex.premultiplyAlpha ? sample.rgb.div(max(sample.a, 1e-6)) : sample.rgb
  m.colorNode = srgbBytes.has(tex) ? srgbToLinearNode(rgb) : rgb
  m.opacityNode = cover.mul(sample.a).mul(opacity)
  return m
}

/** One image's draw: its mesh, the mesh's one-instance buffer, the `src` it shows and the texture made for it. */
interface Entry {
  mesh: Mesh; buffer: InstanceBuffer; material: MeshBasicNodeMaterial; src: unknown; texture: Texture
  /** The texture's `version` and readiness as of the last `pollChanged`. */
  version: number; ready: boolean
}

/** Whether a texture's image can be uploaded: present, and not an element still loading. */
const isReady = (image: unknown): boolean => image != null && (image as { complete?: boolean }).complete !== false

/**
 * Every image of one Surface, one mesh each (spec §5.5: images are separate draws in this phase): a one-instance
 * `InstanceBuffer` on its own quad, with `createImageMaterial` over the texture the loader makes for its `src`.
 * Meshes are kept by `node` across updates (the texture loads once), re-created when the `src` changes, and removed
 * when the node's image disappears or loses its `src`. An image with no area (its AA margin would still rasterise, at
 * q / size = 0/0) or no opacity is hidden, keeping its texture. Images are lifted `elevation + lift(i)` pt.
 *
 * Draw order: the meshes sit in `container`, a plain `Object3D` (a `Group` would reset three's group order and pull
 * them out of their Surface's layer), at `renderOrder` ∈ [base, base + ½) in z order, so a caller places the whole set
 * between two of its batched draws (the Surface: after panels and pools, before glyphs). Known limitation: an image is
 * not interleaved with a batched draw, so a photo meant to cover some text still draws under the glyph batch.
 */
export class ImageSet {
  readonly container = new Object3D()
  private readonly entries = new Map<Node, Entry>()
  private readonly m = new Matrix4()
  constructor(private readonly su: SurfaceUniforms, private readonly load: ImageLoader = defaultImageLoader) {}

  update(instances: readonly ImageInstance[], s: SurfaceDims, lift: (i: ImageInstance) => number = () => 0, base = 0): void {
    const live = new Set<Node>()
    const ppu = s.ptPerUnit
    const shown = instances.filter(i => i.src != null).sort((a, b) => a.z - b.z)   // no source, nothing to show
    shown.forEach((inst, k) => {
      live.add(inst.node)
      let e = this.entries.get(inst.node)
      if (e && e.src !== inst.src) { this.release(e); e = undefined }
      if (!e) { e = this.create(inst); this.entries.set(inst.node, e) }

      const b = e.buffer
      b.begin(1)
      const [cx, cy] = surfaceToLocal(inst.rect.x + inst.rect.width / 2, inst.rect.y + inst.rect.height / 2, s)
      b.set(0, 'iRect', cx, cy, inst.rect.width / ppu, inst.rect.height / ppu)
      b.set(0, 'iShape', inst.radius / ppu, cornerExponentFor(inst.rect, inst.radius), inst.opacity, 0)
      writeMatrixRows(b, 0, instanceMatrix({ ...inst, elevation: inst.elevation + lift(inst) }, s, this.m))
      writeClip(b, 0, inst.clip)
      b.commit()
      // by rank rather than base + z·ε: bounded however many nodes the tree has
      e.mesh.renderOrder = base + 0.5 * k / shown.length
      e.mesh.visible = inst.rect.width > 0 && inst.rect.height > 0 && inst.opacity > 0
    })
    for (const [node, e] of this.entries) if (!live.has(node)) { this.release(e); this.entries.delete(node) }
  }

  /**
   * Whether any image's texture changed since the last poll (its `version` moved: a URL finished loading, a video
   * frame, a caller's `needsUpdate`), or its image became ready. An element still loading when it was first uploaded is
   * marked for upload again here: three skips an incomplete image and does not retry it by itself. Images created by
   * `update` count from their creation (the update that made them has redrawn already).
   */
  pollChanged(): boolean {
    let changed = false
    for (const e of this.entries.values()) {
      const t = e.texture, ready = isReady(t.image)
      if (ready && !e.ready && t.version === e.version) t.needsUpdate = true
      if (ready !== e.ready || t.version !== e.version) changed = true
      e.ready = ready; e.version = t.version
    }
    return changed
  }

  dispose(): void {
    for (const e of this.entries.values()) this.release(e)
    this.entries.clear()
  }

  private create(inst: ImageInstance): Entry {
    const src = inst.src as ImageSource
    const tex = this.load(src)
    const geometry = createQuadGeometry()
    const buffer = new InstanceBuffer(geometry, IMAGE_ATTRS, 1)
    const material = createImageMaterial(geometry, this.su, tex)
    const mesh = new Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.userData = { node: inst.node, buffer }
    this.container.add(mesh)
    return { mesh, buffer, material, src, texture: tex, version: tex.version, ready: isReady(tex.image) }
  }

  private release(e: Entry): void {
    this.container.remove(e.mesh)
    e.material.dispose(); e.buffer.dispose()
    if (e.texture !== e.src) e.texture.dispose()   // a Texture src stays the caller's
  }
}
