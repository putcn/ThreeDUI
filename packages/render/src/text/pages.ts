import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace } from 'three'
import type { AtlasManager } from '@glassui/text'

/**
 * GPU textures for the atlas pages (white glyphs on transparent, sampled for their alpha); call `sync()` once per frame
 * after layout. Each texture wraps its page canvas as is: raw data (no colour space), straight alpha, linear filtering
 * with mipmaps and anisotropy 4, and three's default `flipY`, so the atlas's top-left uv (u, v) samples at (u, 1 − v).
 */
export class AtlasPages {
  readonly textures: CanvasTexture[] = []
  private lastEpoch: number
  constructor(private readonly atlas: AtlasManager) { this.lastEpoch = atlas.epoch }

  /**
   * Creates textures for new pages, marks dirty pages for upload and clears the atlas's dirty set. `uploaded`: the page
   * indices (re)uploaded, ascending; `epochChanged`: slots were invalidated (eviction, `invalidate()`) since the last
   * sync, so quads built from earlier layouts may point at wiped glyphs.
   */
  sync(): { uploaded: number[]; epochChanged: boolean } {
    const uploaded: number[] = []
    for (let i = this.textures.length; i < this.atlas.pages.length; i++) {
      const t = new CanvasTexture(this.atlas.pages[i] as unknown as HTMLCanvasElement)
      t.colorSpace = NoColorSpace; t.generateMipmaps = true; t.minFilter = LinearMipmapLinearFilter; t.magFilter = LinearFilter
      t.anisotropy = 4; t.premultiplyAlpha = false
      this.textures.push(t)
      uploaded.push(i)
    }
    for (const i of this.atlas.dirtyPages) { this.textures[i]!.needsUpdate = true; if (!uploaded.includes(i)) uploaded.push(i) }
    this.atlas.clearDirty()
    const epochChanged = this.atlas.epoch !== this.lastEpoch
    this.lastEpoch = this.atlas.epoch
    return { uploaded: uploaded.sort((a, b) => a - b), epochChanged }
  }

  dispose(): void { for (const t of this.textures) t.dispose() }
}
