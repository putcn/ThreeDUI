import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const path = (p: string): string => fileURLToPath(new URL(p, import.meta.url))
const manifest = (p: string): { dependencies: Record<string, string> } => JSON.parse(readFileSync(path(p), 'utf8'))

// A page must load one @vue/runtime-core: the playground's SFCs import `vue`, @glassui/vue imports @vue/runtime-core.
// What makes them one is pnpm resolving both to the same store path, which needs the same exact version.
it('the playground\'s vue and @glassui/vue\'s @vue/runtime-core pin the same exact version', () => {
  const vue = manifest('../../../examples/playground/package.json').dependencies.vue
  expect(vue).toMatch(/^\d+\.\d+\.\d+$/)
  expect(manifest('../package.json').dependencies['@vue/runtime-core']).toBe(vue)
})
it('…and both resolve to the same installed @vue/runtime-core', () => {
  const fromVue = createRequire(createRequire(path('../../../examples/playground/package.json')).resolve('vue/package.json'))
  const viaVue = createRequire(fromVue.resolve('@vue/runtime-dom/package.json')).resolve('@vue/runtime-core/package.json')
  const ours = createRequire(path('../package.json')).resolve('@vue/runtime-core/package.json')
  expect(viaVue).toBe(ours)
})
