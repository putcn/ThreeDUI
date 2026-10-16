import { AddEquation, Box3, Color, CustomBlending, Euler, Group, Mesh, Object3D, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, Quaternion, Vector2, Vector3, type Camera, type Material, type Object3DEventMap, type Texture } from 'three'
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial, type UniformNode } from 'three/webgpu'
import { bool, float, screenUV, texture, uniform, uv, vec2 } from 'three/tsl'
import {
  apply, buildRenderList, createSurface, effectiveStyle, EventDispatcher, FocusManager, GlassUIError, hitTest, PointerTracker, resolveColor,
  type AnimationRuntime, type ColorScheme, type GlassInstance, type LayoutEngine, type MeasureFn, type Node, type RenderList, type RGBA, type SurfaceModel, type Theme, type UIEventType,
} from '@glassui/core'
import type { TextEngine } from '@glassui/text'
import { GlassBatch, type TouchState } from '../glass/batch'
import { createGlassMaterial, DepthCapture, ScreenCapture, type GlassMaterial, type GlassMaterialOptions, type GlassMode } from '../glass/material'
import { FILL, fillTokens, SLAB_BEHIND, SLAB_FROST } from '../glass/frost'
import { PanelBatch, cornerExponentFor } from '../panel/batch'
import { createPanelMaterial } from '../panel/material'
import { DecorationBatch } from '../decoration/batch'
import { createPoolMaterial, createRimMaterial, createShadowMaterial, SHADOW_DECAL } from '../decoration/material'
import { GlyphBatch } from '../text/batch'
import { createGlyphMaterial } from '../text/material'
import type { AtlasPages } from '../text/pages'
import { ImageSet } from '../image/images'
import type { SurfaceUniforms } from '../flat'
import { ContentPass, contentRTSize, rtTarget, RT_SETTLE_FRAMES, type RendererLike } from './content'
import { checkOpacity, SurfaceMotion, type PoseSpring, type ResolvedPose, type SurfacePose } from './motion'
import { KawasePyramid } from '../blur/kawase'
import { SurfaceLuma } from '../luma'
import { liftFor, partition, splitNested, type Partition } from './partition'
import { StackPass } from './stack'
import { toColor } from '../color'
import { Viewport3DAttachment, type Attach3DOptions } from '../viewport'

export interface SurfaceOptions {
  id?: string; width: number; height: number; ptPerUnit?: number; placement?: 'screen' | 'world'; background?: 'none' | 'glass' | string; cornerRadius?: number; interactive?: boolean
  /** Spec §5.4: whether the Surface's glass also shadows world geometry. No effect yet (planned): the UI shadows only the UI. */
  castToWorld?: boolean
  /** Default 1: multiplies the content RT's texels per CSS px after the quality's floor (below 1 it may go under one texel per CSS px). */
  contentScale?: number
  /** Default false. A world Surface that turns to face the camera every tick (`Surface.billboard`); no effect on the screen layer. */
  billboard?: boolean
  /** Default true: whether the Surface shadows the UI (`Surface.castShadows`). */
  castShadows?: boolean
}
/** The quality knobs a Surface reads (`QualityProfile` in `quality.ts` extends it into a full tier). */
export interface QualitySettings {
  contentType: 'byte' | 'half'
  /**
   * Content RT texels per device px, as a cap on supersampling: the RT gets `dpr × max(contentScale, 1/dpr)` texels per
   * CSS px, never fewer than one (the content quad displays it), so a scale below 1 only bites above DPR 1.
   */
  contentScale: number
  backFaces: boolean; depthReject: boolean; blur: 'kawase' | 'mip'
  /**
   * How the glass sees its backdrop (`GlassMode`): `'refract'` (high, medium), `'straight'` (low: no refraction, no
   * dispersion, no depth reject), `'fill'` (minimal: a near-opaque frosted fill of the theme's `fill` colour; no
   * content, screen or depth sample, no luma pass, no blur pyramid, so a glass Surface copies no framebuffer).
   */
  glassMode: GlassMode
  /** `'refract'` only: `'never'` refracts once instead of per colour channel; `'auto'` (medium: disperse only above 0.25 px) is not implemented yet and disperses as `'always'`. */
  dispersion: 'always' | 'auto' | 'never'
}
/**
 * What every Surface of one root shares; `quality` is the root's current tier, the one new Surfaces start from. The root
 * replaces `theme`, `scheme`, `measure` and `contrast` (increased contrast: the 'fill' glass mode's solid black/white
 * fills, `fillColors`) in place, then has every Surface rebuild once: `restyle`, or `setQuality` when the change moved
 * the tier (every glass build reads the fill colours from here).
 */
export interface SurfaceContext { theme: Theme; scheme: ColorScheme; layout: LayoutEngine; measure: MeasureFn; anim: AnimationRuntime; text: TextEngine; pages: AtlasPages; quality: QualitySettings; contrast: boolean }
export interface SurfaceEventMap extends Object3DEventMap {
  /** The Surface failed (`markFailed`: a frame or a rebuild threw, or the root's render isolation blamed it). */
  error: { error: Error }
  /** `dispose` ran (once, after everything was freed). */
  dispose: object
}

/**
 * `renderOrder` of each draw inside a Surface's `layer`; images take [images, images + ½) in z order (`ImageSet`);
 * `innerGlass*`: nested glass (spatial spec §2.4), after the outer glass, which it sees in the stacked RT instead;
 * `viewport`: the 3D objects attached to its nodes (`Surface.attach3D`), over the rims and under what rides on glass.
 */
export const SURFACE_ORDER = { slab: -1, content: 0, glassBack: 1, glassFront: 2, innerGlassBack: 2.25, innerGlassFront: 2.5, rims: 3, viewport: 3.25, images: 3.5, glyphs: 4 } as const
export { SLAB_FROST } from '../glass/frost'
/** `renderOrder` of each draw inside the content RT's scene. */
export const CONTENT_ORDER = { panels: 0, shadows: 0.5, pools: 1, images: 1.5, glyphs: 2 } as const

/**
 * How far (pt, per component) the tallest drop shadow's offset must move before the content RT redraws for a new light
 * direction (spatial spec §11.7; `Surface.setLightDirection`).
 */
const SHADOW_REDRAW_PT = 0.5
/** The drop shadows' alpha in `scheme` (`SHADOW_DECAL`). */
const shadowAlpha = (scheme: ColorScheme): number => scheme === 'dark' ? SHADOW_DECAL.alphaDark : SHADOW_DECAL.alphaLight

/**
 * What is behind a `'none'` Surface: no slab, so no frost of its own — no lift, and no level floor (its element glass
 * reads it at the glass's own roughness level, as it reads the content; the luma at its tap grid's level).
 */
const NO_FROST = { level: 0, lift: 0 } as const

const blankPose = (): ResolvedPose => ({ position: new Vector3(), quaternion: new Quaternion(), scale: new Vector3(1, 1, 1), opacity: 1 })

/** Element handler types (`Node.handlers`) that make a node take the pointer on a `'none'` Surface. */
const POINTER_HANDLERS: readonly UIEventType[] = ['pointerdown', 'pointerup', 'pointermove', 'pointerenter', 'pointerleave', 'click', 'dblclick', 'contextmenu', 'wheel']

/**
 * Whether `n` paints (glass, text, an image, a background other than `'none'`, a border) or is interactive (a `scroll`
 * node, whose gaps still catch the wheel and drags; a finite `tabIndex`, read as the focus manager reads it; or an
 * element handler for a pointer type). Never a `pointerEvents: 'box-none'` node: it is not a pointer target itself, so
 * neither its paint nor its scrolling claims the pointer (its children still can).
 */
function paintedOrInteractive(n: Node): boolean {
  const s = effectiveStyle(n)
  if (s.pointerEvents === 'box-none') return false
  if (n.type === 'glass' || n.type === 'text' || n.type === 'image' || n.type === 'scroll') return true
  if ((s.bg !== undefined && s.bg !== 'none') || s.border !== undefined) return true
  const t = n.props.tabIndex
  if (Number.isFinite(typeof t === 'number' || (typeof t === 'string' && t.trim() !== '') ? Number(t) : NaN)) return true
  return POINTER_HANDLERS.some(h => n.handlers.has(h))
}

/**
 * The `'fill'` glass mode's colours, linear: the background slab's, the element glass's and its border's; `alpha`, the
 * fill's alpha over the lit shell (the material's `fillAlpha`).
 */
export interface FillColors { slab: Color; glass: Color; border: Color; alpha: number }

/**
 * The `'fill'` glass mode's colours from the theme's tokens for `scheme` (spec §5.6, minimal; see `FILL`): the slab
 * fills with `fill` (the card is distinct from the host scene); element glass with `fill` moved `FILL.labelMix` toward
 * `label` in sRGB (a shade darker on a light card, lighter on a dark one) and a `tertiaryLabel` border. A theme missing
 * one of the tokens gets the default light theme's value for it instead of failing every Surface.
 *
 * `opts.contrast` (increased contrast, spec §8.3: black/white solid + border): the slab and the element glass fill pure
 * white (light) or black (dark), solid (alpha 1 instead of `FILL.alpha`), and the border is the `label` token. Glass
 * with a glow or tint still fills with that colour (the material's rule), solid too: a coloured control keeps its colour.
 */
export function fillColors(theme: Theme, scheme: ColorScheme, opts: { contrast?: boolean } = {}): FillColors {
  const t = fillTokens(theme, scheme)
  if (opts.contrast) {
    const solid: RGBA = scheme === 'light' ? [1, 1, 1, 1] : [0, 0, 0, 1]
    return { slab: toColor(solid), glass: toColor(solid), border: toColor(t.label), alpha: 1 }
  }
  return { slab: toColor(t.fill), glass: toColor(t.glass), border: toColor(t.border), alpha: FILL.alpha }
}

/**
 * The content quad's material: the content RT on the Surface plane, lit (it receives the glass's shadows) but not
 * shadow-casting. The RT holds premultiplied colour (see `ContentPass`), so it composites premultiplied: source factor
 * One (the colour already carries its alpha), alpha "over"; the alpha test (α ≤ 0.02) discards the empty texels, so the
 * depth the quad writes stays on its content. `su.opacity` (the whole Surface's) fades it: premultiplied, it scales the
 * colour and the alpha alike.
 *
 * Orientation: three's render-target textures have v = 0 at the image's TOP row on both backends (WebGPU natively; the
 * GLSL builder flips render-target reads to match), while the quad's `PlaneGeometry` uv has v = 1 at its top edge, so
 * the quad samples at (u, 1 − v). (`texture(tex, uv)` rather than `.sample(uv)`: no uv-matrix uniform.)
 */
export function createContentMaterial(content: Texture, su?: SurfaceUniforms): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 })
  const sample = texture(content, vec2(uv().x, uv().y.oneMinus()))
  const fade = su?.opacity ?? float(1)
  m.colorNode = sample.rgb.mul(fade)
  m.opacityNode = sample.a.mul(fade)
  m.transparent = true; m.depthWrite = true; m.alphaTest = 0.02; m.toneMapped = false
  m.blending = CustomBlending; m.premultipliedAlpha = false
  m.blendEquation = AddEquation; m.blendSrc = OneFactor; m.blendDst = OneMinusSrcAlphaFactor
  m.blendEquationAlpha = AddEquation; m.blendSrcAlpha = OneFactor; m.blendDstAlpha = OneMinusSrcAlphaFactor
  return m
}

/**
 * The draw that makes a `'none'` Surface's behind-capture copy the framebuffer before its content quad. three copies at
 * the first draw of a frame that samples the capture; this one samples it (sampling is what schedules the copy:
 * `updateBefore`) at the slab's place in the order, and writes nothing (no colour, no depth).
 * three's WebGL backend does not reset `colorMask` on clear: the content quad (colour-writing, next in the same group) restores it — keep it so.
 */
function createCaptureProbe(capture: ScreenCapture): Mesh<PlaneGeometry, MeshBasicNodeMaterial> {
  const m = new MeshBasicNodeMaterial()
  m.colorNode = capture.sample(screenUV).rgb
  m.opacityNode = float(0)
  m.colorWrite = false; m.depthWrite = false; m.depthTest = false; m.transparent = true; m.toneMapped = false
  const probe = new Mesh(new PlaneGeometry(1e-3, 1e-3), m)
  probe.renderOrder = SURFACE_ORDER.slab; probe.frustumCulled = false
  probe.name = 'capture-probe'
  return probe
}

/**
 * Spec §3.2: a content face in 3D, in Surface-local units (centred, y up; its own position/quaternion/scale place it).
 *
 * Draws (all `frustumCulled = false`, orders in `SURFACE_ORDER`): background slab back/front (`background: 'glass'`
 * only, refracting the screen) — or, on a `'none'` Surface while it has glass to see through, the capture probe in
 * their place (`createCaptureProbe`) — the content quad, the glass back (with `quality.backFaces`) and front refracting the
 * content RT, rims, then the images and glyphs riding on glass. The content RT's scene (`CONTENT_ORDER`), drawn
 * orthographically with the same Surface-local instance matrices: panels, the drop shadows of raised glass (spatial spec
 * §11.7: `createShadowMaterial`, along the key light the root hands over each tick, `setLightDirection`), pools,
 * images, glyphs (one mesh per page).
 * With `quality.blur === 'kawase'` the content RT also feeds a `KawasePyramid`, which the element glass samples by
 * roughness instead of the RT's mips; with clear + adaptive glass, a luma pass (`SurfaceLuma`) for its darkening.
 * `quality.glassMode` picks how all of this glass sees its backdrop (`GlassMode`): refracted, straight through, or not
 * at all (the minimal tier's frosted fill: no luma, no pyramid, no capture copied).
 *
 * Every draw lives under `layer`, a `Group` whose `renderOrder` is `drawOrder`: three sorts by the nearest group's order
 * first, so Surfaces draw one after another (the root sets `drawOrder`, nearer = higher) instead of layer by layer
 * across Surfaces. No `Group` sits below it whose `renderOrder` is not `drawOrder` too (the 3D attachments' anchors and
 * the Groups in their objects carry it). The glass material takes its mesh-local z = 0 as the content plane, so
 * everything on that plane is a child of `plane` (an `Object3D` at z = `contentPlaneZ`: the background slab's
 * thickness, 0 without one) and instance matrices stay plane-relative.
 *
 * Motion (spatial spec §2.1): `animateTo` springs a world Surface's position, rotation, scale and opacity (a screen
 * Surface's opacity only; `SurfaceMotion`), stepped by the root every tick (`stepMotion`) before it reads a matrix.
 * `opacity` fades the whole Surface: every draw on its plane multiplies its alpha by it (`su.opacity`), the content
 * pass's draws never (the RT is faded once, on its quad). Below 1 the content quad writes no depth; at 0, or while the
 * root has `culled` it (out of view), `layer` is hidden: nothing draws, captures or takes the pointer.
 *
 * Nested glass (spatial spec §2.4): glass inside glass is split off into `innerGlass` (`splitNested`), drawn after the
 * outer glass; while there is some and the glass mode samples a backdrop, a stacked RT (`stack`) holds the content RT
 * with the outer glass drawn over it as translucent panels, and the inner glass sees that instead of the content.
 *
 * 3D viewports (spatial spec §2.3): `attach3D` hangs a three.js object off a node of a world Surface, on an anchor in
 * `plane` that every `tick` places at the node's box (`Viewport3DAttachment`); it fades with `opacity`, raises
 * `glassBounds` by its `depth`, and the pointer hits it with the content quad (`hitSurfaces`).
 */
export class Surface extends Object3D<SurfaceEventMap> {
  readonly model: SurfaceModel
  readonly events = new EventDispatcher()
  readonly pointer: PointerTracker
  readonly focus: FocusManager
  /** The raycast target: its uv → Surface pt via `pointFromUV`. */
  readonly contentMesh: Mesh
  readonly contentPass: ContentPass
  /** The element glass; with nested glass, the outer level only (`innerGlass` holds the rest). */
  readonly glass = new GlassBatch()
  /** Glass inside other glass (spatial spec §2.4; `splitNested`): it sees the outer glass through `stack`. No luma index. */
  readonly innerGlass = new GlassBatch()
  readonly panels = new PanelBatch()
  readonly rims = new DecorationBatch('rim')
  readonly pools = new DecorationBatch('pool')
  /** The drop shadows of raised glass (spatial spec §11.7), in the content RT. */
  readonly shadows = new DecorationBatch('shadow')
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
  /** `castShadows`: the casters as set, and the element glass draws (the casters among `glassMeshes`). */
  private casts: boolean
  private readonly casters: Mesh[] = []
  /** `SurfaceOptions.castToWorld`: no effect yet (planned). */
  castToWorld: boolean
  /**
   * A world Surface that faces the camera: each root `tick` sets its world rotation to the camera's before reading its
   * matrices (`SurfaceOptions.billboard`). Ignored on the screen layer, which faces the camera already.
   */
  billboard: boolean
  /**
   * Keyboard focus stays in this Surface (a modal dialog): Tab past the last focusable wraps to the first (Shift+Tab
   * before the first: to the last) instead of leaving the canvas (`PointerBridge`). Default false.
   */
  trapFocus = false
  /** Set when the Surface failed (`markFailed`): it stops drawing (`visible = false`) and has emitted `{ type: 'error', error }`. */
  error: Error | null = null
  /** True while animating. */
  needsFrame = false
  /** The content RT must be redrawn (`prepare` does it). */
  contentDirty = true
  private readonly ctx: SurfaceContext
  /** The plane draws' uniforms, the Surface's opacity included. */
  private readonly su: Required<SurfaceUniforms>
  /** The content pass's: `su` without the opacity (the RT is faded once, on its quad). */
  private readonly suContent: SurfaceUniforms
  /**
   * The drop shadows' offset per pt of elevation (pt, y down), shared by all of them, as the content RT was last drawn
   * (`prepare` copies `lightDir` into it on every redraw): straight in front (none) until the first; and their alpha,
   * the scheme's.
   */
  private readonly shadowDir = uniform(new Vector2())
  private readonly shadowAlpha: UniformNode<'float', number>
  /** The latest light direction as a shadow offset per pt of elevation (`setLightDirection`), drawn or not yet. */
  private readonly lightDir = new Vector2()
  private readonly motion: SurfaceMotion
  /** `opacity` and `culled`. */
  private fade = 1
  private hidden = false
  /** `prepare`s since the Surface or the camera last moved (capped at `RT_SETTLE_FRAMES`); whether one has sized the RT. */
  private stillFrames = 0
  private sized = false
  /** Scratch poses: the Object3D's own (`pose`) and where its motion ends (`restPose`). */
  private readonly now = blankPose()
  private readonly resting = blankPose()
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
  /** A glass Surface's framebuffer capture (null otherwise): the slab refracts it, element glass sees it under transparent content. */
  private readonly screen: ScreenCapture | null = null
  /**
   * A `'none'` Surface's capture of what is behind it, while it has glass in a mode that samples a backdrop (null
   * otherwise): element glass sees it under transparent content. `captureProbe` takes it before the content quad.
   */
  private behindCapture: ScreenCapture | null = null
  private captureProbe: Mesh<PlaneGeometry, MeshBasicNodeMaterial> | null = null
  /** A glass Surface's depth capture for `depthReject`, shared by the slab's faces and the element glass (one depth copy per render); made on first use. */
  private depth: DepthCapture | null = null
  /** The content RT's blur pyramid on the 'kawase' tier (null otherwise), redrawn with it while there is glass to sample it. */
  private pyramid: KawasePyramid | null = null
  /** The pyramid holds the current content RT's blur (false after a redraw that had no glass to draw it for). */
  private pyramidCurrent = false
  /** The stacked RT the inner glass samples, while there is nested glass in a glass mode that samples a backdrop (`syncStack`). */
  private stackPass: StackPass | null = null
  /** The inner glass draws (`buildGlass`): shown only while `innerGlass` has instances, so a Surface without nesting never builds their shader. */
  private innerMeshes: Mesh[] = []
  /** Clear + adaptive glass's backdrop luma (spec §5.3), measured from the content RT after it in `prepare`. */
  private readonly luma = new SurfaceLuma()
  /** The last `tick`'s dt (s): the luma's smoothing step. */
  private lastDt = 1 / 60
  private pointerPt: [number, number] | null = null
  private list: RenderList | null = null
  private parts: Partition | null = null
  /** `list.glass` split by nesting (`splitNested`): what `glass` and `innerGlass` hold. */
  private nested: { outer: GlassInstance[]; inner: GlassInstance[] } | null = null
  /** The atlas epoch the glyph batches were last built at (the pages are shared: another Surface may have seen the change). */
  private seenEpoch: number
  private isDisposed = false
  private readonly attachments = new Map<Node, Viewport3DAttachment>()

  constructor(opts: SurfaceOptions, ctx: SurfaceContext) {
    super()
    this.ctx = ctx
    this.model = createSurface(opts)
    this.name = this.model.id
    this.interactive = opts.interactive ?? true
    this.castToWorld = opts.castToWorld ?? false
    this.casts = opts.castShadows ?? true
    this.billboard = opts.billboard ?? false
    this.contentScale = opts.contentScale ?? 1
    this.pointer = new PointerTracker(this.model.root, this.events, ctx.theme)
    this.focus = new FocusManager(this.model.root, this.events)
    this.su = { size: uniform(new Vector2()), ptPerUnit: uniform(this.model.ptPerUnit), opacity: uniform(1) }
    this.suContent = { size: this.su.size, ptPerUnit: this.su.ptPerUnit }
    this.shadowAlpha = uniform(shadowAlpha(ctx.scheme))
    this.motion = new SurfaceMotion(ctx.theme)
    this.quality = ctx.quality
    this.contentPass = new ContentPass({ type: this.quality.contentType })
    this.seenEpoch = ctx.text.atlas.epoch

    this.add(this.layer)
    const bg = this.model.background
    if (bg === 'glass') {
      // one framebuffer capture, kept across quality rebuilds. The slab is this Surface's first draw and samples it, so
      // it is taken before any of this Surface's draws; element glass then shares it (no second copy) to see what is
      // behind the slab where the content RT is transparent. A 'none' Surface takes one only while it has glass
      // (`syncBehind`), so without glass it never pays a framebuffer copy
      this.screen = new ScreenCapture()
      this.backgroundGlass = new GlassBatch()
    } else if (bg !== 'none') {
      // opaque: a clear must be (0,0,0)@0 or opaque to stay premultiplied on both backends (WebGL premultiplies it)
      toColor(resolveColor(bg, ctx.theme, ctx.scheme), this.contentClear.color); this.contentClear.alpha = 1
    }
    this.layer.add(this.plane)

    this.contentMesh = new Mesh(new PlaneGeometry(1, 1), this.own(createContentMaterial(this.contentPass.texture, this.su)))
    this.contentMesh.receiveShadow = true; this.contentMesh.castShadow = false; this.contentMesh.renderOrder = SURFACE_ORDER.content; this.contentMesh.frustumCulled = false
    // the raycast hit's way back to its Surface; not enumerable, so `toJSON`/`clone` (which stringify userData) skip the cycle
    Object.defineProperty(this.contentMesh.userData, 'surface', { value: this, enumerable: false })
    this.plane.add(this.contentMesh)
    this.maskContentShadow()

    this.syncPyramid(this.quality)
    this.buildGlass(this.quality)
    const rimMesh = new Mesh(this.rims.geometry, this.own(createRimMaterial(this.rims.geometry, this.su)))
    rimMesh.renderOrder = SURFACE_ORDER.rims; rimMesh.frustumCulled = false
    this.plane.add(rimMesh)
    this.foregroundText = new GlyphBatch(ctx.text, ctx.pages)
    this.foregroundImages = new ImageSet(this.su)
    this.plane.add(this.foregroundImages.container)

    const panelMesh = new Mesh(this.panels.geometry, this.own(createPanelMaterial(this.panels.geometry, this.suContent)))
    panelMesh.renderOrder = CONTENT_ORDER.panels; panelMesh.frustumCulled = false
    const shadowMesh = new Mesh(this.shadows.geometry, this.own(createShadowMaterial(this.shadows.geometry, this.suContent, this.shadowDir, this.shadowAlpha)))
    shadowMesh.renderOrder = CONTENT_ORDER.shadows; shadowMesh.frustumCulled = false
    const poolMesh = new Mesh(this.pools.geometry, this.own(createPoolMaterial(this.pools.geometry, this.suContent)))
    poolMesh.renderOrder = CONTENT_ORDER.pools; poolMesh.frustumCulled = false
    this.contentText = new GlyphBatch(ctx.text, ctx.pages)
    this.contentImages = new ImageSet(this.suContent)
    this.contentPass.scene.add(panelMesh, shadowMesh, poolMesh, this.contentImages.container)

    this.applySize()
  }

  /**
   * (Re)creates the glass draws for quality `q`, disposing the ones it replaces: the background slab's faces (its back
   * with `q.backFaces`, refracting the one screen capture; with `q.depthReject` both read one shared depth capture, so
   * a render copies the depth buffer once per Surface, not once per face) and the element glass's (its back with
   * `q.backFaces`, refracting the content RT). On a glass Surface element glass also sees the slab's screen capture,
   * through the slab's frost, where the content is transparent, and with `q.depthReject` reads the slab's depth capture
   * too (no further copy); on a 'none' Surface it sees the behind-capture there (`syncBehind`; at the glass's own
   * roughness level, as it sees the content, with no lift and no depth reject), or, without one, refracts the content
   * RT alone. The captures are owned by the Surface: a rebuild never disposes them.
   *
   * `q.glassMode` (`GlassMode`): `'straight'` looks through the same backdrops unrefracted, with no depth reject (and no
   * depth capture); `'fill'` hands no backdrop to any draw (the theme's fill colour instead), so while it lasts no draw
   * references the captures and three copies nothing; the next rebuild to another mode references them again.
   */
  private buildGlass(q: QualitySettings): void {
    for (const m of this.glassMeshes) m.removeFromParent()
    for (const gm of this.glassMaterials) gm.dispose()
    this.glassMeshes.length = 0; this.glassMaterials.length = 0; this.casters.length = 0
    const slab = this.backgroundGlass, screen = this.screen, mode = q.glassMode
    // the 'fill' mode's colours, from the shared context as it is now (a quality change after a contrast change sees it)
    const fills = fillColors(this.ctx.theme, this.ctx.scheme, { contrast: this.ctx.contrast })
    const optics = { mode, dispersion: q.dispersion !== 'never', fillAlpha: fills.alpha }
    const reject = q.depthReject && mode === 'refract'
    const depth = slab && screen && reject ? (this.depth ??= new DepthCapture()) : undefined
    if (slab && screen) {
      for (const [side, on] of [['back', q.backFaces], ['front', true]] as const) {
        if (!on) continue
        const backdrop = mode === 'fill' ? {} : { screen, depthReject: reject, depth }
        const gm = createGlassMaterial({ geometry: slab.geometry, K: slab.K, backdrop: 'screen', side, surface: this.su, ...backdrop, ...optics, fill: fills.slab })
        const mesh = new Mesh(slab.geometry, gm.material)
        mesh.renderOrder = SURFACE_ORDER.slab; mesh.frustumCulled = false   // at z = 0: its top face is the content plane
        this.layer.add(mesh); this.glassMeshes.push(mesh); this.glassMaterials.push(gm)
      }
    }
    // what is behind the content plane, captured before any of this Surface's content: on a glass Surface the slab's
    // captures (the slab is its first draw), through its frost; on a 'none' one the probe's (at the slab's place),
    // frosted by the glass's own roughness alone (no `screenLevel`: the material's default, the content's level)
    const behind = mode === 'fill' ? {}
      : slab && screen ? { screen, screenLevel: SLAB_BEHIND.level, screenLift: SLAB_BEHIND.lift, depthReject: reject, ...(depth ? { depth } : {}) }
        : this.behindCapture ? { screen: this.behindCapture, screenLift: NO_FROST.lift }
          : {}
    /** One batch's element-glass draws (its back with `q.backFaces`, its front) at `orders`, refracting `source`. */
    const draws = (batch: GlassBatch, orders: readonly [number, number], source: Pick<GlassMaterialOptions, 'content' | 'pyramid'>) => {
      const made: { mesh: Mesh; gm: GlassMaterial }[] = []
      for (const [side, order, on] of [['back', orders[0], q.backFaces], ['front', orders[1], true]] as const) {
        if (!on) continue
        const gm = createGlassMaterial({ geometry: batch.geometry, K: batch.K, backdrop: 'panel', side, surface: this.su, ...source, ...behind, ...optics, fill: fills.glass, border: fills.border })
        const mesh = new Mesh(batch.geometry, gm.material)
        mesh.renderOrder = order; mesh.frustumCulled = false; mesh.castShadow = this.casts; mesh.receiveShadow = false
        this.plane.add(mesh); this.glassMeshes.push(mesh); this.casters.push(mesh); this.glassMaterials.push(gm); made.push({ mesh, gm })
      }
      return made
    }
    const element = draws(this.glass, [SURFACE_ORDER.glassBack, SURFACE_ORDER.glassFront], { content: this.contentPass.texture, pyramid: this.pyramid?.textures })
    this.luma.attach(element.map(d => d.gm))   // the slab's luma index is −1, the inner glass's too: only the outer element glass reads it
    // nested glass: the stacked RT and its mips (no pyramid), or without one (the 'fill' mode) the content RT, as the outer glass
    const stack = this.stackPass
    const inner = draws(this.innerGlass, [SURFACE_ORDER.innerGlassBack, SURFACE_ORDER.innerGlassFront], stack ? { content: stack.texture } : { content: this.contentPass.texture, pyramid: this.pyramid?.textures })
    this.innerMeshes = inner.map(d => d.mesh)
    this.showInner()
  }

  /** The inner glass draws are shown while there is nested glass: hidden, three never builds their shader. */
  private showInner(): void { for (const m of this.innerMeshes) m.visible = this.innerGlass.buffer.count > 0 }

  /**
   * Makes (on 'kawase', in the content's texel type) or drops the blur pyramid (also in the 'fill' glass mode, which
   * samples no backdrop); before `buildGlass`, which hands it to the glass.
   */
  private syncPyramid(q: QualitySettings): void {
    if (q.blur !== 'kawase' || q.glassMode === 'fill') { this.pyramid?.dispose(); this.pyramid = null }
    else if (this.pyramid) this.pyramid.setType(q.contentType)
    else this.pyramid = new KawasePyramid(4, q.contentType)   // spec §5.6: 4 levels
  }

  /**
   * A 'none' Surface's capture of what is behind it (and its probe): made while it has glass to show it through and the
   * glass mode samples a backdrop (`wanted`), dropped when not; a no-op on other backgrounds. True when it appeared or
   * went away: the element glass must then be rebuilt (`buildGlass`) to sample it, or to stop sampling it.
   */
  private syncBehind(wanted: boolean): boolean {
    if (this.model.background !== 'none' || wanted === (this.behindCapture !== null)) return false
    if (wanted) {
      this.behindCapture = new ScreenCapture()
      this.captureProbe = createCaptureProbe(this.behindCapture)
      this.layer.add(this.captureProbe)
    } else this.dropBehind()
    return true
  }

  /** Frees the behind-capture and its probe, if any. */
  private dropBehind(): void {
    const probe = this.captureProbe
    if (probe) { probe.removeFromParent(); probe.material.dispose(); probe.geometry.dispose() }
    this.behindCapture?.dispose()
    this.captureProbe = null; this.behindCapture = null
  }

  /**
   * The stacked RT (spatial spec §2.4; `StackPass`): made while the Surface has nested glass and the glass mode samples
   * a backdrop (`wanted`), in the content's texel type and filled from the last paint at once; dropped (freed) when not.
   * True when it appeared or went away: the glass must then be rebuilt (`buildGlass`) for the inner glass to sample
   * it, or to sample the content RT again.
   */
  private syncStack(wanted: boolean): boolean {
    if (wanted === (this.stackPass !== null)) return false
    if (wanted) {
      this.stackPass = new StackPass(this.contentPass.texture, this.suContent, { type: this.quality.contentType, text: this.ctx.text, pages: this.ctx.pages })
      if (this.parts) this.fillStack(this.parts)
    } else { this.stackPass?.dispose(); this.stackPass = null }
    return true
  }

  /**
   * A quality change for this Surface: rebuilds the glass draws for `q` (and the blur pyramid for `q.blur`; a 'none'
   * Surface's behind-capture and the stacked RT, which the 'fill' glass mode drops; the rims when it enters or leaves the
   * 'fill' glass mode), switches the content RT's texel type (and the stacked RT's) and marks the content dirty (the
   * RT's size follows `q.contentScale` at the next `prepare`). A throw fails the Surface instead of propagating; a failed
   * or disposed Surface only records `q`. It leaves the shared `ctx.quality` alone: the root owns that (it is what new
   * Surfaces start from), replaces it on a tier change and then calls this on every Surface.
   */
  setQuality(q: QualitySettings): void {
    const wasFill = this.quality.glassMode === 'fill'
    this.quality = q
    if (this.error || this.isDisposed) return
    try {
      this.syncPyramid(q)
      this.syncBehind(this.glass.buffer.count > 0 && q.glassMode !== 'fill')
      this.syncStack(this.innerGlass.buffer.count > 0 && q.glassMode !== 'fill')
      this.buildGlass(q)
      this.contentPass.setType(q.contentType); this.stackPass?.setType(q.contentType)
      if (this.parts && wasFill !== (q.glassMode === 'fill')) this.fillRims(this.parts)
      this.contentDirty = true
    } catch (e) { this.markFailed(e) }
  }

  /**
   * Re-reads the theme, the scheme and increased contrast from the shared context (the root changed them): the pointer
   * tracker's and the motion's theme (its spring presets), the 'fill' glass mode's colours, an opaque background's clear
   * colour, the drop shadows' alpha (`SHADOW_DECAL`, by scheme), the background slab (its optics come from
   * `theme.glass`), the glass draws (rebuilt through `buildGlass`, so a 'none' Surface keeps its behind-capture and a
   * glass one its screen capture), and every node marked for layout, paint and text (a text style's size and colour may
   * come from the theme) with the content redrawn. A throw fails the
   * Surface instead of propagating; a failed or disposed Surface ignores it.
   */
  restyle(): void {
    if (this.error || this.isDisposed) return
    try {
      const { theme, scheme } = this.ctx
      this.pointer.theme = theme; this.motion.theme = theme
      const bg = this.model.background
      if (bg !== 'glass' && bg !== 'none') { toColor(resolveColor(bg, theme, scheme), this.contentClear.color); this.contentClear.alpha = 1 }
      this.shadowAlpha.value = shadowAlpha(scheme)
      this.applySize()
      this.buildGlass(this.quality)
      this.root.walk(n => { n.markDirty('layout'); n.markDirty('paint'); n.markDirty('text') })
      this.contentDirty = true
    } catch (e) { this.markFailed(e) }
  }

  get root(): Node { return this.model.root }
  /** The stacked RT the inner glass samples (spatial spec §2.4), or null: no nested glass, or the 'fill' glass mode. */
  get stack(): StackPass | null { return this.stackPass }
  /** Units: 0, or the background slab's thickness (it follows the Surface size). */
  get contentPlaneZ(): number { return this.plane.position.z }
  /**
   * This Surface's place among the others (the `layer` group's `renderOrder`): higher draws later. The 3D attachments'
   * Groups carry it too (`Viewport3DAttachment.groupOrder`), so their objects sort among this Surface's draws.
   */
  get drawOrder(): number { return this.layer.renderOrder }
  set drawOrder(v: number) {
    this.layer.renderOrder = v
    for (const a of this.attachments.values()) a.groupOrder = v
  }

  /**
   * The whole Surface's visual opacity, 0–1 (default 1): every draw on its plane multiplies its alpha by it. Setting it
   * jumps (a running opacity animation carries on from its own value at the next `stepMotion`). Below 1 the content quad
   * writes no depth (a fading Surface must not punch holes into what draws after it); at 0 `layer` is hidden. Anything
   * outside [0, 1] throws a readable `GlassUIError`.
   */
  get opacity(): number { return this.fade }
  set opacity(v: number) { checkOpacity('Surface.opacity', v); this.fade = v; this.applyFade() }
  /** Out of the camera's view: the root sets it on every world Surface each tick; `layer` is hidden while it is true. */
  get culled(): boolean { return this.hidden }
  set culled(v: boolean) { this.hidden = v; this.applyFade() }

  private applyFade(): void {
    this.su.opacity.value = this.fade
    ;(this.contentMesh.material as Material).depthWrite = this.fade >= 1
    this.layer.visible = this.fade > 0 && !this.hidden
  }

  /**
   * Springs the channels `target` names (spatial spec §2.1; `SurfaceMotion`): position (world units), rotation (an XYZ
   * Euler, radians; along the short arc), scale and opacity; the root steps them every tick. Default spring
   * `POSE_SPRING`; `spring` takes a theme preset, `{ response, dampingFraction }` or a `SpringConfig`. A retarget keeps
   * the named channels' velocity and ends the older call's promise `false`; the promise resolves `true` when all of
   * the call's channels settle. `immediate` (or `anim.reducedMotion` now) writes the end pose at the next step and
   * resolves `true` then. On a failed or disposed Surface it resolves `false` at once. A screen Surface may animate
   * `opacity` only (the screen layer places it); a position, rotation or scale throws, as does a bad pose or spring
   * (a readable `GlassUIError`).
   */
  animateTo(target: SurfacePose, opts: { spring?: PoseSpring; immediate?: boolean } = {}): Promise<boolean> {
    if (this.error || this.isDisposed) return Promise.resolve(false)
    if (this.model.placement === 'screen' && (target.position !== undefined || target.rotation !== undefined || target.scale !== undefined)) {
      throw new GlassUIError('Surface.animateTo', '屏幕层 Surface 只能动画 opacity：位置与缩放由屏幕层摆放')
    }
    return this.motion.to(target, this.pose(), { ...opts, immediate: opts.immediate === true || this.ctx.anim.reducedMotion })
  }

  /**
   * Advances the running animation by `dt` s and writes it into `position`, `quaternion`, `scale` and `opacity`; the
   * root calls it every tick, before it reads any matrix. True while some channel still moves; false (doing nothing)
   * when none does, or on a failed or disposed Surface.
   */
  stepMotion(dt: number): boolean {
    if (this.error || this.isDisposed || !this.motion.active) return false
    const p = this.pose(), more = this.motion.step(dt, p)
    this.position.copy(p.position); this.quaternion.copy(p.quaternion); this.scale.copy(p.scale)
    if (p.opacity !== this.fade) this.opacity = p.opacity
    return more
  }

  /**
   * Where the running animation ends (the current pose for the channels not moving): what a camera aims at while the
   * Surface is still on its way. Fresh arrays; `rotation` is the XYZ Euler of the target quaternion.
   */
  get restPose(): { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number]; opacity: number } {
    const r = this.motion.rest(this.pose(), this.resting), e = new Euler().setFromQuaternion(r.quaternion)
    return { position: [r.position.x, r.position.y, r.position.z], rotation: [e.x, e.y, e.z], scale: [r.scale.x, r.scale.y, r.scale.z], opacity: r.opacity }
  }

  /** The Object3D's own position, quaternion and scale and the current opacity, in the scratch pose `now`. */
  private pose(): ResolvedPose {
    const p = this.now
    p.position.copy(this.position); p.quaternion.copy(this.quaternion); p.scale.copy(this.scale); p.opacity = this.fade
    return p
  }

  /** Surface size in pt; marks layout (the root's style size) and the content RT. A no-op on a disposed Surface. */
  setSize(width: number, height: number): void {
    if (this.isDisposed) return
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

  /**
   * The world position of Surface pt (x, y) on its content plane (the content quad: a unit plane scaled to the Surface,
   * at z = `contentPlaneZ`), written into `target`. Brings the quad's world matrix up to date first (three's
   * `localToWorld` does).
   */
  worldFromPoint(x: number, y: number, target: Vector3): Vector3 {
    const { width: w, height: h } = this.model
    return this.contentMesh.localToWorld(target.set(x / w - 0.5, 0.5 - y / h, 0))
  }

  /** The node under (x, y) Surface pt in this Surface's tree, or null (core `hitTest` with the Surface's theme). */
  hitNode(x: number, y: number): Node | null { return hitTest(this.model.root, x, y, this.ctx.theme) }

  /**
   * Whether a pointer at (x, y) Surface pt belongs to this Surface: always on a glass or coloured background (the
   * panel is UI); on a 'none' one only where some node on the path from the hit node up to the root paints or is
   * interactive (`paintedOrInteractive`; a `pointerEvents: 'box-none'` node never is). So a full-screen HUD — bare root,
   * full-size layout wrappers and all — lets the pointer through its empty areas to what is behind it (other Surfaces,
   * then the host app); so does a full-screen `scroll` set to `'box-none'`, except over painted or interactive content.
   */
  takesPointer(x: number, y: number): boolean {
    if (this.model.background !== 'none') return true
    for (let n = this.hitNode(x, y); n; n = n.parent) {
      if (paintedOrInteractive(n)) return true
      if (n === this.model.root) break
    }
    return false
  }

  /** The pointer's position on this Surface (pt), or null when it is elsewhere: where a press glows (the bridge sets it). */
  setPointer(pt: [number, number] | null): void { this.pointerPt = pt }

  /**
   * The key light's direction (toward it) in this Surface's own frame (x right, y up, z out of its face), normalised;
   * the root hands it over every tick (spatial spec §11.7). The drop shadows fall `(−x / z, y / z)` pt per pt of
   * elevation (y down), z taken as at least 0.1 (a grazing light, or one from behind, stays bounded; the shader clamps
   * the offset further). It marks the content dirty when the tallest shadow's offset (`shadows.maxElevation`) would move
   * more than `SHADOW_REDRAW_PT` in either component from what the content RT was last drawn with; a smaller move waits
   * (a slow drift adds up against the drawn direction), and any redraw draws the latest one. A Surface without shadows
   * never redraws for it, nor does a still light, or a camera parallaxing under an anchored one.
   */
  setLightDirection(local: Vector3): void {
    const z = Math.max(local.z, 0.1)
    const want = this.lightDir.set(-local.x / z, local.y / z), drawn = this.shadowDir.value, e = this.shadows.maxElevation
    if (e > 0 && Math.max(Math.abs(want.x - drawn.x), Math.abs(want.y - drawn.y)) * e > SHADOW_REDRAW_PT) this.contentDirty = true
  }

  /** The 3D objects attached to this Surface's nodes (`attach3D`), by node. */
  get viewports(): ReadonlyMap<Node, Viewport3DAttachment> { return this.attachments }

  /**
   * Whether the Surface shadows the UI (default true; `SurfaceOptions.castShadows`): false takes every caster of its
   * out of the key light's shadow map, its element glass and its attached 3D objects (`attach3D`; a detach gives an
   * object its own `castShadow` back), and masks its content quad out of the map too (three draws a receiver into a
   * VSM map, so the quad would cast its whole rectangle). Its own content still receives shadows. The background slab
   * never casts. Takes effect at once, and holds through rebuilds.
   */
  get castShadows(): boolean { return this.casts }
  set castShadows(v: boolean) {
    if (v === this.casts) return
    this.casts = v
    for (const m of this.casters) m.castShadow = v
    for (const a of this.attachments.values()) a.castShadows = v
    this.maskContentShadow()
  }

  /** The content quad in the shadow pass: as three draws it (a receiver) while the Surface casts, discarded while it does not. */
  private maskContentShadow(): void {
    const m = this.contentMesh.material as MeshStandardNodeMaterial, mask = this.casts ? null : bool(false)
    if (m.maskShadowNode === mask) return
    m.maskShadowNode = mask; m.needsUpdate = true
  }

  /**
   * Attaches a three.js `object` to `node` (spatial spec §2.3; `Viewport3DAttachment`): from the next `tick` it stands
   * on the face `node`'s box sits on (its nearest glass ancestor's top, else the content plane), centred on the box,
   * 1 local unit = 1 pt; it draws in the transparent queue after the rims (`SURFACE_ORDER.viewport`), casts shadows,
   * fades with `opacity`, and the pointer hits it as part of `node` (`hitSurfaces`: events carry `object`).
   * `opts.depth` (pt, default the node's width) is how far it rises, for the shadow fit; `opts.update` runs every tick
   * the anchor is shown (true asks for a frame; a throw fails the Surface). Returns the detach: it restores what was
   * adopted and takes the object off (nothing is disposed); `dispose` does the same for every attachment. Throws a
   * `GlassUIError` on a screen Surface, for a node not in this Surface's tree, a node already attached, or an `object`
   * that is not an `Object3D`.
   */
  attach3D(node: Node, object: Object3D, opts: Attach3DOptions = {}): () => void {
    const scope = 'Surface.attach3D'
    if (this.model.placement === 'screen') throw new GlassUIError(scope, '只能挂在世界层 Surface 上')
    let under = false
    for (let p: Node | null = node; p && !under; p = p.parent) under = p === this.root
    if (!under) throw new GlassUIError(scope, '节点不在这个 Surface 里')
    if (this.attachments.has(node)) throw new GlassUIError(scope, '这个节点已经挂了一个 3D 物体：先卸下')
    if ((object as Partial<Object3D> | null)?.isObject3D !== true) throw new GlassUIError(scope, 'object 必须是 three.js 的 Object3D')
    const a = new Viewport3DAttachment(node, object, opts, SURFACE_ORDER.viewport, this.drawOrder)
    a.castShadows = this.casts
    this.attachments.set(node, a)
    this.plane.add(a.anchor)
    return () => {
      if (this.attachments.get(node) === a) this.attachments.delete(node)
      a.dispose()
    }
  }

  /**
   * Layout → animation → render list → batches (sets `contentDirty`). A throw fails the Surface instead of propagating;
   * a failed or disposed Surface does nothing.
   */
  tick(dt: number): void {
    if (this.error || this.isDisposed) return
    this.lastDt = dt
    try {
      const root = this.root, ctx = this.ctx
      if (root.dirty.layout || root.dirty.tree) ctx.layout.compute(root, this.model.width, this.model.height, ctx.measure)
      this.needsFrame = ctx.anim.tick(root, dt, this.model.cornerRadius)
      if (root.dirty.paint || !this.list || !this.parts) {
        const list = this.list = buildRenderList(this.model, ctx.theme, ctx.scheme)
        const p = this.parts = partition(list)
        this.updateTouch(list)
        this.fill(list, p)
        // glass appeared on (or left) a 'none' Surface: it now sees (or no longer sees) what is behind it; nested glass
        // appeared (or went away): its stacked RT with it. Both synced, then one rebuild
        const fillMode = this.quality.glassMode === 'fill'
        const behind = this.syncBehind(this.glass.buffer.count > 0 && !fillMode), stack = this.syncStack(this.innerGlass.buffer.count > 0 && !fillMode)
        if (behind || stack) this.buildGlass(this.quality)
        root.walk(n => { n.dirty.paint = false })
        this.contentDirty = true
      } else {
        if (this.updateTouch(this.list)) this.fillGlass()
        if (ctx.text.atlas.epoch !== this.seenEpoch) { this.fillText(this.parts); this.contentDirty = true }
      }
      // a texture changed under an image (a URL that loaded, a video frame): content images are in the RT, foreground
      // ones only need a frame — but the stacked RT holds those riding on outer glass, and redraws with the content
      if (this.contentImages.pollChanged()) this.contentDirty = true
      if (this.stackPass?.images.pollChanged()) this.contentDirty = true
      if (this.foregroundImages.pollChanged()) this.needsFrame = true
      if (this.attachments.size && this.list) this.stepViewports(dt, this.list)
    } catch (e) { this.markFailed(e) }
  }

  /** Places, fades and updates every attachment from the current list (`Viewport3DAttachment.step`); after layout. */
  private stepViewports(dt: number, list: RenderList): void {
    const { theme, scheme, anim } = this.ctx
    const step = { root: this.root, surface: this.model, glass: list.glass, opacity: this.fade, context: { reducedMotion: anim.reducedMotion, theme, scheme } }
    for (const a of this.attachments.values()) if (a.step(dt, step)) this.needsFrame = true
  }

  private fill(list: RenderList, p: Partition): void {
    const s = this.model
    this.nested = splitNested(list.glass)
    this.fillGlass()
    this.panels.update(p.content.panels, s)
    this.shadows.update(p.content.shadows, s)
    this.pools.update(p.content.pools, s)
    this.fillRims(p)
    this.foregroundImages.update(p.foreground.images, s, i => liftFor(p, i.node), SURFACE_ORDER.images)
    this.contentImages.update(p.content.images, s, undefined, CONTENT_ORDER.images)
    this.fillText(p)
  }

  /**
   * Both element-glass batches from the last split (`nested`), with the press glow wherever the pressed glass is: the
   * outer glass, and the inner glass with no luma index (its adaptive darkening is deferred, spatial spec §2.4); shows
   * or hides the inner glass draws.
   */
  private fillGlass(): void {
    const n = this.nested
    if (!n) return
    this.glass.update(n.outer, this.model, this.touch)
    this.innerGlass.update(n.inner, this.model, this.touch, { luma: false })
    this.showInner()
  }

  /**
   * The stacked RT's draws from partition `p` (`StackPass.update`): the outer glass, and the foreground text and images
   * riding on an outer glass (`glassOf`), in the theme's colours. A no-op without a stack.
   */
  private fillStack(p: Partition): void {
    const stack = this.stackPass, n = this.nested
    if (!stack || !n) return
    const outer = new Set(n.outer)
    const rides = (i: { node: Node }): boolean => { const g = p.glassOf.get(i.node); return g !== undefined && outer.has(g) }
    stack.update(n.outer, p.foreground.text.filter(rides), p.foreground.images.filter(rides), this.model, this.ctx.theme, this.ctx.scheme)
  }

  /**
   * The rim decorations: the glass's bright outline and edge bands, drawn over it — none in the 'fill' glass mode,
   * whose border band replaces them (white over it would wash the border out). Pools stay: they are content.
   */
  private fillRims(p: Partition): void {
    this.rims.update(this.quality.glassMode === 'fill' ? [] : p.foreground.rims, this.model, d => liftFor(p, d.node))
  }

  /**
   * Rebuilds the glyph quads from the last partition when the atlas epoch moved since they were built — the pages are
   * shared, so another Surface's glyphs may have evicted this one's after it ticked — and marks the content dirty. The
   * root calls it on every Surface when the epoch moved during its tick. True if it rebuilt.
   */
  refreshText(): boolean {
    if (this.error || this.isDisposed || !this.parts || this.ctx.text.atlas.epoch === this.seenEpoch) return false
    try {
      this.fillText(this.parts)
      this.contentDirty = true
      return true
    } catch (e) { this.markFailed(e); return false }
  }

  /** The glyph quads, laid out once more if the atlas evicted while they were built (their slots moved under them). */
  private fillText(p: Partition): void {
    const atlas = this.ctx.text.atlas, epoch = atlas.epoch
    this.layoutText(p)
    if (atlas.epoch !== epoch) this.layoutText(p)
    this.seenEpoch = atlas.epoch
  }

  /** Every glyph batch from `p`, the stacked RT's with the others (one atlas epoch; its panels and images ride along). */
  private layoutText(p: Partition): void {
    this.foregroundText.update(p.foreground.text, this.model, t => liftFor(p, t.node))
    this.contentText.update(p.content.text, this.model)
    this.fillStack(p)
    this.syncGlyphMeshes(this.foregroundText, this.foregroundGlyphs, this.plane, SURFACE_ORDER.glyphs, this.su)
    this.syncGlyphMeshes(this.contentText, this.contentGlyphs, this.contentPass.scene, CONTENT_ORDER.glyphs, this.suContent)
  }

  /**
   * One mesh per atlas page per batch, made when the page first has glyphs (a page batch is never dropped), with `su`
   * (the plane's, or the content pass's: `suContent`).
   */
  private syncGlyphMeshes(batch: GlyphBatch, meshes: Map<number, Mesh>, parent: Object3D, renderOrder: number, su: SurfaceUniforms): void {
    for (const [page, pb] of batch.perPage) {
      if (meshes.has(page)) continue
      const mesh = new Mesh(pb.geometry, this.own(createGlyphMaterial(pb.geometry, su, this.ctx.pages.textures[page]!)))
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

  /**
   * Sizes the content RT (and the pyramid) for the Surface's projected size — `dpr × max(quality.contentScale, 1/dpr) ×
   * contentScale` texels per CSS px, so never below one texel per CSS px from the quality alone — through `rtTarget`:
   * the first `prepare` takes exactly that, a growth 25 % more, and a shrink waits until `moving` (the root: the camera,
   * its projection, the Surface or its animation moved this tick) has been false for `RT_SETTLE_FRAMES` calls in a row
   * with no growth among them. Then redraws it when dirty (a resize makes it dirty; the shadows take the latest light
   * direction, `setLightDirection`), and the stacked RT (sized with it) right after it. Then the pyramid, when the RT
   * changed since it was last drawn and the Surface has glass instances to sample it (its only input is the content RT;
   * without glass its 9 passes are skipped until glass appears). Then the
   * luma (`SurfaceLuma.update`, not in the 'fill' glass mode; the outer glass only), from the content RT's own mips: on
   * a redraw and while its smoothing settles after one; on a glass Surface drawn with `camera` (the root passes its
   * own), every frame, over the slab's screen capture too (frosted as the slab frosts it); likewise on a 'none' Surface
   * with a behind-capture, over that (unfrosted). A throw fails the Surface instead of propagating; a failed or disposed
   * Surface does nothing.
   */
  prepare(renderer: RendererLike, projectedPx: { width: number; height: number }, dpr: number, camera?: Camera, moving = false): void {
    if (this.error || this.isDisposed) return
    try {
      // the quality's scale caps supersampling: the RT never drops below one texel per CSS px (it is what the content
      // quad displays), so it only bites above DPR 1; the Surface's own `contentScale` multiplies the result
      const floor = dpr > 0 ? 1 / dpr : 1
      const need = contentRTSize(projectedPx, dpr, { scale: Math.max(this.quality.contentScale, floor) * this.contentScale })
      // a Surface flying closer re-allocates at most once per 25 %, and one flying away keeps its RT until it settles
      this.stillFrames = moving ? 0 : Math.min(RT_SETTLE_FRAMES, this.stillFrames + 1)
      const size = rtTarget(this.contentPass, need, { settled: this.stillFrames >= RT_SETTLE_FRAMES, fresh: !this.sized })
      this.sized = true
      // a growth starts the count over: with nothing moving (a resize, a DPR change) it would otherwise shrink right back
      if (size.width > this.contentPass.width || size.height > this.contentPass.height) this.stillFrames = 0
      if (this.contentPass.resize(size.width, size.height)) this.contentDirty = true
      if (this.stackPass?.resize(size.width, size.height)) this.contentDirty = true
      this.pyramid?.resize(size.width, size.height)
      const redrawn = this.contentDirty
      if (redrawn) {
        this.shadowDir.value.copy(this.lightDir)   // the shadows follow the latest light whenever the RT redraws
        this.contentPass.setView(this.model)
        this.contentPass.render(renderer, this.contentClear)
        this.stackPass?.render(renderer)   // it starts from the content RT: right after it
        this.contentDirty = false; this.pyramidCurrent = false
      }
      // 9 passes only when glass will sample them; skipped, the targets stay (wired to the glass) and catch up later
      if (this.pyramid && !this.pyramidCurrent && this.glass.buffer.count > 0) {
        this.pyramid.render(renderer, this.contentPass.texture)
        this.pyramidCurrent = true
      }
      // the 'fill' glass mode samples no backdrop: nothing reads the luma (and the slab capture's copy would be stale)
      if (this.quality.glassMode === 'fill') return
      // what the element glass sees where the content is transparent, frosted as it sees it
      const capture = this.screen ?? this.behindCapture, frost = this.screen ? SLAB_BEHIND : NO_FROST
      const behind = capture && camera ? { behind: { capture, camera, plane: this.plane, frost } } : {}
      this.luma.update({ renderer, glass: this.nested?.outer ?? [], surface: this.model, content: this.contentPass.texture, dt: this.lastDt, redrawn, ...behind })
    } catch (e) { this.markFailed(e) }
  }

  /**
   * Stops the Surface for good: `error` set (`e`, made an `Error` if it is not one), hidden (`visible = false`), no more
   * frames (`tick`, `prepare` and the rebuilds do nothing), then one `{ type: 'error', error }` event (a throwing
   * listener is logged, never rethrown: this runs inside frames). It never ticks again, so its nodes' animation state is
   * dropped (`AnimationRuntime.forget`) and their `whenSettled` promises resolve, and its own motion stops (a pending
   * `animateTo` resolves `false`). The first failure stands: a failed or disposed Surface ignores it. Its own frames
   * call it when they throw; the root, when its render isolation blames it.
   */
  markFailed(e: unknown): void {
    if (this.error || this.isDisposed) return
    this.error = e instanceof Error ? e : new Error(String(e))
    this.visible = false; this.needsFrame = false
    this.ctx.anim.forget(this.root); this.motion.stop()
    // a throwing listener must not escape the frame either
    try { this.dispatchEvent({ type: 'error', error: this.error }) } catch (le) { console.error('[glassui] an "error" listener threw:', le) }
  }

  /** `dispose` has run: the Surface's resources are freed and it does nothing any more. */
  get disposed(): boolean { return this.isDisposed }

  /**
   * Surface-local bounds of the content face up to the top of its tallest glass, or of its tallest shown 3D attachment
   * (its face plus its `depth`), for the shadow-camera fit and the view culling.
   */
  get glassBounds(): Box3 {
    const ppu = this.model.ptPerUnit, w = this.model.width / ppu, h = this.model.height / ppu
    let top = this.contentPlaneZ
    for (const g of this.list?.glass ?? []) top = Math.max(top, this.contentPlaneZ + (g.elevation + g.params.thickness) / ppu)
    for (const a of this.attachments.values()) if (a.anchor.visible) top = Math.max(top, this.contentPlaneZ + (a.base + a.depth) / ppu)
    return new Box3(new Vector3(-w / 2, -h / 2, 0), new Vector3(w / 2, h / 2, top + 0.01))   // never flat
  }

  /**
   * Frees everything the Surface holds (its animation and layout state, render targets, geometries, materials,
   * captures), detaches its 3D attachments (restoring what they adopted; the objects are the owners' and are not
   * freed), detaches it from its parent, then emits `{ type: 'dispose' }` (the root it belongs to drops it then, so a
   * Surface disposed directly leaves `root.surfaces` too; a throwing listener is logged). Idempotent: a second call
   * frees nothing and emits nothing.
   */
  dispose(): void {
    if (this.isDisposed) return
    this.isDisposed = true   // first: a throw below must not lead to anything being freed twice
    try {
      for (const a of this.attachments.values()) a.dispose()   // first: the owners' materials go back whatever fails below
      this.attachments.clear()
      this.motion.stop()   // a pending `animateTo` resolves false
      this.ctx.anim.forget(this.root)
      this.ctx.layout.dispose(this.root)
      this.contentPass.dispose(); this.pyramid?.dispose(); this.luma.dispose(); this.stackPass?.dispose()
      for (const b of [this.glass, this.innerGlass, this.panels, this.rims, this.pools, this.shadows, this.backgroundGlass]) b?.dispose()
      this.foregroundText.dispose(); this.contentText.dispose(); this.foregroundImages.dispose(); this.contentImages.dispose()
      for (const gm of this.glassMaterials) gm.dispose()
      for (const m of this.materials) m.dispose()
      this.screen?.dispose(); this.depth?.dispose(); this.dropBehind()
      this.contentMesh.geometry.dispose()
    } finally {
      this.removeFromParent()
      try { this.dispatchEvent({ type: 'dispose' }) } catch (le) { console.error('[glassui] a "dispose" listener threw:', le) }
    }
  }
}
