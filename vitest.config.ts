import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    projects: [
      { test: { name: 'packages', include: ['packages/*/test/**/*.test.ts'], environment: 'node' } },
      // the playground's own tests (the WMS demo's data, model and views): its config compiles the .vue files
      'examples/playground/vitest.config.ts',
    ],
  },
})
