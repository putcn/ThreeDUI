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
    else if (!(isVNode(c) && c.type === Comment)) throw new GlassUIError('Text.default', '默认插槽只能是纯文本（图标与文字并排请用 <Stack direction="horizontal">）')
  }
  return out
}
/** Whitespace a template leaves at a slot's edges (`<Text>\n  文字\n</Text>` condenses to " 文字 "), dropped as HTML does. */
const EDGE_WS = /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g
const BLANK = /^[ \t\n\r\f]*$/
/**
 * Whether a default slot renders anything: text that is not all whitespace, or any element. Comments (a template's
 * `<!-- … -->` in a dev build, a false `v-if`), empty children and empty fragments do not count.
 */
function hasContent(children: readonly unknown[] | undefined): boolean {
  return (children ?? []).some(c => {
    if (c == null || typeof c === 'boolean') return false
    if (typeof c === 'string' || typeof c === 'number') return !BLANK.test(String(c))
    if (Array.isArray(c)) return hasContent(c)
    if (!isVNode(c)) return true
    if (c.type === Comment) return false
    if (c.type === TextVNode) return !BLANK.test(String(c.children ?? ''))
    if (c.type === Fragment) return Array.isArray(c.children) && hasContent(c.children)
    return true
  })
}
/**
 * A fragment run's edge spaces as no-break spaces: each run is its own text node, and the text engine hangs a line's
 * trailing spaces outside its width (CSS-like), so "状态 " would lose the space before the next run.
 */
const keepEdgeSpaces = (t: string): string => t.replace(/^ +| +$/g, m => '\u00a0'.repeat(m.length))

export const Text = defineGlassComponent({
  name: 'Text',
  description: '一段文字（支持中文与系统字体回退）。value 或默认插槽给出内容（二选一；插槽首尾空白会去掉）；value 也可以是片段数组：各自颜色/字重/字号，排成可换行的一排，片段首尾的空格保留，换行只发生在片段之间或片段内部，不跨片段重排；片段数组不支持 maxLines，wrap: false 让整排与每个片段都不换行。不可选择、不可编辑：输入用 Input。',
  props: z.object({
    value: z.union([z.string(), z.array(Run)]).optional().describe('文字内容；省略时用默认插槽的纯文本'),
    size: z.union([z.number().positive(), z.string()]).optional().describe('字号，pt 数字或 fontSize token（xs/sm/base/lg/xl/2xl/3xl/4xl）'),
    weight: Weight.optional().describe('字重 100–900'),
    color: z.string().optional().describe('颜色 token（label、secondaryLabel、accent…）或 #hex'),
    maxLines: z.number().int().min(1).optional().describe('最多行数，超出以 … 截断（片段数组不支持）'),
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
    // a slot that renders nothing (a comment, whitespace) is no conflict: only one with content is
    if (v.value !== undefined && slots.default && hasContent(slots.default())) throw new GlassUIError('Text', 'value 和默认插槽不能同时给出：二选一')
    if (!Array.isArray(v.value)) return h('text', { style }, v.value ?? slotText(slots.default?.()).replace(EDGE_WS, ''))
    // fragments: one text node per run in a row that wraps between runs; `align` places the row's runs
    if (v.maxLines !== undefined) throw new GlassUIError('Text.maxLines', '片段数组不支持 maxLines（各片段是独立的文字，无法一起截断）：用字符串 value')
    const { textAlign: _align, ...typo } = style
    const row: Style = { flexDirection: 'row', flexWrap: v.wrap === false ? 'nowrap' : 'wrap', alignItems: 'baseline', ...(v.align && v.align !== 'left' ? { justifyContent: JUSTIFY[v.align] } : {}) }
    return h('box', { style: row }, v.value.map((f, i) => {
      if (f.color !== undefined) colorOf(`Text.value.${i}.color`, f.color, theme, scheme)
      const own: Style = { ...(f.size !== undefined ? { fontSize: f.size } : {}), ...(f.weight !== undefined ? { fontWeight: f.weight } : {}), ...(f.color !== undefined ? { color: f.color } : {}) }
      return h('text', { style: { ...typo, ...own } }, keepEdgeSpaces(f.text))
    }))
  }
})
