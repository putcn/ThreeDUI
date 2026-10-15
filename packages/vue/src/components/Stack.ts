import { Comment, createTextVNode, Fragment, h, isVNode, normalizeClass, type VNode } from '@vue/runtime-core'
import { z } from 'zod'
import { GlassUIError, parseTw, type Style, type Theme } from '@glassui/core'
import { defineGlassComponent } from '../define'
import { useRoot } from '../inject'

const ALIGN = { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' } as const
const JUSTIFY = { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between' } as const

/**
 * A slot's children one by one, for the layers of a `z` stack: fragments (`v-for`) flattened, `v-if` comments and empty
 * children dropped. Each gets the key of its layer: its fragment path, then its own key (or its index there), so a
 * `v-if` branch's key (`0`, `1`…) and a `v-for` item's (often 0-based too) never collide, while a keyed reorder within
 * one `v-for` keeps each item's layer.
 */
function layers(children: readonly unknown[] | undefined, path = '', out: { vnode: VNode; key: string }[] = []): { vnode: VNode; key: string }[] {
  (children ?? []).forEach((c, i) => {
    if (c == null || typeof c === 'boolean') return
    if (Array.isArray(c)) layers(c, `${path}${i}.`, out)
    else if (isVNode(c) && c.type === Fragment && Array.isArray(c.children)) layers(c.children, `${path}${i}.`, out)
    else if (isVNode(c) && c.type === Comment) return
    else {
      const vnode = isVNode(c) ? c : createTextVNode(String(c))
      out.push({ vnode, key: `${path}|${vnode.key == null ? `#${i}` : String(vnode.key)}` })
    }
  })
  return out
}

/** Style keys Stack's own props set: a `tw` / `class` setting one would lose to them (the style layer wins), so it is an error. */
const OWN: Partial<Record<keyof Style, (v: unknown) => string>> = {
  flexDirection: v => v === 'row' ? 'direction="horizontal"' : v === 'column' ? 'direction="vertical"（默认，可省略）' : '反向排列用 <Box>，Stack 不支持',
  gap: v => `:gap="${String(v)}"`,
  alignItems: v => v === 'baseline' ? '基线对齐用 <Box tw="flex-row items-baseline">，Stack 不支持' : `align="${({ 'flex-start': 'start', center: 'center', 'flex-end': 'end', stretch: 'stretch' } as Record<string, string>)[String(v)]}"`,
  justifyContent: v => {
    const j = ({ 'flex-start': 'start', center: 'center', 'flex-end': 'end', 'space-between': 'between' } as Record<string, string>)[String(v)]
    return j ? `justify="${j}"` : `${String(v)} 用 <Box>，Stack 不支持`
  },
  flexWrap: v => v === 'wrap' ? 'wrap（布尔属性）' : '去掉它（Stack 默认不换行）',
}
const PROP_OF: Partial<Record<keyof Style, string>> = { flexDirection: 'direction', gap: 'gap', alignItems: 'align', justifyContent: 'justify', flexWrap: 'wrap' }

/** Throws when a class in the user's `tw` / `class` sets a layout key Stack's props own; a class that does not parse is left to the renderer's error. */
function checkClasses(attrs: Record<string, unknown>, theme: Theme): void {
  for (const attr of ['tw', 'class'] as const) {
    if (attrs[attr] == null) continue
    for (const cls of normalizeClass(attrs[attr]).split(/\s+/).filter(Boolean)) {
      let parsed: Style
      try { parsed = parseTw(cls, theme, attr) } catch { continue }
      for (const k of Object.keys(parsed) as (keyof Style)[]) {
        const use = OWN[k]
        if (use) throw new GlassUIError(`Stack.${attr}`, `"${cls}" 与 Stack 的 ${PROP_OF[k]} 属性冲突（Stack 自己的布局优先，它不会生效）：用 ${use(parsed[k])}`)
      }
    }
  }
}

export const Stack = defineGlassComponent({
  name: 'Stack',
  description: '把子项排成一列（vertical，默认）、一行（horizontal）或叠在一起（z）。gap 是子项间距（pt，默认 8）；align 是交叉轴对齐，justify 是主轴分布。方向、间距、对齐、分布和换行只用这些属性：tw / class 里写同类的类（flex-row、gap-4、items-center、justify-between、flex-wrap）会报错。z 时每个子项各占一层、铺满整个 Stack（绝对定位，inset 0），align / justify 作用在每层之内，指针穿过层的空白处落到下面的层；层不撑开 Stack，所以 z 的 Stack 要给定尺寸。',
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
    { mistake: '<Stack tw="flex-row gap-4 items-center">', fix: '<Stack direction="horizontal" :gap="16" align="center">（布局用属性，tw 只放间距、背景等其他样式）' },
    { mistake: '<Stack direction="z">（不给尺寸）', fix: '层是绝对定位的，不撑开 Stack：用 :style 或 tw 给它宽高' },
  ],
}, (p, { slots, attrs }) => {
  const root = useRoot()
  return () => {
    const v = p.value
    const place: Style = { ...(v.align ? { alignItems: ALIGN[v.align] } : {}), ...(v.justify ? { justifyContent: JUSTIFY[v.justify] } : {}) }
    if (v.direction === 'z') {
      // each layer in a box filling the Stack; `'box-none'`: the box itself lets the pointer through to the layers below
      // (it fills the whole Stack), its child inherits what is above the Stack. Keyed by its path and its child's key,
      // so a keyed reorder moves the layers
      return h('box', layers(slots.default?.()).map(({ vnode, key }) => h('box', { key, style: { position: 'absolute', inset: 0, pointerEvents: 'box-none', ...place } }, [vnode])))
    }
    checkClasses(attrs, root.theme)
    return h('box', { style: { flexDirection: v.direction === 'horizontal' ? 'row' : 'column', gap: v.gap, ...place, ...(v.wrap ? { flexWrap: 'wrap' } : {}) } }, slots.default?.())
  }
})
