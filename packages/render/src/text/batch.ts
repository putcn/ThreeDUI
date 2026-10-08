import { Matrix4, type InstancedBufferGeometry } from 'three'
import type { TextInstance } from '@glassui/core'
import type { GlyphPlacement, TextEngine } from '@glassui/text'
import { InstanceBuffer } from '../instances'
import { instanceMatrix, writeClip, writeMatrixRows } from '../transform'
import { createQuadGeometry } from '../quad'
import { surfaceToLocal, type SurfaceDims } from '../units'
import { srgbToLinear } from '../color'
import { runFor } from './measure'
import type { AtlasPages } from './pages'

/**
 * Per-instance vec4 attributes of a glyph: `iRect` (cx, cy, w, h; units, the untransformed glyph quad), `iUV` (u0, v0,
 * u1, v1 as the atlas reports them: top-left origin, the material flips v), `iColor` (linear rgb, alpha), the matrix
 * rows and the clip (transform.ts), `iMisc` (opacity, luma index (−1: none), 0, 0).
 */
export const GLYPH_ATTRS = ['iRect', 'iUV', 'iColor', 'iMat0', 'iMat1', 'iMat2', 'iClipRect', 'iClipInv', 'iClipT', 'iMisc'] as const

/** One atlas page's glyph quads: one instanced draw (with that page's material). */
export interface PageBatch { geometry: InstancedBufferGeometry; buffer: InstanceBuffer }

/** A laid-out glyph and the index of its text instance in the z-sorted list. */
interface Placed { g: GlyphPlacement; k: number }

const offset = new Matrix4()

/**
 * Every glyph of a Surface's text instances as quads, one instanced draw per atlas page; each page's glyphs sorted
 * far→near by their text's `z`. `update` rebuilds everything from the list: a page's batch is created the first time
 * it has glyphs and kept (at zero instances when it has none), its buffer never shrinks.
 *
 * A glyph is placed inside its text instance's own frame: the text's matrix (`instanceMatrix`: its composed transform,
 * its tilt about the text rect's centre, `elevation + lift(t)` pt above the Surface) times the glyph's offset from the
 * text rect's centre, so a tilted text turns as one block. The engine lays the text out at the text rect's width with
 * its alignment. The page textures are synced at the end (`AtlasPages.sync`).
 */
export class GlyphBatch {
  readonly perPage = new Map<number, PageBatch>()
  glyphCount = 0
  private readonly mats: Matrix4[] = []   // per sorted text instance, reused across updates
  private readonly m = new Matrix4()
  constructor(private readonly engine: TextEngine, private readonly pages: AtlasPages) {}

  update(instances: readonly TextInstance[], s: SurfaceDims, lift: (t: TextInstance) => number = () => 0): void {
    const ppu = s.ptPerUnit
    const sorted = [...instances].sort((a, b) => a.z - b.z)
    const byPage = new Map<number, Placed[]>()
    let count = 0
    sorted.forEach((t, k) => {
      instanceMatrix({ ...t, elevation: t.elevation + lift(t) }, s, this.mats[k] ??= new Matrix4())
      for (const g of this.engine.layout(runFor(t), t.rect.width, t.align)) {
        let list = byPage.get(g.page)
        if (!list) byPage.set(g.page, list = [])
        list.push({ g, k }); count++
      }
    })
    this.glyphCount = count

    for (const [page, pb] of this.perPage) if (!byPage.has(page)) { pb.buffer.begin(0); pb.buffer.commit() }
    for (const [page, list] of byPage) {
      let pb = this.perPage.get(page)
      if (!pb) { const geometry = createQuadGeometry(); pb = { geometry, buffer: new InstanceBuffer(geometry, GLYPH_ATTRS, 64) }; this.perPage.set(page, pb) }
      const b = pb.buffer
      b.begin(list.length)
      list.forEach(({ g, k }, i) => {
        const t = sorted[k]!
        // the glyph's centre relative to the text rect's centre, pt (y down)
        const dx = g.x + g.width / 2 - t.rect.width / 2, dy = g.y + g.height / 2 - t.rect.height / 2
        const [cx, cy] = surfaceToLocal(t.rect.x + g.x + g.width / 2, t.rect.y + g.y + g.height / 2, s)
        b.set(i, 'iRect', cx, cy, g.width / ppu, g.height / ppu)
        b.set(i, 'iUV', g.u0, g.v0, g.u1, g.v1)
        b.set(i, 'iColor', srgbToLinear(t.color[0]), srgbToLinear(t.color[1]), srgbToLinear(t.color[2]), t.color[3])
        writeMatrixRows(b, i, this.m.multiplyMatrices(this.mats[k]!, offset.makeTranslation(dx / ppu, -dy / ppu, 0)))
        writeClip(b, i, t.clip)
        b.set(i, 'iMisc', t.opacity, -1, 0, 0)
      })
      b.commit()
    }
    this.pages.sync()
  }

  dispose(): void { for (const pb of this.perPage.values()) pb.buffer.dispose(); this.perPage.clear() }
}
