<script setup lang="ts">
// The overview Block's content (spatial spec §4 step 2, §12.1–12.2): the top bar, four KPI Cards, and two charts whose
// third dimension carries meaning: the last 14 days' outbound orders by hour as a heat surface (the working days'
// double peak, the weekend and holiday lull) and 徐州一号仓's stock by zone × category as a bar matrix whose colour is a
// fourth value, the days of cover. The tabs in the top bar focus the other Blocks.
import { BarMatrix3D, Box, Button, Card, GlassContainer, Stack, SurfaceChart3D, Switch, Text } from '@glassui/vue'
import { dashboardSeries, grouped, heat, isDayOff, kpis, stock, TODAY } from './data'
import Breadcrumb from './Breadcrumb.vue'
import { computed, onBeforeUnmount, ref } from 'vue'

const emit = defineEmits<{ navigate: [name: string] }>()
const range = ref<'今日' | '本周' | '本月'>('今日'), auto = ref(false), tick = ref(0)
let timer: ReturnType<typeof setInterval> | undefined
const setAuto = (on: boolean) => { auto.value = on; clearInterval(timer); if (on) timer = setInterval(() => { tick.value++ }, 5000) }
onBeforeUnmount(() => clearInterval(timer))

/** pt: both charts' plot height (the matrix's legend takes the room the heat surface's summary row takes). */
const CHART = 300
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
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
const work = mean(totals.filter((_, i) => !isDayOff(heat.days[i]!))), off = mean(totals.filter((_, i) => isDayOff(heat.days[i]!)))
const periodKey = computed(() => range.value === '今日' ? 'today' : range.value === '本周' ? 'week' : 'month')
const summary = computed(() => dashboardSeries.summary[periodKey.value])
const heatSummary = computed(() => [
  { label: '峰值', value: `${grouped(summary.value[0]!)} 单/时`, note: `${heat.days[peak.day]} ${heat.hours[peak.hour]}` },
  { label: '工作日日均', value: `${grouped(summary.value[1]!)} 单`, note: '' },
  { label: '休息日日均', value: `${grouped(summary.value[2]!)} 单`, note: `${Math.round((summary.value[2]! / Math.max(1, summary.value[1]!) - 1) * 100)}%` },
])
/** A KPI's change against yesterday: ▲ in success, ▼ in danger. */
const delta = (d: number) => [
  { text: `${d >= 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(1)}%`, color: d >= 0 ? 'success' : 'danger', weight: 600 },
  { text: '  较昨日', color: 'tertiaryLabel' },
]
const figure = (k: (typeof kpis)[number], index: number) => [
  { text: k.unit === '%' ? dashboardSeries[periodKey.value][index]!.toFixed(1) : grouped(dashboardSeries[periodKey.value][index]! + (index === 1 ? Array.from({ length: tick.value }, (_, i) => dashboardSeries.refreshSteps[i % dashboardSeries.refreshSteps.length]!).reduce((a, b) => a + b, 0) : 0)), size: 38, weight: 700 },
  ...(k.unit === undefined ? [] : [{ text: ` ${k.unit}`, size: 17, weight: 500, color: 'secondaryLabel' }]),
]
</script>

<template>
  <Stack direction="horizontal" align="center" justify="between" :style="{ height: 44, flexShrink: 0 }">
    <Stack :gap="5"><Breadcrumb title="运营看板" @navigate="emit('navigate', 'overview')"/><Text value="云仓 WMS · 徐州一号仓" :size="23" :weight="700"/></Stack>
    <Stack direction="horizontal" align="center" :gap="14"><Text :value="TODAY.label" :size="14" color="secondaryLabel"/><Switch :checked="auto" label="自动刷新" @update:checked="setAuto"/></Stack>
  </Stack>
  <GlassContainer>
    <Button v-for="period in ['今日', '本周', '本月'] as const" :key="period" :label="period" size="small" :variant="range === period ? 'glassProminent' : 'glass'" :glass-id="range === period ? 'range-active' : undefined" @press="range = period" />
  </GlassContainer>

  <!-- KPIs -->
  <Stack direction="horizontal" :gap="20" :style="{ flexShrink: 0 }">
    <Card v-for="k in kpis" :key="k.label" :style="{ flexGrow: 1, flexBasis: 0, gap: 10 }">
      <Text :value="k.label" :size="15" color="secondaryLabel" />
      <Text :value="figure(k, kpis.indexOf(k))" :wrap="false" />
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
