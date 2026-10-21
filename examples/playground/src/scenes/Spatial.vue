<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import { Block, Space, Surface } from '@glassui/vue'
import Dashboard from '../wms/Dashboard.vue'
import Network from '../wms/Network.vue'
import Twin from '../wms/Twin.vue'
import Orders from '../wms/Orders.vue'
import Settings from '../wms/Settings.vue'
import Inventory from '../wms/Inventory.vue'
import BinPanel from '../wms/BinPanel.vue'
import LocationPanel from '../wms/LocationPanel.vue'
import LoginHud from '../wms/LoginHud.vue'
import Dock from '../wms/Dock.vue'
import TraceCard from '../wms/TraceCard.vue'
import { network, orders, SHORT_PICK, type Bin, type Order } from '../wms/data'
import type { PlaceHover } from '../wms/map'
import { initialFlow, loginSucceeded, arrived, chose, autoZoom, loggedOut, type Flow } from '../wms/flow'
import { BLOCKS, BLOCK_SCALE, GRID, inFrameOf, NETWORK, PANEL, PLACE_PANEL, SLOT_BY_NAME, TRACE_PANEL, TWIN } from './spatial-grid'

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
function logout(): void { clearTimeout(autoTimer); flow.value = loggedOut(flow.value); hovered.value = null; place.value = null; traceOrder.value = null }
const hovered = shallowRef<Bin | null>(null), place = shallowRef<PlaceHover | null>(null)
const panel = inFrameOf(TWIN, PANEL.offset), placePanel = { left: inFrameOf(NETWORK, PLACE_PANEL.offset.left), right: inFrameOf(NETWORK, PLACE_PANEL.offset.right) }
const traceOrder = shallowRef<Order | null>(null)
const traceStep = computed(() => focus.value === 'network' ? 'network' : focus.value === 'twin' ? 'twin' : 'orders')
const tracePoses = {
  orders: inFrameOf(SLOT_BY_NAME.orders, TRACE_PANEL.offset),
  network: inFrameOf(NETWORK, TRACE_PANEL.offset),
  twin: inFrameOf(TWIN, TRACE_PANEL.offset),
}
const traceLane = network.lanes.find(lane => lane.from === 'SP-1' && lane.to === 'WH-1' && lane.status === 'overdue')?.id ?? null
function startTrace(order: Order): void { traceOrder.value = order; hovered.value = null; place.value = null; onChoose('orders') }
function inspectShortPick(): void { traceOrder.value = orders.find(order => order.status === '异常') ?? null; hovered.value = null; place.value = null; onChoose('twin') }
function advanceTrace(): void { onChoose(traceStep.value === 'orders' ? 'network' : traceStep.value === 'network' ? 'twin' : 'orders') }
const go = (name: string | null) => { if (name !== 'orders' && name !== 'network' && name !== 'twin') traceOrder.value = null; onChoose(name) }
onBeforeUnmount(() => { clearTimeout(autoTimer); if (typeof window !== 'undefined') delete (window as Window & { __glassuiSpatialFocus?: () => string | null }).__glassuiSpatialFocus })
</script>

<template>
  <Space :focus="focus" :radius="GRID.radius" :gap="GRID.gap" :camera-margin="GRID.cameraMargin" layout="grid" :columns="GRID.columns" overview :standby="flow.stage === 'login'" @update:focus="onChoose" @arrive="onArrive">
    <Block name="orders" :width="BLOCKS.orders.width" :height="BLOCKS.orders.height" :position="SLOT_BY_NAME.orders.position" :rotation="SLOT_BY_NAME.orders.rotation" :unfocused-opacity="0.32"><Orders @navigate="go" @trace="startTrace"/></Block>
    <Block name="dashboard" :width="BLOCKS.dashboard.width" :height="BLOCKS.dashboard.height" :position="SLOT_BY_NAME.dashboard.position" :rotation="SLOT_BY_NAME.dashboard.rotation" :scale="BLOCK_SCALE.dashboard" :unfocused-opacity="0.32"><Dashboard @navigate="go"/></Block>
    <Block name="network" :width="BLOCKS.network.width" :height="BLOCKS.network.height" :position="NETWORK.position" :rotation="NETWORK.rotation" :unfocused-opacity="0.32"><Network :active="focus === 'network'" :trace-warehouse-id="traceOrder ? 'WH-1' : null" :trace-lane-id="traceOrder ? traceLane : null" @hover="p => (place = p)" @navigate="go"/></Block>
    <Block name="twin" :width="BLOCKS.twin.width" :height="BLOCKS.twin.height" :position="TWIN.position" :rotation="TWIN.rotation" :unfocused-opacity="0.32"><Twin :active="focus === 'twin'" :trace-bin-id="traceOrder ? SHORT_PICK.bin : null" @hover="b => (hovered = b)" @navigate="go"/></Block>
    <Block name="inventory" :width="BLOCKS.inventory.width" :height="BLOCKS.inventory.height" :position="SLOT_BY_NAME.inventory.position" :rotation="SLOT_BY_NAME.inventory.rotation" :unfocused-opacity="0.32"><Inventory @navigate="go" @inspect="inspectShortPick"/></Block>
    <Block name="settings" :width="BLOCKS.settings.width" :height="BLOCKS.settings.height" :position="SLOT_BY_NAME.settings.position" :rotation="SLOT_BY_NAME.settings.rotation" :unfocused-opacity="0.32"><Settings @navigate="go" @logout="logout"/></Block>
  </Space>
  <LoginHud v-if="flow.stage === 'login'" @success="login" />
  <Dock v-if="flow.stage === 'operating'" :current="flow.focus" @go="go" />
  <Surface v-if="traceOrder" :width="TRACE_PANEL.width" :height="TRACE_PANEL.height" :pt-per-unit="TRACE_PANEL.ptPerUnit" :position="tracePoses.orders.position" :rotation="tracePoses.orders.rotation" background="glass" :radius="28" :cast-shadows="false"><TraceCard :order="traceOrder" :step="traceStep" :target="tracePoses[traceStep]" @next="advanceTrace" @close="traceOrder = null"/></Surface>
  <Surface v-if="hovered && !traceOrder && focus === 'twin'" :width="PANEL.width" :height="PANEL.height" :pt-per-unit="PANEL.ptPerUnit" :position="panel.position" :rotation="panel.rotation" background="glass" :radius="28" :interactive="false" :cast-shadows="false"><BinPanel :bin="hovered"/></Surface>
  <Surface v-if="place && !traceOrder && focus === 'network'" :key="place.side" :width="PLACE_PANEL.width" :height="PLACE_PANEL.height" :pt-per-unit="PLACE_PANEL.ptPerUnit" :position="placePanel[place.side].position" :rotation="placePanel[place.side].rotation" background="glass" :radius="28" :interactive="false" :cast-shadows="false"><LocationPanel :place="place.location"/></Surface>
</template>
