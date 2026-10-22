<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { GlassTransition, Surface, useRoot } from '@glassui/vue'
import SignUpForm from '../scenes/SignUpForm.vue'
import { DEMO_LOGIN, validateLogin } from './forms'
import { loginScale, loginTilt } from './login-motion'
import { useSpatialLocale } from './locale'
const emit = defineEmits<{ success: []; toggleLanguage: [] }>()
const { t } = useSpatialLocale()
const root = useRoot()
const viewport = ref({ width: typeof innerWidth === 'number' ? innerWidth : 1280, height: typeof innerHeight === 'number' ? innerHeight : 900 })
const tilt = ref<[number, number, number]>([0, 0, 0])
const resize = () => { viewport.value = { width: innerWidth, height: innerHeight } }
const move = (event: PointerEvent) => {
  if (event.pointerType !== 'mouse' || root.anim.reducedMotion || (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)) { tilt.value = [0, 0, 0]; return }
  tilt.value = loginTilt(event.clientX / viewport.value.width * 2 - 1, event.clientY / viewport.value.height * 2 - 1)
}
onMounted(() => { addEventListener('resize', resize); addEventListener('pointermove', move, { passive: true }) })
onBeforeUnmount(() => { removeEventListener('resize', resize); removeEventListener('pointermove', move); clearTimeout(timer) })
const scale = computed(() => loginScale(viewport.value.width, viewport.value.height))
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
    <Surface layer="screen" center :width="885" :height="560" background="glass" :radius="40" :scale="scale" :rotation="tilt">
      <SignUpForm mode="login" :initial-email="DEMO_LOGIN.email" :initial-password="DEMO_LOGIN.password" :loading="loading" :errors="errors" submit-id="login-submit" :submit-label="t('登录')" @submit="submit" @toggle-language="emit('toggleLanguage')" />
    </Surface>
  </GlassTransition>
</template>
