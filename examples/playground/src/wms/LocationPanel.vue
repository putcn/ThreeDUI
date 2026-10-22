<script setup lang="ts">
// The place panel's content (spatial spec §12.4): what a hovered place on the network map is and holds, and today's
// runs into and out of it, on the glass panel that floats in front of the map (Spatial.vue's world <Surface>), on the
// side of the map away from the place, with the info panels' veil and entrance (panel.ts).
import { computed } from 'vue'
import { Box, Stack, Text } from '@glassui/vue'
import { grouped, KINDS, laneSummary, lanesOf, network, stockLevel, type Lane, type Location } from './data'
import { useInfoPanel } from './panel'
import { useSpatialLocale } from './locale'

const props = defineProps<{ place: Location }>()
const { t } = useSpatialLocale()
/** The chip: a store's stock level, else its kind, in its colour. */
const chip = computed(() => {
  const p = props.place
  if (p.kind === 'store') { const l = stockLevel(p); return { label: t(l.label), color: l.color } }
  return { label: t(KINDS[p.kind].label), color: KINDS[p.kind].color }
})
const figures = computed(() => [
  { label: t('在库'), value: grouped(props.place.onhand), unit: ` ${t('件')}` },
  { label: 'SKU', value: grouped(props.place.skus), unit: '' },
  { label: t('缺货 SKU'), value: grouped(props.place.outOfStock), unit: '', alert: props.place.outOfStock > 0 && props.place.kind === 'store' && stockLevel(props.place).key !== 'ok' },
])
/** Today's runs in and out: their summary, and how many are overdue. */
const runs = computed(() => {
  const { inbound, outbound } = lanesOf(network, props.place.id)
  const late = (ls: Lane[]): number => ls.filter(l => l.status === 'overdue').length
  return [
    { label: t('入库'), text: t(laneSummary(network, inbound, 'in')), late: late(inbound) },
    { label: t('出库'), text: t(laneSummary(network, outbound, 'out')), late: late(outbound) },
  ]
})
const { veil } = useInfoPanel()
</script>

<template>
  <Stack :gap="7" :style="{ margin: 8, flexGrow: 1, radius: 20, bg: veil, paddingX: 16, paddingY: 12 }">
    <Stack direction="horizontal" justify="between" align="center">
      <Text :value="`${t(KINDS[place.kind].label)} · ${t(place.district)}`" :size="13" color="secondaryLabel" :wrap="false" />
      <Stack direction="horizontal" align="center" :gap="5" :style="{ paddingX: 9, height: 20, radius: 'capsule', bg: `${chip.color}38` }">
        <Box :style="{ width: 7, height: 7, radius: 3.5, bg: chip.color }" />
        <Text :value="chip.label" :size="12" :weight="600" :wrap="false" />
      </Stack>
    </Stack>
    <Text :value="t(place.name)" :size="22" :weight="700" :max-lines="1" />
    <Stack direction="horizontal" :gap="10">
      <Stack v-for="f in figures" :key="f.label" :gap="2" :style="{ flexGrow: 1, flexBasis: 0 }">
        <Text :value="f.label" :size="12" color="secondaryLabel" :wrap="false" />
        <Text :value="[{ text: f.value, weight: 700, ...(f.alert ? { color: 'danger' } : {}) }, { text: f.unit, color: 'secondaryLabel' }]" :size="16" :wrap="false" />
      </Stack>
    </Stack>
    <Box :style="{ height: 1, bg: 'separator' }" />
    <Stack v-for="r in runs" :key="r.label" direction="horizontal" align="center" :gap="10">
      <Text :value="r.label" :size="12" color="tertiaryLabel" :wrap="false" />
      <Text
        :value="[{ text: r.text }, ...(r.late ? [{ text: `  ${t('逾期')} ${r.late}`, color: 'danger', weight: 600 }] : [])]"
        :size="13" :wrap="false" :style="{ flexGrow: 1, flexBasis: 0 }"
      />
    </Stack>
  </Stack>
</template>
