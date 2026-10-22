import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, CylinderGeometry, DoubleSide, ExtrudeGeometry, Float32BufferAttribute, Group, InstancedMesh,
  LineSegments, Matrix4, Mesh, QuadraticBezierCurve3, Quaternion, Shape, ShapeGeometry, SphereGeometry, TubeGeometry, Vector2, Vector3,
  type Intersection, type Material, type Object3D, type Raycaster,
} from 'three'
import { LineBasicNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu'
import { attribute, color, float, length, mix, normalLocal, positionLocal, smoothstep, uniform, vec3 } from 'three/tsl'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { GlassUIError, type RGBA } from '@glassui/core'
import type { Viewport3DContext } from '@glassui/render'
import { disposeTextPlane, textPlane, type TextPlane } from '@glassui/render/internal'
import type { CanvasFactory } from '@glassui/text'
import { KINDS, stockLevel, type Lane, type Location, type LocationKind, type Network } from './data'
import { createWindow } from './window'

/**
 * The logistics network map (spatial spec §12.4): Xuzhou's districts, roads and water (`geo`, the committed extract of
 * DataV and OpenStreetMap) as a pale relief map, with the network's places standing on it as prisms and today's
 * runs arching between them, made to be attached with `<Viewport3D :object="map.group" :update="map.update">`. Local
 * units are pt (the Viewport3D's): the group's origin is the box centre on the glass, x right, y up, z out of it.
 *
 * The map is seen as through a window (window.ts): a muted pearl plate fills the box (`plate`), and everything else is
 * drawn only where the line of sight from the camera through it meets the plate inside the box's rounded rectangle, so
 * a zoomed or panned map never spills over the Block. Inside, the ground lies in its own frame (x east, y north, z up)
 * and is seen pitched: turned back `pitch` from the plate and then flattened toward the plate (`SQUASH`), so it reads
 * as a map looked down on at that angle (an axonometric view) while it stands only a little way out of the glass; it is
 * seated so its far edge (as the window shows it) is just in front of the plate.
 *
 * Projection: equirectangular about the city's centre in km (`createProjection`); `fit` pt a km fills the box with the
 * city at zoom 1 and the rest pitch. The view opens on the warehouses and the stores round them (`INITIAL`), then its
 * zoom (1–6), pan centre (inside the city's bounds), yaw (free) and pitch (0.3–1.2 rad) ease to their targets. The
 * ground's layers scale with the zoom; the places, their diamond tops, the lanes, the dots and the labels keep their
 * size in pt (growing with √(zoom / MARK_ZOOM)), and so do the motorways' and trunk roads' widths.
 *
 * Draw calls (33, at most 40): the plate, the districts (one extruded mesh), their outlines, the lakes, the rivers, the
 * roads by class (secondary and primary 1-px lines; trunk and motorway flat ribbons), the places by kind (3
 * instanced), their diamond tops, the lanes (one merged mesh), the moving dots (instanced), and for each warehouse and
 * supplier a light backdrop and two text planes (name, second line). Nothing casts a shadow, and only the plate and the
 * places take the pointer.
 */

/** The committed GIS extract (src/wms/geo/xuzhou.json): flat [lon, lat, …] coordinates, WGS-84. */
export interface GeoData {
  bbox: readonly number[]
  districts: readonly { name: string; center: readonly number[]; rings: readonly (readonly number[])[] }[]
  roads: readonly { cls: string; c: readonly number[] }[]
  rivers: readonly { c: readonly number[] }[]
  lakes: readonly { c: readonly number[] }[]
}

/** The zoom the places' sizes are designed at (they grow with √(zoom / MARK_ZOOM)). */
export const MARK_ZOOM = 1.8
/** The view's rest pitch: looked down on at 50° from straight above. */
export const PITCH0 = 50 * Math.PI / 180
export const LIMITS = { zoom: [1, 6], pitch: [0.3, 1.2] } as const
/**
 * The view it opens on (spatial spec §12.4: zoomed in to see the warehouses and stores): the cluster, the warehouses
 * and the stores within `radius` km of the warehouses' centre, centred, spread over `width` of the map's width (and at
 * most `height` of its height, as the pitch foreshortens it).
 */
export const INITIAL = { radius: 40, width: 0.6, height: 0.75 } as const
/** How much of its depth the pitched ground keeps toward the viewer (1: none flattened). */
export const SQUASH = 0.14
/** The plate's corner radius, pt. */
export const PLATE_RADIUS = 22
/** Of the box the city fills at zoom 1. */
const FILL = 0.94
/** pt over the ground's plane: the districts' extrusion, the layers drawn on them, the places' feet. */
const Z = { district: 6, lake: 6.15, river: 6.25, edge: 6.3, road: 6.4, base: 6.5 } as const
/** Each place kind's prism radius (pt at zoom MARK_ZOOM); the height is `HEIGHT` × √onhand (pt), at least `MIN_HEIGHT`. */
const RADIUS: Record<LocationKind, number> = { warehouse: 8.5, store: 5.4, supplier: 7.5 }
const HEIGHT = 0.17, MIN_HEIGHT = 12
/** Draw order inside the viewport slot (each drawable's own `renderOrder`). */
const ORDER = { plate: 0, districts: 1, lakes: 2, rivers: 3, edges: 4, roads: 5, lanes: 9, prisms: 10, diamonds: 11, dots: 12, backdrops: 13, labels: 14 } as const
/**
 * Roads by class, brightest last (drawn on top): the colour's alpha and, for the trunk roads and motorways, a width (pt
 * at zoom MARK_ZOOM): a flat ribbon on the ground (spatial spec §12.4: layered by width and brightness); the others are
 * 1-px lines. A lace under the lanes: the widest road stays narrower than the narrowest city lane (`LANES`).
 */
export const ROADS = [
  { cls: 'secondary', alpha: 0.3 }, { cls: 'primary', alpha: 0.5 },
  { cls: 'trunk', alpha: 0.4, width: 0.8 }, { cls: 'motorway', alpha: 0.55, width: 1.2 },
] as const
const COLORS = {
  plate: '#e8ebf4', plateEdge: '#dfe4ef', district: '#c9d2e6', districtSide: '#aebcd7', edge: '#8495bf', road: '#687cab', water: '#80bbc9',
  transfer: '#7167d9', purchase: '#a28de5', planned: '#b8afd7', overdue: '#db7484', dot: '#6b63f5', overdueDot: '#dc6d80', diamond: '#ffffff',
  label: [0.11, 0.12, 0.19, 1] as RGBA, sublabel: [0.34, 0.37, 0.48, 1] as RGBA, backdrop: '#f8f9fc',
} as const
/**
 * The lanes, what the map is about (they stand out over the roads' lace): a city run's tube (a transfer, white) is
 * `base` + `extra` × √(pieces / the most a transfer carries) pt in radius at zoom MARK_ZOOM, so even the lightest is
 * wider than a motorway ribbon; a purchase, coming in from far off, sits at the `floor`. Colour: full strength for a
 * lane of the hovered place, `purchase` for a purchase otherwise (a little dimmer than the city's runs), and `others`
 * for every lane not the hovered place's.
 */
export const LANES = { floor: 0.45, base: 0.65, extra: 0.7, dim: { purchase: 0.62, others: 0.28 }, arc: { rise: 0.22, min: 8, max: 100 } } as const
/**
 * The labels: a light `backdrop` behind each (so a lane or prism behind does not cross it), `pad` pt round its text;
 * the second lines only from zoom `subZoom`; a label whose box would overlap one already placed is left out (warehouses
 * first, the most stock first, then the suppliers), with `gap` pt between boxes.
 */
export const LABELS = { name: 13, sub: 10.5, pad: 5, gap: 4, subZoom: 2.5, lift: 10, backdropAlpha: 0.78, radius: 6 } as const
/** pt round a place's prism (as the window shows it) within which a pointer on the plate picks it. */
export const PICK_RADIUS = 14
/** Seconds the view eases toward its targets in (the time constant). */
const EASE = 0.09
/** The lanes are built again only when the scale has moved this far since (in between, their group is scaled), or it settles. */
const REBUILD = 0.03
/** Dots per moving lane, their radius (pt at MARK_ZOOM), and their pace (pt/s, a lane's share a second within bounds). */
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
   * One frame (the Viewport3D's `update`; `ctx` its box): sizes the plate and the fit to the box (the first box also
   * sets the opening view, `INITIAL`), eases the view to its targets, keeps the places, lanes and labels in place,
   * moves the dots along their lanes (not under reduced motion, where everything is at its target at once). True while
   * anything moves.
   */
  update(dt: number, ctx: Viewport3DContext): boolean
  /** Highlights the place `id` (its prism lit, its lanes bright, the others dimmed); null: none. */
  hover(id: string | null): void
  /** Pins one run for an investigation; null restores the normal hover colouring. */
  highlightLane(id: string | null): void
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
  /**
   * Zooms by `factor` (> 1 in), within `LIMITS.zoom`, about the window's centre; zooming out also draws the pan centre
   * toward the city's centre, reaching it at zoom 1, so the whole city (the suppliers at its edge too) shows there.
   */
  zoom(factor: number): void
  zoomBy(factor: number): void
  resetView(): void
  setLayer(kind: LocationKind, visible: boolean): void
  /** Frees every geometry, material and texture (the map draws nothing after it). */
  dispose(): void
}

export interface NetworkMapOptions {
  /** Makes the label canvases (the root's: DOM canvases in a browser). */
  createCanvas: CanvasFactory
  /** Localizes labels that are baked into the map's text planes. */
  translate?: (text: string) => string
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

/** A flat [lon, lat, …] line as projected points, consecutive duplicates (and a ring's closing one) dropped. */
function linePoints(flat: readonly number[], proj: Projection): Vector2[] {
  const out: Vector2[] = []
  for (let i = 0; i < flat.length; i += 2) {
    const p = new Vector2(...proj.project(flat[i]!, flat[i + 1]!))
    if (!out.length || !out[out.length - 1]!.equals(p)) out.push(p)
  }
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

/**
 * A flat strip along each line (km, at height `z`): two vertices a point on it, both at the point; `side` (a vec2) is
 * the way and how far each moves out per unit of half width: the line's normal there, lengthened at a bend (the miter,
 * at most 1 / 0.35) so the strip keeps its width round it. The material moves them (`positionNode`), so one geometry
 * serves every zoom.
 */
export function ribbons(lines: readonly (readonly number[])[], proj: Projection, z: number): BufferGeometry {
  const pos: number[] = [], side: number[] = [], index: number[] = []
  const din = new Vector2(), dout = new Vector2(), t = new Vector2()
  for (const c of lines) {
    const pts = linePoints(c, proj), n = pts.length
    if (n < 2) continue
    const base = pos.length / 3
    for (let i = 0; i < n; i++) {
      const p = pts[i]!, hasIn = i > 0, hasOut = i < n - 1
      if (hasIn) din.subVectors(p, pts[i - 1]!).normalize()
      if (hasOut) dout.subVectors(pts[i + 1]!, p).normalize()
      if (hasIn && hasOut) { t.addVectors(din, dout); if (t.lengthSq() < 1e-12) t.copy(din); t.normalize() } else t.copy(hasIn ? din : dout)
      const seg = hasIn ? din : dout, k = 1 / Math.max(0.35, -t.y * -seg.y + t.x * seg.x)   // normal · segment's normal
      const nx = -t.y * k, ny = t.x * k
      pos.push(p.x, p.y, z, p.x, p.y, z); side.push(nx, ny, -nx, -ny)
    }
    for (let i = 0; i < n - 1; i++) { const a = base + 2 * i; index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2) }
  }
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(pos, 3)); g.setAttribute('side', new Float32BufferAttribute(side, 2)); g.setIndex(index)
  return g
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

  // ---- the window ------------------------------------------------------------------------------------------------------
  const group = new Group()
  group.name = 'network-map'
  const win = createWindow(group, PLATE_RADIUS), mask = win.mask

  /** An unlit material of the map: masked to the window, not tone mapped. */
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

  // ---- the plate: muted pearl, a soft vignette, the box's size (made in `update`) ---------------------------------------
  const plateMaterial = new MeshBasicNodeMaterial({ transparent: true, depthWrite: true })
  plateMaterial.toneMapped = false
  plateMaterial.colorNode = mix(color(COLORS.plate), color(COLORS.plateEdge), smoothstep(0.45, 1.3, length(positionLocal.xy.div(win.half))))
  owned.materials.push(plateMaterial)
  const plate = place(new Mesh(keep(new ShapeGeometry(roundedRect(2, 2, 0.5))), plateMaterial), 'plate', ORDER.plate, true)
  plate.position.z = 0.2

  // ---- the view's frames: plate ← flatten and seat ← pitch ← yaw ← pan ← (ground scaled by s | marks in pt) -----------
  const view = new Group(), tilt = new Group(), turn = new Group(), pan = new Group(), ground = new Group(), marks = new Group(), lanesGroup = new Group(), labels = new Group()
  view.name = 'view'; tilt.name = 'tilt'; turn.name = 'yaw'; pan.name = 'pan'; ground.name = 'ground'; marks.name = 'marks'; lanesGroup.name = 'lane-frame'; labels.name = 'labels'
  group.add(plate, view, labels); view.add(tilt); tilt.add(turn); turn.add(pan); pan.add(ground, marks); marks.add(lanesGroup)

  // ---- the ground: districts, outlines, lakes, rivers, roads (km in x–y, pt in z) ---------------------------------------
  const shapes = geo.districts.flatMap(d => d.rings.map(r => new Shape(linePoints(r, proj).filter((p, i, all) => i < all.length - 1 || !p.equals(all[0]!)))))
  const districtMaterial = basic({ opacity: 0.9, depthWrite: true })
  // the tops in the district colour, the 6 pt sides darker (their normals lie flat)
  districtMaterial.colorNode = mix(color(COLORS.districtSide), color(COLORS.district), normalLocal.z.clamp(0, 1))
  const districts = keep(new ExtrudeGeometry(shapes, { depth: Z.district, bevelEnabled: false, curveSegments: 1 }))
  districts.clearGroups()   // caps and sides, one material
  ground.add(place(new Mesh(districts, districtMaterial), 'districts', ORDER.districts))
  ground.add(place(new LineSegments(keep(segments(geo.districts.flatMap(d => d.rings), proj, Z.edge, true)), lineMaterial(COLORS.edge, 0.55)), 'district-edges', ORDER.edges))
  const lakes = keep(new ShapeGeometry(geo.lakes.map(l => new Shape(linePoints(l.c, proj).filter((p, i, all) => i < all.length - 1 || !p.equals(all[0]!)))), 1))
  lakes.translate(0, 0, Z.lake).clearGroups()
  ground.add(place(new Mesh(lakes, basic({ color: COLORS.water, opacity: 0.42, depthTest: false })), 'lakes', ORDER.lakes))
  ground.add(place(new LineSegments(keep(segments(geo.rivers.map(r => r.c), proj, Z.river)), lineMaterial(COLORS.water, 0.85)), 'rivers', ORDER.rivers))
  /** Each ribbon class's half width (km): its width in pt over the scale, set as the view moves. */
  const kmUniform = (v: number) => uniform(v)
  const halfWidths: { width: number; km: ReturnType<typeof kmUniform> }[] = []
  ROADS.forEach((r, i) => {
    const lines = geo.roads.filter(x => x.cls === r.cls).map(x => x.c)
    if (!('width' in r)) {
      ground.add(place(new LineSegments(keep(segments(lines, proj, Z.road)), lineMaterial(COLORS.road, r.alpha)), `roads-${r.cls}`, ORDER.roads + i))
      return
    }
    // a flat ribbon: its vertices moved out along `side` by its half width in km (pt / scale), so it keeps its pt width
    const km = kmUniform(0.01), m = basic({ color: COLORS.road, opacity: r.alpha, depthTest: false })
    m.side = DoubleSide
    m.positionNode = positionLocal.add(vec3(attribute<'vec2'>('side', 'vec2').mul(km), float(0)))
    halfWidths.push({ width: r.width, km })
    ground.add(place(new Mesh(keep(ribbons(lines, proj, Z.road)), m), `roads-${r.cls}`, ORDER.roads + i))
  })

  // ---- the places: one instanced hex prism per kind, coloured by kind (a store: by its stock level) --------------------
  const prism = keep(new CylinderGeometry(1, 1, 1, 6, 1).rotateX(Math.PI / 2).translate(0, 0, 0.5))
  /** Lit tops, sides shaded by which way they face (a light from the west-south-west of the ground). */
  const prismShade = mix(normalLocal.x.mul(-0.12).add(normalLocal.y.mul(-0.1)).add(0.66), float(1), normalLocal.z.clamp(0, 1))
  const kinds: LocationKind[] = ['warehouse', 'store', 'supplier']
  const ofKind = Object.fromEntries(kinds.map(k => [k, locations.filter(l => l.kind === k)])) as Record<LocationKind, Location[]>
  const baseColor = new Map(locations.map(l => [l.id, new Color(l.kind === 'store' ? stockLevel(l).color : KINDS[l.kind].color)]))
  const litColor = new Map(locations.map(l => [l.id, baseColor.get(l.id)!.clone().lerp(new Color('#ffffff'), 0.35)]))
  const prismsOf = (k: LocationKind): InstancedMesh => {
    const m = basic({ depthWrite: true })
    m.colorNode = prismShade
    const mesh = place(new InstancedMesh(prism, m, Math.max(1, ofKind[k].length)), `places-${k}`, ORDER.prisms, true)
    mesh.count = ofKind[k].length
    ofKind[k].forEach((l, i) => mesh.setColorAt(i, baseColor.get(l.id)!))
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
      for (const h of hits) if (win.onPlate(hit.copy(h.point).applyMatrix4(inv))) out.push(h)
    }
  }
  const heightOf = (l: Location): number => Math.max(MIN_HEIGHT, HEIGHT * Math.sqrt(Math.max(0, l.onhand)))

  // ---- marks: diamonds, lanes, dots ------------------------------------------------------------------------------------
  // four edges a place, their vertices written in place as the view or the hover changes
  const diamondGeometry = keep(new BufferGeometry()).setAttribute('position', new Float32BufferAttribute(new Float32Array(locations.length * 8 * 3), 3))
  const diamonds = place(new LineSegments(diamondGeometry, lineMaterial(COLORS.diamond, 0.9)), 'diamonds', ORDER.diamonds)
  diamonds.material.depthTest = true
  const laneMesh = place(new Mesh(keep(new BufferGeometry()), basic({ opacity: 0.9, vertexColors: true })), 'lanes', ORDER.lanes)
  const moving = network.lanes.filter(l => l.status !== 'planned')
  let visibleMoving = moving
  const dots = place(new InstancedMesh(keep(new SphereGeometry(1, 10, 8)), basic({}), Math.max(1, moving.length * DOTS.perLane)), 'dots', ORDER.dots)
  dots.count = moving.length * DOTS.perLane
  moving.forEach((l, i) => { for (let k = 0; k < DOTS.perLane; k++) dots.setColorAt(i * DOTS.perLane + k, new Color(l.status === 'overdue' ? COLORS.overdueDot : COLORS.dot)) })
  marks.add(prisms.warehouse, prisms.store, prisms.supplier, diamonds)
  lanesGroup.add(laneMesh, dots)

  // ---- labels: each warehouse's and supplier's name and a second line on a light backdrop, facing the camera ----------
  const translate = opts.translate ?? ((text: string) => text)
  const sublabel = (l: Location): string => (l.kind === 'warehouse' ? `${translate(l.district)} · ${translate('在库')} ${(l.onhand / 10_000).toFixed(1)} ${translate('万件')}` : `${translate(l.district)} · ${translate(KINDS.supplier.label)}`)
  const backdropMaterial = basic({ color: COLORS.backdrop, opacity: LABELS.backdropAlpha, depthTest: false })
  const widthOf = (p: TextPlane): number => { p.geometry.computeBoundingBox(); const b = p.geometry.boundingBox!; return b.max.x - b.min.x }
  const heightOfPlane = (p: TextPlane): number => { p.geometry.computeBoundingBox(); const b = p.geometry.boundingBox!; return b.max.y - b.min.y }
  // warehouses first, the most stock first, then the suppliers: the order the decluttering keeps them in
  const tagged = [...ofKind.warehouse].sort((a, b) => b.onhand - a.onhand).concat(ofKind.supplier).map(l => {
    const name = textPlane(translate(l.name), { size: LABELS.name, color: COLORS.label, weight: 600, createCanvas: opts.createCanvas })
    const sub = textPlane(sublabel(l), { size: LABELS.sub, color: COLORS.sublabel, weight: 500, createCanvas: opts.createCanvas })
    for (const [p, n] of [[name, 'name'], [sub, 'sub']] as const) {
      owned.labels.push(p)
      p.material.depthTest = false; p.material.maskNode = mask
      place(p, `label-${l.id}-${n}`, ORDER.labels)
    }
    // two blocks: the name alone, and the name over its second line; each with its backdrop
    const P = LABELS.pad, nh = heightOfPlane(name), sh = heightOfPlane(sub)
    const compact = { w: widthOf(name) + 2 * P, h: nh + 2 * P }, full = { w: Math.max(widthOf(name), widthOf(sub)) + 2 * P, h: nh + sh + 2 * P }
    const shapeOf = (s: { w: number; h: number }) => keep(new ShapeGeometry(roundedRect(s.w, s.h, Math.min(LABELS.radius, s.h / 2)), 4))
    const back = place(new Mesh(shapeOf(compact), backdropMaterial), `label-${l.id}-backdrop`, ORDER.backdrops)
    const g = new Group()
    g.name = `label-${l.id}`
    g.add(back, name, sub)
    labels.add(g)
    return { l, g, name, sub, back, compact: { ...compact, geometry: back.geometry }, full: { ...full, geometry: shapeOf(full) }, nh, sh }
  })

  // ---- the view's state ----------------------------------------------------------------------------------------------
  const [bx0, by0, bx1, by1] = proj.bounds
  const warehouses = ofKind.warehouse.length ? ofKind.warehouse : locations
  const home: [number, number] = [0, 0]
  for (const l of warehouses) { const [x, y] = at.get(l.id)!; home[0] += x / warehouses.length; home[1] += y / warehouses.length }
  const target: MapView = { zoom: MARK_ZOOM, yaw: 0, pitch: PITCH0, centre: [clamp(home[0], bx0, bx1), clamp(home[1], by0, by1)] }
  const now: MapView = { ...target, centre: [target.centre[0], target.centre[1]] }
  let box = { width: 0, height: 0 }, fit = 1, hovered: string | null = null, time = 0, dotsPlaced = false, opened = false
  /** The scale the lanes were last built at (their group is scaled by the current one over it), and the hover they show. */
  let laneScale = -1, laneHover: string | null | undefined, highlightedLane: string | null = null, paintedLane: string | null | undefined
  const layerVisible: Record<LocationKind, boolean> = { store: true, warehouse: true, supplier: true }
  /** What the prisms, the parked dots and the labels were last placed for: the scale, the hover, the eye. */
  let placedHover: string | null | undefined, placedScale = -1, dotsScale = -1
  const labelEye = new Vector3(Number.NaN, 0, 0)
  /** Scratch for the labels' pass: where a top and a centre show, and the placed boxes (x0, y0, x1, y1 each). */
  const seenAt: [number, number] = [0, 0], boxes = new Float64Array(4 * tagged.length)
  /** Each lane's vertex range in the merged tubes; each moving lane's curve (built at `laneScale`) and length. */
  let ranges: { lane: Lane; start: number; count: number }[] = [], curves: { curve: QuadraticBezierCurve3; length: number }[] = []
  const toPlate = new Matrix4(), mtx = new Matrix4(), face = new Matrix4(), v = new Vector3(), w = new Vector3(), size = new Vector3(), q = new Quaternion(), up = new Vector3(0, 1, 0)
  const tmpColor = new Color()

  /** pt a km now, and the places' size factor. */
  const scale = (): number => fit * now.zoom
  const markScale = (): number => Math.sqrt(now.zoom / MARK_ZOOM)
  /** The place's foot (marks frame, pt) at scale `s`, into `out`. */
  const foot = (l: Location, s: number, out: Vector3): Vector3 => { const [x, y] = at.get(l.id)!; return out.set(x * s, y * s, Z.base) }

  /**
   * The view it opens on (`INITIAL`): the warehouses and the stores within `INITIAL.radius` km of their centre, centred,
   * at the zoom that spreads them over `INITIAL.width` of the map's width (and no more than `INITIAL.height` of its height).
   */
  const opening = (): void => {
    const near = locations.filter(l => l.kind === 'warehouse' || (l.kind === 'store' && Math.hypot(at.get(l.id)![0] - home[0], at.get(l.id)![1] - home[1]) <= INITIAL.radius))
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const l of near) { const [x, y] = at.get(l.id)!; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y) }
    const zoom = clamp(Math.min(INITIAL.width * box.width / (Math.max(1, x1 - x0) * fit), INITIAL.height * box.height / (Math.max(1, y1 - y0) * Math.cos(PITCH0) * fit)), LIMITS.zoom[0], LIMITS.zoom[1])
    target.zoom = now.zoom = zoom
    target.centre = [clamp((x0 + x1) / 2, bx0, bx1), clamp((y0 + y1) / 2, by0, by1)]
    now.centre = [target.centre[0], target.centre[1]]
  }

  /** Sizes the plate to the box and fits the city to it at zoom 1 (the rest pitch); the first box sets the opening view. */
  const resize = (): void => {
    const { width: W, height: H } = box
    plate.geometry.dispose()
    owned.geometries = owned.geometries.filter(g => g !== plate.geometry)
    plate.geometry = keep(new ShapeGeometry(roundedRect(W, H, Math.min(PLATE_RADIUS, W / 2, H / 2)), 6))
    win.setBox(W, H)
    fit = FILL * Math.min(W / (bx1 - bx0), H / ((by1 - by0) * Math.cos(PITCH0)))
    if (!opened) { opened = true; opening() }
  }

  /** Sets the frames from `now`: the flattening and the seat (the window's far edge just in front of the plate). */
  const pose = (): void => {
    const s = scale(), H = box.height, m = markScale()
    view.scale.set(1, 1, SQUASH)
    view.position.set(0, 0, SQUASH * (H / 2) * Math.tan(now.pitch) + 2)
    tilt.rotation.x = -now.pitch
    turn.rotation.z = now.yaw
    pan.position.set(-now.centre[0] * s, -now.centre[1] * s, 0)
    ground.scale.set(s, s, 1)
    for (const o of [view, tilt, turn, pan, ground]) o.updateMatrix()
    toPlate.copy(view.matrix).multiply(tilt.matrix).multiply(turn.matrix).multiply(pan.matrix)
    for (const r of halfWidths) r.km.value = r.width * m / 2 / s
  }

  /** The prisms' matrices and colours, and the diamonds, at the current scale and hover (in place, no allocation). */
  const placePlaces = (): void => {
    const s = scale(), m = markScale(), pos = diamondGeometry.getAttribute('position') as BufferAttribute
    let n = 0
    for (const k of kinds) {
      const mesh = prisms[k]
      ofKind[k].forEach((l, i) => {
        const r = RADIUS[k] * m * (l.id === hovered ? 1.3 : 1), h = heightOf(l) * m
        foot(l, s, w)
        mesh.setMatrixAt(i, mtx.compose(w, q.identity(), size.set(r, r, h)))
        mesh.setColorAt(i, (l.id === hovered ? litColor : baseColor).get(l.id)!)
        // the diamond over its top: a square turned 45°, wider than the prism
        const d = r * 1.55, z = w.z + h + 0.6
        pos.setXYZ(n++, w.x + d, w.y, z); pos.setXYZ(n++, w.x, w.y + d, z)
        pos.setXYZ(n++, w.x, w.y + d, z); pos.setXYZ(n++, w.x - d, w.y, z)
        pos.setXYZ(n++, w.x - d, w.y, z); pos.setXYZ(n++, w.x, w.y - d, z)
        pos.setXYZ(n++, w.x, w.y - d, z); pos.setXYZ(n++, w.x + d, w.y, z)
      })
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.boundingSphere = null; mesh.boundingBox = null   // recomputed for the raycast
    }
    pos.needsUpdate = true
    diamondGeometry.boundingSphere = null
  }

  /** A lane's colour for the current hover: full for the hovered place's lanes, a purchase a little dimmer, the rest dimmed. */
  const laneColor = (lane: Lane, out: Color): Color => {
    const hex = lane.status === 'overdue' ? COLORS.overdue : lane.status === 'planned' ? COLORS.planned : lane.kind === 'purchase' ? COLORS.purchase : COLORS.transfer
    if (highlightedLane !== null) return out.set(hex).multiplyScalar(lane.id === highlightedLane ? 1.35 : 0.22)
    const mine = hovered !== null && (lane.from === hovered || lane.to === hovered)
    return out.set(hex).multiplyScalar(mine ? 1 : hovered !== null ? LANES.dim.others : lane.kind === 'purchase' ? LANES.dim.purchase : 1)
  }

  /** Writes every lane's colour into the merged tubes (in place) for the current hover. */
  const paintLanes = (): void => {
    const col = laneMesh.geometry.getAttribute('color') as BufferAttribute | undefined
    if (!col) return
    for (const { lane, start, count } of ranges) {
      laneColor(lane, tmpColor)
      for (let i = start; i < start + count; i++) col.setXYZ(i, tmpColor.r, tmpColor.g, tmpColor.b)
    }
    col.needsUpdate = true
    laneHover = hovered
    paintedLane = highlightedLane
  }

  /** The lanes' tubes at the current scale (one merged mesh, a vertex range a lane) and the moving lanes' curves. */
  const buildLanes = (): void => {
    const s = scale(), m = markScale(), maxQty = Math.max(1, ...network.lanes.filter(l => l.kind === 'transfer').map(l => l.qty)), parts: BufferGeometry[] = [], a = new Vector3(), b = new Vector3()
    const byLane = new Map<Lane, { curve: QuadraticBezierCurve3; length: number }>()
    ranges = []
    let start = 0
    for (const lane of network.lanes) {
      if (!layerVisible[byId.get(lane.from)!.kind] || !layerVisible[byId.get(lane.to)!.kind]) continue
      foot(byId.get(lane.from)!, s, a); foot(byId.get(lane.to)!, s, b)
      const len = a.distanceTo(b), mid = a.clone().add(b).multiplyScalar(0.5), h = clamp(len * LANES.arc.rise, LANES.arc.min, LANES.arc.max)
      const curve = new QuadraticBezierCurve3(a.clone(), mid.setZ(mid.z + 2 * h), b.clone())
      byLane.set(lane, { curve, length: curve.getLength() })
      if (len < 1) continue   // its ends one place: an arc too small to draw
      const r = (lane.kind === 'purchase' ? LANES.floor : LANES.base + LANES.extra * Math.sqrt(Math.min(1, lane.qty / maxQty))) * m
      const tube = new TubeGeometry(curve, Math.round(clamp(len / 14, 12, 64)), r, 5, false)
      const n = tube.getAttribute('position').count
      tube.setAttribute('color', new Float32BufferAttribute(new Float32Array(n * 3), 3))
      tube.deleteAttribute('uv')
      parts.push(tube); ranges.push({ lane, start, count: n }); start += n
    }
    visibleMoving = moving.filter(lane => layerVisible[byId.get(lane.from)!.kind] && layerVisible[byId.get(lane.to)!.kind])
    curves = visibleMoving.map(lane => byLane.get(lane)!).filter((c): c is { curve: QuadraticBezierCurve3; length: number } => c !== undefined)
    dots.count = curves.length * DOTS.perLane
    const merged = parts.length ? mergeGeometries(parts) : null
    for (const p of parts) p.dispose()
    owned.geometries = owned.geometries.filter(g => g !== laneMesh.geometry)
    laneMesh.geometry.dispose()
    laneMesh.geometry = keep(merged ?? new BufferGeometry())
    laneScale = s
    lanesGroup.scale.set(1, 1, 1)
    // each lane's vertex range in the merged tubes (its id → [start, count]), for whoever inspects the mesh
    laneMesh.userData.ranges = Object.fromEntries(ranges.map(r => [r.lane.id, [r.start, r.count]]))
    paintLanes()
    dotsPlaced = false
  }

  /** Puts the dots along their lanes at `time` (each lane's dots evenly apart, moving from its start to its end). */
  const placeDots = (): void => {
    // the lane frame is scaled across (by the scale over the one the lanes were built at): undone for the dots' size
    const r = DOTS.radius * markScale(), across = r * laneScale / Math.max(1e-9, scale())
    curves.forEach((c, i) => {
      const rate = clamp(DOTS.pace / Math.max(1, c.length), DOTS.rate[0], DOTS.rate[1])
      for (let k = 0; k < DOTS.perLane; k++) {
        const t = (((time * rate + k / DOTS.perLane + i * 0.137) % 1) + 1) % 1
        const lane = visibleMoving[i]
        if (lane) dots.setColorAt(i * DOTS.perLane + k, new Color(lane.status === 'overdue' ? COLORS.overdueDot : COLORS.dot))
        dots.setMatrixAt(i * DOTS.perLane + k, mtx.compose(c.curve.getPoint(t, v), q.identity(), size.set(across, across, r)))
      }
    })
    dots.instanceMatrix.needsUpdate = true
    dots.boundingSphere = null
    dotsPlaced = true
  }

  /**
   * The labels over their places' tops, in the plate's frame, facing the camera: the second lines from zoom
   * `LABELS.subZoom`; then, in priority order, each left out when its place is outside the window or its box (as the
   * window shows it) overlaps one already placed.
   */
  const placeLabels = (): void => {
    const s = scale(), m = markScale(), withSub = now.zoom >= LABELS.subZoom
    let placed = 0
    for (const t of tagged) {
      t.g.visible = layerVisible[t.l.kind]
      const block = withSub ? t.full : t.compact
      // the block's bottom `LABELS.lift` pt over the prism's top
      foot(t.l, s, t.g.position).setZ(Z.base + heightOf(t.l) * m).applyMatrix4(toPlate)
      const topShows = win.onPlate(t.g.position, seenAt) !== null
      t.g.position.add(v.set(0, LABELS.lift + block.h / 2, 2))
      // the lines in the block: the name over the second line, or the name alone
      t.name.position.set(0, withSub ? block.h / 2 - LABELS.pad - t.nh / 2 : 0, 0.1)
      t.sub.position.set(0, -block.h / 2 + LABELS.pad + t.sh / 2, 0.1)
      t.sub.visible = withSub
      if (t.back.geometry !== block.geometry) t.back.geometry = block.geometry
      // its box as the window shows it (the block faces the camera: its size, magnified by its height off the plate),
      // left out when it overlaps a box already placed
      let free = topShows && win.onPlate(t.g.position, seenAt) !== null
      const k = win.eye.z / Math.max(1, win.eye.z - t.g.position.z), hw = block.w * k / 2 + LABELS.gap, hh = block.h * k / 2 + LABELS.gap
      const x0 = seenAt[0] - hw, x1 = seenAt[0] + hw, y0 = seenAt[1] - hh, y1 = seenAt[1] + hh
      for (let i = 0; free && i < placed; i++) {
        const o = i * 4
        if (!(x1 < boxes[o]! || x0 > boxes[o + 2]! || y1 < boxes[o + 1]! || y0 > boxes[o + 3]!)) free = false
      }
      t.g.visible = free
      if (free) { boxes[placed * 4] = x0; boxes[placed * 4 + 1] = y0; boxes[placed * 4 + 2] = x1; boxes[placed * 4 + 3] = y1; placed++ }
      // turned to the camera: the planes' +z toward the eye (the plate's normal until a render tells where it is)
      t.g.quaternion.setFromRotationMatrix(face.lookAt(win.eye, t.g.position, up))
    }
    labelEye.copy(win.eye)
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
      // the lanes: built again when the scale has moved far enough, or once it settles; in between their frame is
      // scaled to it (their feet stay on the places); a new hover repaints them in place
      if (laneScale < 0 || Math.abs(s / laneScale - 1) > REBUILD || (!busy && s !== laneScale)) buildLanes()
      else if (s !== laneScale) lanesGroup.scale.set(s / laneScale, s / laneScale, 1)
      if (laneHover !== hovered || paintedLane !== highlightedLane) paintLanes()
      // the prisms and diamonds stand in the marks frame (km × scale): a pan or a turn moves the frame, not them
      if (s !== placedScale || hovered !== placedHover) { placePlaces(); placedScale = s; placedHover = hovered }
      if (!ctx.reducedMotion && dt > 0 && moving.length) { time += dt; placeDots(); busy = true }
      else if (!dotsPlaced || s !== dotsScale) placeDots()
      dotsScale = s
      // the labels stand in the plate's frame, facing the camera: placed again when the view or the eye moves
      if (changed || labelEye.distanceToSquared(win.eye) > 0.25) placeLabels()
      return busy
    },
    hover(id) {
      if (id !== null && !byId.has(id)) throw new GlassUIError('networkMap.hover', `没有 id 为 "${id}" 的地点`, { allowed: [...byId.keys()], got: id })
      hovered = id
    },
    highlightLane(id) {
      if (id !== null && !network.lanes.some(lane => lane.id === id)) throw new GlassUIError('networkMap.highlightLane', `没有 id 为 "${id}" 的线路`)
      highlightedLane = id
    },
    pick(object, instanceId, point) {
      const k = kindOf.get(object)
      const l = k !== undefined && instanceId !== undefined ? ofKind[k][instanceId] : undefined
      if (l) return l
      if (object !== plate || !point) return null
      let best: Location | null = null, bestD = PICK_RADIUS
      const [px, py] = point, s = scale(), m = markScale()
      for (const c of locations) {
        const a = win.onPlate(foot(c, s, v).applyMatrix4(toPlate))
        if (!a) continue
        const b = win.onPlate(foot(c, s, w).setZ(Z.base + heightOf(c) * m).applyMatrix4(toPlate)) ?? a
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
      return win.onPlate(foot(l, scale(), v).applyMatrix4(toPlate))
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
      const was = target.zoom, next = clamp(was * factor, LIMITS.zoom[0], LIMITS.zoom[1]), lo = LIMITS.zoom[0]
      if (next < was) {
        const k = was > lo ? (next - lo) / (was - lo) : 0, cx = (bx0 + bx1) / 2, cy = (by0 + by1) / 2
        target.centre = [cx + (target.centre[0] - cx) * k, cy + (target.centre[1] - cy) * k]
      }
      target.zoom = next
    },
    zoomBy(factor) { this.zoom(factor) },
    resetView() {
      target.yaw = 0; target.pitch = PITCH0
      if (opened) opening()
      else { target.zoom = MARK_ZOOM; target.centre = [clamp(home[0], bx0, bx1), clamp(home[1], by0, by1)] }
    },
    setLayer(kind, visible) {
      layerVisible[kind] = visible
      prisms[kind].visible = visible
      for (const t of tagged) if (t.l.kind === kind) t.g.visible = visible
      laneScale = -1
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
