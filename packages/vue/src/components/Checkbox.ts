import { computed, h, shallowRef } from '@vue/runtime-core'
import { z } from 'zod'
import type { Node, Style } from '@glassui/core'
import { controlStyle, TOGGLE_LABEL, useGlassControl } from '../control'
import { defineGlassComponent } from '../define'
import { useTheme } from '../inject'
import { GlassTransition } from '../transition'
import { Icon } from './Icon'
import { Text } from './Text'

/** The press (to 0.9, as the reference's checkbox), lift, tilt and glint. */
const CONTROL = controlStyle({ pressScale: 0.9 })
/** The reference's clear glass for a 44 pt box: a thinner slab than its size would get, small fillets. */
const GLASS: Style['glass'] = { thickness: 14, fillet: 4, filletBottom: 2 }
/** The check (or the dash): 30 pt in the accent, the reference's stroke. */
const MARK = { size: 30, color: 'accent', weight: 0.14 } as const

export const Checkbox = defineGlassComponent({
  name: 'Checkbox',
  description: '复选框（Liquid Glass 控件）：44 × 44、圆角 12 的清玻璃方块，选中时里面是强调色的对勾（缩放淡入），indeterminate 时是一条横线（不论 checked）。受控组件：显示的永远是 checked，用 v-model:checked 双向绑定，点击只发出新值。整行（方块与标签）都能点：点方块或标签、方块聚焦时按 Enter、空格（按下时显示按压，松开时切换）都会切换，依次发出 update:checked 与 change；indeterminate 时切换总是发出 true，父组件收到后自己把 indeterminate 清掉（例如"全选"）。label（或默认插槽）在方块右侧，相距 16 pt。可以用 Tab 聚焦方块，键盘聚焦时显示焦点环；鼠标、触控笔悬停在方块上时上浮 6 pt、朝指针倾斜（最多 3°）、高光增强，按下缩到 0.9；触屏没有悬停效果，减少动态效果时不倾斜。disabled 时整行变淡、不响应、不在 Tab 顺序里。',
  props: z.object({
    checked: z.boolean().default(false).describe('是否选中；用 v-model:checked 双向绑定（受控：组件自己不改它，只发出新值）'),
    indeterminate: z.boolean().default(false).describe('部分选中：显示横线，不论 checked；此时切换发出 checked = true，由父组件清掉 indeterminate'),
    disabled: z.boolean().default(false).describe('禁用：整行（方块与标签）变淡到 0.4，不响应指针和键盘，不在 Tab 顺序里'),
    label: z.string().optional().describe('方块右侧的标签，点击它也会切换；给了默认插槽时由插槽代替'),
  }),
  events: {
    'update:checked': { payload: 'boolean', description: '用户切换后的新值（v-model:checked 靠它更新；indeterminate 时总是 true）；禁用时不发' },
    change: { payload: 'boolean', description: '用户切换了复选框：新值，紧跟 update:checked 发出；禁用时不发' },
  },
  slots: { default: '代替 label 的标签内容（同样在方块右侧，点击也会切换）' },
  examples: [
    '<Checkbox v-model:checked="agree" label="我已阅读并同意服务条款" />',
    '<Checkbox :checked="all" :indeterminate="some && !all" label="全选" @change="selectAll" />',
    '<Checkbox v-model:checked="news" disabled>订阅产品动态</Checkbox>',
  ],
  mistakes: [
    { mistake: '<Checkbox v-model="agree" />', fix: '<Checkbox v-model:checked="agree" />：复选框的值叫 checked，不是 modelValue' },
    { mistake: '<Checkbox label="同意" />（没有绑定，以为点了会自己变）', fix: 'Checkbox 是受控的，显示的永远是 checked：用 v-model:checked="agree"，或 :checked 加 @update:checked 自己接住新值' },
    { mistake: '<Checkbox :checked="all" indeterminate @change="selectAll" />（indeterminate 写死）', fix: ':indeterminate="some && !all"：横线不论 checked 都显示，要由父组件在全选或全不选时把它算成 false' },
  ],
}, (p, { slots, emit }) => {
  const theme = useTheme()
  const el = shallowRef<Node | null>(null)
  /** The props, null while they are invalid (the render throws that error; nothing here should throw it again). */
  const valid = computed(() => { try { return p.value } catch { return null } })
  const inert = computed(() => !valid.value || valid.value.disabled)
  // the row takes the click (the box's and the label's bubble to it); the box takes the hover, the keys and the press
  const { handlers: { onClick, ...box } } = useGlassControl(el, {
    disabled: inert,
    onActivate: () => { const v = p.value, next = v.indeterminate || !v.checked; emit('update:checked', next); emit('change', next) },
  })

  return () => {
    const v = p.value, m = theme.value.metrics
    const style: Style = {
      width: m.checkbox, height: m.checkbox, radius: m.checkboxRadius, flexShrink: 0, alignItems: 'center', justifyContent: 'center',
      glass: GLASS, transition: CONTROL.transition,
      // a disabled Checkbox shows no hover or press (the pointer tracker still presses it)
      ...(inert.value ? {} : { hover: CONTROL.hover, pressed: CONTROL.pressed }),
    }
    // one Icon (its name swaps between the dash and the check in place); the transition scales it in and out
    const mark = v.indeterminate || v.checked ? [h(Icon, { name: v.indeterminate ? 'minus' : 'check', ...MARK })] : []
    const content = slots.default ? slots.default() : v.label !== undefined
      ? [h(Text, { value: v.label, size: TOGGLE_LABEL.size, weight: TOGGLE_LABEL.weight, color: TOGGLE_LABEL.color })]
      : null
    return h('box', {
      style: { flexDirection: 'row', alignItems: 'center', gap: TOGGLE_LABEL.gap, disabled: { opacity: 0.4 } }, disabled: v.disabled, onClick,
    }, [
      h('glass', { ref: el, style, tabIndex: v.disabled ? -1 : 0, disabled: v.disabled, ...box }, [h(GlassTransition, { preset: 'scale' }, () => mark)]),
      content ? h('box', { style: { flexShrink: 1 } }, content) : null,
    ])
  }
})
