<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { GlassTransition, Surface } from '@glassui/vue'
import SignUpForm from '../scenes/SignUpForm.vue'
import { validateLogin } from './forms'
const emit = defineEmits<{ success: [] }>()
const viewport = ref({ width: typeof innerWidth === 'number' ? innerWidth : 1280, height: typeof innerHeight === 'number' ? innerHeight : 900 })
const resize = () => { viewport.value = { width: innerWidth, height: innerHeight } }
onMounted(() => addEventListener('resize', resize)); onBeforeUnmount(() => { removeEventListener('resize', resize); clearTimeout(timer) })
const scale = computed(() => Math.max(0.1, Math.min(1, (viewport.value.height - 40) / 1045, (viewport.value.width - 40) / 885)))
const errors = ref<{ email?: string; password?: string }>({}), loading = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
function submit(value: { email: string; password: string }): void {
  errors.value = validateLogin(value)
  if (Object.keys(errors.value).length) return
  loading.value = true
  clearTimeout(timer)
  timer = setTimeout(() => { loading.value = false; emit('success') }, 800)
}
</script>
<template>
  <GlassTransition preset="scale">
    <Surface layer="screen" center :width="885" :height="1045" background="glass" :radius="48" :scale="scale">
      <SignUpForm mode="login" :loading="loading" :errors="errors" submit-id="login-submit" submit-label="登录" @submit="submit" />
    </Surface>
  </GlassTransition>
</template>
