import { test, expect, type Page } from '@playwright/test'

// What the playground exposes (examples/playground/src/main.ts `PlaygroundHandle`), as far as the harness reads it.
declare global {
  interface Window { __glassui?: { ready: Promise<{ backend: 'webgpu' | 'webgl2' | 'unknown' }> } }
}

/** Wall clock to wait after `ready` (the springs, the first content passes). */
const SETTLE_MS = 1000
/**
 * UI frame time to wait as well (s). The root clamps a frame's dt to 50 ms (`FrameScheduler.maxDt`), so below 20 fps
 * (SwiftShader) 1000 ms of wall clock is less than 1 s of UI time; the backdrop luma's smoothing (τ = 0.2 s) needs
 * `LUMA_SETTLE` = 1 s of it from the first frame, which has no screen capture yet. At 20 fps or more the two are equal.
 */
const SETTLE_UI_S = 1
/** The root's per-frame dt clamp: `FrameScheduler`'s default `maxDt` (packages/render/src/scheduler.ts); keep in step. */
const MAX_DT_S = 1 / 20

/**
 * What is compared, each at a fixed tier (`quality=…`: no adaptation) and DPR 1 (the config): both scenes at `high`,
 * and the sign-up form at the lower tiers too — `medium` (refraction; the content RT at one texel per CSS px) and
 * `minimal` (a near-opaque frosted fill, no screen copy). `name` is the baseline's: `<name>-<project>.png`.
 */
const cases = [
  { name: 'signup', scene: 'signup', quality: 'high' },
  { name: 'world', scene: 'world', quality: 'high' },
  { name: 'signup-medium', scene: 'signup', quality: 'medium' },
  { name: 'signup-minimal', scene: 'signup', quality: 'minimal' },
] as const
for (const { name, scene, quality } of cases) {
  test(`${name} renders the same`, async ({ page }, info) => {
    const webgl = info.project.name === 'webgl2'
    // from navigation on: an uncaught throw or a console error after `ready` may change only a few pixels (a stopped
    // loop, the HUD's small error box), under the diff budget, so they fail the test on their own
    const errors: string[] = []
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
    page.on('console', m => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`) })
    // `hud=0`: no live fps text in the frame
    await page.goto(`/?scene=${scene}&quality=${quality}${webgl ? '&webgl' : ''}&hud=0`)
    // only the backend crosses back: the root itself is not serialisable
    const backend = await page.evaluate(async () => {
      const handle = window.__glassui
      if (!handle) throw new Error('window.__glassui is missing: the playground did not start')
      return (await handle.ready).backend
    })
    // before the screenshot, so a fallback never writes or matches a baseline under the wrong backend
    if (webgl) expect(backend).toBe('webgl2')
    else {
      test.skip(backend === 'webgl2', 'WebGPU unavailable: three fell back to WebGL2')
      expect(backend).toBe('webgpu')
    }
    await settle(page)
    expect(errors, 'page errors and console errors since navigation').toEqual([])
    await expect(page).toHaveScreenshot(`${name}.png`)
  })
}

/** Resolves once `SETTLE_MS` of wall clock and `SETTLE_UI_S` of the UI's clamped frame time have both passed. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(([wallMs, uiS, maxDt]) => new Promise<void>(resolve => {
    const start = performance.now()
    let ui = 0, last: number | null = null
    // the playground's loop runs on the same animation frames: the sum of clamped intervals is the root's frame time
    const tick = (t: number): void => {
      if (last !== null) ui += Math.min(maxDt, Math.max(0, (t - last) / 1000))
      last = t
      if (t - start >= wallMs && ui >= uiS) resolve()
      else requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }), [SETTLE_MS, SETTLE_UI_S, MAX_DT_S] as const)
}
