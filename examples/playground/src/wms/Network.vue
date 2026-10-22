<script setup lang="ts">
// The network Block's content (spatial spec §12.4): the title, the network's counts and the legend; Xuzhou's logistics
// map in a Viewport3D filling the rest (map.ts: a dark plate, the districts, roads and water, the places as prisms and
// today's runs as arcs); the controls' hint and the map data's credit under it. Wheel to zoom, drag to pan, right-drag
// or Shift-drag to turn; hover a place to light it and its runs, which `hover` reports (with the side of the map it
// shows on) so Spatial.vue can float the place panel on the other side.
import { computed, markRaw, onBeforeUnmount, reactive, watch } from 'vue'
import { Box, Button, GlassContainer, Stack, Text, useCanvasFactory, useMotion, useSurfaceRef, Viewport3D } from '@glassui/vue'
import type { UIEvent } from '@glassui/core'
import type { Viewport3DContext } from '@glassui/render'
import geo from './geo/xuzhou.json'
import { KINDS, network, STOCK_LEVELS, stockLevel } from './data'
import { createNetworkMap, type GeoData, type PlaceHover } from './map'
import Breadcrumb from './Breadcrumb.vue'
import { useSpatialLocale } from './locale'
const { t } = useSpatialLocale()

/** `active`: this Block is the focus (Spatial.vue's); off it the map holds still (default true). */
const props = withDefaults(defineProps<{ active?: boolean; traceWarehouseId?: string | null; traceLaneId?: string | null }>(), { active: true, traceWarehouseId: null, traceLaneId: null })
const emit = defineEmits<{ hover: [place: PlaceHover | null]; navigate: [name: string | null] }>()

// the map, made once (raw: three objects must not become reactive proxies). Under frozen motion (screenshots), and
// while the Block is not the focus, it is as under reduced motion: the view is where it is headed at once and the dots
// park, so the map asks for no frames it does not need
const map = markRaw(createNetworkMap(geo as GeoData, network, { createCanvas: useCanvasFactory(), translate: t }))
watch(() => props.traceWarehouseId, id => map.hover(id), { immediate: true })
watch(() => props.traceLaneId, id => map.highlightLane(id), { immediate: true })
const layers = reactive({ store: true, warehouse: true, supplier: true })
const layerKinds = ['store', 'warehouse', 'supplier'] as const
const toggleLayer = (kind: keyof typeof layers) => { layers[kind] = !layers[kind]; map.setLayer(kind, layers[kind]) }
const frozen = useMotion() === 'frozen'
const update = (dt: number, ctx: Viewport3DContext): boolean => map.update(dt, frozen || !props.active ? { ...ctx, reducedMotion: true } : ctx)

// the header: the counts, today's runs, the stock held; the legend (kinds, then the stores' stock levels)
const places = network.locations, lanes = network.lanes
const count = (k: keyof typeof KINDS): number => places.filter(l => l.kind === k).length
const moving = lanes.filter(l => l.status !== 'planned').length, overdue = lanes.filter(l => l.status === 'overdue').length
const held = places.filter(l => l.kind !== 'supplier').reduce((s, l) => s + l.onhand, 0)
const stats = computed(() => [
  { text: `${count('warehouse')} ${t('个仓库')} · ${count('store')} ${t('家门店')} · ${count('supplier')} ${t('家供应商')} · ${t('在途')} ${moving} ${t('单')} · ` },
  { text: `${t('逾期')} ${overdue}`, color: 'danger', weight: 600 },
  { text: ` · ${t('在库')} ${(held / 10_000).toFixed(1)} ${t('万件')}` },
])
const stores = places.filter(l => l.kind === 'store')
const legend = computed(() => [
  { key: 'store', label: t(KINDS.store.label), color: KINDS.store.color, count: count('store') },
  { key: 'warehouse', label: t(KINDS.warehouse.label), color: KINDS.warehouse.color, count: count('warehouse') },
  { key: 'supplier', label: t(KINDS.supplier.label), color: KINDS.supplier.color, count: count('supplier') },
  ...STOCK_LEVELS.map(s => ({ key: s.key, label: t(s.label), color: s.color, count: stores.filter(l => stockLevel(l).key === s.key).length })),
])

/** Radians the map turns a CSS px dragged sideways (yaw) and up (pitch); the wheel's zoom per unit of deltaY. */
const TURN = 0.008, TILT = 0.005, WHEEL = 0.0015
/** ms the panel stays up after the pointer leaves a place (so it does not blink between neighbours). */
const GRACE = 160

/** The place reported last (its id; null: none), and the pending report of none. */
let shown: string | null = null, later: ReturnType<typeof setTimeout> | undefined
const report = (id: string | null): void => {
  clearTimeout(later); later = undefined
  if (id === shown) return
  shown = id
  if (id === null) { emit('hover', null); return }
  const at = map.placeOf(id)
  emit('hover', { location: places.find(l => l.id === id)!, side: at && at[0] > 0 ? 'left' : 'right' })
}
/** Lights `id` on the map at once; the panel follows at once for a place, after `GRACE` for none. */
const hover = (id: string | null, now = false): void => {
  map.hover(id ?? props.traceWarehouseId)
  if (id !== null || now) report(id)
  else if (shown !== null && later === undefined) later = setTimeout(() => report(null), GRACE)
}
const placeOf = (e: UIEvent): string | null => map.pick(e.object, e.instanceId, e.point)?.id ?? null

// the drags: the pointer's last place on the canvas (`screenX/Y`, CSS px, which move only with the pointer, whatever lies
// under it) and in the Block (pt). A left drag pans by the canvas px times `ratio`, the Block's pt a canvas px, measured
// as the pointer crosses the plate (where the Block's point is exact); Shift turns it into a turn, as a right drag is
type At = { x: number; y: number; px: number; py: number; flat: boolean }
let last: At | null = null, ratio = 1.3
const atOf = (e: UIEvent): At | null =>
  e.screenX === undefined || e.screenY === undefined ? null : { x: e.screenX, y: e.screenY, px: e.x, py: e.y, flat: !e.object || (e.object as { name?: string }).name === 'plate' }
const drag = (e: UIEvent, at: At, prev: At): void => {
  const dx = at.x - prev.x, dy = at.y - prev.y
  if (e.shiftKey === true || ((e.buttons ?? 0) & 2) !== 0) map.rotate(dx * TURN, -dy * TILT)
  else map.pan(dx * ratio, dy * ratio)
}

const onPointerdown = (e: UIEvent): void => { last = atOf(e); hover(null, true) }
// a right-button down presses nothing: it arrives as contextmenu, where its drag starts
const onContextmenu = (e: UIEvent): void => { last = atOf(e); hover(null, true) }
const onPointerup = (): void => { last = null }
const onPointermove = (e: UIEvent): void => {
  const at = atOf(e), prev = last
  last = at
  if (at && prev && at.flat && prev.flat) {
    const d = Math.hypot(at.x - prev.x, at.y - prev.y)
    if (d > 2) ratio = Math.min(4, Math.max(0.3, Math.hypot(at.px - prev.px, at.py - prev.py) / d))
  }
  // a left drag (the box holds the press), or a right one (no press: the moves say the right button is down)
  if (e.currentTarget.state.pressed || ((e.buttons ?? 0) & 2) !== 0) {
    if (at && prev) drag(e, at, prev)
    return
  }
  if (e.pointerType === 'touch') return   // no hover by touch: a tap shows the place (click)
  hover(placeOf(e))
}
const onPointerleave = (): void => { last = null; hover(null, true) }
const onWheel = (e: UIEvent): void => { map.zoom(Math.exp(-(e.deltaY ?? 0) * WHEEL)) }
// a tap shows the place a finger has no hover for; a mouse or pen hovers instead (and the click that ends a drag must
// not pin the panel)
const onClick = (e: UIEvent): void => { if (e.pointerType !== 'touch') return; const id = placeOf(e); if (id !== null) hover(id) }

// the map's geometries, materials and textures are ours: freed with the Block's Surface (in a leaving Block it flies
// out attached), or at once when there is none
const surface = useSurfaceRef()
onBeforeUnmount(() => {
  clearTimeout(later)
  const s = surface.value
  if (s) s.addEventListener('dispose', () => { map.dispose() })
  else map.dispose()
})
</script>

<template>
  <Stack direction="horizontal" justify="between" align="end" :style="{ flexShrink: 0 }">
    <Stack :gap="4">
      <Breadcrumb id="crumb-overview-network" :title="t('物流网络')" @navigate="emit('navigate', null)" />
      <Text :value="t('物流网络 · 徐州')" :size="24" :weight="700" />
      <Text :value="stats" :size="14" color="secondaryLabel" :wrap="false" />
    </Stack>
    <Stack direction="horizontal" :gap="8">
      <Stack
        v-for="l in legend" :key="l.key" direction="horizontal" align="center" :gap="6"
        :style="{ paddingX: 12, height: 30, radius: 'capsule', bg: '#ffffff73', border: { width: 1, color: 'separator' } }"
      >
        <Box :style="{ width: 10, height: 10, radius: 3, bg: l.color }" />
        <Text :value="[{ text: l.label }, { text: ` ${l.count}`, color: 'tertiaryLabel' }]" :size="13" :wrap="false" />
      </Stack>
    </Stack>
  </Stack>

  <Stack direction="horizontal" justify="end" :style="{ flexShrink: 0 }">
    <GlassContainer>
      <Button shape="circle" leading-icon="plus" @press="map.zoomBy(1.25)"/><Button shape="circle" leading-icon="minus" @press="map.zoomBy(0.8)"/><Button shape="circle" leading-icon="refresh" @press="map.resetView()"/>
      <Button v-for="kind in layerKinds" :key="kind" size="small" :label="t({store:'门店',warehouse:'仓库',supplier:'供应商'}[kind])" :variant="layers[kind] ? 'tinted' : 'glass'" @press="toggleLayer(kind)"/>
    </GlassContainer>
  </Stack>
  <Viewport3D
    :object="map.group" :update="update" :depth="260" :style="{ flexGrow: 1, height: 'auto' }"
    @pointerdown="onPointerdown" @pointerup="onPointerup" @pointermove="onPointermove" @pointerleave="onPointerleave" @contextmenu="onContextmenu" @wheel="onWheel" @click="onClick"
  />

  <Stack direction="horizontal" justify="between" align="center" :style="{ flexShrink: 0 }">
    <Text :value="t('滚轮缩放 · 左键平移 · 右键/Shift 旋转 · 悬停查看地点')" :size="13" color="tertiaryLabel" />
    <Text value="© OpenStreetMap contributors · DataV" :size="12" color="tertiaryLabel" :wrap="false" />
  </Stack>
</template>
