import { h, inject, onBeforeUnmount, onMounted, shallowRef, watch } from '@vue/runtime-core'
import { z } from 'zod'
import type { Node, Style, UIEvent } from '@glassui/core'
import { tiltToward } from '../control'
import { defineGlassComponent } from '../define'
import { useMotion, useRoot } from '../inject'
import { BLOCK } from '../spatial/context'
import { Text } from './Text'

/**
 * A Card's depth (spatial spec §11.3): its elevation at rest and hovered (pt), its largest hover tilt each way
 * (radians), and the delay between the Cards of one rise-in (seconds).
 */
export const CARD_DEPTH = { rest: 24, hover: 40, tilt: 4 * Math.PI / 180, stagger: 0.06 } as const

/**
 * A Card's own style; the user's `style` merges over it (its `transition` key by key). Rulings of Task 9F: a fixed
 * 12 pt slab rather than the theme's thickness, which is a ratio of the short side (a 300 pt card would be 60 pt thick);
 * the theme's `xl` radius (24 pt) rather than `concentric`, which in a Block came to 8 pt (48 less the 40 pt padding)
 * and to 0 in any layout box between them. Task 9I: the springs its lift and tilt animate on.
 */
const CARD: Style = {
  bg: 'glass', radius: 'xl', padding: 24, gap: 12, flexDirection: 'column', glass: { thickness: 12, fillet: 4, filletBottom: 2 },
  transition: { elevation: 'smooth', tilt: 'snappy' },
}

export const Card = defineGlassComponent({
  name: 'Card',
  description: 'Block 里的分组容器：一块更薄的玻璃（厚 12 pt），圆角 24 pt（主题的 xl），默认纵向排列、padding 24、gap 12，放在 Block 里、Stack 里都一样。它浮在背板上方 24 pt，在背板上投下真实的阴影；指针悬停时上浮到 40 pt 并朝指针倾斜（每个方向最多 4°），离开时回落。悬停只在焦点 Block 里有（非焦点 Block 的内容不接收指针），触屏没有悬停效果，减少动态效果时只上浮、不倾斜。Block 进场时，里面的 Card 从 0 升到 24 pt，一起出现的按出现顺序每张晚 60 ms；motion 为 frozen 时直接就位。这些都是 Card 自带的，不用写什么。title 是排在最上面的标题（17 pt、600 字重）。style 落到 Card 本身，按键覆盖这些默认值（如 :style="{ flexGrow: 1, flexBasis: 0 }" 让几张 Card 平分一行，:style="{ padding: 16 }" 改内边距）；浮起与倾斜的动画手感也写在 style 的 transition 里（默认 { elevation: smooth, tilt: snappy }）。里面可以再放玻璃控件（按钮、输入框），它们按嵌套玻璃绘制。Card 自己就是玻璃，不用再包玻璃的 Box。',
  props: z.object({
    title: z.string().optional().describe('标题，17 pt、600 字重，排在内容最上面；省略时没有标题'),
  }),
  slots: { default: '卡片内容' },
  examples: [
    '<Card title="本周活跃"><Text value="1,284" size="3xl" :weight="700" /><Text value="比上周 +12%" color="success" size="sm" /></Card>',
    '<Stack direction="horizontal" :gap="16"><Card title="完成任务" :style="{ flexGrow: 1, flexBasis: 0 }"><Text value="36" size="3xl" :weight="700" /></Card><Card title="存储用量" :style="{ flexGrow: 1, flexBasis: 0 }"><Text value="68%" size="3xl" :weight="700" /></Card></Stack>',
    '<Card title="通知" :style="{ padding: 16, gap: 8, transition: { elevation: \'bouncy\' } }"><Text value="每天 9:00 推送摘要" color="secondaryLabel" /></Card>',
  ],
  mistakes: [
    { mistake: '<Card><Box tw="bg-glass rounded-xl p-4">…</Box></Card>（Card 里再包一层玻璃 Box）', fix: 'Card 不需要再包一层玻璃 Box：内容直接放进 Card；要改内边距或圆角就写在 Card 的 style 上（:style="{ padding: 16 }"）' },
    { mistake: '<Card :style="{ elevation: 40 }">（想让 Card 浮得更高或贴住背板）', fix: 'elevation 不是样式：Card 自己管浮起（静止 24 pt，悬停 40 pt，进场从 0 升起）；能调的是动画手感，如 :style="{ transition: { elevation: \'bouncy\' } }"' },
  ],
}, (p, { slots }) => {
  const root = useRoot(), frozen = useMotion() === 'frozen'
  // in a Block: hover only while it is the focus, and a place in its rise-in; elsewhere (a gallery) always, and first
  const block = inject(BLOCK, null), index = block ? block.nextCard() : 0
  const box = shallowRef<Node | null>(null)
  let hovered = false, gone = false, timer: ReturnType<typeof setTimeout> | undefined

  /** Back to rest: no tilt, the resting elevation. */
  const settle = (n: Node): void => { hovered = false; n.tilt = { x: 0, y: 0 }; n.elevation = CARD_DEPTH.rest }
  // up to the hover elevation, tilted so its face turns toward the pointer (`tiltToward`: the edge under it recedes, as
  // a control's does); reduced motion lifts without tilting. Only a mouse or a pen hovers (core spec §8.3): a finger
  // dragging over a Card leaves it at rest, as the rig's parallax does
  const onPointermove = (e: UIEvent): void => {
    const n = box.value
    if (!n || (block && !block.focused.value)) return
    if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return
    hovered = true
    n.elevation = CARD_DEPTH.hover
    n.tilt = root.anim.reducedMotion ? { x: 0, y: 0 } : tiltToward(n, e, CARD_DEPTH.tilt)
  }
  const onPointerleave = (): void => { const n = box.value; if (n && hovered) settle(n) }
  // a Block that loses the focus under a still pointer: its content takes no more pointer events, so no leave comes
  if (block) watch(block.focused, f => { const n = box.value; if (!f && n && hovered) settle(n) })

  // the rise-in: flat on mount, then up after its place in the wave. The wait starts once a tick has recorded the Card
  // at 0, so the runtime animates the rise (a node it first sees already up just stands there). Frozen motion and
  // reduced motion stand it at once
  onMounted(() => {
    const n = box.value
    if (!n) return
    if (frozen || root.anim.reducedMotion) { n.elevation = CARD_DEPTH.rest; return }
    n.elevation = 0
    void root.afterTick().then(() => {
      if (gone) return
      timer = setTimeout(() => { timer = undefined; if (!hovered) n.elevation = CARD_DEPTH.rest }, index * CARD_DEPTH.stagger * 1000)
    })
  })
  onBeforeUnmount(() => { gone = true; clearTimeout(timer) })

  return () => {
    const { title } = p.value
    return h('box', { ref: box, style: CARD, onPointermove, onPointerleave }, [title ? h(Text, { value: title, size: 17, weight: 600 }) : null, ...slots.default?.() ?? []])
  }
})
