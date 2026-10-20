<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Button, GlassContainer, GlassTransition, Surface } from '@glassui/vue'
const props = defineProps<{ current: string | null }>()
const emit = defineEmits<{ go: [name: string | null] }>()
const items = [
  { name: null, label: '总览', icon: 'grid' }, { name: 'orders', label: '订单', icon: 'list' }, { name: 'dashboard', label: '运营看板', icon: 'chart' },
  { name: 'network', label: '物流网络', icon: 'map' }, { name: 'inbound', label: '入库作业', icon: 'inbox' }, { name: 'twin', label: '仓储孪生', icon: 'cube' }, { name: 'settings', label: '设置', icon: 'gear' },
] as const
const size = ref({ width: typeof innerWidth === 'number' ? innerWidth : 1280, height: typeof innerHeight === 'number' ? innerHeight : 900 })
const resize = () => { size.value = { width: innerWidth, height: innerHeight } }
onMounted(() => { if (typeof addEventListener !== 'undefined') addEventListener('resize', resize) }); onBeforeUnmount(() => { if (typeof removeEventListener !== 'undefined') removeEventListener('resize', resize) })
const left = computed(() => (size.value.width - 7 * 58 - 6 * 8) / 2), top = computed(() => size.value.height - 24 - 64)
</script>
<template>
  <GlassTransition preset="scale">
    <Surface layer="screen" :left="left" :top="top" :width="7 * 58 + 6 * 8" :height="64" background="none">
      <GlassContainer :spacing="16" :gap="8">
        <Button v-for="item in items" :key="item.name === props.current ? `${item.name ?? 'overview'}-on` : (item.name ?? 'overview')" :id="`dock-${item.name ?? 'overview'}`" shape="circle" :leading-icon="item.icon" size="small" :variant="item.name === props.current ? 'glassProminent' : 'glass'" :glass-id="item.name === props.current ? 'dock-active' : undefined" @press="emit('go', item.name)" />
      </GlassContainer>
    </Surface>
  </GlassTransition>
</template>
