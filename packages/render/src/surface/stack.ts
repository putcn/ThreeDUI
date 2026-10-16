import { AddEquation, Color, CustomBlending, Mesh, OneFactor, OneMinusSrcAlphaFactor, PlaneGeometry, type Material, type Texture } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { texture, uv, vec2 } from 'three/tsl'
import type { ColorScheme, GlassInstance, ImageInstance, PanelInstance, RGBA, TextInstance, Theme } from '@glassui/core'
import type { TextEngine } from '@glassui/text'
import { ContentPass, type RendererLike } from './content'
import { PanelBatch } from '../panel/batch'
import { createPanelMaterial } from '../panel/material'
import { GlyphBatch } from '../text/batch'
import { createGlyphMaterial } from '../text/material'
import type { AtlasPages } from '../text/pages'
import { ImageSet } from '../image/images'
import { fillTokens } from '../glass/frost'
import type { SurfaceUniforms } from '../flat'
import type { SurfaceDims } from '../units'

/** Spatial spec §2.4: the opacity of an outer glass's panel in the stacked RT, its fill and its border alike. */
export const STACK_FILL_ALPHA = 0.35

/**
 * `renderOrder` of each draw inside the stacked RT's scene: the content RT first, then the outer glass's panels and what
 * rides on them (images in [images, images + ½) in z order, as `CONTENT_ORDER`).
 */
export const STACK_ORDER = { content: -1, panels: 0, images: 1.5, glyphs: 2 } as const

/**
 * The stack's first draw: `content` (the content RT, premultiplied) copied onto a unit quad the Surface's size, so the
 * stacked RT starts as the content RT. Unlit, composited premultiplied (source One, alpha "over") over the stack's
 * transparent clear; sampled at (u, 1 − v) as the content quad does (`createContentMaterial`), so the stack keeps the
 * content RT's orientation (v = 0 at the top row) and the inner glass samples it as the outer glass samples the content.
 */
export function createStackContentMaterial(content: Texture): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial()
  const sample = texture(content, vec2(uv().x, uv().y.oneMinus()))
  m.colorNode = sample.rgb
  m.opacityNode = sample.a
  m.lights = false   // unlit outright, as the panel material
  m.transparent = true; m.depthWrite = false; m.depthTest = false; m.toneMapped = false
  m.blending = CustomBlending; m.premultipliedAlpha = false
  m.blendEquation = AddEquation; m.blendSrc = OneFactor; m.blendDst = OneMinusSrcAlphaFactor
  m.blendEquationAlpha = AddEquation; m.blendSrcAlpha = OneFactor; m.blendDstAlpha = OneMinusSrcAlphaFactor
  return m
}

/** `c` with its alpha multiplied by `STACK_FILL_ALPHA`. */
const translucent = (c: RGBA): RGBA => [c[0], c[1], c[2], c[3] * STACK_FILL_ALPHA]

/**
 * Spatial spec §2.4, nested glass: what glass inside glass sees. A second RT, the content RT's size and texel type
 * (a `ContentPass` of its own, drawn in the content pass's space: `setView`, Surface-local units), holding
 *
 * 1. the content RT (`createStackContentMaterial`, at `STACK_ORDER.content`);
 * 2. each outer glass as a translucent panel (`PanelBatch`), with the glass's rect, radius, z, placement, opacity and
 *    clip, filled with the colour the `'fill'` glass mode gives it — its glow colour (a glow of strength > 0), else its
 *    tint, else the theme's `fill` a shade toward `label` (`fillTokens`) — and a 1 pt `tertiaryLabel` border, both at
 *    their alpha × `STACK_FILL_ALPHA`. Panels rather than the 'fill' glass material: its lit shell turns black in an
 *    offscreen scene without lights;
 * 3. the foreground text and images riding on an outer glass, flat (no lift).
 *
 * The inner glass samples `texture` and its mips (`ContentPass`'s target is mipmapped) where the outer glass samples
 * the content RT. The Surface makes one only while it has nested glass in a glass mode that samples a backdrop,
 * resizes it with the content RT and renders it right after every content redraw. `su` is the content pass's uniforms
 * (no opacity): the inner glass on the plane fades, the RT never.
 */
export class StackPass {
  readonly pass: ContentPass
  readonly panels = new PanelBatch()
  readonly text: GlyphBatch
  readonly images: ImageSet
  private readonly quad: Mesh<PlaneGeometry, MeshBasicNodeMaterial>
  private readonly glyphs = new Map<number, Mesh>()
  private readonly materials: Material[] = []
  private readonly pages: AtlasPages
  private readonly clear = { color: new Color(0, 0, 0), alpha: 0 }

  /** `opts.text` and `opts.pages`: the Surface's text engine and atlas pages, which lay out and sample the stack's glyphs. */
  constructor(content: Texture, private readonly su: SurfaceUniforms, opts: { type?: 'byte' | 'half'; text: TextEngine; pages: AtlasPages }) {
    this.pass = new ContentPass(opts)
    this.pages = opts.pages
    this.text = new GlyphBatch(opts.text, opts.pages)
    this.images = new ImageSet(su)
    this.quad = new Mesh(new PlaneGeometry(1, 1), this.own(createStackContentMaterial(content)))
    this.quad.renderOrder = STACK_ORDER.content; this.quad.frustumCulled = false
    const panels = new Mesh(this.panels.geometry, this.own(createPanelMaterial(this.panels.geometry, su)))
    panels.renderOrder = STACK_ORDER.panels; panels.frustumCulled = false
    this.pass.scene.add(this.quad, panels, this.images.container)
  }

  get texture(): Texture { return this.pass.texture }

  /**
   * Rewrites the stack's draws: `outer` as panels (coloured from `theme` for `scheme`), `text` and `images` (what rides
   * on them) flat; the view and the content quad follow `s`.
   */
  update(outer: readonly GlassInstance[], text: readonly TextInstance[], images: readonly ImageInstance[], s: SurfaceDims, theme: Theme, scheme: ColorScheme): void {
    const t = fillTokens(theme, scheme)
    const border = { width: 1, color: translucent(t.border) }
    this.panels.update(outer.map((g): PanelInstance => {
      const { node, rect, radius, z, elevation, scale, transform, tilt, opacity, clip, params: p } = g
      const color = p.glow && p.glow.strength > 0 ? p.glow.color : p.tint ?? t.glass   // the 'fill' mode's rule
      return { node, rect, radius, z, elevation, scale, transform, tilt, opacity, color: translucent(color), border, ...(clip ? { clip } : {}) }
    }), s)
    this.text.update(text, s)
    for (const [page, pb] of this.text.perPage) {
      if (this.glyphs.has(page)) continue
      const mesh = new Mesh(pb.geometry, this.own(createGlyphMaterial(pb.geometry, this.su, this.pages.textures[page]!)))
      mesh.renderOrder = STACK_ORDER.glyphs; mesh.frustumCulled = false
      this.pass.scene.add(mesh); this.glyphs.set(page, mesh)
    }
    this.images.update(images, s, undefined, STACK_ORDER.images)
    this.pass.setView(s)
    this.quad.scale.set(s.width / s.ptPerUnit, s.height / s.ptPerUnit, 1)
  }

  /** The RT's size in texels (the content RT's); true if it changed. */
  resize(width: number, height: number): boolean { return this.pass.resize(width, height) }
  /** The RT's texel type (the content RT's), switched in place. */
  setType(type: 'byte' | 'half'): void { this.pass.setType(type) }
  /** Clears the RT to transparent (0, 0, 0) at alpha 0 and draws the stack into it. */
  render(renderer: RendererLike): void { this.pass.render(renderer, this.clear) }

  dispose(): void {
    this.pass.dispose(); this.panels.dispose(); this.text.dispose(); this.images.dispose()
    for (const m of this.materials) m.dispose()
    this.quad.geometry.dispose()
  }

  private own<M extends Material>(m: M): M { this.materials.push(m); return m }
}
