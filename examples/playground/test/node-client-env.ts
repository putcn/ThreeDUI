import type { Environment } from 'vitest/runtime'

/**
 * Node, with the modules transformed as for the browser (Vite's `client` environment): plugin-vue then compiles the
 * .vue files' templates to render functions, as the app gets them, rather than to SSR string renderers. The glass
 * renderer needs nothing from a DOM.
 */
export default {
  name: 'node-client',
  viteEnvironment: 'client',
  setup: () => ({ teardown() {} }),
} satisfies Environment
