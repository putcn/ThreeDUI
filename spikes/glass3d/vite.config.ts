import { defineConfig } from 'vite'

// Static build of the spike for publishing (e.g. fortbrain.ai/concepts/glassui-signup/).
// Relative base so the folder can live under any path.
export default defineConfig({
  base: './',
  build: {
    outDir: process.env.GLASSUI_OUT ?? 'dist',
    emptyOutDir: true,
    target: 'es2022',
  },
})
