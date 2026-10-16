import { BoxGeometry, CircleGeometry, Color, ExtrudeGeometry, Group, InstancedMesh, Matrix4, Mesh, Quaternion, Shape, Vector3, type BufferGeometry, type Material } from 'three'
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { GlassUIError } from '@glassui/core'
import type { Viewport3DContext } from '@glassui/render'
import { binLevel, RACKS, type Bin } from './data'

/**
 * The warehouse twin's three.js model (spatial spec §4 step 3): a tabletop model of 上海一号仓's high-bay area, made to
 * be attached with `<Viewport3D :object="warehouse.group" :update="…">`. Local units are pt (the Viewport3D's): the group's
 * origin is the box centre on the glass, x right, y up, z out of the plate.
 *
 * Inside, the model is built y-up (its floor in x–z, rows A–F from the back, −z, to the front) and then tilted like a
 * model on a table: its floor leans back `TILT` from the plate, so the viewer looks down on it at 90° − 31.5° and sees
 * the rack tops, every row's face and the aisles between them, while the racks stand out of the glass toward the
 * viewer. It is scaled to fit its box (`FIT`) and seated so the lowest point of its floor touches the glass.
 *
 * Eight draw calls: the floor slab, the painted lines (instanced), the rack frames (one instanced box per upright and
 * beam), the bins (one `InstancedMesh` of rounded boxes, instance i = `bins[i]`), the staging loads (instanced), and
 * the AGV's body, its glowing top and its glow on the floor.
 */

/** Radians the floor leans back from the plate (0: lying on the glass, seen from straight above). */
export const TILT = 0.55
/** The most the model yaws either way about its floor's normal (`rotateBy`), radians. */
export const YAW_LIMIT = 0.8
/** pt/s: the AGV's speed round its loop. */
export const AGV_SPEED = 120
/** pt a hovered bin rises (along the racks' uprights). */
export const HOVER_LIFT = 6
/**
 * How the model fills its box: at rest (yaw 0) within `rest` of the box's width and height; turned, it may use the
 * margins too, and shrinks only when even `turned` of the box is too small (a yawed floor reaches deeper, so its tilted
 * projection grows taller). `view`: about how far (pt) the camera stands from the box when the twin is focused (the
 * rig frames a 900 pt Block from about 6 units, 1460 pt): the fit allows for the perspective that makes the near
 * edge, standing out of the glass, look bigger.
 */
const FIT = { rest: { width: 0.92, height: 0.88 }, turned: { width: 1, height: 1 }, view: 1500 } as const

/** The model's layout, pt (y-up model space). */
const M = {
  bin: { w: 30, h: 15, d: 22, r: 3 },
  /** Bay pitch along a row, level pitch up the rack, the first level's beam height. */
  bay: 36, level: 20, base: 4,
  /** A rack's depth (its front and back uprights' centres 23 apart), the upright's and the beam's cross-sections. */
  rack: { d: 26, upright: 3, beam: { h: 2.5, d: 2 } },
  /** Rows A–F's centres along z: 40 pt aisles, the 70 pt main aisle between C and D. */
  rows: [-180, -114, -48, 48, 114, 180],
  /** The racks' left end (x): the staging area is left of it, the AGV's turning room right of it. */
  rackX: -90,
  floor: { w: 680, d: 430, t: 8, bevel: 2, r: 26 },
  mainAisle: 35,
  /** The AGV's loop: two lanes down the main aisle, from x = from to x = to, turning in semicircles. */
  agv: { lane: 16, from: -160, to: 290, len: 30, w: 20, h: 9 },
} as const
const ROW_LENGTH = RACKS.bays * M.bay
/** The rack tops' height: the top beam over the last level. */
const RACK_TOP = M.base + RACKS.levels * M.level + M.rack.beam.h

/** Every geometry and material the model owns, for `dispose`. */
interface Owned { geometries: BufferGeometry[]; materials: Material[] }

export interface Warehouse {
  /** The model: attach it (`Viewport3D` `object`). */
  readonly group: Group
  /** The bins' mesh: a pointer event whose `object` is it names the bin by `instanceId` (see `binAt`). */
  readonly bins: InstancedMesh
  /**
   * One frame (the Viewport3D's `update`; `ctx` its box): eases the yaw and the hovered bin's lift, fits the model to
   * the box and seats it on the glass when the box or the yaw changed, drives the AGV (not under reduced motion). True
   * while anything moves.
   */
  update(dt: number, ctx: Viewport3DContext): boolean
  /** Highlights bin `id` (an instance of `bins`): its colour lightened at once, raised `HOVER_LIFT` pt; null: none. */
  hover(id: number | null): void
  /** The bin instance `id` draws. */
  binAt(id: number): Bin
  /** Yaws the model by `dx` radians about its floor's normal (eased), clamped to ±`YAW_LIMIT`. */
  rotateBy(dx: number): void
  /** Frees every geometry and material (the model draws nothing after it). */
  dispose(): void
}

const standard = (owned: Owned, color: string, o: { roughness: number; metalness?: number }): MeshStandardNodeMaterial => {
  const m = new MeshStandardNodeMaterial({ color, roughness: o.roughness, metalness: o.metalness ?? 0 })
  owned.materials.push(m)
  return m
}
const keep = <G extends BufferGeometry>(owned: Owned, g: G): G => { owned.geometries.push(g); return g }

/** The floor: a rounded slab, its top at y = 0. */
function floorMesh(owned: Owned): Mesh {
  const { w, d, t, bevel, r } = M.floor, x = w / 2 - r, z = d / 2 - r
  const shape = new Shape()
  shape.absarc(x, z, r, 0, Math.PI / 2, false); shape.absarc(-x, z, r, Math.PI / 2, Math.PI, false)
  shape.absarc(-x, -z, r, Math.PI, Math.PI * 1.5, false); shape.absarc(x, -z, r, Math.PI * 1.5, Math.PI * 2, false)
  const g = keep(owned, new ExtrudeGeometry(shape, { depth: t, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2, curveSegments: 8 }))
  g.rotateX(-Math.PI / 2).translate(0, -(t + bevel), 0)   // the shape in x–z, extruded up; its top (bevel included) at 0
  const mesh = new Mesh(g, standard(owned, '#e7eaf0', { roughness: 0.9 }))
  mesh.name = 'floor'; mesh.receiveShadow = true
  return mesh
}

/** One instance of a unit box, scaled to `size` and centred on `at`. */
const boxAt = (at: [number, number, number], size: [number, number, number]): Matrix4 =>
  new Matrix4().compose(new Vector3(...at), new Quaternion(), new Vector3(...size))

/** Instanced unit boxes, one per `[at, size, color]`. */
function boxes(owned: Owned, name: string, list: readonly [[number, number, number], [number, number, number], string][], material: Material): InstancedMesh {
  const mesh = new InstancedMesh(keep(owned, new BoxGeometry(1, 1, 1)), material, list.length), c = new Color()
  list.forEach(([at, size, color], i) => { mesh.setMatrixAt(i, boxAt(at, size)); mesh.setColorAt(i, c.set(color)) })
  mesh.name = name
  return mesh
}

/** The staging lanes by the docks (the floor's left edge): centres, each `STAGING.w` × `STAGING.d`, clear of the main aisle. */
const STAGING = { w: 70, d: 58, at: [[-290, -150], [-205, -150], [-290, -80], [-205, -80], [-290, 80], [-205, 80], [-290, 150], [-205, 150]] } as const

/** The floor paint, 0.8 pt proud: the main aisle's edges and dashed centre line, the staging lanes' outlines. */
function lines(owned: Owned): InstancedMesh {
  const y = 0.4, edge = '#ffffff', dash = '#f2c46d', list: [[number, number, number], [number, number, number], string][] = []
  const x0 = M.agv.from - 40, x1 = M.rackX + ROW_LENGTH + 40
  for (const z of [-(M.mainAisle - 4), M.mainAisle - 4]) list.push([[(x0 + x1) / 2, y, z], [x1 - x0, 0.8, 2], edge])
  for (let x = x0 + 20; x + 14 <= x1 - 20; x += 24) list.push([[x + 7, y, 0], [14, 0.8, 2], dash])
  const { w, d } = STAGING
  for (const [cx, cz] of STAGING.at) {
    list.push([[cx, y, cz - d / 2], [w, 0.8, 1.6], edge], [[cx, y, cz + d / 2], [w, 0.8, 1.6], edge])
    list.push([[cx - w / 2, y, cz], [1.6, 0.8, d], edge], [[cx + w / 2, y, cz], [1.6, 0.8, d], edge])
  }
  return boxes(owned, 'lines', list, standard(owned, '#ffffff', { roughness: 0.8 }))
}

/** The rack frames: every row's uprights (front and back, at each bay's edge) and its beams (front and back, under each level and on top). */
function frames(owned: Owned): InstancedMesh {
  const list: [[number, number, number], [number, number, number], string][] = []
  const { upright: u, beam, d } = M.rack, half = (d - u) / 2, top = RACK_TOP
  for (const rz of M.rows) {
    for (const side of [-half, half]) {
      for (let i = 0; i <= RACKS.bays; i++) list.push([[M.rackX + i * M.bay, top / 2, rz + side], [u, top, u], '#c5cbd4'])
      for (let l = 0; l <= RACKS.levels; l++) list.push([[M.rackX + ROW_LENGTH / 2, M.base + l * M.level + beam.h / 2, rz + side], [ROW_LENGTH + u, beam.h, beam.d], '#aab3bf'])
    }
  }
  return boxes(owned, 'frames', list, standard(owned, '#ffffff', { roughness: 0.45, metalness: 0.25 }))
}

/** Where bin `b` rests (its centre, model space): on its level's beam, in its bay, in its row. */
const binCentre = (b: Bin): Vector3 =>
  new Vector3(M.rackX + (b.bay + 0.5) * M.bay, M.base + b.level * M.level + M.rack.beam.h + 0.5 + M.bin.h / 2, M.rows[b.row]!)

/** Loads waiting in some of the staging lanes: a rounded block on the floor, `h` pt high. */
function pallets(owned: Owned): InstancedMesh {
  const loads = [[0, 26], [1, 18], [2, 22], [5, 30], [6, 16]] as const, H = 20
  const mesh = new InstancedMesh(keep(owned, new RoundedBoxGeometry(44, H, 36, 2, 3)), standard(owned, '#e4d6bd', { roughness: 0.85 }), loads.length)
  loads.forEach(([lane, h], i) => { const [x, z] = STAGING.at[lane]!; mesh.setMatrixAt(i, boxAt([x, h / 2, z], [1, h / H, 1])) })
  mesh.name = 'pallets'
  return mesh
}

/** The AGV: a white rounded body, a glowing accent top, and its glow on the floor. Faces +x. */
function agv(owned: Owned): Group {
  const { len, w, h } = M.agv, group = new Group()
  const body = new Mesh(keep(owned, new RoundedBoxGeometry(len, h, w, 2, 3)), standard(owned, '#f7f8fa', { roughness: 0.35 }))
  body.position.y = h / 2 + 1
  const glow = standard(owned, '#6b63f5', { roughness: 0.3 })
  glow.emissive.set('#6b63f5'); glow.emissiveIntensity = 1.4
  const top = new Mesh(keep(owned, new RoundedBoxGeometry(len - 10, 2.4, w - 8, 2, 1.1)), glow)
  top.position.y = h + 2
  const haloMaterial = new MeshBasicNodeMaterial({ color: '#6b63f5', transparent: true, opacity: 0.22, depthWrite: false })
  owned.materials.push(haloMaterial)
  const halo = new Mesh(keep(owned, new CircleGeometry(26, 32)), haloMaterial)
  halo.rotation.x = -Math.PI / 2; halo.position.y = 0.6; halo.scale.set(1.25, 1, 1)
  group.add(halo, body, top)
  group.name = 'agv'
  return group
}

/**
 * The AGV's pose `distance` pt round its loop (model space): right along the main aisle's front lane, a half turn, left
 * along its rear lane, a half turn. `heading` is its yaw (`rotation.y`): 0 faces +x.
 */
function agvPose(distance: number, out: { x: number; z: number; heading: number }): void {
  const { from, to, lane } = M.agv, straight = to - from, turn = Math.PI * lane, total = 2 * (straight + turn)
  let s = ((distance % total) + total) % total
  if (s < straight) { out.x = from + s; out.z = lane; out.heading = 0; return }
  s -= straight
  if (s < turn) { const a = s / lane; out.x = to + lane * Math.sin(a); out.z = lane * Math.cos(a); out.heading = a; return }
  s -= turn
  if (s < straight) { out.x = to - s; out.z = -lane; out.heading = Math.PI; return }
  s -= straight
  const a = s / lane
  out.x = from - lane * Math.sin(a); out.z = -lane * Math.cos(a); out.heading = Math.PI + a
}

/** Builds the twin from `data.bins` (in their order: instance i is `bins[i]`). */
export function createWarehouse(data: { bins: readonly Bin[] }): Warehouse {
  const list = data.bins, owned: Owned = { geometries: [], materials: [] }
  const group = new Group(), tilt = new Group(), yaw = new Group()
  group.name = 'warehouse'; tilt.name = 'tilt'; yaw.name = 'yaw'
  tilt.rotation.x = Math.PI / 2 - TILT
  group.add(tilt); tilt.add(yaw)

  const binMesh = new InstancedMesh(keep(owned, new RoundedBoxGeometry(M.bin.w, M.bin.h, M.bin.d, 2, M.bin.r)), standard(owned, '#ffffff', { roughness: 0.55 }), list.length)
  binMesh.name = 'bins'
  const base = list.map(b => new Color(binLevel(b.occupancy).color)), lit = base.map(c => c.clone().lerp(new Color('#ffffff'), 0.4))
  const centres = list.map(binCentre)
  list.forEach((_, i) => { binMesh.setMatrixAt(i, boxAt(centres[i]!.toArray(), [1, 1, 1])); binMesh.setColorAt(i, base[i]!) })
  const vehicle = agv(owned)
  yaw.add(floorMesh(owned), lines(owned), frames(owned), binMesh, pallets(owned), vehicle)

  /** The hovered bin, and each bin's lift (pt) where it is not 0 or not at its target. */
  let hovered: number | null = null
  const lift = new Map<number, number>()
  let yawNow = 0, yawTarget = 0, distance = 0
  /** The box the model is fitted to: the Viewport3D's, from `update`. */
  let box = { width: 0, height: 0 }
  const pose = { x: 0, z: 0, heading: 0 }

  const placeBin = (i: number): void => {
    const c = centres[i]!, l = lift.get(i) ?? 0
    binMesh.setMatrixAt(i, boxAt([c.x, c.y + l, c.z], [1, 1, 1]))
    binMesh.instanceMatrix.needsUpdate = true
  }
  const placeAgv = (): void => {
    agvPose(distance, pose)
    vehicle.position.set(pose.x, 0, pose.z); vehicle.rotation.y = pose.heading
  }
  /** The model's extent (model space): the floor slab's box and the racks' box over it (a hovered bin's lift included). */
  const extent = (): Vector3[] => {
    const { w, d, t, bevel } = M.floor, fw = w / 2 + bevel, fd = d / 2 + bevel, rz = M.rows[M.rows.length - 1]! + M.rack.d / 2
    const out: Vector3[] = []
    for (const x of [-fw, fw]) for (const z of [-fd, fd]) out.push(new Vector3(x, -(t + 2 * bevel), z), new Vector3(x, 0, z))
    for (const x of [M.rackX, M.rackX + ROW_LENGTH]) for (const z of [-rz, rz]) out.push(new Vector3(x, RACK_TOP + HOVER_LIFT, z))
    return out
  }
  const corners = extent(), turn = new Matrix4(), p = new Vector3()
  /** How far the floor reaches toward the plate at `yaw` (model pt below the tilted origin, scale 1); see `place`. */
  const reach = (yaw: number): number => {
    const { w, d, t, bevel, r } = M.floor, a = tilt.rotation.x
    const out = (w / 2 - r) * Math.abs(Math.sin(yaw)) + (d / 2 - r) * Math.abs(Math.cos(yaw)) + r + bevel
    return (t + 2 * bevel) * Math.sin(a) + out * Math.cos(a)
  }
  /**
   * The scale and offset that fit the model at `yaw` into `share` of the box, seen in perspective from `FIT.view`
   * (a few rounds: the seat, and so each corner's magnification, depends on the scale), at most `cap`.
   */
  const frame = (yaw: number, share: { width: number; height: number }, cap = Infinity): { scale: number; x: number; y: number; z: number } => {
    turn.makeRotationX(tilt.rotation.x).multiply(new Matrix4().makeRotationY(yaw))
    const pts = corners.map(c => c.clone().applyMatrix4(turn)), out = reach(yaw), V = FIT.view
    let k = 1, x = 0, y = 0, z = 1
    for (let round = 0; round < 8; round++) {
      z = 1 + k * out
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
      for (const q of pts) {
        const m = V / Math.max(V * 0.2, V - (k * q.z + z))
        p.set((k * q.x + x) * m, (k * q.y + y) * m, 0)
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y)
      }
      // re-centre (undoing an average magnification) and rescale toward the fit
      x -= (x0 + x1) / 2 * (V - z) / V; y -= (y0 + y1) / 2 * (V - z) / V
      k = Math.min(cap, Math.max(1e-3, k * Math.min(box.width * share.width / (x1 - x0), box.height * share.height / (y1 - y0))))
    }
    return { scale: k, x, y, z: 1 + k * out }
  }
  /** The scale that fits the model at rest in the current box (recomputed when the box changes). */
  let restScale = 0
  /**
   * Fits the model, as tilted and yawed now, to its box (see `FIT`) and sets it on the glass: the lowest point of its
   * floor 1 pt over the plate. The slab's outline is a rounded rectangle, so its farthest reach toward the plate is its
   * inner rectangle's plus the corner radius (a rounded rectangle's support) plus the bevel, taken at the slab's bottom
   * (conservative by under 1.5 pt).
   */
  const place = (resized: boolean): void => {
    if (resized) restScale = frame(0, FIT.rest).scale
    const f = frame(yawNow, FIT.turned, restScale)
    tilt.scale.setScalar(f.scale); tilt.position.set(f.x, f.y, f.z)
  }
  placeAgv()

  return {
    group, bins: binMesh,
    update(dt, ctx) {
      const resized = ctx.width !== box.width || ctx.height !== box.height
      let moved = resized, moving = false
      box = { width: ctx.width, height: ctx.height }
      // the yaw eases to its target (≈ 0.1 s), the lifts likewise (≈ 0.07 s); reduced motion: there at once
      const ease = (tau: number): number => ctx.reducedMotion ? 1 : 1 - Math.exp(-Math.max(0, dt) / tau)
      if (yawNow !== yawTarget) {
        yawNow += (yawTarget - yawNow) * ease(0.1)
        if (Math.abs(yawTarget - yawNow) < 1e-4) yawNow = yawTarget
        else moving = true
        yaw.rotation.y = yawNow; moved = true
      }
      if (moved) place(resized)
      for (const [i, l] of lift) {
        const target = i === hovered ? HOVER_LIFT : 0
        let next = l + (target - l) * ease(0.07)
        if (Math.abs(target - next) < 0.05) next = target
        if (next === 0) lift.delete(i); else lift.set(i, next)
        if (next !== target) moving = true
        if (next !== l) placeBin(i)
      }
      if (!ctx.reducedMotion && dt > 0) { distance += AGV_SPEED * dt; placeAgv(); moving = true }
      return moving
    },
    hover(id) {
      if (id === hovered) return
      if (id !== null && !(Number.isInteger(id) && id >= 0 && id < list.length)) throw new GlassUIError('warehouse.hover', `没有第 ${id} 个库位（共 ${list.length} 个）`)
      if (hovered !== null) { binMesh.setColorAt(hovered, base[hovered]!); if (!lift.has(hovered)) lift.set(hovered, 0) }
      hovered = id
      if (id !== null) { binMesh.setColorAt(id, lit[id]!); if (!lift.has(id)) lift.set(id, 0) }
      binMesh.instanceColor!.needsUpdate = true
    },
    binAt(id) {
      const b = Number.isInteger(id) ? list[id] : undefined
      if (!b) throw new GlassUIError('warehouse.binAt', `没有第 ${id} 个库位（共 ${list.length} 个）`)
      return b
    },
    rotateBy(dx) {
      if (!Number.isFinite(dx)) return
      yawTarget = Math.max(-YAW_LIMIT, Math.min(YAW_LIMIT, yawTarget + dx))
    },
    dispose() {
      group.traverse(o => { if (o instanceof InstancedMesh) o.dispose() })
      for (const g of owned.geometries) g.dispose()
      for (const m of owned.materials) m.dispose()
      group.clear()   // nothing left to draw (a disposed geometry drawn again would be uploaded again)
    },
  }
}

