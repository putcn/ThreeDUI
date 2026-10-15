import { it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const files = (d: string): string[] => readdirSync(d).flatMap(f => statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)])
it('src never imports three or the render package at runtime', () => {
  const sources = files(fileURLToPath(new URL('../src', import.meta.url))).filter(f => f.endsWith('.ts'))
  expect(sources.length).toBeGreaterThan(0)
  for (const f of sources) {
    const src = readFileSync(f, 'utf8')
    expect(src, f).not.toMatch(/from ['"]three/)
    expect(src, f).not.toMatch(/^import (?!type)[^\n]*from ['"]@glassui\/render/m)
  }
})
