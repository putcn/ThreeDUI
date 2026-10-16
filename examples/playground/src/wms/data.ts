/**
 * The 云仓 WMS demo's mock data (spatial spec §4, §12.4): a fictional retail logistics operator in Xuzhou — its main
 * warehouse 徐州一号仓, three more warehouses and a chain of stores across the city's districts — on Thursday
 * 2026-10-15. Generated from a fixed seed (`SEED`) so every load, screenshot and test sees the same numbers; the views
 * read the exports, `createWmsData(seed)` makes the same shape from any seed (the tests check it is deterministic).
 *
 * The figures agree with each other: the twin's bins are the six zones' racks (row A is zone A), so a zone's stock is
 * its bins' quantities summed and the utilisation KPI is the bins' mean occupancy; today's outbound KPI is the last
 * point of the 30-day flow, and the latest order is that day's last number; the order in 异常 (a daily-chemicals
 * customer's) is the one an alert names, short at a daily-chemicals bin. The outbound heat surface's days add up to the
 * flow's; the zone × category stock adds up to 徐州一号仓's on-hand on the network map, whose SKU count is the KPI's.
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

/**
 * Orders per hour over the 14 whole days before `TODAY` (the overview's heat surface): `hours` '00'–'23', `days`
 * 'MM-DD' oldest first, `values[day][hour]`; a day's hours add up to its outbound orders in the 30-day flow.
 */
export interface Heat { hours: string[]; days: string[]; values: number[][] }
/**
 * 徐州一号仓's stock by zone × category (the overview's matrix): `values[zone][category]` pieces, `cover` the days of
 * stock that cell holds at its current outbound rate (周转天数). Each zone's main category is its twin row's.
 */
export interface StockMatrix { rows: string[]; cols: string[]; values: number[][]; cover: number[][] }

/** What a place on the logistics map is. */
export type LocationKind = 'warehouse' | 'store' | 'supplier'
/**
 * A place on the logistics map (spatial spec §12.4), at WGS-84 `lon`/`lat` inside the district it names (a supplier:
 * past the city's south-east edge, where its lanes come in; `district` is then its home region). `onhand` pieces in
 * stock, `skus` SKUs stocked, `outOfStock` of them at zero.
 */
export interface Location { id: string; name: string; kind: LocationKind; district: string; lon: number; lat: number; onhand: number; skus: number; outOfStock: number }
/** 计划 (leaves later today), 在途 (on the road, on time), 逾期 (on the road, past its due time). */
export type LaneStatus = 'planned' | 'transit' | 'overdue'
/**
 * A run between two places today: a transfer (调拨, warehouse → store or warehouse) or a purchase (采购, supplier →
 * warehouse); `qty` pieces; `time` 'HH:mm' it left (planned: leaves).
 */
export interface Lane { id: string; from: string; to: string; kind: 'transfer' | 'purchase'; qty: number; status: LaneStatus; time: string }
export interface Network { locations: Location[]; lanes: Lane[] }

export interface WmsData {
  kpis: Kpi[]
  /** Today's outbound orders (the 今日出库单 KPI). */
  outboundToday: number
  /** The bins' mean occupancy, 0–1 (the 库位利用率 KPI). */
  utilisation: number
  flow30d: Flow
  zones: Zone[]
  bins: Bin[]
  orders: Order[]
  alerts: Alert[]
  heat: Heat
  stock: StockMatrix
  network: Network
}

/** The bins' occupancy bands, lowest first: a bin is in the last band whose `min` its occupancy reaches. */
export const BIN_LEVELS = [
  { key: 'free', label: '空闲', color: '#7aa7ff', min: 0 },
  { key: 'normal', label: '正常', color: '#a59bff', min: 0.3 },
  { key: 'busy', label: '繁忙', color: '#ffb86b', min: 0.75 },
  { key: 'full', label: '满载', color: '#ff7b7b', min: 0.95 },
] as const
export type BinLevel = (typeof BIN_LEVELS)[number]
/** The band `occupancy` (0–1) falls in. */
export function binLevel(occupancy: number): BinLevel {
  let level: BinLevel = BIN_LEVELS[0]
  for (const l of BIN_LEVELS) if (occupancy >= l.min) level = l
  return level
}

/** The bin the 异常 order came up short at (a daily-chemicals bin, zone C), and what it holds. */
export const SHORT_PICK = { bin: 'C-06-2', qty: 6, wanted: 8 } as const

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
  // the short pick the second alert reports
  const short = bins.find(b => b.id === SHORT_PICK.bin)!
  short.qty = SHORT_PICK.qty; short.occupancy = SHORT_PICK.qty / short.cap
  return bins
}

/**
 * The hours' share of a day's outbound orders, 00–23: a working day's morning (10–11 h) and afternoon (15–16 h) peaks
 * round a lunch dip, with an evening tail of online orders; a weekend's or holiday's peaks lower and later, its evening
 * fuller. Normalised in `makeHeat`.
 */
const HOURS = {
  work: [0.8, 0.5, 0.4, 0.3, 0.3, 0.5, 1.2, 2.6, 5.0, 7.8, 9.6, 9.2, 5.6, 6.4, 8.2, 9.4, 8.8, 6.2, 3.8, 3.0, 2.6, 2.0, 1.4, 1.0],
  rest: [1.1, 0.7, 0.5, 0.4, 0.3, 0.4, 0.7, 1.4, 2.8, 4.6, 6.0, 6.8, 6.2, 5.4, 5.8, 6.4, 6.8, 6.2, 5.0, 4.6, 4.2, 3.4, 2.4, 1.6],
} as const

/** The 14 whole days before `TODAY`, by hour: each day's flow total spread over the hours (±6 % noise), summing to it. */
function makeHeat(rand: () => number, flow: Flow): Heat {
  const end = Date.UTC(TODAY.year, TODAY.month - 1, TODAY.day), heat: Heat = { hours: HOURS.work.map((_, h) => pad(h)), days: [], values: [] }
  for (let i = 14; i >= 1; i--) {
    const date = new Date(end - i * DAY_MS), m = date.getUTCMonth() + 1, d = date.getUTCDate(), wd = date.getUTCDay()
    const label = `${pad(m)}-${pad(d)}`, total = flow.outbound[flow.labels.indexOf(label)]!
    const shape = wd === 0 || wd === 6 || (m === 10 && d <= 7) ? HOURS.rest : HOURS.work
    const w = shape.map(x => x * (0.94 + rand() * 0.12)), sum = w.reduce((a, b) => a + b, 0)
    const row = w.map(x => Math.round(total * x / sum))
    // the rounding's remainder goes to the busiest hour, so the day adds up exactly
    const top = row.indexOf(Math.max(...row)); row[top]! += total - row.reduce((a, b) => a + b, 0)
    heat.days.push(label); heat.values.push(row)
  }
  return heat
}

/** The matrix's categories, in its columns' order, and each zone's main one (its twin row's goods: A 食品 … F 数码). */
export const CATEGORIES = ['食品', '饮料', '日化', '家居', '数码', '母婴'] as const
const ZONE_CATEGORY = [0, 1, 2, 3, 5, 4] as const
/** Days of cover by category: drinks and food turn fastest, electronics and homeware slowest. */
const COVER = [9, 7, 18, 34, 46, 15] as const

/** 徐州一号仓's stock by zone × category: each zone mostly its main category, some of the others. */
function makeStock(rand: () => number): StockMatrix {
  const values = ROW_NAMES.map((_, z) => CATEGORIES.map((_, c) => {
    const main = ZONE_CATEGORY[z] === c
    return Math.round((main ? 15_000 + rand() * 11_000 : 900 + rand() * (rand() < 0.3 ? 8_000 : 3_600)) / 10) * 10
  }))
  // zone C, the full one (the alert's), holds more days of cover; zone F, the emptiest, fewer
  const cover = values.map((row, z) => row.map((_, c) => Math.max(2, Math.round(COVER[c]! * (0.72 + rand() * 0.56) * (z === 2 ? 1.25 : z === 5 ? 0.85 : 1)))))
  return { rows: ROW_NAMES.map(n => `${n} 区`), cols: [...CATEGORIES], values, cover }
}

/** A store's stock state, by the share of its SKUs out of stock: the map's prism colours and the legend. */
export const STOCK_LEVELS = [
  { key: 'ok', label: '货源充足', color: '#7ee0b0', below: 0.008 },
  { key: 'tight', label: '偏紧', color: '#ffb86b', below: 0.025 },
  { key: 'out', label: '缺货', color: '#ff7b8a', below: Infinity },
] as const
export type StockLevel = (typeof STOCK_LEVELS)[number]
/** The level of a place with `outOfStock` of its `skus` at zero. */
export function stockLevel(l: Pick<Location, 'skus' | 'outOfStock'>): StockLevel {
  const share = l.skus > 0 ? l.outOfStock / l.skus : 0
  return STOCK_LEVELS.find(s => share < s.below) ?? STOCK_LEVELS[2]
}
/** Each kind's name and colour on the map (a store's prism is coloured by its stock level instead: its colour here is the legend's neutral swatch). */
export const KINDS = {
  warehouse: { label: '仓库', color: '#f2c46d' },
  store: { label: '门店', color: '#b9c4da' },
  supplier: { label: '供应商', color: '#a9b4ff' },
} as const

/**
 * The places: four warehouses (the main one in 鼓楼, 二号仓 in 云龙, 三号仓 in 铜山, a cross-dock in 贾汪), 24 stores of
 * the 星河超市 chain across the districts and counties, and two suppliers whose lanes enter from the south-east. Each
 * store: [name, district, lon, lat, level]; its stock is drawn from the seed to match its level.
 */
const WAREHOUSES = [
  ['WH-1', '徐州一号仓', '鼓楼区', 117.235, 34.315],
  ['WH-2', '徐州二号仓', '云龙区', 117.300, 34.235],
  ['WH-3', '徐州三号仓', '铜山区', 117.170, 34.150],
  ['WH-4', '贾汪中转仓', '贾汪区', 117.420, 34.420],
] as const
const STORES = [
  ['黄楼店', '鼓楼区', 117.200, 34.278, 'ok'], ['下淀店', '鼓楼区', 117.245, 34.290, 'tight'], ['琵琶店', '鼓楼区', 117.160, 34.318, 'ok'],
  ['大郭庄店', '云龙区', 117.275, 34.225, 'ok'], ['潘塘店', '云龙区', 117.300, 34.180, 'tight'], ['翠屏山店', '云龙区', 117.225, 34.240, 'ok'],
  ['矿大店', '泉山区', 117.150, 34.225, 'out'], ['湖滨店', '泉山区', 117.165, 34.245, 'ok'], ['王陵店', '泉山区', 117.180, 34.262, 'ok'], ['金山桥店', '泉山区', 117.110, 34.300, 'ok'],
  ['新城区店', '铜山区', 117.200, 34.180, 'ok'], ['大学城店', '铜山区', 117.110, 34.180, 'tight'], ['柳新店', '铜山区', 117.080, 34.350, 'ok'],
  ['贾汪店', '贾汪区', 117.460, 34.440, 'ok'], ['大吴店', '贾汪区', 117.360, 34.330, 'ok'],
  ['丰县店', '丰县', 116.595, 34.695, 'tight'], ['华山店', '丰县', 116.720, 34.590, 'ok'],
  ['沛县店', '沛县', 116.935, 34.725, 'ok'], ['龙固店', '沛县', 116.830, 34.880, 'ok'],
  ['睢宁店', '睢宁县', 117.945, 33.905, 'ok'], ['双沟店', '睢宁县', 117.830, 33.800, 'out'],
  ['新沂店', '新沂市', 118.345, 34.370, 'ok'],
  ['邳州店', '邳州市', 117.960, 34.320, 'tight'], ['官湖店', '邳州市', 118.050, 34.480, 'out'],
] as const
const SUPPLIERS = [
  ['SP-1', '禾丰供应链', '浙江', 118.420, 33.880, 64_000, 1_260],
  ['SP-2', '鼎沃贸易', '上海', 118.600, 34.030, 52_000, 980],
] as const
/** Each warehouse's stock (WH-1's is the zone × category matrix's total), SKUs and SKUs out (WH-1's SKUs: the KPI). */
const WAREHOUSE_STOCK = [[0, 12_486, 23], [128_400, 9_820, 41], [96_700, 8_240, 37], [18_600, 2_150, 9]] as const

/**
 * Today's runs: [from, to, status] (a store by its name). Each warehouse supplies the stores round it (the counties from
 * the nearest warehouse on the expressways); 一号仓 tops up the cross-dock and 三号仓; the suppliers' purchase lanes
 * come in from the south-east, two of them overdue.
 */
const LANES = [
  ['WH-1', '黄楼店', 'transit'], ['WH-1', '下淀店', 'transit'], ['WH-1', '琵琶店', 'planned'], ['WH-1', '王陵店', 'transit'],
  ['WH-1', '金山桥店', 'transit'], ['WH-1', '丰县店', 'transit'], ['WH-1', '沛县店', 'transit'],
  ['WH-2', '大郭庄店', 'transit'], ['WH-2', '潘塘店', 'transit'], ['WH-2', '翠屏山店', 'planned'], ['WH-2', '湖滨店', 'transit'], ['WH-2', '矿大店', 'transit'],
  ['WH-3', '新城区店', 'transit'], ['WH-3', '大学城店', 'transit'], ['WH-3', '柳新店', 'planned'], ['WH-3', '睢宁店', 'transit'], ['WH-3', '双沟店', 'transit'],
  ['WH-4', '贾汪店', 'transit'], ['WH-4', '大吴店', 'planned'], ['WH-4', '邳州店', 'transit'], ['WH-4', '官湖店', 'transit'], ['WH-4', '新沂店', 'planned'],
  ['WH-1', 'WH-4', 'transit'], ['WH-1', 'WH-3', 'transit'],
  ['SP-1', 'WH-1', 'overdue'], ['SP-1', 'WH-3', 'transit'], ['SP-2', 'WH-1', 'transit'], ['SP-2', 'WH-2', 'overdue'],
] as const

/** The stores' ids: 'ST-01' … in `STORES` order. */
const storeId = (i: number): string => `ST-${pad(i + 1)}`

/** The network: the places (warehouses, then stores, then suppliers) and today's lanes. */
function makeNetwork(rand: () => number, stock: StockMatrix): Network {
  const between = (lo: number, hi: number, step = 10): number => Math.round((lo + rand() * (hi - lo)) / step) * step
  const total = stock.values.flat().reduce((a, b) => a + b, 0)
  const locations: Location[] = [
    ...WAREHOUSES.map(([id, name, district, lon, lat], i): Location => {
      const [onhand, skus, outOfStock] = WAREHOUSE_STOCK[i]!
      return { id, name, kind: 'warehouse', district, lon, lat, onhand: i === 0 ? total : onhand, skus, outOfStock }
    }),
    ...STORES.map(([name, district, lon, lat, level], i): Location => {
      const skus = between(1_800, 3_400)
      // out of stock: under 0.8 % of SKUs (ok), up to 2.5 % (tight), more (out)
      const share = level === 'ok' ? 0.001 + rand() * 0.006 : level === 'tight' ? 0.01 + rand() * 0.012 : 0.03 + rand() * 0.02
      return { id: storeId(i), name: `星河超市 · ${name}`, kind: 'store', district, lon, lat, onhand: between(2_400, 8_800), skus, outOfStock: Math.round(skus * share) }
    }),
    ...SUPPLIERS.map(([id, name, district, lon, lat, onhand, skus]): Location => ({ id, name, kind: 'supplier', district, lon, lat, onhand, skus, outOfStock: 0 })),
  ]
  const idOf = (key: string): string => (key.includes('-') ? key : storeId(STORES.findIndex(s => s[0] === key)))
  const lanes = LANES.map(([from, to, status], i): Lane => {
    const a = idOf(from), b = idOf(to), kind = a.startsWith('SP') ? 'purchase' : 'transfer'
    const qty = kind === 'purchase' ? between(6_000, 14_000, 100) : b.startsWith('WH') ? between(3_600, 8_400, 100) : between(280, 1_600)
    // left this morning (overdue: since 05:00, due by noon), or leaves this afternoon
    const minutes = status === 'planned' ? 15 * 60 + 10 * i : status === 'overdue' ? 5 * 60 + 25 * i % 60 : 8 * 60 + 13 * i
    return { id: `LN-${pad(i + 1)}`, from: a, to: b, kind, qty, status, time: `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}` }
  })
  return { locations, lanes }
}

/** The demo's data from `seed` (`SEED` for the exports below). */
export function createWmsData(seed: number): WmsData {
  const rand = mulberry32(seed)
  const flow30d = makeFlow(rand), bins = makeBins(rand)
  const zones = ROW_NAMES.map((name, row) => ({ label: `${name} 区`, value: bins.filter(b => b.row === row).reduce((sum, b) => sum + b.qty, 0) }))
  const utilisation = bins.reduce((sum, b) => sum + b.occupancy, 0) / bins.length
  const today = flow30d.outbound[29]!, yesterday = flow30d.outbound[28]!
  const heat = makeHeat(rand, flow30d), stock = makeStock(rand), network = makeNetwork(rand, stock)
  const kpis: Kpi[] = [
    { label: '库存 SKU', value: grouped(network.locations[0]!.skus), delta: 1.6 },
    { label: '今日出库单', value: grouped(today), unit: '单', delta: change(today, yesterday) },
    { label: '准时发货率', value: '98.6', unit: '%', delta: 0.3 },
    { label: '库位利用率', value: (utilisation * 100).toFixed(1), unit: '%', delta: -1.1 },
  ]
  const fullC = bins.filter(b => b.row === 2 && b.occupancy >= 0.95).length
  // today's latest orders by their last update, numbered in the day's sequence: the newest is today's outbound count
  const no = (n: number): string => `SO261015-${String(n).padStart(4, '0')}`
  const orders: Order[] = [
    { no: no(today), customer: '禾谷生鲜', items: 36, status: '待拣货', time: '14:32' },
    { no: no(today - 2), customer: '星河超市·黄楼店', items: 124, status: '待拣货', time: '14:27' },
    { no: no(today - 5), customer: '青禾母婴', items: 18, status: '拣货中', time: '14:19' },
    { no: no(today - 9), customer: '优格家居旗舰店', items: 9, status: '拣货中', time: '14:05' },
    { no: no(today - 13), customer: '蓝鲸日化', items: SHORT_PICK.wanted, status: '异常', time: '13:58' },
    { no: no(today - 19), customer: '鹿野咖啡', items: 48, status: '已发货', time: '13:41' },
    { no: no(today - 24), customer: '北辰数码', items: 6, status: '已发货', time: '13:26' },
    { no: no(today - 30), customer: '木子文具', items: 72, status: '已发货', time: '13:12' },
  ]
  const odd = orders.find(o => o.status === '异常')!
  const alerts: Alert[] = [
    { level: 'danger', title: `C 区 ${fullC} 个库位满载`, detail: '占用率已达 95% 以上，建议将慢动销 SKU 调拨至 F 区', time: '8 分钟前' },
    { level: 'warning', title: `订单 ${odd.no} 拣货异常`, detail: `库位 ${SHORT_PICK.bin} 实际 ${SHORT_PICK.qty} 件，少于应拣 ${SHORT_PICK.wanted} 件，已通知盘点`, time: '21 分钟前' },
    { level: 'warning', title: 'AGV-02 电量 18%', detail: '当前任务完成后自动返回充电位', time: '35 分钟前' },
  ]
  return { kpis, outboundToday: today, utilisation, flow30d, zones, bins, orders, alerts, heat, stock, network }
}

export const { kpis, outboundToday, utilisation, flow30d, zones, bins, orders, alerts, heat, stock, network } = createWmsData(SEED)
