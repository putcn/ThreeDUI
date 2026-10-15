import { h } from '@vue/runtime-core'
import { z } from 'zod'
import { defineGlassComponent } from '../define'

export const Box = defineGlassComponent({
  name: 'Box',
  description: '通用容器：一个 flex 盒子（默认纵向排列），布局、间距、背景色、圆角都用 tw / style / class 设置。它不是玻璃：玻璃只用于控件（Button、Input、Switch…），内容区不用玻璃。只是把子项排成一行或一列时用 Stack 更直接。',
  props: z.object({}),
  slots: { default: '子项' },
  examples: [
    '<Box tw="flex-row items-center gap-3 p-4"><Icon name="info" /><Text value="提示" /></Box>',
    '<Box :style="{ width: 64, height: 64, bg: \'accent\', radius: 16 }" />',
  ],
  mistakes: [
    { mistake: '<Box tw="bg-glass">（内容区用玻璃）', fix: '玻璃只用于控件；内容区用不透明背景色，如 tw="bg-fill rounded-xl"' },
    { mistake: '<Box direction="horizontal">', fix: 'Box 没有自己的属性：用 tw="flex-row"，或 <Stack direction="horizontal">' },
  ],
}, (_p, { slots }) => () => h('box', slots.default?.()))
