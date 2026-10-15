import { Comment, createTextVNode, Fragment, h, isVNode, type VNode } from '@vue/runtime-core'
import { z } from 'zod'
import type { Style } from '@glassui/core'
import { defineGlassComponent } from '../define'

const ALIGN = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' } as const
const JUSTIFY = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between' } as const

/** A slot's children one by one, for the layers of a `z` stack: fragments (`v-for`) flattened, `v-if` comments and empty children dropped. */
function layers(children: readonly unknown[] | undefined, out: VNode[] = []): VNode[] {
  for (const c of children ?? []) {
    if (c == null || typeof c === 'boolean') continue
    if (typeof c === 'string' || typeof c === 'number') out.push(createTextVNode(String(c)))
    else if (Array.isArray(c)) layers(c, out)
    else if (isVNode(c) && c.type === Fragment && Array.isArray(c.children)) layers(c.children, out)
    else if (isVNode(c) && c.type !== Comment) out.push(c)
  }
  return out
}

export const Stack = defineGlassComponent({
  name: 'Stack',
  description: '把子项排成一列（vertical，默认）、一行（horizontal）或叠在一起（z）。gap 是子项间距（pt，默认 8）；align 是交叉轴对齐，justify 是主轴分布。z 时每个子项各占一层、铺满整个 Stack（绝对定位，inset 0），align / justify 作用在每层之内；层不撑开 Stack，所以 z 的 Stack 要给定尺寸。',
  props: z.object({
    direction: z.enum(['horizontal', 'vertical', 'z']).default('vertical').describe('排列方向：vertical 一列、horizontal 一行、z 叠放'),
    gap: z.number().min(0).default(8).describe('子项间距，pt（z 时不用）'),
    align: z.enum(['start', 'center', 'end', 'stretch']).optional().describe('交叉轴对齐（默认 stretch）'),
    justify: z.enum(['start', 'center', 'end', 'between']).optional().describe('主轴分布（默认 start）'),
    wrap: z.boolean().optional().describe('一行（列）放不下时换行（z 时不用）'),
  }),
  slots: { default: '子项' },
  examples: [
    '<Stack direction="horizontal" :gap="12" align="center"><Icon name="mail" /><Text value="邮箱" /></Stack>',
    '<Stack :gap="16"><Text value="标题" :size="24" :weight="700" /><Text value="说明" color="secondaryLabel" /></Stack>',
    '<Stack direction="z" align="center" justify="center" :style="{ width: 64, height: 64 }"><Box tw="w-full h-full rounded-xl bg-accent" /><Icon name="star" color="#ffffff" /></Stack>',
  ],
  mistakes: [
    { mistake: 'gap="12"', fix: ':gap="12"（数字要绑定）' },
    { mistake: 'direction="row"', fix: 'direction="horizontal"（列是 vertical，叠放是 z）' },
    { mistake: '<Stack direction="z">（不给尺寸）', fix: '层是绝对定位的，不撑开 Stack：用 :style 或 tw 给它宽高' },
  ],
}, (p, { slots }) => () => {
  const v = p.value
  const place: Style = { ...(v.align ? { alignItems: ALIGN[v.align] } : {}), ...(v.justify ? { justifyContent: JUSTIFY[v.justify] } : {}) }
  if (v.direction === 'z') {
    // each layer in a box filling the Stack; keyed by its child's key, so a keyed reorder moves the layers
    return h('box', layers(slots.default?.()).map((c, i) => h('box', { key: c.key ?? `layer-${i}`, style: { position: 'absolute', inset: 0, ...place } }, [c])))
  }
  return h('box', { style: { flexDirection: v.direction === 'horizontal' ? 'row' : 'column', gap: v.gap, ...place, ...(v.wrap ? { flexWrap: 'wrap' } : {}) } }, slots.default?.())
})
