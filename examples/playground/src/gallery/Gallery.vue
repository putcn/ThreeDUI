<script setup lang="ts">
// Six navigable Blocks on one arc; all controls remain real Vue components.
import { computed, h, onBeforeUnmount, ref, type FunctionalComponent } from 'vue'
import { Box, Button, Checkbox, Dialog, GlassContainer, Icon, ICON_NAMES, Input, Stack, Block, Space, Switch, Text, useScheme } from '@glassui/vue'
import { setDemoLocale, type DemoLocale } from '../demo-locale'

const scheme = useScheme()
/** The wrap tile's chip fill: the scheme's accent (theme `accent`) at low alpha; a little more under the pointer. */
const chip = computed(() => scheme.value === 'dark' ? '#8a83ff33' : '#6b63f524')
const sections = ['primitives', 'buttons', 'toggles', 'inputs', 'dialog', 'containers'] as const
const props = defineProps<{ initialFocus?: string; initialLocale?: DemoLocale; onNavigate?: (section: string) => void }>()
const focus = ref(sections.find(s => s === props.initialFocus) ?? 'primitives')
const navigate = (section: (typeof sections)[number]) => { if (section !== focus.value) { focus.value = section; props.onNavigate?.(section) } }
const locale = ref<DemoLocale>(props.initialLocale ?? 'en')
const tr = (zh: string, en: string) => locale.value === 'zh' ? zh : en
const sectionNames: Record<(typeof sections)[number], { zh: string; en: string }> = {
  primitives: { zh: '基础元件', en: 'Primitives' }, buttons: { zh: '按钮', en: 'Buttons' },
  toggles: { zh: '开关', en: 'Toggles' }, inputs: { zh: '输入框', en: 'Inputs' },
  dialog: { zh: '对话框', en: 'Dialog' }, containers: { zh: '玻璃容器', en: 'Glass container' },
}
const sectionLabel = (section: (typeof sections)[number]) => sectionNames[section][locale.value]
const toggleLocale = () => {
  const next = locale.value === 'zh' ? 'en' : 'zh'
  if (city.value === (locale.value === 'zh' ? '杭州市西湖区文三路 90 号' : '90 Wensan Road, Hangzhou')) city.value = next === 'zh' ? '杭州市西湖区文三路 90 号' : '90 Wensan Road, Hangzhou'
  if (query.value === (locale.value === 'zh' ? '液态玻璃' : 'Liquid Glass')) query.value = next === 'zh' ? '液态玻璃' : 'Liquid Glass'
  if (project.value === (locale.value === 'zh' ? '玻璃界面实验室' : 'Glass Interface Lab')) project.value = next === 'zh' ? '玻璃界面实验室' : 'Glass Interface Lab'
  outcome.value = ''
  locale.value = next
  setDemoLocale(next)
}

/** A small spaced caption over each group. */
const Caption: FunctionalComponent<{ value: string }> = p => h(Text, { value: p.value, size: 12, weight: 600, color: 'secondaryLabel', style: { letterSpacing: 1.4 } })
/** A row's caption at its left, one line (the longest, GLASS PROMINENT · 主操作, is ≈ 190 pt). */
const RowCaption: FunctionalComponent<{ value: string }> = p => h(Text, { value: p.value, size: 12, weight: 600, color: 'secondaryLabel', wrap: false, style: { width: 224, flexShrink: 0, letterSpacing: 1 } })

const ramp = computed(() => [
  { token: '4xl', weight: 700, text: tr('玻璃 Liquid Glass', 'Liquid Glass') },
  { token: '2xl', weight: 600, text: tr('清透、有深度的界面', 'Clear interfaces with depth') },
  { token: 'xl', weight: 600, text: tr('Headline 标题', 'Headline') },
  { token: 'base', weight: 400, text: tr('正文 Body：中文与 Latin 混排，系统字体回退。', 'Body text: Latin and Chinese with system font fallback.') },
  { token: 'sm', weight: 400, text: tr('说明 Caption · 次要信息', 'Caption · secondary information'), color: 'secondaryLabel' },
  { token: 'xs', weight: 500, text: tr('脚注 FOOTNOTE · 12 PT', 'Footnote · 12 pt'), color: 'tertiaryLabel' },
] as const)
const colors = computed(() => [
  { token: 'accent', label: tr('强调 accent', 'Accent') }, { token: 'success', label: tr('成功 success', 'Success') }, { token: 'danger', label: tr('危险 danger', 'Danger') },
  { token: 'label', label: tr('标签 label', 'Label') }, { token: 'secondaryLabel', label: tr('次要 secondaryLabel', 'Secondary label') }, { token: 'tertiaryLabel', label: tr('三级 tertiaryLabel', 'Tertiary label') },
] as const)
const wrapLabels = computed(() => locale.value === 'zh' ? ['玻璃', 'Glass', '折射', 'Refraction', '高光'] : ['Glass', 'Refraction', 'Highlights', 'Depth', 'Shadows'])
const tile = { padding: 16, radius: 16, border: { width: 1, color: 'separator' }, flexGrow: 1, flexBasis: 0 }
const tint = (a: number) => ({ width: 36, height: 36, radius: 10, bg: 'accent', opacity: a })

/** The Buttons section: each variant in the three sizes (small, regular, large), its labels growing with the size. */
const variants = computed(() => [
  { variant: 'glassProminent', caption: tr('GLASS PROMINENT · 主操作', 'GLASS PROMINENT · primary'), labels: locale.value === 'zh' ? ['确定', '创建账号', '开始免费试用'] : ['Confirm', 'Create account', 'Start free trial'] },
  { variant: 'glass', caption: tr('GLASS · 次要操作', 'GLASS · secondary'), labels: locale.value === 'zh' ? ['取消', '稍后再说', '查看详情'] : ['Cancel', 'Maybe later', 'View details'] },
  { variant: 'filled', caption: tr('FILLED · 实心', 'FILLED · solid'), labels: locale.value === 'zh' ? ['提交', '保存更改', '立即购买'] : ['Submit', 'Save changes', 'Buy now'] },
  { variant: 'tinted', caption: tr('TINTED · 淡底', 'TINTED · subtle'), labels: locale.value === 'zh' ? ['收藏', '加入清单', '订阅更新'] : ['Favorite', 'Add to list', 'Subscribe'] },
  { variant: 'plain', caption: tr('PLAIN · 纯文字', 'PLAIN · text only'), labels: locale.value === 'zh' ? ['编辑', '查看全部', '了解更多'] : ['Edit', 'View all', 'Learn more'] },
] as const)
const sizes = ['small', 'regular', 'large'] as const
/** Presses of the primary action, and the "保存" Button that loads for a moment when pressed. */
const presses = ref(0), saving = ref(false)
let saveTimer: ReturnType<typeof setTimeout> | undefined
const save = () => {
  if (saving.value) return
  saving.value = true
  saveTimer = setTimeout(() => { saving.value = false }, 1600)
}
onBeforeUnmount(() => clearTimeout(saveTimer))

/**
 * The Glass Container section. A toolbar of circle icon Buttons: at gap 8, under its spacing 16, one liquid slab; widened
 * to gap 24 they slide apart (an x spring on each) and the slab pinches into single glass. A swap bar: the star (one
 * glassId) moves between the bar's two ends, growing out of its old place over the others. The dock pattern (Task 19C):
 * the selected item is glowing glass (it stands apart) keyed to re-mount, its glassId moving the highlight.
 */
const toolbar = ['plus', 'minus', 'search', 'heart', 'gear'] as const
const wide = ref(false)
const toolbarGap = computed(() => wide.value ? 24 : 8)
const swapLeft = ref(true), swapMiddle = ['mail', 'search', 'gear'] as const
const tabs = [{ name: 'mail', icon: 'mail' }, { name: 'star', icon: 'star' }, { name: 'heart', icon: 'heart' }, { name: 'user', icon: 'user' }] as const
const tab = ref<(typeof tabs)[number]['name']>('star')

/** The Switch & Checkbox section: every toggle is v-model'd, so each flips when pressed. */
const wifi = ref(true), bluetooth = ref(false), remember = ref(true), notify = ref(false), agree = ref(true), news = ref(false)
/** The reference's pair (the terms checkbox, "Remember me"), with a readout. */
const terms = ref(false), rememberMe = ref(true)
/** "全部通知" over three channels: checked when all are on, a dash when only some are; toggling it sets them all. */
const channels = ref([{ key: 'mail', zh: '邮件', en: 'Email', on: true }, { key: 'sms', zh: '短信', en: 'SMS', on: false }, { key: 'push', zh: '推送', en: 'Push', on: true }])
const allOn = computed(() => channels.value.every(c => c.on))
const someOn = computed(() => !allOn.value && channels.value.some(c => c.on))
const setAll = (on: boolean) => { for (const c of channels.value) c.on = on }

/** The Inputs section: every field is v-model'd; the reference's three report what Enter submitted. */
const nickname = ref(''), city = ref(locale.value === 'zh' ? '杭州市西湖区文三路 90 号' : '90 Wensan Road, Hangzhou'), secret = ref('glass-ui-2026'), qty = ref<number | null>(12)
const query = ref(locale.value === 'zh' ? '液态玻璃' : 'Liquid Glass'), poem = ref('春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。')
const fullName = ref(''), email = ref(''), password = ref(''), submitted = ref('')

/** The Dialog section: renaming the project in a dialog (its field starts from the current name), and how it ended. */
const project = ref(locale.value === 'zh' ? '玻璃界面实验室' : 'Glass Interface Lab'), renaming = ref(false), draft = ref(''), outcome = ref('')
const openRename = () => { draft.value = project.value; renaming.value = true }
const rename = () => {
  const name = draft.value.trim()
  if (!name) return
  project.value = name; outcome.value = tr(`已保存：${name}`, `Saved: ${name}`); renaming.value = false
}
const cancelRename = () => { outcome.value = tr('已取消', 'Cancelled'); renaming.value = false }
</script>

<template>
  <Space v-model:focus="focus" :radius="10" :gap="0.3" :camera="false">
    <Block name="primitives" :width="1440" :height="1000" :style="{ padding: 40, gap: 20, height: 1000 }">
      <Stack direction="horizontal" :gap="10" align="center" :style="{ height: 44, flexShrink: 0 }">
        <Text :value="tr('组件库', 'Gallery')" :size="20" :weight="700" :style="{ marginRight: 16 }" />
        <Button v-for="section in sections" :id="`gallery-primitives-to-${section}`" :key="section" :label="sectionLabel(section)" size="small" :variant="focus === section ? 'glassProminent' : 'glass'" @press="navigate(section)" />
        <Button id="gallery-primitives-language" :label="locale === 'zh' ? 'EN' : '中文'" size="small" variant="plain" @press="toggleLocale" />
      </Stack>
      <scroll id="gallery-primitives-scroll" :style="{ height: 856, flexShrink: 0, overflow: 'scroll' }">
        <Box :style="{ flexShrink: 0, paddingBottom: 32 }">
          <Stack id="primitives" :gap="24">
        <Stack :gap="12">
          <Stack direction="horizontal" justify="between" align="end">
            <Text :value="tr('基础元件', 'Primitives')" size="xl" :weight="700" />
            <!-- bottom-aligned line boxes: lifted 3 pt so the two baselines meet -->
            <Text :value="tr('基础元件 · Box · Text · Icon · Stack', 'Building blocks · Box · Text · Icon · Stack')" size="sm" color="secondaryLabel" :style="{ marginBottom: 3 }" />
          </Stack>
          <Box :style="{ height: 1, bg: 'separator' }" />
        </Stack>

        <Stack direction="horizontal" :gap="56">
          <Stack id="text-ramp" :gap="8" :style="{ width: 480, flexShrink: 0 }">
            <Caption :value="tr('文字 TEXT', 'TEXT · type scale')" />
            <Box v-for="r in ramp" :key="r.token" tw="flex-row items-center">
              <Text :value="r.token" :size="12" color="tertiaryLabel" :style="{ width: 44 }" />
              <Text :value="r.text" :size="r.token" :weight="r.weight" :color="'color' in r ? r.color : undefined" />
            </Box>
          </Stack>

          <Stack :gap="12" :style="{ flexGrow: 1, flexShrink: 1 }">
            <Caption :value="tr('颜色 COLOR', 'COLOR · tokens')" />
            <Stack direction="horizontal" :gap="10" wrap>
              <Stack v-for="c in colors" :key="c.token" direction="horizontal" :gap="8" align="center" :style="{ width: 196 }">
                <Box :style="{ width: 10, height: 10, radius: 'capsule', bg: c.token }" />
                <Text :value="c.label" :color="c.token" :weight="600" size="sm" />
              </Stack>
            </Stack>
            <Box :style="{ height: 8 }" />
            <Caption :value="tr('片段 FRAGMENTS', 'TEXT FRAGMENTS')" />
            <Text :value="[{ text: tr('已有账号？', 'Already have an account?') }, { text: tr('登录', 'Sign in'), color: 'accent', weight: 600 }]" />
            <Text :value="[{ text: tr('状态 ', 'Status '), color: 'secondaryLabel' }, { text: tr('● 在线', '● Online'), color: 'success', weight: 600 }, { text: '  ·  ', color: 'tertiaryLabel' }, { text: tr('3 条新消息', '3 new messages'), weight: 600 }]" />
            <Box :style="{ height: 8 }" />
            <Caption :value="tr('截断 MAX LINES 2', 'TRUNCATION · MAX 2 LINES')" />
            <Text :max-lines="2" color="secondaryLabel" :style="{ maxWidth: 520 }" :value="tr('Liquid Glass 是一种会折射、反射周围内容的半透明材质：控件浮在内容之上，又与内容融为一体。光线穿过它的边缘时会弯折、分出淡淡的色散；超出两行的文字在这里以省略号截断。', 'Liquid Glass is a translucent material that refracts and reflects its surroundings. Controls float above content while remaining part of it. Text past two lines is truncated with an ellipsis.')" />
          </Stack>
        </Stack>

        <Stack id="icons" :gap="14">
          <Caption :value="tr('图标 ICON · 22 个内置', 'ICONS · 22 built in')" />
          <Stack direction="horizontal" :gap="22" align="center" wrap>
            <Icon v-for="n in ICON_NAMES" :key="n" :name="n" :size="28" />
          </Stack>
          <Stack direction="horizontal" :gap="40" align="end">
            <Stack :gap="8">
              <Stack direction="horizontal" :gap="14" align="center" :style="{ height: 40 }">
                <Icon v-for="s in [16, 20, 24, 32, 40]" :key="s" name="check" :size="s" color="accent" />
              </Stack>
              <Text :value="tr('尺寸 size 16–40', 'Size 16–40')" :size="12" color="secondaryLabel" />
            </Stack>
            <Stack :gap="8">
              <Stack direction="horizontal" :gap="14" align="center">
                <Icon v-for="c in ['accent', 'success', 'danger', 'secondaryLabel', '#ff9f0a']" :key="c" name="star" :size="28" :color="c" />
              </Stack>
              <Text :value="tr('颜色 token 或 #hex', 'Color token or #hex')" :size="12" color="secondaryLabel" />
            </Stack>
            <Stack :gap="8">
              <Stack direction="horizontal" :gap="14" align="center">
                <Icon v-for="w in [0.06, 0.08, 0.1, 0.13]" :key="w" name="heart" :size="28" :weight="w" />
              </Stack>
              <Text :value="tr('描边 weight 0.06–0.13', 'Stroke weight 0.06–0.13')" :size="12" color="secondaryLabel" />
            </Stack>
          </Stack>
        </Stack>

        <Stack id="stacks" :gap="14">
          <Caption :value="tr('布局 STACK', 'LAYOUT · STACK')" />
          <!-- two rows of three: the column beside the world panel is too narrow for six in a row -->
          <Stack :gap="16">
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
                <Text :value="tr('z · 叠放', 'z · layered')" :size="12" color="secondaryLabel" />
              </Stack>
            </Stack>
            <Stack direction="horizontal" :gap="16" align="stretch">
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
                  <Box v-for="t in wrapLabels" :key="t" :style="{ paddingX: 10, paddingY: 3, radius: 'capsule', bg: chip }">
                    <Text :value="t" :size="13" color="accent" :weight="500" />
                  </Box>
                </Stack>
                <Text value="wrap" :size="12" color="secondaryLabel" />
              </Stack>
            </Stack>
          </Stack>
        </Stack>
      </Stack>
        </Box>
      </scroll>
    </Block>
    <Block name="buttons" :width="1440" :height="1000" :style="{ padding: 40, gap: 20, height: 1000 }">
      <Stack direction="horizontal" :gap="10" align="center" :style="{ height: 44, flexShrink: 0 }">
        <Text :value="tr('组件库', 'Gallery')" :size="20" :weight="700" :style="{ marginRight: 16 }" />
        <Button v-for="section in sections" :id="`gallery-buttons-to-${section}`" :key="section" :label="sectionLabel(section)" size="small" :variant="focus === section ? 'glassProminent' : 'glass'" @press="navigate(section)" />
        <Button id="gallery-buttons-language" :label="locale === 'zh' ? 'EN' : '中文'" size="small" variant="plain" @press="toggleLocale" />
      </Stack>
      <scroll id="gallery-buttons-scroll" :style="{ height: 856, flexShrink: 0, overflow: 'scroll' }">
        <Box :style="{ flexShrink: 0, paddingBottom: 32 }">
          <Stack id="buttons" :gap="24">
        <Stack :gap="12">
          <Stack direction="horizontal" justify="between" align="end">
            <Text :value="tr('按钮', 'Buttons')" size="xl" :weight="700" />
            <Text :value="tr('按钮 · 五种外观 × 三种尺寸 · 悬停上浮倾斜，按下缩小', 'Five variants × three sizes · hover to lift and tilt, press to shrink')" size="sm" color="secondaryLabel" :style="{ marginBottom: 3 }" />
          </Stack>
          <Box :style="{ height: 1, bg: 'separator' }" />
        </Stack>

        <!-- every variant in every size: glass right on the wall, no panel behind it -->
        <Stack :gap="16">
          <Stack v-for="v in variants" :key="v.variant" direction="horizontal" :gap="16" align="center">
            <RowCaption :value="v.caption" />
            <Button v-for="(s, i) in sizes" :key="s" :variant="v.variant" :size="s" :label="v.labels[i]" />
          </Stack>
        </Stack>

        <Stack direction="horizontal" :gap="40" align="end" wrap>
          <Stack :gap="10">
            <Stack direction="horizontal" :gap="12" align="center">
              <Button :label="tr('不可用', 'Unavailable')" disabled />
              <Button variant="glassProminent" :label="tr('不可用', 'Unavailable')" disabled />
              <Button variant="filled" :label="tr('不可用', 'Unavailable')" disabled />
            </Stack>
            <Caption :value="tr('禁用 DISABLED', 'DISABLED')" />
          </Stack>
          <Stack :gap="10">
            <Stack direction="horizontal" :gap="12" align="center">
              <Button :label="tr('同步中', 'Syncing')" loading />
              <Button variant="glassProminent" :label="tr('保存', 'Save')" leading-icon="check" :loading="saving" @press="save" />
            </Stack>
            <Caption :value="tr('加载中 LOADING · 点「保存」试试', 'LOADING · press Save to try')" />
          </Stack>
        </Stack>

        <Stack direction="horizontal" :gap="40" align="end" wrap>
          <Stack :gap="10">
            <Stack direction="horizontal" :gap="12" align="center">
              <Button shape="circle" size="small" leading-icon="plus" />
              <Button shape="circle" leading-icon="heart" />
              <Button shape="circle" size="large" leading-icon="gear" />
              <Button shape="circle" variant="glassProminent" leading-icon="search" />
              <Button shape="circle" variant="tinted" leading-icon="star" />
            </Stack>
            <Caption :value="tr('圆形 CIRCLE · 只放图标', 'CIRCLE · icon only')" />
          </Stack>
          <Stack :gap="10">
            <Stack direction="horizontal" :gap="12" align="center">
              <Button shape="roundedRectangle" :label="tr('新建', 'New')" leading-icon="plus" />
              <Button shape="roundedRectangle" variant="filled" :label="tr('下一步', 'Next')" trailing-icon="chevron-right" />
            </Stack>
            <Caption :value="tr('圆角矩形 ROUNDED RECTANGLE · 图标', 'ROUNDED RECTANGLE · with icons')" />
          </Stack>
        </Stack>

        <!-- the reference's primary action: large glowing glass, the label and arrow centred, full width -->
        <Stack :gap="10" align="start" :style="{ maxWidth: 560 }">
          <Button variant="glassProminent" size="large" :label="tr('创建账号', 'Create account')" trailing-icon="arrow-right" full-width @press="presses++" />
          <Text :value="presses ? tr(`press 触发了 ${presses} 次`, `press fired ${presses} times`) : tr('点按、Enter 或空格都会触发 press；Tab 聚焦时显示焦点环', 'Click, Enter or Space fires press; Tab shows the focus ring')" size="sm" color="secondaryLabel" />
        </Stack>
      </Stack>
        </Box>
      </scroll>
    </Block>
    <Block name="toggles" :width="1440" :height="1000" :style="{ padding: 40, gap: 20, height: 1000 }">
      <Stack direction="horizontal" :gap="10" align="center" :style="{ height: 44, flexShrink: 0 }">
        <Text :value="tr('组件库', 'Gallery')" :size="20" :weight="700" :style="{ marginRight: 16 }" />
        <Button v-for="section in sections" :id="`gallery-toggles-to-${section}`" :key="section" :label="sectionLabel(section)" size="small" :variant="focus === section ? 'glassProminent' : 'glass'" @press="navigate(section)" />
        <Button id="gallery-toggles-language" :label="locale === 'zh' ? 'EN' : '中文'" size="small" variant="plain" @press="toggleLocale" />
      </Stack>
      <scroll id="gallery-toggles-scroll" :style="{ height: 856, flexShrink: 0, overflow: 'scroll' }">
        <Box :style="{ flexShrink: 0, paddingBottom: 32 }">
          <Stack id="toggles" :gap="24">
        <Stack :gap="12">
          <Stack direction="horizontal" justify="between" align="end">
            <Text :value="tr('开关与复选框', 'Switch & Checkbox')" size="xl" :weight="700" />
            <Text :value="tr('开关与复选框 · v-model:checked · 点按、Enter、空格切换', 'v-model:checked · click, Enter or Space to toggle')" size="sm" color="secondaryLabel" :style="{ marginBottom: 3 }" />
          </Stack>
          <Box :style="{ height: 1, bg: 'separator' }" />
        </Stack>

        <!-- glass right on the wall, as the Buttons: on and off, then with labels (a Switch's on its left, a Checkbox's on its right) -->
        <Stack :gap="16">
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption :value="tr('SWITCH · 开关', 'SWITCH · on and off')" />
            <Switch v-model:checked="wifi" />
            <Switch v-model:checked="bluetooth" />
          </Stack>
          <Stack direction="horizontal" :gap="32" align="center">
            <RowCaption :value="tr('SWITCH · 带标签', 'SWITCH · with labels')" />
            <Switch v-model:checked="remember" :label="tr('记住我', 'Remember me')" />
            <Switch v-model:checked="notify" :label="tr('通知', 'Notifications')" />
          </Stack>
          <Stack direction="horizontal" :gap="32" align="center">
            <RowCaption :value="tr('CHECKBOX · 复选框', 'CHECKBOX')" />
            <Checkbox v-model:checked="agree" :label="tr('同意服务条款', 'Agree to terms')" />
            <Checkbox v-model:checked="news" :label="tr('订阅动态', 'Subscribe to updates')" />
          </Stack>
        </Stack>

        <Stack direction="horizontal" :gap="40" align="end" wrap>
          <Stack :gap="10">
            <Stack direction="horizontal" :gap="12" align="center">
              <Switch :checked="true" disabled />
              <Switch disabled />
              <Checkbox :checked="true" disabled :label="tr('已锁定', 'Locked')" :style="{ marginLeft: 12 }" />
            </Stack>
            <Caption :value="tr('禁用 DISABLED', 'DISABLED')" />
          </Stack>
          <Stack :gap="10">
            <Stack :gap="12" align="start">
              <Checkbox :checked="allOn" :indeterminate="someOn" :label="tr('全部通知', 'All notifications')" @update:checked="setAll" />
              <!-- the channels, indented under the parent's label (its box 44 + gap 16) -->
              <Stack :gap="12" align="start" :style="{ paddingLeft: 60 }">
                <Checkbox v-for="ch in channels" :key="ch.key" v-model:checked="ch.on" :label="ch[locale]" />
              </Stack>
            </Stack>
            <Caption :value="tr('部分选中 INDETERMINATE · 点「全部通知」试试', 'INDETERMINATE · try All notifications')" />
          </Stack>
        </Stack>

        <!-- the reference's pair: the terms checkbox at the left, "Remember me" at the right, its label against it -->
        <Stack :gap="10" :style="{ maxWidth: 640 }">
          <Stack direction="horizontal" justify="between" align="center">
            <Checkbox v-model:checked="terms" :label="tr('我同意服务条款与隐私政策', 'I agree to the Terms & Privacy Policy')" />
            <Switch v-model:checked="rememberMe" :label="tr('记住我', 'Remember me')" />
          </Stack>
          <Text :value="tr(`条款：${terms ? '已同意' : '未同意'} · 记住我：${rememberMe ? '开' : '关'}；Tab 聚焦时显示焦点环`, `Terms: ${terms ? 'accepted' : 'not accepted'} · Remember me: ${rememberMe ? 'on' : 'off'}; Tab shows the focus ring`)" size="sm" color="secondaryLabel" />
        </Stack>
      </Stack>
        </Box>
      </scroll>
    </Block>
    <Block name="inputs" :width="1440" :height="1000" :style="{ padding: 40, gap: 20, height: 1000 }">
      <Stack direction="horizontal" :gap="10" align="center" :style="{ height: 44, flexShrink: 0 }">
        <Text :value="tr('组件库', 'Gallery')" :size="20" :weight="700" :style="{ marginRight: 16 }" />
        <Button v-for="section in sections" :id="`gallery-inputs-to-${section}`" :key="section" :label="sectionLabel(section)" size="small" :variant="focus === section ? 'glassProminent' : 'glass'" @press="navigate(section)" />
        <Button id="gallery-inputs-language" :label="locale === 'zh' ? 'EN' : '中文'" size="small" variant="plain" @press="toggleLocale" />
      </Stack>
      <scroll id="gallery-inputs-scroll" :style="{ height: 856, flexShrink: 0, overflow: 'scroll' }">
        <Box :style="{ flexShrink: 0, paddingBottom: 32 }">
          <Stack id="inputs" :gap="24">
        <Stack :gap="12">
          <Stack direction="horizontal" justify="between" align="end">
            <Text :value="tr('输入框', 'Inputs')" size="xl" :weight="700" />
            <Text :value="tr('输入框 · v-model · 输入法、复制粘贴、撤销由页面里的原生输入框代理', 'v-model · native input proxy handles IME, copy, paste and undo')" size="sm" color="secondaryLabel" :style="{ marginBottom: 3 }" />
          </Stack>
          <Box :style="{ height: 1, bg: 'separator' }" />
        </Stack>

        <!-- glass right on the wall, as the other controls: each kind in a row -->
        <Stack :gap="16">
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption :value="tr('EMPTY · 占位提示', 'EMPTY · placeholder')" />
            <Input v-model="nickname" :placeholder="tr('你的昵称', 'Your nickname')" :style="{ width: 340 }" />
          </Stack>
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption :value="tr('FILLED · 已填写', 'FILLED · preset value')" />
            <Input v-model="city" :style="{ width: 340 }" />
          </Stack>
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption :value="tr('PASSWORD · 密码', 'PASSWORD')" />
            <Input v-model="secret" type="password" leading-icon="lock" :placeholder="tr('密码', 'Password')" :style="{ width: 340 }" />
          </Stack>
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption :value="tr('NUMBER · 数字', 'NUMBER')" />
            <Input v-model="qty" type="number" placeholder="0" :style="{ width: 200 }" />
            <Text :value="`v-model：${qty === null ? 'null' : qty}`" size="sm" color="secondaryLabel" />
          </Stack>
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption :value="tr('CLEARABLE · 可清除', 'CLEARABLE')" />
            <Input v-model="query" clearable leading-icon="search" :placeholder="tr('搜索', 'Search')" :style="{ width: 340 }" />
          </Stack>
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption :value="tr('DISABLED · 禁用', 'DISABLED')" />
            <Input :model-value="tr('不可编辑', 'Read only')" disabled leading-icon="user" :style="{ width: 340 }" />
          </Stack>
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption :value="tr('CHINESE · 中文 · 长文本滚动', 'CHINESE · long text scrolling')" />
            <Input v-model="poem" :style="{ width: 340 }" />
          </Stack>
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption :value="tr('SIZES · 三种尺寸', 'SIZES · three options')" />
            <Input size="small" placeholder="small 36" :style="{ width: 180 }" />
            <Input placeholder="regular 52" :style="{ width: 220 }" />
          </Stack>
        </Stack>

        <!-- the reference's fields: large (84 pt), a leading icon each, the password's eye -->
        <Stack :gap="16" :style="{ maxWidth: 560 }">
          <Caption :value="tr('参考稿 REFERENCE · LARGE 84 · 前置图标', 'REFERENCE · LARGE 84 · leading icons')" />
          <Input v-model="fullName" size="large" leading-icon="user" :placeholder="tr('姓名', 'Full name')" @submit="submitted = fullName" />
          <Input v-model="email" size="large" leading-icon="mail" :placeholder="tr('邮箱地址', 'Email address')" @submit="submitted = email" />
          <Input v-model="password" type="password" size="large" leading-icon="lock" :placeholder="tr('密码', 'Password')" @submit="submitted = '••••'" />
          <Text :value="submitted ? tr(`Enter 提交了：${submitted}`, `Enter submitted: ${submitted}`) : tr('点按或 Tab 进入编辑；Enter 发出 submit，Esc 退出；拖动选择，双击选词', 'Click or Tab to edit; Enter submits, Esc leaves; drag to select and double-click a word')" size="sm" color="secondaryLabel" />
        </Stack>
      </Stack>
        </Box>
      </scroll>
    </Block>
    <Block name="dialog" :width="1440" :height="1000" :style="{ padding: 40, gap: 20, height: 1000 }">
      <Stack direction="horizontal" :gap="10" align="center" :style="{ height: 44, flexShrink: 0 }">
        <Text :value="tr('组件库', 'Gallery')" :size="20" :weight="700" :style="{ marginRight: 16 }" />
        <Button v-for="section in sections" :id="`gallery-dialog-to-${section}`" :key="section" :label="sectionLabel(section)" size="small" :variant="focus === section ? 'glassProminent' : 'glass'" @press="navigate(section)" />
        <Button id="gallery-dialog-language" :label="locale === 'zh' ? 'EN' : '中文'" size="small" variant="plain" @press="toggleLocale" />
      </Stack>
      <scroll id="gallery-dialog-scroll" :style="{ height: 856, flexShrink: 0, overflow: 'scroll' }">
        <Box :style="{ flexShrink: 0, paddingBottom: 32 }">
          <Stack id="dialog" :gap="24">
        <Stack :gap="12">
          <Stack direction="horizontal" justify="between" align="end">
            <Text :value="tr('对话框', 'Dialog')" size="xl" :weight="700" />
            <Text :value="tr('对话框 · v-model:open · 暗化背景上的玻璃面板，键盘只在面板里', 'v-model:open · a glass panel over a dimmed backdrop with contained keyboard focus')" size="sm" color="secondaryLabel" :style="{ marginBottom: 3 }" />
          </Stack>
          <Box :style="{ height: 1, bg: 'separator' }" />
        </Stack>

        <!-- the opener right on the wall; the Dialog takes no space here: its panel and scrim are Surfaces of their own -->
        <Stack :gap="10" align="start">
          <Stack direction="horizontal" :gap="16" align="center">
            <Button id="open-dialog" variant="glassProminent" :label="tr('重命名项目', 'Rename project')" leading-icon="gear" @press="openRename" />
            <Text :value="tr(`项目：${project}`, `Project: ${project}`)" :weight="600" />
          </Stack>
          <Text :value="outcome || tr('打开后输入框自动获得焦点；Tab 在面板里循环，Escape 或点击背景关闭，焦点回到按钮', 'The input receives focus; Tab stays in the dialog; Escape or the backdrop closes it and restores focus')" size="sm" color="secondaryLabel" />
        </Stack>
        <Dialog id="rename-dialog" v-model:open="renaming" :title="tr('重命名项目', 'Rename project')" @close="outcome = tr('已关闭（Escape 或点击背景）', 'Closed (Escape or backdrop)')">
          <Text :value="tr('新名称会同步给项目里的所有成员。', 'The new name will be visible to all project members.')" color="secondaryLabel" />
          <Input v-model="draft" leading-icon="star" :placeholder="tr('项目名称', 'Project name')" clearable :max-length="24" @submit="rename" />
          <template #footer>
            <Button :label="tr('取消', 'Cancel')" @press="cancelRename" />
            <Button variant="glassProminent" :label="tr('保存', 'Save')" leading-icon="check" :disabled="!draft.trim()" @press="rename" />
          </template>
        </Dialog>
      </Stack>
        </Box>
      </scroll>
    </Block>
    <Block name="containers" :width="1440" :height="1000" :style="{ padding: 40, gap: 20, height: 1000 }">
      <Stack direction="horizontal" :gap="10" align="center" :style="{ height: 44, flexShrink: 0 }">
        <Text :value="tr('组件库', 'Gallery')" :size="20" :weight="700" :style="{ marginRight: 16 }" />
        <Button v-for="section in sections" :id="`gallery-containers-to-${section}`" :key="section" :label="sectionLabel(section)" size="small" :variant="focus === section ? 'glassProminent' : 'glass'" @press="navigate(section)" />
        <Button id="gallery-containers-language" :label="locale === 'zh' ? 'EN' : '中文'" size="small" variant="plain" @press="toggleLocale" />
      </Stack>
      <scroll id="gallery-containers-scroll" :style="{ height: 856, flexShrink: 0, overflow: 'scroll' }">
        <Box :style="{ flexShrink: 0, paddingBottom: 32 }">
          <Stack id="containers" :gap="24">
        <Stack :gap="12">
          <Stack direction="horizontal" justify="between" align="end">
            <Text :value="tr('玻璃容器', 'Glass Container')" size="xl" :weight="700" />
            <Text :value="tr('玻璃容器 · 相距小于 spacing 的素玻璃融成一块 · glassId 形变', 'Nearby glass controls fuse within spacing; glassId carries their shape across positions')" size="sm" color="secondaryLabel" :style="{ marginBottom: 3 }" />
          </Stack>
          <Box :style="{ height: 1, bg: 'separator' }" />
        </Stack>

        <!-- the toolbar: fused at gap 8 (under spacing 16), apart at gap 24; the Buttons slide (an x spring each) -->
        <Stack direction="horizontal" :gap="40" align="end" wrap>
          <Stack :gap="10">
            <GlassContainer id="containers-toolbar" :spacing="16" :gap="toolbarGap">
              <Button v-for="i in toolbar" :key="i" shape="circle" :leading-icon="i" :style="{ transition: { x: 'smooth' } }" />
            </GlassContainer>
            <Caption :value="tr(`工具栏 TOOLBAR · spacing 16 · gap ${toolbarGap}`, `TOOLBAR · spacing 16 · gap ${toolbarGap}`)" />
          </Stack>
          <Stack :gap="10">
            <Button id="containers-widen" :label="wide ? tr('收拢到 gap 8', 'Close to gap 8') : tr('拉开到 gap 24', 'Spread to gap 24')" :leading-icon="wide ? 'minus' : 'plus'" @press="wide = !wide" />
            <Caption :value="tr('间距超过 spacing 时各自分开', 'Controls separate when the gap exceeds spacing')" />
          </Stack>
        </Stack>

        <!-- glassId: the star leaves one end and mounts at the other; the new one grows out of the old place -->
        <Stack :gap="10">
          <Stack direction="horizontal" :gap="24" align="center">
            <GlassContainer id="containers-swap-bar" :spacing="16" :gap="8">
              <Button v-if="swapLeft" key="l" shape="circle" leading-icon="star" glass-id="gallery-swap" />
              <Box v-else key="lx" :style="{ width: 52, height: 52 }" />
              <Button v-for="i in swapMiddle" :key="i" shape="circle" :leading-icon="i" />
              <Button v-if="!swapLeft" key="r" shape="circle" leading-icon="star" glass-id="gallery-swap" />
              <Box v-else key="rx" :style="{ width: 52, height: 52 }" />
            </GlassContainer>
            <Button id="containers-swap" :label="swapLeft ? tr('换到右边', 'Move right') : tr('换到左边', 'Move left')" :trailing-icon="swapLeft ? 'chevron-right' : 'chevron-left'" @press="swapLeft = !swapLeft" />
          </Stack>
          <Caption :value="tr('GLASSID 形变 · 同一 glass-id 的按钮换个位置重新挂载时，从旧处长过去，与相遇的玻璃融合', 'GLASSID MORPH · a remounted button grows from its previous position and fuses with nearby glass')" />
        </Stack>

        <!-- the selected item: glowing glass stands apart (like Apple's selected toolbar item); keyed to re-mount, its
             glassId moves the highlight to the new one -->
        <Stack :gap="10">
          <GlassContainer id="containers-tabs" :spacing="16" :gap="8">
            <Button
              v-for="t in tabs" :key="t.name === tab ? `${t.name}-on` : t.name" shape="circle" :leading-icon="t.icon"
              :variant="t.name === tab ? 'glassProminent' : 'glass'" :glass-id="t.name === tab ? 'gallery-tab' : undefined" @press="tab = t.name"
            />
          </GlassContainer>
          <Caption :value="tr('选中项 SELECTED · 发光的玻璃单独成块，点别的图标试试', 'SELECTED ITEM · the glowing control stands apart; try another icon')" />
        </Stack>
      </Stack>
        </Box>
      </scroll>
    </Block>
  </Space>
</template>
