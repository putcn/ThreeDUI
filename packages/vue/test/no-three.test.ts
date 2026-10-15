import { it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const files = (d: string): string[] => readdirSync(d).flatMap(f => statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)])

const SPEC = String.raw`['"](?:three|@glassui\/render)['"\/]`
/**
 * A runtime import or re-export of `three` / `@glassui/render`, across lines: `import` / `export … from` that is not
 * `import type` / `export type` (the clause may span lines but not another import/export or a string), a side-effect
 * `import '…'`, a dynamic `import('…')`, a `require('…')`.
 */
const RUNTIME = new RegExp([
  String.raw`\b(?:import|export)\s+(?!type\b)(?:(?!\b(?:import|export)\b)[\w\s{},*$])*?\bfrom\s*${SPEC}`,
  String.raw`\bimport\s*\(?\s*${SPEC}`,
  String.raw`\brequire\s*\(\s*${SPEC}`,
].join('|'))

it('the import pattern catches multi-line imports and re-exports, and lets type-only ones through', () => {
  const runtime = [
    `import { A } from '@glassui/render'`, `import {\n  A,\n  B,\n} from '@glassui/render'`, `import { type A, B } from "@glassui/render"`,
    `export { A } from '@glassui/render'`, `export {\n  A,\n} from '@glassui/render'`, `export * from 'three'`, `import * as T from 'three'`,
    `import 'three'`, `import { X } from 'three/webgpu'`, `const m = await import('three')`, `const t = require('three')`,
  ]
  const typeOnly = [
    `import type { A } from '@glassui/render'`, `import type {\n  A,\n  B,\n} from '@glassui/render'`, `export type { A } from '@glassui/render'`,
    `import { A } from 'x'\nimport type { B } from '@glassui/render'`, `export { a }\nimport type { T } from '@glassui/render'`,
    `import { threeish } from './three-free'`, `import { X } from 'threejs-extras'`,
  ]
  for (const src of runtime) expect(src, src).toMatch(RUNTIME)
  for (const src of typeOnly) expect(src, src).not.toMatch(RUNTIME)
})
it('src never imports three or the render package at runtime', () => {
  const sources = files(fileURLToPath(new URL('../src', import.meta.url))).filter(f => f.endsWith('.ts'))
  expect(sources.length).toBeGreaterThan(0)
  for (const f of sources) expect(readFileSync(f, 'utf8'), f).not.toMatch(RUNTIME)
})
