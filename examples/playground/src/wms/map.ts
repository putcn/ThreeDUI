import {
  AdditiveBlending, BufferGeometry, Color, CylinderGeometry, ExtrudeGeometry, Float32BufferAttribute, Group, InstancedMesh, LineSegments,
  Matrix4, Mesh, QuadraticBezierCurve3, Quaternion, Shape, ShapeGeometry, SphereGeometry, TubeGeometry, Vector2, Vector3,
  type Intersection, type Material, type Object3D, type Raycaster,
} from 'three'
import { LineBasicNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu'
import { abs, color, float, Fn, length, max, min, mix, normalLocal, positionLocal, positionWorld, smoothstep, uniform, vec2, vec4 } from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { GlassUIError, type RGBA } from '@glassui/core'
import type { Viewport3DContext } from '@glassui/render'
import { disposeTextPlane, textPlane, type TextPlane } from '@glassui/render/internal'
import type { CanvasFactory } from '@glassui/text'
import { grouped, KINDS, stockLevel, type Lane, type Location, type LocationKind, type Network } from './data'

/**
 * The logistics network map (spatial spec §12.4): Xuzhou's districts, roads and water (`geo`, the committed extract of
 * DataV and OpenStreetMap) as a dark control-room map, with the network's places standing on it as prisms and today's
 * runs arching between them, made to be attached with `<Viewport3D :object="map.group" :update="map.update">`. Local
 * units are pt (the Viewport3D's): the group's origin is the box centre on the glass, x right, y up, z out of it.
 *
 * The map is seen as through a window: a dark navy plate fills the box (`plate`), and everything else is drawn only
 * where the line of sight from the camera through it meets the plate inside the box's rounded rectangle (each
 * material's `maskNode`), so a zoomed or panned map never spills over the Block. Inside, the ground lies in its own
 * frame (x east, y north, z up) and is seen pitched: turned back `pitch` from the plate and then flattened toward the
 * plate (`SQUASH`), so it reads as a map looked down on at that angle (an axonometric view) while it stands only a little
 * way out of the glass; it is seated so its far edge (as the window shows it) is just in front of the plate.
 *
 * Projection: equirectangular about the city's centre in km (`createProjection`); `fit` pt a km fills the box with the
 * city at zoom 1 and the rest pitch; the view's zoom (1–6), pan centre (inside the city's bounds), yaw (free) and pitch
 * (0.3–1.2 rad) ease to their targets. The ground's layers scale with the zoom; the places, their diamond tops, the
 * lanes, the dots and the labels keep their size in pt (the places grow with √(zoom / ZOOM0)).
 *
 * Draw calls (27, at most 40): the plate, the districts (one extruded mesh), their outlines, the lakes, the rivers, the
 * roads by class (4), the places by kind (3 instanced), their diamond tops, the lanes (one merged mesh), the moving dots
 * (instanced), and two text planes (name, second line) for each warehouse and supplier. Nothing casts a shadow, and only
 * the plate and the places take the pointer.
 */

/** The committed GIS extract (src/wms/geo/xuzhou.json): flat [lon, lat, …] coordinates, WGS-84. */
export interface GeoData {
  bbox: readonly number[]
  districts: readonly { name: string; center: readonly number[]; rings: readonly (readonly number[])[] }[]
  roads: readonly { cls: string; c: readonly number[] }[]
  rivers: readonly { c: readonly number[] }[]
  lakes: readonly { c: readonly number[] }[]
}

/** The view at rest: zoomed in on the warehouses, looked down on at 50° from straight above. */
export const ZOOM0 = 1.8
export const PITCH0 = 50 * Math.PI / 180
export const LIMITS = { zoom: [1, 6], pitch: [0.3, 1.2] } as const
/** How much of its depth the pitched ground keeps toward the viewer (1: none flattened). */
export const SQUASH = 0.14
/** The plate's corner radius, pt. */
export const PLATE_RADIUS = 22
/** Of the box the city fills at zoom 1. */
const FILL = 0.94
/** pt over the ground's plane: the districts' extrusion, the layers drawn on them, the places' feet. */
const Z = { district: 6, lake: 6.15, river: 6.25, edge: 6.3, road: 6.4, base: 6.5 } as const
/** Each place kind's prism radius (pt at zoom ZOOM0); the height is `HEIGHT` × √onhand (pt), at least `MIN_HEIGHT`. */
const RADIUS: Record<LocationKind, number> = { warehouse: 8.5, store: 5.4, supplier: 7.5 }
const HEIGHT = 0.17, MIN_HEIGHT = 12
/** Draw order inside the viewport slot (each drawable's own `renderOrder`). */
const ORDER = { plate: 0, districts: 1, lakes: 2, rivers: 3, edges: 4, roads: 5, lanes: 9, prisms: 10, diamonds: 11, dots: 12, labels: 13 } as const
/** Roads by class: colour alpha, brightest last (drawn on top). */
const ROADS = [['secondary', 0.3], ['primary', 0.5], ['trunk', 0.7], ['motorway', 0.9]] as const
const COLORS = {
  plate: '#121a33', plateEdge: '#080c18', district: '#2a3a63', districtSide: '#1a2545', edge: '#6f89cc', road: '#5fd3ff', water: '#3d7bd9',
  transfer: '#9ee6ff', purchase: '#eaf4ff', planned: '#46618f', overdue: '#ff5d73', dot: '#ffffff', overdueDot: '#ffb0ba', diamond: '#ffffff',
  label: [0.93, 0.95, 1, 1] as RGBA, sublabel: [0.62, 0.7, 0.85, 1] as RGBA,
} as const
/** pt round a place's foot (as the window shows it) within which a pointer on the plate picks it. */
export const PICK_RADIUS = 14
/** Seconds the view eases toward its targets in (the time constant). */
const EASE = 0.09
/** Dots per moving lane, their radius (pt at ZOOM0), and their pace (pt/s, a lane's share a second within bounds). */
const DOTS = { perLane: 3, radius: 2.1, pace: 120, rate: [0.08, 0.45] } as const

const DEG = Math.PI / 180
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

/** Equirectangular about the city's centre: km east and north. */
export interface Projection {
  /** The city's centre (the middle of its districts' extent), [lon, lat]. */
  readonly centre: readonly [number, number]
  /** The districts' extent, km: [minX, minY, maxX, maxY]. */
  readonly bounds: readonly [number, number, number, number]
  project(lon: number, lat: number): [number, number]
  unproject(x: number, y: number): [number, number]
}
export function createProjection(geo: GeoData): Projection {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity
  for (const d of geo.districts) for (const r of d.rings) for (let i = 0; i < r.length; i += 2) {
    w = Math.min(w, r[i]!); e = Math.max(e, r[i]!); s = Math.min(s, r[i + 1]!); n = Math.max(n, r[i + 1]!)
  }
  if (!(e > w && n > s)) throw new GlassUIError('networkMap.geo', '地图数据里没有区县边界')
  const lon0 = (w + e) / 2, lat0 = (s + n) / 2, kx = 111.32 * Math.cos(lat0 * DEG), ky = 110.574
  const project = (lon: number, lat: number): [number, number] => [(lon - lon0) * kx, (lat - lat0) * ky]
  const [x0, y0] = project(w, s), [x1, y1] = project(e, n)
  return { centre: [lon0, lat0], bounds: [x0, y0, x1, y1], project, unproject: (x, y) => [lon0 + x / kx, lat0 + y / ky] }
}

/** A hovered place, as the network Block reports it: the place, and the side of the map the panel takes (away from it). */
export interface PlaceHover { location: Location; side: 'left' | 'right' }

/** Where the map's view is headed (the targets `update` eases to): zoom, yaw and pitch (rad), the pan centre (km). */
export interface MapView { zoom: number; yaw: number; pitch: number; centre: [number, number] }

export interface NetworkMap {
  /** The map: attach it (`Viewport3D` `object`). */
  readonly group: Group
  /** The places, in the network's order. */
  readonly locations: readonly Location[]
  readonly projection: Projection
  /** The targets the view eases to (a copy). */
  readonly view: MapView
  /**
   * One frame (the Viewport3D's `update`; `ctx` its box): sizes the plate and the fit to the box, eases the view to its
   * targets, keeps the places, lanes and labels in place, moves the dots along their lanes (not under reduced motion,
   * where everything is at its target at once). True while anything moves.
   */
  update(dt: number, ctx: Viewport3DContext): boolean
  /** Highlights the place `id` (its prism lit, its lanes bright, the others dimmed); null: none. */
  hover(id: string | null): void
  /**
   * The place a pointer event names: an instance of a kind's prisms (`object`, `instanceId`: the pointer's raycast hits
   * a prism only where the window shows it), or, on the plate, the nearest place in the window whose prism (from its
   * foot to its top, as the window shows them) is within `PICK_RADIUS` of `point` (the anchor-frame point, pt); null
   * when none.
   */
  pick(object: unknown, instanceId?: number, point?: readonly [number, number, number]): Location | null
  /** Where the place `id`'s foot shows on the plate (pt, the box centre the origin, y up), or null outside the window. */
  placeOf(id: string): [number, number] | null
  /** Drags the map by (dx, dy) pt as on screen (x right, y down): the ground under the pointer follows it; clamped to the city. */
  pan(dx: number, dy: number): void
  /** Turns the map: yaw by `dyaw` (free), pitch by `dpitch` within `LIMITS.pitch`. */
  rotate(dyaw: number, dpitch: number): void
  /** Zooms by `factor` (> 1 in), within `LIMITS.zoom`, about the window's centre. */
  zoom(factor: number): void
  /** Frees every geometry, material and texture (the map draws nothing after it). */
  dispose(): void
}

export interface NetworkMapOptions {
  /** Makes the label canvases (the root's: DOM canvases in a browser). */
  createCanvas: CanvasFactory
}

/** Every geometry, material and texture the map owns, for `dispose`. */
interface Owned { geometries: BufferGeometry[]; materials: Material[]; labels: TextPlane[] }

/** A rounded rectangle `w` × `h` centred on the origin. */
function roundedRect(w: number, h: number, r: number): Shape {
  const x = w / 2 - r, y = h / 2 - r, s = new Shape()
  s.absarc(x, y, r, 0, Math.PI / 2, false); s.absarc(-x, y, r, Math.PI / 2, Math.PI, false)
  s.absarc(-x, -y, r, Math.PI, Math.PI * 1.5, false); s.absarc(x, -y, r, Math.PI * 1.5, Math.PI * 2, false)
  return s
}

/** A flat [lon, lat, …] ring as projected points, its closing duplicate dropped. */
function ringPoints(flat: readonly number[], proj: Projection): Vector2[] {
  const out: Vector2[] = []
  for (let i = 0; i < flat.length; i += 2) out.push(new Vector2(...proj.project(flat[i]!, flat[i + 1]!)))
  if (out.length > 1 && out[0]!.equals(out[out.length - 1]!)) out.pop()
  return out
}

/** Line segments along each flat [lon, lat, …] line (closed: back to its start), projected, at height `z`. */
function segments(lines: readonly (readonly number[])[], proj: Projection, z: number, closed = false): BufferGeometry {
  const pos: number[] = []
  for (const c of lines) {
    const n = c.length / 2
    for (let i = 0; i < n - 1 + (closed ? 1 : 0); i++) {
      const j = (i + 1) % n, [ax, ay] = proj.project(c[2 * i]!, c[2 * i + 1]!), [bx, by] = proj.project(c[2 * j]!, c[2 * j + 1]!)
      pos.push(ax, ay, z, bx, by, z)
    }
  }
  return new BufferGeometry().setAttribute('position', new Float32BufferAttribute(pos, 3))
}

/** Takes `o` out of the pointer's way (lines, lanes, dots, labels: only the plate and the places take it). */
const inert = (o: Object3D): void => { o.raycast = () => {} }

/** Builds the map of `geo` with `network`'s places and lanes. */
export function createNetworkMap(geo: GeoData, network: Network, opts: NetworkMapOptions): NetworkMap {
  const proj = createProjection(geo), owned: Owned = { geometries: [], materials: [], labels: [] }
  const keep = <G extends BufferGeometry>(g: G): G => { owned.geometries.push(g); return g }
  const locations = network.locations, byId = new Map(locations.map(l => [l.id, l]))
  for (const lane of network.lanes) {
    if (!byId.has(lane.from) || !byId.has(lane.to)) throw new GlassUIError('networkMap.lanes', `线路 ${lane.id} 的两端必须是已有地点（${lane.from} → ${lane.to}）`)
  }
  const at = new Map(locations.map(l => [l.id, proj.project(l.lon, l.lat)]))

  // ---- the window: the frame the plate lies in, the camera in it, the box --------------------------------------------
  const group = new Group()
  group.name = 'network-map'
  /** World → the plate's frame, and the camera in that frame (until a render says: straight ahead, 1600 pt out). */
  const plateFrame = new Matrix4(), eyeFrame = new Matrix4(), eyeLocal = new Vector3(0, 0, 1600)
  /** The uniforms of the window every map material is masked to (`eyeLocal` and `half` also serve the picking). */
  const win = {
    // as of each render (the group's matrixWorld is current by then); each computes its own (no order between them)
    toPlate: uniform(new Matrix4()).onRenderUpdate(() => plateFrame.copy(group.matrixWorld).invert()),
    eye: uniform(new Vector3()).onRenderUpdate(({ camera }) => {
      if (camera) eyeLocal.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(eyeFrame.copy(group.matrixWorld).invert())
      return eyeLocal
    }),
    half: uniform(new Vector2(1, 1)),
    radius: uniform(PLATE_RADIUS),
  }
  /** True where the line of sight through the fragment meets the plate inside the box's rounded rectangle. */
  const mask = Fn(() => {
    const p = win.toPlate.mul(vec4(positionWorld, 1)).xyz, e = win.eye
    const t = e.z.div(max(e.z.sub(p.z), float(1e-3)))
    const q = e.xy.add(p.xy.sub(e.xy).mul(t))
    const d = vec2(abs(q).sub(win.half.sub(win.radius)))
    return length(max(d, vec2(0, 0))).add(min(max(d.x, d.y), float(0))).sub(win.radius).lessThanEqual(0)
  })()
  /** The JS twin of `mask` for a plate-frame point: where it shows on the plate, or null outside the window. */
  const onPlate = (p: Vector3): [number, number] | null => {
    const e = eyeLocal, t = e.z / Math.max(e.z - p.z, 1e-3), x = e.x + (p.x - e.x) * t, y = e.y + (p.y - e.y) * t
    const hx = win.half.value.x - PLATE_RADIUS, hy = win.half.value.y - PLATE_RADIUS
    const dx = Math.abs(x) - hx, dy = Math.abs(y) - hy
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - PLATE_RADIUS <= 0 ? [x, y] : null
  }

  /** An unlit material of the map: masked to the window, not tone mapped, at `order` in the slot. */
  const basic = (o: { color?: string; opacity?: number; additive?: boolean; depthTest?: boolean; depthWrite?: boolean; vertexColors?: boolean }): MeshBasicNodeMaterial => {
    const m = new MeshBasicNodeMaterial({ color: o.color ?? '#ffffff', transparent: true, opacity: o.opacity ?? 1, depthTest: o.depthTest ?? true, depthWrite: o.depthWrite ?? false, vertexColors: o.vertexColors ?? false })
    if (o.additive) m.blending = AdditiveBlending
    m.toneMapped = false; m.maskNode = mask
    owned.materials.push(m)
    return m
  }
  const lineMaterial = (hex: string, opacity: number, additive = false): LineBasicNodeMaterial => {
    const m = new LineBasicNodeMaterial({ color: hex, transparent: true, opacity, depthTest: false, depthWrite: false })
    if (additive) m.blending = AdditiveBlending
    m.toneMapped = false; m.maskNode = mask
    owned.materials.push(m)
    return m
  }
  const place = <O extends Object3D>(o: O, name: string, order: number, pickable = false): O => {
    o.name = name; o.renderOrder = order; o.frustumCulled = false; o.userData.noShadow = true
    if (!pickable) inert(o)
    return o
  }

  // ---- the plate: dark navy, a soft vignette, the box's size (made in `update`) ----------------------------------------
  const plateMaterial = new MeshBasicNodeMaterial({ transparent: true, depthWrite: true })
  plateMaterial.toneMapped = false
  plateMaterial.colorNode = mix(color(COLORS.plate), color(COLORS.plateEdge), smoothstep(0.45, 1.3, length(positionLocal.xy.div(win.half))))
  owned.materials.push(plateMaterial)
  const plate = place(new Mesh(keep(new ShapeGeometry(roundedRect(2, 2, 0.5))), plateMaterial), 'plate', ORDER.plate, true)
  plate.position.z = 0.2

  // ---- the view's frames: plate ← flatten and seat ← pitch ← yaw ← pan ← (ground scaled by s | marks in pt) -----------
  const view = new Group(), tilt = new Group(), turn = new Group(), pan = new Group(), ground = new Group(), marks = new Group(), labels = new Group()
  view.name = 'view'; tilt.name = 'tilt'; turn.name = 'yaw'; pan.name = 'pan'; ground.name = 'ground'; marks.name = 'marks'; labels.name = 'labels'
  group.add(plate, view, labels); view.add(tilt); tilt.add(turn); turn.add(pan); pan.add(ground, marks)

  // ---- the ground: districts, outlines, lakes, rivers, roads (km in x–y, pt in z) ---------------------------------------
  const shapes = geo.districts.flatMap(d => d.rings.map(r => new Shape(ringPoints(r, proj))))
  const districtMaterial = basic({ opacity: 0.9, depthWrite: true })
  // the tops in the district colour, the 6 pt sides darker (their normals lie flat)
  districtMaterial.colorNode = mix(color(COLORS.districtSide), color(COLORS.district), normalLocal.z.clamp(0, 1))
  const districts = keep(new ExtrudeGeometry(shapes, { depth: Z.district, bevelEnabled: false, curveSegments: 1 }))
  districts.clearGroups()   // caps and sides, one material
  ground.add(place(new Mesh(districts, districtMaterial), 'districts', ORDER.districts))
  ground.add(place(new LineSegments(keep(segments(geo.districts.flatMap(d => d.rings), proj, Z.edge, true)), lineMaterial(COLORS.edge, 0.55)), 'district-edges', ORDER.edges))
  const lakes = keep(new ShapeGeometry(geo.lakes.map(l => new Shape(ringPoints(l.c, proj))), 1))
  lakes.translate(0, 0, Z.lake).clearGroups()
  ground.add(place(new Mesh(lakes, basic({ color: COLORS.water, opacity: 0.42, depthTest: false })), 'lakes', ORDER.lakes))
  ground.add(place(new LineSegments(keep(segments(geo.rivers.map(r => r.c), proj, Z.river)), lineMaterial(COLORS.water, 0.85)), 'rivers', ORDER.rivers))
  ROADS.forEach(([cls, alpha], i) => {
    const lines = geo.roads.filter(r => r.cls === cls).map(r => r.c)
    ground.add(place(new LineSegments(keep(segments(lines, proj, Z.road)), lineMaterial(COLORS.road, alpha, true)), `roads-${cls}`, ORDER.roads + i))
  })

  // ---- the places: one instanced hex prism per kind, coloured by kind (a store: by its stock level) --------------------
  const prism = keep(new CylinderGeometry(1, 1, 1, 6, 1).rotateX(Math.PI / 2).translate(0, 0, 0.5))
  /** Lit tops, sides shaded by which way they face (a light from the west-south-west of the ground). */
  const prismShade = mix(normalLocal.x.mul(-0.12).add(normalLocal.y.mul(-0.1)).add(0.66), float(1), normalLocal.z.clamp(0, 1))
  const kinds: LocationKind[] = ['warehouse', 'store', 'supplier']
  const ofKind = Object.fromEntries(kinds.map(k => [k, locations.filter(l => l.kind === k)])) as Record<LocationKind, Location[]>
  const baseColor = (l: Location): Color => new Color(l.kind === 'store' ? stockLevel(l).color : KINDS[l.kind].color)
  const prismsOf = (k: LocationKind): InstancedMesh => {
    const m = basic({ depthWrite: true })
    m.colorNode = prismShade
    const mesh = place(new InstancedMesh(prism, m, Math.max(1, ofKind[k].length)), `places-${k}`, ORDER.prisms, true)
    mesh.count = ofKind[k].length
    ofKind[k].forEach((l, i) => mesh.setColorAt(i, baseColor(l)))
    return mesh
  }
  const prisms: Record<LocationKind, InstancedMesh> = { warehouse: prismsOf('warehouse'), store: prismsOf('store'), supplier: prismsOf('supplier') }
  const kindOf = new Map<unknown, LocationKind>(kinds.map(k => [prisms[k], k]))
  // a prism takes the pointer only where the window shows it: one zoomed or panned out of view, though still in front
  // of the Block (over its title or legend, say), lets the pointer through
  const hits: Intersection[] = [], inv = new Matrix4(), hit = new Vector3()
  for (const mesh of Object.values(prisms)) {
    mesh.raycast = (raycaster: Raycaster, out: Intersection[]): void => {
      hits.length = 0
      InstancedMesh.prototype.raycast.call(mesh, raycaster, hits)
      inv.copy(group.matrixWorld).invert()
      for (const h of hits) if (onPlate(hit.copy(h.point).applyMatrix4(inv))) out.push(h)
    }
  }
  const heightOf = (l: Location): number => Math.max(MIN_HEIGHT, HEIGHT * Math.sqrt(Math.max(0, l.onhand)))

  // ---- marks: diamonds, lanes, dots (rebuilt or moved as the scale changes) -------------------------------------------
  // four edges a place, their vertices written in place as the scale or the hover changes
  const diamondGeometry = keep(new BufferGeometry()).setAttribute('position', new Float32BufferAttribute(new Float32Array(locations.length * 8 * 3), 3))
  const diamonds = place(new LineSegments(diamondGeometry, lineMaterial(COLORS.diamond, 0.9)), 'diamonds', ORDER.diamonds)
  diamonds.material.depthTest = true
  const laneMesh = place(new Mesh(keep(new BufferGeometry()), basic({ opacity: 0.9, additive: true, vertexColors: true })), 'lanes', ORDER.lanes)
  const moving = network.lanes.filter(l => l.status !== 'planned')
  const dots = place(new InstancedMesh(keep(new SphereGeometry(1, 10, 8)), basic({ additive: true }), Math.max(1, moving.length * DOTS.perLane)), 'dots', ORDER.dots)
  dots.count = moving.length * DOTS.perLane
  moving.forEach((l, i) => { for (let k = 0; k < DOTS.perLane; k++) dots.setColorAt(i * DOTS.perLane + k, new Color(l.status === 'overdue' ? COLORS.overdueDot : COLORS.dot)) })
  marks.add(prisms.warehouse, prisms.store, prisms.supplier, diamonds, laneMesh, dots)

  // ---- labels: each warehouse's and supplier's name and a second line, facing the camera ----------------------------
  const sublabel = (l: Location): string => (l.kind === 'warehouse' ? `${l.district} · 在库 ${(l.onhand / 10_000).toFixed(1)} 万件` : `${l.district} · ${KINDS.supplier.label}`)
  const tagged = locations.filter(l => l.kind !== 'store').map(l => {
    const name = textPlane(l.name, { size: 13, color: COLORS.label, weight: 600, createCanvas: opts.createCanvas })
    const sub = textPlane(sublabel(l), { size: 10.5, color: COLORS.sublabel, weight: 500, createCanvas: opts.createCanvas })
    for (const [p, n] of [[name, 'name'], [sub, 'sub']] as const) {
      owned.labels.push(p)
      p.material.depthTest = false; p.material.maskNode = mask
      place(p, `label-${l.id}-${n}`, ORDER.labels)
    }
    const g = new Group()
    g.name = `label-${l.id}`
    name.position.y = 9; sub.position.y = -6
    g.add(name, sub)
    labels.add(g)
    return { l, g }
  })

  // ---- the view's state ----------------------------------------------------------------------------------------------
  const [bx0, by0, bx1, by1] = proj.bounds
  const warehouses = ofKind.warehouse.length ? ofKind.warehouse : locations
  const home: [number, number] = [0, 0]
  for (const l of warehouses) { const [x, y] = at.get(l.id)!; home[0] += x / warehouses.length; home[1] += y / warehouses.length }
  const target: MapView = { zoom: ZOOM0, yaw: 0, pitch: PITCH0, centre: [clamp(home[0], bx0, bx1), clamp(home[1], by0, by1)] }
  const now: MapView = { ...target, centre: [target.centre[0], target.centre[1]] }
  let box = { width: 0, height: 0 }, fit = 1, built = { s: -1, hovered: null as string | null }, hovered: string | null = null, time = 0, dotsPlaced = false
  /** Each moving lane's curve (marks frame, pt) and length, as of the last build (in `moving`'s order). */
  let curves: { curve: QuadraticBezierCurve3; length: number }[] = []
  const toPlate = new Matrix4(), mtx = new Matrix4(), face = new Matrix4(), v = new Vector3(), size = new Vector3(), q = new Quaternion(), up = new Vector3(0, 1, 0)

  /** pt a km now, and the places' size factor. */
  const scale = (): number => fit * now.zoom
  const markScale = (): number => Math.sqrt(now.zoom / ZOOM0)
  /** The place's foot (marks frame, pt), into `out` (default: a new vector). */
  const foot = (l: Location, s = scale(), out = new Vector3()): Vector3 => { const [x, y] = at.get(l.id)!; return out.set(x * s, y * s, Z.base) }

  /** Sizes the plate to the box and fits the city to it at zoom 1 (the rest pitch). */
  const resize = (): void => {
    const { width: W, height: H } = box
    plate.geometry.dispose()
    owned.geometries = owned.geometries.filter(g => g !== plate.geometry)
    plate.geometry = keep(new ShapeGeometry(roundedRect(W, H, Math.min(PLATE_RADIUS, W / 2, H / 2)), 6))
    win.half.value.set(W / 2, H / 2)
    fit = FILL * Math.min(W / (bx1 - bx0), H / ((by1 - by0) * Math.cos(PITCH0)))
  }

  /** Sets the frames from `now`: the flattening and the seat (the window's far edge just in front of the plate). */
  const pose = (): void => {
    const s = scale(), H = box.height
    view.scale.set(1, 1, SQUASH)
    view.position.set(0, 0, SQUASH * (H / 2) * Math.tan(now.pitch) + 2)
    tilt.rotation.x = -now.pitch
    turn.rotation.z = now.yaw
    pan.position.set(-now.centre[0] * s, -now.centre[1] * s, 0)
    ground.scale.set(s, s, 1)
    for (const o of [view, tilt, turn, pan, ground]) o.updateMatrix()
    toPlate.copy(view.matrix).multiply(tilt.matrix).multiply(turn.matrix).multiply(pan.matrix)
  }

  /** The prisms' matrices and colours, and the diamonds, at the current scale and hover. */
  const buildPlaces = (): void => {
    const s = scale(), m = markScale(), lit = new Color('#ffffff'), pos = diamondGeometry.getAttribute('position') as Float32BufferAttribute, f = new Vector3()
    let n = 0
    for (const k of kinds) {
      const mesh = prisms[k]
      ofKind[k].forEach((l, i) => {
        const r = RADIUS[k] * m * (l.id === hovered ? 1.3 : 1), h = heightOf(l) * m
        foot(l, s, f)
        mesh.setMatrixAt(i, mtx.compose(f, q.identity(), v.set(r, r, h)))
        mesh.setColorAt(i, l.id === hovered ? baseColor(l).lerp(lit, 0.35) : baseColor(l))
        // the diamond over its top: a square turned 45°, wider than the prism
        const d = r * 1.55, z = f.z + h + 0.6
        const c = [[f.x + d, f.y], [f.x, f.y + d], [f.x - d, f.y], [f.x, f.y - d]] as const
        for (let j = 0; j < 4; j++) { const a = c[j]!, b = c[(j + 1) % 4]!; pos.setXYZ(n++, a[0], a[1], z); pos.setXYZ(n++, b[0], b[1], z) }
      })
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.boundingSphere = null; mesh.boundingBox = null   // recomputed for the raycast
    }
    pos.needsUpdate = true
    diamondGeometry.computeBoundingSphere()
  }

  /** The lanes' tubes (one merged mesh, coloured per lane; a hovered place's lanes bright, the others dimmed) and curves. */
  const buildLanes = (): void => {
    const s = scale(), m = markScale(), maxQty = Math.max(1, ...network.lanes.map(l => l.qty)), parts: BufferGeometry[] = []
    const byLane = new Map(network.lanes.map(lane => {
      const a = foot(byId.get(lane.from)!, s), b = foot(byId.get(lane.to)!, s), len = a.distanceTo(b)
      const mid = a.clone().add(b).multiplyScalar(0.5), h = clamp(len * 0.22, 8, 100)
      const curve = new QuadraticBezierCurve3(a, mid.setZ(mid.z + 2 * h), b)
      if (len < 1) return [lane, { curve, length: curve.getLength() }] as const   // its ends one place: an arc too small to draw
      const tube = new TubeGeometry(curve, Math.round(clamp(len / 14, 12, 64)), (0.45 + 0.9 * Math.sqrt(lane.qty / maxQty)) * m, 5, false)
      const hex = lane.status === 'overdue' ? COLORS.overdue : lane.status === 'planned' ? COLORS.planned : lane.kind === 'purchase' ? COLORS.purchase : COLORS.transfer
      const c = new Color(hex).multiplyScalar(hovered === null || lane.from === hovered || lane.to === hovered ? 1 : 0.28)
      const n = tube.getAttribute('position').count, rgb = new Float32Array(n * 3)
      for (let i = 0; i < n; i++) rgb.set([c.r, c.g, c.b], i * 3)
      tube.setAttribute('color', new Float32BufferAttribute(rgb, 3))
      tube.deleteAttribute('uv')
      parts.push(tube)
      return [lane, { curve, length: curve.getLength() }] as const
    }))
    curves = moving.map(lane => byLane.get(lane)!)
    const merged = parts.length ? mergeGeometries(parts) : new BufferGeometry()
    for (const p of parts) p.dispose()
    owned.geometries = owned.geometries.filter(g => g !== laneMesh.geometry)
    laneMesh.geometry.dispose()
    laneMesh.geometry = keep(merged ?? new BufferGeometry())
    dotsPlaced = false
  }

  /** Puts the dots along their lanes at `time` (each lane's dots evenly apart, moving from its start to its end). */
  const placeDots = (): void => {
    const m = markScale(), r = DOTS.radius * m
    curves.forEach((c, i) => {
      const rate = clamp(DOTS.pace / Math.max(1, c.length), DOTS.rate[0], DOTS.rate[1])
      for (let k = 0; k < DOTS.perLane; k++) {
        const t = (((time * rate + k / DOTS.perLane + i * 0.137) % 1) + 1) % 1
        dots.setMatrixAt(i * DOTS.perLane + k, mtx.compose(c.curve.getPoint(t, v), q.identity(), size.set(r, r, r)))
      }
    })
    dots.instanceMatrix.needsUpdate = true
    dots.boundingSphere = null
    dotsPlaced = true
  }

  /** The labels over their places' tops, in the plate's frame, facing the camera. */
  const placeLabels = (): void => {
    const s = scale(), m = markScale()
    for (const { l, g } of tagged) {
      foot(l, s, g.position).setZ(Z.base + heightOf(l) * m + 4).applyMatrix4(toPlate).add(v.set(0, 18, 2))
      // turned to the camera: the planes' +z toward the eye (the plate's normal until a render tells where it is)
      g.quaternion.setFromRotationMatrix(face.lookAt(eyeLocal, g.position, up))
    }
  }

  const map: NetworkMap = {
    group, locations, projection: proj,
    get view(): MapView { return { ...target, centre: [target.centre[0], target.centre[1]] } },
    update(dt, ctx) {
      if (!(ctx.width > 0 && ctx.height > 0)) return false   // not laid out yet: nothing to fit to
      const resized = ctx.width !== box.width || ctx.height !== box.height
      if (resized) { box = { width: ctx.width, height: ctx.height }; resize() }
      const k = ctx.reducedMotion ? 1 : 1 - Math.exp(-Math.max(0, dt) / EASE)
      let changed = resized, busy = false
      const ease = (from: number, to: number, eps: number): number => {
        if (from === to) return from
        const next = Math.abs(to - from) < eps ? to : from + (to - from) * k
        changed = true
        if (next !== to) busy = true
        return next
      }
      now.zoom = ease(now.zoom, target.zoom, 1e-4); now.yaw = ease(now.yaw, target.yaw, 1e-5); now.pitch = ease(now.pitch, target.pitch, 1e-5)
      now.centre = [ease(now.centre[0], target.centre[0], 1e-4), ease(now.centre[1], target.centre[1], 1e-4)]
      if (changed) pose()
      const s = scale()
      if (s !== built.s || hovered !== built.hovered) { buildPlaces(); buildLanes(); built = { s, hovered } }
      if (!ctx.reducedMotion && dt > 0 && moving.length) { time += dt; placeDots(); busy = true }
      else if (!dotsPlaced) placeDots()
      placeLabels()
      return busy
    },
    hover(id) {
      if (id !== null && !byId.has(id)) throw new GlassUIError('networkMap.hover', `没有 id 为 "${id}" 的地点`, { allowed: [...byId.keys()], got: id })
      hovered = id
    },
    pick(object, instanceId, point) {
      const k = kindOf.get(object)
      const l = k !== undefined && instanceId !== undefined ? ofKind[k][instanceId] : undefined
      if (l) return l
      if (object !== plate || !point) return null
      let best: Location | null = null, bestD = PICK_RADIUS
      const [px, py] = point, m = markScale()
      for (const c of locations) {
        const a = map.placeOf(c.id)
        if (!a) continue
        const b = onPlate(foot(c).setZ(Z.base + heightOf(c) * m).applyMatrix4(toPlate)) ?? a
        // the distance from the point to the prism's axis as it shows
        const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy
        const t = len2 > 0 ? clamp(((px - a[0]) * dx + (py - a[1]) * dy) / len2, 0, 1) : 0
        const d = Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy)
        if (d <= bestD) { best = c; bestD = d }
      }
      return best
    },
    placeOf(id) {
      const l = byId.get(id)
      if (!l) throw new GlassUIError('networkMap.placeOf', `没有 id 为 "${id}" 的地点`, { allowed: [...byId.keys()], got: id })
      return onPlate(foot(l).applyMatrix4(toPlate))
    },
    pan(dx, dy) {
      if (!Number.isFinite(dx) || !Number.isFinite(dy)) return
      // the plate's (dx, −dy) on the ground: undo the pitch's foreshortening, then the yaw; km at the target zoom
      const gx = dx, gy = -dy / Math.cos(target.pitch), c = Math.cos(-target.yaw), sn = Math.sin(-target.yaw), s = fit * target.zoom
      const ex = (gx * c - gy * sn) / s, ey = (gx * sn + gy * c) / s
      target.centre = [clamp(target.centre[0] - ex, bx0, bx1), clamp(target.centre[1] - ey, by0, by1)]
    },
    rotate(dyaw, dpitch) {
      if (Number.isFinite(dyaw)) target.yaw += dyaw
      if (Number.isFinite(dpitch)) target.pitch = clamp(target.pitch + dpitch, LIMITS.pitch[0], LIMITS.pitch[1])
    },
    zoom(factor) {
      if (!(Number.isFinite(factor) && factor > 0)) return
      target.zoom = clamp(target.zoom * factor, LIMITS.zoom[0], LIMITS.zoom[1])
    },
    dispose() {
      for (const mesh of [...Object.values(prisms), dots]) mesh.dispose()
      for (const l of owned.labels) disposeTextPlane(l)
      for (const g of owned.geometries) g.dispose()
      for (const m of owned.materials) m.dispose()
      owned.geometries = []; owned.materials = []; owned.labels = []
      group.clear()
    },
  }
  return map
}

/** The lanes into and out of `id`, and their pieces: what the place panel lists. */
export function lanesOf(network: Network, id: string): { inbound: Lane[]; outbound: Lane[] } {
  return { inbound: network.lanes.filter(l => l.to === id), outbound: network.lanes.filter(l => l.from === id) }
}
/** "→ 3 家门店 · 12,430 件"-style summary of `lanes` (to or from `id`), by what is at their other ends. */
export function laneSummary(network: Network, lanes: readonly Lane[], dir: 'in' | 'out'): string {
  if (!lanes.length) return '—'
  const ends = lanes.map(l => network.locations.find(x => x.id === (dir === 'out' ? l.to : l.from))!)
  const count = (k: LocationKind, unit: string): string | null => { const n = ends.filter(e => e.kind === k).length; return n ? `${n} ${unit}${KINDS[k].label}` : null }
  const what = [count('store', '家'), count('warehouse', '个'), count('supplier', '家')].filter(Boolean).join('、')
  return `${dir === 'out' ? '→' : '←'} ${what} · ${grouped(lanes.reduce((s, l) => s + l.qty, 0))} 件`
}
