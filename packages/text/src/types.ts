import type { AtlasManager } from './atlas'

export interface FontSpec { family: string; size: number; weight: number }
// `| undefined` on optionals: callers forward possibly-undefined values (e.g. core's `MeasureFn` maxWidth) under exactOptionalPropertyTypes.
export interface TextRun { text: string; font: FontSpec; letterSpacing?: number | undefined; lineHeight?: number | undefined }
export interface Line { text: string; start: number; end: number; width: number; y: number }
export interface GlyphPlacement { char: string; x: number; y: number; width: number; height: number; page: number; u0: number; v0: number; u1: number; v1: number }

/** The Canvas2D subset the text package uses; browser canvases, OffscreenCanvas and `@napi-rs/canvas` all satisfy it. */
export interface CanvasCtxLike {
  font: string; textBaseline: string; fillStyle: string
  measureText(s: string): { width: number; actualBoundingBoxAscent?: number; actualBoundingBoxDescent?: number }
  fillText(s: string, x: number, y: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray; width: number; height: number }
}
export interface CanvasLike { width: number; height: number; getContext(type: '2d'): CanvasCtxLike }
export type CanvasFactory = (width: number, height: number) => CanvasLike

export interface TextEngine {
  measure(run: TextRun, c: { maxWidth?: number | undefined }): { width: number; height: number; lines: Line[] }
  layout(run: TextRun, maxWidth: number | undefined, align: 'left' | 'center' | 'right'): GlyphPlacement[]
  caretFromPoint(run: TextRun, maxWidth: number | undefined, x: number, y: number): number
  caretRect(run: TextRun, maxWidth: number | undefined, index: number): { x: number; y: number; height: number }
  selectionRects(run: TextRun, maxWidth: number | undefined, start: number, end: number): { x: number; y: number; width: number; height: number }[]
  atlas: AtlasManager
}
