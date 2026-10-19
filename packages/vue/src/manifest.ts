import { z } from 'zod'
import { defaultTheme, StyleSchema, STYLE_KEYS, twClasses } from '@glassui/core'
// The barrel registers every built-in, including components not used by the caller.
import { glassComponents, VUE_VERSION } from './index'

export interface GlassManifest {
  name: '@glassui/vue'
  version: string
  setup: string
  components: {
    name: string
    description: string
    props: { name: string; type: unknown; required: boolean; default?: unknown; description: string }[]
    events: { name: string; payload: string; description: string }[]
    slots: { name: string; description: string }[]
    vModel: string[]
    examples: string[]
    mistakes: { mistake: string; fix: string }[]
  }[]
  style: { keys: { name: string; type: unknown }[]; states: ['hover', 'pressed', 'focused', 'disabled']; tw: string[] }
  theme: { colors: string[]; fontSize: Record<string, number>; radius: Record<string, number>; spacing: number[]; metrics: Record<string, number> }
  rules: string[]
}

const setup = `// Vite + @vitejs/plugin-vue; pin vue to 3.5.44 (the @glassui/vue runtime version).
// main.ts — the host owns three.js, the canvas, camera and frame loop.
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
app.mount() // detached: App owns its Surfaces (or mount an existing root.createSurface(...)).
renderer.setAnimationLoop(t => root.frame(t))
addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight
  camera.updateProjectionMatrix()
  renderer.setSize(innerWidth, innerHeight)
})
// On teardown: app.unmount(); renderer.setAnimationLoop(null); root.dispose(); renderer.dispose().

// App.vue — a spatial login and dashboard; Space drives the camera (no OrbitControls).
<script setup lang="ts">
import { ref } from 'vue'
import { Space, Block, Card, Text, Input, Button, BarChart3D } from '@glassui/vue'
const focus = ref('login'), email = ref('')
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
</template>`

const rules = [
  'Use glass for containers (Surface, Block, Card, Dialog) and controls; use Box for plain content/layout. Nested glass controls inside Card are supported.',
  'Buttons default to capsule; circle buttons contain only an icon. Use fixed radii for panels and concentric radii for nested rounded content.',
  'Use one glassProminent primary action per screen; secondary actions use glass. filled, tinted and plain buttons are flat.',
  'Use design tokens for color, fontSize, radius and spacing; numeric layout values are pt, rotations are radians, world positions are world units.',
  'Bind numeric and boolean values with :prop; use Stack direction/gap/align/justify/wrap props rather than conflicting tw layout classes.',
  'Button uses @press; Input uses v-model, Switch/Checkbox use v-model:checked, Dialog uses v-model:open, Space uses v-model:focus. Controlled values must be updated by the parent.',
  'Glass controls lift and tilt on hover and shrink on press; touch has no hover. Reduced motion and motion=frozen suppress animation.',
  'Surface, ScreenLayer, WorldLayer and Space have no host node; put style, class and tw on their content instead.',
  'An invisible overlay with opacity:0 can still intercept pointers: set pointerEvents:none when it should let pointers through. Surface interactive=false lets pointers through that entire Surface.',
  'Host tags are box, text, image, glass, scroll and portal. Use a Vue compiler isCustomElement predicate matching HOST_TAGS for raw host elements.',
  'KeepAlive and Suspense are unsupported. Use v-if/v-for, slots, Teleport and Transition/GlassTransition with the documented renderer limits.',
  'Named Teleport targets use <portal name="overlay" /> and to="overlay". The target must exist even when disabled; same-pass named targets require Teleport defer. Keep deferred content simple and validate it; avoid nested or conditionally mounted deferred targets.',
  'glassId morphs match a removed and newly mounted button within 500 ms in the same app and same live Surface. Do not duplicate a live id or move it across Surfaces; transition-leaving and KeepAlive-deactivated buttons do not count as removed.',
  'GlassContainer fuses nearby plain glass when gap is less than spacing; glowing/tinted controls keep their own rim.',
  'Blocks live directly in a Space, with unique names; focus names an existing Block. A Block size is fixed (width/height in pt), never content-sized.',
  'Use one CameraRig per root, normally owned by Space; do not run OrbitControls next to a camera-driving Space. Use :camera="false" only when the host owns the camera.',
  'Space currently arranges Blocks on an arc using radius and gap; explicit position/rotation override placement.',
  '3D charts and Viewport3D require a world Surface/Block and cannot be placed in scroll. Hold three.js objects with shallowRef or markRaw; dispose owned geometry/materials yourself.',
  'Dialog owns its screen Surfaces and traps focus; keep it mounted and control open for exit animation. Footer actions must close it explicitly; long content needs a fixed-height scroll.',
  'JSON Schema describes representable inputs; custom function/Object3D validators use an unconstrained schema with their API contract in description. Runtime validation still applies.',
]

/** Fresh JSON data, stable component order; defaults describe inputs rather than parsed outputs. */
export function generateManifest(): GlassManifest {
  const style = z.toJSONSchema(StyleSchema, { io: 'input', unrepresentable: 'any' })
  const components = [...glassComponents()].sort((a, b) => a.glass.name < b.glass.name ? -1 : a.glass.name > b.glass.name ? 1 : 0).map(({ glass: meta }) => {
    // Input mode keeps defaulted fields optional and retains nested required lists and defaults.
    const schema = z.toJSONSchema(meta.props, { io: 'input', unrepresentable: 'any' })
    const events = Object.entries(meta.events ?? {}).map(([name, event]) => ({ name, ...event }))
    const props = Object.entries(meta.props.shape).map(([name, prop]) => {
      const type = schema.properties?.[name] ?? {}
      return {
        name, type, required: schema.required?.includes(name) ?? false,
        ...(typeof type === 'object' && Object.hasOwn(type, 'default') ? { default: type.default } : {}),
        description: (prop as z.ZodType).description ?? '',
      }
    })
    return {
      name: meta.name, description: meta.description, props, events,
      slots: Object.entries(meta.slots ?? {}).map(([name, description]) => ({ name, description })),
      vModel: props.filter(p => events.some(e => e.name === `update:${p.name}`)).map(p => p.name === 'modelValue' ? 'v-model' : `v-model:${p.name}`),
      examples: meta.examples, mistakes: meta.mistakes ?? [],
    }
  })
  // Clone metadata and theme collections too: callers cannot mutate the registry or global defaultTheme through JSON.
  return JSON.parse(JSON.stringify({
    name: '@glassui/vue', version: VUE_VERSION, setup, components,
    style: { keys: STYLE_KEYS.map(name => ({ name, type: style.properties?.[name] ?? {} })), states: ['hover', 'pressed', 'focused', 'disabled'], tw: twClasses(defaultTheme) },
    theme: { colors: Object.keys(defaultTheme.colors.light), fontSize: defaultTheme.fontSize, radius: defaultTheme.radius, spacing: defaultTheme.spacing, metrics: defaultTheme.metrics },
    rules,
  })) as GlassManifest
}
