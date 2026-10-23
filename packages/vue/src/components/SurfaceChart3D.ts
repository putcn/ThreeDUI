import { h, type VNode } from '@vue/runtime-core'
import { z } from 'zod'
import type { SurfaceCell } from '@glassui/render'
import { formatFn, formatValue, niceMax, niceTicks } from '../chart'
import { use3DChart, useGridHover } from '../chart3d'
import { defineGlassComponent } from '../define'
import { READOUT, READOUT_GAP, readoutRow } from '../readout'
import { Text } from './Text'
import { colorOf } from './tokens'
import { Viewport3D } from './Viewport3D'

/** The default colour ramp, low → high: pale blue-violet through the accent to a deep magenta. */
const DEFAULT_RAMP = ['#cfd8ff', '#a59bff', 'accent', '#c2185b'] as const
/** The readout's line when no cell is hovered. */
const HINT = '指向曲面查看数值'

const SurfaceChart3DProps = z.object({
  xLabels: z.array(z.string()).min(2).describe('列标签（横轴，从左到右），一列一个，如 24 个时段 "00"…"23"；至少 2 个。放不下时均匀隔几个显示一个'),
  yLabels: z.array(z.string()).min(2).describe('行标签（纵深，从后往前），一行一个，如近 14 天的日期 "10-03"…"10-16"；至少 2 个。第一行在最后面，最后一行离观者最近'),
  values: z.array(z.array(z.number().finite().min(0))).describe(
    '数值，行 × 列：values[行][列]，共 yLabels.length 行、每行 xLabels.length 个，都是不小于 0 的有限数；数值就是曲面的高度（第三维）。空数组时只显示"暂无数据"'),
  max: z.number().positive().finite().optional().describe('满高对应的数值；默认把最大值向上取到好看的刻度顶（236 → 250、17 → 20；全为 0 时取 1）。刻度标签从 0 均匀排到它；比它大的数值按它封顶（曲面不会高过最高刻度，读数仍显示原值）'),
  ramp: z.array(z.string()).min(2).max(6).optional().describe(
    '色带：2–6 个颜色 token 或 #hex，从低到高；曲面每个点按 数值 / max 在色带上取色。默认 ["#cfd8ff", "#a59bff", "accent", "#c2185b"]（淡蓝紫 → 主题色 → 深品红）'),
  format: formatFn.optional().describe('刻度与读数里数值的写法 (v: number) => string，如 v => `${v} 单`；默认最多两位小数（1.5、2、0.33）'),
  hint: z.string().optional().describe('未悬停数据点时读数行的提示；默认“指向曲面查看数值”'),
  height: z.number().positive().default(280).describe('图表区高度，pt（不含下方 20 pt 的读数行）；宽度撑满'),
}).superRefine((x, ctx) => {
  if (x.values.length === 0) return
  if (x.values.length !== x.yLabels.length) {
    ctx.addIssue({ code: 'custom', path: ['values'], message: `应为 ${x.yLabels.length} 行（与 yLabels 一样多，values[行][列]），得到 ${x.values.length} 行` })
    return
  }
  x.values.forEach((row, i) => {
    if (row.length !== x.xLabels.length) ctx.addIssue({ code: 'custom', path: ['values'], message: `第 ${i + 1} 行有 ${row.length} 个，xLabels 有 ${x.xLabels.length} 个（每行一列一个）` })
  })
})
type Props = z.output<typeof SurfaceChart3DProps>
type Reading = { row: number; col: number; value: number; x: string; y: string }

/** The full height's value: `max`, else the largest value rounded up. */
const topOf = (x: Props): number => x.max ?? niceMax(Math.max(...x.values.flat()))
/** The value ticks, evenly from 0 to `max`: its nice ticks when they end on it, else 0, half and `max`. */
const ticksOf = (max: number): number[] => { const t = niceTicks(0, max); return t.at(-1) === max ? t : [0, max / 2, max] }

export const SurfaceChart3D = defineGlassComponent({
  name: 'SurfaceChart3D',
  description: '3D 热力曲面图：两个坐标轴（xLabels 列、yLabels 行，如时段 × 日期）上的数值画成一张平滑曲面，高度就是数值，颜色按高度在色带上取（默认淡蓝紫 → 主题色 → 深品红），一眼看出高峰与规律。曲面立在一块半透明底板上，底板上有沿行列的细网格线；列标签沿底板前缘、行标签沿左缘平躺在底板上，数值刻度立在左后角，都随图表一起透视。图表像桌面一样向后倾，进场时曲面一行接一行从底板长出，数据变化时弹到新高度（减少动态效果时直接到位）。指针指到曲面上时，该点立起一根竖直指示线和一个圆点，下方读数行显示"日期 · 时段 · 数值"并发出 hover；点击发出 select。图表区高 height（默认 280）pt、宽度撑满，下面是 20 pt 的读数行。通常放在 <Card> 里，只能用在 <Block>（世界层）里，不能放进 scroll。',
  props: SurfaceChart3DProps,
  events: {
    hover: { payload: '{ row: number; col: number; value: number; x: string; y: string } | null', description: '指向的格点变了：行号、列号（从 0 起）、数值与它的列标签 x、行标签 y；离开曲面时为 null。触屏不发（没有悬停）' },
    select: { payload: '{ row: number; col: number; value: number; x: string; y: string }', description: '点击了曲面上的某个格点：同 hover 的内容' },
  },
  examples: [
    '<Space><Block name="overview" :width="1100" :height="760"><Card title="出库热力 · 近 14 天"><SurfaceChart3D :x-labels="hours" :y-labels="days" :values="outbound" :format="v => `${v} 单`" @hover="e => peak = e" /></Card></Block></Space>',
    `<Space><Block name="pick" :width="900" :height="620"><Card title="拣货效率（件/时）"><SurfaceChart3D :x-labels="['08', '10', '12', '14', '16', '18']" :y-labels="['周一', '周二', '周三', '周四', '周五']" :values="rates" :max="400" :height="240" @select="e => openShift(e.y, e.x)" /></Card></Block></Space>`,
    `<Space><Block name="dock" :width="980" :height="700"><Card title="月台占用率"><SurfaceChart3D :x-labels="slots" :y-labels="['1 号月台', '2 号月台', '3 号月台', '4 号月台']" :values="busy" :max="100" :ramp="['#e8f5e9', 'success', '#ff9f0a', 'danger']" :format="v => \`\${v}%\`" /></Card></Block></Space>`,
  ],
  mistakes: [
    { mistake: ':values="byHour"（24 行 × 14 列：把时段当成了行）', fix: 'values[行][列]：行对应 yLabels（如日期），列对应 xLabels（如时段），形状必须是 yLabels.length × xLabels.length；需要时先转置' },
    { mistake: `:values="{ '10-15': [12, 30, …], '10-16': [8, 26, …] }"（values 写成"日期 → 数组"的对象）`, fix: `values 是二维数组，日期放进 yLabels：:y-labels="['10-15', '10-16']" :values="[[12, 30, …], [8, 26, …]]"` },
    { mistake: '<ScreenLayer><Surface …><SurfaceChart3D … /></Surface></ScreenLayer>，或放进 scroll', fix: '3D 图表只在世界层：放进 <Space> 里的 <Block>（最好包一张 <Card title="…">），不能放进可滚动的 scroll' },
  ],
}, (p, { emit }) => {
  // never a set without data: the chart needs 2 × 2, and its first set is the one that grows the surface in
  const { chart, props: v, update, box } = use3DChart(p, root => root.createSurfaceChart(), (chart, x, t, s) => {
    const fmt = x.format ?? formatValue, max = topOf(x)
    chart.set({ values: x.values, max, ramp: (x.ramp ?? DEFAULT_RAMP).map((c, i) => colorOf(`SurfaceChart3D.ramp.${i}`, c, t, s)) })
    chart.labels({ x: x.xLabels, y: x.yLabels, ticks: ticksOf(max).map(n => fmt(n)) })
  })
  const reading = (c: SurfaceCell): Reading | null => {
    const x = v.value, value = x?.values[c.row]?.[c.col]
    return x && value !== undefined ? { row: c.row, col: c.col, value, x: x.xLabels[c.col]!, y: x.yLabels[c.row]! } : null
  }
  // the vertex nearest the pointer's point on the surface (or the plate)
  const { hovered, handlers } = useGridHover({ chart, props: v, emit, reading })
  const on = handlers(e => (e.point ? chart.cellAt(e.point) : null))

  /** The readout under the chart: "y · x · value" for the hovered cell, else the hint. */
  const readout = (x: Props): VNode => {
    const c = hovered.value, r = c && reading(c)
    return readoutRow(r && [{ text: r.y, color: 'secondaryLabel' }, { text: r.x, color: 'secondaryLabel' }, { text: (x.format ?? formatValue)(r.value), weight: 600 }], x.hint ?? HINT)
  }

  return () => {
    const x = p.value
    // as tall as the chart and its readout, so the Card does not jump when data arrives
    if (x.values.length === 0) return h('box', { ref: box, style: { height: x.height + READOUT_GAP + READOUT, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' } }, [h(Text, { value: '暂无数据', color: 'secondaryLabel' })])
    // how far the chart rises off the glass, for the shadow fit: its own number, at any width (its tallest data is
    // 0.45 × the shorter side, so no box wider than it is high rises further), so a resize never re-attaches it
    return h('box', { ref: box, style: { flexDirection: 'column', gap: READOUT_GAP, alignSelf: 'stretch' } }, [
      h(Viewport3D, { object: chart, update, depth: chart.riseFor(x.height, x.height), style: { height: x.height }, ...on }),
      readout(x),
    ])
  }
})
