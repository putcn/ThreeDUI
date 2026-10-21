---
name: build-glassui
description: Build or modify Vue interfaces with the ThreeDUI/GlassUI workspace packages, including spatial Space/Block layouts, glass controls, and scene-native charts. Use when working in this repository or a workspace that contains @glassui/vue; not for ordinary DOM-only Vue UI.
---

# Build with GlassUI

Use this skill when an agent is asked to create or change a GlassUI interface. The repository's packages currently export TypeScript source; do not suggest installing an unpublished npm release. Work in this pnpm workspace unless the user explicitly provides another configured source setup.

## Find the source of truth

- Read [`docs/getting-started.md`](../../../docs/getting-started.md) for renderer, scene, camera, and Vue setup.
- Read [`docs/components.md`](../../../docs/components.md) for composition patterns and [`docs/spatial-ui.md`](../../../docs/spatial-ui.md) for 3D layout.
- Inspect [`packages/vue/manifest.json`](../../../packages/vue/manifest.json) for exact props, models, events, slots, constraints, and examples. It is generated from component metadata. Do not infer GlassUI props from HTML or Tailwind.
- Check the closest working source example: [`examples/playground/src/gallery/Gallery.vue`](../../../examples/playground/src/gallery/Gallery.vue) for controls, or [`examples/playground/src/scenes/Spatial.vue`](../../../examples/playground/src/scenes/Spatial.vue) and [`examples/playground/src/wms`](../../../examples/playground/src/wms) for a connected spatial app.

## Build the interface

1. Identify whether the requested UI belongs on a screen `Surface`, a positioned world `Surface`, or a `Space` of navigable `Block`s. Prefer `Space` when focus and camera transitions express navigation, not merely for decorative depth.
2. Keep the host responsible for its three.js renderer, scene, camera, canvas, and frame loop. Mount the Vue app with `createGlassApp(App, { root })`; the root comes from `await createUIRoot({ renderer, scene, camera })`.
3. In `Space`, put only direct `Block` children with unique `name`s and numeric bound `width`/`height`. If `Space` drives the camera, do not also drive it with OrbitControls. `focus: null` requires `overview`; `layout="grid"` requires `:columns`.
4. Use existing components and their models/events as documented in the manifest: `@press` for `Button`, `v-model` for `Input`, `v-model:checked` for toggles, `v-model:open` for `Dialog`. Put layout on `Box`/`Stack`; a `Surface` itself does not accept `tw`/`style`.
5. Put actual 3D information where spatial interaction helps comprehension: charts, map, model, or a custom host object. Keep dense reading and form entry legible. Respect the chosen design language and existing app structure rather than copying the WMS demo's domain.

## Verify

Run `pnpm typecheck`, relevant `pnpm test` cases, and `pnpm playground:build`. Open the changed scene in the browser and check focus, input, and visual hierarchy. After component metadata changes, run `pnpm manifest`. The [demo guide](../../../docs/demos.md) lists direct URLs. Report any device or backend limitation that you actually observed.
