import { Comment, Fragment, h, isVNode, Text as TextVNode } from '@vue/runtime-core'
import { z } from 'zod'
import { GlassUIError, type Style } from '@glassui/core'
import { defineGlassComponent } from '../define'
import { useRoot } from '../inject'
import { checkFontSize, colorOf } from './tokens'

/** One run of a `Text`'s `value` array: its own colour, weight or size over the Text's. */
export interface TextFragment { text: string; color?: string; weight?: number; size?: number }

const Weight = z.number().int().min(100).max(900)
const Run = z.object({
  text: z.string(), color: z.string().optional(), weight: Weight.optional(), size: z.number().positive().optional(),
}).strict()

/** `align` as the fragments row's `justifyContent` (`left` is the default, flex-start). */
const JUSTIFY = { center: 'center', right: 'flex-end' } as const

/**
 * The plain text of a default slot: its text vnodes concatenated (a template's `{{ }}` and literal text), `v-if`
 * comments and empty children skipped, fragments (`v-for`) flattened. Anything else throws.
 */
function slotText(children: readonly unknown[] | undefined): string {
  let out = ''
  for (const c of children ?? []) {
    if (c == null || typeof c === 'boolean') continue
    if (typeof c === 'string' || typeof c === 'number') out += String(c)
    else if (Array.isArray(c)) out += slotText(c)
    else if (isVNode(c) && c.type === TextVNode) out += String(c.children ?? '')
    else if (isVNode(c) && c.type === Fragment && Array.isArray(c.children)) out += slotText(c.children)
    else if (!(isVNode(c) && c.type === Comment)) throw new GlassUIError('Text', '默认插槽只能是纯文本（图标与文字并排请用 <Stack direction="horizontal">）')
  }
  return out
}

export const Text = defineGlassComponent({
  name: 'Text',
  description: '一段文字（支持中文与系统字体回退）。value 或默认插槽给出内容；value 也可以是片段数组（各自颜色/字重/字号，按行排成可换行的一排，片段内部不再跨片段重排）。不可选择、不可编辑：输入用 Input。',
  props: z.object({
    value: z.union([z.string(), z.array(Run)]).optional().describe('文字内容；省略时用默认插槽的纯文本'),
    size: z.union([z.number().positive(), z.string()]).optional().describe('字号，pt 数字或 fontSize token（xs/sm/base/lg/xl/2xl/3xl/4xl）'),
    weight: Weight.optional().describe('字重 100–900'),
    color: z.string().optional().describe('颜色 token（label、secondaryLabel、accent…）或 #hex'),
    maxLines: z.number().int().min(1).optional().describe('最多行数，超出以 … 截断'),
    align: z.enum(['left', 'center', 'right']).optional().describe('对齐（片段数组时对齐整排）'),
    wrap: z.boolean().optional().describe('是否在宽度处换行（默认 true）'),
  }),
  slots: { default: '纯文本内容（value 省略时）' },
  examples: [
    '<Text value="创建账号" :size="24" :weight="700" />',
    '<Text color="secondaryLabel" :max-lines="2">很长的说明文字…</Text>',
    '<Text :value="[{ text: \'已有账号？\' }, { text: \'登录\', color: \'accent\', weight: 600 }]" />',
  ],
  mistakes: [
    { mistake: 'size="20"', fix: ':size="20"（数字要绑定）' },
    { mistake: '<Text>{{ a }}<Icon /></Text>', fix: 'Text 只放文字；图标与文字并排用 Stack direction="horizontal"' },
  ],
}, (p, { slots }) => {
  const root = useRoot()
  return () => {
    const v = p.value, theme = root.theme, scheme = root.scheme
    // tokens are checked here, so a typo is this render's error rather than the Surface's next layout failing
    if (v.size !== undefined) checkFontSize('Text.size', v.size, theme)
    if (v.color !== undefined) colorOf('Text.color', v.color, theme, scheme)
    const style: Style = {
      ...(v.size !== undefined ? { fontSize: v.size } : {}), ...(v.weight !== undefined ? { fontWeight: v.weight } : {}),
      ...(v.color !== undefined ? { color: v.color } : {}), ...(v.maxLines !== undefined ? { maxLines: v.maxLines } : {}),
      ...(v.align !== undefined ? { textAlign: v.align } : {}), ...(v.wrap !== undefined ? { wrap: v.wrap } : {}),
    }
    if (!Array.isArray(v.value)) return h('text', { style }, v.value ?? slotText(slots.default?.()))
    // fragments: one text node per run in a row that wraps between runs; `align` places the row's runs
    const { textAlign: _align, ...typo } = style
    const row: Style = { flexDirection: 'row', flexWrap: v.wrap === false ? 'nowrap' : 'wrap', alignItems: 'baseline', ...(v.align && v.align !== 'left' ? { justifyContent: JUSTIFY[v.align] } : {}) }
    return h('box', { style: row }, v.value.map((f, i) => {
      if (f.color !== undefined) colorOf(`Text.value.${i}.color`, f.color, theme, scheme)
      const own: Style = { ...(f.size !== undefined ? { fontSize: f.size } : {}), ...(f.weight !== undefined ? { fontWeight: f.weight } : {}), ...(f.color !== undefined ? { color: f.color } : {}) }
      return h('text', { style: { ...typo, ...own } }, f.text)
    }))
  }
})
