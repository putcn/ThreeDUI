<script setup lang="ts">
// The spatial scene (`?scene=spatial`): a preview of 云仓 WMS, a fictional warehouse operator's dashboard (spatial spec
// §4 steps 2–5; Task 19 adds the login and the settings). Three Blocks on the Space's arc: the orders on the left, the
// overview in the middle (the first focus), the warehouse twin on the right. Click a Block showing at the frame's edge,
// or a tab or breadcrumb, to focus it: the camera springs to it and the others recede.
// Hovering a bin in the twin floats a glass info panel in front of the twin: its own world Surface, outside the Space,
// that refracts the racks behind it (spatial spec §11.4).
// `?focus=<name>` picks the first focus (default overview).
import { ref, shallowRef } from 'vue'
import { Block, Space, Surface } from '@glassui/vue'
import Overview from '../wms/Overview.vue'
import Twin from '../wms/Twin.vue'
import Orders from '../wms/Orders.vue'
import BinPanel from '../wms/BinPanel.vue'
import type { Bin } from '../wms/data'
import { ARC, BLOCKS, inFrameOf, PANEL, TWIN } from './spatial-arc'

const props = defineProps<{ initialFocus?: string }>()
const focus = ref(props.initialFocus ?? 'overview')
/** The twin's hovered bin (null: none): the info panel shows it while the twin is the focus. */
const hovered = shallowRef<Bin | null>(null)
const go = (name: string): void => { focus.value = name }
const panel = inFrameOf(TWIN, PANEL.offset)
</script>

<template>
  <Space v-model:focus="focus" :radius="ARC.radius" :gap="ARC.gap">
    <Block name="orders" :width="BLOCKS.orders.width" :height="BLOCKS.orders.height">
      <Orders @navigate="go" />
    </Block>
    <Block name="overview" :width="BLOCKS.overview.width" :height="BLOCKS.overview.height">
      <Overview @navigate="go" />
    </Block>
    <Block name="twin" :width="BLOCKS.twin.width" :height="BLOCKS.twin.height" :position="TWIN.position" :rotation="TWIN.rotation">
      <Twin @hover="b => (hovered = b)" @navigate="go" />
    </Block>
  </Space>
  <!-- the bin info panel: glass in front of the twin, letting the pointer through to the bins behind it -->
  <Surface
    v-if="hovered && focus === 'twin'"
    :width="PANEL.width" :height="PANEL.height" :position="panel.position" :rotation="panel.rotation"
    background="glass" :radius="28" :interactive="false"
  >
    <BinPanel :bin="hovered" />
  </Surface>
</template>
