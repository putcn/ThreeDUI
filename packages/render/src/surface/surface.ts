import { AddEquation, Box3, Color, CustomBlending, Mesh, Object3D, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, Vector2, Vector3, type Material, type Object3DEventMap, type Texture } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { texture, uniform, viewportMipTexture } from 'three/tsl'
import {
  apply, buildRenderList, createSurface, EventDispatcher, FocusManager, PointerTracker, resolveColor,
  type AnimationRuntime, type ColorScheme, type GlassInstance, type LayoutEngine, type MeasureFn, type Node, type RenderList, type SurfaceModel, type Theme,
} from '@glassui/core'
import type { TextEngine } from '@glassui/text'
import { GlassBatch, type TouchState } from '../glass/batch'
import { createGlassMaterial, type GlassMaterial } from '../glass/material'
import { PanelBatch, cornerExponentFor } from '../panel/batch'
import { createPanelMaterial } from '../panel/material'
import { DecorationBatch } from '../decoration/batch'
import { createPoolMaterial, createRimMaterial } from '../decoration/material'
import { GlyphBatch } from '../text/batch'
import { createGlyphMaterial } from '../text/material'
import type { AtlasPages } from '../text/pages'
import { ImageSet } from '../image/images'
import type { SurfaceUniforms } from '../flat'
import { ContentPass, contentRTSize, type RendererLike } from './content'
import { liftFor, partition, type Partition } from './partition'
import { toColor } from '../color'

export interface SurfaceOptions { id?: string; width: number; height: number; ptPerUnit?: number; placement?: 'screen' | 'world'; background?: 'none' | 'glass' | string; cornerRadius?: number; interactive?: boolean; castToWorld?: boolean; contentScale?: number }
/** The quality knobs a Surface reads (Task 19's tiers extend it). */
export interface QualitySettings { contentType: 'byte' | 'half'; contentScale: number; backFaces: boolean; depthReject: boolean }
/** What every Surface of one root shares. */
export interface SurfaceContext { theme: Theme; scheme: ColorScheme; layout: LayoutEngine; measure: MeasureFn; anim: AnimationRuntime; text: TextEngine; pages: AtlasPages; quality: QualitySettings }
export interface SurfaceEventMap extends Object3DEventMap { error: { error: Error } }

/**
 * The content quad's material: the content RT on the Surface plane, lit (it receives the glass's shadows) but not
 * shadow-casting. The RT holds premultiplied colour (see `ContentPass`), so it composites premultiplied: source factor
 * One (the colour already carries its alpha), alpha "over"; the alpha test (α ≤ 0.02) discards the empty texels, so the
 * depth the quad writes stays on its content.
 */
export function createContentMaterial(content: Texture): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 })
  const sample = texture(content)
  m.colorNode = sample.rgb
  m.opacityNode = sample.a
  m.transparent = true; m.depthWrite = true; m.alphaTest = 0.02; m.toneMapped = false
  m.blending = CustomBlending; m.premultipliedAlpha = false
  m.blendEquation = AddEquation; m.blendSrc = OneFactor; m.blendDst = OneMinusSrcAlphaFactor
  m.blendEquationAlpha = AddEquation; m.blendSrcAlpha = OneFactor; m.blendDstAlpha = OneMinusSrcAlphaFactor
  return m
}

/**
 * Spec §3.2: a content face in 3D, in Surface-local units (centred, y up; its own position/quaternion/scale place it).
 *
 * Draws (all `frustumCulled = false`): background slab back/front (−1, `background: 'glass'` only, refracting the
 * screen), the content quad (0), the glass back (1, with `quality.backFaces`) and front (2) refracting the content RT,
 * rims (3), the glyphs and images riding on glass (4). The content RT's scene, drawn orthographically with the same
 * Surface-local instance matrices: panels (0), pools (1), glyphs (2, one mesh per atlas page), images (group 2).
 * The glass material takes its mesh-local z = 0 as the content plane, so everything on that plane sits at
 * `contentPlaneZ` (the background slab's thickness; 0 without one) and instance matrices stay plane-relative.
 */
export class Surface extends Object3D<SurfaceEventMap> {
  readonly model: SurfaceModel
  readonly events = new EventDispatcher()
  readonly pointer: PointerTracker
  readonly focus: FocusManager
  /** The raycast target: its uv → Surface pt via `pointFromUV`. */
  readonly contentMesh: Mesh
  readonly contentPass: ContentPass
  readonly glass = new GlassBatch()
  readonly panels = new PanelBatch()
  readonly rims = new DecorationBatch('rim')
  readonly pools = new DecorationBatch('pool')
  readonly foregroundText: GlyphBatch
  readonly contentText: GlyphBatch
  readonly foregroundImages: ImageSet
  readonly contentImages: ImageSet
  readonly backgroundGlass: GlassBatch | null = null
  /** Units: 0, or the background slab's thickness. */
  readonly contentPlaneZ: number = 0
  interactive: boolean
  castToWorld: boolean
  /** Set when a frame threw: the Surface stops drawing (`visible = false`) and has emitted `{ type: 'error', error }`. */
  error: Error | null = null
  /** True while animating. */
  needsFrame = false
  /** The content RT must be redrawn (`prepare` does it). */
  contentDirty = true
  private readonly ctx: SurfaceContext
  private readonly su: SurfaceUniforms
  private readonly contentScale: number
  private readonly contentClear: { color: Color; alpha: number } = { color: new Color(0, 0, 0), alpha: 0 }
  private readonly glassMaterials: GlassMaterial[] = []
  private readonly materials: Material[] = []
  private readonly foregroundGlyphs = new Map<number, Mesh>()
  private readonly contentGlyphs = new Map<number, Mesh>()
  private readonly touch = new Map<Node, TouchState>()
  private pointerPt: [number, number] | null = null
  private list: RenderList | null = null
  private parts: Partition | null = null
  /** The atlas epoch the glyph batches were last built at (the pages are shared: another Surface may have seen the change). */
  private seenEpoch: number

  constructor(opts: SurfaceOptions, ctx: SurfaceContext) {
    super()
    this.ctx = ctx
    this.model = createSurface(opts)
    this.name = this.model.id
    this.interactive = opts.interactive ?? true
    this.castToWorld = opts.castToWorld ?? false
    this.contentScale = opts.contentScale ?? 1
    this.pointer = new PointerTracker(this.model.root, this.events, ctx.theme)
    this.focus = new FocusManager(this.model.root, this.events)
    this.su = { size: uniform(new Vector2()), ptPerUnit: uniform(this.model.ptPerUnit) }
    this.contentPass = new ContentPass({ type: ctx.quality.contentType })
    this.seenEpoch = ctx.text.atlas.epoch

    const bg = this.model.background
    if (bg === 'glass') {
      // fixed at creation: a later setSize keeps the slab (and the content plane) where it is
      this.contentPlaneZ = Math.min(this.model.width, this.model.height) * 0.05 / this.model.ptPerUnit
      const slab = this.backgroundGlass = new GlassBatch()
      const screen = viewportMipTexture()   // one framebuffer capture for both faces
      for (const [side, on] of [['back', ctx.quality.backFaces], ['front', true]] as const) {
        if (!on) continue
        const gm = createGlassMaterial({ geometry: slab.geometry, K: slab.K, backdrop: 'screen', side, surface: this.su, screen, depthReject: ctx.quality.depthReject })
        const mesh = new Mesh(slab.geometry, gm.material)
        mesh.renderOrder = -1; mesh.frustumCulled = false   // at z = 0: its top face is the content plane
        this.add(mesh); this.glassMaterials.push(gm)
      }
    } else if (bg !== 'none') {
      // opaque: a clear must be (0,0,0)@0 or opaque to stay premultiplied on both backends (WebGL premultiplies it)
      toColor(resolveColor(bg, ctx.theme, ctx.scheme), this.contentClear.color); this.contentClear.alpha = 1
    }
    const onPlane = <T extends Object3D>(o: T): T => { o.position.z = this.contentPlaneZ; return o }

    this.contentMesh = new Mesh(new PlaneGeometry(1, 1), this.own(createContentMaterial(this.contentPass.texture)))
    this.contentMesh.receiveShadow = true; this.contentMesh.castShadow = false; this.contentMesh.renderOrder = 0; this.contentMesh.frustumCulled = false
    // the raycast hit's way back to its Surface; not enumerable, so `toJSON`/`clone` (which stringify userData) skip the cycle
    Object.defineProperty(this.contentMesh.userData, 'surface', { value: this, enumerable: false })
    this.add(onPlane(this.contentMesh))

    for (const [side, order, on] of [['back', 1, ctx.quality.backFaces], ['front', 2, true]] as const) {
      if (!on) continue
      const gm = createGlassMaterial({ geometry: this.glass.geometry, K: this.glass.K, backdrop: 'panel', side, surface: this.su, content: this.contentPass.texture })
      const mesh = new Mesh(this.glass.geometry, gm.material)
      mesh.renderOrder = order; mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = false
      this.add(onPlane(mesh)); this.glassMaterials.push(gm)
    }
    const rimMesh = new Mesh(this.rims.geometry, this.own(createRimMaterial(this.rims.geometry, this.su)))
    rimMesh.renderOrder = 3; rimMesh.frustumCulled = false
    this.add(onPlane(rimMesh))
    this.foregroundText = new GlyphBatch(ctx.text, ctx.pages)
    this.foregroundImages = new ImageSet(this.su)
    this.foregroundImages.group.renderOrder = 4
    this.add(onPlane(this.foregroundImages.group))

    const panelMesh = new Mesh(this.panels.geometry, this.own(createPanelMaterial(this.panels.geometry, this.su)))
    panelMesh.renderOrder = 0; panelMesh.frustumCulled = false
    const poolMesh = new Mesh(this.pools.geometry, this.own(createPoolMaterial(this.pools.geometry, this.su)))
    poolMesh.renderOrder = 1; poolMesh.frustumCulled = false
    this.contentText = new GlyphBatch(ctx.text, ctx.pages)
    this.contentImages = new ImageSet(this.su)
    this.contentImages.group.renderOrder = 2
    this.contentPass.scene.add(panelMesh, poolMesh, this.contentImages.group)

    this.applySize()
  }

  get root(): Node { return this.model.root }

  /** Surface size in pt; marks layout (the root's style size) and the content RT. */
  setSize(width: number, height: number): void {
    this.model.width = width; this.model.height = height
    this.root.setStyle({ width, height })
    this.applySize()
    this.contentDirty = true
  }

  private applySize(): void {
    const w = this.model.width / this.model.ptPerUnit, h = this.model.height / this.model.ptPerUnit
    this.su.size.value.set(w, h)
    this.contentMesh.scale.set(w, h, 1)
    this.backgroundGlass?.update([this.backgroundSlab()], this.model)
  }

  /** The background slab: one glass instance over the Surface rect, a thin frosted sheet (`thickness = contentPlaneZ`). */
  private backgroundSlab(): GlassInstance {
    const t = this.ctx.theme.glass, { width, height, ptPerUnit } = this.model
    const rect = { x: 0, y: 0, width, height }, radius = Math.min(this.model.cornerRadius, width / 2, height / 2)
    const thickness = this.contentPlaneZ * ptPerUnit
    return {
      node: this.root, rect, radius, z: 0, elevation: 0, scale: 1, transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, tilt: { x: 0, y: 0 }, opacity: 1,
      params: {
        thickness, fillet: thickness * 0.3, filletBottom: 0, profile: 'fillet', scatter: 0.12, lift: 0.07, edgeGlow: 0.3, ior: t.ior, dispersion: 0.3,
        roughness: 0.4, tint: null, absorption: 0, glow: null, cornerExponent: cornerExponentFor(rect, radius), envIntensity: t.envIntensity,
        specularIntensity: t.specularIntensity, innerGlow: t.innerGlow, adaptive: false, variant: 'regular',
      },
    }
  }

  /** Surface pt from the content quad's hit uv (PlaneGeometry: v = 1 at the top). */
  pointFromUV(u: number, v: number): [number, number] { return [u * this.model.width, (1 - v) * this.model.height] }

  /** The pointer's position on this Surface (pt), or null when it is elsewhere: where a press glows (the bridge sets it). */
  setPointer(pt: [number, number] | null): void { this.pointerPt = pt }

  /** Layout → animation → render list → batches (sets `contentDirty`). A throw fails the Surface instead of propagating. */
  tick(dt: number): void {
    if (this.error) return
    try {
      const root = this.root, ctx = this.ctx
      if (root.dirty.layout || root.dirty.tree) ctx.layout.compute(root, this.model.width, this.model.height, ctx.measure)
      this.needsFrame = ctx.anim.tick(root, dt, this.model.cornerRadius)
      if (root.dirty.paint || !this.list || !this.parts) {
        const list = this.list = buildRenderList(this.model, ctx.theme, ctx.scheme)
        const p = this.parts = partition(list)
        this.updateTouch(list)
        this.fill(list, p)
        root.walk(n => { n.dirty.paint = false })
        this.contentDirty = true
        return
      }
      if (this.updateTouch(this.list)) this.glass.update(this.list.glass, this.model, this.touch)
      if (ctx.text.atlas.epoch !== this.seenEpoch) { this.fillText(this.parts); this.contentDirty = true }
    } catch (e) { this.fail(e) }
  }

  private fill(list: RenderList, p: Partition): void {
    const s = this.model
    this.glass.update(list.glass, s, this.touch)
    this.panels.update(p.content.panels, s)
    this.pools.update(p.content.pools, s)
    this.rims.update(p.foreground.rims, s, d => liftFor(p, d.node))
    this.foregroundImages.update(p.foreground.images, s, i => liftFor(p, i.node))
    this.contentImages.update(p.content.images, s)
    this.fillText(p)
  }

  /** The glyph quads, laid out once more if the atlas evicted while they were built (their slots moved under them). */
  private fillText(p: Partition): void {
    const atlas = this.ctx.text.atlas, epoch = atlas.epoch
    this.layoutText(p)
    if (atlas.epoch !== epoch) this.layoutText(p)
    this.seenEpoch = atlas.epoch
  }

  private layoutText(p: Partition): void {
    this.foregroundText.update(p.foreground.text, this.model, t => liftFor(p, t.node))
    this.contentText.update(p.content.text, this.model)
    this.syncGlyphMeshes(this.foregroundText, this.foregroundGlyphs, this, 4, this.contentPlaneZ)   // on the content plane
    this.syncGlyphMeshes(this.contentText, this.contentGlyphs, this.contentPass.scene, 2, 0)
  }

  /** One mesh per atlas page per batch, made when the page first has glyphs (a page batch is never dropped). */
  private syncGlyphMeshes(batch: GlyphBatch, meshes: Map<number, Mesh>, parent: Object3D, renderOrder: number, z: number): void {
    for (const [page, pb] of batch.perPage) {
      if (meshes.has(page)) continue
      const mesh = new Mesh(pb.geometry, this.own(createGlyphMaterial(pb.geometry, this.su, this.ctx.pages.textures[page]!)))
      mesh.renderOrder = renderOrder; mesh.frustumCulled = false; mesh.position.z = z
      parent.add(mesh); meshes.set(page, mesh)
    }
  }

  private own<M extends Material>(m: M): M { this.materials.push(m); return m }

  /**
   * The press glow (spec §5.4): while a node is pressed and the pointer is known, the nearest glass at or above it glows
   * at the pointer, in its centred slab uv (y up; the glass's own scale divided out). Returns whether it changed.
   */
  private updateTouch(list: RenderList): boolean {
    const before = this.touch.entries().next().value
    this.touch.clear()
    const pressed = this.pointer.pressed, pt = this.pointerPt
    if (pressed && pt) {
      let g: GlassInstance | undefined
      for (let n: Node | null = pressed; n && !g; n = n.parent) g = list.glass.find(i => i.node === n)
      const t = g?.transform, k = t ? Math.sqrt(Math.abs(t.a * t.d - t.b * t.c)) : 0
      if (g && t && k > 1e-6 && g.rect.width > 0 && g.rect.height > 0) {
        const [cx, cy] = apply(t, g.rect.x + g.rect.width / 2, g.rect.y + g.rect.height / 2)
        this.touch.set(g.node, { u: (pt[0] - cx) / (g.rect.width * k), v: (cy - pt[1]) / (g.rect.height * k), press: 1 })
      }
    }
    const after = this.touch.entries().next().value
    return before?.[0] !== after?.[0] || before?.[1].u !== after?.[1].u || before?.[1].v !== after?.[1].v
  }

  /** Sizes the content RT for the Surface's projected size and redraws it when dirty (a resize makes it dirty). */
  prepare(renderer: RendererLike, projectedPx: { width: number; height: number }, dpr: number): void {
    if (this.error) return
    try {
      const size = contentRTSize(projectedPx, dpr, { scale: this.ctx.quality.contentScale * this.contentScale })
      if (this.contentPass.resize(size.width, size.height)) this.contentDirty = true
      if (!this.contentDirty) return
      this.contentPass.setView(this.model)
      this.contentPass.render(renderer, this.contentClear)
      this.contentDirty = false
    } catch (e) { this.fail(e) }
  }

  private fail(e: unknown): void {
    this.error = e instanceof Error ? e : new Error(String(e))
    this.visible = false
    this.dispatchEvent({ type: 'error', error: this.error })
  }

  /** Surface-local bounds of the content face up to the top of its tallest glass (for the shadow-camera fit). */
  get glassBounds(): Box3 {
    const ppu = this.model.ptPerUnit, w = this.model.width / ppu, h = this.model.height / ppu
    let top = this.contentPlaneZ
    for (const g of this.list?.glass ?? []) top = Math.max(top, this.contentPlaneZ + (g.elevation + g.params.thickness) / ppu)
    return new Box3(new Vector3(-w / 2, -h / 2, 0), new Vector3(w / 2, h / 2, top + 0.01))   // never flat
  }

  dispose(): void {
    this.ctx.anim.forget(this.root)
    this.ctx.layout.dispose(this.root)
    this.contentPass.dispose()
    for (const b of [this.glass, this.panels, this.rims, this.pools, this.backgroundGlass]) b?.dispose()
    this.foregroundText.dispose(); this.contentText.dispose(); this.foregroundImages.dispose(); this.contentImages.dispose()
    for (const gm of this.glassMaterials) gm.dispose()
    for (const m of this.materials) m.dispose()
    this.contentMesh.geometry.dispose()
    this.removeFromParent()
  }
}
