import { describe, it, expect, vi, afterEach } from 'vitest'
import { h, nextTick } from 'vue'
import { InstancedMesh, Matrix4, Mesh, Vector3, type BufferGeometry, type Object3D } from 'three'
import { absoluteRect, defaultTheme, type Node } from '@glassui/core'
import { flush, type FakeRoot, type FakeSurface } from '../../../packages/vue/test/fixtures/fake-root'
import { mountGlass } from '../../../packages/vue/test/fixtures/mount'
import Spatial from '../src/scenes/Spatial.vue'
import { bins, kpis, orders } from '../src/wms/data'
import { YAW_LIMIT } from '../src/wms/warehouse'
import { BLOCKS, inFrameOf, PANEL, TWIN } from '../src/scenes/spatial-arc'

/** pt per world unit (the Blocks' and the panel's). */
const PT = 244

/** The scene mounted on a fake root, focused on `focus`, laid out (a few ticks: the Blocks measure after one). */
async function scene(focus: string, motion: 'live' | 'frozen' = 'live') {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const m = mountGlass(() => h(Spatial, { initialFocus: focus }), { motion })
  for (let i = 0; i < 3; i++) { await flush(); m.root.tick(); await nextTick() }
  await flush()
  const [orders, overview, twin] = m.root.surfacesMade as [FakeSurface, FakeSurface, FakeSurface]
  return { ...m, warn, orders, overview, twin }
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
  it('mounts its three Blocks (orders, overview, twin) with no error and no content taller than its Block', async () => {
    const s = await scene('overview')
    expect(s.errors).toEqual([])
    expect(s.warn).not.toHaveBeenCalled()
    expect(s.root.surfacesMade).toHaveLength(3)
    expect([s.orders, s.overview, s.twin].map(x => [x.model.width, x.model.height])).toEqual([BLOCKS.orders, BLOCKS.overview, BLOCKS.twin].map(b => [b.width, b.height]))
    // the overview's content: the KPIs, both charts (the 3D one with six zones, the busiest in the accent)
    for (const k of kpis) expect(texts(s.overview.root, k.label)).toHaveLength(1)
    expect(s.overview.attached).toHaveLength(1)
    const chart = (s.root as FakeRoot).charts[0]!
    expect(chart.set).toHaveBeenCalled()
    expect(chart.set.mock.lastCall![0].values).toHaveLength(6)
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
  })

  it('hovering a bin floats the glass info panel in front of the twin, showing the bin; leaving the model hides it', async () => {
    const s = await scene('twin'), { node, bins: mesh } = model(s.twin), at = { node, object: mesh, instanceId: 57 }
    s.twin.pointer.move(-999, -999, 'mouse', at); await nextTick(); await flush()
    const panel = s.root.surfacesMade[3]!
    expect(panel).toBeDefined()
    expect(panel.created).toMatchObject({ layer: 'world', width: PANEL.width, height: PANEL.height, background: 'glass', interactive: false })
    const pose = inFrameOf(TWIN, PANEL.offset)
    expect(panel.restPose.position.map(v => +v.toFixed(6))).toEqual(pose.position.map(v => +v.toFixed(6)))   // flown in to its place
    expect(panel.restPose.opacity).toBe(1)
    expect(panel.animations[0]!.from.opacity).toBe(0)
    const shown = textOf(panel.root)
    expect(shown).toContain(bins[57]!.id); expect(shown).toContain(bins[57]!.sku)
    // another bin: the same panel, its content
    s.twin.pointer.move(-999, -999, 'mouse', { ...at, instanceId: 3 }); await nextTick(); await flush()
    expect(s.root.surfacesMade).toHaveLength(4); expect(textOf(panel.root)).toContain(bins[3]!.id)
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
    expect(s.root.surfacesMade[3]!.disposed).toBe(false)
    s.twin.pointer.move(-999, -999, 'mouse', { node, object: mesh, instanceId: 11 }); await nextTick(); await flush()
    vi.advanceTimersByTime(1000); await nextTick(); await flush()
    expect(s.root.surfacesMade[3]!.disposed).toBe(false)                         // back on a bin in time
    s.twin.pointer.move(-999, -999, 'mouse', { node, object: group.getObjectByName('floor') }); await nextTick()
    vi.advanceTimersByTime(1000); await nextTick(); await flush()
    expect(s.root.surfacesMade[3]!.disposed).toBe(true)
  })

  it('no panel while the twin is not the focus: its content takes no pointer', async () => {
    const s = await scene('overview'), { node, bins: mesh } = model(s.twin)
    s.twin.pointer.move(-999, -999, 'mouse', { node, object: mesh, instanceId: 57 }); await nextTick(); await flush()
    expect(s.root.surfacesMade).toHaveLength(3)
  })

  it('dragging across the twin turns the model (0.01 rad a pt, ±0.8 at most) and hides the panel', async () => {
    const s = await scene('twin'), { node, group, update } = model(s.twin), floor = { node, object: group.getObjectByName('floor') }
    const yaw = group.getObjectByName('yaw')!, r = absoluteRect(node), y = r.y + r.height / 2
    s.twin.pointer.move(r.x + 300, y, 'mouse', { node, object: model(s.twin).bins, instanceId: 5 }); await nextTick(); await flush()
    expect(s.root.surfacesMade).toHaveLength(4)
    s.twin.pointer.down(r.x + 300, y, 'mouse', floor); await nextTick(); await flush()
    expect(s.root.surfacesMade[3]!.disposed).toBe(true)
    s.twin.pointer.move(r.x + 330, y, 'mouse', floor)
    update(1 / 60, ctx(node))
    expect(yaw.rotation.y).toBeCloseTo(0.3, 9)
    for (let x = 340; x <= 600; x += 20) s.twin.pointer.move(r.x + x, y, 'mouse', floor)
    update(1 / 60, ctx(node))
    expect(yaw.rotation.y).toBeCloseTo(YAW_LIMIT, 9)
    s.twin.pointer.up(r.x + 600, y, 'mouse', floor)
    s.twin.pointer.move(r.x + 200, y, 'mouse', floor)                            // released: moving no longer turns it
    update(1 / 60, ctx(node))
    expect(yaw.rotation.y).toBeCloseTo(YAW_LIMIT, 9)
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

  it('the info panel clears the model wherever it stands under it, at every yaw (its glass floats in front of the racks)', async () => {
    const s = await scene('twin'), { node, group, update } = model(s.twin)
    // the Viewport3D's box in the twin's own frame (pt, the centre the origin, y up); the model stands on the content
    // plane, the Block slab's thickness (5 % of its short side) over the Block's origin, where the panel's offset starts
    const r = absoluteRect(node), cx = r.x + r.width / 2 - BLOCKS.twin.width / 2, cy = BLOCKS.twin.height / 2 - (r.y + r.height / 2)
    const plane = 0.05 * Math.min(BLOCKS.twin.width, BLOCKS.twin.height)
    const [px, py, pz] = PANEL.offset.map(v => v * PT) as [number, number, number], turn = group.getObjectByName('yaw')!
    let worst = -Infinity
    for (let yaw = -YAW_LIMIT; yaw <= YAW_LIMIT + 1e-9; yaw += 0.1) {
      dragBy(s.twin, node, yaw - turn.rotation.y)                                 // turned as the user turns it, then settled
      update(1 / 60, ctx(node)); group.updateMatrixWorld(true)
      for (const p of points(group)) {
        const x = p.x + cx, y = p.y + cy, z = p.z + plane
        if (Math.abs(x - px) <= PANEL.width / 2 && Math.abs(y - py) <= PANEL.height / 2) worst = Math.max(worst, z)
      }
    }
    // the panel's back face is its position (its own slab sits in front of it); keep 20 pt of air
    expect(worst).toBeGreaterThan(plane)                                          // it does stand over racks
    expect(worst).toBeLessThan(pz - 20)
  })
})

/** Turns the twin's model by `rad` the way the user does: a drag across its box (0.01 rad a pt), on the floor. */
function dragBy(twin: FakeSurface, node: Node, rad: number): void {
  const group = twin.attached[0]!.object as Object3D, floor = { node, object: group.getObjectByName('floor') }
  const r = absoluteRect(node), y = r.y + r.height / 2, x0 = r.x + r.width / 2
  twin.pointer.down(x0, y, 'mouse', floor)
  const steps = Math.ceil(Math.abs(rad) / 0.3) || 1
  for (let i = 1; i <= steps; i++) twin.pointer.move(x0 + rad * 100 * i / steps, y, 'mouse', floor)
  twin.pointer.up(x0 + rad * 100, y, 'mouse', floor)
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

