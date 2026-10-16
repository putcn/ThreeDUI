<script setup lang="ts">
// The overview Block's content (spatial spec §4 step 2): the top bar, four KPI Cards, the 30-day flow (a 2D line chart)
// and the zones' stock (a 3D bar chart growing out of its Card's glass). The tabs in the top bar focus the other Blocks.
import { BarChart3D, Box, Card, Icon, LineChart, Stack, Text } from '@glassui/vue'
import { flow30d, grouped, kpis, TODAY, zones } from './data'

const emit = defineEmits<{ navigate: [name: string] }>()

const tabs = [{ name: 'overview', label: '总览' }, { name: 'twin', label: '仓储孪生' }, { name: 'orders', label: '订单' }] as const
/** A tab: the current one (this Block) on a white capsule, the others tinted under the pointer. */
const tab = (current: boolean) => ({
  paddingX: 18, height: 32, radius: 'capsule' as const, justifyContent: 'center' as const,
  ...(current ? { bg: 'fill' } : { hover: { bg: '#1c1c220d' } }),
})
/** The line chart's series: inbound in a sky blue, outbound (today's KPI) in the accent. */
const series = [{ name: '入库', data: flow30d.inbound, color: '#5b9cf6' }, { name: '出库', data: flow30d.outbound, color: 'accent' }]
/** The busiest zone in the accent, the others in a lighter tint of it. */
const top = Math.max(...zones.map(z => z.value))
const bars = zones.map(z => ({ label: z.label, value: z.value, color: z.value === top ? 'accent' : '#b9b4fb' }))
const total = zones.reduce((s, z) => s + z.value, 0)
const least = Math.min(...zones.map(z => z.value))
const most = zones.find(z => z.value === top)!, fewest = zones.find(z => z.value === least)!
const summary = [
  { label: '库存总量', value: `${grouped(total)} 件` },
  { label: '最多', value: `${most.label} ${grouped(most.value)}` },
  { label: '最少', value: `${fewest.label} ${grouped(fewest.value)}` },
]
const pieces = (v: number): string => `${grouped(v)} 件`
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
      <Text value="上海一号仓" :size="15" :weight="600" :wrap="false" />
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

  <!-- charts: the 30-day flow (60 %) and the zones' stock (40 %) -->
  <Stack direction="horizontal" :gap="20" :style="{ flexGrow: 1 }">
    <Card :style="{ flexGrow: 3, flexBasis: 0 }">
      <Stack direction="horizontal" justify="between" align="center">
        <Text value="近 30 天出入库" :size="17" :weight="600" />
        <Text value="单位：单 · 09-16 至 10-15" :size="13" color="tertiaryLabel" />
      </Stack>
      <LineChart :labels="flow30d.labels" :series="series" :height="456" :format="grouped" />
    </Card>
    <Card :style="{ flexGrow: 2, flexBasis: 0 }">
      <Stack direction="horizontal" justify="between" align="center">
        <Text value="各库区库存" :size="17" :weight="600" />
        <Text value="单位：件" :size="13" color="tertiaryLabel" />
      </Stack>
      <Box :style="{ flexGrow: 1, justifyContent: 'center' }">
        <BarChart3D :data="bars" :format="pieces" />
      </Box>
      <Box :style="{ height: 1, bg: 'separator' }" />
      <Stack direction="horizontal" :gap="12">
        <Stack v-for="s in summary" :key="s.label" :gap="4" :style="{ flexGrow: 1, flexBasis: 0 }">
          <Text :value="s.label" :size="13" color="secondaryLabel" />
          <Text :value="s.value" :size="18" :weight="700" :wrap="false" />
        </Stack>
      </Stack>
    </Card>
  </Stack>
</template>
