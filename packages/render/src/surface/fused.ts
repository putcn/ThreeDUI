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

/**
 * One cluster's draws: its mesh batch, built for `plan` (`writePlan`) and centred on `rect`, and the meshes drawing it;
 * the instance it last wrote (`list`: just `inst`), from the cluster `src`, with its batch options `opts`; `seen`: the
 * last update that kept it.
 */
interface Draw {
  plan: Float64Array; batch: GlassBatch; rect: Rect; nested: boolean; meshes: Mesh[]
  src: FusedGlassInstance | null; list: [GlassInstance] | null; opts: { luma?: boolean; lumaBase?: number }; seen: number
}
/** The materials every outer (or every nested) slab is drawn with, one per face, at its order. */
type Look = { order: number; gm: GlassMaterial }[]

const round = (v: number): number => Math.round(v / FUSED_ROUND) * FUSED_ROUND
/** Batch options of a nested slab: no luma index. */
const NO_LUMA = Object.freeze({ luma: false })

/** A cluster's shapes rounded to `FUSED_ROUND`: what its mesh is traced from (its bounds are the instance's rect). */
export function fusedShapes(f: FusedGlassInstance): FusedShape[] {
  return f.shapes.map(sh => ({ x: round(sh.x), y: round(sh.y), width: round(sh.width), height: round(sh.height), radius: round(sh.radius) }))
}

/**
 * The slab profile a cluster's mesh is extruded with: its params' (the first member's geometry) clamped as
 * `GlassBatch` packs them (never 0 thick, fillets within the thickness) on `minSide`, the smallest member's short side
 * among `shapes` (`fusedShapes`), so the fillets fit it as on a 9-slice slab.
 */
export function fusedProfile(f: FusedGlassInstance, shapes: readonly FusedShape[]): FusedProfile {
  const p = f.params, thickness = clampPt(p.thickness, MIN_THICKNESS, Infinity)
  let minSide = Infinity
  for (const sh of shapes) minSide = Math.min(minSide, sh.width, sh.height)
  return { thickness, fillet: clampPt(p.fillet, 0, thickness), filletBottom: clampPt(p.filletBottom, 0, thickness), minSide: Math.max(FUSED_ROUND, minSide) }
}

/** `m` (pt) in units: its positions over `ptPerUnit` (the normals are unchanged by a uniform scale). */
function toUnits(m: SlabMesh, ptPerUnit: number): SlabMesh {
  const positions = new Float32Array(m.positions.length)
  for (let i = 0; i < positions.length; i++) positions[i] = m.positions[i]! / ptPerUnit
  return { positions, normals: m.normals, index: m.index }
}

/**
 * Glass containers' fused slabs on a Surface (spec §5.2): per cluster (`FusedGlassInstance`), a mesh batch
 * (`GlassBatch({ mesh })`: `extrudeSlab` of `fusedOutline` over `fusedShapes` with `fusedProfile`, in units, centred
 * on the rounded shapes' bounds) holding one instance — the cluster's params, elevation, opacity and clip over those
 * bounds, radius 0, untransformed and untilted, as its first member's node (the press glow's key, `pressTarget`) —
 * drawn at the element glass's orders (`FusedBuild.orders.outer`) or, nested in glass, at the inner glass's (`.inner`,
 * no luma index).
 *
 * A cluster keeps the draw of the previous update that holds one of its members (so one dissolving or reshaping
 * leaves the others alone), and that draw keeps its mesh while the cluster's plan (its rounded shapes, spacing,
 * profile and the units, compared as numbers) is unchanged; a changed plan gets a new batch (the old one freed) under
 * the same meshes. An update with the very clusters of the last one (a moving press glow) only rewrites the instances:
 * it allocates nothing of its own and keeps `outer` as it was, so the luma does not repack.
 *
 * Every outer slab shares one look (a material per face, made like the element glass's by `FusedBuild`), every nested
 * one another, made on first use and rebuilt by `setBuild`. The meshes are children of `parent` (the content plane)
 * and cast shadows while `castShadows` is on.
 */
export class FusedGlass {
  private draws: Draw[] = []
  /** Each member node of the last update's clusters → its cluster's draw. */
  private readonly byMember = new Map<Node, Draw>()
  private build: FusedBuild | null = null
  private readonly looks: { outer: Look | null; inner: Look | null } = { outer: null, inner: null }
  private casts: boolean
  private readonly K: number
  private outerInstances: readonly GlassInstance[] = []
  /** The last update's clusters, luma base and units: an update with the same is a touch-only one. */
  private last: { outer: readonly FusedGlassInstance[]; inner: readonly FusedGlassInstance[]; lumaBase: number; ptPerUnit: number } | null = null
  private epoch = 0
  /** Scratch: a plan being compared (`writePlan`), and the outer instances being collected. */
  private plan = new Float64Array(64)
  private readonly nextOuter: GlassInstance[] = []

  /** `opts.K`: the profile segments of the element glass's slab, which the fused slabs' fillets follow too. */
  constructor(private readonly parent: Object3D, opts: { castShadows: boolean; K: number }) {
    this.casts = opts.castShadows
    this.K = opts.K
  }

  /** Every cluster's batch, outer clusters first, in list order. */
  get batches(): GlassBatch[] { return this.draws.map(d => d.batch) }
  /** The outer slabs' instances as last written, in their luma order (`LumaFrame.extra`); kept while they are unchanged. */
  get outer(): readonly GlassInstance[] { return this.outerInstances }
  /** The outer slabs' materials, which read the luma (none before the first outer slab or without a build). */
  get lumaMaterials(): GlassMaterial[] { return this.looks.outer?.map(l => l.gm) ?? [] }

  get castShadows(): boolean { return this.casts }
  set castShadows(v: boolean) {
    this.casts = v
    for (const d of this.draws) for (const m of d.meshes) m.castShadow = v
  }

  /** Rebuilds every slab's draws with `build` (null: none, the 'fill' glass mode), freeing the looks it replaces. */
  setBuild(build: FusedBuild | null): void {
    this.build = build
    this.dropLooks()
    for (const d of this.draws) this.dress(d)
  }

  /**
   * Draws `outer` and `inner` (nested in glass) clusters, freeing the draws of those gone: an outer cluster `j` reads
   * luma texel `lumaBase + j`, a nested one none; a pressed member's glow (`touch`, keyed as `pressTarget` keys it)
   * shows on its slab. True when the outer look was made (the luma must be attached to it).
   */
  update(outer: readonly FusedGlassInstance[], inner: readonly FusedGlassInstance[], s: SurfaceDims, touch: ReadonlyMap<Node, TouchState>, lumaBase: number): boolean {
    const last = this.last
    if (last && last.outer === outer && last.inner === inner && last.lumaBase === lumaBase && last.ptPerUnit === s.ptPerUnit) {
      // the same clusters: only the press glow moves
      for (const d of this.draws) if (d.list) d.batch.update(d.list, s, touch, d.opts)
      return false
    }
    const hadLook = this.looks.outer, epoch = ++this.epoch, next: Draw[] = [], made: Draw[] = []
    this.nextOuter.length = 0
    const place = (f: FusedGlassInstance, nested: boolean, luma: number | null): void => {
      // the previous draw holding one of its members, unless an earlier cluster took it
      let prev: Draw | undefined
      for (const m of f.members) { const d = this.byMember.get(m.node); if (d && d.seen !== epoch) { prev = d; break } }
      const d = this.sync(prev, f, nested, s)
      if (d !== prev) made.push(d)
      d.seen = epoch
      next.push(d)
      if (d.src !== f || !d.list) {
        d.src = f
        d.list = [{ node: f.members[0]!.node, rect: d.rect, radius: 0, z: f.z, params: f.params, elevation: f.elevation, scale: f.scale, transform: f.transform, tilt: f.tilt, opacity: f.opacity, ...(f.clip ? { clip: f.clip } : {}) }]
      }
      if (luma === null) d.opts = NO_LUMA
      else if (d.opts.lumaBase !== luma) d.opts = { lumaBase: luma }
      d.batch.update(d.list, s, touch, d.opts)
      if (luma !== null) this.nextOuter.push(d.list[0])
    }
    try {
      outer.forEach((f, j) => place(f, false, lumaBase + j))
      for (const f of inner) place(f, true, null)
    } catch (e) {
      for (const d of made) this.free(d)   // a throw fails the Surface: what it kept (`draws`) is what dispose frees
      throw e
    }
    for (const d of this.draws) if (d.seen !== epoch) this.free(d)
    this.draws = next
    this.byMember.clear()
    for (const d of next) for (const m of d.src!.members) this.byMember.set(m.node, d)
    const o = this.nextOuter, kept = this.outerInstances
    if (o.length !== kept.length || o.some((g, i) => g !== kept[i])) this.outerInstances = o.slice()
    this.last = { outer, inner, lumaBase, ptPerUnit: s.ptPerUnit }
    return this.looks.outer !== hadLook
  }

  /**
   * Writes cluster `f`'s plan into the scratch `plan`: its member count, spacing, profile (`fusedProfile`'s thickness
   * and fillets), units and rounded shapes, as numbers; returns its length.
   */
  private writePlan(f: FusedGlassInstance, s: SurfaceDims): number {
    const n = f.shapes.length, len = 6 + 5 * n
    if (this.plan.length < len) this.plan = new Float64Array(2 * len)
    const q = this.plan, p = f.params, t = clampPt(p.thickness, MIN_THICKNESS, Infinity)
    q[0] = n; q[1] = f.spacing; q[2] = t; q[3] = clampPt(p.fillet, 0, t); q[4] = clampPt(p.filletBottom, 0, t); q[5] = s.ptPerUnit
    for (let i = 0; i < n; i++) {
      const sh = f.shapes[i]!, o = 6 + 5 * i
      q[o] = round(sh.x); q[o + 1] = round(sh.y); q[o + 2] = round(sh.width); q[o + 3] = round(sh.height); q[o + 4] = round(sh.radius)
    }
    return len
  }

  /** `prev` (or a new draw) for cluster `f`: its mesh rebuilt when its plan changed, dressed when new or moved in or out of glass. */
  private sync(prev: Draw | undefined, f: FusedGlassInstance, nested: boolean, s: SurfaceDims): Draw {
    const len = this.writePlan(f, s), q = this.plan
    let same = prev !== undefined && prev.plan.length === len
    for (let i = 0; same && i < len; i++) same = prev!.plan[i] === q[i]
    let d = prev
    if (!d || !same) {
      const shapes = fusedShapes(f)
      const mesh = toUnits(extrudeSlab(fusedOutline(shapes, f.spacing), shapes, f.spacing, fusedProfile(f, shapes), this.K), s.ptPerUnit)
      const batch = new GlassBatch({ mesh }), rect = fusedBounds(shapes), plan = q.slice(0, len)
      if (d) {
        // the shared materials read the geometry's attributes by name: the meshes just take the new one
        for (const m of d.meshes) { m.geometry = batch.geometry; m.visible = mesh.index.length > 0 }
        d.batch.dispose()
        d.plan = plan; d.batch = batch; d.rect = rect; d.list = null
      } else d = { plan, batch, rect, nested, meshes: [], src: null, list: null, opts: NO_LUMA, seen: 0 }
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
    for (const d of this.draws) this.free(d)
    this.draws = []
    this.byMember.clear()
    this.dropLooks()
    this.outerInstances = []
    this.last = null
  }
}

/**
 * The glass a press on `pressed` glows on (spec §5.4): the nearest at or above it, a fused member included. While
 * clusters draw fused (`fuse`) a member stands for its slab: the glow lands in the slab's rect (untransformed), keyed by
 * the cluster's first member, the node of the slab's instance (`FusedGlass`). Its key, rect and transform; null when no
 * glass is above it.
 */
export function pressTarget(list: RenderList, pressed: Node, fuse: boolean): { key: Node; rect: Rect; transform: Mat2D } | null {
  for (let n: Node | null = pressed; n; n = n.parent) {
    const g = list.glass.find(i => i.node === n)
    if (g) return { key: g.node, rect: g.rect, transform: g.transform }
    for (const f of list.fused) {
      const m = f.members.find(i => i.node === n)
      if (m) return fuse ? { key: f.members[0]!.node, rect: f.rect, transform: f.transform } : { key: m.node, rect: m.rect, transform: m.transform }
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
