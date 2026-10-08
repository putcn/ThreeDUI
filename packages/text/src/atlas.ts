import type { CanvasCtxLike, CanvasFactory, CanvasLike } from './types'

/** Where a glyph lives: atlas page index and its pixel rect on that page. */
export interface AtlasSlot { page: number; x: number; y: number; width: number; height: number }

interface Shelf { y: number; height: number; x: number }
interface Page { canvas: CanvasLike; ctx: CanvasCtxLike; shelves: Shelf[]; nextY: number; keys: Set<string>; lastUse: number }

/**
 * Packs rasterised glyphs into square canvas pages with shelf packing. When every page is full, the least recently
 * used page (by `get`/`allocate`) is cleared and reused, dropping all of its slots. `dirtyPages` collects the pages
 * drawn to since the last `clearDirty()`, i.e. the textures the renderer must re-upload.
 */
export class AtlasManager {
  readonly pages: CanvasLike[] = []
  readonly dirtyPages = new Set<number>()
  private pageData: Page[] = []
  private slots = new Map<string, AtlasSlot>()
  private tick = 0
  private pageSize: number; private maxPages: number; private createCanvas: CanvasFactory

  /**
   * @param opts.pageSize page edge in px, a positive integer (default 2048)
   * @param opts.maxPages pages kept before LRU eviction, a positive integer (default 4)
   */
  constructor(opts: { pageSize?: number | undefined; maxPages?: number | undefined; createCanvas: CanvasFactory }) {
    const { pageSize = 2048, maxPages = 4 } = opts
    if (!(Number.isInteger(pageSize) && pageSize > 0)) throw new Error(`[atlas] pageSize must be a positive integer, got ${pageSize}`)
    if (!(Number.isInteger(maxPages) && maxPages > 0)) throw new Error(`[atlas] maxPages must be a positive integer, got ${maxPages}`)
    this.pageSize = pageSize; this.maxPages = maxPages; this.createCanvas = opts.createCanvas
  }

  /** The cached slot for `key`, if its page has not been evicted; marks that page as recently used. */
  get(key: string): AtlasSlot | undefined {
    const s = this.slots.get(key)
    if (s) this.pageData[s.page]!.lastUse = ++this.tick
    return s
  }

  private newPage(): number {
    const canvas = this.createCanvas(this.pageSize, this.pageSize)
    this.pageData.push({ canvas, ctx: canvas.getContext('2d'), shelves: [], nextY: 0, keys: new Set(), lastUse: ++this.tick })
    this.pages.push(canvas)
    return this.pageData.length - 1
  }

  private evictLRU(): number {
    let idx = 0
    for (let i = 1; i < this.pageData.length; i++) if (this.pageData[i]!.lastUse < this.pageData[idx]!.lastUse) idx = i
    const p = this.pageData[idx]!
    for (const k of p.keys) this.slots.delete(k)
    p.keys.clear(); p.shelves = []; p.nextY = 0; p.lastUse = ++this.tick
    p.ctx.clearRect(0, 0, this.pageSize, this.pageSize)
    return idx
  }

  /** First shelf tall enough with room left, else a new shelf below the last one, else null (page full). */
  private tryPlace(pageIdx: number, w: number, h: number): { x: number; y: number } | null {
    const p = this.pageData[pageIdx]!
    for (const s of p.shelves) if (h <= s.height && s.x + w <= this.pageSize) { const at = { x: s.x, y: s.y }; s.x += w; return at }
    if (p.nextY + h <= this.pageSize) { const shelf = { y: p.nextY, height: h, x: w }; p.shelves.push(shelf); p.nextY += h; return { x: 0, y: shelf.y } }
    return null
  }

  /**
   * The slot for `key`: the cached one if present (`draw` is not called), else a fresh `ceil(width)×ceil(height)` slot
   * on which `draw` is called once with the page context and the slot origin. The slot area starts transparent.
   */
  allocate(key: string, width: number, height: number, draw: (ctx: CanvasCtxLike, x: number, y: number) => void): AtlasSlot {
    const w = Math.ceil(width), h = Math.ceil(height)
    // Negated so NaN is rejected too: NaN/negative sizes would silently corrupt a shelf's cursor.
    if (!(w >= 0 && h >= 0)) throw new Error(`[atlas] invalid glyph size ${width}×${height} (must be ≥ 0)`)
    if (w > this.pageSize || h > this.pageSize) throw new Error(`[atlas] glyph ${w}×${h} exceeds page size ${this.pageSize}`)
    const existing = this.get(key); if (existing) return existing
    let pageIdx = -1, at: { x: number; y: number } | null = null
    for (let i = 0; i < this.pageData.length && !at; i++) { at = this.tryPlace(i, w, h); if (at) pageIdx = i }
    // A new or just-cleared page always has room: w and h are within the page size.
    if (!at) { pageIdx = this.pageData.length < this.maxPages ? this.newPage() : this.evictLRU(); at = this.tryPlace(pageIdx, w, h)! }
    const slot: AtlasSlot = { page: pageIdx, x: at.x, y: at.y, width: w, height: h }
    const p = this.pageData[pageIdx]!
    draw(p.ctx, at.x, at.y)
    p.keys.add(key); p.lastUse = ++this.tick
    this.slots.set(key, slot); this.dirtyPages.add(pageIdx)
    return slot
  }

  /** Call after uploading the dirty pages to the GPU. */
  clearDirty(): void { this.dirtyPages.clear() }
}
