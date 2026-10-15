import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// The GlassUI playground: the sign-up form and a world-layer scene on @glassui/core + @glassui/render, and the Vue
// component gallery (`?scene=gallery`) on @glassui/vue.
// Relative base so the static build (`pnpm playground:build` → examples/playground/dist) can live under any path.
export default defineConfig({
  base: './',
  plugins: [
    // the glass renderer's host elements (spec §8.1), not components
    vue({ template: { compilerOptions: { isCustomElement: tag => ['box', 'text', 'image', 'glass', 'scroll', 'portal'].includes(tag) } } }),
  ],
  resolve: {
    // One Vue runtime: the SFCs import `vue`, @glassui/vue imports `@vue/runtime-core`; two copies would split `h`, the
    // current instance and the scheduler. They are one because pnpm resolves `vue`'s runtime-core and @glassui/vue's to
    // the same store path (both pinned to the same exact version: packages/vue/test/runtime-pin.test.ts); dedupe can only
    // name this package's own dependencies, so it keeps `vue` itself single should another workspace package bring one.
    dedupe: ['vue'],
  },
  build: {
    outDir: process.env.GLASSUI_OUT ?? 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 2000,   // one bundle: three/webgpu + yoga (inlined wasm) + zod + vue ≈ 1.3 MB, expected for a demo
  },
})
