# Getting started

GlassUI is currently developed as a **pnpm workspace**. The packages are not released to npm; their exports resolve to TypeScript source in this repository. The simplest working environment is the included Vite playground.

## Run the repository

Use Node.js 22.12+ and pnpm 11:

```bash
git clone https://github.com/putcn/ThreeDUI.git
cd ThreeDUI
pnpm install
pnpm playground
```

Open [the demo index](http://127.0.0.1:5176/demos.html). For a component-by-component tour, open [the gallery](http://127.0.0.1:5176/?scene=gallery). For the complete spatial app, open [the spatial demo](http://127.0.0.1:5176/?scene=spatial). All source is in [`examples/playground/src`](../examples/playground/src).

## Minimal host

The host creates a three.js renderer and scene; GlassUI renders onto its canvas and participates in its frame loop. In a Vite app **inside this workspace**, enable `@vitejs/plugin-vue`, set `build.target: 'es2022'`, and use these two files. The workspace pins Vue 3.5.44 so the custom renderer and SFCs share one runtime. If using raw host tags (`box`, `text`, `image`, `glass`, `scroll`, `portal`) in Vue templates, configure `@vitejs/plugin-vue` to treat them as custom elements; see [`examples/playground/vite.config.ts`](../examples/playground/vite.config.ts).

`src/main.ts`:

```ts
import { Color, PerspectiveCamera, Scene } from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { createUIRoot } from '@glassui/render'
import { createGlassApp } from '@glassui/vue'
import App from './App.vue'

const renderer = new WebGPURenderer({ antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
document.body.style.margin = '0'
document.body.appendChild(renderer.domElement)

const scene = new Scene()
scene.background = new Color('#d9d4d2')
const camera = new PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 100)
camera.position.set(0, 0, 7)

const root = await createUIRoot({ renderer, scene, camera })
const app = createGlassApp(App, { root })
app.mount()
renderer.setAnimationLoop(time => root.frame(time))

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})

// On teardown: app.unmount(); renderer.setAnimationLoop(null);
// root.dispose(); renderer.dispose().
```

`src/App.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { Space, Block, Card, Text, Input, Button, BarChart3D } from '@glassui/vue'

const focus = ref('login')
const email = ref('')
const visits = [{ label: 'Mon', value: 120 }, { label: 'Tue', value: 160 }]
</script>

<template>
  <Space v-model:focus="focus">
    <Block name="login" :width="488" :height="560">
      <Text value="Welcome back" size="2xl" />
      <Input v-model="email" placeholder="Email" />
      <Button label="Log in" variant="glassProminent" @press="focus = 'dashboard'" />
    </Block>
    <Block name="dashboard" :width="880" :height="620">
      <Card title="Visits"><BarChart3D :data="visits" /></Card>
    </Block>
  </Space>
</template>
```

`Space` drives the camera by default. Do not run OrbitControls against that same camera unless you set `:camera="false"` on `Space`. Numeric props need Vue binding syntax (`:width="488"`), and `Space` accepts only direct `Block` children. See [Spatial UI](./spatial-ui.md) for overview, placement, and 3D content.

## Find the right component

The [component guide](./components.md) explains composition patterns; [`packages/vue/manifest.json`](../packages/vue/manifest.json) is the generated reference for exact prop names, values, events, slots, examples, and common mistakes. The [gallery](http://127.0.0.1:5176/?scene=gallery) lets you interact with the controls before using them. Its source ([`Gallery.vue`](../examples/playground/src/gallery/Gallery.vue)) is a larger Vue example.

Run `pnpm typecheck`, `pnpm test`, and `pnpm playground:build` before proposing changes. Use [`pnpm manifest`](../package.json) after changing component metadata.
