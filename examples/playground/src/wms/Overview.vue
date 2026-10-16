<script setup lang="ts">
// The overview Block's content (spatial spec §4 step 2, §12.1–12.2): the top bar, four KPI Cards, and two charts whose
// third dimension carries meaning: the last 14 days' outbound orders by hour as a heat surface (the working days'
// double peak, the weekend and holiday lull) and 徐州一号仓's stock by zone × category as a bar matrix whose colour is a
// fourth value, the days of cover. The tabs in the top bar focus the other Blocks.
import { BarMatrix3D, Box, Card, Icon, Stack, SurfaceChart3D, Text } from '@glassui/vue'
import { grouped, heat, kpis, stock, TODAY } from './data'

const emit = defineEmits<{ navigate: [name: string] }>()

const tabs = [{ name: 'overview', label: '总览' }, { name: 'network', label: '物流网络' }, { name: 'twin', label: '仓储孪生' }, { name: 'orders', label: '订单' }] as const
/** A tab: the current one (this Block) on a white capsule, the others tinted under the pointer. */
const tab = (current: boolean) => ({
  paddingX: 18, height: 32, radius: 'capsule' as const, justifyContent: 'center' as const,
  ...(current ? { bg: 'fill' } : { hover: { bg: '#1c1c220d' } }),
})
/** pt: both charts' plot height (the matrix's legend takes the room the heat surface's summary row takes). */
const CHART = 420
const orders = (v: number): string => `${grouped(v)} 单`
const pieces = (v: number): string => `${grouped(v)} 件`
const days = (v: number): string => `${v} 天`
/** Under the heat surface: its peak hour, and a working day's and a day off's average (weekends and the holiday). */
const peak = (() => {
  let best = { value: -1, day: 0, hour: 0 }
  heat.values.forEach((row, day) => row.forEach((value, hour) => { if (value > best.value) best = { value, day, hour } }))
  return best
})()
const totals = heat.values.map(r => r.reduce((a, b) => a + b, 0))
const isOff = (label: string): boolean => {
  const [m, d] = label.split('-').map(Number) as [number, number], wd = new Date(Date.UTC(TODAY.year, m - 1, d)).getUTCDay()
  return wd === 0 || wd === 6 || (m === 10 && d <= 7)
}
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
const work = mean(totals.filter((_, i) => !isOff(heat.days[i]!))), off = mean(totals.filter((_, i) => isOff(heat.days[i]!)))
const heatSummary = [
  { label: '峰值', value: `${grouped(peak.value)} 单/时`, note: `${heat.days[peak.day]} ${heat.hours[peak.hour]}:00` },
  { label: '工作日日均', value: `${grouped(work)} 单`, note: '' },
  { label: '休息日日均', value: `${grouped(off)} 单`, note: `${Math.round((off / work - 1) * 100)}%` },
]
/** A KPI's change against yesterday: ▲ in success, ▼ in danger. */
const delta = (d: number) => [
  { text: `${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}%`, color: d >= 0 ? 'success' : 'danger', weight: 600 },
  { text: '  较昨日', color: 'tertiaryLabel' },
]
const figure = (k: (typeof kpis)[number]) => [
  { text: k.value, size: 38, weight: 700 },
  ...(k.unit === undefined ? [] : [{ text: ` ${k.unit}`, size: 17, weight: 500, color: 'secondaryLabel' }]),
]
</script>

<template>
  <!-- the top bar: brand, warehouse switch, the Blocks as tabs, the day and the user -->
  <Stack direction="horizontal" align="center" :gap="14" :style="{ height: 44, flexShrink: 0 }">
    <Box :style="{ width: 34, height: 34, radius: 10, bg: 'accent', alignItems: 'center', justifyContent: 'center', gap: 3 }">
      <Box v-for="i in 3" :key="i" :style="{ width: 16, height: 3, radius: 1.5, bg: '#ffffff' }" />
    </Box>
    <Text value="云仓 WMS" :size="20" :weight="700" :wrap="false" />
    <Stack direction="horizontal" align="center" :gap="6" :style="{ paddingX: 14, height: 34, radius: 'capsule', bg: '#6b63f514', marginLeft: 6 }">
      <Text value="徐州一号仓" :size="15" :weight="600" :wrap="false" />
      <Icon name="chevron-down" :size="16" color="secondaryLabel" :weight="0.12" />
    </Stack>
    <Box :style="{ flexGrow: 1 }" />
    <Stack direction="horizontal" :gap="4" :style="{ padding: 4, radius: 'capsule', bg: '#1c1c220d' }">
      <Box v-for="t in tabs" :key="t.name" :style="tab(t.name === 'overview')" @click="emit('navigate', t.name)">
        <Text :value="t.label" :size="15" :weight="t.name === 'overview' ? 600 : 500" :color="t.name === 'overview' ? 'label' : 'secondaryLabel'" :wrap="false" />
      </Box>
    </Stack>
    <Box :style="{ flexGrow: 1 }" />
    <Text :value="TODAY.label" :size="15" color="secondaryLabel" :wrap="false" />
    <Stack direction="horizontal" align="center" :gap="10" :style="{ marginLeft: 6 }">
      <Box :style="{ width: 36, height: 36, radius: 'capsule', bg: 'accent', alignItems: 'center', justifyContent: 'center' }">
        <Text value="王" :size="16" :weight="600" color="#ffffff" />
      </Box>
      <Stack :gap="0">
        <Text value="王敏" :size="15" :weight="600" :wrap="false" />
        <Text value="仓储主管" :size="12" color="secondaryLabel" :wrap="false" />
      </Stack>
    </Stack>
  </Stack>

  <!-- KPIs -->
  <Stack direction="horizontal" :gap="20" :style="{ flexShrink: 0 }">
    <Card v-for="k in kpis" :key="k.label" :style="{ flexGrow: 1, flexBasis: 0, gap: 10 }">
      <Text :value="k.label" :size="15" color="secondaryLabel" />
      <Text :value="figure(k)" :wrap="false" />
      <Text :value="delta(k.delta)" :size="14" />
    </Card>
  </Stack>

  <!-- charts, as tall as each other: the outbound heat surface (60 %) and the zone × category stock (40 %) -->
  <Stack direction="horizontal" :gap="20" :style="{ flexGrow: 1 }">
    <Card :style="{ flexGrow: 3, flexBasis: 0 }">
      <Stack direction="horizontal" justify="between" align="center">
        <Text value="近 14 天出库热力" :size="17" :weight="600" />
        <Text :value="`单位：单/时 · ${heat.days[0]} 至 ${heat.days.at(-1)}`" :size="13" color="tertiaryLabel" />
      </Stack>
      <SurfaceChart3D :x-labels="heat.hours" :y-labels="heat.days" :values="heat.values" :format="orders" :height="CHART" />
      <Stack direction="horizontal" :gap="12" :style="{ height: 26, alignItems: 'center' }">
        <Stack v-for="s in heatSummary" :key="s.label" direction="horizontal" align="center" :gap="8" :style="{ flexGrow: 1, flexBasis: 0, justifyContent: 'center' }">
          <Text :value="s.label" :size="13" color="secondaryLabel" :wrap="false" />
          <Text :value="[{ text: s.value, weight: 700 }, ...(s.note ? [{ text: `  ${s.note}`, color: 'tertiaryLabel', weight: 500 }] : [])]" :size="15" :wrap="false" />
        </Stack>
      </Stack>
    </Card>
    <Card :style="{ flexGrow: 2, flexBasis: 0 }">
      <Stack direction="horizontal" justify="between" align="center">
        <Text value="库区 × 品类 库存" :size="17" :weight="600" />
        <Text value="高：件数 · 色：周转天数" :size="13" color="tertiaryLabel" />
      </Stack>
      <BarMatrix3D
        :rows="stock.rows" :cols="stock.cols" :values="stock.values" :color-values="stock.cover"
        color-label="周转" :color-format="days" :format="pieces" :height="CHART"
      />
    </Card>
  </Stack>
</template>
