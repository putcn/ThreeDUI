import { computed, h, onScopeDispose, shallowRef, watch, type VNode } from '@vue/runtime-core'
import { z } from 'zod'
import type { Node, RGBA, UIEvent } from '@glassui/core'
import type { CanvasLike } from '@glassui/text'
import { formatValue, niceTicks } from '../chart'
import { defineGlassComponent } from '../define'
import { useCanvasFactory, useRoot, useScheme } from '../inject'
import { useLaidOutWidth } from '../layout-width'
import { drawLineChart, GUTTER, type LineChartDrawing } from '../linechart-draw'
import { Text } from './Text'
import { colorOf } from './tokens'

/** The series colours when a series names none, by its index (then again from the first). */
const DEFAULT_COLORS = ['accent', 'success', 'danger', 'secondaryLabel'] as const
/** The labels' font family: the Text engine's (`system-ui`, then its Chinese system stack). */
const FONT = 'system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Noto Sans SC", sans-serif'
/** Canvas px per pt: the chart is drawn at 2× so it stays crisp at DPR 2. */
const SCALE = 2
/** pt: the hover panel's distance from the guide. */
const PANEL_GAP = 12

const LineChartProps = z.object({
  labels: z.array(z.string()).min(2).describe('横轴标签，每个点一个，从左到右（至少 2 个）；最多显示 6 个，均匀抽取，首尾总在'),
  series: z.array(z.object({
    name: z.string().describe('系列名：显示在图例与悬停面板里'),
    data: z.array(z.number().finite()).describe('数值，与 labels 一一对应（长度相同），有限数'),
    color: z.string().optional().describe('线与面积的颜色：颜色 token 或 #hex（默认依次 accent、success、danger、secondaryLabel，再循环）'),
  }).strict()).describe('系列，每项 { name, data, color? }，一项一条曲线；空数组时只显示"暂无数据"'),
  height: z.number().positive().default(200).describe('图表区高度，pt（不含上方图例；横轴标签占其中底部 22 pt）'),
  format: z.custom<(v: number) => string>(v => typeof v === 'function', '需要一个函数 (v: number) => string').optional().describe(
    '纵轴刻度与悬停面板里数值的写法 (v: number) => string，如 v => `${v} 件`；默认最多两位小数（1.5、2、0.33）。刻度标签放在左侧 36 pt 内，过长时整列缩小字号'),
  yMin: z.number().default(0).describe('纵轴下端（默认 0）：从它或它下面最近的刻度起；有数据比它小时纵轴向下延伸到能放下'),
}).superRefine((x, ctx) => {
  x.series.forEach((s, i) => {
    if (s.data.length !== x.labels.length) ctx.addIssue({ code: 'custom', path: ['series'], message: `第 ${i + 1} 条系列 "${s.name}" 有 ${s.data.length} 个点，labels 有 ${x.labels.length} 个` })
  })
})
type Props = z.output<typeof LineChartProps>
type HoverPayload = { index: number; label: string; values: number[] } | null

/** A series' colour as written: its own, else the default for its index. */
const colorAt = (s: Props['series'][number], i: number): string => s.color ?? DEFAULT_COLORS[i % DEFAULT_COLORS.length]!
/** The y axis: from `yMin` (or the least value, when lower) to the greatest value. */
const ticksOf = (x: Props): number[] => {
  const all = x.series.flatMap(s => s.data)
  return niceTicks(Math.min(x.yMin, ...all), Math.max(...all))
}
/** pt: a series dot's diameter (in the legend and the hover panel). */
const DOT = 8
/** An `RGBA` (sRGB 0..1) as a canvas fill style. */
const css = ([r, g, b, a]: RGBA): string => `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`

export const LineChart = defineGlassComponent({
  name: 'LineChart',
  description: '2D 折线图（趋势图）：上方一行图例（每个系列一个 8 pt 色点加名称），下面是高 height（默认 200）pt、宽度撑满的图表区。图表区用 Canvas2D 按 2 倍像素画成一张图片：左侧 44 pt 是纵轴刻度（3–6 个"好看"的刻度，步长 1、2、5 × 10ⁿ，从 yMin 起），底部 22 pt 是横轴标签（最多 6 个，均匀抽取），横向网格线，每个系列一条平滑曲线（单调三次插值，不会冲过数据）与曲线下渐变的面积。指针悬停时最近的点上画一条竖直准线、每条曲线上一个圆点，旁边浮出一块平面面板列出该点的标签与各系列的 format 值，并发出 hover。颜色是主题的颜色 token，明暗切换、宽度变化、数据变化时重画。它是平面内容（不是玻璃），屏幕层、世界层都能用，通常放在 <Card> 里。',
  props: LineChartProps,
  events: { hover: { payload: '{ index: number; label: string; values: number[] } | null', description: '悬停的点变了：它的序号（从 0 起）、标签与各系列在该点的值（与 series 同序）；指针离开图表区时为 null' } },
  examples: [
    `<Card title="近 30 天出入库"><LineChart :labels="days" :series="[{ name: '入库', data: inbound }, { name: '出库', data: outbound }]" :format="v => \`\${v} 件\`" /></Card>`,
    `<Card title="今日订单量"><LineChart :labels="['09:00', '11:00', '13:00', '15:00', '17:00', '19:00']" :series="[{ name: '订单', data: [58, 91, 76, 104, 88, 41], color: 'success' }]" :height="160" /></Card>`,
    `<Card title="库位利用率"><LineChart :labels="['第 1 周', '第 2 周', '第 3 周', '第 4 周']" :series="[{ name: 'A 区', data: [72, 75, 81, 86] }, { name: 'B 区', data: [64, 66, 63, 70] }]" :y-min="60" :format="v => \`\${v}%\`" @hover="e => focused = e?.label ?? null" /></Card>`,
  ],
  mistakes: [
    { mistake: `:series="[{ name: '入库', data: { '10-01': 120, '10-02': 98 } }]"（data 写成"标签 → 数值"的对象）`, fix: `data 是与 labels 一一对应的数字数组，标签放进 labels：:labels="['10-01', '10-02']" :series="[{ name: '入库', data: [120, 98] }]"` },
    { mistake: `:labels="['一', '二', '三']" :series="[{ name: '入库', data: [120, 98] }]"（data 与 labels 长度不同）`, fix: '每条系列的 data 长度必须等于 labels 的长度（一个标签一个点）；缺数据的点要补上数值，不能省略' },
    { mistake: `:series="{ name: '入库', data: [120, 98] }"（只有一条曲线时省掉了数组）`, fix: `series 总是数组，一条曲线也要包一层：:series="[{ name: '入库', data: [120, 98] }]"` },
  ],
}, (p, { emit }) => {
  const root = useRoot(), scheme = useScheme(), createCanvas = useCanvasFactory()
  // the theme too (a `setTheme` with the same scheme swaps the colours the tokens name)
  const theme = shallowRef(root.theme)
  onScopeDispose(root.on('theme', e => { theme.value = e.theme }))
  /** The last valid props (the render reports invalid ones). */
  const v = computed<Props | null>(prev => { try { return p.value } catch { return prev ?? null } })

  // the chart box's laid-out width, kept current every tick (0 until the first one: nothing drawn yet)
  const box = shallowRef<Node | null>(null), width = useLaidOutWidth(root, box)

  /**
   * A series dot: a `DOT` pt disc in `color`, drawn at `SCALE` into a canvas (one per colour, kept) and shown as an
   * image. An image beside a label rides on the same glass as the label (a Card's top face); a box with a background
   * would be drawn under the glass, at the plate, and part from its label as the view turns.
   */
  const dots = new Map<string, CanvasLike>()
  const dot = (color: RGBA): VNode => {
    const key = color.join()
    let src = dots.get(key)
    if (!src) {
      src = createCanvas(DOT * SCALE, DOT * SCALE)
      const g = src.getContext('2d') as unknown as CanvasRenderingContext2D, r = DOT * SCALE / 2
      g.fillStyle = css(color); g.beginPath(); g.arc(r, r, r, 0, Math.PI * 2); g.fill()
      dots.set(key, src)
    }
    return h('image', { src, style: { width: DOT, height: DOT, flexShrink: 0 } })
  }

  const hovered = shallowRef<number | null>(null)
  const setHover = (i: number | null): void => {
    if (hovered.value === i) return
    hovered.value = i
    const x = v.value
    const payload: HoverPayload = i === null || !x ? null : { index: i, label: x.labels[i]!, values: x.series.map(s => s.data[i]!) }
    emit('hover', payload)
  }
  // a hovered point the data no longer has (or no chart at all) is hovered no more
  watch(() => { const x = v.value; return x && x.series.length ? x.labels.length : 0 }, n => { const i = hovered.value; if (i !== null && i >= n) setHover(null) })
  // no hover by touch (core spec §8.3): a finger dragging across the Block would scrub the chart, redrawing it at each
  // point. Only touch is refused, so an event that names no pointer type still hovers
  const onPointermove = (e: UIEvent): void => {
    if (e.pointerType === 'touch') return
    const x = v.value, w = box.value?.layout.width ?? 0
    if (!x || x.series.length === 0 || w <= GUTTER.left) return
    const n = x.labels.length
    setHover(Math.min(n - 1, Math.max(0, Math.round((e.localX - GUTTER.left) / (w - GUTTER.left) * (n - 1)))))
  }
  const onPointerleave = (): void => { setHover(null) }

  // the drawing is made again only when what it draws changes (a parent re-rendering with equal props keeps it: a new
  // canvas is a new texture upload)
  let last: { key: string; canvas: CanvasLike } | null = null
  const paint = (o: LineChartDrawing): CanvasLike => {
    const key = JSON.stringify([o.width, o.height, o.labels, o.series, o.ticks, o.ticks.map(o.format), o.grid, o.text, o.hover])
    if (last?.key === key) return last.canvas
    const canvas = createCanvas(Math.ceil(o.width * SCALE), Math.ceil(o.height * SCALE))
    drawLineChart(canvas.getContext('2d') as unknown as CanvasRenderingContext2D, o)
    last = { key, canvas }
    return canvas
  }

  /** The values panel beside the guide at `i`: right of it in the plot's left half, left of it in the right half. */
  const panel = (x: Props, i: number, w: number, colors: readonly RGBA[]): VNode => {
    const gx = GUTTER.left + i / (x.labels.length - 1) * (w - GUTTER.left), fmt = x.format ?? formatValue
    const side = gx <= (GUTTER.left + w) / 2 ? { left: gx + PANEL_GAP } : { right: w - gx + PANEL_GAP }
    return h('box', { style: { position: 'absolute', top: 8, ...side, padding: 8, gap: 4, bg: 'fill', radius: 10, border: { width: 1, color: 'separator' } } }, [
      h(Text, { value: x.labels[i]!, size: 13, weight: 600 }),
      ...x.series.map((s, k) => h('box', { style: { flexDirection: 'row', alignItems: 'center', gap: 6 } }, [
        dot(colors[k]!),
        h(Text, { value: [{ text: `${s.name}: `, color: 'secondaryLabel' }, { text: fmt(s.data[i]!) }], size: 13, wrap: false }),
      ])),
    ])
  }

  return () => {
    const x = p.value
    if (x.series.length === 0) return h('box', { style: { height: x.height, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' } }, [h(Text, { value: '暂无数据', color: 'secondaryLabel' })])
    const t = theme.value, s = scheme.value, w = width.value
    // resolved on every render, drawn or not: a bad colour is this render's error
    const tokens = x.series.map(colorAt)
    const colors: RGBA[] = tokens.map((c, k) => colorOf(`LineChart.series.${k}.color`, c, t, s))
    const i = hovered.value !== null && hovered.value < x.labels.length ? hovered.value : null
    const src = w > 0 ? paint({
      width: w, height: x.height, scale: SCALE, labels: x.labels, series: x.series.map((d, k) => ({ color: colors[k]!, data: d.data })),
      ticks: ticksOf(x), grid: colorOf('LineChart', 'separator', t, s), text: colorOf('LineChart', 'secondaryLabel', t, s), font: FONT,
      format: x.format ?? formatValue, hover: i,
    }) : null
    const image = { width: '100%', height: x.height }
    return h('box', { style: { flexDirection: 'column', gap: 12, alignSelf: 'stretch' } }, [
      h('box', { style: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 } }, x.series.map((d, k) => h('box', { style: { flexDirection: 'row', alignItems: 'center', gap: 6 } }, [
        dot(colors[k]!), h(Text, { value: d.name, size: 13, color: 'secondaryLabel' }),
      ]))),
      h('box', { ref: box, style: { height: x.height, alignSelf: 'stretch' }, onPointermove, onPointerleave }, [
        h('image', src ? { src, style: image } : { style: image }),
        i !== null && w > 0 ? panel(x, i, w, colors) : null,
      ]),
    ])
  }
})
