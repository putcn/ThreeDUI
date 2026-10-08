import { AtlasManager } from './atlas'
import type { CanvasCtxLike, CanvasFactory, FontSpec, GlyphPlacement, Line, TextEngine, TextRun } from './types'

/**
 * CJK scripts: Han (incl. Ext A), kana, Hangul, compatibility ideographs, full-width forms and the supplementary
 * ideograph planes (Ext B+). A line may break on either side of these.
 */
const CJK = /^[⺀-鿿가-힯豈-﫿＀-￯\u{20000}-\u{3FFFF}]/u
const BLANK = /^\s+$/u
/** Atlas padding around each glyph, in atlas px. */
const PAD = 2
/** A glyph cell is 1.3 em tall: the em box plus 0.15 em above and below for accents and descenders. */
const CELL_EM = 1.3
/** The common Chinese system stack (macOS, Windows, Linux), then the platform UI font. */
const DEFAULT_FALLBACK = ['PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans SC', 'Noto Sans CJK SC', 'system-ui', 'sans-serif']

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const isHardBreak = (s: string) => s === '\n' || s === '\r\n' || s === '\r'
const quote = (family: string) => (family.includes(' ') ? `"${family}"` : family)

/** A grapheme cluster: its text, UTF-16 offset in the run, and advance in pt (letter spacing included). */
interface Cluster { s: string; i: number; w: number }
/** A laid-out line and the cluster range [c0, c1) it covers; `soft` rows end at a wrap, not at `\n` or the text end. */
interface Row { line: Line; c0: number; c1: number; soft: boolean }

/**
 * Validates a run and normalises `maxWidth` (Infinity → unconstrained). Canvas silently ignores an invalid CSS font
 * and keeps the previous one, so a bad `FontSpec` must fail here rather than measure with a stale font.
 */
function check(run: TextRun, maxWidth: number | undefined): number | undefined {
  const { family, size, weight } = run.font
  if (!family.trim()) throw new Error('[text] font family must not be empty')
  if (!(Number.isFinite(size) && size > 0)) throw new Error(`[text] font size must be a positive finite number, got ${size}`)
  if (!(Number.isFinite(weight) && weight >= 1 && weight <= 1000)) throw new Error(`[text] font weight must be in 1–1000, got ${weight}`)
  const { lineHeight, letterSpacing } = run
  if (lineHeight !== undefined && !(Number.isFinite(lineHeight) && lineHeight > 0)) throw new Error(`[text] lineHeight must be a positive finite number, got ${lineHeight}`)
  if (letterSpacing !== undefined && !Number.isFinite(letterSpacing)) throw new Error(`[text] letterSpacing must be finite, got ${letterSpacing}`)
  if (maxWidth !== undefined && !(maxWidth >= 0)) throw new Error(`[text] maxWidth must be ≥ 0 or undefined, got ${maxWidth}`)
  return maxWidth === Infinity ? undefined : maxWidth
}

/** x of the caret at `index` from the left edge of `row`: the advances of the row's clusters ending at or before it. */
function xAt(clusters: Cluster[], row: Row, index: number): number {
  let x = 0
  for (let k = row.c0; k < row.c1; k++) { const c = clusters[k]!; if (c.i + c.s.length > index) break; x += c.w }
  return x
}

/** The row a caret at `index` is drawn on: the last row starting at or before it, so a soft-wrap index opens the next row. */
function rowAt(rows: Row[], index: number): Row {
  let row = rows[0]!
  for (const r of rows) { if (r.line.start > index) break; row = r }
  return row
}

/**
 * The default text engine: system fonts through Canvas2D, so every character the platform can draw (CJK included) is
 * available without a prebuilt charset. Each distinct (font, grapheme) is rasterised once, on first layout, into the
 * shared atlas at `size × oversample` px with 2 px padding; whitespace is never rasterised.
 *
 * - Units are pt. Text indices (`Line.start/end`, caret indices) are UTF-16 offsets into `run.text`, as in DOM
 *   selections, and always fall on grapheme-cluster boundaries; a cluster (é, 👍🏽, 🇨🇳) is one glyph.
 * - With a `maxWidth`, lines wrap greedily: after a space, between two CJK characters, and at a CJK/non-CJK boundary
 *   (so a Latin word next to CJK moves to the next line whole when it fits); a word wider than the line is broken by
 *   cluster. Spaces at a line end hang: they never overflow or start the next line and are excluded from `Line.width`.
 *   `\n` and `\r\n` force a break. An infinite `maxWidth` means unconstrained.
 * - Line height defaults to round(1.3 × size); glyph quads are centred vertically in the line box. Without a
 *   `maxWidth`, centre/right alignment is relative to the widest line.
 * - Caret and selection geometry are in left-aligned line coordinates. The index shared by two soft-wrapped lines is
 *   drawn at the start of the later line (the interface carries no caret affinity).
 * - Glyph uvs are normalised page coordinates with the origin at the page canvas's top-left.
 */
export class SystemFontEngine implements TextEngine {
  readonly atlas: AtlasManager
  private measureCtx: CanvasCtxLike
  private advances = new Map<string, number>()
  private fallback: string[]
  private oversample: number

  /**
   * @param opts.pageSize / opts.maxPages atlas page edge in px and page count (defaults 2048 / 4)
   * @param opts.fallbackFamilies tried after `FontSpec.family` (default: PingFang SC, Hiragino Sans GB, Microsoft YaHei,
   *   Noto Sans SC, Noto Sans CJK SC, system-ui, sans-serif)
   * @param opts.oversample atlas px per pt, a positive number (default 2)
   */
  constructor(opts: { createCanvas: CanvasFactory; pageSize?: number | undefined; maxPages?: number | undefined; fallbackFamilies?: string[] | undefined; oversample?: number | undefined }) {
    const { oversample = 2 } = opts
    if (!(Number.isFinite(oversample) && oversample > 0)) throw new Error(`[text] oversample must be a positive finite number, got ${oversample}`)
    this.atlas = new AtlasManager({ pageSize: opts.pageSize, maxPages: opts.maxPages, createCanvas: opts.createCanvas })
    this.measureCtx = opts.createCanvas(8, 8).getContext('2d')
    this.fallback = opts.fallbackFamilies ?? DEFAULT_FALLBACK
    this.oversample = oversample
  }

  private css(f: FontSpec, scale = 1): string {
    return `${f.weight} ${f.size * scale}px ${[f.family, ...this.fallback].map(quote).join(', ')}`
  }

  /** Advance of cluster `s` in the CSS font `css`, in pt, without letter spacing. Cached per (font, cluster). */
  private advance(css: string, s: string): number {
    const key = `${css}|${s}`
    let w = this.advances.get(key)
    if (w === undefined) { this.measureCtx.font = css; w = this.measureCtx.measureText(s).width; this.advances.set(key, w) }
    return w
  }

  /** Splits a run into grapheme clusters and greedily wraps them into rows (see the class comment for the rules). */
  private shape(run: TextRun, maxWidth: number | undefined) {
    const limit = check(run, maxWidth)
    const css = this.css(run.font), ls = run.letterSpacing ?? 0, lh = run.lineHeight ?? Math.round(run.font.size * 1.3)
    const clusters: Cluster[] = []
    for (const { segment: s, index: i } of graphemes.segment(run.text)) clusters.push({ s, i, w: isHardBreak(s) ? 0 : this.advance(css, s) + ls })
    const offset = (k: number) => clusters[k]?.i ?? run.text.length
    const rows: Row[] = []
    const push = (c0: number, c1: number, soft: boolean) => {
      let t = c1; while (t > c0 && clusters[t - 1]!.s === ' ') t--   // trailing spaces hang outside the width
      let width = 0; for (let k = c0; k < t; k++) width += clusters[k]!.w
      const start = offset(c0), end = offset(c1)
      rows.push({ line: { text: run.text.slice(start, end), start, end, width, y: rows.length * lh }, c0, c1, soft })
    }
    // c0: first cluster of the open row; x: its width so far; brk: last cluster the row may break before (-1: none)
    let c0 = 0, x = 0, brk = -1
    for (let k = 0; k < clusters.length; k++) {
      const { s, w } = clusters[k]!
      if (isHardBreak(s)) { push(c0, k, false); c0 = k + 1; x = 0; brk = -1; continue }
      if (s === ' ') { x += w; continue }
      if (k > c0) { const p = clusters[k - 1]!.s; if (p === ' ' || CJK.test(s) || CJK.test(p)) brk = k }
      if (limit !== undefined && x + w > limit && k > c0) {
        if (brk > c0) { push(c0, brk, true); c0 = brk; x = 0; for (let j = c0; j < k; j++) x += clusters[j]!.w }
        if (x + w > limit && k > c0) { push(c0, k, true); c0 = k; x = 0 }   // still too wide: break the word by cluster
        brk = -1
      }
      x += w
    }
    push(c0, clusters.length, false)
    return { clusters, rows, lh, limit }
  }

  measure(run: TextRun, c: { maxWidth?: number | undefined }) {
    const { rows, lh } = this.shape(run, c.maxWidth)
    const lines = rows.map(r => r.line)
    return { width: lines.reduce((m, l) => Math.max(m, l.width), 0), height: lines.length * lh, lines }
  }

  /** The atlas slot for cluster `s`, rasterised on first use: `cell` px tall plus padding, em box centred vertically. */
  private glyphSlot(css: string, raster: string, s: string, cell: number) {
    const w = Math.ceil(this.advance(css, s) * this.oversample) + PAD * 2, h = cell + PAD * 2
    return this.atlas.allocate(`${css}|${s}`, w, h, (ctx, x, y) => {
      ctx.clearRect(x, y, w, h)   // drop any overhang a neighbouring glyph drew into this area before it was allocated
      ctx.font = raster; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'
      ctx.fillText(s, x + PAD, y + PAD + cell / 2)
    })
  }

  layout(run: TextRun, maxWidth: number | undefined, align: 'left' | 'center' | 'right'): GlyphPlacement[] {
    const { clusters, rows, lh, limit } = this.shape(run, maxWidth)
    const os = this.oversample, css = this.css(run.font), raster = this.css(run.font, os)
    const cell = Math.ceil(run.font.size * CELL_EM * os)
    const top = (lh - cell / os) / 2 - PAD / os   // quad top within its line: the cell is centred in the line box
    const box = limit ?? rows.reduce((m, r) => Math.max(m, r.line.width), 0)
    const out: GlyphPlacement[] = []
    for (const { line, c0, c1 } of rows) {
      const free = Math.max(0, box - line.width)
      let x = align === 'center' ? free / 2 : align === 'right' ? free : 0
      for (let k = c0; k < c1; k++) {
        const c = clusters[k]!
        if (!BLANK.test(c.s)) {
          const s = this.glyphSlot(css, raster, c.s, cell), size = this.atlas.pages[s.page]!.width
          out.push({
            char: c.s, x: x - PAD / os, y: line.y + top, width: s.width / os, height: s.height / os, page: s.page,
            u0: s.x / size, v0: s.y / size, u1: (s.x + s.width) / size, v1: (s.y + s.height) / size,
          })
        }
        x += c.w
      }
    }
    return out
  }

  caretRect(run: TextRun, maxWidth: number | undefined, index: number) {
    const { clusters, rows, lh } = this.shape(run, maxWidth)
    const row = rowAt(rows, index)
    return { x: xAt(clusters, row, index), y: row.line.y, height: lh }
  }

  caretFromPoint(run: TextRun, maxWidth: number | undefined, x: number, y: number): number {
    const { clusters, rows, lh } = this.shape(run, maxWidth)
    const row = rows[Math.min(rows.length - 1, Math.max(0, Math.floor(y / lh)))] ?? rows[0]!   // NaN y → first row
    let end = row.c1
    if (row.soft) while (end > row.c0 && clusters[end - 1]!.s === ' ') end--   // a wrapped row's hanging spaces are not targets
    let cx = 0
    for (let k = row.c0; k < end; k++) { const c = clusters[k]!; if (x < cx + c.w / 2) return c.i; cx += c.w }
    return clusters[end]?.i ?? run.text.length
  }

  selectionRects(run: TextRun, maxWidth: number | undefined, start: number, end: number) {
    const { clusters, rows, lh } = this.shape(run, maxWidth)
    const a = Math.min(start, end), b = Math.max(start, end)
    return rows.filter(r => a < b && r.line.end > a && r.line.start < b).map(r => {
      const x0 = xAt(clusters, r, a), x1 = xAt(clusters, r, b)
      return { x: x0, y: r.line.y, width: x1 - x0, height: lh }
    })
  }
}
