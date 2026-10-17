import { Mesh, type InstancedBufferGeometry, type Object3D } from 'three'
import type { FusedGlassInstance, GlassInstance, Mat2D, Node, Rect, RenderList } from '@glassui/core'
import { clampPt, GlassBatch, MIN_THICKNESS, type TouchState } from '../glass/batch'
import { extrudeSlab, fusedBounds, fusedOutline, type FusedProfile, type FusedShape, type SlabMesh } from '../glass/fused'
import type { GlassMaterial } from '../glass/material'
import type { SurfaceDims } from '../units'

/**
 * The grid (pt) a cluster's shapes are rounded to before its mesh is built: the mesh is rebuilt only when a rounded
 * shape (or the spacing, thickness or fillets) changes. A press or a hover moves the shapes every frame for a few
 * hundred ms, and an outline plus its extrusion costs about 0.5–2 ms (`FUSED_MAX_CELLS`).
 */
export const FUSED_ROUND = 0.25

/** How the fused slabs are drawn, from the Surface's glass build (`buildGlass`); none in the 'fill' glass mode. */
export interface FusedBuild {
  /** A glass material on a fused slab's geometry, made as the element glass's: an outer slab's, or a nested one's (`nested`). */
  material(geometry: InstancedBufferGeometry, side: 'back' | 'front', nested: boolean): GlassMaterial
  /** Whether the slabs draw their back faces too (`QualitySettings.backFaces`). */
  backFaces: boolean
  /** `renderOrder` of the back and front draws of an outer slab and of a nested one. */
  orders: { outer: readonly [number, number]; inner: readonly [number, number] }
}

/** One cluster's draws: its mesh batch, built for `key` and centred on `rect`, and the meshes drawing it. */
interface Draw { key: string; batch: GlassBatch; rect: Rect; nested: boolean; meshes: Mesh[] }
/** The materials every outer (or every nested) slab is drawn with, one per face, at its order. */
type Look = { order: number; gm: GlassMaterial }[]

const round = (v: number): number => Math.round(v / FUSED_ROUND) * FUSED_ROUND

/**
 * What a cluster's mesh is built from: its shapes rounded to `FUSED_ROUND`, and the first member's profile clamped as
 * `GlassBatch` packs it (never 0 thick, fillets within the thickness) on `minSide`, the smallest member's short side
 * (so the fillets fit it, as on a 9-slice slab); `key` names all of it, the spacing and the units.
 */
function planOf(f: FusedGlassInstance, s: SurfaceDims): { key: string; shapes: FusedShape[]; profile: FusedProfile } {
  const shapes = f.shapes.map(sh => ({ x: round(sh.x), y: round(sh.y), width: round(sh.width), height: round(sh.height), radius: round(sh.radius) }))
  const p = f.params, thickness = clampPt(p.thickness, MIN_THICKNESS, Infinity)
  const profile: FusedProfile = {
    thickness, fillet: clampPt(p.fillet, 0, thickness), filletBottom: clampPt(p.filletBottom, 0, thickness),
    minSide: Math.max(FUSED_ROUND, Math.min(...shapes.map(sh => Math.min(sh.width, sh.height)))),
  }
  const key = `${shapes.map(sh => `${sh.x},${sh.y},${sh.width},${sh.height},${sh.radius}`).join(';')}|${f.spacing}|${profile.thickness},${profile.fillet},${profile.filletBottom}|${s.ptPerUnit}`
  return { key, shapes, profile }
}

/** `m` (pt) in units: its positions over `ptPerUnit` (the normals are unchanged by a uniform scale). */
function toUnits(m: SlabMesh, ptPerUnit: number): SlabMesh {
  const positions = new Float32Array(m.positions.length)
  for (let i = 0; i < positions.length; i++) positions[i] = m.positions[i]! / ptPerUnit
  return { positions, normals: m.normals, index: m.index }
}

/** The press glow of a cluster: a pressed member's (`pressTarget` keys it by the member), if any. */
function touchOf(f: FusedGlassInstance, touch: ReadonlyMap<Node, TouchState>): TouchState | undefined {
  for (const m of f.members) { const t = touch.get(m.node); if (t) return t }
  return undefined
}

/**
 * Glass containers' fused slabs on a Surface (spec §5.2): per cluster (`FusedGlassInstance`), a mesh batch
 * (`GlassBatch({ mesh })`: `extrudeSlab` of `fusedOutline`, in units, centred on its rounded shapes' bounds) holding
 * one instance — the cluster's params, elevation, opacity and clip over those bounds, radius 0, untransformed and
 * untilted — drawn at the element glass's orders (`FusedBuild.orders.outer`) or, nested in glass, at the inner glass's
 * (`.inner`, no luma index). Draws are kept per container node, its clusters matched by their index there; a cluster
 * whose key (`planOf`) is unchanged keeps its mesh, a changed one gets a new batch (the old one freed) under the same
 * meshes. Every outer slab shares one look (a material per face, made like the element glass's by `FusedBuild`), every
 * nested one another, made on first use and rebuilt by `setBuild`. The meshes are children of `parent` (the content
 * plane) and cast shadows while `castShadows` is on.
 */
export class FusedGlass {
  private draws = new Map<Node, Draw[]>()
  private build: FusedBuild | null = null
  private readonly looks: { outer: Look | null; inner: Look | null } = { outer: null, inner: null }
  private casts: boolean
  private readonly K: number
  private outerInstances: GlassInstance[] = []

  /** `opts.K`: the profile segments of the element glass's slab, which the fused slabs' fillets follow too. */
  constructor(private readonly parent: Object3D, opts: { castShadows: boolean; K: number }) {
    this.casts = opts.castShadows
    this.K = opts.K
  }

  /** Every cluster's batch, by container then cluster. */
  get batches(): GlassBatch[] { return [...this.draws.values()].flatMap(list => list.map(d => d.batch)) }
  /** The outer slabs' instances as last written, in their luma order (`LumaFrame.extra`). */
  get outer(): readonly GlassInstance[] { return this.outerInstances }
  /** The outer slabs' materials, which read the luma (none before the first outer slab or without a build). */
  get lumaMaterials(): GlassMaterial[] { return this.looks.outer?.map(l => l.gm) ?? [] }

  get castShadows(): boolean { return this.casts }
  set castShadows(v: boolean) {
    this.casts = v
    for (const list of this.draws.values()) for (const d of list) for (const m of d.meshes) m.castShadow = v
  }

  /** Rebuilds every slab's draws with `build` (null: none, the 'fill' glass mode), freeing the looks it replaces. */
  setBuild(build: FusedBuild | null): void {
    this.build = build
    this.dropLooks()
    for (const list of this.draws.values()) for (const d of list) this.dress(d)
  }

  /**
   * Draws `outer` and `inner` (nested in glass) clusters, freeing the draws of those gone: an outer cluster `j` reads
   * luma texel `lumaBase + j`, a nested one none; a pressed member's glow (`touch`) shows on its slab. True when the
   * outer look was made (the luma must be attached to it).
   */
  update(outer: readonly FusedGlassInstance[], inner: readonly FusedGlassInstance[], s: SurfaceDims, touch: ReadonlyMap<Node, TouchState>, lumaBase: number): boolean {
    const hadLook = this.looks.outer, next = new Map<Node, Draw[]>(), made: Draw[] = []
    this.outerInstances = []
    const place = (f: FusedGlassInstance, nested: boolean, luma: number | null): void => {
      let list = next.get(f.node)
      if (!list) next.set(f.node, list = [])
      const prev = this.draws.get(f.node)?.[list.length], d = this.sync(prev, f, nested, s)
      if (d !== prev) made.push(d)
      list.push(d)
      const inst: GlassInstance = { node: f.node, rect: d.rect, radius: 0, z: f.z, params: f.params, elevation: f.elevation, scale: f.scale, transform: f.transform, tilt: f.tilt, opacity: f.opacity, ...(f.clip ? { clip: f.clip } : {}) }
      const t = touchOf(f, touch)
      d.batch.update([inst], s, t ? new Map([[f.node, t]]) : undefined, luma === null ? { luma: false } : { lumaBase: luma })
      if (luma !== null) this.outerInstances.push(inst)
    }
    try {
      outer.forEach((f, j) => place(f, false, lumaBase + j))
      for (const f of inner) place(f, true, null)
    } catch (e) {
      for (const d of made) this.free(d)   // a throw fails the Surface: what it kept (`draws`) is what dispose frees
      throw e
    }
    for (const [node, list] of this.draws) for (const d of list.slice(next.get(node)?.length ?? 0)) this.free(d)
    this.draws = next
    return this.looks.outer !== hadLook
  }

  /** `prev` (or a new draw) for cluster `f`: its mesh rebuilt when its key changed, dressed when new or moved in or out of glass. */
  private sync(prev: Draw | undefined, f: FusedGlassInstance, nested: boolean, s: SurfaceDims): Draw {
    const { key, shapes, profile } = planOf(f, s)
    let d = prev
    if (!d || d.key !== key) {
      const mesh = toUnits(extrudeSlab(fusedOutline(shapes, f.spacing), shapes, f.spacing, profile, this.K), s.ptPerUnit)
      const batch = new GlassBatch({ mesh }), rect = fusedBounds(shapes)
      if (d) {
        // the shared materials read the geometry's attributes by name: the meshes just take the new one
        for (const m of d.meshes) { m.geometry = batch.geometry; m.visible = mesh.index.length > 0 }
        d.batch.dispose()
        d.key = key; d.batch = batch; d.rect = rect
      } else d = { key, batch, rect, nested, meshes: [] }
    }
    if (d.nested !== nested || (!d.meshes.length && this.build)) { d.nested = nested; this.dress(d) }
    return d
  }

  /** `d`'s meshes anew, one per face of its look (none without a build); hidden while its mesh is empty (a cluster too small to trace). */
  private dress(d: Draw): void {
    for (const m of d.meshes) m.removeFromParent()
    d.meshes = []
    const look = this.lookFor(d)
    for (const { order, gm } of look ?? []) {
      const mesh = new Mesh(d.batch.geometry, gm.material)
      mesh.renderOrder = order; mesh.frustumCulled = false; mesh.castShadow = this.casts; mesh.receiveShadow = false
      mesh.visible = (d.batch.geometry.index?.count ?? 0) > 0
      this.parent.add(mesh); d.meshes.push(mesh)
    }
  }

  /** The look `d` is drawn with (outer or nested), made on first use; null without a build. */
  private lookFor(d: Draw): Look | null {
    const b = this.build
    if (!b) return null
    const which = d.nested ? 'inner' : 'outer', have = this.looks[which]
    if (have) return have
    const [back, front] = b.orders[which], look: Look = []
    if (b.backFaces) look.push({ order: back, gm: b.material(d.batch.geometry, 'back', d.nested) })
    look.push({ order: front, gm: b.material(d.batch.geometry, 'front', d.nested) })
    return this.looks[which] = look
  }

  private free(d: Draw): void {
    for (const m of d.meshes) m.removeFromParent()
    d.meshes = []
    d.batch.dispose()
  }

  private dropLooks(): void {
    for (const look of [this.looks.outer, this.looks.inner]) for (const { gm } of look ?? []) gm.dispose()
    this.looks.outer = null; this.looks.inner = null
  }

  /** Frees every batch and material and takes the meshes off. */
  dispose(): void {
    for (const list of this.draws.values()) for (const d of list) this.free(d)
    this.draws.clear()
    this.dropLooks()
    this.outerInstances = []
  }
}

/**
 * The glass a press on `pressed` glows on (spec §5.4): the nearest at or above it, a fused member included. While
 * clusters draw fused (`fuse`) a member stands for its slab: the glow lands in the slab's rect (untransformed), keyed by
 * the member, which `FusedGlass.update` looks for. Its key, rect and transform; null when no glass is above it.
 */
export function pressTarget(list: RenderList, pressed: Node, fuse: boolean): { key: Node; rect: Rect; transform: Mat2D } | null {
  for (let n: Node | null = pressed; n; n = n.parent) {
    const g = list.glass.find(i => i.node === n)
    if (g) return { key: g.node, rect: g.rect, transform: g.transform }
    for (const f of list.fused) {
      const m = f.members.find(i => i.node === n)
      if (m) return fuse ? { key: m.node, rect: f.rect, transform: f.transform } : { key: m.node, rect: m.rect, transform: m.transform }
    }
  }
  return null
}

/**
 * The faces a 3D attachment can stand on (`Viewport3DStep.glass`): the glass and the fused members — on their slab's
 * top while it draws fused (`fuse`: the cluster's elevation and thickness), else on their own.
 */
export function glassFaces(list: RenderList, fuse: boolean): readonly GlassInstance[] {
  if (!list.fused.length) return list.glass
  const out = [...list.glass]
  for (const f of list.fused) for (const m of f.members) out.push(fuse ? { ...m, elevation: f.elevation, params: { ...m.params, thickness: f.params.thickness } } : m)
  return out
}
