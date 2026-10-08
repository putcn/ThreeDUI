import { Group, Matrix4, Mesh, SRGBColorSpace, Texture, TextureLoader, type InstancedBufferGeometry } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { texture, float, fwidth, smoothstep, max } from 'three/tsl'
import type { ImageInstance, Node } from '@glassui/core'
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

let textureLoader: TextureLoader | undefined
/**
 * A `Texture` src as is (the caller owns it, colour space included); an element in a new texture marked for upload; a
 * URL through three's `TextureLoader` (the texture is returned at once and filled when the image arrives). The textures
 * it makes are sRGB (three decodes them to linear on sample).
 */
export const defaultImageLoader: ImageLoader = src => {
  if (isTexture(src)) return src
  let t: Texture
  if (typeof src === 'string') t = (textureLoader ??= new TextureLoader()).load(src)
  else { t = new Texture(src); t.needsUpdate = true }
  t.colorSpace = SRGBColorSpace
  return t
}

/**
 * An image quad: the texture stretched over the rect, cut to its rounded corners by the superellipse SDF, unlit and
 * alpha-blended (normal blending of the texture's straight rgb: the content RT is premultiplied by construction).
 * Opacity = coverage × sample alpha × instance opacity, coverage antialiased over ±0.75 px (`fwidth`); the quad extends
 * `AA_MARGIN_PT` beyond the rect so the outer half of the ramp is rasterised, and the clip discards.
 *
 * The geometry's `uv` spans the grown quad, so the rect's uv is `q / size + 0.5`: u runs left → right and v bottom →
 * top (q.y is up), which is upright as both backends upload images flipped (`flipY`, three's default: the image's top
 * row at v = 1). The margin samples just past [0, 1] (clamped to the edge by the default wrap), where coverage is at
 * most ½ and falling. `texture(tex, uv)` rather
 * than `texture(tex).sample(uv)`: the latter applies the texture's uv matrix (a uniform and a multiply per fragment).
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
  m.colorNode = sample.rgb
  m.opacityNode = cover.mul(sample.a).mul(opacity)
  return m
}

/** One image's draw: its mesh, the mesh's one-instance buffer, the `src` it shows and the texture made for it. */
interface Entry { mesh: Mesh; buffer: InstanceBuffer; material: MeshBasicNodeMaterial; src: unknown; texture: Texture }

/**
 * Every image of one Surface, one mesh each (spec §5.5: images are separate draws in this phase): a one-instance
 * `InstanceBuffer` on its own quad, with `createImageMaterial` over the texture the loader makes for its `src`.
 * Meshes are kept by `node` across updates (the texture loads once), re-created when the `src` changes, and removed
 * when the node's image disappears or loses its `src`. `renderOrder = z` orders them within `group` (whose own
 * `renderOrder` places them among the Surface's draws). An image with no area (its AA margin would still rasterise, at
 * q / size = 0/0) or no opacity is hidden, keeping its texture. Images are lifted `elevation + lift(i)` pt.
 */
export class ImageSet {
  readonly group = new Group()
  private readonly entries = new Map<Node, Entry>()
  private readonly m = new Matrix4()
  constructor(private readonly su: SurfaceUniforms, private readonly load: ImageLoader = defaultImageLoader) {}

  update(instances: readonly ImageInstance[], s: SurfaceDims, lift: (i: ImageInstance) => number = () => 0): void {
    const live = new Set<Node>()
    const ppu = s.ptPerUnit
    for (const inst of instances) {
      if (inst.src == null) continue   // no source, nothing to show
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
      e.mesh.renderOrder = inst.z
      e.mesh.visible = inst.rect.width > 0 && inst.rect.height > 0 && inst.opacity > 0
    }
    for (const [node, e] of this.entries) if (!live.has(node)) { this.release(e); this.entries.delete(node) }
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
    this.group.add(mesh)
    return { mesh, buffer, material, src, texture: tex }
  }

  private release(e: Entry): void {
    this.group.remove(e.mesh)
    e.material.dispose(); e.buffer.dispose()
    if (e.texture !== e.src) e.texture.dispose()   // a Texture src stays the caller's
  }
}
