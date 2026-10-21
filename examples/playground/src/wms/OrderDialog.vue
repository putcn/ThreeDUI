<script setup lang="ts">
import { Button, Dialog, Stack, Text } from '@glassui/vue'
import type { Order } from './data'
const props = defineProps<{ order: Order | null; open: boolean }>()
const emit = defineEmits<{ 'update:open': [open: boolean]; ship: [order: Order]; trace: [order: Order] }>()
</script>
<template>
  <Dialog :open="props.open" title="订单详情" @update:open="emit('update:open', $event)">
    <Stack v-if="props.order" :gap="10"><Text :value="props.order.no" :weight="700"/><Text :value="props.order.customer"/><Text :value="`件数 ${props.order.items} · ${props.order.status} · ${props.order.time}`"/></Stack>
    <template #footer><Button label="关闭" @press="emit('update:open', false)"/><Button v-if="props.order?.status === '异常'" variant="glassProminent" label="追踪异常" @press="props.order && emit('trace', props.order)"/><Button v-else-if="props.order?.status !== '已发货'" variant="glassProminent" label="标记已发货" @press="props.order && emit('ship', props.order)"/></template>
  </Dialog>
</template>
