<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Button, Checkbox, Dialog, GlassContainer, Input, Stack, Switch, Text, useRoot } from '@glassui/vue'
import Breadcrumb from './Breadcrumb.vue'
const emit = defineEmits<{ navigate: [name: null]; logout: [] }>()
const root = useRoot(), reduced = ref(root.anim?.reducedMotion ?? false), tier = ref(root.quality?.tier ?? 'high'), logout = ref(false), password = ref(false), alerts = ref([true, true, false]), displayName = ref('王敏')
const updateQuality = () => { tier.value = root.quality.tier }
let stopQuality: (() => void) | undefined
onMounted(() => { if (root.quality && root.on) stopQuality = root.on('quality', updateQuality) }); onBeforeUnmount(() => stopQuality?.())
</script>
<template>
  <Stack :gap="24">
    <Stack :gap="8"><Breadcrumb title="设置" @navigate="emit('navigate', null)"/><Text value="设置" :size="28" :weight="700"/></Stack>
    <Stack :gap="12"><Text value="通知" :weight="600"/><Switch v-model:checked="alerts[0]" label="逾期提醒"/><Switch v-model:checked="alerts[1]" label="低库存预警"/><Switch v-model:checked="alerts[2]" label="每日报表邮件"/></Stack>
    <Stack :gap="12"><Text value="显示" :weight="600"/><Switch v-model:checked="reduced" label="减少动态效果" @update:checked="root.anim && (root.anim.reducedMotion = $event)"/><Text :value="`画质：${tier}`"/><GlassContainer><Button v-for="q in ['high','medium','low'] as const" :key="q" :label="{high:'高',medium:'中',low:'低'}[q]" :variant="tier === q ? 'glassProminent' : 'glass'" @press="root.quality?.set(q)"/></GlassContainer></Stack>
    <Stack :gap="12"><Text value="账户" :weight="600"/><Input v-model="displayName" placeholder="显示名"/><Button label="修改密码" @press="password = true"/><Button id="settings-logout" variant="glass" leading-icon="logout" label="退出登录" @press="logout = true"/></Stack>
    <Dialog v-model:open="password" title="修改密码"><Input type="password" placeholder="新密码"/><Input type="password" placeholder="确认新密码"/><template #footer><Button label="取消" @press="password = false"/><Button variant="glassProminent" label="保存" @press="password = false"/></template></Dialog>
    <Dialog v-model:open="logout" title="退出登录" @close="logout = false"><Text value="退出后将返回登录界面。"/><template #footer><Button label="取消" @press="logout = false"/><Button id="logout-confirm" variant="glassProminent" label="退出登录" @press="logout = false; emit('logout')"/></template></Dialog>
  </Stack>
</template>
