# Visual regression (Playwright)

Screenshots of the playground compared against committed baselines:

| baseline | URL | projects |
| --- | --- | --- |
| `signup` | `/?scene=signup&quality=high[&webgl]&hud=0` | `webgl2`, `webgpu` |
| `world` | `/?scene=world&quality=high[&webgl]&hud=0` | `webgl2`, `webgpu` |
| `signup-medium` | `/?scene=signup&quality=medium[&webgl]&hud=0` | `webgl2`, `webgpu` |
| `signup-minimal` | `/?scene=signup&quality=minimal[&webgl]&hud=0` | `webgl2`, `webgpu` |

The standalone sign-up scene now places its form in world space so the camera can inspect its thickness. The screenshots capture its initial front view; `tests/signup-navigation.spec.ts` checks left-drag pan, right-drag rotation, wheel zoom, and that text entry still receives focus.

`signup-medium` is the touch default (refraction, mip blur; at DPR 1 the content RT keeps one texel per CSS px) and
`signup-minimal` the reduced-transparency tier (a near-opaque frosted fill instead of refraction, no screen copy).

- Viewport 1280 × 900, DPR 1; a test fails when more than 2 % of the pixels differ (`maxDiffPixelRatio: 0.02`).
- `webgl2`: the headless shell with SwiftShader, `&webgl` forces three's WebGL2 backend; it must report `webgl2`.
- `webgpu`: the full Chromium build in new headless (`channel: 'chromium'`; the headless shell has no WebGPU). When
  three falls back to WebGL2 the test is skipped ("WebGPU unavailable: three fell back to WebGL2"), never compared.
- The backend is checked before the screenshot, so a fallback never writes or matches a baseline.
- An uncaught page error or a `console.error` from navigation on fails the test before the screenshot (it may change
  too few pixels to trip the 2 % budget).
- Determinism: `quality=…` fixes the tier (no adaptation); `hud=0` hides the HUD's live fps text. After `__glassui.ready` the test
  waits 1000 ms and at least 1 s of the UI's frame time (the root clamps a frame to 50 ms, so a slow SwiftShader frame
  rate stretches the wait) for the backdrop luma's smoothing to settle. Nothing else in the scenes moves without input.
- Baselines: `tests/visual.spec.ts-snapshots/<baseline>-<project>.png` (the same names on every platform).

## Run

From the repository root:

```sh
pnpm --filter visual exec playwright install chromium   # once per Playwright version: the pinned version's Chromium builds
pnpm test:visual                                          # build the playground, serve it on 127.0.0.1:5177, compare
```

The web server is `vite build` + `vite preview --port 5177` of `examples/playground`. With a server already listening
on 5177, Playwright reuses it as is (no rebuild): stop it, or rebuild it yourself, before testing a change.

Pass Playwright flags without `--` (pnpm forwards a `--` literally): `pnpm test:visual --project=webgl2`.

## Baselines

Baselines are machine-specific: text is rasterised with the system fonts, and WebGPU goes through the local GPU driver.
The committed ones come from the reference machine: macOS on Apple Silicon, Chromium from Playwright (the version in
`package.json`). Another machine (CI included) must not compare against them: it regenerates its own baselines once
(below), inspects them, and keeps them local. Never commit them: the file names carry no platform suffix, so they would
overwrite the reference machine's.

To (re)generate them:

```sh
pnpm test:visual:update        # writes tests/visual.spec.ts-snapshots/*.png
```

Inspect every PNG (and, on the reference machine only, commit it). `signup` has reference renders in `docs/images/`
(`signup-front.jpg`). `signup-medium` and `signup-minimal` have none and are judged by eye: medium is the same form
drawn without back faces, depth reject or the blur pyramid (text as sharp as at `high`); minimal shows the controls as
near-opaque fills (light grey, or the accent for coloured controls) with a solid border in `tertiaryLabel` and no
rims. `world` has none either and
is judged by eye: the glass card stands to the right, tipped back, and the wall occludes its lower-left corner and the
left end of the Cancel pill.

## On a diff

The quick path: a failing test leaves `test-results/<test>/<scene>-{expected,actual,diff}.png`. The HTML report has
the same images side by side (it is written on every run, never opened by itself):

```sh
pnpm --filter visual exec playwright show-report   # serves playwright-report/: expected, actual and diff per test
```

An unintended change is a regression: fix it. An intended one: regenerate with `pnpm test:visual:update`, inspect, and
commit the new PNGs with the change that caused them.
