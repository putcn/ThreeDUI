import { createCanvas } from '@napi-rs/canvas'
import { AtlasManager, type CanvasFactory, type GlyphPlacement, type Line, type TextEngine, type TextRun } from '@glassui/text'

/** A code unit's advance, pt: monospace, 0.6 × the font size. */
const cw = (run: TextRun): number => 0.6 * run.font.size
/** Line height, pt: the run's, or 1.3 × the font size rounded. */
const lh = (run: TextRun): number => run.lineHeight ?? Math.round(1.3 * run.font.size)
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** The run's lines: one, or wrapped every `floor(maxWidth / cw)` code units (at least one) when `wrap !== false`. */
function lines(run: TextRun, maxWidth: number | undefined): Line[] {
  const c = cw(run), h = lh(run), text = run.text
  const per = run.wrap !== false && maxWidth !== undefined ? Math.max(1, Math.floor(maxWidth / c)) : Math.max(1, text.length)
  const out: Line[] = []
  for (let start = 0; start < text.length || out.length === 0; start += per) {
    const end = Math.min(text.length, start + per)
    out.push({ text: text.slice(start, end), start, end, width: (end - start) * c, y: out.length * h, truncated: false })
    if (end >= text.length) break
  }
  return out
}

/** A monospace `TextEngine` for tests (no font rasterising; the atlas is a real one over `@napi-rs/canvas`). */
export function createFakeText(): TextEngine {
  const canvas = ((w: number, h: number) => createCanvas(w, h)) as unknown as CanvasFactory
  return {
    measure(run, { maxWidth }) {
      const ls = lines(run, maxWidth)
      return { width: Math.max(0, ...ls.map(l => l.width)), height: ls.length * lh(run), lines: ls }
    },
    layout(run, maxWidth) {
      const c = cw(run), h = lh(run)
      return lines(run, maxWidth).flatMap(l => l.text.split('').map((char, i): GlyphPlacement => ({ char, x: i * c, y: l.y, width: c, height: h, page: 0, u0: 0, v0: 0, u1: 0, v1: 0 })))
    },
    caretFromPoint: (run, _w, x) => clamp(Math.round(x / cw(run)), 0, run.text.length),
    caretRect: (run, _w, i) => ({ x: i * cw(run), y: 0, height: lh(run) }),
    selectionRects: (run, _w, a, b) => [{ x: a * cw(run), y: 0, width: (b - a) * cw(run), height: lh(run) }],
    atlas: new AtlasManager({ createCanvas: canvas }),
  }
}
