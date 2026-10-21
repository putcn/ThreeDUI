<script setup lang="ts">
import { computed, ref } from 'vue'
import { Box, Button, Card, Input, Stack, Text } from '@glassui/vue'
import { bins, grouped, SHORT_PICK, utilisation, zones } from './data'
import Breadcrumb from './Breadcrumb.vue'

const emit = defineEmits<{ navigate: [name: string | null]; inspect: [] }>()
const query = ref('')
const low = bins.filter(bin => bin.occupancy < 0.3)
const shortBin = bins.find(bin => bin.id === SHORT_PICK.bin)!
const candidates = [shortBin, ...low.filter(bin => bin.id !== shortBin.id).sort((a, b) => a.occupancy - b.occupancy)].slice(0, 6)
const visible = computed(() => candidates.filter(bin => `${bin.id} ${bin.sku} ${bin.name}`.toLowerCase().includes(query.value.trim().toLowerCase())))
const total = zones.reduce((sum, zone) => sum + zone.value, 0)
const maxZone = Math.max(...zones.map(zone => zone.value))
</script>

<template>
  <Stack direction="horizontal" justify="between" align="end" :style="{ flexShrink: 0 }">
    <Stack :gap="4">
      <Breadcrumb id="crumb-overview-inventory" title="库存" @navigate="emit('navigate', null)" />
      <Text value="库存台账 · 徐州一号仓" :size="24" :weight="700" />
      <Text value="从库区概况定位到具体库位" :size="14" color="secondaryLabel" />
    </Stack>
    <Button id="inventory-open-twin" variant="glassProminent" label="查看仓储孪生" @press="emit('navigate', 'twin')" />
  </Stack>

  <Stack direction="horizontal" :gap="16" :style="{ flexShrink: 0 }">
    <Card :style="{ flexGrow: 1, flexBasis: 0, gap: 7 }"><Text value="在库件数" :size="14" color="secondaryLabel"/><Text :value="grouped(total)" :size="31" :weight="700"/><Text value="六个库区" :size="13" color="tertiaryLabel"/></Card>
    <Card :style="{ flexGrow: 1, flexBasis: 0, gap: 7 }"><Text value="待核查库位" :size="14" color="secondaryLabel"/><Text :value="String(low.length)" :size="31" :weight="700" color="danger"/><Text value="占用率低于 30%" :size="13" color="tertiaryLabel"/></Card>
    <Card :style="{ flexGrow: 1, flexBasis: 0, gap: 7 }"><Text value="库位利用率" :size="14" color="secondaryLabel"/><Text :value="`${Math.round(utilisation * 100)}%`" :size="31" :weight="700"/><Text :value="`${bins.length} 个库位`" :size="13" color="tertiaryLabel"/></Card>
  </Stack>

  <Stack direction="horizontal" :gap="18" :style="{ flexGrow: 1 }">
    <Card :style="{ flexGrow: 1, flexBasis: 0, gap: 14 }">
      <Stack :gap="3"><Text value="库区分布" :size="18" :weight="700"/><Text value="在库件数 · 同一比例尺" :size="13" color="secondaryLabel"/></Stack>
      <Stack v-for="(zone, index) in zones" :key="zone.label" direction="horizontal" align="center" :gap="12" :style="{ height: 51 }">
        <Text :value="zone.label" :size="14" :weight="600" :style="{ width: 45 }" :wrap="false" />
        <Box :style="{ flexGrow: 1, height: 12, radius: 6, bg: '#7b86aa1c' }"><Box :style="{ width: `${zone.value / maxZone * 100}%`, height: 12, radius: 6, bg: index === 2 ? '#9789ed' : '#aab6d8' }" /></Box>
        <Text :value="grouped(zone.value)" :size="14" align="right" :style="{ width: 62, font: 'Menlo' }" :wrap="false" />
      </Stack>
    </Card>

    <Card :style="{ flexGrow: 1.16, flexBasis: 0, gap: 11 }">
      <Stack direction="horizontal" justify="between" align="center"><Text value="待核查库位" :size="18" :weight="700"/><Text value="按低库存优先" :size="13" color="secondaryLabel"/></Stack>
      <Input v-model="query" leading-icon="search" placeholder="搜索库位或商品" />
      <Stack v-for="bin in visible" :key="bin.id" direction="horizontal" align="center" :gap="10" :style="{ height: 42 }">
        <Box :style="{ width: 7, height: 7, radius: 4, bg: bin.id === SHORT_PICK.bin ? 'danger' : '#ff9f0a' }" />
        <Text :value="bin.id" :size="13" :weight="600" :style="{ width: 70, font: 'Menlo' }" :wrap="false" />
        <Text :value="bin.name" :size="13" :max-lines="1" :style="{ flexGrow: 1, flexBasis: 0 }" />
        <Text :value="`${bin.qty} / ${bin.cap}`" :size="13" color="secondaryLabel" align="right" :style="{ width: 65 }" :wrap="false" />
      </Stack>
      <Stack v-if="visible.length === 0" align="center" :style="{ paddingY: 28 }"><Text value="没有匹配的库位" :size="14" color="secondaryLabel"/></Stack>
      <Stack direction="horizontal" justify="end" :style="{ marginTop: 5 }"><Button id="inventory-inspect-short" size="small" variant="glass" :label="`定位 ${SHORT_PICK.bin}`" @press="emit('inspect')" /></Stack>
    </Card>
  </Stack>
</template>
