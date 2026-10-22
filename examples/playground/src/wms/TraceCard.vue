<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { Box, Button, Stack, Text, useMotion, useRoot, useScheme, useSurfaceRef } from '@glassui/vue'
import type { ArcSlot } from '@glassui/vue'
import type { Order } from './data'
import { SHORT_PICK } from './data'
import { useSpatialLocale } from './locale'

const props = defineProps<{ order: Order; step: 'orders' | 'network' | 'twin'; target: ArcSlot }>()
const { locale, t } = useSpatialLocale()
const emit = defineEmits<{ next: []; close: [] }>()
const surface = useSurfaceRef(), frozen = useMotion() === 'frozen'
const root = useRoot(), scheme = useScheme()
const veil = computed(() => {
  const fill = root.theme.colors[scheme.value].fill ?? '#ffffff'
  return /^#[0-9a-f]{6}$/i.test(fill) ? `${fill}e0` : fill
})
const stepText = computed(() => t(props.step === 'orders' ? '订单异常' : props.step === 'network' ? '关联路线' : '异常库位'))
const detail = computed(() => props.step === 'orders'
  ? locale.value === 'zh' ? `应拣 ${SHORT_PICK.wanted} 件，库位 ${SHORT_PICK.bin} 实际 ${SHORT_PICK.qty} 件。` : `Pick requires ${SHORT_PICK.wanted} units; bin ${SHORT_PICK.bin} has ${SHORT_PICK.qty}.`
  : props.step === 'network'
    ? t('一条进入徐州一号仓的补货线路已逾期，可继续排查库位。')
    : locale.value === 'zh' ? `${SHORT_PICK.bin} 当前 ${SHORT_PICK.qty} 件，少于订单所需 ${SHORT_PICK.wanted} 件。` : `${SHORT_PICK.bin} has ${SHORT_PICK.qty} units, below the ${SHORT_PICK.wanted} needed for this order.`)
const action = computed(() => t(props.step === 'orders' ? '查看关联路线' : props.step === 'network' ? '定位异常库位' : '返回订单'))

onMounted(() => {
  const s = surface.value
  if (!s) return
  s.opacity = 0
  s.scale.setScalar(0.94)
  void s.animateTo({ position: [...props.target.position], rotation: [...props.target.rotation], opacity: 1, scale: 1 }, { spring: { response: 0.4, dampingFraction: 0.9 }, immediate: frozen })
})
watch(() => props.target, target => {
  const s = surface.value
  if (s) void s.animateTo({ position: [...target.position], rotation: [...target.rotation] }, { spring: { response: 0.55, dampingFraction: 0.92 }, immediate: frozen })
}, { flush: 'post' })
</script>

<template>
  <Stack :gap="10" :style="{ margin: 7, flexGrow: 1, radius: 21, bg: veil, paddingX: 15, paddingY: 12 }">
    <Stack direction="horizontal" justify="between" align="center">
      <Stack direction="horizontal" align="center" :gap="7">
        <Box :style="{ width: 8, height: 8, radius: 4, bg: 'danger' }" />
        <Text :value="stepText" :size="13" :weight="700" color="danger" />
      </Stack>
      <Button id="trace-close" shape="circle" size="small" leading-icon="x" variant="glass" @press="emit('close')" />
    </Stack>
    <Text :value="props.order.no" :size="21" :weight="700" :wrap="false" :style="{ font: 'Menlo' }" />
    <Text :value="detail" :size="13" color="secondaryLabel" :max-lines="2" />
    <Stack direction="horizontal" justify="end"><Button id="trace-next" variant="glassProminent" size="small" :label="action" @press="emit('next')" /></Stack>
  </Stack>
</template>
