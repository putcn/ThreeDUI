<script setup lang="ts">
// The component gallery (`?scene=gallery`): every @glassui/vue component, section by section. Content only, so no
// glass here (spec §8.3: glass on controls, never on content areas); later sections add the controls.
import { computed, h, type FunctionalComponent } from 'vue'
import { Box, Icon, ICON_NAMES, Stack, Text, useScheme } from '@glassui/vue'

// The wall is vivid and darkens toward the lower left: a light veil (a dark one in the dark scheme) keeps every line
// readable while the wall's colour still shows through, for the glass of later sections to refract.
const scheme = useScheme()
const veil = computed(() => scheme.value === 'dark' ? '#16161ab3' : '#fbfaf88c')

/** A small spaced caption over each group. */
const Caption: FunctionalComponent<{ value: string }> = p => h(Text, { value: p.value, size: 12, weight: 600, color: 'secondaryLabel', style: { letterSpacing: 1.4 } })

const ramp = [
  { token: '4xl', weight: 700, text: '玻璃 Liquid Glass' },
  { token: '2xl', weight: 600, text: '清透、有深度的界面' },
  { token: 'xl', weight: 600, text: 'Headline 标题' },
  { token: 'base', weight: 400, text: '正文 Body：中文与 Latin 混排，系统字体回退。' },
  { token: 'sm', weight: 400, text: '说明 Caption · 次要信息', color: 'secondaryLabel' },
  { token: 'xs', weight: 500, text: '脚注 FOOTNOTE · 12 PT', color: 'tertiaryLabel' },
] as const
const colors = [
  { token: 'accent', label: '强调 accent' }, { token: 'success', label: '成功 success' }, { token: 'danger', label: '危险 danger' },
  { token: 'label', label: '标签 label' }, { token: 'secondaryLabel', label: '次要 secondaryLabel' }, { token: 'tertiaryLabel', label: '三级 tertiaryLabel' },
] as const
const tile = { padding: 16, radius: 16, border: { width: 1, color: 'separator' }, flexGrow: 1, flexBasis: 0 }
const tint = (a: number) => ({ width: 36, height: 36, radius: 10, bg: 'accent', opacity: a })
</script>

<template>
  <Box id="gallery" :style="{ width: '100%', height: '100%', bg: veil, paddingX: 64, paddingTop: 44, paddingBottom: 40, gap: 32 }">
    <Stack :gap="6">
      <Text value="GLASSUI · @glassui/vue" :size="12" :weight="600" color="accent" :style="{ letterSpacing: 1.6 }" />
      <Text value="组件画廊 Gallery" size="3xl" :weight="700" />
      <Text value="这里的每一行文字、每个图标和每一处布局，都由 Vue 组件渲染进 three.js 场景里的 Surface。" color="secondaryLabel" />
    </Stack>

    <Stack id="primitives" :gap="24">
      <Stack :gap="12">
        <Stack direction="horizontal" justify="between" align="end">
          <Text value="Primitives" size="xl" :weight="700" />
          <!-- bottom-aligned line boxes: lifted 3 pt so the two baselines meet -->
          <Text value="基础元件 · Box · Text · Icon · Stack" size="sm" color="secondaryLabel" :style="{ marginBottom: 3 }" />
        </Stack>
        <Box :style="{ height: 1, bg: 'separator' }" />
      </Stack>

      <Stack direction="horizontal" :gap="56">
        <Stack id="text-ramp" :gap="8" :style="{ width: 480, flexShrink: 0 }">
          <Caption value="文字 TEXT" />
          <Box v-for="r in ramp" :key="r.token" tw="flex-row items-center">
            <Text :value="r.token" :size="12" color="tertiaryLabel" :style="{ width: 44 }" />
            <Text :value="r.text" :size="r.token" :weight="r.weight" :color="'color' in r ? r.color : undefined" />
          </Box>
        </Stack>

        <Stack :gap="12" :style="{ flexGrow: 1, flexShrink: 1 }">
          <Caption value="颜色 COLOR" />
          <Stack direction="horizontal" :gap="10" wrap>
            <Stack v-for="c in colors" :key="c.token" direction="horizontal" :gap="8" align="center" :style="{ width: 196 }">
              <Box :style="{ width: 10, height: 10, radius: 'capsule', bg: c.token }" />
              <Text :value="c.label" :color="c.token" :weight="600" size="sm" />
            </Stack>
          </Stack>
          <Box :style="{ height: 8 }" />
          <Caption value="片段 FRAGMENTS" />
          <Text :value="[{ text: '已有账号？' }, { text: '登录', color: 'accent', weight: 600 }]" />
          <Text :value="[{ text: '状态 ', color: 'secondaryLabel' }, { text: '● 在线', color: 'success', weight: 600 }, { text: '  ·  ', color: 'tertiaryLabel' }, { text: '3 条新消息', weight: 600 }]" />
          <Box :style="{ height: 8 }" />
          <Caption value="截断 MAX LINES 2" />
          <Text :max-lines="2" color="secondaryLabel" :style="{ maxWidth: 520 }" value="Liquid Glass 是一种会折射、反射周围内容的半透明材质：控件浮在内容之上，又与内容融为一体。光线穿过它的边缘时会弯折、分出淡淡的色散；超出两行的文字在这里以省略号截断。" />
        </Stack>
      </Stack>

      <Stack id="icons" :gap="14">
        <Caption value="图标 ICON · 22 个内置" />
        <Stack direction="horizontal" :gap="22" align="center" wrap>
          <Icon v-for="n in ICON_NAMES" :key="n" :name="n" :size="28" />
        </Stack>
        <Stack direction="horizontal" :gap="40" align="end">
          <Stack :gap="8">
            <Stack direction="horizontal" :gap="14" align="end">
              <Icon v-for="s in [16, 20, 24, 32, 40]" :key="s" name="check" :size="s" color="accent" />
            </Stack>
            <Text value="尺寸 size 16–40" :size="12" color="secondaryLabel" />
          </Stack>
          <Stack :gap="8">
            <Stack direction="horizontal" :gap="14" align="center">
              <Icon v-for="c in ['accent', 'success', 'danger', 'secondaryLabel', '#ff9f0a']" :key="c" name="star" :size="28" :color="c" />
            </Stack>
            <Text value="颜色 token 或 #hex" :size="12" color="secondaryLabel" />
          </Stack>
          <Stack :gap="8">
            <Stack direction="horizontal" :gap="14" align="center">
              <Icon v-for="w in [0.06, 0.08, 0.1, 0.13]" :key="w" name="heart" :size="28" :weight="w" />
            </Stack>
            <Text value="描边 weight 0.06–0.13" :size="12" color="secondaryLabel" />
          </Stack>
        </Stack>
      </Stack>

      <Stack id="stacks" :gap="14">
        <Caption value="布局 STACK" />
        <Stack direction="horizontal" :gap="16" align="stretch">
          <Stack justify="between" :gap="12" :style="tile">
            <Stack direction="horizontal" :gap="8">
              <Box :style="tint(1)" /><Box :style="tint(0.6)" /><Box :style="tint(0.3)" />
            </Stack>
            <Text value="horizontal · gap 8" :size="12" color="secondaryLabel" />
          </Stack>
          <Stack justify="between" :gap="12" :style="tile">
            <Stack :gap="6">
              <Box v-for="w in [120, 88, 56]" :key="w" :style="{ width: w, height: 10, radius: 'capsule', bg: 'accent', opacity: 0.25 + w / 160 }" />
            </Stack>
            <Text value="vertical · gap 6" :size="12" color="secondaryLabel" />
          </Stack>
          <Stack justify="between" :gap="12" :style="tile">
            <Stack direction="z" align="center" justify="center" :style="{ width: 56, height: 56 }">
              <Box tw="w-full h-full" :style="{ bg: 'accent', radius: 16 }" />
              <Icon name="star" :size="28" color="#ffffff" />
            </Stack>
            <Text value="z · 叠放" :size="12" color="secondaryLabel" />
          </Stack>
          <Stack justify="between" :gap="12" :style="tile">
            <Stack direction="horizontal" justify="between" align="center" :style="{ height: 36 }">
              <Box v-for="i in 3" :key="i" :style="{ width: 14, height: 14, radius: 'capsule', bg: 'accent' }" />
            </Stack>
            <Text value="justify between" :size="12" color="secondaryLabel" />
          </Stack>
          <Stack justify="between" :gap="12" :style="tile">
            <Stack direction="horizontal" :gap="6" align="center" :style="{ height: 56 }">
              <Box v-for="hh in [24, 44, 32, 56, 18]" :key="hh" :style="{ width: 12, height: hh, radius: 'capsule', bg: 'accent', opacity: 0.75 }" />
            </Stack>
            <Text value="align center" :size="12" color="secondaryLabel" />
          </Stack>
          <Stack justify="between" :gap="12" :style="tile">
            <Stack direction="horizontal" :gap="6" wrap>
              <Box v-for="t in ['玻璃', 'Glass', '折射', 'Refraction', '高光']" :key="t" :style="{ paddingX: 10, paddingY: 3, radius: 'capsule', bg: '#6b63f524' }">
                <Text :value="t" :size="13" color="accent" :weight="500" />
              </Box>
            </Stack>
            <Text value="wrap" :size="12" color="secondaryLabel" />
          </Stack>
        </Stack>
      </Stack>
    </Stack>
  </Box>
</template>
