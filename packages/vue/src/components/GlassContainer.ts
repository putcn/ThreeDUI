import { h } from '@vue/runtime-core'
import { z } from 'zod'
import { defineGlassComponent } from '../define'

/**
 * Apple's `GlassEffectContainer` (spec §5.2, §8.2): a row (or column) whose box is a glass container
 * (`props.glassContainer`), so the plain glass under it fuses into one slab where the shapes come within `spacing` of
 * each other. The fusing itself is the render list's and the Surface's (Task 16): only plain glass fuses (no glow, the
 * cluster's variant and tint); a glowing or tinted member stands apart with its own rim.
 */
export const GlassContainer = defineGlassComponent({
  name: 'GlassContainer',
  description: '玻璃容器（对应 Apple 的 GlassEffectContainer）：把子项排成一行（horizontal，默认）或一列（vertical），间距 gap（pt，默认 8），交叉轴居中；里面相邻的玻璃控件形状相距小于 spacing（pt，默认 16）时融合成一整块液态玻璃，拉开到 spacing 以上又各自分开。用于工具栏、导航坞、分段按钮组这类一排玻璃按钮。只有素玻璃会融合：variant="glass" 的 Button 这类没有发光、没有着色的玻璃。工具栏里的主按钮（glassProminent、filled、tinted）单独成一块，不与旁边的素玻璃融合——这是有意的，就像 Apple 工具栏里被选中的项：glassProminent（发光）和 Switch（无论开关都带着色）是带自己边缘的单独玻璃，旁边的素玻璃在它两侧各自融合；filled、tinted、plain 的 Button 本来就不是玻璃。悬停的那一个上浮时整块玻璃跟着它的高度与高光。配合 Button 的 glassId：同一应用、同一个仍存活的 Surface 里，同一 glassId 的按钮被移除、500 ms 内在别处重新挂载时，新按钮从旧按钮的位置和大小形变过去，在容器里与相遇的素玻璃融合。容器本身不是玻璃，不画背景。',
  props: z.object({
    spacing: z.number().min(0).default(16).describe('融合距离，pt（默认 16）：两块玻璃的形状相距小于它时融成一块；gap 要小于它，按钮才会融合'),
    direction: z.enum(['horizontal', 'vertical']).default('horizontal').describe('排列方向：horizontal 一行（默认）、vertical 一列'),
    gap: z.number().min(0).default(8).describe('子项间距，pt（默认 8）；不小于 spacing 时按钮之间不融合'),
  }),
  slots: { default: '子项：通常是一排 Button（shape="circle" 的图标按钮或胶囊按钮）' },
  examples: [
    '<GlassContainer><Button shape="circle" leading-icon="plus" @press="zoomIn" /><Button shape="circle" leading-icon="minus" @press="zoomOut" /><Button shape="circle" leading-icon="search" @press="find" /></GlassContainer>',
    '<GlassContainer :spacing="16" :gap="8"><Button v-for="v in views" :key="v.name === current ? v.name + \'-on\' : v.name" shape="circle" :leading-icon="v.icon" :variant="v.name === current ? \'glassProminent\' : \'glass\'" :glass-id="v.name === current ? \'dock-active\' : undefined" @press="current = v.name" /></GlassContainer>',
    '<GlassContainer direction="vertical" :gap="6"><Button label="今日" size="small" /><Button label="本周" size="small" /><Button label="本月" size="small" /></GlassContainer>',
  ],
  mistakes: [
    {
      mistake: '<GlassContainer><Button variant="glassProminent" label="保存" /><Button label="取消" /></GlassContainer>（以为主按钮也会融进那一条）',
      fix: '工具栏里的主按钮（glassProminent、filled、tinted）不与旁边的素玻璃融合，单独成一块：glassProminent 是带自己边缘的发光玻璃，filled、tinted 本来就不是玻璃。这是有意的，就像 Apple 工具栏里被选中的项；要融成一条就都用默认的 variant="glass"',
    },
    { mistake: '<GlassContainer :spacing="8" :gap="12">', fix: 'gap 不小于 spacing 时按钮之间永远不融合：融合的工具栏用 gap 小于 spacing（默认 gap 8、spacing 16）' },
    { mistake: 'spacing="16" / gap="8"', fix: ':spacing="16" / :gap="8"（数字要绑定）' },
    { mistake: '<GlassContainer tw="flex-col">', fix: 'direction="vertical"：方向、间距用属性（容器自己的布局优先，tw 里的 flex-col、gap-* 不会生效）' },
    { mistake: '<GlassContainer><Card>…</Card></GlassContainer>（把内容区放进容器）', fix: 'GlassContainer 用于融合一排玻璃按钮（工具栏、导航坞）；玻璃内容容器用 Card，普通布局用 Box' },
  ],
  aliases: {
    direction: { row: 'horizontal', column: 'vertical', col: 'vertical', x: 'horizontal', y: 'vertical' },
  },
}, (p, { slots }) => () => {
  const v = p.value
  return h('box', {
    glassContainer: { spacing: v.spacing },
    style: { flexDirection: v.direction === 'horizontal' ? 'row' : 'column', gap: v.gap, alignItems: 'center' },
  }, slots.default?.())
})
