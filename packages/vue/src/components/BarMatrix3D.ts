import { h, type VNode } from '@vue/runtime-core'
import { z } from 'zod'
import { rampColor, type ColorScheme, type RGBA, type Theme } from '@glassui/core'
import type { GridCell } from '@glassui/render'
import type { CanvasLike } from '@glassui/text'
import { formatFn, formatValue, niceMax } from '../chart'
import { use3DChart, useGridHover } from '../chart3d'
import { defineGlassComponent } from '../define'
import { useCanvasFactory } from '../inject'
import { READOUT, READOUT_GAP, readoutRow } from '../readout'
import { Text } from './Text'
import { colorOf, cssColor } from './tokens'
import { Viewport3D } from './Viewport3D'

/** The default colour ramp, low → high: green, amber, red (few days of cover is good, so low is green). */
const DEFAULT_RAMP = ['#34c759', '#ffb86b', '#ff6b6b'] as const
/** The readout's line when no bar is hovered. */
const HINT = '指向柱子查看数值'
/**
 * The legend (pt): the ramp as a `width` × `strip` gradient strip, drawn at `scale` × into a canvas shown as an image
 * (as LineChart's dots), and under it, `gap` below, the colour values' min and max and `colorLabel` (12 pt, at least
 * `labelGap` apart); `height` in all, `READOUT_GAP` under the readout.
 */
const LEGEND = { width: 160, strip: 8, gap: 4, height: 28, scale: 2, labelGap: 6 } as const

const BarMatrix3DProps = z.object({
  rows: z.array(z.string()).min(1).describe('行标签（纵深，从后往前），一行一个，如库区 "A 区"…"F 区"；第一行在最后面，最后一行离观者最近，平躺在底板左缘'),
  cols: z.array(z.string()).min(1).describe('列标签（横向，从左到右），一列一个，如品类 "日化"、"食品"、"家电"；平躺在底板前缘，放不下时均匀隔几个显示一个'),
  values: z.array(z.array(z.number().finite().min(0))).describe(
    '数值，行 × 列：values[行][列]，共 rows.length 行、每行 cols.length 个，都是不小于 0 的有限数；数值就是柱子的高度（如库存件数）。空数组时只显示"暂无数据"'),
  colorValues: z.array(z.array(z.number().finite())).optional().describe(
    '第四维：每格一个有限数（如周转天数），与 values 同形（行 × 列）；柱子的颜色按它在自身最小值到最大值之间的位置在色带上取（最小取色带第一色、最大取最后一色，全相等取中间色），并在读数行下显示色带图例。省略时颜色按 数值 / max 取'),
  colorRamp: z.array(z.string()).min(2).max(6).optional().describe(
    '色带：2–6 个颜色 token 或 #hex，从低到高。默认 ["#34c759", "#ffb86b", "#ff6b6b"]（绿 → 琥珀 → 红：周转天数少为好，所以低值为绿）'),
  colorLabel: z.string().optional().describe('colorValues 的名称，如 "周转"：写在图例色带下方，也原样放在读数里颜色值的前面（"周转 12 天"）'),
  max: z.number().positive().finite().optional().describe('满高对应的数值；默认把最大值向上取到好看的刻度顶（4580 → 5000、17 → 20；全为 0 时取 1）。比它大的数值按它封顶（柱子不会更高，读数仍显示原值）'),
  format: formatFn.optional().describe('读数里数值的写法 (v: number) => string，如 v => `${v.toLocaleString()} 件`；默认最多两位小数（1.5、2、0.33）'),
  colorFormat: formatFn.optional().describe('读数与图例里 colorValues 的写法 (v: number) => string，如 v => `${v} 天`；默认最多两位小数'),
  height: z.number().positive().default(280).describe('图表区高度，pt（不含下方 20 pt 的读数行与有 colorValues 时 28 pt 的图例）；宽度撑满'),
}).superRefine((x, ctx) => {
  const shape = (key: 'values' | 'colorValues', m: number[][], rows: number, why: string): void => {
    if (m.length !== rows) { ctx.addIssue({ code: 'custom', path: [key], message: `应为 ${rows} 行（${why}，${key}[行][列]），得到 ${m.length} 行` }); return }
    m.forEach((row, i) => {
      if (row.length !== x.cols.length) ctx.addIssue({ code: 'custom', path: [key], message: `第 ${i + 1} 行有 ${row.length} 个，应为 ${x.cols.length} 个（cols 有 ${x.cols.length} 个，每行一列一个）` })
    })
  }
  if (x.values.length > 0) shape('values', x.values, x.rows.length, '与 rows 一样多')
  // as values: rows × cols, or empty while values is
  if (x.colorValues) shape('colorValues', x.colorValues, x.values.length && x.rows.length, '与 values 同形')
})
type Props = z.output<typeof BarMatrix3DProps>
type Reading = { row: number; col: number; value: number; colorValue?: number; rowLabel: string; colLabel: string }

/** The full height's value: `max`, else the largest value rounded up. */
const topOf = (x: Props): number => x.max ?? niceMax(Math.max(...x.values.flat()))
/** The colour values' least and greatest (the ramp's ends). */
const spanOf = (m: number[][]): [number, number] => { const all = m.flat(); return [Math.min(...all), Math.max(...all)] }
/** The cell an event's object names (the render matrix's bar: `userData` `{ row, col }`); null off the bars. */
function cellOf(o: unknown): GridCell | null {
  const u = (o as { userData?: { row?: unknown; col?: unknown } } | null | undefined)?.userData
  return typeof u?.row === 'number' && typeof u.col === 'number' ? { row: u.row, col: u.col } : null
}

export const BarMatrix3D = defineGlassComponent({
  name: 'BarMatrix3D',
  description: '3D 柱状矩阵：行（rows，如库区 A–F）× 列（cols，如品类）的方阵，每格立一根圆角柱，高度是数值（如库存件数），颜色是第四维 colorValues（如周转天数，默认绿 → 琥珀 → 红的色带；省略时按高度取色）。柱子立在一块半透明底板上，列标签沿底板前缘、行标签沿左缘平躺在底板上，随图表一起透视；图表像桌面一样向后倾，与 <SurfaceChart3D> 同一套倾角、底板与标签样式。进场时柱子沿对角线依次长出，数据变化时弹到新高度（减少动态效果时直接到位）。指针指到柱子上时它变亮并升高一点，下方读数行显示"行 · 列 · 数值 · 颜色值"并发出 hover；点击发出 select。有 colorValues 时读数行下有一条色带图例，标着最小值、最大值与 colorLabel。图表区高 height（默认 280）pt、宽度撑满。通常放在 <Card> 里，只能用在 <Block>（世界层）里，不能放进 scroll。',
  props: BarMatrix3DProps,
  events: {
    hover: { payload: '{ row: number; col: number; value: number; colorValue?: number; rowLabel: string; colLabel: string } | null', description: '指向的柱子变了：行号、列号（从 0 起）、数值、颜色值（有 colorValues 时）与它的行标签、列标签；离开柱子时为 null。触屏不发（没有悬停）' },
    select: { payload: '{ row: number; col: number; value: number; colorValue?: number; rowLabel: string; colLabel: string }', description: '点击了某根柱子：同 hover 的内容' },
  },
  examples: [
    `<Space><Block name="overview" :width="1100" :height="760"><Card title="库存分布 · 库区 × 品类"><BarMatrix3D :rows="['A 区', 'B 区', 'C 区', 'D 区', 'E 区', 'F 区']" :cols="categories" :values="stock" :color-values="coverDays" color-label="周转" :format="v => \`\${v.toLocaleString()} 件\`" :color-format="v => \`\${v} 天\`" @select="e => openZone(e.rowLabel, e.colLabel)" /></Card></Block></Space>`,
    `<Space><Block name="slots" :width="880" :height="640"><Card title="库位占用（个）"><BarMatrix3D :rows="['1 层', '2 层', '3 层']" :cols="['A 排', 'B 排', 'C 排', 'D 排']" :values="[[42, 38, 50, 12], [30, 44, 47, 20], [18, 25, 33, 9]]" :max="60" :height="240" /></Card></Block></Space>`,
    `<Space><Block name="quality" :width="980" :height="700"><Card title="退货量 × 退货率"><BarMatrix3D :rows="channels" :cols="months" :values="returns" :color-values="returnRates" :color-ramp="['#e8f5e9', 'success', '#ff9f0a', 'danger']" color-label="退货率" :color-format="v => \`\${v}%\`" @hover="e => focused = e" /></Card></Block></Space>`,
  ],
  mistakes: [
    { mistake: ':values="byCategory"（6 列 × 6 行：把品类当成了行）', fix: 'values[行][列]：行对应 rows（如库区），列对应 cols（如品类），形状必须是 rows.length × cols.length；需要时先转置。colorValues 同形' },
    { mistake: `:values="{ 'A 区': [4580, 1200], 'B 区': [2400, 3600] }"（values 写成"行 → 数组"的对象）`, fix: `values 是二维数组，行名放进 rows：:rows="['A 区', 'B 区']" :values="[[4580, 1200], [2400, 3600]]"` },
    { mistake: ':color-values="coverDays" 却少了一行或一列（与 values 不同形）', fix: 'colorValues 与 values 一一对应，同样 rows.length 行、每行 cols.length 个；没有第四维时省略 colorValues，颜色就按高度取' },
    { mistake: '<ScreenLayer><Surface …><BarMatrix3D … /></Surface></ScreenLayer>，或放进 scroll', fix: '3D 图表只在世界层：放进 <Space> 里的 <Block>（最好包一张 <Card title="…">），不能放进可滚动的 scroll' },
  ],
}, (p, { emit }) => {
  const createCanvas = useCanvasFactory()
  /** The colour ramp, resolved for `theme` and `scheme` (a bad token is this render's error: `colorOf` throws). */
  const rampOf = (x: Props, t: Theme, s: ColorScheme): RGBA[] => (x.colorRamp ?? DEFAULT_RAMP).map((c, i) => colorOf(`BarMatrix3D.colorRamp.${i}`, c, t, s))
  const { chart, props: v, update, box, theme, scheme } = use3DChart(p, root => root.createBarMatrix(), (chart, x, th, s) => {
    const r = rampOf(x, th, s), max = topOf(x), cv = x.colorValues
    // a fourth value: its place between its own least and greatest (all equal: the ramp's middle); else the height's
    const [lo, hi] = cv ? spanOf(cv) : [0, 0]
    const t = (row: number, col: number): number => (cv ? (hi > lo ? (cv[row]![col]! - lo) / (hi - lo) : 0.5) : Math.min(1, x.values[row]![col]! / max))
    chart.set({ values: x.values, max, colors: x.values.map((row, i) => row.map((_, k) => rampColor(r, t(i, k)))) })
    chart.labels({ rows: x.rows, cols: x.cols })
  })
  const reading = (c: GridCell): Reading | null => {
    const x = v.value, value = x?.values[c.row]?.[c.col]
    if (!x || value === undefined) return null
    const out: Reading = { row: c.row, col: c.col, value, rowLabel: x.rows[c.row]!, colLabel: x.cols[c.col]! }, cv = x.colorValues?.[c.row]?.[c.col]
    return cv === undefined ? out : { ...out, colorValue: cv }
  }
  // the bar the pointer is on
  const { hovered, handlers } = useGridHover({ chart, props: v, emit, reading })
  const on = handlers(e => cellOf(e.object))

  /** The readout under the matrix: "row · col · value · colorLabel colour value" for the hovered bar, else the hint. */
  const readout = (x: Props): VNode => {
    const c = hovered.value, r = c && reading(c)
    if (!r) return readoutRow(null, HINT)
    const parts = [{ text: r.rowLabel, color: 'secondaryLabel' }, { text: r.colLabel, color: 'secondaryLabel' }, { text: (x.format ?? formatValue)(r.value), weight: 600 }]
    if (r.colorValue !== undefined) parts.push({ text: `${x.colorLabel ? `${x.colorLabel} ` : ''}${(x.colorFormat ?? formatValue)(r.colorValue)}`, color: 'secondaryLabel' })
    return readoutRow(parts, HINT)
  }

  /**
   * The legend's strip: the ramp from its first colour (left) to its last (right), column by column (`rampColor`, as
   * the bars are coloured) in a capsule, at `LEGEND.scale` ×; drawn again only for other colours.
   */
  let strip: { key: string; canvas: CanvasLike } | null = null
  const stripOf = (colors: readonly RGBA[]): CanvasLike => {
    const key = colors.join('|')
    if (strip?.key === key) return strip.canvas
    const S = LEGEND.scale, w = LEGEND.width * S, hh = LEGEND.strip * S, r = hh / 2
    const canvas = createCanvas(w, hh), g = canvas.getContext('2d') as unknown as CanvasRenderingContext2D
    g.beginPath(); g.arc(r, r, r, Math.PI / 2, Math.PI * 1.5); g.arc(w - r, r, r, -Math.PI / 2, Math.PI / 2); g.closePath(); g.clip()
    for (let px = 0; px < w; px++) { g.fillStyle = cssColor(rampColor(colors, px / (w - 1))); g.fillRect(px, 0, 1, hh) }
    strip = { key, canvas }
    return canvas
  }
  /**
   * The legend under the readout: the strip, then the colour values' min, `colorLabel` and max; type only, no panel.
   * The min and max keep their width; a label too long for what is left between them is cut to one line (…).
   */
  const legend = (x: Props, cv: number[][]): VNode => {
    const [lo, hi] = spanOf(cv), fmt = x.colorFormat ?? formatValue, small = { size: 12, wrap: false }, whole = { flexShrink: 0 }
    return h('box', { style: { width: LEGEND.width, height: LEGEND.height, gap: LEGEND.gap, alignSelf: 'center' } }, [
      h('image', { src: stripOf(rampOf(x, theme.value, scheme.value)), style: { width: LEGEND.width, height: LEGEND.strip } }),
      h('box', { style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: LEGEND.labelGap } }, [
        h(Text, { value: fmt(lo), color: 'tertiaryLabel', ...small, style: whole }),
        x.colorLabel ? h(Text, { value: x.colorLabel, color: 'secondaryLabel', ...small, maxLines: 1 }) : null,
        h(Text, { value: fmt(hi), color: 'tertiaryLabel', ...small, style: whole }),
      ]),
    ])
  }

  return () => {
    const x = p.value, cv = x.colorValues
    const below = READOUT_GAP + READOUT + (cv ? READOUT_GAP + LEGEND.height : 0)
    // as tall as the matrix, its readout and legend, so the Card does not jump when data arrives
    if (x.values.length === 0) return h('box', { ref: box, style: { height: x.height + below, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' } }, [h(Text, { value: '暂无数据', color: 'secondaryLabel' })])
    // how far the matrix rises off the glass, for the shadow fit: its own number, at any width (its tallest bar is
    // 0.45 × the shorter side, so no box wider than it is high rises further), so a resize never re-attaches it
    return h('box', { ref: box, style: { flexDirection: 'column', gap: READOUT_GAP, alignSelf: 'stretch' } }, [
      h(Viewport3D, { object: chart, update, depth: chart.riseFor(x.height, x.height), style: { height: x.height }, ...on }),
      readout(x),
      ...(cv ? [legend(x, cv)] : []),
    ])
  }
})
