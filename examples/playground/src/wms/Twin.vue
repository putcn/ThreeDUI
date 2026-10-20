<script setup lang="ts">
// The twin Block's content (spatial spec §4 step 3): the title, the overview line and the occupancy legend, then the
// warehouse model in a Viewport3D filling the rest. Drag across it to turn the model; hover a bin to raise it, which
// `hover` reports so Spatial.vue can float the info panel in front of the twin.
import { markRaw, onBeforeUnmount, ref } from 'vue'
import { Box, Button, GlassContainer, Stack, Switch, Text, useMotion, useSurfaceRef, Viewport3D } from '@glassui/vue'
import type { UIEvent } from '@glassui/core'
import type { Viewport3DContext } from '@glassui/render'
import { BIN_LEVELS, binLevel, bins, RACKS, utilisation, type Bin } from './data'
import { createWarehouse } from './warehouse'
import Breadcrumb from './Breadcrumb.vue'

/** `active`: this Block is the focus (Spatial.vue's); off it the model holds still (default true). */
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true })
const emit = defineEmits<{ hover: [bin: Bin | null]; navigate: [name: string | null] }>()

// the model, made once (raw: three objects must not become reactive proxies). Under frozen motion (screenshots), and
// while the Block is not the focus, it is as under reduced motion: the AGV parks, the yaw and the lift are there at
// once, so the model asks for no frames it does not need
const warehouse = markRaw(createWarehouse({ bins }))
const preset = ref<'top' | 'angled' | 'front'>('angled'), lowOnly = ref(false)
function setPreset(value: 'top' | 'angled' | 'front'): void { preset.value = value; warehouse.setView(value) }
function setLowOnly(value: boolean): void { lowOnly.value = value; warehouse.setLowOnly(value) }
const frozen = useMotion() === 'frozen'
const update = (dt: number, ctx: Viewport3DContext): boolean => warehouse.update(dt, frozen || !props.active ? { ...ctx, reducedMotion: true } : ctx)
const percent = Math.round(utilisation * 100)
const counts = BIN_LEVELS.map(l => ({ ...l, count: bins.filter(b => binLevel(b.occupancy).key === l.key).length }))

/** Radians of yaw per CSS px dragged across the canvas. */
const TURN = 0.01
/** ms the panel stays up after the pointer leaves a bin for a gap, a frame or the floor (so it does not blink between bins). */
const GRACE = 160
/** The bin reported last (null: none), and the pending report of none. */
let shown: number | null = null, later: ReturnType<typeof setTimeout> | undefined
const report = (id: number | null): void => {
  clearTimeout(later); later = undefined
  if (id === shown) return
  shown = id
  emit('hover', id === null ? null : warehouse.binAt(id))
}
/** Highlights `id` in the model at once; the panel follows at once for a bin, after `GRACE` for none. */
const hover = (id: number | null, now = false): void => {
  warehouse.hover(id)
  if (id !== null || now) report(id)
  else if (shown !== null && later === undefined) later = setTimeout(() => report(null), GRACE)
}
/** The bin a pointer event is on: its instance of the bins' mesh, else null. */
const binOf = (e: UIEvent): number | null => (e.object === warehouse.bins && e.instanceId !== undefined ? e.instanceId : null)

// the drag: the box's press state is the tracker's (set by the down on it, cleared by the up wherever that lands);
// `x` is the pointer's last place on the canvas (`screenX`, CSS px), which moves only with the pointer, whatever lies
// under it (a 3D hit's localX is its point taken onto the plate: it jumps between a near rack and the floor behind)
let drag: { x: number } | null = null
const onPointerdown = (e: UIEvent): void => { drag = e.screenX === undefined ? null : { x: e.screenX }; hover(null, true) }
const onPointerup = (): void => { drag = null }
const onPointermove = (e: UIEvent): void => {
  if (e.currentTarget.state.pressed) {
    if (e.screenX === undefined) return
    if (drag) warehouse.rotateBy((e.screenX - drag.x) * TURN)
    drag = { x: e.screenX }
    return
  }
  drag = null
  if (e.pointerType === 'touch') return   // no hover by touch: a tap shows the bin (click)
  hover(binOf(e))
}
// a tap shows the bin a finger has no hover for; a mouse or pen hovers instead (and the click that ends a drag must
// not pin the panel)
const onClick = (e: UIEvent): void => { if (e.pointerType !== 'touch') return; const id = binOf(e); if (id !== null) hover(id) }
const onPointerleave = (): void => { drag = null; hover(null, true) }

// the model's geometries and materials are ours: freed with the Block's Surface (in a leaving Block it flies out
// attached), or at once when there is none
const surface = useSurfaceRef()
onBeforeUnmount(() => {
  clearTimeout(later)
  const s = surface.value
  if (s) s.addEventListener('dispose', () => { warehouse.dispose() })
  else warehouse.dispose()
})
</script>

<template>
  <Stack direction="horizontal" justify="between" align="end" :style="{ flexShrink: 0 }">
    <Stack :gap="4">
      <Breadcrumb title="仓储孪生" @navigate="emit('navigate', null)" />
      <Text value="仓储孪生 · 徐州一号仓" :size="24" :weight="700" />
      <Text :value="`${RACKS.rows} 排 · ${bins.length} 个库位 · 利用率 ${percent}%`" :size="14" color="secondaryLabel" />
    </Stack>
    <Stack direction="horizontal" :gap="8">
      <GlassContainer>
        <Button v-for="v in [{key:'top',label:'俯视'},{key:'angled',label:'斜视'},{key:'front',label:'正视'}] as const" :key="v.key" :label="v.label" size="small" :variant="preset === v.key ? 'glassProminent' : 'glass'" @press="setPreset(v.key)"/>
      </GlassContainer>
      <Switch :checked="lowOnly" label="只显示低库存" @update:checked="setLowOnly"/>
      <Stack
        v-for="l in counts" :key="l.key" direction="horizontal" align="center" :gap="6"
        :style="{ paddingX: 12, height: 30, radius: 'capsule', bg: '#ffffff73', border: { width: 1, color: 'separator' } }"
      >
        <Box :style="{ width: 10, height: 10, radius: 3, bg: l.color }" />
        <Text :value="[{ text: l.label }, { text: ` ${l.count}`, color: 'tertiaryLabel' }]" :size="13" :wrap="false" />
      </Stack>
    </Stack>
  </Stack>

  <Viewport3D
    :object="warehouse.group" :update="update" :depth="460" :style="{ flexGrow: 1, height: 'auto' }"
    @pointerdown="onPointerdown" @pointerup="onPointerup" @pointermove="onPointermove" @pointerleave="onPointerleave" @click="onClick"
  />

  <Stack direction="horizontal" justify="between" align="center" :style="{ flexShrink: 0 }">
    <Text value="拖动旋转 · 悬停查看库位" :size="13" color="tertiaryLabel" />
    <Stack direction="horizontal" align="center" :gap="6">
      <Box :style="{ width: 8, height: 8, radius: 4, bg: 'success' }" />
      <Text :value="[{ text: 'AGV-01 运行中' }, { text: ' · 今日搬运 412 次', color: 'tertiaryLabel' }]" :size="13" :wrap="false" />
    </Stack>
  </Stack>
</template>
