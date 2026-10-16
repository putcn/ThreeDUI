import { h } from '@vue/runtime-core'
import { z } from 'zod'
import type { Style } from '@glassui/core'
import { defineGlassComponent } from '../define'
import { Text } from './Text'

/**
 * A Card's own style; the user's `style` / `tw` / `class` merge over it. Rulings of Task 9F: a fixed 12 pt slab rather
 * than the theme's thickness, which is a ratio of the short side (a 300 pt card would be 60 pt thick); the theme's `xl`
 * radius (24 pt) rather than `concentric`, which in a Block came to 8 pt (48 less the 40 pt padding) and to 0 in any
 * layout box between them.
 */
const CARD: Style = { bg: 'glass', radius: 'xl', padding: 24, gap: 12, flexDirection: 'column', glass: { thickness: 12, fillet: 4, filletBottom: 2 } }

export const Card = defineGlassComponent({
  name: 'Card',
  description: 'Block 里的分组容器：一块更薄的玻璃（厚 12 pt），圆角 24 pt（主题的 xl），默认纵向排列、padding 24、gap 12，放在 Block 里、Stack 里都一样。title 是排在最上面的标题（17 pt、600 字重）。tw / class / style 落到 Card 本身，覆盖这些默认值（如 :style="{ flexGrow: 1, flexBasis: 0 }" 让几张 Card 平分一行，tw="rounded-lg" 换圆角）。里面可以再放玻璃控件（按钮、输入框），它们按嵌套玻璃绘制。Card 自己就是玻璃，不用再包玻璃的 Box。',
  props: z.object({
    title: z.string().optional().describe('标题，17 pt、600 字重，排在内容最上面；省略时没有标题'),
  }),
  slots: { default: '卡片内容' },
  examples: [
    '<Card title="本周活跃"><Text value="1,284" size="3xl" :weight="700" /><Text value="比上周 +12%" color="success" size="sm" /></Card>',
    '<Stack direction="horizontal" :gap="16"><Card title="完成任务" :style="{ flexGrow: 1, flexBasis: 0 }"><Text value="36" size="3xl" :weight="700" /></Card><Card title="存储用量" :style="{ flexGrow: 1, flexBasis: 0 }"><Text value="68%" size="3xl" :weight="700" /></Card></Stack>',
    '<Card tw="p-4" :style="{ gap: 8 }"><Text value="通知" :weight="600" /><Text value="每天 9:00 推送摘要" color="secondaryLabel" /></Card>',
  ],
  mistakes: [
    { mistake: '<Card><Box tw="bg-glass rounded-xl p-4">…</Box></Card>（Card 里再包一层玻璃 Box）', fix: 'Card 不需要再包一层玻璃 Box：内容直接放进 Card；要改内边距或圆角就写在 Card 上（tw="p-4"）' },
    { mistake: '<Block …><Card>（整个 Block 的内容）</Card></Block>', fix: 'Block 本身就是玻璃背板：内容直接放进 Block；Card 只用来在 Block 里分组（几张 Card 并排或上下排）' },
  ],
}, (p, { slots }) => () => {
  const { title } = p.value
  return h('box', { style: CARD }, [title ? h(Text, { value: title, size: 17, weight: 600 }) : null, ...slots.default?.() ?? []])
})
