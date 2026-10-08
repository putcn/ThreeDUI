import { BackSide, DataTexture, FrontSide, RGBAFormat, UnsignedByteType, type InstancedBufferGeometry, type Texture, type Vector2 } from 'three'
import { MeshPhysicalNodeMaterial, ViewportDepthTextureNode, ViewportTextureNode, type Node, type TextureNode, type UniformNode } from 'three/webgpu'
import {
  attribute, float, vec2, vec3, vec4, uniform, texture, varying, positionView, positionViewDirection, normalView,
  transformNormalToView, negateOnBackSide, modelViewMatrix, cameraProjectionMatrix, viewportMipTexture,
  linearDepth, screenUV, refract, reflect, normalize, dot, max, min, abs, exp, mix, clamp, pow, smoothstep, step, select, length,
} from 'three/tsl'
import { GLASS_ATTRS } from './batch'
import { slabVertex } from './vertex'

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
  /** The screen capture to refract (screen only), shared per layer and disposed by its owner; default: a new `ScreenCapture` this material owns. */
  screen?: ReturnType<typeof viewportMipTexture> | undefined
  /** Backdrop luma per instance (Task 23); default: 1×1 black, i.e. never darken. `setLuma` swaps it. */
  luma?: Texture | undefined
  /** Screen only: where the refracted sample hits something nearer than the glass, sample straight through instead. */
  depthReject?: boolean | undefined
}

export interface GlassMaterial {
  material: MeshPhysicalNodeMaterial
  /** Swaps the panel content texture in place (no rebuild); a no-op for a screen backdrop, which has none. */
  setContent(tex: Texture): void
  /** Swaps the luma texture in place: `count` texels in a row, texel `i` = instance `i`'s backdrop luma. */
  setLuma(tex: Texture, count: number): void
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

/** `viewportMipTexture()` that frees every framebuffer copy, and its own template, on `dispose`. */
export class ScreenCapture extends ViewportTextureNode {
  readonly copies = new Set<Texture>()
  /** It made its template (no texture passed in; `clone()` passes the base's). */
  private readonly ownsTemplate: boolean
  constructor(...args: ConstructorParameters<typeof ViewportTextureNode>) { super(...args); this.generateMipmaps = true; this.ownsTemplate = args[2] == null }
  override getTextureForReference(reference?: CaptureReference): Texture { return record(this, super.getTextureForReference(reference)) }
  override dispose(): void { freeCopies(this, this.ownsTemplate); super.dispose() }
}

/** `viewportDepthTexture()` that frees every depth copy on `dispose`; its template is three's, shared by all: kept. */
export class DepthCapture extends ViewportDepthTextureNode {
  readonly copies = new Set<Texture>()
  override getTextureForReference(reference?: CaptureReference): Texture { return record(this, super.getTextureForReference(reference)) }
  override dispose(): void { freeCopies(this, false); super.dispose() }
}

/** Shadow colour of untinted glass (spec §5.4): a slightly cool grey. */
const NEUTRAL_SHADOW = [0.78, 0.78, 0.84] as const

/** 1×1 black: "the backdrop is dark", so nothing darkens until a real luma pass is attached. */
function blackTexture(): DataTexture {
  const t = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat, UnsignedByteType)
  t.needsUpdate = true
  return t
}

/**
 * The glass slab material (spec §5.3, ported from the spike's `glass.ts` onto the batch's instance attributes): lights,
 * environment reflections and Fresnel come from `MeshPhysicalNodeMaterial`; the transmitted term is the backdrop
 * refracted per colour channel through the real slab thickness, with Beer–Lambert tint, frost lift, a planar
 * reflection of the content (panel), adaptive darkening (clear variant), press/edge/inner glow and a coloured
 * transmitted shadow.
 *
 * Varyings: the fragment stage never reads an instance attribute. Each would cost one inter-stage variable, and 14 of
 * them plus three's own exceed WebGPU's default 16 (`maxInterStageShaderVariables`) and WebGL2's guaranteed 15
 * (`MAX_VARYING_VECTORS`). The vertex stage packs what the fragment needs into 8 vec4 varyings (+ the slab normal);
 * the position-dependent ones (depth, slab uv, clip coordinates) are affine in the slab-local position, so their
 * interpolation is exact.
 *
 * Units: the refraction depth is measured in the slab's own frame (slab-local z, the height above its back face, in
 * the units of its thickness), so a tilted, scaled or elevated slab refracts as it would flat; the path inside is
 * converted to view units by the length of the slab's z axis in view space (instance z scale × model-view scale: a
 * screen-layer Surface is scaled by units per px).
 */
export function createGlassMaterial(o: GlassMaterialOptions): GlassMaterial {
  if (o.backdrop === 'panel' && !o.content) throw new Error('[render] createGlassMaterial: backdrop "panel" needs a content texture')
  // three compiles a missing attribute to zeros (opacity 0: invisible glass), so fail here instead
  for (const name of GLASS_ATTRS) if (!o.geometry.hasAttribute(name)) throw new Error(`[render] createGlassMaterial: geometry has no "${name}" attribute`)
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

  const black = o.luma ? null : blackTexture()
  const contentTex = o.backdrop === 'panel' && o.content ? texture(o.content) : null   // non-null exactly for 'panel'
  const lumaTex = texture(o.luma ?? black!)
  const lumaCount = uniform(1)
  const ownScreen = o.backdrop === 'screen' && !o.screen ? new ScreenCapture() : null
  // @types/three declares viewportMipTexture as returning a plain Node; it is a ViewportTextureNode (a TextureNode)
  const screen = o.backdrop === 'screen' ? (o.screen ?? ownScreen) as TextureNode : null
  // one base node for every depth sample: its clones share one captured depth texture (one copy per target)
  const sceneDepth = o.backdrop === 'screen' && o.depthReject ? new DepthCapture() : null

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

  // clip: the material discards where the mask is false, and the shadow pass reuses the mask
  const q = abs(vClip.xy).sub(vClip.zw)
  const clipDist = length(max(q, 0)).add(min(max(q.x, q.y), 0)).sub(clipR)
  m.maskNode = clipR.lessThan(0).or(clipDist.lessThanEqual(0))

  const lod = roughness.mul(8)
  const V = positionViewDirection, N = normalView
  // floored base: WGSL pow is exp2(y·log2 x), undefined at x = 0 (N·V = 1)
  const fresnel = pow(max(float(1).sub(clamp(dot(N, V), 0, 1)), 1e-6), 2.5)

  // the content plane (mesh-local z = 0) in view space: origin, in-plane axes, normal
  const origin = modelViewMatrix.mul(vec4(0, 0, 0, 1)).xyz
  const ex = modelViewMatrix.mul(vec4(1, 0, 0, 0)).xyz, ey = modelViewMatrix.mul(vec4(0, 1, 0, 0)).xyz
  const nb = normalize(modelViewMatrix.mul(vec4(0, 0, 1, 0)).xyz)
  /** Content uv of a view-space point on the plane: its mesh-local xy over the Surface size. */
  const planeUV = (P: Node<'vec3'>) => {
    const d = P.sub(origin)
    return vec2(dot(d, ex).div(dot(ex, ex)), dot(d, ey).div(dot(ey, ey))).div(size).add(0.5)
  }

  /** One colour channel's refraction: the backdrop colour along the refracted ray and the path length inside (slab units). */
  const channel = (iorScale: Node<'float'>) => {
    const R = refract(V.negate(), N, float(1).div(ior.mul(iorScale)))
    const t1 = min(depth.div(max(dot(R.negate(), nb), 0.15)), thickness.mul(4))
    const inside = positionView.add(R.mul(t1.mul(slabToView)))            // where the ray leaves the slab back
    if (contentTex) {
      // then straight on (along the view ray) to the content plane
      const t2 = max(dot(origin.sub(inside), nb).div(min(dot(V.negate(), nb), -0.05)), 0)
      return { c: contentTex.sample(planeUV(inside.sub(V.mul(t2)))).level(lod).rgb, t1 }
    }
    const clip = cameraProjectionMatrix.mul(vec4(inside, 1))
    const ndc = clip.xy.div(clip.w)
    const suv = vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)))
    let c: Node<'vec3'> = screen!.sample(suv).level(lod).rgb
    // something nearer than the glass was captured there: it is not behind the glass, so look straight through
    if (sceneDepth) c = select(linearDepth(sceneDepth.sample(suv)).lessThan(linearDepth()), screen!.sample(screenUV).level(lod).rgb, c)
    return { c, t1 }
  }
  const k = dispersion.mul(0.03)
  const r = channel(float(1).sub(k)), g = channel(float(1)), b = channel(float(1).add(k))
  let c: Node<'vec3'> = vec3(r.c.r, g.c.g, b.c.b)
  c = c.mul(exp(float(1).sub(tint).mul(absorption).mul(g.t1.div(thickness)).negate()))   // Beer–Lambert
  c = mix(c, vec3(1), roughness.mul(0.08).add(lift))                                      // frost + lift
  if (contentTex) {
    // planar reflection (spec §5.4): mirror the reflected ray below the plane and sample the content where it lands
    const Rr = reflect(V.negate(), N)
    const down = Rr.sub(nb.mul(max(dot(Rr, nb), 0).mul(2)))
    const t3 = max(dot(origin.sub(positionView), nb).div(min(dot(down, nb), -0.05)), 0)
    c = mix(c, contentTex.sample(planeUV(positionView.add(down.mul(t3)))).level(lod.add(2)).rgb, fresnel.mul(reflection))
  }
  // adaptive darkening (spec §4.1, clear variant): only instances with a luma index (≥ 0), over a bright backdrop
  const luma = lumaTex.sample(vec2(lumaIndex.add(0.5).div(lumaCount), 0.5)).level(float(0)).r
  c = c.mul(mix(float(1), float(0.65), step(float(0), lumaIndex).mul(step(float(0.6), luma))))
  m.backdropNode = c
  m.backdropAlphaNode = float(1).sub(roughness.mul(scatter))
  m.colorNode = tint.mul(tint).mul(0.6)
  m.opacityNode = opacity

  // press glow around the touch point (centred slab uv), light leaking at the steep rims, and the inner glow layer
  const dt = slabUV.sub(0.5).sub(touch)
  const pressGlow = exp(dot(dt, dt).negate().div(0.36)).mul(press)
  // lit left of the split; `1 − smoothstep` keeps edge0 < edge1 (a reversed smoothstep is undefined in GLSL)
  const mask = select(split.lessThan(0), float(1), float(1).sub(smoothstep(split.sub(soft), split.add(soft), slabUV.x)))
  m.emissiveNode = vec3(pressGlow.mul(0.45)).add(tint.mul(pressGlow.mul(0.25)))
    .add(mix(vec3(1), tint, 0.5).mul(fresnel.mul(edgeGlow)))
    .add(glowColor.mul(float(0.55).add(fresnel.mul(1.2))).mul(glowStrength).mul(mask))

  // coloured transmitted shadow (spec §5.4): a glowing slab casts its glow colour, a tinted one what it lets through
  const neutral = vec3(...NEUTRAL_SHADOW)
  const absorbed = exp(float(1).sub(tint).mul(absorption).mul(0.9).negate()).mul(0.9)
  const shadow = select(glowStrength.greaterThan(0), mix(neutral, glowColor, 0.6), select(absorption.lessThan(1e-4), neutral, absorbed))
  m.castShadowNode = vec4(shadow, 1)

  return {
    material: m,
    setContent(tex) { if (contentTex) contentTex.value = tex },
    setLuma(tex, count) { lumaTex.value = tex; lumaCount.value = Math.max(1, count) },
    dispose() { m.dispose(); black?.dispose(); ownScreen?.dispose(); sceneDepth?.dispose() },
  }
}
