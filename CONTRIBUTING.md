# Contributing

Thanks for helping make spatial UI practical. This repository is still experimental; a focused issue or pull request with a reproducible example is especially useful.

## Develop locally

Use Node.js 22.12+ and pnpm 11. Run `pnpm install`, then `pnpm playground` and open [the demo index](http://127.0.0.1:5176/demos.html). The workspace packages are source exports; there is no published npm release or separate package build to install.

Before opening a pull request, run:

```bash
pnpm typecheck
pnpm test
pnpm playground:build
```

If you change a component's metadata, run `pnpm manifest` and include the updated [`manifest.json`](./packages/vue/manifest.json). For rendering changes, inspect the affected scene in a browser and follow the [visual-test guide](./examples/visual/README.md). Its screenshot baselines depend on local fonts and GPU drivers; do not update them blindly on another machine.

## Where to work

`packages/core` owns layout, styles, and input state; `packages/text` owns glyph infrastructure; `packages/render` owns three.js rendering; `packages/vue` owns the Vue renderer and public components. The comprehensive app and component gallery live in `examples/playground`. User-facing docs live in `docs/`; design and spike history is in `docs/superpowers/`.

For a new component, document its supported props, events, slots, examples, and common mistakes in its `defineGlassComponent` metadata so the manifest stays useful to people and agents. Keep the gallery focused on working interactions. If a behavior depends on the host scene or GPU backend, state that explicitly in docs and verification notes.

Apache-2.0 applies to contributions; see [LICENSE](./LICENSE).
