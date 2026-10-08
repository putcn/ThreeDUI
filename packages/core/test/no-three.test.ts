import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Static, side-effect, dynamic and CommonJS imports of `three` or `three/...`.
const THREE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]three(?:['"\/])/

const GPU_FREE_PACKAGES = ['core', 'text']

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

describe('GPU-free packages', () => {
  for (const pkg of GPU_FREE_PACKAGES) {
    it(`@glassui/${pkg} never imports three`, () => {
      const src = fileURLToPath(new URL(`../../${pkg}/src`, import.meta.url))
      const sources = files(src)
      expect(sources.length, `${src} has no source files to scan`).toBeGreaterThan(0)
      for (const f of sources) {
        expect(readFileSync(f, 'utf8'), f).not.toMatch(THREE_IMPORT)
      }
    })
  }
})
