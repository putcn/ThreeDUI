import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

describe('@glassui/core stays GPU-free', () => {
  it('never imports three', () => {
    const src = join(__dirname, '..', 'src')
    for (const f of files(src)) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/from ['"]three/)
    }
  })
})
