import { computed, h, onBeforeUnmount, shallowRef, watch, watchEffect, type VNode } from '@vue/runtime-core'
import { z } from 'zod'
import type { Node, UIEvent } from '@glassui/core'
import type { Surface, Viewport3DContext } from '@glassui/render'
import { formatValue, niceMax } from '../chart'
import { defineGlassComponent } from '../define'
import { useRoot, useScheme, useSurfaceRef } from '../inject'
import { useLaidOutWidth } from '../layout-width'
import { isHeld } from '../renderer'
import { Text } from './Text'
import { colorOf } from './tokens'
import { Viewport3D } from './Viewport3D'

/** pt: the chart box's height (the bars' full height). */
const HEIGHT = 200

const BarChart3DProps = z.object({
  data: z.array(z.object({
    label: z.string().describe('柱下的标签'),
    value: z.number().min(0).describe('数值：不小于 0 的有限数'),
    color: z.string().optional().describe('柱子的颜色：颜色 token 或 #hex（默认 accent）'),
  })).describe('数据，每项 { label, value, color? }，一项一根柱子，从左到右排列；value 是不小于 0 的有限数。空数组时只显示"暂无数据"'),
  max: z.number().positive().optional().describe('纵轴最大值：value 等于它的柱子满高（200 pt）；默认把最大的 value 向上取到好看的刻度顶（236 → 250、17 → 20、101 → 150；全为 0 时取 1）'),
  format: z.custom<(v: number) => string>(v => typeof v === 'function', '需要一个函数 (v: number) => string').optional().describe(
    '悬停标签里数值的写法 (v: number) => string，如 v => `${v} 次`；默认最多两位小数（1.5、2、0.33）'),
})
type Props = z.output<typeof BarChart3DProps>

/** The axis maximum: `max`, else the largest value rounded up. */
const topOf = (x: Props): number => x.max ?? niceMax(Math.max(...x.data.map(d => d.value)))
/** The bar index an event's object carries (the render chart's `userData.index`); null off the bars. */
function barIndex(o: unknown): number | null {
  const i = (o as { userData?: { index?: unknown } } | null | undefined)?.userData?.index
  return typeof i === 'number' ? i : null
}

export const BarChart3D = defineGlassComponent({
  name: 'BarChart3D',
  description: '内置 3D 柱状图：柱子是圆角立方体，从所贴的玻璃面里长出来（进场时依次长出，数据变化时弹到新高度），受界面灯光照明并投下阴影。图表区高 200 pt、宽度撑满，n 根柱子 n 等分；下面是一行标签（13 pt、secondaryLabel），与柱子一一对齐。悬停一根柱子时它变亮变厚，柱顶上方 8 pt 处显示一个填充色小标签，写着 format(value)；点击发出 select。颜色是主题的颜色 token，随明暗切换。通常放在 <Card> 里（柱子从 Card 的玻璃里长出），只能用在 <Block>（世界层）里，不能放进 scroll。',
  props: BarChart3DProps,
  events: { select: { payload: '{ index: number; label: string; value: number }', description: '点击了某根柱子：它的序号（从 0 起）、标签与数值' } },
  examples: [
    `<Space><Block name="home" :width="880" :height="700"><Card title="一周活跃"><BarChart3D :data="[{ label: '一', value: 120 }, { label: '二', value: 160 }, { label: '三', value: 90 }, { label: '四', value: 210 }, { label: '五', value: 180 }, { label: '六', value: 60 }, { label: '日', value: 40 }]" /></Card></Block></Space>`,
    '<Space><Block name="sales" :width="640" :height="480"><Card title="季度销售"><BarChart3D :data="quarters" :max="100" :format="v => `${v} 万`" @select="e => picked = e.label" /></Card></Block></Space>',
    `<Space><Block name="budget" :width="488" :height="420"><Card title="本月收支"><BarChart3D :data="[{ label: '收入', value: 82, color: 'success' }, { label: '支出', value: 64, color: 'danger' }]" /></Card></Block></Space>`,
  ],
  mistakes: [
    { mistake: `:data="[{ label: '一', value: '120' }]"（value 写成字符串）`, fix: `value 是数字：:data="[{ label: '一', value: 120 }]"；负数、NaN、Infinity 也会报错` },
    { mistake: '<ScreenLayer><Surface …><BarChart3D :data="rows" /></Surface></ScreenLayer>（放在屏幕层）', fix: '3D 图表只在世界层：放进 <Space> 里的 <Block>，最好包一张 <Card title="…">' },
    { mistake: '把 BarChart3D 放进可滚动的 scroll 里', fix: '本期不支持裁剪 3D 物体：放在 scroll 外，Block 的高度给够（图表区 200 pt 加标签行）' },
  ],
}, (p, { emit }) => {
  const root = useRoot(), scheme = useScheme(), surface = useSurfaceRef()
  const chart = root.createBarChart()
  // made once: a new function each render would re-attach the chart
  const update = (dt: number, c: Viewport3DContext): boolean => chart.update(dt, c)
  /** The last valid props (the render reports invalid ones). */
  const v = computed<Props | null>(prev => { try { return p.value } catch { return prev ?? null } })
  // never an empty set: the max would be −Infinity, and the first set is the one that grows the bars in
  watchEffect(() => {
    const x = v.value
    if (!x || x.data.length === 0) return
    chart.set({
      values: x.data.map(d => d.value),
      colors: x.data.map(d => colorOf('BarChart3D.data.color', d.color ?? 'accent', root.theme, scheme.value)),
      max: topOf(x),
    })
  })

  const hovered = shallowRef<number | null>(null)
  const setHover = (o: unknown): void => { const i = barIndex(o); hovered.value = i; chart.hover(i) }
  // a hovered bar the data no longer has (or no chart at all) is hovered no more
  watch(() => v.value?.data.length ?? 0, n => { const i = hovered.value; if (i !== null && i >= n) setHover(undefined) })
  const select = (o: unknown): void => {
    const i = barIndex(o), d = i === null ? undefined : v.value?.data[i]
    if (i !== null && d) emit('select', { index: i, label: d.label, value: d.value })
  }
  const handlers = {
    onPointermove: (e: UIEvent) => { setHover(e.object) },
    onPointerleave: () => { setHover(undefined) },
    onClick: (e: UIEvent) => { select(e.object) },
  }

  // the chart box's laid-out width, kept current every tick (0 until the first one: no tag); the label row and the tag
  // restate the render chart's columns: n equal ones, bar i centred on its own
  const box = shallowRef<Node | null>(null), width = useLaidOutWidth(root, box)
  /** The value tag over bar `i`: centred on its column, 8 pt above its top. */
  const tag = (x: Props, i: number): VNode | null => {
    const d = x.data[i], w = width.value
    if (!d || w <= 0) return null
    const column = w / x.data.length
    return h('box', {
      style: { position: 'absolute', left: column * (i + 0.5) - 40, bottom: d.value / topOf(x) * HEIGHT + 8, width: 80, paddingY: 4, alignItems: 'center', bg: 'fill', radius: 10, border: { width: 1, color: 'separator' } },
    }, [h(Text, { value: (x.format ?? formatValue)(d.value) })])
  }

  // the chart is ours to dispose; in a leaving Block it flies out attached, so it goes with the Surface instead
  let home: Surface | null = null
  watch(surface, s => { if (s) home = s }, { immediate: true })
  onBeforeUnmount(() => {
    const n = box.value, s = home
    if (n && s && isHeld(n)) s.addEventListener('dispose', () => { chart.dispose() })
    else chart.dispose()
  })

  return () => {
    const x = p.value
    if (x.data.length === 0) return h('box', { style: { height: HEIGHT, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' } }, [h(Text, { value: '暂无数据', color: 'secondaryLabel' })])
    const i = hovered.value
    return h('box', { style: { flexDirection: 'column', gap: 8, alignSelf: 'stretch' } }, [
      h('box', { ref: box, style: { height: HEIGHT, alignSelf: 'stretch' } }, [
        h(Viewport3D, { object: chart, update, depth: 60, style: { position: 'absolute', inset: 0, height: 'auto' }, ...handlers }),
        i !== null ? tag(x, i) : null,
      ]),
      h('box', { style: { flexDirection: 'row' } }, x.data.map(d => h('box', { style: { flexGrow: 1, flexBasis: 0, alignItems: 'center' } }, [h(Text, { value: d.label, size: 13, color: 'secondaryLabel' })]))),
    ])
  }
})
