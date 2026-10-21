# Spatial UI

GlassUI treats interface surfaces as scene objects. A view can live in world space, rotate with the workspace, move toward the user when focused, and sit beside a real 3D chart, map, or warehouse model. The [spatial application](http://127.0.0.1:5176/?scene=spatial&stage=overview) shows six business views sharing one scene and camera.

## Three levels of composition

1. **Surface:** a render target for UI content. A screen Surface stays camera-facing; a world Surface has a position, rotation, scale, and points-per-world-unit conversion.
2. **Space + Block:** `Space` arranges world-layer `Block`s in an arc or grid, controls focus, and optionally drives the camera. Every `Block` has a unique name and fixed dimensions in points.
3. **Scene content:** `Viewport3D`, charts, and application-specific three.js objects can live with the UI. The host still owns the renderer and frame loop.

```vue
<script setup lang="ts">
import { ref } from 'vue'
import { Space, Block, Card, Text, BarChart3D } from '@glassui/vue'
const focus = ref<string | null>(null)
const data = [{ label: 'A', value: 42 }, { label: 'B', value: 67 }]
</script>

<template>
  <Space v-model:focus="focus" layout="grid" :columns="2" :radius="12" :gap="0.8" overview>
    <Block name="summary" :width="560" :height="420">
      <Text value="Summary" size="2xl" />
    </Block>
    <Block name="analytics" :width="720" :height="540">
      <Card title="Trend"><BarChart3D :data="data" /></Card>
    </Block>
  </Space>
</template>
```

`focus = null` means overview only when `overview` is enabled. Clicking a Block in overview focuses it; setting `focus` changes the camera programmatically. `Space` defaults to an arc; the grid layout needs a positive `columns` value. If your host controls the camera, set `:camera="false"` on `Space`. Avoid competing OrbitControls on a camera driven by `Space`.

## Mixing 2D tasks and 3D content

Use 3D where it adds meaning: a map for geography, a warehouse model for locations, a chart whose marks can be inspected from a changed viewpoint. Keep input-heavy tasks in legible `Block`s or screen Surfaces. The WMS demo links an order to a route and then to a warehouse bin; navigation changes camera focus and contextual information follows the selected object. Its source is [`Spatial.vue`](../examples/playground/src/scenes/Spatial.vue) and [`wms/`](../examples/playground/src/wms).

World `position` and `rotation` use three.js units and radians. `Block` width/height and ordinary layout are in points; `ptPerUnit` controls their conversion into world size. Do not place 3D chart content inside a scrolling region: the current renderer does not clip 3D objects there. Use [the manifest](../packages/vue/manifest.json) for exact constraints of each chart and `Viewport3D`.

## Scope

The current demo illustrates composition and interaction; it is not a production WMS or a general digital-twin engine. It uses local fixtures and current browser GPU capabilities. For underlying design decisions, see the [spatial design spec](./superpowers/specs/2026-10-15-glassui-spatial-ui-design.md).
