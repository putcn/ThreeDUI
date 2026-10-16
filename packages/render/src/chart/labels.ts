import { CanvasTexture, Mesh, NoColorSpace, PlaneGeometry, SRGBColorSpace } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import type { RGBA } from '@glassui/core'
import type { CanvasFactory } from '@glassui/text'

/** The labels' font family: the system UI font, then the Chinese system stack (as `LineChart`'s). */
export const LABEL_FONT = 'system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", sans-serif'

/** A text plane's proportions. */
export const TEXT_PLANE = {
  /** Canvas px per pt: drawn at 3× so a label stays crisp up close, at DPR 2 and seen at a slant. */
  scale: 3,
  /** Room left and right of the text, of the font size (a glyph's overhang past its advance). */
  pad: 0.25,
  /** The plane's height, of the font size. */
  lineHeight: 1.5,
  /** Anisotropic filtering: a chart's labels lie back with its base, seen at a slant. */
  anisotropy: 4,
} as const

export interface TextPlaneOptions {
  /** pt: the font size. */
  size: number
  /** sRGB; its alpha is the plane's opacity. */
  color: RGBA
  /** Default 500. */
  weight?: number
  /** Where the plane's origin is along the text: its left end, its centre (default) or its right end. */
  align?: 'left' | 'center' | 'right'
  /** Makes the canvases the text is measured and drawn on (the root's: DOM canvases in a browser). */
  createCanvas: CanvasFactory
}

/** pt: the height of a `textPlane` of font size `size`, whatever its text (its canvas, `TEXT_PLANE.lineHeight` × size, in whole canvas px). */
export const textPlaneHeight = (size: number): number => Math.max(1, Math.ceil(size * TEXT_PLANE.lineHeight * TEXT_PLANE.scale)) / TEXT_PLANE.scale

/** A label: a plane in its x–y, facing +z, 1 unit = 1 pt; `userData.text` its text, `userData.ink` its advance width (pt). */
export type TextPlane = Mesh<PlaneGeometry, MeshBasicNodeMaterial>

/**
 * A label for a 3D chart (spatial spec §12.1): `text` drawn on a plane that lies in the chart, so it turns with it and
 * reads in perspective. The text is measured, then drawn at `TEXT_PLANE.scale` × on a transparent canvas just big
 * enough for it (its advance plus `TEXT_PLANE.pad` × size either side, `TEXT_PLANE.lineHeight` × size high, vertically
 * centred); the plane is that canvas's size in pt. Its origin is on the text's left end, centre or right end
 * (`align`), halfway up.
 *
 * The canvas holds white glyphs and serves as the material's `alphaMap` (uploaded premultiplied and untagged, so a
 * filtered or mipmapped texel's coverage is exact: no dark fringe), and the colour is the material's: a new colour is
 * `recolorTextPlane`, with no new texture. `MeshBasicNodeMaterial`: unlit, `transparent`, `depthWrite` false, not tone
 * mapped (the theme's colour as given). The caller owns it: `disposeTextPlane` frees its geometry, material and texture.
 */
export function textPlane(text: string, opts: TextPlaneOptions): TextPlane {
  const { size, color, weight = 500, align = 'center', createCanvas } = opts
  const S = TEXT_PLANE.scale, font = `${weight} ${size * S}px ${LABEL_FONT}`
  const probe = createCanvas(1, 1).getContext('2d')
  probe.font = font
  const ink = probe.measureText(text).width / S, pad = TEXT_PLANE.pad * size
  const cw = Math.max(1, Math.ceil((ink + 2 * pad) * S)), ch = Math.round(textPlaneHeight(size) * S)
  const canvas = createCanvas(cw, ch), g = canvas.getContext('2d')
  g.font = font; g.textBaseline = 'middle'; g.fillStyle = '#ffffff'
  g.fillText(text, pad * S, ch / 2)

  const map = new CanvasTexture(canvas as never)
  map.colorSpace = NoColorSpace; map.premultiplyAlpha = true; map.anisotropy = TEXT_PLANE.anisotropy
  const w = cw / S, start = align === 'left' ? 0 : align === 'right' ? -ink : -ink / 2   // where the text begins
  const geometry = new PlaneGeometry(w, ch / S)
  geometry.translate(start - pad + w / 2, 0, 0)
  const material = new MeshBasicNodeMaterial({ alphaMap: map, transparent: true, depthWrite: false })
  material.toneMapped = false
  const mesh: TextPlane = new Mesh(geometry, material)
  mesh.userData.text = text; mesh.userData.ink = ink
  recolorTextPlane(mesh, color)
  return mesh
}

/** Gives `plane` the colour `color` (sRGB; its alpha the opacity, written only when it changes). */
export function recolorTextPlane(plane: TextPlane, color: RGBA): void {
  const [r, g, b, a] = color
  plane.material.color.setRGB(r, g, b, SRGBColorSpace)
  if (plane.userData.alpha !== a) { plane.material.opacity = a; plane.userData.alpha = a }
}

/** Frees `plane`'s geometry, material and texture, and takes it off its parent. */
export function disposeTextPlane(plane: TextPlane): void {
  plane.removeFromParent()
  plane.material.alphaMap?.dispose(); plane.material.dispose(); plane.geometry.dispose()
}
