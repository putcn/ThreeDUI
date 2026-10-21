import { describe, it, expect } from 'vitest'
import { Box3, Color, InstancedMesh, Matrix4, Mesh, Vector3, type BufferGeometry, type Object3D } from 'three'
import { defaultTheme } from '@glassui/core'
import type { Viewport3DContext } from '@glassui/render'
import { alerts, binLevel, bins, CATEGORIES, createWmsData, dashboardSeries, flow30d, heat, HOLIDAY, holidayFactor, isDayOff, kpis, laneSummary, lanesOf, mulberry32, network, orders, outboundToday, SEED, SHORT_PICK, stock, stockLevel, utilisation, zones } from '../src/wms/data'
import { AGV_SPEED, createWarehouse, HOVER_LIFT, YAW_LIMIT } from '../src/wms/warehouse'

const ctx = (o: Partial<Viewport3DContext> = {}): Viewport3DContext => ({ width: 1200, height: 680, reducedMotion: false, theme: defaultTheme, scheme: 'light', ...o })
const named = (root: Object3D, name: string): Object3D => { const o = root.getObjectByName(name); if (!o) throw new Error(`no ${name}`); return o }
/** The model's lowest point off the plate (z, pt): the floor slab's lowest vertex. */
function lowestZ(group: Object3D): number {
  group.updateMatrixWorld(true)
  const floor = named(group, 'floor') as Mesh, pos = (floor.geometry as BufferGeometry).getAttribute('position'), p = new Vector3()
  let low = Infinity
  for (let i = 0; i < pos.count; i++) low = Math.min(low, p.fromBufferAttribute(pos, i).applyMatrix4(floor.matrixWorld).z)
  return low
}

describe('wms data', () => {
  it('mulberry32 is a seeded uniform PRNG: the same seed, the same sequence', () => {
    const a = mulberry32(7), b = mulberry32(7), c = mulberry32(8)
    const xs = Array.from({ length: 100 }, a), ys = Array.from({ length: 100 }, b), zs = Array.from({ length: 100 }, c)
    expect(xs).toEqual(ys); expect(xs).not.toEqual(zs)
    expect(xs.every(x => x >= 0 && x < 1)).toBe(true)
    expect(Math.abs(xs.reduce((s, x) => s + x, 0) / xs.length - 0.5)).toBeLessThan(0.1)
  })
  it('is deterministic: the exports are the fixed seed\'s data, made again the same; another seed differs', () => {
    expect(createWmsData(SEED)).toEqual({ kpis, outboundToday, utilisation, flow30d, zones, bins, orders, alerts, heat, stock, network, dashboardSeries })
    expect(createWmsData(SEED)).toEqual(createWmsData(SEED))
    expect(createWmsData(SEED + 1).bins).not.toEqual(bins)
  })
  it('the 30 days end on 2026-10-15, in the hundreds to low thousands; today\'s outbound is the KPI', () => {
    expect(flow30d.labels).toHaveLength(30); expect(flow30d.labels[0]).toBe('09-16'); expect(flow30d.labels.at(-1)).toBe('10-15')
    for (const s of [flow30d.inbound, flow30d.outbound]) { expect(s).toHaveLength(30); expect(s.every(v => Number.isInteger(v) && v >= 100 && v < 5000)).toBe(true) }
    expect(kpis.map(k => k.label)).toEqual(['库存 SKU', '今日出库单', '准时发货率', '库位利用率'])
    expect(kpis[1]).toEqual({ label: '今日出库单', value: '1,932', unit: '单', delta: 8.4 }); expect(outboundToday).toBe(flow30d.outbound.at(-1))
    expect('unit' in kpis[0]!).toBe(false)                                       // absent, not undefined
  })
  it('240 bins with unique ids, row A–F × bay 01–10 × level 1–4, occupancy = qty / cap', () => {
    expect(bins).toHaveLength(6 * 10 * 4)
    expect(new Set(bins.map(b => b.id)).size).toBe(bins.length)
    for (const b of bins) {
      expect(b.id).toBe(`${'ABCDEF'[b.row]}-${String(b.bay + 1).padStart(2, '0')}-${b.level + 1}`)
      expect(b.qty).toBeGreaterThanOrEqual(0); expect(b.qty).toBeLessThanOrEqual(b.cap); expect(b.occupancy).toBeCloseTo(b.qty / b.cap, 12)
    }
    // every band shows in the twin
    expect(new Set(bins.map(b => binLevel(b.occupancy).key))).toEqual(new Set(['free', 'normal', 'busy', 'full']))
  })
  it('the zones are their rows\' stock, in the thousands; the utilisation KPI is the bins\' mean occupancy', () => {
    expect(zones.map(z => z.label)).toEqual(['A 区', 'B 区', 'C 区', 'D 区', 'E 区', 'F 区'])
    zones.forEach((z, row) => expect(z.value).toBe(bins.filter(b => b.row === row).reduce((s, b) => s + b.qty, 0)))
    expect(zones.every(z => z.value >= 1000 && z.value < 5000)).toBe(true)
    const mean = bins.reduce((s, b) => s + b.occupancy, 0) / bins.length
    expect(utilisation).toBe(mean); expect(kpis[3]!.value).toBe((mean * 100).toFixed(1))
  })
  it('dashboard today, week and month KPI and chart summaries use deterministic seeded series', () => {
    const a = createWmsData(SEED).dashboardSeries, b = createWmsData(SEED).dashboardSeries
    expect(a).toEqual(b)
    expect(a.today).toHaveLength(4); expect(a.week).toHaveLength(4); expect(a.month).toHaveLength(4)
    expect(a.today[1]).toBe(outboundToday)
    expect(a.week[1]).toBe(flow30d.outbound.slice(-7).reduce((x, y) => x + y, 0))
    expect(a.month[1]).toBe(flow30d.outbound.reduce((x, y) => x + y, 0))
    expect(a.summary.today).toHaveLength(3); expect(a.summary.week).toHaveLength(3); expect(a.summary.month).toHaveLength(3)
    expect(a.refreshSteps).toHaveLength(8); expect(a.refreshSteps.every(x => x > 0)).toBe(true)
  })
  it('8 orders, newest first and numbered in the day (the newest is today\'s outbound count), every status shown', () => {
    expect(orders).toHaveLength(8)
    expect(new Set(orders.map(o => o.status))).toEqual(new Set(['待拣货', '拣货中', '已发货', '异常']))
    expect([...orders.map(o => o.time)].sort().reverse()).toEqual(orders.map(o => o.time))
    const n = orders.map(o => Number(/^SO261015-(\d{4})$/.exec(o.no)![1]))
    expect(n[0]).toBe(outboundToday); expect([...n].sort((a, b) => b - a)).toEqual(n); expect(n.every(x => x >= 1900)).toBe(true)
  })
  it('the heat surface: the 14 whole days before today by hour, each day adding up to its outbound orders; working days peak at 10–11 h and 15–16 h, days off run lower', () => {
    expect(heat.days).toEqual(['10-01', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07', '10-08', '10-09', '10-10', '10-11', '10-12', '10-13', '10-14'])
    expect(heat.hours).toEqual(Array.from({ length: 24 }, (_, h) => `${h} 时`))   // the readout says "12 时"
    heat.values.forEach((row, i) => {
      expect(row).toHaveLength(24); expect(row.every(v => Number.isInteger(v) && v >= 0)).toBe(true)
      expect(row.reduce((a, b) => a + b, 0)).toBe(flow30d.outbound[flow30d.labels.indexOf(heat.days[i]!)])
    })
    // a working day (10-13, a Tuesday): its two busiest hours are in the two peaks, round a lunch dip; nights are quiet
    const tue = heat.values[12]!, top2 = [...tue.keys()].sort((a, b) => tue[b]! - tue[a]!).slice(0, 2).sort((a, b) => a - b)
    expect([10, 11]).toContain(top2[0]); expect([15, 16]).toContain(top2[1])
    expect(tue[12]!).toBeLessThan(Math.min(tue[10]!, tue[15]!) * 0.75); expect(tue[3]!).toBeLessThan(tue[10]! * 0.06)
    // the weekend after the holiday (10-10, 10-11) runs below the working days round it
    const total = (i: number): number => heat.values[i]!.reduce((a, b) => a + b, 0)
    expect(Math.max(total(9), total(10))).toBeLessThan(Math.min(total(8), total(11)))
  })
  it('the stock matrix: zones A–F × the six categories, each zone mostly its twin row\'s goods; it adds up to 徐州一号仓\'s on-hand; days of cover by category', () => {
    expect(stock.rows).toEqual(['A 区', 'B 区', 'C 区', 'D 区', 'E 区', 'F 区']); expect(stock.cols).toEqual([...CATEGORIES])
    expect(stock.cols).toEqual(['食品', '饮料', '日化', '家居', '数码', '母婴'])
    for (const m of [stock.values, stock.cover]) { expect(m).toHaveLength(6); expect(m.every(r => r.length === 6 && r.every(v => Number.isInteger(v) && v > 0))).toBe(true) }
    // the twin's rows: A 食品 (FD), B 饮料 (BV), C 日化 (DC), D 家居 (HM), E 母婴 (MB), F 数码 (EL)
    const main = [0, 1, 2, 3, 5, 4]
    stock.values.forEach((row, z) => expect(row.indexOf(Math.max(...row))).toBe(main[z]))
    const wh1 = network.locations.find(l => l.id === 'WH-1')!
    expect(stock.values.flat().reduce((a, b) => a + b, 0)).toBe(wh1.onhand)
    // electronics and homeware turn slowest, drinks fastest
    const mean = (c: number): number => stock.cover.reduce((s, r) => s + r[c]!, 0) / 6
    expect(mean(4)).toBeGreaterThan(mean(3)); expect(mean(3)).toBeGreaterThan(mean(2)); expect(mean(1)).toBeLessThan(mean(0))
  })
  it('the network: 4 warehouses, 24 stores, 2 suppliers; its lanes join places that exist, two overdue purchases among them; 徐州一号仓\'s SKUs are the KPI\'s', () => {
    const of = (k: string) => network.locations.filter(l => l.kind === k)
    expect(of('warehouse').map(l => l.name)).toEqual(['徐州一号仓', '徐州二号仓', '徐州三号仓', '贾汪中转仓'])
    expect(of('warehouse').map(l => l.district)).toEqual(['鼓楼区', '云龙区', '铜山区', '贾汪区'])
    expect(of('store')).toHaveLength(24); expect(of('supplier').map(l => l.district)).toEqual(['浙江', '上海'])
    expect(new Set(network.locations.map(l => l.id)).size).toBe(network.locations.length)
    expect(kpis[0]!.value).toBe(of('warehouse')[0]!.skus.toLocaleString('en-US'))
    // the stores' stock levels: most enough, a few tight, a few out
    const levels = of('store').map(l => stockLevel(l).key)
    expect(levels.filter(k => k === 'ok').length).toBeGreaterThan(12); expect(levels.filter(k => k === 'tight').length).toBeGreaterThanOrEqual(3); expect(levels.filter(k => k === 'out').length).toBeGreaterThanOrEqual(2)
    for (const l of network.locations) { expect(l.outOfStock).toBeLessThanOrEqual(l.skus); expect(l.onhand).toBeGreaterThan(0) }
    const ids = new Set(network.locations.map(l => l.id))
    for (const lane of network.lanes) {
      expect(ids.has(lane.from) && ids.has(lane.to)).toBe(true)
      expect(lane.kind).toBe(lane.from.startsWith('SP') ? 'purchase' : 'transfer')
      expect(lane.from.startsWith('ST')).toBe(false)                              // stores only receive
      expect(lane.time).toMatch(/^\d{2}:\d{2}$/)
    }
    const overdue = network.lanes.filter(l => l.status === 'overdue')
    expect(overdue).toHaveLength(2); expect(overdue.every(l => l.kind === 'purchase')).toBe(true)
    expect(network.lanes.filter(l => l.status === 'transit').length).toBeGreaterThan(15)
    // the customer in today's orders is one of the chain's stores
    expect(orders.some(o => network.locations.some(l => l.name.replace(' · ', '·') === o.customer))).toBe(true)
  })
  it('a day off is a weekend or the National Day holiday (10-01 to 10-07): one rule for the heat surface and the overview\'s averages', () => {
    expect(['10-01', '10-04', '10-07', '10-10', '10-11'].map(isDayOff)).toEqual([true, true, true, true, true])
    expect(['10-08', '10-09', '10-12', '10-14', '10-15'].map(isDayOff)).toEqual([false, false, false, false, false])
    expect(heat.days.filter(isDayOff)).toEqual(['10-01', '10-02', '10-03', '10-04', '10-05', '10-06', '10-07', '10-10', '10-11'])
  })
  it('the holiday is set once (HOLIDAY): its days are the days off it makes and the flow\'s lull, with the rush before and the restock after (Task 9P R4)', () => {
    expect(HOLIDAY).toEqual({ month: 10, day: 1, days: 7 })
    for (const label of flow30d.labels) {
      const [m, d] = label.split('-').map(Number) as [number, number]
      const inIt = m === HOLIDAY.month && d >= HOLIDAY.day && d < HOLIDAY.day + HOLIDAY.days
      const weekday = ![0, 6].includes(new Date(Date.UTC(2026, m - 1, d)).getUTCDay())
      if (weekday) expect(isDayOff(label), label).toBe(inIt)
      expect(holidayFactor(m, d, 'out') < 1, label).toBe(inIt)                       // the lull is exactly the holiday
    }
    expect(holidayFactor(9, 27, 'out')).toBeGreaterThan(1); expect(holidayFactor(9, 26, 'out')).toBe(1)   // the rush: four days before
    expect(holidayFactor(10, 10, 'in')).toBeGreaterThan(1); expect(holidayFactor(10, 11, 'in')).toBe(1)   // the restock: three days after
  })
  it('the place panel\'s lane summaries: "→ 7 家门店、2 个仓库 · n 件" out of 一号仓, "← 2 家供应商 · n 件" into it', () => {
    const { inbound, outbound } = lanesOf(network, 'WH-1')
    const sum = (ls: typeof inbound): string => ls.reduce((s, l) => s + l.qty, 0).toLocaleString('en-US')
    expect(laneSummary(network, outbound, 'out')).toBe(`→ 7 家门店、2 个仓库 · ${sum(outbound)} 件`)
    expect(laneSummary(network, inbound, 'in')).toBe(`← 2 家供应商 · ${sum(inbound)} 件`)
    expect(laneSummary(network, [], 'in')).toBe('—')
  })
  it('2–3 alerts: one names the order in 异常 (a 日化 customer\'s), short at a 日化 bin (zone C) holding what it says', () => {
    expect(alerts.length).toBeGreaterThanOrEqual(2); expect(alerts.length).toBeLessThanOrEqual(3)
    const odd = orders.find(o => o.status === '异常')!, alert = alerts.find(a => a.title.includes(odd.no))!
    expect(odd.customer).toContain('日化'); expect(odd.items).toBe(SHORT_PICK.wanted)
    const bin = bins.find(b => b.id === SHORT_PICK.bin)!
    expect(bin.row).toBe(2); expect(bin.sku.startsWith('DC-')).toBe(true); expect(bin.qty).toBe(SHORT_PICK.qty)
    expect(alert.detail).toContain(`库位 ${bin.id} 实际 ${bin.qty} 件`)
  })
})

describe('warehouse model', () => {
  it('draws the bins as one InstancedMesh of 6 × 10 × 4, coloured by occupancy band; binAt maps an instance to its bin', () => {
    const w = createWarehouse({ bins })
    expect(w.bins).toBeInstanceOf(InstancedMesh); expect(w.bins.count).toBe(240)
    const c = new Color()
    for (const i of [0, 57, 239]) expect(w.bins.getColorAt(i, c).getHexString()).toBe(new Color(binLevel(bins[i]!.occupancy).color).getHexString())
    expect(w.binAt(57)).toBe(bins[57]); expect(() => w.binAt(240)).toThrow(/240/)
    // instanced frames and lines too: a handful of draw calls, not hundreds
    let draws = 0
    w.group.traverse(o => { if (o instanceof Mesh) draws++ })
    expect(draws).toBeLessThanOrEqual(11)
    expect(named(w.group, 'frames')).toBeInstanceOf(InstancedMesh)
  })
  it('hover lightens exactly one bin at once and raises it 6 pt; hover(null) puts it back', () => {
    const w = createWarehouse({ bins }), c = new Color()
    const colours = (): string[] => Array.from({ length: 240 }, (_, i) => w.bins.getColorAt(i, c).getHexString())
    const y = (i: number): number => { const m = new Matrix4(); w.bins.getMatrixAt(i, m); return new Vector3().setFromMatrixPosition(m).y }
    const before = colours(), rest = y(57)
    w.hover(57)
    const after = colours()
    expect(after.filter((h, i) => h !== before[i])).toHaveLength(1); expect(after[57]).not.toBe(before[57])
    const lit = new Color(`#${after[57]}`), base = new Color(`#${before[57]}`)
    expect(lit.r + lit.g + lit.b).toBeGreaterThan(base.r + base.g + base.b)
    w.update(1 / 60, ctx({ reducedMotion: true }))
    expect(y(57)).toBeCloseTo(rest + HOVER_LIFT, 6)
    w.hover(null); w.update(1 / 60, ctx({ reducedMotion: true }))
    expect(colours()).toEqual(before); expect(y(57)).toBeCloseTo(rest, 6)
    expect(() => w.hover(240)).toThrow(/240/)
  })
  it('pins the investigated bin in red and lifted while other hover comes and goes', () => {
    const w = createWarehouse({ bins }), index = bins.findIndex(bin => bin.id === SHORT_PICK.bin), c = new Color(), m = new Matrix4()
    const y = (): number => { w.bins.getMatrixAt(index, m); return new Vector3().setFromMatrixPosition(m).y }
    const rest = y()
    w.trace(index); w.update(1 / 60, ctx({ reducedMotion: true }))
    const beacon = named(w.group, 'trace-beacon')
    expect(beacon.visible).toBe(true)
    expect(beacon.position.x).not.toBe(0)
    expect(w.bins.getColorAt(index, c).getHexString()).toBe(new Color('#ff3b30').getHexString())
    expect(y()).toBeCloseTo(rest + HOVER_LIFT * 1.8, 5)
    w.hover(index + 1); w.hover(null); w.update(1 / 60, ctx({ reducedMotion: true }))
    expect(w.bins.getColorAt(index, c).getHexString()).toBe(new Color('#ff3b30').getHexString())
    w.trace(null); w.update(1 / 60, ctx({ reducedMotion: true }))
    expect(beacon.visible).toBe(false)
    expect(w.bins.getColorAt(index, c).getHexString()).toBe(new Color(binLevel(bins[index]!.occupancy).color).getHexString())
    expect(y()).toBeCloseTo(rest, 6)
  })
  it('fits its box, stands on the glass and never behind it, at every yaw; rotateBy clamps to ±0.8', () => {
    const w = createWarehouse({ bins }), c = ctx({ reducedMotion: true }), yaw = named(w.group, 'yaw')
    for (const dx of [0, -5, 10]) {
      w.rotateBy(dx); w.update(1 / 60, c)
      expect(Math.abs(yaw.rotation.y)).toBeLessThanOrEqual(YAW_LIMIT)
      const low = lowestZ(w.group)
      expect(low).toBeGreaterThanOrEqual(0.99); expect(low).toBeLessThan(3)
    }
    expect(yaw.rotation.y).toBeCloseTo(YAW_LIMIT, 9)
    w.rotateBy(-YAW_LIMIT); w.update(1 / 60, c)
    const box = new Box3().setFromObject(w.group)
    expect(box.max.x - box.min.x).toBeLessThanOrEqual(c.width); expect(box.max.y - box.min.y).toBeLessThanOrEqual(c.height)
    expect(box.max.x - box.min.x).toBeGreaterThan(c.width * 0.6)                 // fills it, give or take the margins
    expect(Math.abs(box.max.y + box.min.y)).toBeLessThan(c.height * 0.1)
  })
  it('the yaw eases; the AGV drives at 120 pt/s, and parks under reduced motion', () => {
    const w = createWarehouse({ bins }), agv = named(w.group, 'agv'), yaw = named(w.group, 'yaw')
    w.update(0, ctx())
    const x0 = agv.position.x
    expect(w.update(0.25, ctx())).toBe(true)
    expect(agv.position.x - x0).toBeCloseTo(AGV_SPEED * 0.25, 6)               // along the front lane, facing +x
    w.rotateBy(0.5); w.update(1 / 60, ctx())
    expect(yaw.rotation.y).toBeGreaterThan(0); expect(yaw.rotation.y).toBeLessThan(0.5)
    const parked = agv.position.clone()
    for (let i = 0; i < 10; i++) w.update(0.1, ctx({ reducedMotion: true }))
    expect(agv.position).toEqual(parked); expect(yaw.rotation.y).toBe(0.5)
    expect(w.update(0.1, ctx({ reducedMotion: true }))).toBe(false)
  })
  it('dispose frees every geometry and material', () => {
    const w = createWarehouse({ bins }), freed = new Set<unknown>(), owned = new Set<{ addEventListener(t: 'dispose', f: () => void): void }>()
    w.group.traverse(o => {
      if (!(o instanceof Mesh)) return
      owned.add(o.geometry as BufferGeometry)
      for (const m of [o.material].flat()) owned.add(m)
    })
    for (const x of owned) x.addEventListener('dispose', () => { freed.add(x) })
    expect(owned.size).toBeGreaterThanOrEqual(8)
    w.dispose()
    expect(freed.size).toBe(owned.size)
    expect(w.group.children).toHaveLength(0)
  })
})
