import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

// The GlassUI playground: a demo index, spatial application, component gallery, and focused scenes.
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
    rollupOptions: {
      input: {
        playground: fileURLToPath(new URL('./index.html', import.meta.url)),
        demos: fileURLToPath(new URL('./demos.html', import.meta.url)),
      },
    },
    // one bundle: three/webgpu + yoga (inlined wasm) + zod + vue ≈ 1.3 MB, and the network map's Xuzhou extract
    // (src/wms/geo, ≈ 0.4 MB): expected for a demo
    chunkSizeWarningLimit: 2600,
  },
})
