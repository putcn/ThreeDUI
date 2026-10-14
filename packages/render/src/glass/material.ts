import { BackSide, DataTexture, FrontSide, RGBAFormat, UnsignedByteType, type Color, type InstancedBufferGeometry, type Texture, type Vector2 } from 'three'
import { MeshPhysicalNodeMaterial, ViewportDepthTextureNode, ViewportTextureNode, type Node, type NodeFrame, type TextureNode, type UniformNode } from 'three/webgpu'
import {
  attribute, float, vec2, vec3, vec4, uniform, texture, varying, positionView, positionViewDirection, normalView,
  transformNormalToView, negateOnBackSide, modelViewMatrix, cameraProjectionMatrix, viewportMipTexture,
  linearDepth, screenUV, refract, reflect, normalize, dot, max, min, abs, exp, mix, clamp, pow, smoothstep, step, select, length, fwidth,
} from 'three/tsl'
import { GlassUIError } from '@glassui/core'
import { GLASS_ATTRS } from './batch'
import { FILL, FROST } from './frost'
import { slabVertex } from './vertex'
import { sdfNode } from '../panel/sdf'

/**
 * How glass sees its backdrop (the quality tiers' "玻璃" column, spec §5.6):
 * - `'refract'` (high, medium): along the ray refracted through the slab, per colour channel (dispersion);
 * - `'straight'` (low): no refraction — straight through, no ray offset and no dispersion: the content RT at the
 *   content-plane point behind the fragment along the view ray, a screen backdrop at the fragment's own `screenUV`;
 * - `'fill'` (minimal, reduced transparency): no backdrop at all — a near-opaque fill (`FILL.alpha`, or `fillAlpha`:
 *   solid under increased contrast) of the glass's glow colour, else its tint, else the given `fill`, with an optional
 *   `border` band along the outline; the material then samples no texture (no content, pyramid, screen, depth or luma),
 *   so no capture is ever copied for it.
 * Every mode keeps the lit shell, the edge glow, the glow layer (in 'fill' its Fresnel rim only: the fill carries the
 * colour), the clip and the transmitted shadow.
 */
export type GlassMode = 'refract' | 'straight' | 'fill'

export interface GlassMaterialOptions {
  /** The batch geometry (`GlassBatch.geometry`); its instance attributes are read by name. */
  geometry: InstancedBufferGeometry
  /** Profile segments the geometry was built with (`GlassBatch.K`). */
  K: number
  /** `'panel'`: refract the Surface's content RT (class 2). `'screen'`: refract what is already on screen (class 3). */
  backdrop: 'panel' | 'screen'
  side: 'front' | 'back'
  /** Surface size in units (W, H) and its pt per unit. */
  surface: { size: UniformNode<'vec2', Vector2>; ptPerUnit: UniformNode<'float', number> }
  /** The content RT texture (panel only; required there); `setContent` swaps it. */
  content?: Texture | undefined
  /**
   * Panel, high tier: the content's blur pyramid (`KawasePyramid.textures`, each level blurrier than the last), sampled
   * by roughness (`pyramidMix`) instead of the content's mips; `setPyramid` swaps it.
   */
  pyramid?: Texture[] | undefined
  /**
   * Screen: the capture to refract, shared per layer and disposed by its owner; default: a new `ScreenCapture` this
   * material owns. Panel (optional): what lies behind the content plane, seen where the content RT is transparent — a
   * `'glass'` Surface's slab capture, which the slab (that Surface's first draw) takes before any of its draws, or a
   * `'none'` Surface's behind-capture, which its probe takes at the slab's place; either way the content is not in it.
   * Without it (an opaque Surface) the content RT is refracted alone (spec §5.1) and its empty texels refract as black.
   */
  screen?: ReturnType<typeof viewportMipTexture> | undefined
  /** Panel with `screen`: the mip level of the behind-the-plane sample (default: the element's own roughness level). */
  screenLevel?: number | undefined
  /** Panel with `screen`: how far that sample is lifted toward white (a frosted glass background's own lift; default 0). */
  screenLift?: number | undefined
  /** Backdrop luma per instance (Task 23); default: 1×1 black, i.e. never darken. `setLuma` swaps it. */
  luma?: Texture | undefined
  /**
   * Screen, or panel with `screen` (its behind-the-plane sample): where the refracted sample hits something nearer than
   * the glass, sample straight through instead.
   */
  depthReject?: boolean | undefined
  /**
   * With `depthReject`: the depth capture to read, shared (e.g. by a slab's two faces and the element glass on it: one
   * depth copy per render instead of one per draw) and disposed by its owner; default: a new `DepthCapture` this
   * material owns.
   */
  depth?: DepthCapture | undefined
  /** Default `'refract'`; see `GlassMode`. In `'fill'` the backdrop options (`content` aside, still required for a panel) are ignored. */
  mode?: GlassMode | undefined
  /** `'refract'` only: refract per colour channel by the instance's dispersion (default true); false refracts once. */
  dispersion?: boolean | undefined
  /** `'fill'` only: the fill of glass with neither glow nor tint, linear (default white). */
  fill?: Color | undefined
  /**
   * `'fill'` only: the fill's alpha over the lit shell (default `FILL.alpha`, near-opaque); 1 is solid (increased
   * contrast, spec §8.3). The border band is opaque either way.
   */
  fillAlpha?: number | undefined
  /**
   * `'fill'` only: the colour (linear) of a `FILL.borderPt` band inside the glass's outline (its outer contour, from the
   * slab-local position and the instance's rect, radius and corner exponent), so the shape reads against what is
   * behind it; none without. It costs a varying (`vGlassOutline`), which the fill mode has room for.
   */
  border?: Color | undefined
}

export interface GlassMaterial {
  material: MeshPhysicalNodeMaterial
  /** Swaps the panel content texture in place (no rebuild); a no-op for a screen backdrop, which has none. */
  setContent(tex: Texture): void
  /** Swaps the luma texture in place: `count` texels in a row, texel `i` = instance `i`'s backdrop luma. */
  setLuma(tex: Texture, count: number): void
  /** Swaps the pyramid's textures in place; as many as it was made with (none for a screen backdrop). */
  setPyramid(textures: Texture[]): void
  dispose(): void
}

/*
 * Viewport captures that can be disposed: three copies the framebuffer (or depth buffer) into a clone of the node's
 * template texture per render target or canvas target, cached in a private WeakMap, so disposing the node's own texture
 * frees nothing that was drawn. Every copy is resolved through `getTextureForReference` (a material samples clones of
 * the node that resolve through it as their base), so the base records them (`copies`) and frees them on `dispose`.
 */
type CaptureReference = Parameters<ViewportTextureNode['getTextureForReference']>[0]
interface Capture { referenceNode: unknown; copies: Set<Texture> }
/** Records `t` on the capture's base (a sampled clone resolves through it). */
function record(node: Capture, t: Texture): Texture { ((node.referenceNode as Capture | null) ?? node).copies.add(t); return t }
/** Frees every copy, and the template when the node owns it (else it is three's, or the base's). */
function freeCopies(node: Capture, ownsTemplate: boolean): void {
  const template = (node as unknown as { defaultFramebuffer: Texture }).defaultFramebuffer
  if (ownsTemplate) node.copies.add(template); else node.copies.delete(template)
  for (const t of node.copies) t.dispose()
  node.copies.clear()
}

/**
 * `viewportMipTexture()` that frees every framebuffer copy, and its own template, on `dispose`, and records on its base
 * the copy the last render made (`latest`).
 */
export class ScreenCapture extends ViewportTextureNode {
  readonly copies = new Set<Texture>()
  /**
   * The texture the last copy went into (with its mips), whichever target the render was for (the canvas: three r186
   * resolves it as the renderer's `CanvasTarget`, so never the template `getTextureForReference(null)` returns; or a
   * host's render target): what was on screen before this capture's first draw then. Null before the first copy.
   */
  latest: Texture | null = null
  /** It made its template (no texture passed in; `clone()` passes the base's). */
  private readonly ownsTemplate: boolean
  constructor(...args: ConstructorParameters<typeof ViewportTextureNode>) { super(...args); this.generateMipmaps = true; this.ownsTemplate = args[2] == null }
  override getTextureForReference(reference?: CaptureReference): Texture { return record(this, super.getTextureForReference(reference)) }
  /** A sampled clone copies into the texture `updateReference` just resolved (its `value` is the base's): record it there. */
  override updateBefore(frame: NodeFrame): boolean | undefined {
    const r = super.updateBefore(frame), base = (this.referenceNode as ScreenCapture | null) ?? this
    base.latest = this.value
    return r
  }
  override dispose(): void { freeCopies(this, this.ownsTemplate); this.latest = null; super.dispose() }
}

/** `viewportDepthTexture()` that frees every depth copy on `dispose`; its template is three's, shared by all: kept. */
export class DepthCapture extends ViewportDepthTextureNode {
  readonly copies = new Set<Texture>()
  override getTextureForReference(reference?: CaptureReference): Texture { return record(this, super.getTextureForReference(reference)) }
  override dispose(): void { freeCopies(this, false); super.dispose() }
}

/** Shadow colour of untinted glass (spec §5.4): a slightly cool grey. */
const NEUTRAL_SHADOW = [0.78, 0.78, 0.84] as const

/**
 * `[sharp, …levels]` (each blurrier than the last) blended by roughness: k = roughness · n over the n + 1 entries,
 * level ⌊k⌋ to ⌈k⌉ by frac(k), clamped to [0, n] — roughness 1 reaches the last level.
 */
export function pyramidMix(sharp: Node<'vec4'>, levels: Node<'vec4'>[], roughness: Node<'float'>): Node<'vec4'> {
  const k = roughness.mul(levels.length)
  return levels.reduce((c, level, i) => mix(c, level, clamp(k.sub(i), 0, 1)), sharp)
}

/** 1×1 black: "the backdrop is dark", so nothing darkens until a real luma pass is attached. */
function blackTexture(): DataTexture {
  const t = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat, UnsignedByteType)
  t.needsUpdate = true
  return t
}

/**
 * The glass slab material (spec §5.3, ported from the spike's `glass.ts` onto the batch's instance attributes): lights,
 * environment reflections and Fresnel come from `MeshPhysicalNodeMaterial`; the transmitted term is the backdrop
 * refracted per colour channel through the real slab thickness (`mode`: or seen straight through, or replaced by a
 * frosted fill — see `GlassMode`), with Beer–Lambert tint, frost lift, a planar reflection of the content (panel, not
 * in 'fill'), adaptive darkening (clear variant, not in 'fill'), press/edge/inner glow and a coloured transmitted
 * shadow that fades with the instance's opacity (none at all at ≤ 0.01: `maskShadowNode`).
 *
 * Varyings: the fragment stage never reads an instance attribute. Each would cost one inter-stage variable, and 14 of
 * them plus three's own exceed WebGPU's default 16 (`maxInterStageShaderVariables`) and WebGL2's guaranteed 15
 * (`MAX_VARYING_VECTORS`). The vertex stage packs what the fragment needs into 8 vec4 varyings (+ the slab normal);
 * the position-dependent ones (depth, slab uv, clip coordinates) are affine in the slab-local position, so their
 * interpolation is exact. The 'fill' mode needs no view position (one varying fewer) and spends it on the outline's
 * shape (`vGlassOutline`) for its border: 11 either way.
 *
 * Units: the refraction depth is measured in the slab's own frame (slab-local z, the height above its back face, in
 * the units of its thickness), so a tilted, scaled or elevated slab refracts as it would flat; the path inside is
 * converted to view units by the length of the slab's z axis in view space (instance z scale × model-view scale: a
 * screen-layer Surface is scaled by units per px).
 */
export function createGlassMaterial(o: GlassMaterialOptions): GlassMaterial {
  if (o.backdrop === 'panel' && !o.content) throw new GlassUIError('createGlassMaterial', 'backdrop "panel" 需要 content 纹理（Surface 的内容 RT）')
  // three compiles a missing attribute to zeros (opacity 0: invisible glass), so fail here instead
  for (const name of GLASS_ATTRS) if (!o.geometry.hasAttribute(name)) throw new GlassUIError('createGlassMaterial', `几何体缺少实例属性 "${name}"（应为 GlassBatch.geometry）`)
  const mode = o.mode ?? 'refract', fill = mode === 'fill'
  const v = slabVertex(o.geometry, o.K)
  const { size, ptPerUnit } = o.surface

  // ── vertex stage: instance attributes (by name, see slabVertex) → packed varyings ──────────────────────────────
  const A = (name: (typeof GLASS_ATTRS)[number]) => attribute(name, 'vec4')
  const iRect = A('iRect'), iShape = A('iShape'), iCorner = A('iCorner'), iOptics = A('iOptics')
  const iMat0 = A('iMat0'), iMat1 = A('iMat1'), iMat2 = A('iMat2')
  const iTint = A('iTint'), iGlow = A('iGlow'), iGlow2 = A('iGlow2'), iTouch = A('iTouch')
  const iClipRect = A('iClipRect'), iClipInv = A('iClipInv'), iClipT = A('iClipT')
  // rounded-rect clip: the vertex's surface pt (origin top-left, y down) through the clip's inverse transform, taken
  // relative to the clip rect's centre; the fragment only measures the signed distance
  const pt = vec2(v.local.x.add(size.x.mul(0.5)).mul(ptPerUnit), size.y.mul(0.5).sub(v.local.y).mul(ptPerUnit))
  const clipPt = vec2(iClipInv.x.mul(pt.x).add(iClipInv.z.mul(pt.y)).add(iClipT.x), iClipInv.y.mul(pt.x).add(iClipInv.w.mul(pt.y)).add(iClipT.y))
  const half = iClipRect.zw.mul(0.5)
  const clipRadius = min(iClipT.z, min(half.x, half.y))
  // view units per slab unit: the slab's z axis (the instance matrix's third column) mapped to view space
  const toView = length(modelViewMatrix.mul(vec4(iMat0.z, iMat1.z, iMat2.z, 0)).xyz)
  // depth = slab-local z: the height above the slab's own back face, in slab units (as iShape.y)
  const vGeom = varying(vec4(v.slabLocal.z, iShape.y, v.slabLocal.x.div(iRect.z).add(0.5), v.slabLocal.y.div(iRect.w).add(0.5)), 'vGlassGeom')
  const vOptics = varying(iOptics, 'vGlassOptics')
  const vTint = varying(iTint, 'vGlassTint')
  const vGlow = varying(iGlow, 'vGlassGlow')
  const vGlow2 = varying(vec4(iGlow2.xy, iCorner.zw), 'vGlassGlow2')
  const vTouch = varying(iTouch, 'vGlassTouch')
  const vClip = varying(vec4(clipPt.sub(iClipRect.xy.add(half)), half.sub(clipRadius)), 'vGlassClip')
  // writeClip packs width −1 for "no clip"; a clip collapsed to width 0 still clips everything
  const vMisc = varying(vec4(iGlow2.zw, select(iClipRect.z.greaterThanEqual(0), max(clipRadius, 0), float(-1)), toView), 'vGlassMisc')

  // ── fragment stage: unpack ───────────────────────────────────────────────────────────────────────────────────
  const depth = max(vGeom.x, 0)                                          // height above the slab back, slab units
  const thickness = vGeom.y, slabUV = vGeom.zw                           // slab planar uv: 0..1 across the rect
  const ior = vOptics.x, dispersion = vOptics.y, roughness = vOptics.z, scatter = vOptics.w
  const tint = vTint.xyz, absorption = vTint.w                           // linear
  const glowColor = vGlow.xyz, glowStrength = vGlow.w
  const split = vGlow2.x, soft = vGlow2.y, lift = vGlow2.z, edgeGlow = vGlow2.w
  const touch = vTouch.xy, press = vTouch.z, reflection = vTouch.w
  const opacity = vMisc.x, lumaIndex = vMisc.y, clipR = vMisc.z          // clipR < 0: no clip
  const slabToView = vMisc.w                                             // view units per slab unit

  // what the backdrop samples: nothing at all in 'fill'
  const black = o.luma || fill ? null : blackTexture()
  const contentTex = !fill && o.backdrop === 'panel' && o.content ? texture(o.content) : null   // non-null exactly for a sampled 'panel'
  const pyramid = contentTex ? (o.pyramid ?? []).map(t => texture(t)) : []
  const lumaTex = fill ? null : texture(o.luma ?? black!)
  const lumaCount = uniform(1)
  const ownScreen = !fill && o.backdrop === 'screen' && !o.screen ? new ScreenCapture() : null
  // @types/three declares viewportMipTexture as returning a plain Node; it is a ViewportTextureNode (a TextureNode)
  const screen = !fill && o.backdrop === 'screen' ? (o.screen ?? ownScreen) as TextureNode : null
  /** Panel: the capture behind the content plane, composited under the content RT's transparent texels. */
  const behind = !fill && o.backdrop === 'panel' && o.screen ? o.screen as TextureNode : null
  // one base node for every depth sample: its clones share one captured depth texture (one copy per target). Only a
  // refracted sample can land on something nearer than the glass: straight through is what the reject falls back to
  const rejects = mode === 'refract' && o.depthReject === true && (o.backdrop === 'screen' || behind !== null)
  const ownDepth = rejects && !o.depth ? new DepthCapture() : null
  const sceneDepth = rejects ? o.depth ?? ownDepth : null

  const m = new MeshPhysicalNodeMaterial()
  m.transparent = true; m.depthWrite = false; m.depthTest = true
  m.side = o.side === 'back' ? BackSide : FrontSide
  m.toneMapped = false
  m.metalness = 0; m.envMapIntensity = 1; m.specularIntensity = 1; m.iridescence = 0
  m.roughnessNode = max(roughness, 0.06)                                 // specular roughness
  m.iorNode = ior
  m.positionNode = v.position
  // three flips geometry normals on back faces itself, but not a normalNode: flip here so the back pass faces the eye
  m.normalNode = negateOnBackSide(transformNormalToView(v.normal))

  // clip: the material discards where the mask is false; the shadow pass's mask adds the opacity (below)
  const q = abs(vClip.xy).sub(vClip.zw)
  const clipDist = length(max(q, 0)).add(min(max(q.x, q.y), 0)).sub(clipR)
  const clipMask = clipR.lessThan(0).or(clipDist.lessThanEqual(0))
  m.maskNode = clipMask

  const lod = roughness.mul(FROST.levelPerRoughness)
  const V = positionViewDirection, N = normalView
  // floored base: WGSL pow is exp2(y·log2 x), undefined at x = 0 (N·V = 1)
  const fresnel = pow(max(float(1).sub(clamp(dot(N, V), 0, 1)), 1e-6), 2.5)

  // the content plane (mesh-local z = 0) in view space: origin, in-plane axes, normal
  const origin = modelViewMatrix.mul(vec4(0, 0, 0, 1)).xyz
  const ex = modelViewMatrix.mul(vec4(1, 0, 0, 0)).xyz, ey = modelViewMatrix.mul(vec4(0, 1, 0, 0)).xyz
  const nb = normalize(modelViewMatrix.mul(vec4(0, 0, 1, 0)).xyz)
  /**
   * Content RT uv of a view-space point on the plane: its mesh-local xy over the Surface size, v flipped — a render
   * target's v = 0 is its top row on both backends (see `createContentMaterial`), and mesh-local y runs up.
   */
  const planeUV = (P: Node<'vec3'>) => {
    const d = P.sub(origin)
    const q = vec2(dot(d, ex).div(dot(ex, ex)), dot(d, ey).div(dot(ey, ey))).div(size)
    return vec2(q.x.add(0.5), float(0.5).sub(q.y))
  }

  /** Screen uv (v = 0 at the top, as a framebuffer copy is read on both backends) of a view-space point. */
  const screenUVOf = (P: Node<'vec3'>) => {
    const clip = cameraProjectionMatrix.mul(vec4(P, 1))
    const ndc = clip.xy.div(clip.w)
    return vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)))
  }
  const behindLevel = o.screenLevel !== undefined ? float(o.screenLevel) : lod
  /** The content at `at`, frosted by roughness: its mips at `lod`, or (high tier) its pyramid. */
  const frosted = (tex: TextureNode, at: Node<'vec2'>): Node<'vec4'> => pyramid.length
    ? pyramidMix(tex.sample(at).level(float(0)), pyramid.map(l => l.sample(at).level(float(0))), roughness)
    : tex.sample(at).level(lod)
  const behindLift = float(o.screenLift ?? 0)

  /** One colour channel's refraction: the backdrop colour along the refracted ray and the path length inside (slab units). */
  const channel = (iorScale: Node<'float'>) => {
    const R = refract(V.negate(), N, float(1).div(ior.mul(iorScale)))
    const t1 = min(depth.div(max(dot(R.negate(), nb), 0.15)), thickness.mul(4))
    const inside = positionView.add(R.mul(t1.mul(slabToView)))            // where the ray leaves the slab back
    if (contentTex) {
      // then straight on (along the view ray) to the content plane
      const t2 = max(dot(origin.sub(inside), nb).div(min(dot(V.negate(), nb), -0.05)), 0)
      const P = inside.sub(V.mul(t2))
      const content = frosted(contentTex, planeUV(P))
      if (!behind) return { c: content.rgb, t1 }
      // premultiplied content over what is behind the plane there: a glass Surface's slab capture, taken at the slab
      // (that Surface's first draw), so it predates the content quad and holds no content to count twice
      const puv = screenUVOf(P)
      let under: Node<'vec3'> = behind.sample(puv).level(behindLevel).rgb
      // as the slab does: something nearer than the glass was captured there, so look straight through
      if (sceneDepth) under = select(linearDepth(sceneDepth.sample(puv)).lessThan(linearDepth()), behind.sample(screenUV).level(behindLevel).rgb, under)
      return { c: content.rgb.add(mix(under, vec3(1), behindLift).mul(float(1).sub(content.a))), t1 }
    }
    const suv = screenUVOf(inside)
    let c: Node<'vec3'> = screen!.sample(suv).level(lod).rgb
    // something nearer than the glass was captured there: it is not behind the glass, so look straight through
    if (sceneDepth) c = select(linearDepth(sceneDepth.sample(suv)).lessThan(linearDepth()), screen!.sample(screenUV).level(lod).rgb, c)
    return { c, t1 }
  }
  // the backdrop colour and the path through the slab (slab units) its light travelled, by mode (JS-time branches)
  let c: Node<'vec3'>, path: Node<'float'>
  /** 'fill' with a border: 1 on the border band, 0 inside it (with its antialiasing ramp between). */
  let band: Node<'float'> | null = null
  if (mode === 'refract') {
    if (o.dispersion === false) { const g = channel(float(1)); c = g.c; path = g.t1 }
    else {
      const k = dispersion.mul(0.03)
      const r = channel(float(1).sub(k)), g = channel(float(1)), b = channel(float(1).add(k))
      c = vec3(r.c.r, g.c.g, b.c.b); path = g.t1
    }
  } else if (mode === 'straight') {
    path = min(depth.div(max(dot(V, nb), 0.15)), thickness.mul(4))      // the undeviated ray's
    if (contentTex) {
      // along the view ray to the content plane: no ray offset. That point lies on the fragment's own pixel, so the
      // capture behind the plane is read at screenUV (and nothing nearer can be in the way: no depth reject)
      const t = max(dot(origin.sub(positionView), nb).div(min(dot(V.negate(), nb), -0.05)), 0)
      const content = frosted(contentTex, planeUV(positionView.sub(V.mul(t))))
      c = behind ? content.rgb.add(mix(behind.sample(screenUV).level(behindLevel).rgb, vec3(1), behindLift).mul(float(1).sub(content.a))) : content.rgb
    } else c = screen!.sample(screenUV).level(lod).rgb
  } else {
    // the fill is the colour itself (no tint absorption or frost over it): the glow colour, else a tint, else `fill`
    const f = o.fill, plain = f ? vec3(f.r, f.g, f.b) : vec3(1, 1, 1)
    const tinted = min(tint.x, min(tint.y, tint.z)).lessThan(0.999)        // an untinted slab packs white
    c = select(glowStrength.greaterThan(0), glowColor, select(tinted, tint, plain))
    if (o.border) {
      // the outline band: the slab-local position (affine in the slab uv; slab units, as the packed rect and radius)
      // against the outer contour, × pt per unit: pt on any Surface (1 pt per unit on screen ones, 244 on world ones)
      const outline = varying(vec4(iRect.zw.mul(0.5), iShape.x, iCorner.x), 'vGlassOutline')
      const half = outline.xy
      const d = sdfNode(slabUV.sub(0.5).mul(half.mul(2)), half, outline.z, outline.w).mul(ptPerUnit)   // pt, < 0 inside
      const px = max(fwidth(d), 1e-6)                                   // pt per pixel; floored: smoothstep needs edge0 < edge1
      // FILL.borderPt, but never under FILL.borderMinPx pixels: a thinner band cannot put a solid pixel on every edge
      // (its phase against the pixel grid, and the silhouette's MSAA coverage, smear it to a few percent of contrast)
      const width = max(float(FILL.borderPt), px.mul(FILL.borderMinPx))
      band = smoothstep(px.mul(-0.25), px.mul(0.25), d.add(width))      // a ½-pixel ramp at its inner edge
      const b = o.border
      c = mix(c, vec3(b.r, b.g, b.b), band)
    }
    path = thickness
  }
  if (!fill) {
    c = c.mul(exp(float(1).sub(tint).mul(absorption).mul(path.div(thickness)).negate()))  // Beer–Lambert
    c = mix(c, vec3(1), roughness.mul(FROST.liftPerRoughness).add(lift))                  // frost + lift
  }
  if (contentTex) {
    // planar reflection (spec §5.4): mirror the reflected ray below the plane and sample the content where it lands
    const Rr = reflect(V.negate(), N)
    const down = Rr.sub(nb.mul(max(dot(Rr, nb), 0).mul(2)))
    const t3 = max(dot(origin.sub(positionView), nb).div(min(dot(down, nb), -0.05)), 0)
    // premultiplied "over" at the Fresnel weight: transparent content reflects nothing (not black)
    const mirrored = contentTex.sample(planeUV(positionView.add(down.mul(t3)))).level(lod.add(2))
    const w = fresnel.mul(reflection)
    c = c.mul(float(1).sub(w.mul(mirrored.a))).add(mirrored.rgb.mul(w))
  }
  // adaptive darkening (spec §4.1, clear variant): only instances with a luma index (≥ 0), over a bright backdrop
  if (lumaTex) {
    const luma = lumaTex.sample(vec2(lumaIndex.add(0.5).div(lumaCount), 0.5)).level(float(0)).r
    c = c.mul(mix(float(1), float(0.65), step(float(0), lumaIndex).mul(step(float(0.6), luma))))
  }
  m.backdropNode = c
  // the border band is the last word on its pixels: its colour, opaque over the lit shell, no specular or glow over it
  const keep = band ? float(1).sub(band) : null
  const fillAlpha = float(o.fillAlpha ?? FILL.alpha)
  m.backdropAlphaNode = band ? mix(fillAlpha, float(1), band) : fill ? fillAlpha : float(1).sub(roughness.mul(scatter))
  if (keep) m.specularIntensityNode = keep                               // F0 and F90 both scale by it: no specular, no env
  // 'fill': the lit shell is the fill too, so the (1 − FILL.alpha) of it that shows does not wash the colour out
  m.colorNode = fill ? c : tint.mul(tint).mul(0.6)
  m.opacityNode = opacity

  // press glow around the touch point (centred slab uv), light leaking at the steep rims, and the inner glow layer
  const dt = slabUV.sub(0.5).sub(touch)
  const pressGlow = exp(dot(dt, dt).negate().div(0.36)).mul(press)
  // lit left of the split; `1 − smoothstep` keeps edge0 < edge1 (a reversed smoothstep is undefined in GLSL)
  const mask = select(split.lessThan(0), float(1), float(1).sub(smoothstep(split.sub(soft), split.add(soft), slabUV.x)))
  const emissive = vec3(pressGlow.mul(0.45)).add(tint.mul(pressGlow.mul(0.25)))
    .add(mix(vec3(1), tint, 0.5).mul(fresnel.mul(edgeGlow)))
    .add(glowColor.mul(float(fill ? 0 : 0.55).add(fresnel.mul(1.2))).mul(glowStrength).mul(mask))   // 'fill' already is the glow
  m.emissiveNode = keep ? emissive.mul(keep) : emissive

  // coloured transmitted shadow (spec §5.4): a glowing slab casts its glow colour, a tinted one what it lets through
  const neutral = vec3(...NEUTRAL_SHADOW)
  const absorbed = exp(float(1).sub(tint).mul(absorption).mul(0.9).negate()).mul(0.9)
  const shadow = select(glowStrength.greaterThan(0), mix(neutral, glowColor, 0.6), select(absorption.lessThan(1e-4), neutral, absorbed))
  // a fading glass lets more light through (white transmits all), and one faded out writes nothing to the map at all
  m.castShadowNode = vec4(mix(vec3(1), shadow, clamp(opacity, 0, 1)), 1)
  m.maskShadowNode = clipMask.and(opacity.greaterThan(0.01))

  return {
    material: m,
    setContent(tex) { if (contentTex) contentTex.value = tex },
    setLuma(tex, count) { if (lumaTex) { lumaTex.value = tex; lumaCount.value = Math.max(1, count) } },
    setPyramid(textures) {
      if (textures.length !== pyramid.length) throw new GlassUIError('GlassMaterial.setPyramid', `金字塔层数不匹配：材质有 ${pyramid.length} 层，传入 ${textures.length} 层`)
      textures.forEach((t, i) => { pyramid[i]!.value = t })
    },
    dispose() { m.dispose(); black?.dispose(); ownScreen?.dispose(); ownDepth?.dispose() },
  }
}
