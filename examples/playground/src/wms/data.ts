/**
 * The 云仓 WMS demo's mock data (spatial spec §4): a fictional mid-size warehouse in Shanghai, 上海一号仓, on Thursday
 * 2026-10-15. Generated from a fixed seed (`SEED`) so every load, screenshot and test sees the same numbers; the views
 * read the exports, `createWmsData(seed)` makes the same shape from any seed (the tests check it is deterministic).
 *
 * The figures agree with each other: the twin's bins are the six zones' racks (row A is zone A), so a zone's stock is
 * its bins' quantities summed and the utilisation KPI is the bins' mean occupancy; today's outbound KPI is the last
 * point of the 30-day flow; the order in 异常 is the one an alert names, at the bin it names.
 */

/** The seed of the exported data. */
export const SEED = 20261015

/** A 32-bit seeded PRNG (mulberry32): uniform in [0, 1), the same sequence for the same seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** One KPI tile: `value` as shown (thousands grouped), `unit` after it (absent: none), `delta` in % against yesterday. */
export interface Kpi { label: string; value: string; unit?: string; delta: number }
/** The daily flow of the 30 days ending on `TODAY`: `labels` 'MM-DD', inbound and outbound orders per day. */
export interface Flow { labels: string[]; inbound: number[]; outbound: number[] }
/** A storage zone and its stock in pieces. */
export interface Zone { label: string; value: number }
/**
 * One bin (库位) of the twin: `id` 'A-03-2' (row letter, bay 01–10, level 1–4 from the floor), where it stands (`row`
 * 0–5 = A–F from the back, `bay` 0–9 from the left, `level` 0–3 from the floor), the SKU it holds and its name, the
 * quantity, the capacity, and `occupancy` = qty / cap.
 */
export interface Bin { id: string; row: number; bay: number; level: number; sku: string; name: string; qty: number; cap: number; occupancy: number }
export type OrderStatus = '待拣货' | '拣货中' | '已发货' | '异常'
export interface Order { no: string; customer: string; items: number; status: OrderStatus; time: string }
export interface Alert { level: 'danger' | 'warning'; title: string; detail: string; time: string }

export interface WmsData {
  kpis: Kpi[]
  flow30d: Flow
  zones: Zone[]
  bins: Bin[]
  orders: Order[]
  alerts: Alert[]
}

/** The warehouse's racks: rows A–F, 10 bays a row, 4 levels a bay. */
export const RACKS = { rows: 6, bays: 10, levels: 4 } as const
export const ROW_NAMES = ['A', 'B', 'C', 'D', 'E', 'F'] as const
/** Each zone's goods, by row: its SKU prefix, its items and their capacity per bin (pieces). */
const GOODS = [
  { prefix: 'FD', cap: [90, 170], items: ['每日坚果 750g', '燕麦片 1kg', '五常大米 5kg', '橄榄油 1L', '苏打饼干 400g', '黑芝麻糊 600g', '红枣 500g', '海苔 40g×10'] },
  { prefix: 'BV', cap: [64, 116], items: ['矿泉水 550ml×24', '无糖绿茶 500ml×15', '苏打水 330ml×24', '燕麦奶 1L×6', '冷萃咖啡 270ml×12', '椰子水 1L×6', '乌龙茶 500ml×15'] },
  { prefix: 'DC', cap: [90, 170], items: ['洗衣凝珠 52 颗', '洗发水 750ml', '沐浴露 1L', '抽纸 3 层×24 包', '洗洁精 1.5kg', '牙膏 120g×3', '洗手液 500ml'] },
  { prefix: 'HM', cap: [40, 96], items: ['收纳箱 55L', '保温杯 500ml', '真空压缩袋 8 件', '衣架 20 只装', '密封罐 6 件套', '浴室防滑垫', 'LED 台灯'] },
  { prefix: 'MB', cap: [60, 130], items: ['纸尿裤 L 码 54 片', '婴儿湿巾 80 抽×6', '奶瓶 240ml', '婴儿洗衣液 1L', '辅食米粉 250g', '儿童牙刷 4 支'] },
  { prefix: 'EL', cap: [100, 210], items: ['蓝牙耳机', '65W 快充充电器', '数据线 1m×2', '移动电源 10000mAh', '无线鼠标', '智能手环', '手机支架'] },
] as const
/**
 * How full each zone runs (its mean occupancy before noise): C (daily chemicals) is the hot zone the alert is about, F
 * (electronics, slow movers) the cold one the alert suggests moving stock to.
 */
const ZONE_FILL = [0.83, 0.81, 0.94, 0.82, 0.84, 0.64] as const
/** Upper levels hold reserve stock and run fuller; the ground level is the pick face, emptied and topped up all day. */
const LEVEL_FILL = [-0.12, 0.0, 0.05, 0.08] as const

/** The demo's day: 2026-10-15, a Thursday. */
export const TODAY = { year: 2026, month: 10, day: 15, label: '2026年10月15日 周四' } as const
const DAY_MS = 86_400_000
/** Orders by weekday (Sunday first), as a factor of the trend: outbound peaks on Monday and Friday, receiving early in the week (the weekend's replenishment arrives on Monday). */
const WEEKDAY = { out: [0.74, 1.06, 1.04, 1.0, 1.02, 1.08, 0.8], in: [0.56, 1.18, 1.1, 1.0, 0.98, 0.94, 0.62] } as const
/** The National Day holiday (10-01 to 10-07): a pre-holiday rush, a holiday lull, a restock after. */
function holiday(m: number, d: number, dir: 'in' | 'out'): number {
  if (m === 9 && d >= 27) return dir === 'out' ? 1.16 : 1.05
  if (m === 10 && d <= 5) return dir === 'out' ? 0.58 : 0.42
  if (m === 10 && d <= 7) return dir === 'out' ? 0.8 : 0.7
  if (m === 10 && d <= 10) return dir === 'out' ? 1.06 : 1.32
  return 1
}

/** `n` with thousands grouped: 12486 → '12,486'. */
export const grouped = (n: number): string => Math.round(n).toLocaleString('en-US')
const pad = (n: number): string => String(n).padStart(2, '0')
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
/** A % change rounded to one decimal: 1932 against 1782 → 8.4. */
const change = (now: number, before: number): number => Math.round((now / before - 1) * 1000) / 10

/** The 30 days ending on `TODAY`: a slow upward trend, the weekday rhythm, the holiday, ±5 % noise. */
function makeFlow(rand: () => number): Flow {
  const end = Date.UTC(TODAY.year, TODAY.month - 1, TODAY.day), flow: Flow = { labels: [], inbound: [], outbound: [] }
  for (let i = 29; i >= 0; i--) {
    const date = new Date(end - i * DAY_MS), m = date.getUTCMonth() + 1, d = date.getUTCDate(), wd = date.getUTCDay()
    const trend = 1 + (29 - i) / 29 * 0.1, noise = (): number => 0.95 + rand() * 0.1
    flow.labels.push(`${pad(m)}-${pad(d)}`)
    flow.outbound.push(Math.round(1640 * trend * WEEKDAY.out[wd]! * holiday(m, d, 'out') * noise()))
    flow.inbound.push(Math.round(1320 * trend * WEEKDAY.in[wd]! * holiday(m, d, 'in') * noise()))
  }
  // today and yesterday as the outbound KPI states them: 1,932 orders, +8.4 %
  flow.outbound[29] = 1932; flow.outbound[28] = 1782
  return flow
}

/** Every bin, row A–F, bay 1–10, level 1–4 (that order: bin i is the twin's instance i). */
function makeBins(rand: () => number): Bin[] {
  const bins: Bin[] = []
  for (let row = 0; row < RACKS.rows; row++) {
    const goods = GOODS[row]!
    for (let bay = 0; bay < RACKS.bays; bay++) {
      for (let level = 0; level < RACKS.levels; level++) {
        const [lo, hi] = goods.cap, cap = Math.round((lo + rand() * (hi - lo)) / 4) * 4
        // the zone's fill, the level's, and a bay-to-bay spread; now and then a bin nearly empty, mostly a ground-level
        // pick face waiting to be topped up
        const occupancy = rand() < (level === 0 ? 0.22 : 0.04) ? 0.05 + rand() * 0.22 : clamp(ZONE_FILL[row]! + LEVEL_FILL[level]! + (rand() - 0.5) * 0.36, 0.3, 1)
        const qty = Math.round(occupancy * cap), item = Math.floor(rand() * goods.items.length)
        bins.push({
          id: `${ROW_NAMES[row]}-${pad(bay + 1)}-${level + 1}`, row, bay, level,
          sku: `${goods.prefix}-${String(10000 + Math.floor(rand() * 90000))}`, name: goods.items[item]!,
          qty, cap, occupancy: qty / cap,
        })
      }
    }
  }
  // the short pick the second alert reports: B-04-2 holds 6 pieces
  const short = bins.find(b => b.id === 'B-04-2')!
  short.qty = 6; short.occupancy = 6 / short.cap
  return bins
}

/** The demo's data from `seed` (`SEED` for the exports below). */
export function createWmsData(seed: number): WmsData {
  const rand = mulberry32(seed)
  const flow30d = makeFlow(rand), bins = makeBins(rand)
  const zones = ROW_NAMES.map((name, row) => ({ label: `${name} 区`, value: bins.filter(b => b.row === row).reduce((sum, b) => sum + b.qty, 0) }))
  const utilisation = bins.reduce((sum, b) => sum + b.occupancy, 0) / bins.length
  const today = flow30d.outbound[29]!, yesterday = flow30d.outbound[28]!
  const kpis: Kpi[] = [
    { label: '库存 SKU', value: grouped(12486), delta: 1.6 },
    { label: '今日出库单', value: grouped(today), unit: '单', delta: change(today, yesterday) },
    { label: '准时发货率', value: '98.6', unit: '%', delta: 0.3 },
    { label: '库位利用率', value: (utilisation * 100).toFixed(1), unit: '%', delta: -1.1 },
  ]
  const fullC = bins.filter(b => b.row === 2 && b.occupancy >= 0.95).length
  const orders: Order[] = [
    { no: 'SO261015-0418', customer: '禾谷生鲜', items: 36, status: '待拣货', time: '14:32' },
    { no: 'SO261015-0417', customer: '星河超市·徐汇店', items: 124, status: '待拣货', time: '14:27' },
    { no: 'SO261015-0415', customer: '青禾母婴', items: 18, status: '拣货中', time: '14:19' },
    { no: 'SO261015-0412', customer: '优格家居旗舰店', items: 9, status: '拣货中', time: '14:05' },
    { no: 'SO261015-0396', customer: '蓝鲸日化', items: 8, status: '异常', time: '13:58' },
    { no: 'SO261015-0391', customer: '鹿野咖啡', items: 48, status: '已发货', time: '13:41' },
    { no: 'SO261015-0388', customer: '北辰数码', items: 6, status: '已发货', time: '13:26' },
    { no: 'SO261015-0380', customer: '木子文具', items: 72, status: '已发货', time: '13:12' },
  ]
  const alerts: Alert[] = [
    { level: 'danger', title: `C 区 ${fullC} 个库位满载`, detail: '占用率已达 95% 以上，建议将慢动销 SKU 调拨至 F 区', time: '8 分钟前' },
    { level: 'warning', title: '订单 SO261015-0396 拣货异常', detail: '库位 B-04-2 实际 6 件，少于应拣 8 件，已通知盘点', time: '21 分钟前' },
    { level: 'warning', title: 'AGV-02 电量 18%', detail: '当前任务完成后自动返回充电位', time: '35 分钟前' },
  ]
  return { kpis, flow30d, zones, bins, orders, alerts }
}

export const { kpis, flow30d, zones, bins, orders, alerts } = createWmsData(SEED)
