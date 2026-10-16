<script setup lang="ts">
// The twin Block's content (spatial spec §4 step 3): the title, the overview line and the occupancy legend, then the
// warehouse model in a Viewport3D filling the rest. Drag across it to turn the model; hover a bin to raise it, which
// `hover` reports so Spatial.vue can float the info panel in front of the twin.
import { markRaw, onBeforeUnmount } from 'vue'
import { Box, Icon, Stack, Text, useMotion, useSurfaceRef, Viewport3D } from '@glassui/vue'
import type { UIEvent } from '@glassui/core'
import type { Viewport3DContext } from '@glassui/render'
import { bins, kpis, RACKS, type Bin } from './data'
import { BIN_LEVELS, binLevel, createWarehouse } from './warehouse'

const emit = defineEmits<{ hover: [bin: Bin | null]; navigate: [name: string] }>()

// the model, made once (raw: three objects must not become reactive proxies). Under frozen motion (screenshots) it is
// as under reduced motion: the AGV parks, the yaw and the lift are there at once
const warehouse = markRaw(createWarehouse({ bins }))
const frozen = useMotion() === 'frozen'
const update = (dt: number, ctx: Viewport3DContext): boolean => warehouse.update(dt, frozen ? { ...ctx, reducedMotion: true } : ctx)
const utilisation = Math.round(Number(kpis[3]!.value))
const counts = BIN_LEVELS.map(l => ({ ...l, count: bins.filter(b => binLevel(b.occupancy).key === l.key).length }))

/** Radians of yaw per pt dragged across the box. */
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

// the drag: the box's press state is the tracker's (set by the down on it, cleared by the up wherever that lands); `x`
// is the last move's localX, `object` and `instance` what it was over: a move onto another object (or instance) only
// re-bases, since a 3D hit's x is its point taken straight onto the plate, which jumps between a near rack and the
// floor behind it. A step turns at most 40 pt's worth
let drag: { x: number; object: unknown; instance: number | undefined } | null = null
const grab = (e: UIEvent) => ({ x: e.localX, object: e.object, instance: e.instanceId })
const onPointerdown = (e: UIEvent): void => { drag = grab(e); hover(null, true) }
const onPointerup = (): void => { drag = null }
const onPointermove = (e: UIEvent): void => {
  if (e.currentTarget.state.pressed) {
    if (drag && drag.object === e.object && drag.instance === e.instanceId) warehouse.rotateBy(Math.max(-40, Math.min(40, e.localX - drag.x)) * TURN)
    drag = grab(e)
    return
  }
  drag = null
  if (e.pointerType === 'touch') return   // no hover by touch: a tap shows the bin (click)
  hover(binOf(e))
}
const onClick = (e: UIEvent): void => { const id = binOf(e); if (id !== null) hover(id) }
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
      <Stack direction="horizontal" align="center" :gap="4">
        <Box :style="{ flexDirection: 'row', alignItems: 'center', gap: 2, hover: { opacity: 0.7 } }" @click="emit('navigate', 'overview')">
          <Icon name="chevron-left" :size="14" color="accent" :weight="0.14" />
          <Text value="总览" :size="14" color="accent" :weight="600" />
        </Box>
        <Text value="/ 仓储孪生" :size="14" color="tertiaryLabel" />
      </Stack>
      <Text value="仓储孪生 · 上海一号仓" :size="24" :weight="700" />
      <Text :value="`${RACKS.rows} 排 · ${bins.length} 个库位 · 利用率 ${utilisation}%`" :size="14" color="secondaryLabel" />
    </Stack>
    <Stack direction="horizontal" :gap="8">
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
