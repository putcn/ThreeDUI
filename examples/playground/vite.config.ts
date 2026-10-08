import { defineConfig } from 'vite'

// The GlassUI playground: the sign-up form and a world-layer scene on @glassui/core + @glassui/render.
// Relative base so the static build (`pnpm playground:build` → examples/playground/dist) can live under any path.
export default defineConfig({
  base: './',
  build: {
    outDir: process.env.GLASSUI_OUT ?? 'dist',
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 2000,   // one bundle: three/webgpu + yoga (inlined wasm) + zod ≈ 1.2 MB, expected for a demo
  },
})
