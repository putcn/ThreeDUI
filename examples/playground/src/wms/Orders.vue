<script setup lang="ts">
// The orders Block's content (spatial spec §4 step 4): today's eight latest orders with their status, and the alerts.
import { computed, onBeforeUnmount, ref } from 'vue'
import { Box, Button, Card, Checkbox, Input, Icon, Stack, Text } from '@glassui/vue'
import { alerts, grouped, orders as sourceOrders, outboundToday, type Order, type OrderStatus } from './data'
import Breadcrumb from './Breadcrumb.vue'
import OrderDialog from './OrderDialog.vue'
import { filterOrders } from './forms'

const emit = defineEmits<{ navigate: [name: string | null] }>()

/** Each status's chip: its text colour and a tint of it behind. */
const STATUS: Record<OrderStatus, { color: string; bg: string }> = {
  待拣货: { color: 'accent', bg: '#6b63f51f' },
  拣货中: { color: '#8b5cf6', bg: '#a59bff33' },
  已发货: { color: 'success', bg: '#34c7591f' },
  异常: { color: 'danger', bg: '#ff3b301a' },
}
/** The list's columns: order no, customer (the rest), pieces, status, time. */
const COL = { no: 150, items: 64, status: 92, time: 48 } as const
const orders = ref(sourceOrders.map(o => ({ ...o })))
const query = ref(''), overdueOnly = ref(false), todayOnly = ref(false), selected = ref<Order | null>(null), dialog = ref(false), exporting = ref(false), exported = ref(false)
const rows = computed(() => filterOrders(orders.value, { query: query.value, overdueOnly: overdueOnly.value, todayOnly: todayOnly.value }))
const pending = computed(() => orders.value.filter(o => o.status === '待拣货' || o.status === '拣货中').length)
const today = grouped(outboundToday)
let exportTimer: ReturnType<typeof setTimeout> | undefined, exportedTimer: ReturnType<typeof setTimeout> | undefined
function exportOrders(): void { exporting.value = true; clearTimeout(exportTimer); exportTimer = setTimeout(() => { exporting.value = false; exported.value = true; clearTimeout(exportedTimer); exportedTimer = setTimeout(() => { exported.value = false }, 2000) }, 800) }
function ship(order: Order): void { const item = orders.value.find(o => o.no === order.no); if (item) item.status = '已发货'; dialog.value = false }
onBeforeUnmount(() => { clearTimeout(exportTimer); clearTimeout(exportedTimer) })
</script>

<template>
  <Stack :gap="2" :style="{ flexShrink: 0 }">
    <Breadcrumb title="订单" @navigate="emit('navigate', null)" />
    <Stack direction="horizontal" justify="between" align="end">
      <Text value="最近订单" :size="24" :weight="700" />
      <Text :value="[{ text: `今日 ${today} 单` }, { text: `  ·  待处理 ${pending}`, color: 'accent', weight: 600 }]" :size="14" color="secondaryLabel" :wrap="false" />
    </Stack>
    <Stack direction="horizontal" align="center" :gap="12"><Input v-model="query" leading-icon="search" placeholder="搜索单号或客户"/><Checkbox v-model:checked="overdueOnly" label="只看逾期"/><Checkbox v-model:checked="todayOnly" label="只看今日"/><Button variant="glass" :label="exported ? '已导出' : '导出'" :loading="exporting" @press="exportOrders"/></Stack>
  </Stack>

  <Card :style="{ gap: 0, paddingY: 14, flexShrink: 0 }">
    <Stack direction="horizontal" align="center" :gap="12" :style="{ height: 32 }">
      <Text value="单号" :size="13" color="tertiaryLabel" :style="{ width: COL.no }" />
      <Text value="客户" :size="13" color="tertiaryLabel" :style="{ flexGrow: 1, flexBasis: 0 }" />
      <Text value="件数" :size="13" color="tertiaryLabel" align="right" :style="{ width: COL.items }" />
      <Text value="状态" :size="13" color="tertiaryLabel" :style="{ width: COL.status, paddingLeft: 12 }" />
      <Text value="时间" :size="13" color="tertiaryLabel" align="right" :style="{ width: COL.time }" />
    </Stack>
    <template v-for="(o, rowIndex) in rows" :key="o.no">
      <Box :style="{ height: 1, bg: 'separator' }" />
      <Box :id="`order-row-${rowIndex}`" :style="{ flexDirection: 'row', alignItems: 'center', gap: 12, height: 40, hover: { opacity: 0.76 } }" @click="selected = o; dialog = true">
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

  <OrderDialog v-model:open="dialog" :order="selected" @ship="ship" />

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
