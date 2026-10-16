import { h, shallowRef } from '@vue/runtime-core'
import { z } from 'zod'
import type { Node, Style } from '@glassui/core'
import { glowingTint } from '../colors'
import { controlStyle } from '../control'
import { defineGlassComponent } from '../define'
import { knobCanvas } from '../icons'
import { useCanvasFactory, useScheme, useTheme } from '../inject'
import { toggleLabel, toggleRow, useToggle } from './toggle'

/** The press, lift, tilt and glint every control shares. */
const CONTROL = controlStyle()
/** The control's springs, and `smooth` for the glass: the glow's strength and split and the tint follow the knob over. */
const TRANSITION: Style['transition'] = { ...CONTROL.transition, glass: 'smooth' }
/** The knob slides (its `left`) and stretches (its width) `snappy`. */
const KNOB_TRANSITION: Style['transition'] = { x: 'snappy', width: 'snappy' }
/** Room around the knob's disc for its soft shadow, pt, each side (the playground's decal). */
const KNOB_PAD = 4
/** How much wider the knob is while pressed, pt: 48 → 58. */
const KNOB_STRETCH = 10
/**
 * The off switch's tint: white, at no absorption, is what the render draws for no tint at all (a white tint absorbs
 * nothing, lights the shell white and counts as untinted in the `fill` mode), and unlike a missing tint it animates:
 * turning off fades the glowing tint out with the glow instead of dropping it at once.
 */
const UNTINTED = '#ffffff'

export const Switch = defineGlassComponent({
  name: 'Switch',
  description: '开关（Liquid Glass 控件）：136 × 62 的胶囊玻璃，上面一颗白色圆形旋钮。受控组件：显示的永远是 checked，用 v-model:checked 双向绑定，点击只发出新值。打开时旋钮在右，玻璃发出强调色的光并染上强调色，光在旋钮处柔和地截止；关闭时旋钮在左，是清玻璃。切换时旋钮滑过去，发光与染色随之渐变；按住时旋钮朝中间拉长到 58 pt（外侧边缘不动）。点击开关或标签、Enter、空格（按下时显示按压，松开时切换）都会切换，依次发出 update:checked 与 change；按住标签时开关显示按压，点标签还会让开关获得焦点（不显示焦点环），同 HTML 的 label。可以用 Tab 聚焦，键盘聚焦时显示焦点环。label（或默认插槽）在开关左侧，右对齐、相距 16 pt（参考稿的 "Remember me"）；行被父容器拉宽时整行靠右（开关贴在右边）。鼠标、触控笔悬停时上浮 6 pt、朝指针倾斜（最多 3°）、高光增强；按下缩到 0.96；触屏没有悬停效果，减少动态效果时不倾斜。disabled 时整行变淡、不响应、不在 Tab 顺序里。',
  props: z.object({
    checked: z.boolean().default(false).describe('是否打开；用 v-model:checked 双向绑定（受控：组件自己不改它，只发出新值）'),
    disabled: z.boolean().default(false).describe('禁用：整行（开关与标签）变淡到 0.4，不响应指针和键盘，不在 Tab 顺序里'),
    label: z.string().optional().describe('开关左侧的标签，右对齐，点击它也会切换；给了默认插槽时由插槽代替'),
  }),
  events: {
    'update:checked': { payload: 'boolean', description: '用户切换后的新值（v-model:checked 靠它更新）；禁用时不发' },
    change: { payload: 'boolean', description: '用户切换了开关：新值，紧跟 update:checked 发出；禁用时不发' },
  },
  slots: { default: '代替 label 的标签内容（同样在开关左侧，点击也会切换）' },
  examples: [
    '<Switch v-model:checked="remember" label="记住我" />',
    '<Stack direction="horizontal" :gap="12" align="center"><Text value="飞行模式" /><Switch v-model:checked="airplane" @change="save" /></Stack>',
    '<Switch :checked="true" disabled label="由管理员开启" />',
  ],
  mistakes: [
    { mistake: '<Switch v-model="on" />', fix: '<Switch v-model:checked="on" />：开关的值叫 checked，不是 modelValue' },
    { mistake: '<Switch label="通知" />（没有绑定，以为点了会自己变）', fix: 'Switch 是受控的，显示的永远是 checked：用 v-model:checked="notify"，或 :checked 加 @update:checked 自己接住新值' },
    { mistake: '<Switch v-model:checked="on" @click="save" />', fix: '@change="save"：change 也覆盖 Enter、空格与点标签，禁用时不发；@click 落到外层的行上，禁用时照样触发' },
    { mistake: '<Stack><Switch v-model:checked="wifi" label="Wi-Fi" /></Stack>（以为开关在左边）', fix: '纵向 Stack 默认 align stretch，会把开关这一行拉满，行内靠右排（参考稿 "Remember me" 的排法：开关贴在右边，标签右对齐紧挨它）；要放在左边就给父容器 align="start"（或 center），或只给这个开关 :style="{ alignSelf: \'flex-start\' }"' },
  ],
}, (p, { slots, emit }) => {
  const scheme = useScheme(), theme = useTheme(), createCanvas = useCanvasFactory()
  const el = shallowRef<Node | null>(null)
  const { handlers, label, pressing, inert } = useToggle(el, p, emit, v => !v.checked)

  return () => {
    const v = p.value, t = theme.value, m = t.metrics, W = m.switchWidth, H = m.switchHeight
    /** The knob centre's distance from the switch centre (spec §8.2): W/2 − margin − knob/2. */
    const knobX = W / 2 - m.knobMargin - m.knob / 2
    // the decal: the disc and its shadow room; pressed, stretched toward the middle, its outer edge kept
    const size = m.knob + 2 * KNOB_PAD, stretch = pressing.value ? KNOB_STRETCH : 0, width = size + stretch
    const left = v.checked ? W / 2 + knobX + size / 2 - width : W / 2 - knobX - size / 2
    // the glow stays (strength 0 off) with its split, and the tint fades to white, so the runtime animates all of them
    const glass: Style['glass'] = v.checked
      ? { glow: { color: 'accent', strength: 1.1, split: 0.5 + knobX / W }, tint: glowingTint(t, scheme.value), absorption: 1.4 }
      : { glow: { color: 'accent', strength: 0, split: 0.5 - knobX / W }, tint: UNTINTED, absorption: 0 }
    const style: Style = {
      width: W, height: H, radius: 'capsule', flexShrink: 0, glass, transition: TRANSITION,
      // a disabled Switch shows no hover or press (the pointer tracker still presses it)
      ...(inert.value ? {} : { hover: CONTROL.hover, pressed: CONTROL.pressed }),
    }
    const knob = h('image', {
      src: knobCanvas(size, m.knob, createCanvas, stretch),
      style: { position: 'absolute', left, top: (H - size) / 2, width, height: size, transition: KNOB_TRANSITION },
    })
    // the label, right-aligned against the switch, packed right with it; a sibling of the glass, so its click and the
    // switch's own never both reach one handler
    return toggleRow(v.disabled, [
      toggleLabel(slots, v.label, label, 'right'),
      h('glass', { ref: el, style, tabIndex: v.disabled ? -1 : 0, disabled: v.disabled, ...handlers }, [knob]),
    ], { justifyContent: 'flex-end' })
  }
})
