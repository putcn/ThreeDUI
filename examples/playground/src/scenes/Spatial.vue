<script setup lang="ts">
// The spatial scene (`?scene=spatial`): a preview of 云仓 WMS, a fictional logistics operator's dashboard in Xuzhou
// (spatial spec §4 steps 2–5, §12.4; Task 19 adds the login and the settings). Four Blocks on the Space's arc: the
// orders on the left, the overview (the first focus), the logistics network map, the warehouse twin on the right. Click
// a Block showing at the frame's edge, or a tab or breadcrumb, to focus it: the camera springs to it and the others
// recede.
// Hovering a bin in the twin, or a place on the map, floats a glass info panel in front of it: its own world Surface,
// outside the Space, that refracts what is behind it (spatial spec §11.4).
// `?focus=<name>` picks the first focus (default overview).
import { ref, shallowRef } from 'vue'
import { Block, Space, Surface } from '@glassui/vue'
import Overview from '../wms/Overview.vue'
import Network from '../wms/Network.vue'
import Twin from '../wms/Twin.vue'
import Orders from '../wms/Orders.vue'
import BinPanel from '../wms/BinPanel.vue'
import LocationPanel from '../wms/LocationPanel.vue'
import type { Bin } from '../wms/data'
import type { PlaceHover } from '../wms/map'
import { ARC, BLOCKS, inFrameOf, NETWORK, PANEL, PLACE_PANEL, TWIN } from './spatial-arc'

const props = defineProps<{ initialFocus?: string }>()
const focus = ref(props.initialFocus ?? 'overview')
/** The twin's hovered bin (null: none): the bin panel shows it while the twin is the focus. */
const hovered = shallowRef<Bin | null>(null)
/** The map's hovered place and the side the panel takes (null: none): the place panel shows it while the map is the focus. */
const place = shallowRef<PlaceHover | null>(null)
const go = (name: string): void => { focus.value = name }
const panel = inFrameOf(TWIN, PANEL.offset)
const placePanel = { left: inFrameOf(NETWORK, PLACE_PANEL.offset.left), right: inFrameOf(NETWORK, PLACE_PANEL.offset.right) }
</script>

<template>
  <Space v-model:focus="focus" :radius="ARC.radius" :gap="ARC.gap">
    <Block name="orders" :width="BLOCKS.orders.width" :height="BLOCKS.orders.height">
      <Orders @navigate="go" />
    </Block>
    <Block name="overview" :width="BLOCKS.overview.width" :height="BLOCKS.overview.height">
      <Overview @navigate="go" />
    </Block>
    <Block name="network" :width="BLOCKS.network.width" :height="BLOCKS.network.height" :position="NETWORK.position" :rotation="NETWORK.rotation">
      <Network :active="focus === 'network'" @hover="p => (place = p)" @navigate="go" />
    </Block>
    <Block name="twin" :width="BLOCKS.twin.width" :height="BLOCKS.twin.height" :position="TWIN.position" :rotation="TWIN.rotation">
      <Twin :active="focus === 'twin'" @hover="b => (hovered = b)" @navigate="go" />
    </Block>
  </Space>
  <!-- the bin info panel: glass in front of the twin, letting the pointer through to the bins behind it and casting no
       shadow on them (it floats 2 units out: its shadow would be a long grey slab across the twin) -->
  <Surface
    v-if="hovered && focus === 'twin'"
    :width="PANEL.width" :height="PANEL.height" :pt-per-unit="PANEL.ptPerUnit" :position="panel.position" :rotation="panel.rotation"
    background="glass" :radius="28" :interactive="false" :cast-shadows="false"
  >
    <BinPanel :bin="hovered" />
  </Surface>
  <!-- the place panel: glass in front of the map, in its upper corner away from the place (a new side flies in anew),
       letting the pointer through and casting no shadow -->
  <Surface
    v-if="place && focus === 'network'" :key="place.side"
    :width="PLACE_PANEL.width" :height="PLACE_PANEL.height" :pt-per-unit="PLACE_PANEL.ptPerUnit"
    :position="placePanel[place.side].position" :rotation="placePanel[place.side].rotation"
    background="glass" :radius="28" :interactive="false" :cast-shadows="false"
  >
    <LocationPanel :place="place.location" />
  </Surface>
</template>
