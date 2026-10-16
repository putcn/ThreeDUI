import { it, expect } from 'vitest'
import { createCanvas, type Canvas } from '@napi-rs/canvas'
import { h, nextTick, ref, type VNodeChild } from '@vue/runtime-core'
import { absoluteRect, buildRenderList, defaultTheme, resolveColor, type Node, type RGBA } from '@glassui/core'
import { partition } from '@glassui/render/internal'
import { niceMax, niceTicks } from '../src/chart'
import { drawLineChart } from '../src/linechart-draw'
import { Box } from '../src/components/Box'
import { Card } from '../src/components/Card'
import { LineChart } from '../src/components/LineChart'
import { ScreenLayer, Surface } from '../src/components/Surface'
import { glassComponents } from '../src/define'
import { createFakeRoot, flush, type FakeRoot } from './fixtures/fake-root'
import { first, mountGlass } from './fixtures/mount'
import { tree } from './fixtures/tree'

// Brief adjustment (tests 3 and 4): mountGlass's own container is detached and only a Surface is ever laid out, so
// the chart box would never get a width there. Those tests mount the same tree on a screen Surface and read its root.
const onSurface = (child: () => VNodeChild) => h(ScreenLayer, () => [h(Surface, { width: 480, height: 640 }, () => [child()])])
/** `child` mounted on a screen Surface of `root`, laid out and measured (a tick, then the redraw it causes): its root. */
async function laidOut(root: FakeRoot, child: () => VNodeChild): Promise<Node> {
  mountGlass(() => onSurface(child), { root })
  root.tick(); await flush(); root.tick(); await flush()
  return root.surfacesMade[0]!.root
}
/** The RGBA (0–255, straight) of `cv`'s pixel at (x, y) pt, drawn at 2×. */
const probe = (cv: unknown, x: number, y: number) => (cv as Canvas).getContext('2d').getImageData(Math.round(x * 2), Math.round(y * 2), 1, 1).data
const rgb255 = (c: RGBA) => c.slice(0, 3).map(v => Math.round(v * 255))
const near = (px: ArrayLike<number>, c: RGBA) => rgb255(c).every((v, i) => Math.abs(px[i]! - v) <= 2) && px[3] === 255
const isRed = (px: ArrayLike<number>) => px[0]! > 200 && px[1]! < 80 && px[3]! > 128
/** The hover panel among the chart box's children (a `v-if` placeholder anchor is absolute too, but no box). */
const isPanel = (n: Node) => n.type === 'box' && n.style.position === 'absolute'
/** The chart's image: the one image as wide as its box (the legend's and the panel's dots are images too). */
function chartImage(n: Node): Node {
  const all: Node[] = []
  const walk = (m: Node): void => { if (m.type === 'image') all.push(m); m.children.forEach(walk) }
  walk(n)
  const img = all.find(i => i.style.width === '100%')
  if (!img) throw new Error('no chart image')
  return img
}
const base = { width: 200, height: 100, scale: 2, grid: [0, 0, 0, 0.1] as RGBA, text: [0, 0, 0, 1] as RGBA, font: 'sans-serif', format: String, hover: null }

it('niceTicks covers the range in 1/2/5 steps', () => {
  expect(niceTicks(0, 97)).toEqual([0, 20, 40, 60, 80, 100])
  expect(niceTicks(0, 1)[0]).toBe(0); expect(niceTicks(0, 1).at(-1)).toBeGreaterThanOrEqual(1)
  const t = niceTicks(3, 4.2); expect(t[0]).toBeLessThanOrEqual(3); expect(t.at(-1)).toBeGreaterThanOrEqual(4.2); expect(t.length).toBeGreaterThanOrEqual(3); expect(t.length).toBeLessThanOrEqual(6)
})
it('drawLineChart puts a series where its value says', () => {
  const c = createCanvas(400, 200), ctx = c.getContext('2d') as unknown as CanvasRenderingContext2D
  drawLineChart(ctx, { width: 200, height: 100, scale: 2, labels: ['a', 'b'], series: [{ color: [1, 0, 0, 1], data: [50, 50] }], ticks: [0, 50, 100], grid: [0, 0, 0, 0.1], text: [0, 0, 0, 1], font: 'sans-serif', format: String, hover: null })
  // y = 50 of 0..100 sits halfway down the plot (top 0 … bottom 100 − 22 = 78 pt): 39 pt → 78 px; x mid-plot
  const px = ctx.getImageData(Math.round((44 + (200 - 44) / 2) * 2), Math.round(39 * 2), 1, 1).data
  expect(px[0]).toBeGreaterThan(200); expect(px[1]).toBeLessThan(80)
})
it('LineChart draws into an image twice its laid-out size; legend; mismatch errors; empty says so', async () => {
  const root = createFakeRoot()
  const c = await laidOut(root, () => h(Box, { style: { width: 400 } }, () => [h(LineChart, { labels: ['一', '二', '三'], series: [{ name: '入库', data: [1, 3, 2] }, { name: '出库', data: [2, 1, 4] }] })]))
  const img = chartImage(c), src = img.props.src as { width: number; height: number }
  expect(src.width).toBe(800); expect(src.height).toBe(400)
  expect(JSON.stringify(tree(c))).toContain('入库'); expect(JSON.stringify(tree(c))).toContain('出库')
  expect(mountGlass(() => h(LineChart, { labels: ['a', 'b'], series: [{ name: 'x', data: [1] }] })).errors[0]).toMatch(/\[LineChart\.series\].*"x".*1 个点.*2 个/)
  expect(JSON.stringify(tree(mountGlass(() => h(LineChart, { labels: ['a', 'b'], series: [] })).c))).toContain('暂无数据')
})
it('hover picks the nearest index, emits it and shows the values panel', async () => {
  const root = createFakeRoot(), seen: unknown[] = []
  mountGlass(() => onSurface(() => h(Box, { style: { width: 400 } }, () => [h(LineChart, { id: 'lc', labels: ['一', '二', '三'], series: [{ name: '入库', data: [1, 3, 2] }], format: (v: number) => `${v} 件`, onHover: (e: unknown) => seen.push(e) })])), { root })
  root.tick(); await flush()
  const c = root.surfacesMade[0]!.root
  const img = chartImage(c), r = absoluteRect(img)
  expect(r.width).toBe(400)
  // the chart box is the image's parent; localX = 44 + (400 − 44) · 0.5 → index 1
  img.parent!.handlers.get('pointermove')!({ localX: 44 + 178, localY: 50 } as never); await nextTick()
  expect(seen.at(-1)).toEqual({ index: 1, label: '二', values: [3] }); expect(JSON.stringify(tree(c))).toContain('3 件')
  img.parent!.handlers.get('pointerleave')!({} as never); await nextTick(); expect(seen.at(-1)).toBeNull()
})

it('niceTicks: 3–6 evenly stepped, exact ticks covering any range; niceMax is its top (0 → 1)', () => {
  expect(niceTicks(0, 236)).toEqual([0, 50, 100, 150, 200, 250]); expect(niceTicks(0, 186)).toEqual([0, 50, 100, 150, 200])
  expect(niceTicks(0, 0.3)).toEqual([0, 0.1, 0.2, 0.3]); expect(niceTicks(0, 1)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1])
  expect(niceTicks(-37, 12)).toEqual([-40, -20, 0, 20])
  expect(niceTicks(5, 5)[0]).toBeLessThanOrEqual(5); expect(niceTicks(5, 5).at(-1)).toBeGreaterThan(5)   // a flat range still spans something
  let seed = 7
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  for (let k = 0; k < 500; k++) {
    const a = (rand() - 0.3) * 10 ** Math.floor(rand() * 8 - 3), b = a + rand() * 10 ** Math.floor(rand() * 8 - 3)
    const t = niceTicks(a, b), step = t[1]! - t[0]!, m = step / 10 ** Math.floor(Math.log10(step) + 1e-6)
    expect(t.length, `${a}..${b}`).toBeGreaterThanOrEqual(3); expect(t.length, `${a}..${b}`).toBeLessThanOrEqual(6)
    expect(t[0]).toBeLessThanOrEqual(a + step * 1e-6); expect(t.at(-1)).toBeGreaterThanOrEqual(b - step * 1e-6)
    expect([1, 2, 5].some(n => Math.abs(m - n) < 1e-6), `step ${step}`).toBe(true)
    for (let i = 1; i < t.length; i++) expect(Math.abs(t[i]! - t[i - 1]! - step)).toBeLessThan(step * 1e-6)
    const dp = Math.max(0, -Math.floor(Math.log10(step) + 1e-6))
    for (const v of t) expect(v, `${a}..${b}`).toBe(Number(v.toFixed(dp)))   // exact decimals: never 0.30000000000000004
  }
  expect([0, 0.3, 5, 17, 101, 236, 186].map(niceMax)).toEqual([1, 0.3, 5, 20, 150, 250, 200])
})
it('niceTicks: a range the doubles cannot step through ends at once, in 3–6 finite ticks; a swapped range starts at the smaller', () => {
  for (const [a, b] of [[-1.7e308, 1.7e308], [-Number.MAX_VALUE, Number.MAX_VALUE], [0, 1.7e308], [1.7e308, 1.7e308]] as const) {
    const t = niceTicks(a, b)
    expect(t.length, `${a}..${b}`).toBeGreaterThanOrEqual(3); expect(t.length, `${a}..${b}`).toBeLessThanOrEqual(6)
    expect(t.every(Number.isFinite), `${a}..${b}: ${t}`).toBe(true)
    expect(t[0]).toBeLessThanOrEqual(a); expect(t.at(-1)).toBeGreaterThanOrEqual(b)
  }
  expect(niceTicks(-1.7e308, 1.7e308)).toEqual([-1.7e308, 0, 1.7e308])
  expect(niceTicks(5, 3)).toEqual([3, 4, 5, 6])                                          // 3..3 + |3|
})
it('drawLineChart: under the curve an area fades from 0.22 of the series colour to nothing; above it is clear', () => {
  const c = createCanvas(400, 200), ctx = c.getContext('2d') as unknown as CanvasRenderingContext2D
  drawLineChart(ctx, { ...base, labels: ['a', 'b'], series: [{ color: [1, 0, 0, 1], data: [50, 50] }], ticks: [0, 50, 100] })
  const x = 122, under = probe(c, x, 41.5), low = probe(c, x, 77), above = probe(c, x, 20)
  expect(under[0]).toBeGreaterThan(200); expect(under[3]).toBeGreaterThan(0.18 * 255); expect(under[3]).toBeLessThanOrEqual(Math.ceil(0.22 * 255))
  expect(low[3]).toBeLessThan(0.03 * 255)
  expect([...above]).toEqual([0, 0, 0, 0])
})
it('drawLineChart: the curve is monotone between points (no overshoot past a flat run)', () => {
  const c = createCanvas(400, 400), ctx = c.getContext('2d') as unknown as CanvasRenderingContext2D
  // 0, 0, 100, 100 on 0..150: a Catmull-Rom curve would dip ~9 pt under 0 in the first gap and rise over 100 in the last
  drawLineChart(ctx, { ...base, height: 200, labels: ['a', 'b', 'c', 'd'], series: [{ color: [1, 0, 0, 1], data: [0, 0, 100, 100] }], ticks: [0, 50, 100, 150] })
  const y0 = 178, y100 = 178 - 100 / 150 * 178, gap = (200 - 44) / 3
  for (let x = 44 + gap * 0.2; x < 44 + gap * 0.9; x += 2) for (let dy = 2; dy <= 8; dy += 1.5) expect(isRed(probe(c, x, y0 + dy)), `under 0 at ${x}`).toBe(false)
  for (let x = 44 + gap * 2.1; x < 44 + gap * 2.8; x += 2) for (let dy = 2; dy <= 8; dy += 1.5) expect(isRed(probe(c, x, y100 - dy)), `over 100 at ${x}`).toBe(false)
  expect(isRed(probe(c, 44 + gap * 0.5, y0))).toBe(true); expect(isRed(probe(c, 44 + gap * 2.5, y100))).toBe(true)
  // and smooth: 0, 100, 0 is flat at its peak, so halfway up it is at 62.5 (Fritsch–Carlson; the chord is at 50)
  const s = createCanvas(400, 444), sx = s.getContext('2d') as unknown as CanvasRenderingContext2D
  drawLineChart(sx, { ...base, height: 222, labels: ['a', 'b', 'c'], series: [{ color: [1, 0, 0, 1], data: [0, 100, 0] }], ticks: [0, 50, 100] })
  const half = 44 + (200 - 44) / 4
  expect(isRed(probe(s, half, 200 - 62.5 * 2))).toBe(true); expect(isRed(probe(s, half, 200 - 50 * 2))).toBe(false)
  expect(isRed(probe(s, 44 + (200 - 44) / 2, 0.5))).toBe(true)
})
it('drawLineChart: a hover draws a guide at its index and a 4 pt dot on each series', () => {
  const draw = (hover: number | null) => {
    const c = createCanvas(400, 200)
    drawLineChart(c.getContext('2d') as unknown as CanvasRenderingContext2D, { ...base, labels: ['a', 'b', 'c'], series: [{ color: [1, 0, 0, 1], data: [50, 50, 50] }], ticks: [0, 50, 100], hover })
    return c
  }
  const on = draw(1), off = draw(null), x = 44 + 78
  expect(probe(on, x, 10)[3]).toBeGreaterThan(60); expect(probe(off, x, 10)[3]).toBe(0)                   // the guide
  expect(isRed(probe(on, x + 2, 39 - 2.5))).toBe(true); expect(probe(off, x + 2, 39 - 2.5)[3]).toBe(0)   // the dot, 2.5 pt over the line
  expect(probe(on, x + 4.5, 39 - 2.5)[3]).toBe(0)                                                          // and no wider than 4 pt
})
/** A context over a real `@napi-rs/canvas` one that records each `fillText`: its text, the font then, and that font's width of it. */
function recording(w: number, h: number) {
  const real = createCanvas(w, h).getContext('2d'), drawn: { text: string; font: string; width: number }[] = []
  const ctx = new Proxy(real, {
    get: (t, k) => {
      const v = Reflect.get(t, k, t) as unknown
      if (typeof v !== 'function') return v
      return (...a: unknown[]) => {
        if (k === 'fillText') drawn.push({ text: String(a[0]), font: t.font, width: t.measureText(String(a[0])).width })
        return (v as (...x: unknown[]) => unknown).apply(t, a)
      }
    },
    set: (t, k, v) => Reflect.set(t, k, v, t),
  }) as unknown as CanvasRenderingContext2D
  return { ctx, drawn }
}
it('drawLineChart: y labels are the formatted ticks; x labels at most 6, evenly picked, the ends included', () => {
  const { ctx, drawn } = recording(800, 400)
  const labels = Array.from({ length: 30 }, (_, i) => `d${i + 1}`)
  drawLineChart(ctx, { ...base, width: 400, height: 200, labels, series: [{ color: [1, 0, 0, 1], data: labels.map(() => 1) }], ticks: [0, 1, 2], format: v => `${v} 件` })
  expect(drawn.map(d => d.text)).toEqual(['0 件', '1 件', '2 件', 'd1', 'd7', 'd13', 'd18', 'd24', 'd30'])
  expect(new Set(drawn.map(d => d.font))).toEqual(new Set(['600 12px sans-serif']))
  drawn.length = 0
  drawLineChart(ctx, { ...base, labels: ['一', '二', '三'], series: [], ticks: [0, 1], format: String })
  expect(drawn.map(d => d.text)).toEqual(['0', '1', '一', '二', '三'])
})
it('drawLineChart: y labels too wide for the gutter shrink together to fit it; the x labels keep 12 pt', () => {
  const { ctx, drawn } = recording(400, 200)
  drawLineChart(ctx, { ...base, labels: ['a', 'b'], series: [], ticks: [0, 500, 1000], format: v => `${v} 件` })
  const y = drawn.slice(0, 3), x = drawn.slice(3)
  expect(y.map(d => d.text)).toEqual(['0 件', '500 件', '1000 件'])
  expect(new Set(y.map(d => d.font)).size).toBe(1); expect(y[0]!.font).not.toBe('600 12px sans-serif')
  for (const d of y) expect(d.width, d.text).toBeLessThanOrEqual(36)                     // 44 pt gutter less the 8 pt gap
  expect(Math.max(...y.map(d => d.width))).toBeGreaterThan(33)                           // shrunk to fit, not further
  expect(x.map(d => d.font)).toEqual(['600 12px sans-serif', '600 12px sans-serif'])
  // no smaller than 8 pt, even when that still does not fit
  drawn.length = 0
  drawLineChart(ctx, { ...base, labels: ['a', 'b'], series: [], ticks: [0, 50000, 100000], format: v => `${v} 件` })
  expect(drawn.slice(0, 3).map(d => d.font)).toEqual(Array(3).fill('600 8px sans-serif'))
})

it('LineChart: series colours default to accent, success, danger, secondaryLabel, then cycle; the drawing follows the scheme', async () => {
  const root = createFakeRoot()
  const series = [0, 1, 2, 3, 4].map(i => ({ name: `S${i}`, data: [i === 0 ? 2 : 4, i === 0 ? 2 : 4] }))
  const c = await laidOut(root, () => h(Box, { style: { width: 400 } }, () => [h(LineChart, { labels: ['一', '二'], series: [...series.slice(0, 4), { ...series[4]!, color: '#00ff00' }, { name: 'S5', data: [4, 4] }] })]))
  // each legend dot is an image of a disc in its series' colour (its centre pixel)
  const dots = first(c, 'box').children[0]!.children[0]!.children.map(item => item.children[0]!)
  expect(dots.every(d => d.type === 'image')).toBe(true)
  const colours = ['accent', 'success', 'danger', 'secondaryLabel', '#00ff00', 'success'].map(t => resolveColor(t, defaultTheme, 'light'))
  dots.forEach((d, k) => expect(near(probe(d.props.src, 4, 4), colours[k]!), `dot ${k}`).toBe(true))
  expect(dots[1]!.props.src).toBe(dots[5]!.props.src)                                 // one canvas per colour
  // series 0 is flat at 2 of 0..4 (ticks 0, 1, 2, 3, 4): halfway down the 178 pt plot, drawn in accent
  const img = chartImage(c), light = img.props.src
  expect(near(probe(light, 222, 89), resolveColor('accent', defaultTheme, 'light'))).toBe(true)
  root.emit('theme', { theme: root.theme, scheme: 'dark', contrast: false }); await nextTick()
  expect(img.props.src).not.toBe(light)
  expect(near(probe(img.props.src, 222, 89), resolveColor('accent', defaultTheme, 'dark'))).toBe(true)
})
it('LineChart: yMin is where the y axis starts; data under it extends the axis down', async () => {
  const draw = async (yMin: number | undefined, low: number) => {
    const root = createFakeRoot()
    const c = await laidOut(root, () => h(Box, { style: { width: 400 } }, () => [h(LineChart, { labels: ['一', '二'], series: [{ name: 'a', data: [low, low] }, { name: 'b', data: [80, 80] }], ...(yMin !== undefined ? { yMin } : {}) })]))
    return chartImage(c).props.src
  }
  const accent = resolveColor('accent', defaultTheme, 'light')
  expect(near(probe(await draw(undefined, 70), 222, 178 * (1 - 70 / 80)), accent)).toBe(true)   // 0..80
  expect(near(probe(await draw(60, 70), 222, 89), accent)).toBe(true)                           // 60..80: 70 halfway
  expect(near(probe(await draw(60, 40), 222, 178), accent)).toBe(true)                          // 40..80: 40 at the bottom
})
it('LineChart: a hover clamps to the ends; the panel sits right of the guide, left of it in the right half; it lists every series', async () => {
  const root = createFakeRoot(), seen: unknown[] = []
  const c = await laidOut(root, () => h(Box, { style: { width: 400 } }, () => [h(LineChart, { labels: ['10-01', '10-02', '10-03'], series: [{ name: '入库', data: [1, 3, 2] }, { name: '出库', data: [2, 1, 4] }], onHover: (e: unknown) => seen.push(e) })]))
  const box = chartImage(c).parent!, move = (x: number) => box.handlers.get('pointermove')!({ localX: x, localY: 50 } as never)
  move(-30); await nextTick()
  expect(seen).toEqual([{ index: 0, label: '10-01', values: [1, 2] }])
  const panel = box.children.find(isPanel)!
  expect(panel.style).toMatchObject({ top: 8, left: 44 + 12, padding: 8, bg: 'fill', radius: 10, border: { width: 1, color: 'separator' } })
  expect(JSON.stringify(tree(panel))).toMatch(/10-01.*入库:\s.*"1".*出库:\s.*"2"/)   // the name's trailing space is kept as a no-break space
  move(-20); await nextTick(); expect(seen.length).toBe(1)                            // the same index: no new event
  move(9999); await nextTick()
  expect(seen.at(-1)).toEqual({ index: 2, label: '10-03', values: [2, 4] })
  const right = box.children.find(isPanel)!
  expect(right.style.right).toBe(12); expect(right.style.left).toBeUndefined()
  box.handlers.get('pointerleave')!({} as never); await nextTick()
  expect(box.children.some(isPanel)).toBe(false)
})
it('LineChart: a hovered index the labels drop is hovered no more', async () => {
  const root = createFakeRoot(), seen: unknown[] = [], three = { labels: ['一', '二', '三'], series: [{ name: 'a', data: [1, 2, 3] }] }, data = ref(three)
  const c = await laidOut(root, () => h(Box, { style: { width: 400 } }, () => [h(LineChart, { ...data.value, onHover: (e: unknown) => seen.push(e) })]))
  const box = chartImage(c).parent!
  box.handlers.get('pointermove')!({ localX: 9999, localY: 50 } as never); await nextTick()
  expect(seen.at(-1)).toMatchObject({ index: 2 })
  data.value = { labels: ['一', '二'], series: [{ name: 'a', data: [1, 2] }] }; await nextTick()
  expect(seen.at(-1)).toBeNull(); expect(box.children.some(isPanel)).toBe(false)
  data.value = three; await nextTick()
  expect(box.children.some(isPanel)).toBe(false)           // no stale panel when it comes back
})
it('LineChart redraws only when what it draws changes', async () => {
  const root = createFakeRoot(), tick = ref(0), d = ref([1, 2, 3])
  const c = await laidOut(root, () => h(Box, { id: `b${tick.value}`, style: { width: 400 } }, () => [h(LineChart, { labels: ['一', '二', '三'], series: [{ name: 'a', data: [...d.value] }] })]))
  const img = chartImage(c), before = img.props.src
  tick.value++; await nextTick(); root.tick(); await flush()
  expect(img.props.src).toBe(before)                                                       // equal props, a new array: the same drawing
  d.value = [3, 2, 1]; await nextTick()
  expect(img.props.src).not.toBe(before)
})
it('LineChart redraws when only its box is resized: no new props, a 600 px canvas at 300 pt', async () => {
  const root = createFakeRoot(), w = ref(400), labels = ['一', '二', '三'], series = [{ name: '入库', data: [1, 3, 2] }]
  const c = await laidOut(root, () => h(Box, { style: { width: w.value } }, () => [h(LineChart, { labels, series })]))
  const img = chartImage(c)
  expect((img.props.src as Canvas).width).toBe(800)
  w.value = 300; await nextTick(); root.tick(); await flush()
  expect((img.props.src as Canvas).width).toBe(600); expect((img.props.src as Canvas).height).toBe(400)
})
it('the width loop ends once the root has no Surfaces: a disposed root, whose afterTick resolves at once, does not spin', async () => {
  const root = createFakeRoot()
  mountGlass(() => h(LineChart, { labels: ['一', '二'], series: [{ name: 'a', data: [1, 2] }] }), { root })   // no Surface at all
  let calls = 0
  // as a disposed root's afterTick (bounded here, so a spin fails the test instead of hanging it)
  root.afterTick = () => ++calls > 50 ? new Promise<void>(() => {}) : Promise.resolve()
  root.tick(); for (let i = 0; i < 10; i++) await flush()
  expect(calls).toBe(0)
})
it('LineChart: a touch does not hover (core spec §8.3); a mouse does', async () => {
  const root = createFakeRoot(), seen: unknown[] = []
  const c = await laidOut(root, () => h(Box, { style: { width: 400 } }, () => [h(LineChart, { labels: ['一', '二', '三'], series: [{ name: '入库', data: [1, 3, 2] }], onHover: (e: unknown) => seen.push(e) })]))
  const img = chartImage(c), box = img.parent!, src = img.props.src
  box.handlers.get('pointermove')!({ localX: 222, localY: 50, pointerType: 'touch' } as never); await nextTick()
  expect(seen).toEqual([]); expect(box.children.some(isPanel)).toBe(false); expect(img.props.src).toBe(src)
  box.handlers.get('pointermove')!({ localX: 222, localY: 50, pointerType: 'mouse' } as never); await nextTick()
  expect(seen).toEqual([{ index: 1, label: '二', values: [3] }]); expect(box.children.some(isPanel)).toBe(true)
})
it('LineChart errors name the prop', () => {
  const err = (props: Record<string, unknown>) => mountGlass(() => h(LineChart, props)).errors[0]
  expect(err({ labels: ['a'], series: [] })).toMatch(/^GlassUIError: \[LineChart\.labels\] 至少 2 项，得到 1 项/)
  expect(err({ labels: ['a', 'b'], series: { name: 'x', data: [1, 2] } })).toMatch(/\[LineChart\.series\] 类型应为 array，得到 object/)
  expect(err({ labels: ['a', 'b'], series: [{ name: 'x', data: { a: 1, b: 2 } }] })).toMatch(/\[LineChart\.series\.0\.data\] 类型应为 array，得到 object/)
  expect(err({ labels: ['a', 'b'], series: [{ name: 'x', data: [1, Infinity] }] })).toMatch(/\[LineChart\.series\.0\.data\.1\] 类型应为 number，得到 Infinity/)
  expect(err({ labels: ['a', 'b'], series: [{ name: 'x', data: [1, 2] }, { name: '出库', data: [1, 2, 3] }] })).toBe('GlassUIError: [LineChart.series] 第 2 条系列 "出库" 有 3 个点，labels 有 2 个')
  expect(err({ labels: ['a', 'b'], series: [{ name: 'x', data: [1, 2], colour: 'red' }] })).toMatch(/\[LineChart\.series\.0\] 未知属性 "colour"。允许值：name, data, color。你可能想要：color/)
  expect(err({ labels: ['a', 'b'], series: [{ name: 'x', data: [1, 2], color: 'acent' }] })).toMatch(/\[LineChart\.series\.0\.color\] 未知颜色 token "acent".*你可能想要：accent/)
})
it('LineChart is registered with complete manifest metadata', () => {
  const c = glassComponents().find(g => g.glass.name === 'LineChart')!
  expect(c).toBeDefined()
  expect(c.glass.description.length).toBeGreaterThan(40); expect(c.glass.examples.length).toBeGreaterThanOrEqual(2); expect(c.glass.examples.length).toBeLessThanOrEqual(3)
  for (const [k, s] of Object.entries(c.glass.props.shape)) expect((s as { description?: string }).description, `LineChart.${k}`).toMatch(/[一-鿿]/)
  for (const e of c.glass.examples) expect(e).toMatch(/<LineChart\b/)
  const mistakes = c.glass.mistakes!.map(m => m.mistake).join('\n')
  expect(mistakes).toMatch(/data.*对象/); expect(mistakes).toMatch(/labels.*长度/)
  expect(Object.keys(c.glass.events!)).toEqual(['hover'])
})

it('LineChart legend: a dot 6 pt before its label, centred on it; in a Card the dot rides the Card\'s glass with the label', async () => {
  const root = createFakeRoot()
  mountGlass(() => onSurface(() => h(Card, null, () => [h(LineChart, { labels: ['一', '二'], series: [{ name: '入库', data: [1, 2] }, { name: '出库', data: [2, 3] }] })])), { root })
  root.tick(); await flush(); root.tick()
  const s = root.surfacesMade[0]!, chart = chartImage(s.root).parent!.parent!, row = chart.children[0]!
  for (const item of row.children) {
    const [dot, label] = item.children as [Node, Node], d = absoluteRect(dot), l = absoluteRect(label)
    expect([d.width, d.height]).toEqual([8, 8])
    expect(l.x - (d.x + d.width)).toBe(6)                                             // the gap
    expect(Math.abs(d.y + d.height / 2 - (l.y + l.height / 2))).toBeLessThanOrEqual(0.5)   // centred on the label's line (to yoga's rounding)
  }
  // the render partition (spatial spec §2.4, §11.8 / render `partition`): text, images and panels inside glass ride on
  // it; the dot is an image riding the Card's glass with its label, not a panel
  const parts = partition(buildRenderList(s.model, defaultTheme, 'light')), card = chart.parent!   // the Card's box (bg glass)
  for (const item of row.children) {
    const [dot, label] = item.children as [Node, Node]
    expect(parts.foreground.images.some(i => i.node === dot)).toBe(true)
    expect(parts.glassOf.get(dot)?.node).toBe(card); expect(parts.glassOf.get(label)?.node).toBe(card)
    expect(parts.content.panels.some(p => p.node === dot)).toBe(false)
  }
})
