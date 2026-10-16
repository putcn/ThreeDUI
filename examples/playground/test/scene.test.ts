import { describe, it, expect, vi, afterEach } from 'vitest'
import { h, nextTick } from 'vue'
import { Euler, InstancedMesh, LineSegments, Matrix4, Mesh, Quaternion, Vector3, type BufferGeometry, type Material, type Object3D } from 'three'
import { absoluteRect, defaultTheme, type Node } from '@glassui/core'
import { fitDistance } from '@glassui/render/internal'
import { flush, type FakeRoot, type FakeSurface } from '../../../packages/vue/test/fixtures/fake-root'
import { mountGlass } from '../../../packages/vue/test/fixtures/mount'
import Spatial from '../src/scenes/Spatial.vue'
import { bins, heat, kpis, network, orders, stock } from '../src/wms/data'
import { YAW_LIMIT } from '../src/wms/warehouse'
import { laneSummary, lanesOf, LIMITS } from '../src/wms/map'
import { arcPastel, createCurvedWall, MAX_U_LENGTH } from '../src/wall'
import { ARC, BLOCKS, inFrameOf, NETWORK, PANEL, PLACE_PANEL, TWIN, WALL, wallSpan } from '../src/scenes/spatial-arc'

/** pt per world unit (the Blocks' and the panel's). */
const PT = 244

/** The scene mounted on a fake root, focused on `focus`, laid out (a few ticks: the Blocks measure after one). */
async function scene(focus: string, motion: 'live' | 'frozen' = 'live') {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const m = mountGlass(() => h(Spatial, { initialFocus: focus }), { motion })
  for (let i = 0; i < 3; i++) { await flush(); m.root.tick(); await nextTick() }
  await flush()
  const [orders, overview, network, twin] = m.root.surfacesMade as [FakeSurface, FakeSurface, FakeSurface, FakeSurface]
  return { ...m, warn, orders, overview, network, twin }
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

/** The text nodes under `n` whose value is `value` (a fragment run's text included). */
function texts(n: Node, value: string, out: Node[] = []): Node[] {
  if (n.type === 'text' && n.props.value === value) out.push(n)
  for (const c of n.children) texts(c, value, out)
  return out
}
const textOf = (n: Node): string => (n.type === 'text' ? String(n.props.value ?? '') : '') + n.children.map(textOf).join('')
/** The twin's model as attached, its Viewport3D's box, and that attachment's `update`. */
function model(twin: FakeSurface) {
  const a = twin.attached[0]!
  const group = a.object as Object3D, update = a.opts.update!
  return { node: a.node, group, update, bins: group.getObjectByName('bins') as InstancedMesh }
}
const ctx = (node: Node, reducedMotion = true) => ({ width: node.layout.width, height: node.layout.height, reducedMotion, theme: defaultTheme, scheme: 'light' as const })

describe('the WMS scene', () => {
  it('mounts its four Blocks (orders, overview, network, twin) with no error and no content taller than its Block', async () => {
    const s = await scene('overview')
    expect(s.errors).toEqual([])
    expect(s.warn).not.toHaveBeenCalled()
    expect(s.root.surfacesMade).toHaveLength(4)
    expect([s.orders, s.overview, s.network, s.twin].map(x => [x.model.width, x.model.height])).toEqual([BLOCKS.orders, BLOCKS.overview, BLOCKS.network, BLOCKS.twin].map(b => [b.width, b.height]))
    // the overview's content: the KPIs, and the two 3D charts, as tall as each other: the outbound heat surface (14
    // days × 24 hours) and the zone × category matrix coloured by its days of cover
    for (const k of kpis) expect(texts(s.overview.root, k.label)).toHaveLength(1)
    expect(texts(s.overview.root, '近 14 天出库热力')).toHaveLength(1); expect(texts(s.overview.root, '库区 × 品类 库存')).toHaveLength(1)
    expect(s.overview.attached).toHaveLength(2)
    const [surface, matrix] = [(s.root as FakeRoot).surfaceCharts[0]!, (s.root as FakeRoot).barMatrices[0]!]
    expect(surface.set.mock.lastCall![0].values).toEqual(heat.values); expect(heat.values).toHaveLength(14); expect(heat.values[0]).toHaveLength(24)
    expect(matrix.set.mock.lastCall![0].values).toEqual(stock.values); expect(matrix.set.mock.lastCall![0].colors).toHaveLength(6)
    expect(matrix.labels.mock.lastCall![0]).toEqual({ rows: ['A 区', 'B 区', 'C 区', 'D 区', 'E 区', 'F 区'], cols: ['食品', '饮料', '日化', '家居', '数码', '母婴'] })
    const [a, b] = s.overview.attached.map(x => x.node.layout.height)
    expect(a).toBe(b)
    expect(textOf(s.overview.root)).toContain('周转')
    // the network: its title, counts and legend, the map attached, the credit
    expect(texts(s.network.root, '物流网络 · 徐州')).toHaveLength(1)
    expect(textOf(s.network.root)).toContain('4 个仓库 · 24 家门店 · 2 家供应商')
    for (const label of ['门店', '仓库', '供应商', '货源充足', '偏紧', '缺货']) expect(textOf(s.network.root)).toContain(label)
    expect(texts(s.network.root, '© OpenStreetMap contributors · DataV')).toHaveLength(1)
    expect(s.network.attached).toHaveLength(1); expect((s.network.attached[0]!.object as Object3D).name).toBe('network-map')
    // the orders: every order's number, and the alerts
    for (const o of orders) expect(texts(s.orders.root, o.no)).toHaveLength(1)
    expect(textOf(s.orders.root)).toContain('异常告警')
  })

  it('the twin stands at its explicit pose (its arc slot); the focus is the overview, the camera aimed at it', async () => {
    const s = await scene('twin')
    expect(s.twin.restPose.position.map(v => +v.toFixed(9))).toEqual(TWIN.position.map(v => +v.toFixed(9)))
    expect(s.twin.restPose.rotation[1]).toBeCloseTo(TWIN.rotation[1], 9)
    const o = await scene('overview')
    expect(o.root.rigs[0]!.focus.mock.lastCall![0]).toBe(o.overview)
  })

  it('a tab or a breadcrumb focuses its Block', async () => {
    const s = await scene('overview')
    const click = async (surface: FakeSurface, label: string): Promise<void> => {
      const [t] = texts(surface.root, label)
      surface.events.dispatch(t!, 'click', {}); await nextTick(); await flush()
    }
    await click(s.overview, '订单')
    expect(s.root.rigs[0]!.focus.mock.lastCall![0]).toBe(s.orders)
    await click(s.orders, '总览')
    expect(s.root.rigs[0]!.focus.mock.lastCall![0]).toBe(s.overview)
    await click(s.overview, '仓储孪生')
    expect(s.root.rigs[0]!.focus.mock.lastCall![0]).toBe(s.twin)
    await click(s.twin, '总览'); await click(s.overview, '物流网络')
    expect(s.root.rigs[0]!.focus.mock.lastCall![0]).toBe(s.network)
    await click(s.network, '总览')
    expect(s.root.rigs[0]!.focus.mock.lastCall![0]).toBe(s.overview)
  })

  it('hovering a bin floats the glass info panel in front of the twin, showing the bin; leaving the model hides it', async () => {
    const s = await scene('twin'), { node, bins: mesh } = model(s.twin), at = { node, object: mesh, instanceId: 57 }
    s.twin.pointer.move(-999, -999, 'mouse', at); await nextTick(); await flush()
    const panel = s.root.surfacesMade[4]!
    expect(panel).toBeDefined()
    expect(panel.created).toMatchObject({ layer: 'world', width: PANEL.width, height: PANEL.height, ptPerUnit: PANEL.ptPerUnit, background: 'glass', interactive: false })
    expect(panel.castShadows).toBe(false)                                          // no slab of shadow across the twin
    const pose = inFrameOf(TWIN, PANEL.offset)
    expect(panel.restPose.position.map(v => +v.toFixed(6))).toEqual(pose.position.map(v => +v.toFixed(6)))   // flown in to its place
    expect(panel.restPose.opacity).toBe(1)
    expect(panel.animations[0]!.from.opacity).toBe(0)
    const shown = textOf(panel.root)
    expect(shown).toContain(bins[57]!.id); expect(shown).toContain(bins[57]!.sku)
    // another bin: the same panel, its content
    s.twin.pointer.move(-999, -999, 'mouse', { ...at, instanceId: 3 }); await nextTick(); await flush()
    expect(s.root.surfacesMade).toHaveLength(5); expect(textOf(panel.root)).toContain(bins[3]!.id)
    // off the model: gone
    s.twin.pointer.move(5, 5, 'mouse'); await nextTick(); await flush()
    expect(panel.disposed).toBe(true)
  })

  it('crossing a gap between bins keeps the panel up; a moment off the bins takes it down', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await scene('twin'), { node, group, bins: mesh } = model(s.twin)
    s.twin.pointer.move(-999, -999, 'mouse', { node, object: mesh, instanceId: 10 }); await nextTick(); await flush()
    s.twin.pointer.move(-999, -999, 'mouse', { node, object: group.getObjectByName('frames'), instanceId: 4 }); await nextTick(); await flush()
    vi.advanceTimersByTime(100); await nextTick(); await flush()
    expect(s.root.surfacesMade[4]!.disposed).toBe(false)
    s.twin.pointer.move(-999, -999, 'mouse', { node, object: mesh, instanceId: 11 }); await nextTick(); await flush()
    vi.advanceTimersByTime(1000); await nextTick(); await flush()
    expect(s.root.surfacesMade[4]!.disposed).toBe(false)                         // back on a bin in time
    s.twin.pointer.move(-999, -999, 'mouse', { node, object: group.getObjectByName('floor') }); await nextTick()
    vi.advanceTimersByTime(1000); await nextTick(); await flush()
    expect(s.root.surfacesMade[4]!.disposed).toBe(true)
  })

  it('no panel while the twin is not the focus: its content takes no pointer', async () => {
    const s = await scene('overview'), { node, bins: mesh } = model(s.twin)
    s.twin.pointer.move(-999, -999, 'mouse', { node, object: mesh, instanceId: 57 }); await nextTick(); await flush()
    expect(s.root.surfacesMade).toHaveLength(4)
  })

  it('dragging across the twin turns the model by the pointer\'s canvas px (0.01 rad a px, ±0.8 at most), whatever lies under it, and hides the panel', async () => {
    const s = await scene('twin'), { node, group, update, bins: mesh } = model(s.twin), yaw = group.getObjectByName('yaw')!
    // what the bridge hands over as the pointer crosses the model: a bin, a frame, the floor, empty glass — each with
    // its own Surface point (a 3D hit's is taken onto the plate, so it jumps); only the canvas px are steady
    const under = [{ node, object: mesh, instanceId: 5 }, { node, object: group.getObjectByName('frames'), instanceId: 40 }, { node, object: group.getObjectByName('floor') }, undefined]
    const r = absoluteRect(node), at = (i: number) => [r.x + 300 + ((i * 37) % 90), r.y + 200 + ((i * 53) % 70)] as const
    s.twin.pointer.move(...at(0), 'mouse', under[0], { x: 500, y: 400 }); await nextTick(); await flush()
    expect(s.root.surfacesMade).toHaveLength(5)
    s.twin.pointer.down(...at(0), 'mouse', under[0], { x: 500, y: 400 }); await nextTick(); await flush()
    expect(s.root.surfacesMade[4]!.disposed).toBe(true)
    for (let i = 1; i <= 10; i++) s.twin.pointer.move(...at(i), 'mouse', under[i % under.length], { x: 500 + i * 6, y: 400 + i })   // 60 px in all
    update(1 / 60, ctx(node))
    expect(yaw.rotation.y).toBeCloseTo(0.6, 9)
    for (let i = 11; i <= 30; i++) s.twin.pointer.move(...at(i), 'mouse', under[i % under.length], { x: 500 + i * 6, y: 400 })
    update(1 / 60, ctx(node))
    expect(yaw.rotation.y).toBeCloseTo(YAW_LIMIT, 9)                              // 180 px: 1.8 rad, clamped
    s.twin.pointer.up(...at(31), 'mouse', under[0], { x: 700, y: 400 })
    // a mouse's click that ends a drag pins no panel; moving after the release hovers, and no longer turns
    await nextTick(); await flush(); expect(s.root.surfacesMade).toHaveLength(5)
    s.twin.pointer.move(...at(32), 'mouse', under[2], { x: 300, y: 400 })
    update(1 / 60, ctx(node))
    expect(yaw.rotation.y).toBeCloseTo(YAW_LIMIT, 9)
    // a drag from x to x − 100 across bins and frames: exactly 1 rad (0.8 → −0.2)
    s.twin.pointer.down(...at(0), 'mouse', under[1], { x: 300, y: 400 })
    for (let i = 1; i <= 5; i++) s.twin.pointer.move(...at(i), 'mouse', under[i % 2], { x: 300 - i * 20, y: 400 })
    update(1 / 60, ctx(node)); s.twin.pointer.up(...at(6), 'mouse', under[0], { x: 200, y: 400 })
    expect(yaw.rotation.y).toBeCloseTo(YAW_LIMIT - 1, 9)
  })

  it('a mouse click on a bin shows nothing (a mouse hovers); a tap shows the bin', async () => {
    const s = await scene('twin'), { node, bins: mesh } = model(s.twin), bin = { node, object: mesh, instanceId: 21 }
    for (const type of ['mouse', 'touch'] as const) {
      s.twin.pointer.down(-999, -999, type, bin); s.twin.pointer.up(-999, -999, type, bin); await nextTick(); await flush()
      if (type === 'mouse') { expect(s.root.surfacesMade).toHaveLength(4); s.twin.pointer.move(5, 5, 'mouse'); await nextTick(); await flush() }
    }
    expect(s.root.surfacesMade).toHaveLength(5); expect(textOf(s.root.surfacesMade[4]!.root)).toContain(bins[21]!.id)
  })

  it('under frozen motion the twin holds still: the AGV parks (screenshots are repeatable)', async () => {
    const s = await scene('twin', 'frozen'), { node, group, update } = model(s.twin), agv = group.getObjectByName('agv')!
    update(0, ctx(node, false)); const at = agv.position.clone()
    expect(update(0.5, ctx(node, false))).toBe(false)
    expect(agv.position).toEqual(at)
    const live = await scene('twin'), m = model(live.twin), car = m.group.getObjectByName('agv')!
    m.update(0, ctx(m.node, false)); const from = car.position.clone()
    expect(m.update(0.5, ctx(m.node, false))).toBe(true)
    expect(car.position.distanceTo(from)).toBeCloseTo(60, 6)
  })

  it('as the camera sees it, the info panel stays off the twin\'s title row and legend, and its footer, at any aspect', async () => {
    const s = await scene('twin'), content = s.twin.root.children.find(n => n.type === 'box')!.children[0]!.children.filter(n => n.type === 'box')
    const header = absoluteRect(content[0]!), footer = absoluteRect(content.at(-1)!)
    // the twin's frame (pt, centred, y up); the rig stands on its axis, `fitDistance` from its content plane
    const top = BLOCKS.twin.height / 2 - (header.y + header.height), bottom = BLOCKS.twin.height / 2 - footer.y
    const plane = 0.05 * Math.min(BLOCKS.twin.width, BLOCKS.twin.height), k = PT / PANEL.ptPerUnit
    const [px, py, pz] = PANEL.offset.map(v => v * PT) as [number, number, number], face = pz + 0.05 * PANEL.height * k   // its own slab
    for (const aspect of [21 / 9, 16 / 9, 16 / 10, 4 / 3]) {
      const d = fitDistance(BLOCKS.twin.width / PT, BLOCKS.twin.height / PT, 38, aspect, 0.08) * PT, eye = plane + d
      const grow = (eye - plane) / (eye - face), slip = (face - plane) * Math.tan(2.5 * Math.PI / 180)   // perspective; the parallax
      const seen = { top: (py + PANEL.height * k / 2) * grow + slip, bottom: (py - PANEL.height * k / 2) * grow - slip, right: (px + PANEL.width * k / 2) * grow + slip }
      expect(seen.top, `${aspect}`).toBeLessThan(top - 8)
      expect(seen.bottom, `${aspect}`).toBeGreaterThan(bottom + 8)
      expect(seen.right, `${aspect}`).toBeLessThan(BLOCKS.twin.width / 2 - 40)       // inside the Block's padding
      // and it looks about its nominal size there (300 × 170 pt)
      expect(PANEL.width * k * grow).toBeGreaterThan(260); expect(PANEL.width * k * grow).toBeLessThan(320)
    }
  })

  it('the info panel clears the model wherever it stands under it, at every yaw (its glass floats in front of the racks)', async () => {
    const s = await scene('twin'), { node, group, update } = model(s.twin)
    // the Viewport3D's box in the twin's own frame (pt, the centre the origin, y up); the model stands on the content
    // plane, the Block slab's thickness (5 % of its short side) over the Block's origin, where the panel's offset starts
    const r = absoluteRect(node), cx = r.x + r.width / 2 - BLOCKS.twin.width / 2, cy = BLOCKS.twin.height / 2 - (r.y + r.height / 2)
    const plane = 0.05 * Math.min(BLOCKS.twin.width, BLOCKS.twin.height)
    const [px, py, pz] = PANEL.offset.map(v => v * PT) as [number, number, number], turn = group.getObjectByName('yaw')!
    // its footprint in the twin's pt: its own pt are smaller (it has more of them to a unit)
    const W = PANEL.width * PT / PANEL.ptPerUnit, H = PANEL.height * PT / PANEL.ptPerUnit
    let worst = -Infinity
    for (let yaw = -YAW_LIMIT; yaw <= YAW_LIMIT + 1e-9; yaw += 0.1) {
      dragBy(s.twin, node, yaw - turn.rotation.y)                                 // turned as the user turns it, then settled
      update(1 / 60, ctx(node)); group.updateMatrixWorld(true)
      expect(turn.rotation.y).toBeCloseTo(yaw, 6)
      for (const p of points(group)) {
        const x = p.x + cx, y = p.y + cy, z = p.z + plane
        if (Math.abs(x - px) <= W / 2 && Math.abs(y - py) <= H / 2) worst = Math.max(worst, z)
      }
    }
    // the panel's back face is its position (its own slab sits in front of it); keep 20 pt of air
    expect(worst).toBeGreaterThan(plane)                                          // it does stand over racks
    expect(worst).toBeLessThan(pz - 20)
  })
})

describe('the network Block', () => {
  /** The map as attached: its group, its Viewport3D's box, that attachment's `update`, a kind's prisms, the plate. */
  function mapOf(net: FakeSurface) {
    const a = net.attached[0]!, group = a.object as Object3D
    return { node: a.node, group, update: a.opts.update!, prisms: (k: string) => group.getObjectByName(`places-${k}`) as InstancedMesh, plate: group.getObjectByName('plate')! }
  }
  /** The scene focused on the network, its map laid out (one update at its box). */
  async function networkScene(motion: 'live' | 'frozen' = 'live') {
    const s = await scene('network', motion), m = mapOf(s.network)
    m.update(1 / 60, ctx(m.node)); m.group.updateMatrixWorld(true)
    return { ...s, ...m }
  }
  /** A place's instance among its kind's prisms. */
  const instance = (id: string): { kind: string; i: number } => {
    const l = network.locations.find(x => x.id === id)!
    return { kind: l.kind, i: network.locations.filter(x => x.kind === l.kind).indexOf(l) }
  }
  /** Where a prism's foot is in the map's group (the plate's frame, pt), through its frames. */
  const footOf = (group: Object3D, id: string): Vector3 => {
    const { kind, i } = instance(id), mesh = group.getObjectByName(`places-${kind}`) as InstancedMesh, m = new Matrix4()
    mesh.getMatrixAt(i, m); group.updateMatrixWorld(true)
    return new Vector3().setFromMatrixPosition(m).applyMatrix4(mesh.matrixWorld).applyMatrix4(new Matrix4().copy(group.matrixWorld).invert())
  }

  it('stands at its explicit pose, the arc\'s slot between the overview and the twin', async () => {
    const s = await scene('network')
    expect(s.network.restPose.position.map(v => +v.toFixed(9))).toEqual(NETWORK.position.map(v => +v.toFixed(9)))
    expect(s.network.restPose.rotation[1]).toBeCloseTo(NETWORK.rotation[1], 9)
    // the slot after the overview's (which the Space lays out itself), and before the twin's
    const angle = (x: FakeSurface): number => -x.restPose.rotation[1]
    const pt = 244, step = (a: { width: number }, b: { width: number }): number => (a.width / pt / 2 + ARC.gap + b.width / pt / 2) / ARC.radius
    expect(angle(s.network) - angle(s.overview)).toBeCloseTo(step(BLOCKS.overview, BLOCKS.network), 9)
    expect(angle(s.twin) - angle(s.network)).toBeCloseTo(step(BLOCKS.network, BLOCKS.twin), 9)
    expect(s.root.rigs[0]!.focus.mock.lastCall![0]).toBe(s.network)
  })

  it('hovering a place floats the glass place panel on the far side of the map, showing the place; another place updates it; leaving hides it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const s = await networkScene(), on = (id: string) => { const { kind, i } = instance(id); return { node: s.node, object: s.prisms(kind), instanceId: i } }
    // 贾汪中转仓 shows right of the map's centre: the panel takes the left
    expect(footOf(s.group, 'WH-4').x).toBeGreaterThan(0)
    s.network.pointer.move(-999, -999, 'mouse', on('WH-4')); await nextTick(); await flush()
    const panel = s.root.surfacesMade[4]!
    expect(panel.created).toMatchObject({ layer: 'world', width: PLACE_PANEL.width, height: PLACE_PANEL.height, ptPerUnit: PLACE_PANEL.ptPerUnit, background: 'glass', interactive: false })
    expect(panel.castShadows).toBe(false)
    const left = inFrameOf(NETWORK, PLACE_PANEL.offset.left)
    expect(panel.restPose.position.map(v => +v.toFixed(6))).toEqual(left.position.map(v => +v.toFixed(6)))
    expect(panel.animations[0]!.from.opacity).toBe(0)
    const wh4 = network.locations.find(l => l.id === 'WH-4')!
    expect(textOf(panel.root)).toContain(wh4.name); expect(textOf(panel.root)).toContain(wh4.onhand.toLocaleString('en-US'))
    const runs = lanesOf(network, 'WH-4')
    expect(textOf(panel.root)).toContain(laneSummary(network, runs.outbound, 'out')); expect(textOf(panel.root)).toContain(laneSummary(network, runs.inbound, 'in'))
    expect(laneSummary(network, runs.outbound, 'out')).toMatch(/^→ 5 家门店 · [\d,]+ 件$/); expect(laneSummary(network, runs.inbound, 'in')).toMatch(/^← 1 个仓库 · [\d,]+ 件$/)
    // a store on the same side of the centre: the same panel, its content
    const st = network.locations.find(l => l.name.endsWith('贾汪店'))!
    s.network.pointer.move(-999, -999, 'mouse', on(st.id)); await nextTick(); await flush()
    expect(s.root.surfacesMade).toHaveLength(5); expect(textOf(panel.root)).toContain(st.name); expect(textOf(panel.root)).toContain('货源充足')
    // 琵琶店 shows left of it: the panel moves to the right (a new one flies in)
    const pp = network.locations.find(l => l.name.endsWith('琵琶店'))!
    expect(footOf(s.group, pp.id).x).toBeLessThan(0)
    s.network.pointer.move(-999, -999, 'mouse', on(pp.id)); await nextTick(); await flush()
    expect(panel.disposed).toBe(true)
    const right = s.root.surfacesMade[5]!
    expect(right.restPose.position.map(v => +v.toFixed(6))).toEqual(inFrameOf(NETWORK, PLACE_PANEL.offset.right).position.map(v => +v.toFixed(6)))
    expect(textOf(right.root)).toContain(pp.name)
    // off the places, onto the bare plate: it stays a moment (no blinking between neighbours), then goes
    s.network.pointer.move(-999, -999, 'mouse', { node: s.node, object: s.plate, point: [4000, 4000, 0] }); await nextTick()
    vi.advanceTimersByTime(100); await nextTick(); await flush()
    expect(right.disposed).toBe(false)
    vi.advanceTimersByTime(1000); await nextTick(); await flush()
    expect(right.disposed).toBe(true)
    expect(s.errors).toEqual([])
  })

  it('a point on the plate near a place picks it (small prisms are easy to hover); no panel while the network is not the focus', async () => {
    const s = await networkScene(), foot = footOf(s.group, 'WH-1')
    // left of its foot (下淀店 stands just south-east of it)
    s.network.pointer.move(-999, -999, 'mouse', { node: s.node, object: s.plate, point: [foot.x - 7, foot.y - 3, 0.2] }); await nextTick(); await flush()
    expect(textOf(s.root.surfacesMade[4]!.root)).toContain('徐州一号仓')
    const o = await scene('overview'), m = mapOf(o.network)
    m.update(1 / 60, ctx(m.node))
    o.network.pointer.move(-999, -999, 'mouse', { node: m.node, object: m.prisms('warehouse'), instanceId: 0 }); await nextTick(); await flush()
    expect(o.root.surfacesMade).toHaveLength(4)
  })

  it('the wheel zooms the map; a left drag pans it; a right drag (buttons & 2, no press) or a Shift drag turns it, and pitches it within its limits', async () => {
    const s = await networkScene(), ground = s.group.getObjectByName('ground')!, pan = s.group.getObjectByName('pan')!, yaw = s.group.getObjectByName('yaw')!, tilt = s.group.getObjectByName('tilt')!
    const settle = (): void => { s.update(1 / 60, ctx(s.node)) }, flat = { node: s.node, object: s.plate }
    const r = absoluteRect(s.node), x = r.x + r.width / 2, y = r.y + r.height / 2
    // the wheel: up zooms in
    const k0 = ground.scale.x
    s.network.events.dispatch(s.node, 'wheel', { x, y, deltaY: -300 }); settle()
    expect(ground.scale.x / k0).toBeCloseTo(Math.exp(300 * 0.0015), 6)
    // a left drag to the right: the map follows (its pan frame moves right on the plate), and does not turn
    const p0 = pan.position.clone(), yaw0 = yaw.rotation.z
    s.network.pointer.down(x, y, 'mouse', flat, { x: 500, y: 400 })
    for (let i = 1; i <= 5; i++) s.network.pointer.move(x + i * 10, y, 'mouse', flat, { x: 500 + i * 10, y: 400 })
    s.network.pointer.up(x + 50, y, 'mouse', flat, { x: 550, y: 400 }); settle()
    expect(pan.position.x - p0.x).toBeGreaterThan(30); expect(yaw.rotation.z).toBe(yaw0)
    // a right drag: contextmenu at its down, then moves that say the right button is held; no press anywhere
    s.network.pointer.contextMenu(x, y, 'mouse', { x: 500, y: 400 }, { buttons: 2 })
    for (let i = 1; i <= 5; i++) s.network.pointer.move(x, y, 'mouse', flat, { x: 500 + i * 8, y: 400 }, { buttons: 2 })
    settle()
    expect(s.node.state.pressed).toBe(false)
    expect(yaw.rotation.z - yaw0).toBeCloseTo(40 * 0.008, 6)
    // a Shift drag turns too, without panning; dragging up tilts it toward the horizon, never past 1.2
    const p1 = pan.position.clone(), yaw1 = yaw.rotation.z
    s.network.pointer.down(x, y, 'mouse', flat, { x: 500, y: 400 }, { shiftKey: true })
    for (let i = 1; i <= 40; i++) s.network.pointer.move(x, y, 'mouse', flat, { x: 500 - i, y: 400 - i * 20 }, { buttons: 1, shiftKey: true })
    s.network.pointer.up(x, y, 'mouse', flat, { x: 460, y: -400 }, { shiftKey: true }); settle()
    expect(yaw.rotation.z - yaw1).toBeCloseTo(-40 * 0.008, 6)
    expect(-tilt.rotation.x).toBeCloseTo(LIMITS.pitch[1], 9)
    expect(pan.position.distanceTo(p1)).toBeCloseTo(0, 6)
    // a plain move after the release hovers again, and moves nothing
    s.network.pointer.move(x, y, 'mouse', flat, { x: 300, y: 300 }); settle()
    expect(yaw.rotation.z - yaw1).toBeCloseTo(-40 * 0.008, 6)
  })

  it('the place panel clears the map wherever it stands under it, at every pitch, zoom and yaw, on either side', async () => {
    const s = await networkScene(), r = absoluteRect(s.node)
    // the map's box in the Block's own frame (pt, the centre the origin, y up); the map stands on the content plane, the
    // Block slab's thickness (5 % of its short side) over the Block's origin, where the panel's offset starts
    const cx = r.x + r.width / 2 - BLOCKS.network.width / 2, cy = BLOCKS.network.height / 2 - (r.y + r.height / 2)
    const plane = 0.05 * Math.min(BLOCKS.network.width, BLOCKS.network.height), pt = 244
    const W = PLACE_PANEL.width * pt / PLACE_PANEL.ptPerUnit, H = PLACE_PANEL.height * pt / PLACE_PANEL.ptPerUnit
    const at = { x: r.x + r.width / 2, y: r.y + r.height / 2 }, flat = { node: s.node, object: s.plate }
    let worst = -Infinity, under = 0
    for (const pitchPx of [0, -60, 200, -400]) for (const wheel of [0, -2000, 2000]) for (const turn of [0, 160]) {
      // pitched by a right drag (−400: past the steepest; 200: near the flattest), zoomed by the wheel, turned
      s.network.pointer.contextMenu(at.x, at.y, 'mouse', { x: 500, y: 400 }, { buttons: 2 })
      s.network.pointer.move(at.x, at.y, 'mouse', flat, { x: 500 + turn, y: 400 + pitchPx }, { buttons: 2 })
      s.network.events.dispatch(s.node, 'wheel', { x: at.x, y: at.y, deltaY: wheel })
      s.update(1 / 60, ctx(s.node)); s.group.updateMatrixWorld(true)
      for (const side of ['left', 'right'] as const) {
        const [px, py] = PLACE_PANEL.offset[side].map(v => v * pt) as [number, number, number]
        for (const p of mapPoints(s.group)) {
          if (Math.abs(p.x) > r.width / 2 || Math.abs(p.y) > r.height / 2) continue   // outside the window: not drawn
          const x = p.x + cx, y = p.y + cy
          if (Math.abs(x - px) <= W / 2 && Math.abs(y - py) <= H / 2) { worst = Math.max(worst, p.z + plane); under++ }
        }
      }
    }
    expect(under).toBeGreaterThan(1000)                                              // it does stand over the map
    expect(worst).toBeLessThan(PLACE_PANEL.offset.right[2] * pt - 20)                // and 20 pt of air under its back face
  })

  it('as the camera sees it, the place panel stays inside the map, off the title row and legend and the footer, at any aspect', async () => {
    const s = await networkScene(), content = s.network.root.children.find(n => n.type === 'box')!.children[0]!.children.filter(n => n.type === 'box')
    const header = absoluteRect(content[0]!), footer = absoluteRect(content.at(-1)!), box = absoluteRect(s.node)
    const { width: BW, height: BH } = BLOCKS.network, pt = 244
    const top = BH / 2 - (header.y + header.height), bottom = BH / 2 - footer.y, right = box.x + box.width - BW / 2
    expect(bottom).toBeLessThan(BH / 2 - (box.y + box.height) + 1)                   // the footer is under the map's box
    const plane = 0.05 * Math.min(BW, BH), k = pt / PLACE_PANEL.ptPerUnit
    const [px, py, pz] = PLACE_PANEL.offset.right.map(v => v * pt) as [number, number, number], face = pz + 0.05 * PLACE_PANEL.height * k
    for (const aspect of [21 / 9, 16 / 9, 16 / 10, 4 / 3]) {
      const d = fitDistance(BW / pt, BH / pt, 38, aspect, 0.08) * pt, eye = plane + d
      const grow = (eye - plane) / (eye - face), slip = (face - plane) * Math.tan(2.5 * Math.PI / 180)
      const seen = { top: (py + PLACE_PANEL.height * k / 2) * grow + slip, bottom: (py - PLACE_PANEL.height * k / 2) * grow - slip, right: (px + PLACE_PANEL.width * k / 2) * grow + slip, left: (px - PLACE_PANEL.width * k / 2) * grow - slip }
      expect(seen.top, `${aspect}`).toBeLessThan(top - 8)
      expect(seen.top, `${aspect}`).toBeLessThan(BH / 2 - box.y - 8)               // under the map's top edge
      expect(seen.bottom, `${aspect}`).toBeGreaterThan(bottom + 8)
      expect(seen.right, `${aspect}`).toBeLessThan(right - 12)                       // inside the map's right edge (the left one mirrors it)
      expect(seen.left, `${aspect}`).toBeGreaterThan(0)                              // on its own half
    }
    expect(PLACE_PANEL.offset.left).toEqual([-px / pt, py / pt, pz / pt])
  })

  it('under frozen motion the map holds still: the dots park (screenshots are repeatable); live they run', async () => {
    const s = await networkScene('frozen'), dots = s.group.getObjectByName('dots') as InstancedMesh, m = new Matrix4()
    const at = (): number[] => { dots.getMatrixAt(0, m); return m.toArray() }
    s.update(0, ctx(s.node, false)); const parked = at()
    expect(s.update(0.5, ctx(s.node, false))).toBe(false)
    expect(at()).toEqual(parked)
    const live = await networkScene(), d = live.group.getObjectByName('dots') as InstancedMesh
    live.update(0, ctx(live.node, false)); d.getMatrixAt(0, m); const from = m.toArray()
    expect(live.update(0.5, ctx(live.node, false))).toBe(true)
    d.getMatrixAt(0, m); expect(m.toArray()).not.toEqual(from)
  })
})

describe('the curved wall', () => {
  /** The rig's camera at a Block's focus pose, orbited by the parallax (`yaw`, `pitch`, radians) about its content-plane centre. */
  function focusCamera(b: FakeSurface, aspect: number, yaw: number, pitch: number): { eye: Vector3; turn: Quaternion } {
    const pt = 244, { width, height } = b.model, slab = 0.05 * Math.min(width, height) / pt
    const turn = new Quaternion().setFromEuler(new Euler(...b.restPose.rotation, 'XYZ')), normal = new Vector3(0, 0, 1).applyQuaternion(turn)
    const centre = new Vector3(...b.restPose.position).addScaledVector(normal, slab)
    const d = fitDistance(width / pt, height / pt, 38, aspect, 0.08)
    // the parallax: yaw about the target's up axis, pitch about its right one, both about its centre
    const up = new Vector3(0, 1, 0).applyQuaternion(turn), right = new Vector3(1, 0, 0).applyQuaternion(turn)
    const orbit = new Quaternion().setFromAxisAngle(up, yaw).multiply(new Quaternion().setFromAxisAngle(right, -pitch))
    return { eye: centre.clone().add(normal.multiplyScalar(d).applyQuaternion(orbit)), turn: orbit.multiply(turn) }
  }
  /** u along the wall at arc angle `a`, read off the mesh's own uvs (its top row), interpolated. */
  function uAt(wall: Mesh, a: number): number {
    const g = wall.geometry as BufferGeometry, pos = g.getAttribute('position'), uv = g.getAttribute('uv'), row: [number, number][] = []
    for (let i = 0; i < pos.count; i++) if (pos.getY(i) > 0) row.push([Math.atan2(pos.getX(i), -pos.getZ(i)), uv.getX(i)])
    row.sort((p, q) => p[0] - q[0])
    for (let i = 1; i < row.length; i++) {
      const [a0, u0] = row[i - 1]!, [a1, u1] = row[i]!
      if (a >= a0 && a <= a1) return u0 + (u1 - u0) * (a - a0) / (a1 - a0 || 1)
    }
    return Number.NaN
  }
  const ASPECTS = [1512 / 808, 21 / 9, 16 / 9, 16 / 10, 4 / 3]

  it('every Block\'s focus view, at five aspects and every corner of the ±2.5° parallax, sees nothing but the wall, and wall the pastel covers at its full density', async () => {
    const s = await scene('overview'), blocks = [s.orders, s.overview, s.network, s.twin], names = ['orders', 'overview', 'network', 'twin']
    const angles = blocks.map(b => -b.restPose.rotation[1]), span = wallSpan(angles), R = ARC.radius, r = R + WALL.out
    const wall = createCurvedWall({ center: [0, 0, R], radius: r, ...span, height: WALL.height })
    const periodic = (wall.material as Material).userData.periodicU === true
    const half = Math.tan(19 * Math.PI / 180), par = 2.5 * Math.PI / 180
    blocks.forEach((b, n) => {
      for (const aspect of ASPECTS) for (const yaw of [-par, 0, par]) for (const pitch of [-par, 0, par]) {
        const { eye, turn } = focusCamera(b, aspect, yaw, pitch)
        let lo = Infinity, hi = -Infinity, tall = 0, u0 = Infinity, u1 = -Infinity
        // rays through the frustum's border, every tenth of each edge
        for (let i = 0; i <= 20; i++) for (const [x, y] of [[-1 + i / 10, -1], [-1 + i / 10, 1], [-1, -1 + i / 10], [1, -1 + i / 10]] as const) {
          const dir = new Vector3(x * half * aspect, y * half, -1).applyQuaternion(turn).normalize()
          // where it meets the wall's cylinder (axis vertical through (0, ·, R)), going out
          const ox = eye.x, oz = eye.z - R, A = dir.x * dir.x + dir.z * dir.z, B = 2 * (ox * dir.x + oz * dir.z), C = ox * ox + oz * oz - r * r
          const t = (-B + Math.sqrt(B * B - 4 * A * C)) / (2 * A), hx = ox + t * dir.x, hz = oz + t * dir.z, hy = eye.y + t * dir.y
          const a = Math.atan2(hx, -hz), u = uAt(wall, a)
          lo = Math.min(lo, a); hi = Math.max(hi, a); tall = Math.max(tall, Math.abs(hy)); u0 = Math.min(u0, u); u1 = Math.max(u1, u)
        }
        const at = `${names[n]} @ ${aspect.toFixed(2)}, parallax ${(yaw / par).toFixed(0)},${(pitch / par).toFixed(0)}`
        expect(lo, at).toBeGreaterThan(span.from); expect(hi, at).toBeLessThan(span.to)
        expect(tall, at).toBeLessThan(WALL.height / 2)
        if (!periodic) { expect(u0, at).toBeGreaterThanOrEqual(0); expect(u1, at).toBeLessThanOrEqual(1) }
      }
    })
  })

  it('its colour has the density behind the overview everywhere: u runs one a 32 units along it, and the arc\'s pastel repeats seamlessly in u', () => {
    const angles = [0, 0.5, 1.14, 1.75], { from, to } = wallSpan(angles), radius = ARC.radius + WALL.out
    const long = createCurvedWall({ center: [0, 0, ARC.radius], radius, from, to, height: WALL.height })
    const span = (m: Mesh): [number, number] => { const u = (m.geometry as BufferGeometry).getAttribute('uv'); let a = Infinity, b = -Infinity; for (let i = 0; i < u.count; i++) { a = Math.min(a, u.getX(i)); b = Math.max(b, u.getX(i)) } return [a, b] }
    const [a, b] = span(long), length = radius * (to - from)
    expect(b - a).toBeCloseTo(length / MAX_U_LENGTH, 6)
    expect((long.material as Material).userData.periodicU).toBe(true)
  })

  it('the arc\'s pastel repeats seamlessly (period 1 in u) and has no grey: bright everywhere a view can see, with colour in it', () => {
    let low = Infinity, chroma = 0
    for (let u = -1; u <= 2; u += 0.01) for (let v = 0.1; v <= 0.9; v += 0.02) {
      const c = arcPastel(u, v), next = arcPastel(u + 1, v)
      for (let i = 0; i < 3; i++) expect(next[i]).toBeCloseTo(c[i]!, 9)
      low = Math.min(low, 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2])
      chroma = Math.max(chroma, Math.max(...c) - Math.min(...c))
    }
    // the plane's dark side went to about 0.35 under the orders Block: the arc stays light, and coloured
    expect(low).toBeGreaterThan(0.65); expect(chroma).toBeGreaterThan(0.12)
    // continuous across the wrap (no seam): neighbours a hair apart either side of u = 0 and of every blob's wrap
    for (const v of [0.15, 0.5, 0.85]) for (const u of [0, 0.18 + 0.5, 0.86 - 0.5, 0.78 - 0.5, 0.55 + 0.5]) {
      const a = arcPastel(u - 1e-6, v), b = arcPastel(u + 1e-6, v)
      for (let i = 0; i < 3; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThan(1e-4)
    }
  })
})

/**
 * Every point of the map that stands out of the plate, in the group's frame: its meshes' and lines' vertices (instanced
 * ones through each instance), the labels' corners.
 */
function mapPoints(group: Object3D): Vector3[] {
  const out: Vector3[] = [], m = new Matrix4(), inv = new Matrix4().copy(group.matrixWorld).invert(), p = new Vector3()
  group.traverse(o => {
    if (o.name === 'plate' || !(o instanceof Mesh || o instanceof LineSegments)) return
    const pos = (o.geometry as BufferGeometry).getAttribute('position')
    if (!pos) return
    const world = o.matrixWorld
    if (o instanceof InstancedMesh) {
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m)
        for (let j = 0; j < pos.count; j++) out.push(p.fromBufferAttribute(pos, j).applyMatrix4(m).applyMatrix4(world).applyMatrix4(inv).clone())
      }
    } else for (let j = 0; j < pos.count; j += o.name === 'districts' || o.name.startsWith('roads') ? 7 : 1) out.push(p.fromBufferAttribute(pos, j).applyMatrix4(world).applyMatrix4(inv).clone())
  })
  return out
}

/** Turns the twin's model by `rad` the way the user does: a drag across its box, 100 canvas px a radian, on the floor. */
function dragBy(twin: FakeSurface, node: Node, rad: number): void {
  const group = twin.attached[0]!.object as Object3D, floor = { node, object: group.getObjectByName('floor') }
  const r = absoluteRect(node), y = r.y + r.height / 2, x0 = r.x + r.width / 2, sx = 640, sy = 400
  twin.pointer.down(x0, y, 'mouse', floor, { x: sx, y: sy })
  const steps = Math.ceil(Math.abs(rad) / 0.3) || 1
  for (let i = 1; i <= steps; i++) twin.pointer.move(x0, y, 'mouse', floor, { x: sx + rad * 100 * i / steps, y: sy })
  twin.pointer.up(x0, y, 'mouse', floor, { x: sx + rad * 100, y: sy })
}

/** Every corner of the model's racks, bins and loads (their instances' boxes) and every vertex of its floor, in the group's frame. */
function points(group: Object3D): Vector3[] {
  const out: Vector3[] = [], m = new Matrix4(), inv = new Matrix4().copy(group.matrixWorld).invert()
  group.traverse(o => {
    if (o instanceof InstancedMesh) {
      const g = o.geometry as BufferGeometry
      g.computeBoundingBox()
      const b = g.boundingBox!
      for (let i = 0; i < o.count; i++) {
        o.getMatrixAt(i, m)
        for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) out.push(new Vector3(x, y, z).applyMatrix4(m).applyMatrix4(o.matrixWorld).applyMatrix4(inv))
      }
    } else if (o instanceof Mesh && o.name === 'floor') {
      const pos = (o.geometry as BufferGeometry).getAttribute('position')
      for (let i = 0; i < pos.count; i++) out.push(new Vector3().fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld).applyMatrix4(inv))
    }
  })
  return out
}

