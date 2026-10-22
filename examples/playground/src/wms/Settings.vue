<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Box, Button, Card, Dialog, GlassContainer, Input, Stack, Switch, Text, useRoot } from '@glassui/vue'
import Breadcrumb from './Breadcrumb.vue'
import { useSpatialLocale } from './locale'
const { locale, t } = useSpatialLocale()
const emit = defineEmits<{ navigate: [name: null]; logout: [] }>()
const root = useRoot(), reduced = ref(root.anim?.reducedMotion ?? false), tier = ref(root.quality?.tier ?? 'high'), logout = ref(false), password = ref(false), alerts = ref([true, true, false]), displayName = ref(t('王敏'))
watch(locale, () => { if (displayName.value === '王敏' || displayName.value === 'Min Wang') displayName.value = t('王敏') })
const updateQuality = () => { tier.value = root.quality.tier }
let stopQuality: (() => void) | undefined
onMounted(() => { if (root.quality && root.on) stopQuality = root.on('quality', updateQuality) })
onBeforeUnmount(() => stopQuality?.())
</script>

<template>
  <Stack :gap="18">
    <Stack :gap="5">
      <Breadcrumb id="crumb-overview-settings" :title="t('设置')" @navigate="emit('navigate', null)" />
      <Text :value="t('设置')" :size="34" :weight="700" />
      <Text :value="t('管理仓库提醒、显示效果与当前账户。')" :size="16" color="secondaryLabel" />
    </Stack>

    <Card :style="{ gap: 14, padding: 20, flexShrink: 0 }">
      <Stack :gap="3"><Text :value="t('工作提醒')" :size="21" :weight="650"/><Text :value="t('选择需要及时处理的仓储事件。')" :size="15" color="secondaryLabel"/></Stack>
      <Stack direction="horizontal" justify="between" align="center"><Text :value="t('逾期提醒')" :size="18"/><Switch id="settings-alert-overdue" v-model:checked="alerts[0]"/></Stack>
      <Box :style="{ height: 1, bg: 'separator' }" />
      <Stack direction="horizontal" justify="between" align="center"><Text :value="t('低库存预警')" :size="18"/><Switch id="settings-alert-stock" v-model:checked="alerts[1]"/></Stack>
      <Box :style="{ height: 1, bg: 'separator' }" />
      <Stack direction="horizontal" justify="between" align="center"><Text :value="t('每日报表邮件')" :size="18"/><Switch id="settings-alert-report" v-model:checked="alerts[2]"/></Stack>
    </Card>

    <Card :style="{ gap: 14, padding: 20, flexShrink: 0 }">
      <Stack :gap="3"><Text :value="t('显示效果')" :size="21" :weight="650"/><Text :value="t('调整动态效果与玻璃界面的渲染质量。')" :size="15" color="secondaryLabel"/></Stack>
      <Stack direction="horizontal" justify="between" align="center"><Stack :gap="2"><Text :value="t('减少动态效果')" :size="18"/><Text :value="t('关闭视差与背景动画')" :size="14" color="secondaryLabel"/></Stack><Switch id="settings-reduced-motion" v-model:checked="reduced" @update:checked="root.anim && (root.anim.reducedMotion = $event)"/></Stack>
      <Stack direction="horizontal" justify="between" align="center">
        <Text :value="`${t('渲染质量')} · ${t(tier === 'high' ? '高' : tier === 'medium' ? '中' : '低')}`" :size="17" color="secondaryLabel"/>
        <GlassContainer><Button v-for="q in ['high','medium','low'] as const" :key="q" :label="t(q === 'high' ? '高' : q === 'medium' ? '中' : '低')" :variant="tier === q ? 'glassProminent' : 'glass'" @press="root.quality?.set(q)"/></GlassContainer>
      </Stack>
    </Card>

    <Card :style="{ gap: 14, padding: 20, flexShrink: 0 }">
      <Stack :gap="3"><Text :value="t('账户')" :size="21" :weight="650"/><Text :value="t('更新当前用户的显示名称或登录状态。')" :size="15" color="secondaryLabel"/></Stack>
      <Stack direction="horizontal" align="center" :gap="12">
        <Input v-model="displayName" :placeholder="t('显示名称')"/>
        <Button :label="t('修改密码')" @press="password = true"/>
        <Button id="settings-logout" variant="glass" leading-icon="logout" :label="t('退出登录')" @press="logout = true"/>
      </Stack>
    </Card>

    <Dialog v-model:open="password" :title="t('修改密码')"><Input type="password" :placeholder="t('新密码')"/><Input type="password" :placeholder="t('确认新密码')"/><template #footer><Button :label="t('取消')" @press="password = false"/><Button variant="glassProminent" :label="t('保存')" @press="password = false"/></template></Dialog>
    <Dialog v-model:open="logout" :title="t('退出登录')" @close="logout = false"><Text :value="t('退出后将返回登录界面。')"/><template #footer><Button :label="t('取消')" @press="logout = false"/><Button id="logout-confirm" variant="glassProminent" :label="t('退出登录')" @press="logout = false; emit('logout')"/></template></Dialog>
  </Stack>
</template>
