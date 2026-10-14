import { defineConfig } from '@playwright/test'

// Visual regression for the playground (Task 24): `signup` and `world` at 1280 × 900, DPR 1, on WebGL2 (SwiftShader,
// required) and WebGPU (full Chromium in new headless; skipped when three falls back to WebGL2). Baselines are
// machine-specific: see README.md.
export default defineConfig({
  testDir: './tests',
  // SwiftShader (webgl2) needs up to ~55 s per test when workers run in parallel
  timeout: 120_000,
  // `<scene>-<project>.png` on every platform (the default template adds a platform suffix)
  snapshotPathTemplate: '{testDir}/{testFileName}-snapshots/{arg}-{projectName}{ext}',
  // SwiftShader draws the high tier at ~2 fps here and one capture takes ~2.5 s; the stable-screenshot check needs at
  // least two identical captures, so the 5 s default times out although the frames match pixel for pixel. (The matcher's
  // own options have no `timeout` in Playwright's types: it is set for every `expect` here.)
  expect: { timeout: 30_000, toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' } },
  // `list` on the terminal; `html` writes playwright-report/ (expected, actual and diff per failure) for `show-report`
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, baseURL: 'http://127.0.0.1:5177' },
  webServer: { command: 'pnpm --filter playground exec vite build && pnpm --filter playground exec vite preview --port 5177 --strictPort --host 127.0.0.1', url: 'http://127.0.0.1:5177', reuseExistingServer: true, timeout: 120_000 },
  projects: [
    { name: 'webgl2', use: { browserName: 'chromium', launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } } },
    // the default headless shell has no WebGPU: `channel: 'chromium'` runs the full Chromium build in new headless
    { name: 'webgpu', use: { browserName: 'chromium', channel: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] } } },
  ],
})
