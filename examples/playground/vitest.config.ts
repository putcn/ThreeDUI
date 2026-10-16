import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

// The playground's tests (`pnpm test` runs them as the root config's `playground` project): Node, like the packages'
// tests, with the .vue files compiled as the app's Vite config compiles them (the glass host elements are not
// components), for the client: `test/node-client-env.ts`.
export default defineConfig({
  plugins: [vue({ template: { compilerOptions: { isCustomElement: tag => ['box', 'text', 'image', 'glass', 'scroll', 'portal'].includes(tag) } } })],
  resolve: { dedupe: ['vue'] },
  test: { name: 'playground', include: ['test/**/*.test.ts'], environment: './test/node-client-env.ts' },
})
