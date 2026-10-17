<script setup lang="ts">
// The component gallery (`?scene=gallery`): every @glassui/vue component, section by section. The content sits on the
// wall with no glass under it (spec §8.3: glass on controls, never on content areas); the controls (Buttons, Switches,
// Checkboxes, Inputs) are glass right on the wall, with no panel behind them; the Glass Container section fuses a
// toolbar of them into one slab and morphs a glassId between places. The Dialog section's Button opens a
// <Dialog>: a glass panel of its own over a scrim that dims the whole screen. Beside the column stands a world-layer
// <Surface>: a glass panel in the scene, turned about Y, with hover, clicks and an Input of its own.
import { computed, h, onBeforeUnmount, ref, type FunctionalComponent } from 'vue'
import { Box, Button, Checkbox, Dialog, GlassContainer, Icon, ICON_NAMES, Input, Stack, Surface, Switch, Text, useScheme } from '@glassui/vue'

// The page is a vertical `scroll` (the wheel scrolls it once later sections outgrow the viewport). No page fill: the
// content sits on the wall itself, which the later sections' glass refracts.
const scheme = useScheme()
/** The wrap tile's chip fill: the scheme's accent (theme `accent`) at low alpha; a little more under the pointer. */
const chip = computed(() => scheme.value === 'dark' ? '#8a83ff33' : '#6b63f524')
const chipHover = computed(() => scheme.value === 'dark' ? '#8a83ff59' : '#6b63f547')
/** Clicks on the world panel's button. */
const taps = ref(0)

/** A small spaced caption over each group. */
const Caption: FunctionalComponent<{ value: string }> = p => h(Text, { value: p.value, size: 12, weight: 600, color: 'secondaryLabel', style: { letterSpacing: 1.4 } })
/** A row's caption at its left, one line (the longest, GLASS PROMINENT · 主操作, is ≈ 190 pt). */
const RowCaption: FunctionalComponent<{ value: string }> = p => h(Text, { value: p.value, size: 12, weight: 600, color: 'secondaryLabel', wrap: false, style: { width: 224, flexShrink: 0, letterSpacing: 1 } })

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

/** The Buttons section: each variant in the three sizes (small, regular, large), its labels growing with the size. */
const variants = [
  { variant: 'glassProminent', caption: 'GLASS PROMINENT · 主操作', labels: ['确定', '创建账号', '开始免费试用'] },
  { variant: 'glass', caption: 'GLASS · 次要操作', labels: ['取消', '稍后再说', '查看详情'] },
  { variant: 'filled', caption: 'FILLED · 实心', labels: ['提交', '保存更改', '立即购买'] },
  { variant: 'tinted', caption: 'TINTED · 淡底', labels: ['收藏', '加入清单', '订阅更新'] },
  { variant: 'plain', caption: 'PLAIN · 纯文字', labels: ['编辑', '查看全部', '了解更多'] },
] as const
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
const channels = ref([{ key: 'mail', label: '邮件', on: true }, { key: 'sms', label: '短信', on: false }, { key: 'push', label: '推送', on: true }])
const allOn = computed(() => channels.value.every(c => c.on))
const someOn = computed(() => !allOn.value && channels.value.some(c => c.on))
const setAll = (on: boolean) => { for (const c of channels.value) c.on = on }

/** The Inputs section: every field is v-model'd; the reference's three report what Enter submitted. */
const nickname = ref(''), city = ref('杭州市西湖区文三路 90 号'), secret = ref('glass-ui-2026'), qty = ref<number | null>(12)
const query = ref('液态玻璃'), poem = ref('春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。')
const fullName = ref(''), email = ref(''), password = ref(''), submitted = ref('')
/** The world panel's field. */
const note = ref('')

/** The Dialog section: renaming the project in a dialog (its field starts from the current name), and how it ended. */
const project = ref('玻璃界面实验室'), renaming = ref(false), draft = ref(''), outcome = ref('')
const openRename = () => { draft.value = project.value; renaming.value = true }
const rename = () => {
  const name = draft.value.trim()
  if (!name) return
  project.value = name; outcome.value = `已保存：${name}`; renaming.value = false
}
const cancelRename = () => { outcome.value = '已取消'; renaming.value = false }
</script>

<template>
  <scroll id="gallery" :style="{ width: '100%', height: '100%', overflow: 'scroll' }">
    <Box :style="{ flexShrink: 0, paddingX: 64, paddingTop: 44, paddingBottom: 40, gap: 32 }">
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
              <Stack direction="horizontal" :gap="14" align="center" :style="{ height: 40 }">
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
                <Text value="z · 叠放" :size="12" color="secondaryLabel" />
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
                  <Box v-for="t in ['玻璃', 'Glass', '折射', 'Refraction', '高光']" :key="t" :style="{ paddingX: 10, paddingY: 3, radius: 'capsule', bg: chip }">
                    <Text :value="t" :size="13" color="accent" :weight="500" />
                  </Box>
                </Stack>
                <Text value="wrap" :size="12" color="secondaryLabel" />
              </Stack>
            </Stack>
          </Stack>
        </Stack>
      </Stack>

      <Stack id="buttons" :gap="24">
        <Stack :gap="12">
          <Stack direction="horizontal" justify="between" align="end">
            <Text value="Buttons" size="xl" :weight="700" />
            <Text value="按钮 · 五种外观 × 三种尺寸 · 悬停上浮倾斜，按下缩小" size="sm" color="secondaryLabel" :style="{ marginBottom: 3 }" />
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
              <Button label="不可用" disabled />
              <Button variant="glassProminent" label="不可用" disabled />
              <Button variant="filled" label="不可用" disabled />
            </Stack>
            <Caption value="禁用 DISABLED" />
          </Stack>
          <Stack :gap="10">
            <Stack direction="horizontal" :gap="12" align="center">
              <Button label="同步中" loading />
              <Button variant="glassProminent" label="保存" leading-icon="check" :loading="saving" @press="save" />
            </Stack>
            <Caption value="加载中 LOADING · 点「保存」试试" />
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
            <Caption value="圆形 CIRCLE · 只放图标" />
          </Stack>
          <Stack :gap="10">
            <Stack direction="horizontal" :gap="12" align="center">
              <Button shape="roundedRectangle" label="新建" leading-icon="plus" />
              <Button shape="roundedRectangle" variant="filled" label="下一步" trailing-icon="chevron-right" />
            </Stack>
            <Caption value="圆角矩形 ROUNDED RECTANGLE · 图标" />
          </Stack>
        </Stack>

        <!-- the reference's primary action: large glowing glass, the label and arrow centred, full width -->
        <Stack :gap="10" align="start" :style="{ maxWidth: 560 }">
          <Button variant="glassProminent" size="large" label="创建账号" trailing-icon="arrow-right" full-width @press="presses++" />
          <Text :value="presses ? `press 触发了 ${presses} 次` : '点按、Enter 或空格都会触发 press；Tab 聚焦时显示焦点环'" size="sm" color="secondaryLabel" />
        </Stack>
      </Stack>

      <Stack id="containers" :gap="24">
        <Stack :gap="12">
          <Stack direction="horizontal" justify="between" align="end">
            <Text value="Glass Container" size="xl" :weight="700" />
            <Text value="玻璃容器 · 相距小于 spacing 的素玻璃融成一块 · glassId 形变" size="sm" color="secondaryLabel" :style="{ marginBottom: 3 }" />
          </Stack>
          <Box :style="{ height: 1, bg: 'separator' }" />
        </Stack>

        <!-- the toolbar: fused at gap 8 (under spacing 16), apart at gap 24; the Buttons slide (an x spring each) -->
        <Stack direction="horizontal" :gap="40" align="end" wrap>
          <Stack :gap="10">
            <GlassContainer id="containers-toolbar" :spacing="16" :gap="toolbarGap">
              <Button v-for="i in toolbar" :key="i" shape="circle" :leading-icon="i" :style="{ transition: { x: 'smooth' } }" />
            </GlassContainer>
            <Caption :value="`工具栏 TOOLBAR · spacing 16 · gap ${toolbarGap}`" />
          </Stack>
          <Stack :gap="10">
            <Button id="containers-widen" :label="wide ? '收拢到 gap 8' : '拉开到 gap 24'" :leading-icon="wide ? 'minus' : 'plus'" @press="wide = !wide" />
            <Caption value="间距超过 spacing 时各自分开" />
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
            <Button id="containers-swap" :label="swapLeft ? '换到右边' : '换到左边'" :trailing-icon="swapLeft ? 'chevron-right' : 'chevron-left'" @press="swapLeft = !swapLeft" />
          </Stack>
          <Caption value="GLASSID 形变 · 同一 glass-id 的按钮换个位置重新挂载时，从旧处长过去，与相遇的玻璃融合" />
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
          <Caption value="选中项 SELECTED · 发光的玻璃单独成块，点别的图标试试" />
        </Stack>
      </Stack>

      <Stack id="toggles" :gap="24">
        <Stack :gap="12">
          <Stack direction="horizontal" justify="between" align="end">
            <Text value="Switch & Checkbox" size="xl" :weight="700" />
            <Text value="开关与复选框 · v-model:checked · 点按、Enter、空格切换" size="sm" color="secondaryLabel" :style="{ marginBottom: 3 }" />
          </Stack>
          <Box :style="{ height: 1, bg: 'separator' }" />
        </Stack>

        <!-- glass right on the wall, as the Buttons: on and off, then with labels (a Switch's on its left, a Checkbox's on its right) -->
        <Stack :gap="16">
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption value="SWITCH · 开关" />
            <Switch v-model:checked="wifi" />
            <Switch v-model:checked="bluetooth" />
          </Stack>
          <Stack direction="horizontal" :gap="32" align="center">
            <RowCaption value="SWITCH · 带标签" />
            <Switch v-model:checked="remember" label="记住我" />
            <Switch v-model:checked="notify" label="通知" />
          </Stack>
          <Stack direction="horizontal" :gap="32" align="center">
            <RowCaption value="CHECKBOX · 复选框" />
            <Checkbox v-model:checked="agree" label="同意服务条款" />
            <Checkbox v-model:checked="news" label="订阅动态" />
          </Stack>
        </Stack>

        <Stack direction="horizontal" :gap="40" align="end" wrap>
          <Stack :gap="10">
            <Stack direction="horizontal" :gap="12" align="center">
              <Switch :checked="true" disabled />
              <Switch disabled />
              <Checkbox :checked="true" disabled label="已锁定" :style="{ marginLeft: 12 }" />
            </Stack>
            <Caption value="禁用 DISABLED" />
          </Stack>
          <Stack :gap="10">
            <Stack :gap="12" align="start">
              <Checkbox :checked="allOn" :indeterminate="someOn" label="全部通知" @update:checked="setAll" />
              <!-- the channels, indented under the parent's label (its box 44 + gap 16) -->
              <Stack :gap="12" align="start" :style="{ paddingLeft: 60 }">
                <Checkbox v-for="ch in channels" :key="ch.key" v-model:checked="ch.on" :label="ch.label" />
              </Stack>
            </Stack>
            <Caption value="部分选中 INDETERMINATE · 点「全部通知」试试" />
          </Stack>
        </Stack>

        <!-- the reference's pair: the terms checkbox at the left, "Remember me" at the right, its label against it -->
        <Stack :gap="10" :style="{ maxWidth: 640 }">
          <Stack direction="horizontal" justify="between" align="center">
            <Checkbox v-model:checked="terms" label="我同意服务条款与隐私政策" />
            <Switch v-model:checked="rememberMe" label="记住我" />
          </Stack>
          <Text :value="`条款：${terms ? '已同意' : '未同意'} · 记住我：${rememberMe ? '开' : '关'}；Tab 聚焦时显示焦点环`" size="sm" color="secondaryLabel" />
        </Stack>
      </Stack>

      <Stack id="inputs" :gap="24">
        <Stack :gap="12">
          <Stack direction="horizontal" justify="between" align="end">
            <Text value="Inputs" size="xl" :weight="700" />
            <Text value="输入框 · v-model · 输入法、复制粘贴、撤销由页面里的原生输入框代理" size="sm" color="secondaryLabel" :style="{ marginBottom: 3 }" />
          </Stack>
          <Box :style="{ height: 1, bg: 'separator' }" />
        </Stack>

        <!-- glass right on the wall, as the other controls: each kind in a row -->
        <Stack :gap="16">
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption value="EMPTY · 占位提示" />
            <Input v-model="nickname" placeholder="你的昵称" :style="{ width: 340 }" />
          </Stack>
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption value="FILLED · 已填写" />
            <Input v-model="city" :style="{ width: 340 }" />
          </Stack>
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption value="PASSWORD · 密码" />
            <Input v-model="secret" type="password" leading-icon="lock" placeholder="密码" :style="{ width: 340 }" />
          </Stack>
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption value="NUMBER · 数字" />
            <Input v-model="qty" type="number" placeholder="0" :style="{ width: 200 }" />
            <Text :value="`v-model：${qty === null ? 'null' : qty}`" size="sm" color="secondaryLabel" />
          </Stack>
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption value="CLEARABLE · 可清除" />
            <Input v-model="query" clearable leading-icon="search" placeholder="搜索" :style="{ width: 340 }" />
          </Stack>
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption value="DISABLED · 禁用" />
            <Input model-value="不可编辑" disabled leading-icon="user" :style="{ width: 340 }" />
          </Stack>
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption value="CHINESE · 中文 · 长文本滚动" />
            <Input v-model="poem" :style="{ width: 340 }" />
          </Stack>
          <Stack direction="horizontal" :gap="16" align="center">
            <RowCaption value="SIZES · 三种尺寸" />
            <Input size="small" placeholder="small 36" :style="{ width: 180 }" />
            <Input placeholder="regular 52" :style="{ width: 220 }" />
          </Stack>
        </Stack>

        <!-- the reference's fields: large (84 pt), a leading icon each, the password's eye -->
        <Stack :gap="16" :style="{ maxWidth: 560 }">
          <Caption value="参考稿 REFERENCE · LARGE 84 · 前置图标" />
          <Input v-model="fullName" size="large" leading-icon="user" placeholder="Full name" @submit="submitted = fullName" />
          <Input v-model="email" size="large" leading-icon="mail" placeholder="Email address" @submit="submitted = email" />
          <Input v-model="password" type="password" size="large" leading-icon="lock" placeholder="Password" @submit="submitted = '••••'" />
          <Text :value="submitted ? `Enter 提交了：${submitted}` : '点按或 Tab 进入编辑；Enter 发出 submit，Esc 退出；拖动选择，双击选词'" size="sm" color="secondaryLabel" />
        </Stack>
      </Stack>

      <Stack id="dialogs" :gap="24">
        <Stack :gap="12">
          <Stack direction="horizontal" justify="between" align="end">
            <Text value="Dialog" size="xl" :weight="700" />
            <Text value="对话框 · v-model:open · 暗化背景上的玻璃面板，键盘只在面板里" size="sm" color="secondaryLabel" :style="{ marginBottom: 3 }" />
          </Stack>
          <Box :style="{ height: 1, bg: 'separator' }" />
        </Stack>

        <!-- the opener right on the wall; the Dialog takes no space here: its panel and scrim are Surfaces of their own -->
        <Stack :gap="10" align="start">
          <Stack direction="horizontal" :gap="16" align="center">
            <Button id="open-dialog" variant="glassProminent" label="重命名项目" leading-icon="gear" @press="openRename" />
            <Text :value="`项目：${project}`" :weight="600" />
          </Stack>
          <Text :value="outcome || '打开后输入框自动获得焦点；Tab 在面板里循环，Escape 或点击背景关闭，焦点回到按钮'" size="sm" color="secondaryLabel" />
        </Stack>
        <Dialog id="rename-dialog" v-model:open="renaming" title="重命名项目" @close="outcome = '已关闭（Escape 或点击背景）'">
          <Text value="新名称会同步给项目里的所有成员。" color="secondaryLabel" />
          <Input v-model="draft" leading-icon="star" placeholder="项目名称" clearable :max-length="24" @submit="rename" />
          <template #footer>
            <Button label="取消" @press="cancelRename" />
            <Button variant="glassProminent" label="保存" leading-icon="check" :disabled="!draft.trim()" @press="rename" />
          </template>
        </Dialog>
      </Stack>
    </Box>
  </scroll>

  <!-- In the strip right of the column (main.ts: `galleryColumn`): through the playground camera, x = 2.5 keeps the
       panel in that strip and on screen from 4:3 to ultrawide. 340 × 300 pt at 244 pt per unit: 1.39 × 1.23 units.
       Seen from the camera it is already ≈ 0.34 rad off-axis there (−0.35 would face the viewer square on), so −0.7
       turns it ≈ 0.37 rad past that, toward the gallery: a visible slant (its near, right edge ≈ 13 % taller) that
       keeps the text legible. -->
  <Surface :width="340" :height="300" :position="[2.5, 0.9, 0]" :rotation="[0, -0.7, 0]" background="glass" :radius="28">
    <Stack id="world-panel" justify="between" :gap="14" :style="{ padding: 24, flexGrow: 1 }">
      <Stack :gap="10">
        <Stack direction="horizontal" :gap="10" align="center">
          <Icon name="star" :size="24" color="accent" />
          <Text value="世界层 World layer" size="lg" :weight="700" />
        </Stack>
        <Text value="一块世界层 Surface：场景里的玻璃面板，绕 Y 轴转了 −0.7 rad，有自己的悬停、点击与输入。" size="sm" color="secondaryLabel" />
      </Stack>
      <!-- typed into on a tilted Surface: the IME proxy (and its candidate window) follows the projected caret -->
      <Input id="world-input" v-model="note" leading-icon="info" placeholder="在世界层输入…" clearable />
      <Box
        id="world-tap" tw="flex-row items-center gap-2"
        :style="{ alignSelf: 'flex-start', paddingX: 14, paddingY: 8, radius: 'capsule', bg: chip, hover: { bg: chipHover }, pressed: { scale: 0.96 }, transition: { bg: 'smooth', scale: 'snappy' } }"
        @click="taps++"
      >
        <Icon name="check" :size="18" color="accent" />
        <Text :value="taps ? `点了 ${taps} 次` : '悬停、点我试试'" size="sm" :weight="600" color="accent" />
      </Box>
    </Stack>
  </Surface>
</template>
