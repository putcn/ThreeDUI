import { describe, it, expect } from 'vitest'
import { BufferAttribute, BufferGeometry, Color, Group, InstancedMesh, LineSegments, Matrix4, Mesh, PerspectiveCamera, Raycaster, Texture, Vector2, Vector3, type Material, type Object3D } from 'three'
import { defaultTheme, GlassUIError } from '@glassui/core'
import type { Viewport3DContext } from '@glassui/render'
import { napiCanvas } from '../../../packages/vue/test/fixtures/mount'
import geoJson from '../src/wms/geo/xuzhou.json'
import { KINDS, network, stockLevel, type Location } from '../src/wms/data'
import { createNetworkMap, createProjection, INITIAL, LABELS, LANES, LIMITS, MARK_ZOOM, PICK_RADIUS, PITCH0, ROADS, SQUASH, type GeoData } from '../src/wms/map'

const geo = geoJson as GeoData
interface BufferAttributeLike { getX(i: number): number; getY(i: number): number; getZ(i: number): number }
/** A ribbon's half width now (km): its material's `side` multiplier, read off the uniform in its position node. */
function halfKm(mesh: Mesh): number {
  const found: number[] = []
  const walk = (n: unknown, seen = new Set<unknown>()): void => {
    if (!n || typeof n !== 'object' || seen.has(n)) return
    seen.add(n)
    const o = n as { isUniformNode?: boolean; value?: unknown }
    if (o.isUniformNode && typeof o.value === 'number') found.push(o.value)
    for (const v of Object.values(n)) if (v && typeof v === 'object') walk(v, seen)
  }
  walk((mesh.material as unknown as { positionNode: unknown }).positionNode)
  if (found.length !== 1) throw new Error(`expected one number uniform, found ${found.length}`)
  return found[0]!
}
/** A lane's vertex range in the merged tubes (the map records them on the mesh). */
function laneRange(m: ReturnType<typeof make>, lane: (typeof network.lanes)[number]): { start: number; count: number } {
  const [start, count] = ((m.group.getObjectByName('lanes') as Mesh).userData.ranges as Record<string, [number, number]>)[lane.id]!
  return { start, count }
}
const ctx = (o: Partial<Viewport3DContext> = {}): Viewport3DContext => ({ width: 1520, height: 760, reducedMotion: true, theme: defaultTheme, scheme: 'light', ...o })
const make = () => createNetworkMap(geo, network, { createCanvas: napiCanvas })
const named = (root: Object3D, name: string): Object3D => { const o = root.getObjectByName(name); if (!o) throw new Error(`no ${name}`); return o }
const prisms = (root: Object3D, kind: Location['kind']) => named(root, `places-${kind}`) as InstancedMesh
const ofKind = (kind: Location['kind']) => network.locations.filter(l => l.kind === kind)

/** Even–odd point in a flat [lon, lat, …] ring. */
function inRing(x: number, y: number, r: readonly number[]): boolean {
  let inside = false
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i]!, yi = r[i + 1]!, xj = r[j]!, yj = r[j + 1]!
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside
  }
  return inside
}
const districtAt = (lon: number, lat: number): string | null => geo.districts.find(d => d.rings.some(r => inRing(lon, lat, r)))?.name ?? null

/** The drawables under `root` that can draw (a material, an instanced mesh with instances), shown or not just now. */
function drawables(root: Object3D): Object3D[] {
  const out: Object3D[] = []
  root.traverse(o => {
    if (!(o as { material?: unknown }).material) return
    if (o instanceof InstancedMesh && o.count === 0) return
    out.push(o)
  })
  return out
}

/** The place's foot (or the point `up` pt over it) in the plate's frame (pt): through the view's frames, before any perspective. */
function footOnPlate(m: ReturnType<typeof make>, l: Location, up = 0): Vector3 {
  const s = named(m.group, 'ground').scale.x, [x, y] = m.projection.project(l.lon, l.lat)
  const frames = ['view', 'tilt', 'yaw', 'pan'].map(n => named(m.group, n).matrix)
  const toPlate = frames.reduce((acc, f) => acc.multiply(f), new Matrix4())
  return new Vector3(x * s, y * s, 6.5 + up).applyMatrix4(toPlate)
}

/** A camera 1600 pt in front of the map's group, looking at it (the plate's frame is the world here). */
function camera(): PerspectiveCamera {
  const c = new PerspectiveCamera(38, 1520 / 760, 1, 10_000)
  c.position.set(0, 0, 1600); c.lookAt(0, 0, 0); c.updateMatrixWorld(true)
  return c
}
/** A ray from `cam` through the plate-frame point `p` (as it projects). */
function rayTo(cam: PerspectiveCamera, p: Vector3): Raycaster {
  const ndc = p.clone().project(cam), r = new Raycaster()
  r.setFromCamera(new Vector2(ndc.x, ndc.y), cam)
  return r
}

describe('the Xuzhou extract', () => {
  it('names its sources and the ODbL the OSM data is under, and holds the ten districts, the four road classes, rivers and lakes', () => {
    expect((geoJson as { source: { districts: string; osm: string } }).source.districts).toBe('DataV GeoAtlas 320300_full')
    expect((geoJson as { source: { osm: string } }).source.osm).toMatch(/^© OpenStreetMap contributors, ODbL 1\.0 \(https:\/\/opendatacommons\.org\/licenses\/odbl\/\), via Overpass, \d{4}-\d{2}-\d{2}$/)
    expect(geo.districts.map(d => d.name).sort()).toEqual(['丰县', '云龙区', '新沂市', '沛县', '泉山区', '睢宁县', '贾汪区', '邳州市', '铜山区', '鼓楼区'].sort())
    expect(new Set(geo.roads.map(r => r.cls))).toEqual(new Set(['motorway', 'trunk', 'primary', 'secondary']))
    expect(geo.rivers.length).toBeGreaterThan(20); expect(geo.lakes.length).toBeGreaterThan(5)
  })
  it('lies where it was asked for: the districts within 0.02° of the query\'s box; roads and rivers within 0.05° of its bbox (a run ends a point past the city); every lake touches it', () => {
    /** fetch-geo.mjs's query box round the city (west, south, east, north). */
    const QUERY = [116.36, 33.72, 118.67, 34.97] as const
    const within = (c: readonly number[], [w, s, e, n]: readonly number[], tol: number): boolean => {
      for (let i = 0; i < c.length; i += 2) if (c[i]! < w! - tol || c[i]! > e! + tol || c[i + 1]! < s! - tol || c[i + 1]! > n! + tol) return false
      return true
    }
    for (const d of geo.districts) for (const r of d.rings) { expect(r.length % 2).toBe(0); expect(r.length).toBeGreaterThanOrEqual(8); expect(within(r, QUERY, 0.02), d.name).toBe(true) }
    // the bbox is the districts' extent, rounded out to 0.01°
    const all = geo.districts.flatMap(d => d.rings.flat()), xs = all.filter((_, i) => i % 2 === 0), ys = all.filter((_, i) => i % 2 === 1)
    expect(geo.bbox).toEqual([Math.floor(Math.min(...xs) * 100) / 100, Math.floor(Math.min(...ys) * 100) / 100, Math.ceil(Math.max(...xs) * 100) / 100, Math.ceil(Math.max(...ys) * 100) / 100])
    for (const r of [...geo.roads, ...geo.rivers]) expect(within(r.c, geo.bbox, 0.05)).toBe(true)
    for (const l of geo.lakes) {
      let touches = false
      for (let i = 0; i < l.c.length && !touches; i += 2) touches = within([l.c[i]!, l.c[i + 1]!], geo.bbox, 0)
      expect(touches).toBe(true)
    }
  })
  it('every warehouse and store stands inside the district it names; the suppliers stand outside the city, south-east of it', () => {
    for (const l of network.locations.filter(x => x.kind !== 'supplier')) expect(districtAt(l.lon, l.lat), l.name).toBe(l.district)
    const { centre } = createProjection(geo)
    for (const l of ofKind('supplier')) {
      expect(districtAt(l.lon, l.lat), l.name).toBeNull()
      expect(l.lon).toBeGreaterThan(centre[0]); expect(l.lat).toBeLessThan(centre[1])
    }
  })
})

describe('network map controls', () => {
  it('zooms, resets its view and hides a layer with its labels and incident routes', () => {
    const m = make()
    m.update(0, ctx())
    const before = m.view.zoom
    const initial = m.view
    m.zoomBy(1.2)
    expect(m.view.zoom).toBeGreaterThan(before)
    m.setLayer('store', false)
    expect(prisms(m.group, 'store').visible).toBe(false)
    expect(prisms(m.group, 'warehouse').visible).toBe(true)
    m.update(0, ctx())
    const ranges = (named(m.group, 'lanes') as Mesh).userData.ranges as Record<string, unknown>
    expect(Object.keys(ranges).every(id => {
      const lane = network.lanes.find(x => x.id === id)!
      return ![lane.from, lane.to].some(end => network.locations.find(x => x.id === end)!.kind === 'store')
    })).toBe(true)
    m.resetView()
    expect(m.view).toEqual(initial)
    m.setLayer('store', true)
    expect(prisms(m.group, 'store').visible).toBe(true)
    m.dispose()
  })
})

describe('the network map', () => {
  it('the projection round-trips the city centre and any point; 1° of latitude is about 111 km', () => {
    const p = createProjection(geo), [lon0, lat0] = p.centre
    const [x, y] = p.project(lon0, lat0)
    expect(x).toBeCloseTo(0, 12); expect(y).toBeCloseTo(0, 12)
    const [lon, lat] = p.unproject(0, 0)
    expect(lon).toBeCloseTo(lon0, 12); expect(lat).toBeCloseTo(lat0, 12)
    for (const l of network.locations) {
      const back = p.unproject(...p.project(l.lon, l.lat))
      expect(back[0]).toBeCloseTo(l.lon, 9); expect(back[1]).toBeCloseTo(l.lat, 9)
    }
    expect(p.project(lon0, lat0 + 1)[1]).toBeCloseTo(110.574, 3)
    // the city spans about 210 × 140 km round its centre
    const [x0, y0, x1, y1] = p.bounds
    expect(x0).toBeCloseTo(-x1, 6); expect(y0).toBeCloseTo(-y1, 6)
    expect(x1 - x0).toBeGreaterThan(190); expect(x1 - x0).toBeLessThan(230); expect(y1 - y0).toBeGreaterThan(125); expect(y1 - y0).toBeLessThan(155)
  })

  it('one prism per place by kind, a diamond over each, three dots per moving lane, and the warehouses\' and suppliers\' labels', () => {
    const m = make()
    m.update(1 / 60, ctx())
    for (const k of ['warehouse', 'store', 'supplier'] as const) expect(prisms(m.group, k).count).toBe(ofKind(k).length)
    expect(ofKind('warehouse')).toHaveLength(4); expect(ofKind('store')).toHaveLength(24); expect(ofKind('supplier')).toHaveLength(2)
    const diamonds = named(m.group, 'diamonds') as LineSegments
    expect(diamonds.geometry.getAttribute('position').count).toBe(8 * network.locations.length)
    const moving = network.lanes.filter(l => l.status !== 'planned')
    expect((named(m.group, 'dots') as InstancedMesh).count).toBe(3 * moving.length)
    // prisms coloured by kind, a store by its stock level
    const c = new Color()
    ofKind('store').forEach((l, i) => expect(prisms(m.group, 'store').getColorAt(i, c).getHexString()).toBe(new Color(stockLevel(l).color).getHexString()))
    expect(prisms(m.group, 'warehouse').getColorAt(0, c).getHexString()).toBe(new Color(KINDS.warehouse.color).getHexString())
    // the labels: name and second line for each warehouse and supplier
    const texts: string[] = []
    named(m.group, 'labels').traverse(o => { if (typeof o.userData.text === 'string') texts.push(o.userData.text) })
    for (const l of network.locations.filter(x => x.kind !== 'store')) expect(texts).toContain(l.name)
    expect(texts).toHaveLength(2 * 6)
    expect(texts).toContain('鼓楼区 · 在库 22.2 万件')
  })

  it('a prism\'s height grows with √(on-hand); a warehouse stands over every store', () => {
    const m = make(), mtx = new Matrix4()
    m.update(1 / 60, ctx())
    const heights = (k: Location['kind']): number[] => ofKind(k).map((_, i) => { prisms(m.group, k).getMatrixAt(i, mtx); return new Vector3().setFromMatrixScale(mtx).z })
    const wh = heights('warehouse'), st = heights('store')
    expect(Math.min(...wh)).toBeGreaterThan(Math.max(...st))
    // WH-1 holds the most and stands tallest; its height over WH-2's is the square root of their stock's ratio
    const [a, b] = ofKind('warehouse') as [Location, Location]
    expect(wh[0]! / wh[1]!).toBeCloseTo(Math.sqrt(a.onhand / b.onhand), 6)
  })

  it('pick maps an instanced hit to its place, and a point on the plate to the place whose foot is within PICK_RADIUS of it', () => {
    const m = make()
    m.update(1 / 60, ctx())
    expect(m.pick(prisms(m.group, 'warehouse'), 0)).toBe(ofKind('warehouse')[0])
    expect(m.pick(prisms(m.group, 'store'), 3)).toBe(ofKind('store')[3])
    expect(m.pick(prisms(m.group, 'supplier'), 1)).toBe(ofKind('supplier')[1])
    expect(m.pick(prisms(m.group, 'store'), 999)).toBeNull()
    expect(m.pick(prisms(m.group, 'store'))).toBeNull()                            // no instance named
    expect(m.pick(named(m.group, 'districts'), 0, [0, 0, 0])).toBeNull()             // the ground takes no pointer
    expect(m.pick({})).toBeNull()
    const plate = named(m.group, 'plate'), wh = ofKind('warehouse')[0]!, foot = m.placeOf(wh.id)!
    expect(m.pick(plate, undefined, [foot[0] + 5, foot[1] - 4, 0.2])).toBe(wh)
    // up its prism too (it stands some 50 pt up the plate): a point beside its middle picks it
    expect(m.pick(plate, undefined, [foot[0] + 8, foot[1] + 30, 0.2])).toBe(wh)
    expect(m.pick(plate, undefined, [foot[0] + PICK_RADIUS + 30, foot[1] + PICK_RADIUS + 30, 0.2])?.id ?? null).not.toBe(wh.id)
    expect(m.pick(plate)).toBeNull()                                                // no point
  })

  it('a ray through a place on screen hits its prism (the windowed raycast); a place panned out of the window takes no pointer', () => {
    const m = make(), cam = camera()
    m.update(1 / 60, ctx()); m.group.updateMatrixWorld(true)
    const wh = ofKind('warehouse')[0]!, foot = m.placeOf(wh.id)!
    // just above the foot, on the prism's side
    const hits = rayTo(cam, new Vector3(foot[0], foot[1] + 6, 30)).intersectObject(m.group, true)
    const first = hits.find(h => h.object.name.startsWith('places-'))!
    expect(m.pick(first.object, first.instanceId)).toBe(wh)
    // pan it far out: the prism still stands in front of the Block, but outside the window nothing of it is hit
    const before = m.view.centre
    m.pan(-5000, 0); m.update(1 / 60, ctx()); m.group.updateMatrixWorld(true)
    expect(m.view.centre[0]).toBeGreaterThan(before[0])
    expect(m.placeOf(wh.id)).toBeNull()
    const where = prisms(m.group, 'warehouse'), plateAt = footOnPlate(m, wh, 30)   // up its side
    expect(Math.abs(plateAt.x)).toBeGreaterThan(760)                               // past the window's edge
    const off = rayTo(cam, plateAt).intersectObject(m.group, true)
    expect(off.filter(h => h.object === where)).toEqual([])
    // the same ray finds it without the window's filter
    const raw: { object: Object3D }[] = []
    InstancedMesh.prototype.raycast.call(where, rayTo(cam, plateAt), raw as never)
    expect(raw.length).toBeGreaterThan(0)
  })

  it('zoom stays within [1, 6], the pan centre inside the city, the pitch within [0.3, 1.2]; the yaw turns freely', () => {
    const m = make(), [x0, y0, x1, y1] = m.projection.bounds
    expect(m.view.zoom).toBe(MARK_ZOOM); expect(m.view.pitch).toBeCloseTo(PITCH0, 12); expect(m.view.yaw).toBe(0)   // before its first box
    m.zoom(100); expect(m.view.zoom).toBe(LIMITS.zoom[1])
    m.zoom(1e-6); expect(m.view.zoom).toBe(LIMITS.zoom[0])
    m.zoom(1.5); expect(m.view.zoom).toBeCloseTo(1.5, 12)
    m.zoom(Number.NaN); m.zoom(-2); m.zoom(0); expect(m.view.zoom).toBeCloseTo(1.5, 12)
    m.update(1 / 60, ctx())
    for (const [dx, dy] of [[1e6, 0], [-1e6, 0], [0, 1e6], [0, -1e6]] as const) {
      m.pan(dx, dy)
      const [cx, cy] = m.view.centre
      expect(cx).toBeGreaterThanOrEqual(x0); expect(cx).toBeLessThanOrEqual(x1); expect(cy).toBeGreaterThanOrEqual(y0); expect(cy).toBeLessThanOrEqual(y1)
    }
    m.pan(1e6, -1e6); expect(m.view.centre).toEqual([x0, y0])                      // dragged right and up: the west and south edges
    m.rotate(0, 10); expect(m.view.pitch).toBe(LIMITS.pitch[1])
    m.rotate(0, -10); expect(m.view.pitch).toBe(LIMITS.pitch[0])
    m.rotate(7, 0); m.rotate(7, 0); expect(m.view.yaw).toBeCloseTo(14, 12)
    m.rotate(Number.NaN, Number.NaN); expect(m.view.yaw).toBeCloseTo(14, 12)
  })

  it('a drag moves the ground under the pointer with it, whatever the yaw and pitch', () => {
    for (const [yaw, pitch] of [[0, PITCH0], [0.9, 0.5], [-2.2, 1.1]] as const) {
      const m = make()
      m.rotate(yaw, pitch - PITCH0); m.update(1 / 60, ctx())
      const wh = ofKind('warehouse')[0]!, a = footOnPlate(m, wh), seen = m.placeOf(wh.id)!
      m.pan(30, -20); m.update(1 / 60, ctx())                                      // 30 right, 20 up on screen
      const b = footOnPlate(m, wh), now = m.placeOf(wh.id)!
      // its foot moves across the plate by the drag (deeper as it goes up: the ground leans back)
      expect(b.x - a.x).toBeCloseTo(30, 6); expect(b.y - a.y).toBeCloseTo(20, 6); expect(b.z).toBeLessThan(a.z)
      // and shows where the line of sight from the camera (1600 pt out, until a render says) through it meets the plate
      for (const [p, at] of [[a, seen], [b, now]] as const) { const k = 1600 / (1600 - p.z); expect(at[0]).toBeCloseTo(p.x * k, 6); expect(at[1]).toBeCloseTo(p.y * k, 6) }
    }
  })

  it('waits for its box: an update before layout (a box of 0 × 0) does nothing', () => {
    const m = make()
    expect(m.update(1 / 60, ctx({ width: 0, height: 0 }))).toBe(false)
    expect((named(m.group, 'lanes') as Mesh).geometry.getAttribute('position')).toBeUndefined()
    m.update(1 / 60, ctx())
    expect((named(m.group, 'lanes') as Mesh).geometry.getAttribute('position').count).toBeGreaterThan(0)
  })

  it('the view eases to its targets; under reduced motion it is there at once and nothing moves', () => {
    const m = make(), view = named(m.group, 'view'), tilt = named(m.group, 'tilt')
    m.update(1 / 60, ctx({ reducedMotion: false }))
    m.zoom(2); m.rotate(0, 0.2)
    expect(m.update(1 / 60, ctx({ reducedMotion: false }))).toBe(true)
    expect(-tilt.rotation.x).toBeGreaterThan(PITCH0); expect(-tilt.rotation.x).toBeLessThan(PITCH0 + 0.2)
    for (let i = 0; i < 120; i++) m.update(1 / 60, ctx({ reducedMotion: false }))
    expect(-tilt.rotation.x).toBeCloseTo(PITCH0 + 0.2, 6)
    // the dots keep moving while live; under reduced motion they park and the map settles
    expect(m.update(1 / 60, ctx({ reducedMotion: false }))).toBe(true)
    m.zoom(1.2); expect(m.update(1 / 60, ctx())).toBe(false)
    expect(view.scale.z).toBe(SQUASH)
  })

  it('every dot rides its lane, from the lane\'s start toward its end', () => {
    const m = make(), dots = named(m.group, 'dots') as InstancedMesh, mtx = new Matrix4(), p = new Vector3()
    m.update(0, ctx())
    const moving = network.lanes.filter(l => l.status !== 'planned')
    const before = Array.from({ length: dots.count }, (_, i) => { dots.getMatrixAt(i, mtx); return new Vector3().setFromMatrixPosition(mtx) })
    m.update(0.05, ctx({ reducedMotion: false }))
    let moved = 0
    for (let i = 0; i < dots.count; i++) { dots.getMatrixAt(i, mtx); p.setFromMatrixPosition(mtx); if (p.distanceTo(before[i]!) > 0.01) moved++ }
    expect(moved).toBe(dots.count)
    // each dot is on its lane's arc (which stands over the straight line between its ends: in plan, on that line), up
    // off the ground, and has moved along it from the lane's start toward its end (unless it just came round again)
    const s = named(m.group, 'ground').scale.x, at = new Map(network.locations.map(l => [l.id, m.projection.project(l.lon, l.lat).map(v => v * s)]))
    let forward = 0
    moving.forEach((lane, i) => {
      const [ax, ay] = at.get(lane.from)!, [bx, by] = at.get(lane.to)!, dx = bx! - ax!, dy = by! - ay!, len2 = dx * dx + dy * dy
      for (let k = 0; k < 3; k++) {
        dots.getMatrixAt(i * 3 + k, mtx); p.setFromMatrixPosition(mtx)
        const t = ((p.x - ax!) * dx + (p.y - ay!) * dy) / len2, off = Math.abs((p.x - ax!) * dy - (p.y - ay!) * dx) / Math.sqrt(len2)
        expect(off).toBeLessThan(1e-3); expect(t).toBeGreaterThanOrEqual(-1e-9); expect(t).toBeLessThanOrEqual(1 + 1e-9)
        expect(p.z).toBeGreaterThanOrEqual(6)
        const was = before[i * 3 + k]!, t0 = ((was.x - ax!) * dx + (was.y - ay!) * dy) / len2
        if (t > t0) forward++
      }
    })
    expect(forward).toBeGreaterThanOrEqual(dots.count - 3)
  })

  it('hover lights one place\'s prism and dims the lanes that are not its own; hover(null) puts them back; an unknown id throws', () => {
    const m = make(), c = new Color()
    m.update(1 / 60, ctx())
    const stores = prisms(m.group, 'store'), lanes = named(m.group, 'lanes') as Mesh
    const colours = (): string[] => Array.from({ length: stores.count }, (_, i) => stores.getColorAt(i, c).getHexString())
    const bright = (): number => { const a = lanes.geometry.getAttribute('color'); let sum = 0; for (let i = 0; i < a.count; i++) sum += a.getX(i) + a.getY(i) + a.getZ(i); return sum }
    const before = colours(), lit = bright()
    m.hover(ofKind('store')[3]!.id); m.update(1 / 60, ctx())
    const after = colours()
    expect(after.filter((h, i) => h !== before[i])).toHaveLength(1)
    expect(bright()).toBeLessThan(lit * 0.5)
    m.hover(null); m.update(1 / 60, ctx())
    expect(colours()).toEqual(before); expect(bright()).toBeCloseTo(lit, 3)
    expect(() => m.hover('ST-99')).toThrow(GlassUIError)
    expect(() => m.hover('ST-99')).toThrow(/ST-99/)
  })

  it('pins one overdue purchase lane while the map is used for an investigation', () => {
    const m = make(), lane = network.lanes.find(l => l.from === 'SP-1' && l.to === 'WH-1' && l.status === 'overdue')!
    m.update(1 / 60, ctx())
    const mesh = named(m.group, 'lanes') as Mesh, col = mesh.geometry.getAttribute('color')
    const selected = laneRange(m, lane), other = laneRange(m, network.lanes.find(l => l.id !== lane.id)!)
    const brightness = (i: number): number => col.getX(i) + col.getY(i) + col.getZ(i)
    const selectedBefore = brightness(selected.start), otherBefore = brightness(other.start)
    m.highlightLane(lane.id); m.hover('WH-1'); m.update(1 / 60, ctx())
    expect(brightness(selected.start)).toBeGreaterThan(selectedBefore)
    expect(brightness(other.start)).toBeLessThan(otherBefore)
    m.highlightLane(null); m.hover(null); m.update(1 / 60, ctx())
    expect(brightness(selected.start)).toBeCloseTo(selectedBefore, 5)
    expect(() => m.highlightLane('LN-999')).toThrow(GlassUIError)
  })

  it('the lanes: one arc a lane (a vertex range each), wider for more pieces, the two overdue purchases red (dimmed like every purchase)', () => {
    const m = make()
    m.update(1 / 60, ctx())
    const lanes = named(m.group, 'lanes') as Mesh, col = lanes.geometry.getAttribute('color'), red = new Color('#db7484').multiplyScalar(LANES.dim.purchase)
    const overdue = network.lanes.filter(l => l.status === 'overdue')
    expect(overdue).toHaveLength(2); expect(overdue.every(l => l.kind === 'purchase')).toBe(true)
    for (const l of overdue) {
      const r = laneRange(m, l)
      for (const i of [r.start, r.start + r.count - 1]) { expect(col.getX(i)).toBeCloseTo(red.r, 6); expect(col.getY(i)).toBeCloseTo(red.g, 6); expect(col.getZ(i)).toBeCloseTo(red.b, 6) }
    }
    // every lane drawn, its ranges tiling the merged tubes in the lanes' order
    const ranges = network.lanes.map(l => laneRange(m, l))
    ranges.forEach((r, i) => { expect(r.count).toBeGreaterThanOrEqual(13 * 6); if (i) expect(r.start).toBe(ranges[i - 1]!.start + ranges[i - 1]!.count) })
    expect(ranges.at(-1)!.start + ranges.at(-1)!.count).toBe(lanes.geometry.getAttribute('position').count)
    // a transfer carrying more pieces is the thicker tube
    const ringRadius = (l: (typeof network.lanes)[number]): number => {
      const r = laneRange(m, l), pos = lanes.geometry.getAttribute('position'), c = new Vector3(), p = new Vector3()
      for (let i = 0; i < 5; i++) c.add(p.fromBufferAttribute(pos, r.start + i).divideScalar(5))
      return p.fromBufferAttribute(pos, r.start).distanceTo(c)
    }
    const transfers = network.lanes.filter(l => l.kind === 'transfer').sort((a, b) => a.qty - b.qty)
    expect(ringRadius(transfers.at(-1)!)).toBeGreaterThan(ringRadius(transfers[0]!))
  })


  it('stands in front of the plate: no ground in the window behind it, at any pitch', () => {
    for (const pitch of [LIMITS.pitch[0], PITCH0, LIMITS.pitch[1]]) {
      const m = make()
      m.rotate(0.4, pitch - PITCH0); m.zoom(0.5); m.update(1 / 60, ctx())
      m.group.updateMatrixWorld(true)
      const edges = named(m.group, 'district-edges') as LineSegments, pos = edges.geometry.getAttribute('position'), p = new Vector3()
      let inside = 0, low = Infinity
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i).applyMatrix4(edges.matrixWorld)
        if (Math.abs(p.x) <= 760 && Math.abs(p.y) <= 380) { inside++; low = Math.min(low, p.z) }
      }
      expect(inside).toBeGreaterThan(100)
      expect(low, `${pitch}`).toBeGreaterThan(0)
    }
  })

  it('draws in at most 40 calls, none casting a shadow; only the plate and the places take the pointer', () => {
    const m = make()
    m.update(1 / 60, ctx())
    const list = drawables(m.group)
    expect(list.length).toBeLessThanOrEqual(40)
    expect(list.length).toBe(33)
    for (const o of list) expect(o.userData.noShadow).toBe(true)
    const cam = camera(), takers = new Set<string>()
    m.group.updateMatrixWorld(true)
    const feet = network.locations.map(l => m.placeOf(l.id)).filter(p => p !== null)
    for (const [x, y] of [...feet.map(([x, y]) => [x, y + 4] as const), ...Array.from({ length: 21 * 11 }, (_, i) => [-700 + (i % 21) * 70, -350 + Math.floor(i / 21) * 70] as const)]) {
      for (const h of rayTo(cam, new Vector3(x, y, 0)).intersectObject(m.group, true)) takers.add(h.object.name)
    }
    expect([...takers].every(n => n === 'plate' || n.startsWith('places-'))).toBe(true)
    expect(takers.has('plate')).toBe(true); expect(takers.has('places-warehouse')).toBe(true); expect(takers.has('places-store')).toBe(true)
  })

  it('dispose frees every geometry, material and texture, and leaves nothing to draw', () => {
    const m = make()
    m.update(1 / 60, ctx())
    const owned = new Set<{ addEventListener(t: 'dispose', f: () => void): void }>(), freed = new Set<unknown>()
    m.group.traverse(o => {
      const mesh = o as Partial<Mesh>
      if (mesh.geometry instanceof BufferGeometry) owned.add(mesh.geometry)
      for (const mat of [mesh.material ?? []].flat() as Material[]) {
        owned.add(mat)
        const map = (mat as { alphaMap?: Texture | null }).alphaMap
        if (map) owned.add(map)
      }
    })
    for (const x of owned) x.addEventListener('dispose', () => { freed.add(x) })
    expect(owned.size).toBeGreaterThan(30)
    m.dispose()
    expect(freed.size).toBe(owned.size)
    expect(m.group.children).toHaveLength(0)
    expect(m.group).toBeInstanceOf(Group)
  })

  it('opens on the warehouses and the stores round them: centred, spread over 60 % of the map\'s width (Task 9P V4)', () => {
    const m = make(), W = 1520, H = 780
    m.update(1 / 60, ctx({ width: W, height: H }))
    const home = ofKind('warehouse').map(l => m.projection.project(l.lon, l.lat)).reduce((a, p) => [a[0] + p[0] / 4, a[1] + p[1] / 4], [0, 0])
    const near = network.locations.filter(l => l.kind === 'warehouse' || (l.kind === 'store' && Math.hypot(...((p => [p[0] - home[0], p[1] - home[1]])(m.projection.project(l.lon, l.lat)) as [number, number])) <= INITIAL.radius))
    expect(near.length).toBeGreaterThan(14); expect(near.some(l => l.district === '丰县')).toBe(false)   // the counties are left for the zoom out
    // as the window shows them: the cluster's feet span about 60 % of the width, centred on the window
    const shown = near.map(l => footOnPlate(m, l))
    const x0 = Math.min(...shown.map(p => p.x)), x1 = Math.max(...shown.map(p => p.x)), y0 = Math.min(...shown.map(p => p.y)), y1 = Math.max(...shown.map(p => p.y))
    expect((x1 - x0) / W).toBeGreaterThan(0.5); expect((x1 - x0) / W).toBeLessThanOrEqual(INITIAL.width + 1e-6)
    expect((y1 - y0) / H).toBeLessThanOrEqual(INITIAL.height + 0.02)
    expect(Math.abs((x0 + x1) / 2)).toBeLessThan(2); expect(Math.abs((y0 + y1) / 2)).toBeLessThan(0.05 * H)
    expect(m.view.zoom).toBeGreaterThan(3); expect(m.view.zoom).toBeLessThan(5)
    // a later resize does not move it again
    const z = m.view.zoom
    m.update(1 / 60, ctx({ width: 1400, height: 700 }))
    expect(m.view.zoom).toBe(z)
    // zoomed all the way out, everything shows, the suppliers too
    m.zoom(0.01); m.update(1 / 60, ctx({ width: W, height: H }))
    for (const l of network.locations) expect(m.placeOf(l.id), l.name).not.toBeNull()
  })

  it('roads layered by width and brightness (spatial spec §12.4): motorways and trunk roads flat ribbons that keep their pt width, the others 1-px lines', () => {
    const m = make()
    m.update(1 / 60, ctx())
    for (const r of ROADS) {
      const o = named(m.group, `roads-${r.cls}`)
      if ('width' in r) {
        expect(o).toBeInstanceOf(Mesh); expect(o).not.toBeInstanceOf(LineSegments)
        const g = (o as Mesh).geometry, side = g.getAttribute('side'), pos = g.getAttribute('position')
        expect(side.itemSize).toBe(2); expect(side.count).toBe(pos.count)
        // each point twice, pushed out either way along its normal (at least unit length)
        for (let i = 0; i < Math.min(200, pos.count); i += 2) {
          expect(pos.getX(i)).toBe(pos.getX(i + 1)); expect(side.getX(i)).toBeCloseTo(-side.getX(i + 1), 9)
          expect(Math.hypot(side.getX(i), side.getY(i))).toBeGreaterThanOrEqual(1 - 1e-6)
        }
      } else expect(o).toBeInstanceOf(LineSegments)
      expect(((o as Mesh).material as Material).opacity).toBe(r.alpha)
    }
    expect(ROADS.find(r => r.cls === 'motorway')!).toMatchObject({ width: 1.2, alpha: 0.55 })
    expect(ROADS.find(r => r.cls === 'trunk')!).toMatchObject({ width: 0.8, alpha: 0.4 })
  })

  it('a ribbon\'s width stays its pt width at any zoom (growing with the places\' √ zoom): one geometry, its half width in km set as the view moves', () => {
    const m = make(), ground = named(m.group, 'ground'), motorway = named(m.group, 'roads-motorway') as Mesh
    m.update(1 / 60, ctx())
    const g0 = motorway.geometry
    // the material's half width (km) × the ground's scale (pt a km) × 2: the ribbon's width on the ground, pt
    const widthPt = (): number => 2 * halfKm(motorway) * ground.scale.x
    const zoomNow = (): number => m.view.zoom
    expect(widthPt()).toBeCloseTo(1.2 * Math.sqrt(zoomNow() / MARK_ZOOM), 6)
    m.zoom(1.5); m.update(1 / 60, ctx())
    expect(widthPt()).toBeCloseTo(1.2 * Math.sqrt(zoomNow() / MARK_ZOOM), 6)
    expect(motorway.geometry).toBe(g0)                                             // no rebuild for a zoom
  })

  it('labels sit on a dark backdrop, drawn after the lanes and prisms; second lines from zoom 2.5; at zoom 1 no two overlap (warehouses first) (Task 9P V5)', () => {
    const m = make()
    m.update(1 / 60, ctx())
    const groups = network.locations.filter(l => l.kind !== 'store').map(l => named(m.group, `label-${l.id}`))
    for (const g of groups) {
      const back = g.children.find(c => c.name.endsWith('-backdrop')) as Mesh
      expect(back).toBeDefined(); expect(back.renderOrder).toBeGreaterThan(named(m.group, 'lanes').renderOrder); expect(back.renderOrder).toBeGreaterThan(prisms(m.group, 'store').renderOrder)
      const name = g.children.find(c => c.name.endsWith('-name'))!
      expect(name.renderOrder).toBeGreaterThan(back.renderOrder)
      expect(((back.material as Material) as Material & { depthTest: boolean }).depthTest).toBe(false)
    }
    expect(m.view.zoom).toBeGreaterThan(LABELS.subZoom)
    expect(groups.filter(g => g.visible).every(g => g.children.find(c => c.name.endsWith('-sub'))!.visible)).toBe(true)
    // zoomed out to 1: the second lines go; looked at from low (the steepest pitch squeezes the map up and down), the
    // names that would pile up are left out, the most stock kept first
    m.zoom(0.01); m.update(1 / 60, ctx())
    expect(groups.filter(g => g.visible).every(g => !g.children.find(c => c.name.endsWith('-sub'))!.visible)).toBe(true)
    m.rotate(0, 1); m.update(1 / 60, ctx())
    const shown = groups.filter(g => g.visible)
    expect(shown.length).toBeGreaterThan(0); expect(shown.length).toBeLessThan(groups.length)
    expect(shown.map(g => g.name)).toContain('label-WH-1')
    // the shown boxes, as the plate sees them, do not overlap
    const boxes = shown.map(g => {
      const back = g.children.find(c => c.name.endsWith('-backdrop')) as Mesh
      back.geometry.computeBoundingBox()
      const b = back.geometry.boundingBox!, k = 1600 / (1600 - g.position.z)
      return [g.position.x + b.min.x * k, g.position.y + b.min.y * k, g.position.x + b.max.x * k, g.position.y + b.max.y * k] as const
    })
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!, b = boxes[j]!
      expect(a[2] < b[0] || b[2] < a[0] || a[3] < b[1] || b[3] < a[1]).toBe(true)
    }
  })

  it('the lanes are not built again for every frame of a zoom: within 3 % their frame is scaled, and a hover repaints them in place (Task 9P M1)', () => {
    const m = make(), lanes = named(m.group, 'lanes') as Mesh, frame = named(m.group, 'lane-frame')
    m.update(1 / 60, ctx())
    const g0 = lanes.geometry
    m.zoom(1.02); m.update(1 / 60, ctx({ reducedMotion: false }))                 // easing: a little of the 2 %
    expect(lanes.geometry).toBe(g0); expect(frame.scale.x).toBeGreaterThan(1); expect(frame.scale.z).toBe(1)
    m.hover(ofKind('store')[2]!.id); m.update(1 / 60, ctx({ reducedMotion: false }))
    expect(lanes.geometry).toBe(g0)                                                // repainted, not rebuilt
    for (let i = 0; i < 120; i++) m.update(1 / 60, ctx({ reducedMotion: false })) // settles: built once more, exactly
    expect(lanes.geometry).not.toBe(g0); expect(frame.scale.x).toBe(1)
    const g1 = lanes.geometry
    m.zoom(1.5); m.update(1 / 60, ctx({ reducedMotion: false }))                  // a big step: built again at once
    expect(lanes.geometry).not.toBe(g1)
  })

  it('the lanes stand out over the roads: at the opening zoom every city run is lavender and at least as wide as a motorway ribbon (Task 9P R2)', () => {
    const m = make(), lanes = named(m.group, 'lanes') as Mesh, ground = named(m.group, 'ground')
    m.update(1 / 60, ctx({ width: 1520, height: 780 }))
    const motorway = 2 * halfKm(named(m.group, 'roads-motorway') as Mesh) * ground.scale.x, pos = lanes.geometry.getAttribute('position'), col = lanes.geometry.getAttribute('color')
    expect(motorway).toBeCloseTo(1.2 * Math.sqrt(m.view.zoom / MARK_ZOOM), 6)
    const diameter = (l: (typeof network.lanes)[number]): number => {
      const r = laneRange(m, l), c = new Vector3(), p = new Vector3()
      for (let i = 0; i < 5; i++) c.add(p.fromBufferAttribute(pos, r.start + i).divideScalar(5))
      return 2 * p.fromBufferAttribute(pos, r.start).distanceTo(c)
    }
    const runs = network.lanes.filter(l => l.kind === 'transfer' && l.status !== 'planned')
    for (const l of runs) {
      expect(diameter(l), l.id).toBeGreaterThanOrEqual(motorway)
      const i = laneRange(m, l).start
      const transferColor = new Color('#7167d9')
      expect(col.getX(i)).toBeCloseTo(transferColor.r, 6)
      expect(col.getY(i)).toBeCloseTo(transferColor.g, 6)
      expect(col.getZ(i)).toBeCloseTo(transferColor.b, 6)
    }
    // the roads under them: a lace, dimmer than the lanes
    expect(((named(m.group, 'roads-motorway') as Mesh).material as Material).opacity).toBeLessThan(((lanes.material as Material).opacity))
  })

  it('a pan or a turn moves the frames only: the prisms and diamonds are written again only for a new scale or hover; the labels only when the view or the eye moves (Task 9P R3)', () => {
    const m = make(), store = prisms(m.group, 'store'), diamonds = named(m.group, 'diamonds') as LineSegments
    m.update(1 / 60, ctx())
    const versions = (): number[] => [store.instanceMatrix.version, (diamonds.geometry.getAttribute('position') as BufferAttribute).version]
    let was = versions()
    m.pan(40, 10); m.update(1 / 60, ctx()); m.rotate(0.3, 0.1); m.update(1 / 60, ctx())
    expect(versions()).toEqual(was)
    m.zoom(1.2); m.update(1 / 60, ctx())
    expect(versions()[0]).toBeGreaterThan(was[0]!); was = versions()
    m.hover(ofKind('store')[1]!.id); m.update(1 / 60, ctx())
    expect(versions()[0]).toBeGreaterThan(was[0]!)
    // idle frames (the dots running, nothing else): the labels are not placed again
    const label = named(m.group, `label-${ofKind('warehouse')[0]!.id}`)
    label.position.set(1e4, 1e4, 1e4)
    m.update(1 / 60, ctx({ reducedMotion: false })); m.update(1 / 60, ctx({ reducedMotion: false }))
    expect(label.position.x).toBe(1e4)
    m.pan(5, 0); m.update(1 / 60, ctx())                                         // the view moved: placed again
    expect(label.position.x).not.toBe(1e4)
  })

  it('purchase lanes, coming in from far off, run at the lane-weight floor and a little dimmer, unless their place is hovered (Task 9P V8)', () => {
    const m = make(), lanes = named(m.group, 'lanes') as Mesh
    m.update(1 / 60, ctx())
    const col = (): BufferAttributeLike => lanes.geometry.getAttribute('color') as unknown as BufferAttributeLike
    const purchase = network.lanes.find(l => l.kind === 'purchase' && l.status === 'transit')!, transfer = network.lanes.find(l => l.kind === 'transfer' && l.status === 'transit')!
    const avg = (lane: typeof purchase): number => { const r = laneRange(m, lane), c = col(); let s = 0; for (let i = r.start; i < r.start + r.count; i++) s += c.getX(i) + c.getY(i) + c.getZ(i); return s / r.count }
    const want = new Color('#a28de5'), full = want.r + want.g + want.b
    expect(avg(purchase)).toBeCloseTo(full * LANES.dim.purchase, 4)
    const city = new Color('#7167d9')
    expect(avg(transfer)).toBeCloseTo(city.r + city.g + city.b, 4)
    m.hover(purchase.to); m.update(1 / 60, ctx())
    expect(avg(purchase)).toBeCloseTo(full, 4)
    // its tube is the thinnest: at the floor
    const r = laneRange(m, purchase), pos = lanes.geometry.getAttribute('position')
    // a tube's ring: its radius is the distance of a ring vertex from the ring's centre
    const c = new Vector3(), p = new Vector3(), ring = 6
    // the ring's 5 distinct vertices (its sixth closes it on the first)
    for (let i = 0; i < ring - 1; i++) c.add(p.fromBufferAttribute(pos, r.start + i).divideScalar(ring - 1))
    const radius = p.fromBufferAttribute(pos, r.start).distanceTo(c)
    expect(radius).toBeCloseTo(LANES.floor * Math.sqrt(m.view.zoom / MARK_ZOOM), 1)
  })
})
