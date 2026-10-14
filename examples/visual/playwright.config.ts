import { defineConfig } from '@playwright/test'

// Visual regression for the playground (Task 24): `signup` and `world` at 1280 × 900, DPR 1, on WebGL2 (SwiftShader,
// required) and WebGPU (full Chromium in new headless; skipped when three falls back to WebGL2). Baselines are
// machine-specific: see README.md.
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  // `<scene>-<project>.png` on every platform (the default template adds a platform suffix)
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}-{projectName}{ext}',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' } },
  use: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, baseURL: 'http://127.0.0.1:5177' },
  webServer: { command: 'pnpm --filter playground exec vite build && pnpm --filter playground exec vite preview --port 5177 --strictPort --host 127.0.0.1', url: 'http://127.0.0.1:5177', reuseExistingServer: true, timeout: 120_000 },
  projects: [
    { name: 'webgl2', use: { browserName: 'chromium', launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } } },
    // the default headless shell has no WebGPU: `channel: 'chromium'` runs the full Chromium build in new headless
    { name: 'webgpu', use: { browserName: 'chromium', channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] } } },
  ],
})
