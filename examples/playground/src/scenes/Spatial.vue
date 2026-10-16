<script setup lang="ts">
// The spatial scene (`?scene=spatial`): a sketch until Task 19 rebuilds the full flow with real controls. Three Blocks
// stand on the Space's arc; clicking an unfocused one focuses it (the camera springs to it, the keys go to it). The
// landing Block's last Card holds a 3D bar chart, its bars growing out of the Card's glass.
// `?focus=<name>` picks the first focus (default login).
import { ref } from 'vue'
import { BarChart3D, Block, Card, Space, Stack, Text } from '@glassui/vue'
import { ARC } from './spatial-arc'

const props = defineProps<{ initialFocus?: string }>()
const focus = ref(props.initialFocus ?? 'login')

const stats = [
  { title: '本周活跃', value: '1,284', note: '比上周 +12%' },
  { title: '完成任务', value: '36', note: '还剩 8 项' },
  { title: '存储用量', value: '68%', note: '共 50 GB' },
]
// the week's daily actives: the busiest day (186) sets the axis at 200 (BarChart3D rounds the max up to 1/2/5 × 10ⁿ)
const week = [
  { label: '周一', value: 128 }, { label: '周二', value: 164 }, { label: '周三', value: 142 }, { label: '周四', value: 186 },
  { label: '周五', value: 171 }, { label: '周六', value: 96 }, { label: '周日', value: 118 },
]
</script>

<template>
  <Space v-model:focus="focus" :radius="ARC.radius" :gap="ARC.gap">
    <Block name="login" :width="488" :height="560">
      <Text value="登录" size="3xl" :weight="700" />
      <Text value="邮箱 name@example.com" color="secondaryLabel" />
      <Text value="密码 ••••••••" color="secondaryLabel" />
    </Block>

    <Block name="landing" :width="880" :height="700">
      <Text value="欢迎回来" size="3xl" :weight="700" />
      <Stack direction="horizontal" :gap="16">
        <Card v-for="s in stats" :key="s.title" :title="s.title" :style="{ flexGrow: 1, flexBasis: 0 }">
          <Text :value="s.value" size="3xl" :weight="700" />
          <Text :value="s.note" size="sm" color="secondaryLabel" />
        </Card>
      </Stack>
      <Card title="一周活跃">
        <BarChart3D :data="week" />
      </Card>
    </Block>

    <Block name="settings" :width="560" :height="520">
      <Card title="设置">
        <Text value="显示名称 Alex" />
        <Text value="通知 已开启" />
        <Text value="每天 9:00 推送摘要" color="secondaryLabel" />
      </Card>
    </Block>
  </Space>
</template>
