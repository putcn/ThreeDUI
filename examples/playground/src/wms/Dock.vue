<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Button, GlassContainer, GlassTransition, Surface } from '@glassui/vue'
import { useSpatialLocale } from './locale'
const props = defineProps<{ current: string | null }>()
const emit = defineEmits<{ go: [name: string | null]; toggleLanguage: [] }>()
const { locale } = useSpatialLocale()
const items = [
  { name: null, label: '总览', icon: 'grid' }, { name: 'orders', label: '订单', icon: 'list' }, { name: 'dashboard', label: '运营看板', icon: 'chart' },
  { name: 'network', label: '物流网络', icon: 'map' }, { name: 'twin', label: '仓储孪生', icon: 'cube' }, { name: 'inventory', label: '库存', icon: 'inbox' }, { name: 'settings', label: '设置', icon: 'gear' },
] as const
const size = ref({ width: typeof innerWidth === 'number' ? innerWidth : 1280, height: typeof innerHeight === 'number' ? innerHeight : 900 })
const resize = () => { size.value = { width: innerWidth, height: innerHeight } }
onMounted(() => { if (typeof addEventListener !== 'undefined') addEventListener('resize', resize) }); onBeforeUnmount(() => { if (typeof removeEventListener !== 'undefined') removeEventListener('resize', resize) })
const iconWidth = computed(() => Math.min(58, Math.max(36, (size.value.width - 24 - 72 - items.length * 8) / items.length)))
const width = computed(() => items.length * iconWidth.value + items.length * 8 + 72)
const left = computed(() => (size.value.width - width.value) / 2), top = computed(() => size.value.height - 8 - 48)
</script>
<template>
  <GlassTransition preset="scale">
    <Surface layer="screen" :left="left" :top="top" :width="width" :height="48" background="none">
      <GlassContainer :spacing="16" :gap="8">
        <Button v-for="item in items" :key="item.name === props.current ? `${item.name ?? 'overview'}-on` : (item.name ?? 'overview')" :id="`dock-${item.name ?? 'overview'}`" shape="circle" :leading-icon="item.icon" size="small" :variant="item.name === props.current ? 'glassProminent' : 'glass'" :glass-id="item.name === props.current ? 'dock-active' : undefined" :style="{ width: iconWidth }" @press="emit('go', item.name)" />
        <Button id="spatial-language" size="small" variant="glass" :label="locale === 'zh' ? 'EN' : '中文'" :style="{ width: 72 }" @press="emit('toggleLanguage')" />
      </GlassContainer>
    </Surface>
  </GlassTransition>
</template>
