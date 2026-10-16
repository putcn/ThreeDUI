<script setup lang="ts">
// The orders Block's content (spatial spec §4 step 4): today's eight latest orders with their status, and the alerts.
import { Box, Card, Icon, Stack, Text } from '@glassui/vue'
import { alerts, grouped, orders, outboundToday, type OrderStatus } from './data'

const emit = defineEmits<{ navigate: [name: string] }>()

/** Each status's chip: its text colour and a tint of it behind. */
const STATUS: Record<OrderStatus, { color: string; bg: string }> = {
  待拣货: { color: 'accent', bg: '#6b63f51f' },
  拣货中: { color: '#8b5cf6', bg: '#a59bff33' },
  已发货: { color: 'success', bg: '#34c7591f' },
  异常: { color: 'danger', bg: '#ff3b301a' },
}
/** The list's columns: order no, customer (the rest), pieces, status, time. */
const COL = { no: 150, items: 64, status: 92, time: 48 } as const
const pending = orders.filter(o => o.status === '待拣货' || o.status === '拣货中').length
const today = grouped(outboundToday)
</script>

<template>
  <Stack :gap="4" :style="{ flexShrink: 0 }">
    <Stack direction="horizontal" align="center" :gap="4">
      <Box :style="{ flexDirection: 'row', alignItems: 'center', gap: 2, hover: { opacity: 0.7 } }" @click="emit('navigate', 'overview')">
        <Icon name="chevron-left" :size="14" color="accent" :weight="0.14" />
        <Text value="总览" :size="14" color="accent" :weight="600" />
      </Box>
      <Text value="/ 订单与告警" :size="14" color="tertiaryLabel" />
    </Stack>
    <Stack direction="horizontal" justify="between" align="end">
      <Text value="最近订单" :size="24" :weight="700" />
      <Text :value="[{ text: `今日 ${today} 单` }, { text: `  ·  待处理 ${pending}`, color: 'accent', weight: 600 }]" :size="14" color="secondaryLabel" :wrap="false" />
    </Stack>
  </Stack>

  <Card :style="{ gap: 0, paddingY: 14, flexShrink: 0 }">
    <Stack direction="horizontal" align="center" :gap="12" :style="{ height: 32 }">
      <Text value="单号" :size="13" color="tertiaryLabel" :style="{ width: COL.no }" />
      <Text value="客户" :size="13" color="tertiaryLabel" :style="{ flexGrow: 1, flexBasis: 0 }" />
      <Text value="件数" :size="13" color="tertiaryLabel" align="right" :style="{ width: COL.items }" />
      <Text value="状态" :size="13" color="tertiaryLabel" :style="{ width: COL.status, paddingLeft: 12 }" />
      <Text value="时间" :size="13" color="tertiaryLabel" align="right" :style="{ width: COL.time }" />
    </Stack>
    <template v-for="o in orders" :key="o.no">
      <Box :style="{ height: 1, bg: 'separator' }" />
      <Box :style="{ flexDirection: 'row', alignItems: 'center', gap: 12, height: 46 }">
        <Text :value="o.no" :size="14" :style="{ width: COL.no, font: 'Menlo' }" :wrap="false" />
        <Text :value="o.customer" :size="15" :max-lines="1" :style="{ flexGrow: 1, flexBasis: 0 }" />
        <Text :value="`${grouped(o.items)} 件`" :size="14" color="secondaryLabel" align="right" :style="{ width: COL.items }" :wrap="false" />
        <Box :style="{ width: COL.status, paddingLeft: 12, alignItems: 'flex-start' }">
          <Stack direction="horizontal" align="center" :gap="5" :style="{ paddingX: 9, height: 24, radius: 'capsule', bg: STATUS[o.status].bg }">
            <Box :style="{ width: 6, height: 6, radius: 3, bg: STATUS[o.status].color }" />
            <Text :value="o.status" :size="13" :weight="600" :color="STATUS[o.status].color" :wrap="false" />
          </Stack>
        </Box>
        <Text :value="o.time" :size="14" color="tertiaryLabel" align="right" :style="{ width: COL.time }" :wrap="false" />
      </Box>
    </template>
  </Card>

  <Card :style="{ flexShrink: 0 }">
    <Stack direction="horizontal" align="center" :gap="8">
      <Icon name="warning" :size="20" color="danger" />
      <Text value="异常告警" :size="17" :weight="600" />
      <Box :style="{ paddingX: 8, height: 20, radius: 'capsule', bg: '#ff3b301a', justifyContent: 'center' }">
        <Text :value="String(alerts.length)" :size="12" :weight="700" color="danger" />
      </Box>
    </Stack>
    <Stack v-for="a in alerts" :key="a.title" direction="horizontal" align="start" :gap="12" :style="{ paddingY: 4 }">
      <Box :style="{ width: 8, height: 8, radius: 4, marginTop: 7, bg: a.level === 'danger' ? 'danger' : '#ff9f0a' }" />
      <Stack :gap="2" :style="{ flexGrow: 1, flexBasis: 0 }">
        <Text :value="a.title" :size="15" :weight="600" />
        <Text :value="a.detail" :size="13" color="secondaryLabel" :max-lines="1" />
      </Stack>
      <Text :value="a.time" :size="13" color="tertiaryLabel" :wrap="false" />
    </Stack>
  </Card>
</template>
