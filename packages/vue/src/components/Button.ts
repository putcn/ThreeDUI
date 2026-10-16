import { computed, h, onBeforeUnmount, ref, shallowRef, watch, type VNodeChild } from '@vue/runtime-core'
import { z } from 'zod'
import { GlassUIError, type ColorScheme, type Node, type Style, type Theme } from '@glassui/core'
import { glowingTint, towardWhite, withAlpha } from '../colors'
import { controlStyle, useGlassControl } from '../control'
import { defineGlassComponent } from '../define'
import { ICON_ALIASES, ICON_NAMES, type IconName } from '../icons'
import { useMotion, useScheme, useTheme } from '../inject'
import { Icon } from './Icon'
import { Text } from './Text'

const VARIANTS = ['glass', 'glassProminent', 'filled', 'tinted', 'plain'] as const
type Variant = (typeof VARIANTS)[number]
type Size = 'small' | 'regular' | 'large'

/**
 * A size's height, label font, side padding, icon and icon–label gap (pt). The large one is the 80 pt reference control
 * (spec §8.2), its padding, icon and gap the theme's metrics.
 */
function sizeOf(size: Size, theme: Theme): { height: number; font: number; padX: number; icon: number; gap: number } {
  const m = theme.metrics
  switch (size) {
    case 'small': return { height: 36, font: 15, padX: 14, icon: 18, gap: 6 }
    case 'regular': return { height: 52, font: 18, padX: 20, icon: 22, gap: 8 }
    case 'large': return { height: 80, font: 25, padX: m.controlPadding, icon: m.icon, gap: m.groupGap }
  }
}

/**
 * A variant's host element, its label's colour and weight (the icons take the colour too), and what its press adds to
 * the press scale (spec §8.3).
 */
const LOOKS: Record<Variant, { host: 'glass' | 'box'; ink: string; weight: number; pressed?: Style['pressed'] }> = {
  glass: { host: 'glass', ink: 'label', weight: 600 },
  glassProminent: { host: 'glass', ink: '#ffffff', weight: 700 },
  filled: { host: 'box', ink: '#ffffff', weight: 600, pressed: { opacity: 0.85 } },
  tinted: { host: 'box', ink: 'accent', weight: 600 },
  plain: { host: 'box', ink: 'accent', weight: 600, pressed: { opacity: 0.55 } },
}

/** The press, lift, tilt and glint every control shares. */
const CONTROL = controlStyle()
/** A box host's springs: the control's, and its fill and opacity, which its hover and press change. */
const BOX_TRANSITION: Style['transition'] = { ...CONTROL.transition, bg: 'snappy', opacity: 'snappy' }

/**
 * A variant's fill (glowing glass's glow and tint, a box's background; the clear glass and plain have none) and its
 * hover (spec §8.3). Glass glints up (`controlStyle`'s hover) as it lifts and tilts. A box host on the Surface is drawn
 * flat in the content pass, where its lift and tilt do not show, so it hovers by its fill: filled 12 % lighter, tinted
 * at 0.24 rather than 0.15, plain fainter.
 */
function paint(variant: Variant, theme: Theme, scheme: ColorScheme): { fill: Style; hover: Style['hover'] } {
  switch (variant) {
    case 'glass': return { fill: {}, hover: CONTROL.hover }
    case 'glassProminent': return { fill: { glass: { glow: { color: 'accent', strength: 1.1 }, tint: glowingTint(theme, scheme), absorption: 1.4 } }, hover: CONTROL.hover }
    case 'filled': return { fill: { bg: 'accent' }, hover: { bg: towardWhite('accent', 0.12, theme, scheme) } }
    case 'tinted': return { fill: { bg: withAlpha('accent', 0.15, theme, scheme) }, hover: { bg: withAlpha('accent', 0.24, theme, scheme) } }
    case 'plain': return { fill: {}, hover: { opacity: 0.7 } }
  }
}

/** The icons' stroke, of their size: the reference's centred icon + label groups (the playground's pills). */
const ICON_WEIGHT = 0.12
/** The loading dots: 6 pt across, 5 pt apart, the bright one stepping every 300 ms, the others at 0.35. */
const DOT = { size: 6, gap: 5, stepMs: 300, dim: 0.35 } as const
/** The dots' row: over the whole Button, centred. */
const DOTS: Style = { position: 'absolute', inset: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: DOT.gap }

export const Button = defineGlassComponent({
  name: 'Button',
  description: '按钮（Liquid Glass 控件）。variant 决定外观：glass 清玻璃（次要操作，默认）；glassProminent 带强调色发光的玻璃，白色粗体文字（主操作，每屏通常只有一个）；filled 实心强调色、tinted 淡强调色底、plain 无底的强调色文字（这三种不是玻璃）。size：small 高 36、regular 高 52、large 高 80（参考稿主按钮的尺寸）；文字、图标、左右留白随尺寸。shape：capsule 胶囊（默认）、roundedRectangle 圆角矩形（圆角为高的 23%）、circle 正圆（只放图标：用 leadingIcon 或默认插槽，不能有 label）。内容是前置图标 + 文字 + 后置图标，居中成一组，宽度随内容；fullWidth 让它在交叉轴拉满父容器。注意父容器纵向且 align 为 stretch（Stack、Box 的默认）时子项本来就会被拉宽：要按内容宽度就给父容器 align="start" 或 "center"。鼠标、触控笔悬停时上浮 6 pt、朝指针倾斜（最多 3°）：玻璃按钮高光增强；filled 底色变亮、tinted 底色加深、plain 变淡（这三种画在平面上，上浮与倾斜只在玻璃上——如 Card 里——才看得出）。按下缩到 0.96（filled、plain 同时变淡）；触屏没有悬停效果，减少动态效果时不倾斜。点击、Enter、空格（按下时显示按压，松开时触发）都发出 press；可以用 Tab 聚焦，键盘聚焦时显示焦点环。loading 时内容换成三个轮流变亮的点（宽度不变），按钮不响应；disabled 时变淡、不响应、不在 Tab 顺序里。放在 Card 里按嵌套玻璃绘制。',
  props: z.object({
    variant: z.enum(VARIANTS).default('glass').describe('外观：glass 清玻璃（默认，次要操作）、glassProminent 发光玻璃（主操作）、filled 实心强调色、tinted 淡强调色底、plain 无底强调色文字'),
    size: z.enum(['small', 'regular', 'large']).default('regular').describe('尺寸：small 高 36、regular 高 52（默认）、large 高 80'),
    shape: z.enum(['capsule', 'roundedRectangle', 'circle']).default('capsule').describe('形状：capsule 胶囊（默认）、roundedRectangle 圆角矩形（圆角为高的 23%）、circle 正圆（只放图标，不能有 label）'),
    label: z.string().optional().describe('按钮文字；给了默认插槽时由插槽代替'),
    leadingIcon: z.enum(ICON_NAMES).optional().describe('文字前的内置图标（circle 的图标也写在这里）；给了 leading 插槽时由插槽代替'),
    trailingIcon: z.enum(ICON_NAMES).optional().describe('文字后的内置图标；给了 trailing 插槽时由插槽代替'),
    loading: z.boolean().default(false).describe('加载中：内容换成三个轮流变亮的点，宽度不变，按钮不响应'),
    disabled: z.boolean().default(false).describe('禁用：变淡（不透明度 0.4），不响应指针和键盘，不在 Tab 顺序里'),
    fullWidth: z.boolean().default(false).describe('在父容器的交叉轴上拉满（纵向容器里即占满整行宽度）'),
    glassId: z.string().optional().describe('玻璃形变标识，只在 GlassContainer 里生效（GlassContainer 尚未提供，Task 17 起；现在设置它没有效果）：同一 glassId 的按钮从一处换到另一处时，从旧位置形变过去'),
  }),
  events: { press: { payload: "{ pointerType: 'mouse' | 'touch' | 'pen' | 'xr' | 'keyboard' }", description: '按钮被触发：点击（带指针类型）、Enter 键，或空格键松开（keyboard）；禁用或加载中时不发' } },
  slots: { default: '代替 label 的内容', leading: '代替 leadingIcon 的前置内容', trailing: '代替 trailingIcon 的后置内容' },
  examples: [
    '<Button variant="glassProminent" size="large" label="Create account" trailing-icon="arrow-right" full-width @press="submit" />',
    '<Stack direction="horizontal" :gap="12" align="center"><Button label="取消" @press="close" /><Button variant="glassProminent" label="保存" leading-icon="check" :loading="saving" @press="save" /></Stack>',
    '<Button shape="circle" leading-icon="plus" @press="add" />',
  ],
  mistakes: [
    { mistake: '<Button label="提交" @click="submit" />', fix: '@press="submit"：press 还覆盖 Enter 与空格键，禁用、加载中时不发；@click 落到宿主节点上，禁用时照样触发' },
    { mistake: '<Button shape="circle" label="添加" />', fix: 'circle 只放图标：<Button shape="circle" leading-icon="plus" />；要文字就用默认的 capsule' },
    { mistake: '<Button variant="primary" />', fix: '主操作用 variant="glassProminent"，次要操作用默认的 glass' },
    { mistake: '<Button><Text value="保存" /></Button>', fix: '<Button label="保存" />：label 按尺寸取字号，按 variant 取颜色与字重' },
    { mistake: '<Stack><Button label="确定" /></Stack>（以为按钮按内容宽度）', fix: '纵向 Stack 默认 align stretch，会把按钮拉满整行：按内容宽度用 <Stack align="start">（或 center）；要拉满就明写 full-width' },
    { mistake: '<Button :variant="saved ? \'filled\' : \'glass\'" />（运行时在玻璃与非玻璃外观之间切换）', fix: 'glass、glassProminent 是玻璃节点，filled、tinted、plain 是普通 box：两组之间切换会重建按钮节点，焦点和进行中的动画（上浮、倾斜、按压）都会丢失；运行时切换外观就在同一组里切（glass ↔ glassProminent，或 filled ↔ tinted ↔ plain）' },
  ],
  // names from other UI kits and icon sets → ours, for the error's suggestion only
  aliases: {
    variant: {
      primary: 'glassProminent', prominent: 'glassProminent', borderedprominent: 'glassProminent', secondary: 'glass', default: 'glass', clear: 'glass',
      solid: 'filled', fill: 'filled', bordered: 'tinted', tint: 'tinted', soft: 'tinted', text: 'plain', link: 'plain', ghost: 'plain', borderless: 'plain',
    },
    size: { sm: 'small', mini: 'small', md: 'regular', medium: 'regular', normal: 'regular', lg: 'large', big: 'large' },
    shape: { pill: 'capsule', round: 'circle', rounded: 'roundedRectangle', rect: 'roundedRectangle', square: 'roundedRectangle' },
    leadingIcon: ICON_ALIASES, trailingIcon: ICON_ALIASES,
  },
}, (p, { slots, emit }) => {
  const scheme = useScheme(), theme = useTheme(), live = useMotion() === 'live'
  const el = shallowRef<Node | null>(null)
  /** The props, null while they are invalid (the render throws that error; nothing here should throw it again). */
  const valid = computed(() => { try { return p.value } catch { return null } })
  // loading or disabled (or invalid): no press, no hover
  const inert = computed(() => !valid.value || valid.value.disabled || valid.value.loading)
  const { handlers } = useGlassControl(el, { disabled: inert, onActivate: e => { emit('press', e) } })

  // the loading dots: with live motion the bright one steps on a timer while loading; frozen motion lights the middle one
  const bright = ref(live ? 0 : 1)
  let timer: ReturnType<typeof setInterval> | undefined
  const stop = (): void => { clearInterval(timer); timer = undefined }
  if (live) {
    watch(() => valid.value?.loading === true, on => {
      stop(); bright.value = 0
      if (on) timer = setInterval(() => { bright.value = (bright.value + 1) % 3 }, DOT.stepMs)
    }, { immediate: true })
  }
  onBeforeUnmount(stop)

  return () => {
    const v = p.value, t = theme.value, look = LOOKS[v.variant], size = sizeOf(v.size, t), circle = v.shape === 'circle'
    if (circle && v.label !== undefined) throw new GlassUIError('Button.shape', 'circle 只能放图标（去掉 label 或改 shape）')
    const { fill, hover } = paint(v.variant, t, scheme.value)
    const style: Style = {
      height: size.height, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      paddingX: circle ? 0 : size.padX, radius: v.shape === 'roundedRectangle' ? Math.round(size.height * 0.23) : 'capsule',
      ...(circle ? { width: size.height } : {}), ...(v.fullWidth ? { alignSelf: 'stretch' } : {}),
      ...fill,
      transition: look.host === 'box' ? BOX_TRANSITION : CONTROL.transition,
      // an inert Button shows no hover or press (the pointer tracker still presses it)
      ...(inert.value ? {} : { hover, pressed: { ...CONTROL.pressed, ...look.pressed } }),
      disabled: { opacity: 0.4 },
    }
    const icon = (name: IconName): VNodeChild => h(Icon, { name, size: size.icon, color: look.ink, weight: ICON_WEIGHT })
    const content: VNodeChild[] = [
      slots.leading ? slots.leading() : v.leadingIcon ? icon(v.leadingIcon) : null,
      slots.default ? slots.default() : v.label !== undefined ? h(Text, { value: v.label, size: size.font, weight: look.weight, color: look.ink, maxLines: 1 }) : null,
      slots.trailing ? slots.trailing() : v.trailingIcon ? icon(v.trailingIcon) : null,
    ]
    // loading hides the content rather than dropping it, so the Button keeps its width; the dots ride over it
    const row = h('box', { style: { flexDirection: 'row', alignItems: 'center', gap: size.gap, ...(v.loading ? { opacity: 0 } : {}) } }, content)
    const dots = v.loading
      ? h('box', { style: DOTS }, [0, 1, 2].map(i => h('box', { key: i, dot: i, style: { width: DOT.size, height: DOT.size, radius: 'capsule', bg: look.ink, opacity: i === bright.value ? 1 : DOT.dim } })))
      : null
    return h(look.host, {
      ref: el, style, tabIndex: v.disabled ? -1 : 0, disabled: v.disabled, busy: v.loading,
      ...(v.glassId !== undefined ? { glassId: v.glassId } : {}), ...handlers,
    }, [row, dots])
  }
})
