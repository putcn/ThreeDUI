<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Surface } from '@glassui/vue'
import SignUpForm from './SignUpForm.vue'
const props = defineProps<{ viewport?: { width: number; height: number }; inspect?: boolean }>()
const viewport = ref(props.viewport ?? { width: typeof innerWidth === 'number' ? innerWidth : 1280, height: typeof innerHeight === 'number' ? innerHeight : 900 })
const resize = () => { viewport.value = { width: innerWidth, height: innerHeight } }
onMounted(() => { if (typeof addEventListener !== 'undefined') addEventListener('resize', resize) })
onBeforeUnmount(() => { if (typeof removeEventListener !== 'undefined') removeEventListener('resize', resize) })
const scale = computed(() => Math.max(0.1, Math.min(1, (viewport.value.height - 40) / 1045, (viewport.value.width - 40) / 885)))
// The standalone demo puts the glass in the world, preserving the screen form's initial front-view size. At that
// camera distance, ptPerUnit converts the desired CSS-pixel height to world units; resizing retains the same fit.
const cameraDistance = Math.hypot(0.6, 7.3)
const worldPtPerUnit = computed(() => viewport.value.height / (2 * cameraDistance * Math.tan(38 * Math.PI / 360) * scale.value))
const worldCenter: [number, number, number] = [0, -0.05, 0]
</script>
<template>
  <Surface :layer="inspect ? 'world' : 'screen'" :center="!inspect" :position="inspect ? worldCenter : undefined" :pt-per-unit="inspect ? worldPtPerUnit : undefined" :width="885" :height="1045" background="glass" :radius="48" :scale="inspect ? 1 : scale"><SignUpForm /></Surface>
</template>
