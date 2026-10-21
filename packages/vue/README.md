# @glassui/vue

Vue components rendered into GlassUI Surfaces over a three.js scene. Start with the repository [getting-started guide](../../docs/getting-started.md), [component guide](../../docs/components.md), and [interactive gallery](http://127.0.0.1:5176/?scene=gallery). Read [manifest.json](./manifest.json) for exact props, events, slots, models, examples, styles, theme tokens, and renderer rules. Regenerate it with `pnpm manifest` after metadata changes.

These packages currently export TypeScript source from the pnpm workspace and are not published to npm. Build a Vite TypeScript app inside this repository or use the included playground as a starting point. Pin Vue to 3.5.44 so its runtime matches GlassUI. Enable `vue()` from `@vitejs/plugin-vue` in `vite.config.ts`, set `build.target: 'es2022'` for top-level await, and load `/src/main.ts` from an `index.html` module script. Raw host tags additionally need `vue({ template: { compilerOptions: { isCustomElement: tag => HOST_TAGS.includes(tag) } } })` (`HOST_TAGS` from `@glassui/vue`; in TypeScript cast it to `readonly string[]`).

The following quickstart is 30 lines across the two source files. Run `pnpm vite`.

`src/main.ts`:

```ts
import { Color, PerspectiveCamera, Scene } from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { createUIRoot } from '@glassui/render'
import { createGlassApp } from '@glassui/vue'
import App from './App.vue'
const renderer = new WebGPURenderer({ antialias: true })
renderer.setSize(innerWidth, innerHeight)
document.body.style.margin = '0'; document.body.appendChild(renderer.domElement)
const scene = new Scene(); scene.background = new Color('#d9d4d2')
const camera = new PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 100)
camera.position.set(0, 0, 7)
const root = await createUIRoot({ renderer, scene, camera })
const app = createGlassApp(App, { root }); app.mount()
renderer.setAnimationLoop(t => root.frame(t))
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight) })
```

`src/App.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { Surface, Stack, Text, Input, Button, Switch, Dialog } from '@glassui/vue'
const email = ref(''), remember = ref(false), open = ref(false)
</script>
<template>
  <Surface layer="screen" center :width="420" :height="420" background="glass" :radius="32">
    <Stack tw="p-6" :gap="16">
      <Text value="Welcome back" size="2xl" /><Input v-model="email" placeholder="Email" />
      <Switch v-model:checked="remember" label="Remember me" />
      <Button label="Continue" variant="glassProminent" @press="open = true" />
      <Dialog v-model:open="open" title="Ready"><Text :value="email || 'Hello!'" /><Button label="Close" @press="open = false" /></Dialog>
    </Stack>
  </Surface>
</template>
```

The host owns the canvas, camera and frame loop; `createGlassApp` mounts into a detached container when the Vue app owns its Surfaces. You may instead `app.mount(root.createSurface({ width: 420, height: 420 }))` for an app whose content uses an existing Surface. On teardown, call `app.unmount()`, `renderer.setAnimationLoop(null)`, `root.dispose()` and `renderer.dispose()`.

Use `@press` on buttons, `v-model` on Input, and `v-model:checked` / `v-model:open` on switches / dialogs. Numeric props need `:`. Keep Dialog mounted for its exit animation. Layout belongs to Stack props; `tw` uses GlassUI's grammar, which is listed in the manifest.

For a spatial app, see the manifest's complete setup example: login and dashboard Blocks inside Space, with a Card and BarChart3D. Blocks have fixed sizes and unique names; one CameraRig per root, with no OrbitControls alongside a camera-driving Space. Space supports arc and spherical grid layouts; grid requires columns. overview enables framing all Blocks when focus is null, with pointer and keyboard selection; standby pulls back the camera and fades Blocks. radius/gap defaults are 7/0.5 for arc and 24/0.4 for grid. A null focus requires overview.

KeepAlive and Suspense are unsupported. Named portals use `<portal name="overlay" />` and `<Teleport to="overlay" defer>` for same-pass targets; the target must exist even when disabled. Keep deferred content simple and validate it against the renderer's supported cases. An invisible overlay still catches pointers unless its style has `pointerEvents: 'none'`. A `glassId` morph only connects a removed and newly mounted button within the same live Surface and app; do not duplicate live ids or morph across Surfaces.
