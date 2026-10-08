import { AddEquation, Box3, Color, CustomBlending, Group, Mesh, Object3D, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, Vector2, Vector3, type Material, type Object3DEventMap, type Texture } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { texture, uniform, uv, vec2 } from 'three/tsl'
import {
  apply, buildRenderList, createSurface, EventDispatcher, FocusManager, PointerTracker, resolveColor,
  type AnimationRuntime, type ColorScheme, type GlassInstance, type LayoutEngine, type MeasureFn, type Node, type RenderList, type SurfaceModel, type Theme,
} from '@glassui/core'
import type { TextEngine } from '@glassui/text'
import { GlassBatch, type TouchState } from '../glass/batch'
import { createGlassMaterial, DepthCapture, ScreenCapture, type GlassMaterial } from '../glass/material'
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
/** The quality knobs a Surface reads (`QualityProfile` in `quality.ts` extends it into a full tier). */
export interface QualitySettings { contentType: 'byte' | 'half'; contentScale: number; backFaces: boolean; depthReject: boolean; blur: 'kawase' | 'mip' }
/** What every Surface of one root shares; `quality` is the root's current tier, the one new Surfaces start from. */
export interface SurfaceContext { theme: Theme; scheme: ColorScheme; layout: LayoutEngine; measure: MeasureFn; anim: AnimationRuntime; text: TextEngine; pages: AtlasPages; quality: QualitySettings }
export interface SurfaceEventMap extends Object3DEventMap { error: { error: Error } }

/** `renderOrder` of each draw inside a Surface's `layer`; images take [images, images + ½) in z order (`ImageSet`). */
export const SURFACE_ORDER = { slab: -1, content: 0, glassBack: 1, glassFront: 2, rims: 3, images: 3.5, glyphs: 4 } as const
/** The frosted background slab's roughness and lift; element glass on such a Surface sees what is behind it as the slab does. */
export const SLAB_FROST = { roughness: 0.4, lift: 0.07 } as const
/** `renderOrder` of each draw inside the content RT's scene. */
export const CONTENT_ORDER = { panels: 0, pools: 1, images: 1.5, glyphs: 2 } as const

/**
 * The content quad's material: the content RT on the Surface plane, lit (it receives the glass's shadows) but not
 * shadow-casting. The RT holds premultiplied colour (see `ContentPass`), so it composites premultiplied: source factor
 * One (the colour already carries its alpha), alpha "over"; the alpha test (α ≤ 0.02) discards the empty texels, so the
 * depth the quad writes stays on its content.
 *
 * Orientation: three's render-target textures have v = 0 at the image's TOP row on both backends (WebGPU natively; the
 * GLSL builder flips render-target reads to match), while the quad's `PlaneGeometry` uv has v = 1 at its top edge, so
 * the quad samples at (u, 1 − v). (`texture(tex, uv)` rather than `.sample(uv)`: no uv-matrix uniform.)
 */
export function createContentMaterial(content: Texture): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 })
  const sample = texture(content, vec2(uv().x, uv().y.oneMinus()))
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
 * Draws (all `frustumCulled = false`, orders in `SURFACE_ORDER`): background slab back/front (`background: 'glass'`
 * only, refracting the screen), the content quad, the glass back (with `quality.backFaces`) and front refracting the
 * content RT, rims, then the images and glyphs riding on glass. The content RT's scene (`CONTENT_ORDER`), drawn
 * orthographically with the same Surface-local instance matrices: panels, pools, images, glyphs (one mesh per page).
 *
 * Every draw lives under `layer`, a `Group` whose `renderOrder` is `drawOrder`: three sorts by the nearest group's order
 * first, so Surfaces draw one after another (the root sets `drawOrder`, nearer = higher) instead of layer by layer
 * across Surfaces. No `Group` sits below it. The glass material takes its mesh-local z = 0 as the content plane, so
 * everything on that plane is a child of `plane` (an `Object3D` at z = `contentPlaneZ`: the background slab's
 * thickness, 0 without one) and instance matrices stay plane-relative.
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
  /** Holds every draw of this Surface; its `renderOrder` is `drawOrder`. */
  readonly layer = new Group()
  /** The content plane: the content quad, the glass, rims and what rides on glass; at z = `contentPlaneZ`. */
  readonly plane = new Object3D()
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
  /** The quality this Surface's draws were built for: `ctx.quality` at construction, then the last `setQuality`. */
  private quality: QualitySettings
  private readonly contentClear: { color: Color; alpha: number } = { color: new Color(0, 0, 0), alpha: 0 }
  private readonly glassMaterials: GlassMaterial[] = []
  /** The meshes `buildGlass` made (slab and element glass), replaced on a quality change. */
  private readonly glassMeshes: Mesh[] = []
  private readonly materials: Material[] = []
  private readonly foregroundGlyphs = new Map<number, Mesh>()
  private readonly contentGlyphs = new Map<number, Mesh>()
  private readonly touch = new Map<Node, TouchState>()
  private readonly screen: ScreenCapture | null = null
  /** The background slab's depth capture for `depthReject`, shared by its faces (one depth copy per render); made on first use. */
  private depth: DepthCapture | null = null
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
    this.quality = ctx.quality
    this.contentPass = new ContentPass({ type: this.quality.contentType })
    this.seenEpoch = ctx.text.atlas.epoch

    this.add(this.layer)
    const bg = this.model.background
    if (bg === 'glass' || bg === 'none') {
      // one framebuffer capture, taken at this Surface's first draw that samples it (the slab's, or the element glass's
      // on a 'none' Surface) and kept across quality rebuilds: the slab refracts it, and element glass sees it where the
      // content RT is transparent
      this.screen = new ScreenCapture()
      if (bg === 'glass') this.backgroundGlass = new GlassBatch()
    } else {
      // opaque: a clear must be (0,0,0)@0 or opaque to stay premultiplied on both backends (WebGL premultiplies it)
      toColor(resolveColor(bg, ctx.theme, ctx.scheme), this.contentClear.color); this.contentClear.alpha = 1
    }
    this.layer.add(this.plane)

    this.contentMesh = new Mesh(new PlaneGeometry(1, 1), this.own(createContentMaterial(this.contentPass.texture)))
    this.contentMesh.receiveShadow = true; this.contentMesh.castShadow = false; this.contentMesh.renderOrder = SURFACE_ORDER.content; this.contentMesh.frustumCulled = false
    // the raycast hit's way back to its Surface; not enumerable, so `toJSON`/`clone` (which stringify userData) skip the cycle
    Object.defineProperty(this.contentMesh.userData, 'surface', { value: this, enumerable: false })
    this.plane.add(this.contentMesh)

    this.buildGlass(this.quality)
    const rimMesh = new Mesh(this.rims.geometry, this.own(createRimMaterial(this.rims.geometry, this.su)))
    rimMesh.renderOrder = SURFACE_ORDER.rims; rimMesh.frustumCulled = false
    this.plane.add(rimMesh)
    this.foregroundText = new GlyphBatch(ctx.text, ctx.pages)
    this.foregroundImages = new ImageSet(this.su)
    this.plane.add(this.foregroundImages.container)

    const panelMesh = new Mesh(this.panels.geometry, this.own(createPanelMaterial(this.panels.geometry, this.su)))
    panelMesh.renderOrder = CONTENT_ORDER.panels; panelMesh.frustumCulled = false
    const poolMesh = new Mesh(this.pools.geometry, this.own(createPoolMaterial(this.pools.geometry, this.su)))
    poolMesh.renderOrder = CONTENT_ORDER.pools; poolMesh.frustumCulled = false
    this.contentText = new GlyphBatch(ctx.text, ctx.pages)
    this.contentImages = new ImageSet(this.su)
    this.contentPass.scene.add(panelMesh, poolMesh, this.contentImages.container)

    this.applySize()
  }

  /**
   * (Re)creates the glass draws for quality `q`, disposing the ones it replaces: the background slab's faces (its back
   * with `q.backFaces`, refracting the one screen capture; with `q.depthReject` both read one shared depth capture, so
   * a render copies the depth buffer once per Surface, not once per face) and the element glass's (its back with
   * `q.backFaces`, refracting the content RT over the screen capture where the content is transparent — through the
   * slab's frost on a glass Surface). The capture is shared, owned by the Surface: a rebuild never disposes it.
   */
  private buildGlass(q: QualitySettings): void {
    for (const m of this.glassMeshes) m.removeFromParent()
    for (const gm of this.glassMaterials) gm.dispose()
    this.glassMeshes.length = 0; this.glassMaterials.length = 0
    const slab = this.backgroundGlass, screen = this.screen
    if (slab && screen) {
      for (const [side, on] of [['back', q.backFaces], ['front', true]] as const) {
        if (!on) continue
        const depth = q.depthReject ? (this.depth ??= new DepthCapture()) : undefined
        const gm = createGlassMaterial({ geometry: slab.geometry, K: slab.K, backdrop: 'screen', side, surface: this.su, screen, depthReject: q.depthReject, depth })
        const mesh = new Mesh(slab.geometry, gm.material)
        mesh.renderOrder = SURFACE_ORDER.slab; mesh.frustumCulled = false   // at z = 0: its top face is the content plane
        this.layer.add(mesh); this.glassMeshes.push(mesh); this.glassMaterials.push(gm)
      }
    }
    for (const [side, order, on] of [['back', SURFACE_ORDER.glassBack, q.backFaces], ['front', SURFACE_ORDER.glassFront, true]] as const) {
      if (!on) continue
      const behind = !screen ? {} : slab ? { screen, screenLevel: SLAB_FROST.roughness * 8, screenLift: SLAB_FROST.roughness * 0.08 + SLAB_FROST.lift } : { screen }
      const gm = createGlassMaterial({ geometry: this.glass.geometry, K: this.glass.K, backdrop: 'panel', side, surface: this.su, content: this.contentPass.texture, ...behind })
      const mesh = new Mesh(this.glass.geometry, gm.material)
      mesh.renderOrder = order; mesh.frustumCulled = false; mesh.castShadow = true; mesh.receiveShadow = false
      this.plane.add(mesh); this.glassMeshes.push(mesh); this.glassMaterials.push(gm)
    }
  }

  /**
   * A quality change for this Surface: rebuilds the glass draws for `q`, switches the content RT's texel type and marks
   * the content dirty (the RT's size follows `q.contentScale` at the next `prepare`). A throw fails the Surface instead
   * of propagating. It leaves the shared `ctx.quality` alone: the root owns that (it is what new Surfaces start from),
   * replaces it on a tier change and then calls this on every Surface.
   */
  setQuality(q: QualitySettings): void {
    this.quality = q
    if (this.error) return
    try {
      this.buildGlass(q)
      this.contentPass.setType(q.contentType)
      this.contentDirty = true
    } catch (e) { this.fail(e) }
  }

  get root(): Node { return this.model.root }
  /** Units: 0, or the background slab's thickness (it follows the Surface size). */
  get contentPlaneZ(): number { return this.plane.position.z }
  /** This Surface's place among the others (the `layer` group's `renderOrder`): higher draws later. */
  get drawOrder(): number { return this.layer.renderOrder }
  set drawOrder(v: number) { this.layer.renderOrder = v }

  /** Surface size in pt; marks layout (the root's style size) and the content RT. */
  setSize(width: number, height: number): void {
    this.model.width = width; this.model.height = height
    this.root.setStyle({ width, height })
    this.applySize()
    this.contentDirty = true
  }

  private applySize(): void {
    const { width, height, ptPerUnit } = this.model
    const w = width / ptPerUnit, h = height / ptPerUnit
    this.su.size.value.set(w, h)
    this.contentMesh.scale.set(w, h, 1)
    if (this.backgroundGlass) {
      const thickness = Math.max(1, Math.min(width, height) * 0.05)   // pt; never 0 (the refraction divides by it)
      this.plane.position.z = thickness / ptPerUnit
      this.backgroundGlass.update([this.backgroundSlab(thickness)], this.model)
    }
  }

  /** The background slab: one glass instance over the Surface rect, a thin frosted sheet `thickness` pt thick. */
  private backgroundSlab(thickness: number): GlassInstance {
    const t = this.ctx.theme.glass, { width, height } = this.model
    const rect = { x: 0, y: 0, width, height }, radius = Math.min(this.model.cornerRadius, width / 2, height / 2)
    return {
      node: this.root, rect, radius, z: 0, elevation: 0, scale: 1, transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, tilt: { x: 0, y: 0 }, opacity: 1,
      params: {
        thickness, fillet: thickness * 0.3, filletBottom: 0, profile: 'fillet', scatter: 0.12, lift: SLAB_FROST.lift, edgeGlow: 0.3, ior: t.ior, dispersion: 0.3,
        roughness: SLAB_FROST.roughness, tint: null, absorption: 0, glow: null, cornerExponent: cornerExponentFor(rect, radius), envIntensity: t.envIntensity,
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
      } else {
        if (this.updateTouch(this.list)) this.glass.update(this.list.glass, this.model, this.touch)
        if (ctx.text.atlas.epoch !== this.seenEpoch) { this.fillText(this.parts); this.contentDirty = true }
      }
      // a texture changed under an image (a URL that loaded, a video frame): content images are in the RT, foreground
      // ones only need a frame
      if (this.contentImages.pollChanged()) this.contentDirty = true
      if (this.foregroundImages.pollChanged()) this.needsFrame = true
    } catch (e) { this.fail(e) }
  }

  private fill(list: RenderList, p: Partition): void {
    const s = this.model
    this.glass.update(list.glass, s, this.touch)
    this.panels.update(p.content.panels, s)
    this.pools.update(p.content.pools, s)
    this.rims.update(p.foreground.rims, s, d => liftFor(p, d.node))
    this.foregroundImages.update(p.foreground.images, s, i => liftFor(p, i.node), SURFACE_ORDER.images)
    this.contentImages.update(p.content.images, s, undefined, CONTENT_ORDER.images)
    this.fillText(p)
  }

  /**
   * Rebuilds the glyph quads from the last partition when the atlas epoch moved since they were built — the pages are
   * shared, so another Surface's glyphs may have evicted this one's after it ticked — and marks the content dirty. The
   * root calls it on every Surface when the epoch moved during its tick. True if it rebuilt.
   */
  refreshText(): boolean {
    if (this.error || !this.parts || this.ctx.text.atlas.epoch === this.seenEpoch) return false
    try {
      this.fillText(this.parts)
      this.contentDirty = true
      return true
    } catch (e) { this.fail(e); return false }
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
    this.syncGlyphMeshes(this.foregroundText, this.foregroundGlyphs, this.plane, SURFACE_ORDER.glyphs)
    this.syncGlyphMeshes(this.contentText, this.contentGlyphs, this.contentPass.scene, CONTENT_ORDER.glyphs)
  }

  /** One mesh per atlas page per batch, made when the page first has glyphs (a page batch is never dropped). */
  private syncGlyphMeshes(batch: GlyphBatch, meshes: Map<number, Mesh>, parent: Object3D, renderOrder: number): void {
    for (const [page, pb] of batch.perPage) {
      if (meshes.has(page)) continue
      const mesh = new Mesh(pb.geometry, this.own(createGlyphMaterial(pb.geometry, this.su, this.ctx.pages.textures[page]!)))
      mesh.renderOrder = renderOrder; mesh.frustumCulled = false
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
      const size = contentRTSize(projectedPx, dpr, { scale: this.quality.contentScale * this.contentScale })
      if (this.contentPass.resize(size.width, size.height)) this.contentDirty = true
      if (!this.contentDirty) return
      this.contentPass.setView(this.model)
      this.contentPass.render(renderer, this.contentClear)
      this.contentDirty = false
    } catch (e) { this.fail(e) }
  }

  private fail(e: unknown): void {
    this.error = e instanceof Error ? e : new Error(String(e))
    this.visible = false; this.needsFrame = false
    // a throwing listener must not escape the frame either
    try { this.dispatchEvent({ type: 'error', error: this.error }) } catch (le) { console.error('[glassui] an "error" listener threw:', le) }
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
    this.screen?.dispose(); this.depth?.dispose()
    this.contentMesh.geometry.dispose()
    this.removeFromParent()
  }
}
