<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { Block, Space, Surface } from '@glassui/vue'
import Dashboard from '../wms/Dashboard.vue'
import Network from '../wms/Network.vue'
import Twin from '../wms/Twin.vue'
import Orders from '../wms/Orders.vue'
import Inbound from '../wms/Inbound.vue'
import Settings from '../wms/Settings.vue'
import BinPanel from '../wms/BinPanel.vue'
import LocationPanel from '../wms/LocationPanel.vue'
import LoginHud from '../wms/LoginHud.vue'
import Dock from '../wms/Dock.vue'
import type { Bin } from '../wms/data'
import type { PlaceHover } from '../wms/map'
import { initialFlow, loginSucceeded, arrived, chose, autoZoom, loggedOut, type Flow } from '../wms/flow'
import { BLOCKS, GRID, inFrameOf, NETWORK, PANEL, PLACE_PANEL, TWIN } from './spatial-grid'

const props = defineProps<{ initialFocus?: string; initialStage?: 'login' | 'overview' }>()
const flow = ref<Flow>(initialFlow({ ...(props.initialStage ? { stage: props.initialStage } : {}), ...(props.initialFocus ? { focus: props.initialFocus } : {}) }))
const focus = computed(() => flow.value.focus)
if (typeof window !== 'undefined') (window as Window & { __glassuiSpatialFocus?: () => string | null }).__glassuiSpatialFocus = () => flow.value.focus
let autoTimer: ReturnType<typeof setTimeout> | undefined
function onChoose(name: string | null): void { clearTimeout(autoTimer); flow.value = chose(flow.value, name) }
function onArrive(name: string | null): void {
  const result = arrived(flow.value, name)
  flow.value = result.flow
  if (result.autoZoomIn !== null) { clearTimeout(autoTimer); autoTimer = setTimeout(() => { flow.value = autoZoom(flow.value) }, result.autoZoomIn) }
}
function login(): void { clearTimeout(autoTimer); flow.value = loginSucceeded(flow.value) }
function logout(): void { clearTimeout(autoTimer); flow.value = loggedOut(flow.value); hovered.value = null; place.value = null }
const hovered = shallowRef<Bin | null>(null), place = shallowRef<PlaceHover | null>(null)
const panel = inFrameOf(TWIN, PANEL.offset), placePanel = { left: inFrameOf(NETWORK, PLACE_PANEL.offset.left), right: inFrameOf(NETWORK, PLACE_PANEL.offset.right) }
const go = (name: string | null) => onChoose(name)
onBeforeUnmount(() => { clearTimeout(autoTimer); if (typeof window !== 'undefined') delete (window as Window & { __glassuiSpatialFocus?: () => string | null }).__glassuiSpatialFocus })
</script>

<template>
  <Space :focus="focus" :radius="GRID.radius" :gap="GRID.gap" layout="grid" :columns="GRID.columns" overview :standby="flow.stage === 'login'" @update:focus="onChoose" @arrive="onArrive">
    <Block name="orders" :width="BLOCKS.orders.width" :height="BLOCKS.orders.height"><Orders @navigate="go"/></Block>
    <Block name="dashboard" :width="BLOCKS.dashboard.width" :height="BLOCKS.dashboard.height"><Dashboard @navigate="go"/></Block>
    <Block name="network" :width="BLOCKS.network.width" :height="BLOCKS.network.height" :position="NETWORK.position" :rotation="NETWORK.rotation"><Network :active="focus === 'network'" @hover="p => (place = p)" @navigate="go"/></Block>
    <Block name="inbound" :width="BLOCKS.inbound.width" :height="BLOCKS.inbound.height"><Inbound @navigate="go"/></Block>
    <Block name="twin" :width="BLOCKS.twin.width" :height="BLOCKS.twin.height" :position="TWIN.position" :rotation="TWIN.rotation"><Twin :active="focus === 'twin'" @hover="b => (hovered = b)" @navigate="go"/></Block>
    <Block name="settings" :width="BLOCKS.settings.width" :height="BLOCKS.settings.height"><Settings @navigate="go" @logout="logout"/></Block>
  </Space>
  <LoginHud v-if="flow.stage === 'login'" @success="login" />
  <Dock v-if="flow.stage === 'operating'" :current="flow.focus" @go="go" />
  <Surface v-if="hovered && focus === 'twin'" :width="PANEL.width" :height="PANEL.height" :pt-per-unit="PANEL.ptPerUnit" :position="panel.position" :rotation="panel.rotation" background="glass" :radius="28" :interactive="false" :cast-shadows="false"><BinPanel :bin="hovered"/></Surface>
  <Surface v-if="place && focus === 'network'" :key="place.side" :width="PLACE_PANEL.width" :height="PLACE_PANEL.height" :pt-per-unit="PLACE_PANEL.ptPerUnit" :position="placePanel[place.side].position" :rotation="placePanel[place.side].rotation" background="glass" :radius="28" :interactive="false" :cast-shadows="false"><LocationPanel :place="place.location"/></Surface>
</template>
