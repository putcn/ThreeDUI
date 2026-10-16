<script setup lang="ts">
// The spatial scene (`?scene=spatial`): a sketch until Task 19 rebuilds the full flow with real controls. Three Blocks
// stand on the Space's arc; clicking an unfocused one focuses it (the camera springs to it, the keys go to it).
// `?focus=<name>` picks the first focus (default login).
import { ref } from 'vue'
import { Block, Card, Space, Stack, Text } from '@glassui/vue'

const props = defineProps<{ initialFocus?: string }>()
const focus = ref(props.initialFocus ?? 'login')

const stats = [
  { title: '本周活跃', value: '1,284', note: '比上周 +12%' },
  { title: '完成任务', value: '36', note: '还剩 8 项' },
  { title: '存储用量', value: '68%', note: '共 50 GB' },
]
</script>

<template>
  <Space v-model:focus="focus">
    <Block name="login" :width="488" :height="560">
      <Text value="登录" size="3xl" :weight="700" />
      <Text value="邮箱 name@example.com" color="secondaryLabel" />
      <Text value="密码 ••••••••" color="secondaryLabel" />
    </Block>

    <Block name="landing" :width="880" :height="620">
      <Text value="欢迎回来" size="3xl" :weight="700" />
      <!-- concentric: the Cards' radius resolves against their parent's, so the row passes the Block's on -->
      <Stack direction="horizontal" :gap="16" :style="{ radius: 'concentric' }">
        <Card v-for="s in stats" :key="s.title" :title="s.title" :style="{ flexGrow: 1, flexBasis: 0 }">
          <Text :value="s.value" size="3xl" :weight="700" />
          <Text :value="s.note" size="sm" color="secondaryLabel" />
        </Card>
      </Stack>
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
