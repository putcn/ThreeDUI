<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Surface } from '@glassui/vue'
import SignUpForm from './SignUpForm.vue'
const props = defineProps<{ viewport?: { width: number; height: number } }>()
const viewport = ref(props.viewport ?? { width: typeof innerWidth === 'number' ? innerWidth : 1280, height: typeof innerHeight === 'number' ? innerHeight : 900 })
const resize = () => { viewport.value = { width: innerWidth, height: innerHeight } }
onMounted(() => { if (typeof addEventListener !== 'undefined') addEventListener('resize', resize) })
onBeforeUnmount(() => { if (typeof removeEventListener !== 'undefined') removeEventListener('resize', resize) })
const scale = computed(() => Math.max(0.1, Math.min(1, (viewport.value.height - 40) / 1045, (viewport.value.width - 40) / 885)))
</script>
<template>
  <Surface layer="screen" center :width="885" :height="1045" background="glass" :radius="48" :scale="scale"><SignUpForm /></Surface>
</template>
