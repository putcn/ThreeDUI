# ThreeDUI

**A 3D UI component library for three.js — rendered and interacted with entirely inside the canvas, styled after Apple's Liquid Glass, written in Vue syntax, designed to be used by AI coding agents.**

[中文说明](./README.zh-CN.md) · [Live demo](https://fortbrain.ai/concepts/glassui-signup/) · [Why we are building this (blog)](https://fortbrain.ai/blogs/glassui-liquid-glass/) · [Design spec](./docs/superpowers/specs/2026-10-07-glassui-core-design.md)

![A sign-up form drawn inside a three.js canvas: transparent glass blocks with real thickness, colour glowing from inside the glass, shadows on the panel](docs/images/signup-depth.jpg)

Everything above is three.js geometry: the inputs and buttons are transparent glass blocks with real thickness, the colour of the primary button glows from *inside* the glass, shadows fall on the panel, and the panel reflects the controls. No DOM element is involved. Drag the live demo to see the depth.

## Why

1. **UI is now mostly written by AI.** Coding agents carry the complexity, so the API can be explicit and powerful instead of terse — as long as the documentation is clear enough for an agent to use it without a human in the loop.
2. **Expressiveness.** The DOM can only *simulate* thickness, light and material on a plane. In a 3D engine they are real, and they share one light with everything else in the scene.
3. **GPUs keep getting stronger.** three.js's `WebGPURenderer` with automatic WebGL2 fallback runs this on today's phones.
4. **Cross-platform.** A canvas looks and behaves the same in browsers, Electron, Tauri, webviews and XR headsets.

## What it is

- **Vue 3 syntax** (`.vue` SFCs, `v-if`/`v-for`/slots/events) through a custom Vue renderer; the core underneath is framework-agnostic.
- **Containers (`Surface`) live in 3D**: place one anywhere in a scene with position/rotation/scale, or pin it to a camera-facing screen layer — same code.
- **Liquid Glass by default**: real beveled glass geometry, a PBR node material whose transmitted term samples the backdrop, native coloured transmitted shadows, planar reflections, and a "glow layer + glass shell + decoration layer" model for controls.
- **Tailwind-class coverage**: buttons, inputs, checkbox, switch, tabs, dialogs, menus, tables… with a `tw="…"` utility string on every element.
- **Chinese text and IME input** are first-class: on-demand glyph atlases with system-font fallback, and a caret-positioned IME proxy.
- **Built for agents**: strict, typed props; every error names the allowed values and the nearest match; every component ships a machine-readable manifest.

## Status

Early, in the open. The rendering approach was validated in a series of spikes (see `spikes/` and `docs/superpowers/spikes/`); the live demo is the current spike build. Implementation follows the plans in `docs/superpowers/plans/`:

| Plan | Scope | Status |
|---|---|---|
| 1 — Foundation | monorepo, `@glassui/core` (node tree, style/theme/tw, Yoga layout, events, focus, scroll, springs, render lists), `@glassui/text` (CJK-aware system-font engine) | in progress |
| 2 — Render | `@glassui/render`: three.js WebGPU/TSL glass, panels, text, shadows, surfaces, quality tiers | planned |
| 3 — Vue + components | Vue custom renderer, first component set, IME bridge, manifests | planned |

![Front view of the sign-up form](docs/images/signup-front.jpg)

![Detail: the glow layer under a thin transparent glass shell](docs/images/signup-detail.png)

## Try it

```bash
pnpm install
pnpm playground         # http://127.0.0.1:5176  — the sign-up form and a world-layer scene on @glassui/core + @glassui/render
```

Query parameters: `?scene=signup|world|both` (default `both`), `?quality=high|medium|low|minimal` (default: adaptive), `?webgl` to force the WebGL2 backend. Drag the background to orbit (the form stays put; the world-layer panel moves with the scene). The HUD shows the backend, fps, draw calls per frame (the whole frame: content passes, shadow map, host scene and UI), quality tier and Surface count. `pnpm playground:build` writes a static build to `examples/playground/dist`.

The original spike is still there for comparison:

```bash
pnpm spike:glass3d      # http://127.0.0.1:5174  — add ?webgl to force the WebGL2 backend
```

## Repository layout

```
docs/superpowers/specs/   design spec (the authority for all decisions)
docs/superpowers/plans/   implementation plans, one per subsystem
docs/superpowers/spikes/  what each spike found, with the reasoning
spikes/glass3d/           the current demo: real-3D Liquid Glass sign-up form
spikes/glass/             the first (rejected) flat-SDF approach, kept for comparison
packages/                 @glassui/core, @glassui/text, @glassui/render, … (filled in by the plans)
examples/playground/      the sign-up form and a world-layer scene built on the packages (`pnpm playground`)
```

## How the glass works, in one paragraph

Each control is an extruded superellipse with a straight side wall and a small round-over on the top and bottom edges. The material is three.js's `MeshPhysicalNodeMaterial`; its `backdropNode` hook replaces the diffuse term with a refracted sample of what is behind the glass (Snell's law on the real normal, through the real thickness, per-channel IOR for dispersion), while specular, Fresnel, iridescence and environment reflections come from the engine. Coloured controls do not absorb — they *emit* from inside the glass, weighted by Fresnel so edges glow. Shadows are variance shadow maps with `shadowMap.transmitted` so coloured glass casts coloured shadows. The "crystal" cues that a rasteriser cannot produce physically — the outline highlight, the lower-edge band, the light pool beneath — are thin decoration layers on top of the geometry. The full reasoning, with the dead ends, is in the blog post linked above.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
