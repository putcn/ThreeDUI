import { defineConfig } from 'vite'

// @pmndrs/glyph resolves its workers and .wasm files with `new URL('…', import.meta.url)`; dependency pre-bundling
// moves the module and breaks those relative URLs, so the package is served as-is.
export default defineConfig({
  optimizeDeps: { exclude: ['@pmndrs/glyph'] },
  build: { target: 'es2022' },
})
