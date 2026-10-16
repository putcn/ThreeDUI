import { describe, it, expect, vi } from 'vitest'
import { createCanvas, type Canvas } from '@napi-rs/canvas'
import { Box3, Color, Line, Mesh, Raycaster, SRGBColorSpace, Vector3, type BufferGeometry, type Material, type Object3D, type Texture } from 'three'
import type { MeshBasicNodeMaterial, NodeMaterial } from 'three/webgpu'
import { defaultTheme, resolveColor, type RGBA } from '@glassui/core'
import type { CanvasFactory } from '@glassui/text'
import { SurfaceChart, SURFACE, type SurfaceChartData } from '../src/chart/surface'
import { textPlane, TEXT_PLANE, LABEL_FONT } from '../src/chart/labels'
import type { Viewport3DContext } from '../src/viewport'
import { buildShaders } from './fixtures/build-shaders'

const napi: CanvasFactory = (w, h) => createCanvas(w, h) as never
const ctx3 = (o: Partial<Viewport3DContext> = {}): Viewport3DContext => ({ width: 600, height: 280, reducedMotion: false, theme: defaultTheme, scheme: 'light', ...o })
const RAMP: RGBA[] = [[0.81, 0.85, 1, 1], [0.65, 0.61, 1, 1], [0.42, 0.39, 0.96, 1], [0.76, 0.09, 0.36, 1]]
/** 2 rows × 3 columns, the largest (8) at row 1, column 2. */
const VALUES = [[0, 2, 4], [1, 3, 8]]
const data = (o: Partial<SurfaceChartData> = {}): SurfaceChartData => ({ values: VALUES, max: 8, ramp: RAMP, ...o })
const make = (o?: Partial<SurfaceChartData>): SurfaceChart => { const c = new SurfaceChart({ createCanvas: napi }); c.set(data(o)); return c }
const run = (c: SurfaceChart, s: number, o?: Partial<Viewport3DContext>): void => { for (let t = 0; t < s; t += 1 / 60) c.update(1 / 60, ctx3(o)) }
/** The surface's vertex (row, col), in the grid's own frame (before the tilt). */
const vertex = (c: SurfaceChart, row: number, col: number, cols = 3): Vector3 => new Vector3().fromBufferAttribute(c.surface.geometry.getAttribute('position'), row * cols + col)
/** A grid-frame point in the chart's frame (the attachment anchor's, the chart sitting at its origin). */
const toChart = (c: SurfaceChart, p: Vector3): Vector3 => { c.updateMatrixWorld(true); return p.clone().applyMatrix4(c.inner.matrix) }
/** pt: the 600 × 280 box's tallest data (0.45 × its shorter side). */
const Z_MAX = 0.45 * 280
const linear = (c: RGBA): Color => new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)
const colorAt = (c: SurfaceChart, row: number, col: number): Color => new Color().fromBufferAttribute(c.surface.geometry.getAttribute('color') as never, row * 3 + col)
const drawables = (o: Object3D): (Mesh | Line)[] => { const out: (Mesh | Line)[] = []; o.traverse(x => { if (x instanceof Mesh || x instanceof Line) out.push(x) }); return out }

describe('SurfaceChart (spatial spec §12.1)', () => {
  it('one vertex per value: rows × cols, two triangles a cell', () => {
    const c = make(); c.update(0, ctx3())
    expect(c.surface.geometry.getAttribute('position').count).toBe(6)
    expect(c.surface.geometry.index!.count).toBe(1 * 2 * 6)
    const big = make({ values: Array.from({ length: 14 }, (_, r) => Array.from({ length: 24 }, (_, k) => r + k)), max: 40 }); big.update(0, ctx3())
    expect(big.surface.geometry.getAttribute('position').count).toBe(14 * 24)
  })
  it('lays the grid over 0.8 of the width and 0.6 of the height, row 0 at the back; heights stand at value / max of 0.45 × the shorter side', () => {
    const c = make(); run(c, 3)
    for (let r = 0; r < 2; r++) for (let k = 0; k < 3; k++) {
      const v = vertex(c, r, k)
      expect(v.x).toBeCloseTo(-240 + k * 240, 6); expect(v.y).toBeCloseTo(r === 0 ? 84 : -84, 6)
      expect(v.z).toBeCloseTo(VALUES[r]![k]! / 8 * Z_MAX, 3)
    }
    expect(c.update(1 / 60, ctx3())).toBe(false)
  })
  it('colours each vertex from the ramp at value / max: the max vertex the last colour, a zero one the first', () => {
    const c = make(); run(c, 3)
    const top = colorAt(c, 1, 2), want = linear(RAMP[3]!), low = colorAt(c, 0, 0), first = linear(RAMP[0]!)
    for (const [a, b] of [[top, want], [low, first]] as const) { expect(a.r).toBeCloseTo(b.r, 4); expect(a.g).toBeCloseTo(b.g, 4); expect(a.b).toBeCloseTo(b.b, 4) }
    // halfway (4 of 8) on a 4-stop ramp (stops at 0, ⅓, ⅔, 1): halfway from stop 1 to stop 2, mixed in sRGB
    const mid = colorAt(c, 0, 2), t = 0.5 * 3 - 1, mix = RAMP[1]!.map((v, i) => v + (RAMP[2]![i]! - v) * t) as RGBA
    expect(mid.r).toBeCloseTo(linear(mix).r, 4); expect(mid.b).toBeCloseTo(linear(mix).b, 4)
  })
  it('tilts back like a tabletop: a height rises toward the viewer (+z, out of the plate) and up', () => {
    const c = make(); run(c, 3)
    const v = vertex(c, 1, 2), top = toChart(c, v), base = toChart(c, new Vector3(v.x, v.y, 0))
    expect(c.inner.rotation.x).toBe(SURFACE.tilt)
    expect(top.z).toBeGreaterThan(base.z + 1); expect(top.y).toBeGreaterThan(base.y + 1)
    // the back row lies farther into the view than the front one
    expect(toChart(c, new Vector3(0, 84, 0)).z).toBeLessThan(toChart(c, new Vector3(0, -84, 0)).z)
  })
  it('sits on the glass: nothing sinks below the plate (z ≥ 0), the lowest point just on it; centred up and down', () => {
    const c = make(); c.labels({ x: ['00', '01', '02'], y: ['10-01', '10-02'], ticks: ['0', '4', '8'] }); run(c, 3)
    c.updateMatrixWorld(true)
    const all = new Box3().setFromObject(c.inner)
    expect(all.min.z).toBeGreaterThanOrEqual(0); expect(all.min.z).toBeLessThan(2)
    expect(Math.abs(all.min.y + all.max.y) / 2).toBeLessThan(20)
    expect(all.max.y - all.min.y).toBeLessThan(280)
  })
  it('grows in: row r starts 30 ms after row r − 1; reduced motion stands it at once', () => {
    const c = make(); c.update(0, ctx3())
    expect(vertex(c, 1, 2).z).toBe(0)
    c.update(1 / 60, ctx3())                                     // 17 ms: row 0 has started, row 1 waits until 30 ms
    expect(vertex(c, 0, 2).z).toBeGreaterThan(0); expect(vertex(c, 1, 2).z).toBe(0)
    run(c, 0.05); expect(vertex(c, 1, 2).z).toBeGreaterThan(0)
    const rm = make(); expect(rm.update(1 / 60, ctx3({ reducedMotion: true }))).toBe(false)
    expect(vertex(rm, 1, 2).z).toBeCloseTo(Z_MAX, 6); expect(vertex(rm, 0, 1).z).toBeCloseTo(2 / 8 * Z_MAX, 6)
  })
  it('a later set springs from the current heights (no stagger); a reshaped one grows in anew', () => {
    const c = make(); run(c, 3)
    c.set(data({ values: [[0, 2, 4], [1, 3, 4]] })); c.update(1 / 60, ctx3())
    const z = vertex(c, 1, 2).z
    expect(z).toBeLessThan(Z_MAX); expect(z).toBeGreaterThan(Z_MAX / 2)
    run(c, 3); expect(vertex(c, 1, 2).z).toBeCloseTo(Z_MAX / 2, 3)
    c.set(data({ values: [[8, 8], [8, 8], [8, 8]] })); c.update(0, ctx3())
    expect(c.surface.geometry.getAttribute('position').count).toBe(6); expect(vertex(c, 2, 1, 2).z).toBe(0)
  })
  it('cellAt maps every vertex back to its cell, the chart moved too; off the grid is null', () => {
    const c = make(); run(c, 3)
    for (let r = 0; r < 2; r++) for (let k = 0; k < 3; k++) expect(c.cellAt(toChart(c, vertex(c, r, k)).toArray())).toEqual({ row: r, col: k })
    expect(c.cellAt(toChart(c, new Vector3(-240 - 130, 84, 0)).toArray())).toBeNull()   // past the left column by more than half a cell
    expect(c.cellAt(toChart(c, new Vector3(0, -84 - 90, 0)).toArray())).toBeNull()      // past the front row
    expect(c.cellAt(toChart(c, new Vector3(-240 + 100, 84 - 70, 50)).toArray())).toEqual({ row: 0, col: 0 })   // nearest, at any height
    c.position.set(30, -10, 5); c.updateMatrixWorld(true)
    const p = vertex(c, 1, 1).applyMatrix4(c.matrixWorld.clone().multiply(c.inner.matrix))
    expect(c.cellAt(p.toArray())).toEqual({ row: 1, col: 1 })
  })
  it('a real ray onto the surface lands in the cell under it', () => {
    const c = make(); run(c, 3); c.updateMatrixWorld(true)
    const target = toChart(c, vertex(c, 1, 1)), from = target.clone().add(new Vector3(0, 0, 2000))
    const hit = new Raycaster(from, new Vector3(0, 0, -1)).intersectObject(c, true)[0]!
    expect(hit.object).toBe(c.surface)
    expect(c.cellAt(hit.point.toArray())).toEqual({ row: 1, col: 1 })
  })
  it('hover stands a guide from the plate to the vertex with a dot on it in the ramp\'s last colour; null hides them', () => {
    const c = make(); run(c, 3)
    expect(c.guide.visible).toBe(false); expect(c.dot.visible).toBe(false)
    c.hover({ row: 1, col: 1 }); c.update(1 / 60, ctx3())
    const v = vertex(c, 1, 1), line = c.guide.geometry.getAttribute('position')
    expect(c.guide.visible).toBe(true)
    expect([line.getX(0), line.getY(0), line.getZ(0)]).toEqual([v.x, v.y, 0])
    expect([line.getX(1), line.getY(1), line.getZ(1)].map(n => +n.toFixed(4))).toEqual([v.x, v.y, v.z].map(n => +n.toFixed(4)))
    expect(c.dot.position.distanceTo(v)).toBeLessThan(1e-4)
    const dotColor = (c.dot.material as MeshBasicNodeMaterial).color, want = linear(RAMP[3]!)
    expect(dotColor.r).toBeCloseTo(want.r, 5); expect(dotColor.b).toBeCloseTo(want.b, 5)
    expect(c.dot.geometry.parameters.radius).toBe(SURFACE.dot / 2)
    c.hover({ row: 0, col: 2 }); c.update(1 / 60, ctx3())
    expect(c.dot.position.distanceTo(vertex(c, 0, 2))).toBeLessThan(1e-4)
    c.hover({ row: 5, col: 0 }); c.update(1 / 60, ctx3()); expect(c.guide.visible).toBe(false)   // not a cell of the data
    c.hover(null); c.update(1 / 60, ctx3()); expect([c.guide.visible, c.dot.visible]).toEqual([false, false])
  })
  it('labels: x along the front edge, y along the left, ticks standing at the back-left corner at even heights; theme colour', () => {
    const c = make(); c.labels({ x: ['00', '01', '02'], y: ['10-01', '10-02'], ticks: ['0', '4', '8'] }); run(c, 3)
    const { x, y, ticks } = c.labelPlanes
    expect([x.length, y.length, ticks.length]).toEqual([3, 2, 3])
    x.forEach((m, k) => { expect(m.position.x).toBeCloseTo(-240 + k * 240, 6); expect(m.position.y).toBeLessThan(-84); expect(m.rotation.x).toBe(0) })
    y.forEach((m, r) => { expect(m.position.x).toBeLessThan(-240); expect(m.position.y).toBeCloseTo(r === 0 ? 84 : -84, 6) })
    expect(y.map(m => m.visible)).toEqual([false, true])                          // the back row's gives way to the ticks' 0
    ticks.forEach((m, k) => { expect(m.position.z).toBeCloseTo(k / 2 * Z_MAX, 6); expect(m.position.y).toBeCloseTo(84, 6); expect(m.rotation.x).toBeCloseTo(Math.PI / 2, 6) })
    const want = linear(resolveColor('secondaryLabel', defaultTheme, 'light')), got = (x[0]!.material as MeshBasicNodeMaterial).color
    expect(got.r).toBeCloseTo(want.r, 5); expect(got.g).toBeCloseTo(want.g, 5)
    // the plate holds them: its front and left edges are past the labels
    c.updateMatrixWorld(true)
    const plate = new Box3().setFromBufferAttribute(c.plate.geometry.getAttribute('position') as never)
    for (const m of [...x, ...y]) { m.geometry.computeBoundingBox(); const b = m.geometry.boundingBox!.clone().translate(m.position); expect(b.min.x).toBeGreaterThanOrEqual(plate.min.x - 1e-6); expect(b.min.y).toBeGreaterThanOrEqual(plate.min.y - 1e-6) }
  })
  it('labels too close for their columns are thinned to every n-th; shown ones never overlap', () => {
    const cols = 24, hours = Array.from({ length: cols }, (_, k) => String(k).padStart(2, '0'))
    const c = make({ values: [hours.map((_, k) => k), hours.map((_, k) => k)], max: 24 }); c.labels({ x: hours, y: ['a', 'b'], ticks: ['0', '24'] }); run(c, 1)
    const shown = c.labelPlanes.x.filter(m => m.visible)
    expect(shown.length).toBeLessThan(cols); expect(shown.length).toBeGreaterThan(cols / 4)
    expect(shown[0]).toBe(c.labelPlanes.x[0])
    for (let k = 1; k < shown.length; k++) {
      const a = shown[k - 1]!, b = shown[k]!
      expect(b.position.x - a.position.x).toBeGreaterThanOrEqual((a.userData.ink as number) / 2 + (b.userData.ink as number) / 2)
    }
  })
  it('row labels are thinned two lines apart from the front row (the latest, always shown); the back row\'s gives way to the value axis (Task 9P V7)', () => {
    const rows = 14, days = Array.from({ length: rows }, (_, d) => `10-${String(d + 1).padStart(2, '0')}`)
    const c = make({ values: days.map(() => [1, 2, 3]), max: 4 }); c.labels({ x: ['a', 'b', 'c'], y: days, ticks: ['0', '4'] })
    c.update(1 / 60, ctx3({ height: 420 }))
    const shown = c.labelPlanes.y.map((m, r) => (m.visible ? r : -1)).filter(r => r >= 0)
    expect(shown).toEqual([1, 3, 5, 7, 9, 11, 13])
    for (let k = 1; k < shown.length; k++) expect(c.labelPlanes.y[shown[k - 1]!]!.position.y - c.labelPlanes.y[shown[k]!]!.position.y).toBeGreaterThanOrEqual(2 * 15)
    // with no ticks the back row keeps its label (if the thinning gives it one)
    c.labels({ x: ['a', 'b', 'c'], y: days.slice(0, 13), ticks: [] }); c.set({ values: days.slice(0, 13).map(() => [1, 2, 3]), max: 4, ramp: [[0, 0, 0, 1], [1, 1, 1, 1]] }); c.update(1 / 60, ctx3({ height: 420 }))
    expect(c.labelPlanes.y[0]!.visible).toBe(true); expect(c.labelPlanes.y[12]!.visible).toBe(true)
  })
  it('a scheme change recolours the labels without new textures; a changed text makes only its own plane again', () => {
    const c = make(); c.labels({ x: ['00', '01', '02'], y: ['a', 'b'], ticks: ['0', '8'] }); run(c, 1)
    const before = c.labelPlanes.x.slice(), tex = before.map(m => (m.material as MeshBasicNodeMaterial).alphaMap!), freed = tex.map(t => vi.spyOn(t, 'dispose'))
    run(c, 1 / 60, { scheme: 'dark' })
    expect(c.labelPlanes.x).toEqual(before); expect(freed.every(f => f.mock.calls.length === 0)).toBe(true)
    const dark = linear(resolveColor('secondaryLabel', defaultTheme, 'dark')), got = (before[1]!.material as MeshBasicNodeMaterial).color
    expect(got.r).toBeCloseTo(dark.r, 5)
    c.labels({ x: ['00', '06', '02'], y: ['a', 'b'], ticks: ['0', '8'] })
    expect(c.labelPlanes.x[0]).toBe(before[0]); expect(c.labelPlanes.x[2]).toBe(before[2]); expect(c.labelPlanes.x[1]).not.toBe(before[1])
    expect(freed[1]).toHaveBeenCalled(); expect(freed[0]).not.toHaveBeenCalled()
    expect(before[1]!.parent).toBeNull()
  })
  it('only the surface casts a shadow, only the surface and the plate take the pointer', () => {
    const c = make(); c.labels({ x: ['00', '01', '02'], y: ['a', 'b'], ticks: ['0', '8'] }); c.hover({ row: 0, col: 0 }); run(c, 1)
    const all = drawables(c)
    expect(all.length).toBeGreaterThan(8)
    for (const o of all) expect(o.userData.noShadow === true, o.name).toBe(o !== c.surface)
    c.updateMatrixWorld(true)
    const hits = new Set<Object3D>()
    for (const o of all) {
      o.geometry.computeBoundingSphere()
      const centre = o.geometry.boundingSphere!.center.clone().applyMatrix4(o.matrixWorld)
      for (const h of new Raycaster(centre.clone().add(new Vector3(0, 0, 2000)), new Vector3(0, 0, -1)).intersectObject(c, true)) hits.add(h.object)
    }
    expect([...hits].every(o => o === c.surface || o === c.plate)).toBe(true); expect(hits.has(c.surface)).toBe(true)
  })
  it('draw order within the chart: plate, grid, labels, surface, then the guide and dot over it', () => {
    const c = make(); c.labels({ x: ['00', '01', '02'], y: ['a', 'b'], ticks: ['0', '8'] }); c.hover({ row: 0, col: 0 }); run(c, 1)
    const label = c.labelPlanes.x[0]!
    const order = [c.plate, c.grid, label, c.surface, c.guide, c.dot].map(o => o.renderOrder)
    expect([...order].sort((a, b) => a - b)).toEqual(order); expect(new Set(order).size).toBe(order.length)
    expect((c.guide.material as Material).depthTest).toBe(false); expect((c.dot.material as Material).depthTest).toBe(false)
  })
  it('a value above max is capped at the full height (and the ramp\'s last colour)', () => {
    const c = make({ values: [[0, 2, 4], [1, 3, 20]] }); run(c, 3)
    expect(vertex(c, 1, 2).z).toBeCloseTo(Z_MAX, 3)
    const top = colorAt(c, 1, 2), want = linear(RAMP[3]!)
    expect(top.r).toBeCloseTo(want.r, 4); expect(top.b).toBeCloseTo(want.b, 4)
  })
  it('riseFor bounds how far the seated chart rises off the glass, labels, plate and hover ring included, at any size', () => {
    const labels = { x: ['00', '01', '02', '03'], y: ['10-14', '10-15', '10-16'], ticks: ['0', '50', '100', '150'] }
    for (const [W, H] of [[640, 280], [300, 400], [500, 60], [80, 60], [1000, 120], [240, 240]] as const) {
      const c = make({ values: [[150, 150, 150, 150], [150, 150, 150, 150], [150, 150, 150, 150]], max: 150 })
      c.labels(labels); c.hover({ row: 2, col: 1 })                                        // the front row, at the full height
      for (let t = 0; t < 3; t += 1 / 60) c.update(1 / 60, ctx3({ width: W, height: H }))
      c.updateMatrixWorld(true)
      const top = new Box3().setFromObject(c, true).max.z, rise = c.riseFor(W, H)
      expect(top, `${W} × ${H}`).toBeLessThanOrEqual(rise)
      // close: within 4.5 pt (the bound allows for a label on the back row, which gives way to the ticks)
      expect(rise - top, `${W} × ${H}: a close bound`).toBeLessThan(4.5)
      expect(rise).toBeLessThanOrEqual(c.riseFor(H, H))                                    // no width rises it past one as wide as high
      expect(c.riseFor(W * 3, H)).toBe(c.riseFor(Math.max(W, H), H))
      // fewer labels and lower data rise less: still bounded
      const bare = make({ values: [[0, 1], [2, 3]], max: 3 }); run(bare, 3, { width: W, height: H }); bare.updateMatrixWorld(true)
      expect(new Box3().setFromObject(bare, true).max.z).toBeLessThanOrEqual(bare.riseFor(W, H))
    }
  })
  it('after dispose, a set grows in again from the plate, row by row', () => {
    const c = make(); run(c, 3)
    c.dispose(); c.set(data()); c.update(0, ctx3())
    expect(vertex(c, 1, 2).z).toBe(0)
    c.update(1 / 60, ctx3()); expect(vertex(c, 0, 2).z).toBeGreaterThan(0); expect(vertex(c, 1, 2).z).toBe(0)
    run(c, 3); expect(vertex(c, 1, 2).z).toBeCloseTo(Z_MAX, 3)
  })
  it('rejects bad data, changing nothing', () => {
    const c = make()
    expect(() => c.set(data({ max: 0 }))).toThrow(/\[SurfaceChart\.set\].*max/)
    expect(() => c.set(data({ values: [[1, 2], [3]] }))).toThrow(/\[SurfaceChart\.set\].*第 2 行/)
    expect(() => c.set(data({ values: [[1, 2]] }))).toThrow(/\[SurfaceChart\.set\].*2 × 2/)
    expect(() => c.set(data({ values: [[1, 2], [3, -1]] }))).toThrow(/\[SurfaceChart\.set\].*values\[1\]\[1\]/)
    expect(() => c.set(data({ values: [[1, 2], [3, NaN]] }))).toThrow(/\[SurfaceChart\.set\]/)
    expect(() => c.set(data({ ramp: [RAMP[0]!] }))).toThrow(/\[SurfaceChart\.set\].*ramp/)
    expect(() => c.set(data({ ramp: [...RAMP, ...RAMP] }))).toThrow(/\[SurfaceChart\.set\].*ramp/)
    run(c, 3); expect(vertex(c, 1, 2).z).toBeCloseTo(Z_MAX, 3)
  })
  it('dispose frees every geometry, material and label texture and empties the chart', () => {
    const c = make(); c.labels({ x: ['00', '01', '02'], y: ['a', 'b'], ticks: ['0', '8'] }); c.hover({ row: 0, col: 0 }); run(c, 1)
    const spies: ReturnType<typeof vi.spyOn>[] = [], seen = new Set<object>()
    const spy = (o: { dispose(): void } | null | undefined): void => { if (o && !seen.has(o)) { seen.add(o); spies.push(vi.spyOn(o, 'dispose')) } }
    const textures: Texture[] = []
    for (const o of drawables(c)) {
      spy(o.geometry as BufferGeometry); spy(o.material as Material)
      const t = (o.material as MeshBasicNodeMaterial).alphaMap; if (t) { textures.push(t); spy(t) }
    }
    expect(textures.length).toBe(3 + 2 + 2)
    c.dispose()
    for (const s of spies) expect(s).toHaveBeenCalled()
    expect(drawables(c)).toEqual([])
    expect(c.cellAt([0, 0, 0])).toBeNull(); expect(c.update(1 / 60, ctx3())).toBe(false)
  })
  it('builds its surface and label materials on both backends without warnings', () => {
    const c = make(); c.labels({ x: ['00', '01', '02'], y: ['a', 'b'], ticks: ['0', '8'] }); run(c, 1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const forceWebGL of [false, true]) {
        for (const m of [c.surface, c.plate, c.labelPlanes.x[0]!, c.dot]) {
          const out = buildShaders(m.material as NodeMaterial, m.geometry, forceWebGL)
          expect(out.fragment.length).toBeGreaterThan(0)
        }
        expect(buildShaders(c.surface.material as NodeMaterial, c.surface.geometry, forceWebGL, true).fragment.length).toBeGreaterThan(0)
      }
      expect(warn).not.toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })
})

describe('textPlane (chart/labels)', () => {
  const font = (size: number, weight = 500): string => `${weight} ${size * TEXT_PLANE.scale}px ${LABEL_FONT}`
  const ink = (text: string, size: number, weight = 500): number => { const g = createCanvas(4, 4).getContext('2d'); g.font = font(size, weight); return g.measureText(text).width / TEXT_PLANE.scale }
  it('is sized in pt from the measured text, drawn at 3× on a transparent canvas', () => {
    const m = textPlane('08:00', { size: 15, color: [0.2, 0.2, 0.3, 1], createCanvas: napi })
    const w = ink('08:00', 15), pad = TEXT_PLANE.pad * 15, { width, height } = m.geometry.parameters
    expect(m.userData.ink).toBeCloseTo(w, 6)
    expect(width).toBeCloseTo(Math.ceil((w + 2 * pad) * 3) / 3, 6); expect(height).toBeCloseTo(Math.ceil(15 * TEXT_PLANE.lineHeight * 3) / 3, 6)
    expect(textPlane('08:00:00', { size: 15, color: [0, 0, 0, 1], createCanvas: napi }).geometry.parameters.width).toBeGreaterThan(width + 10)
    const cv = (m.material as MeshBasicNodeMaterial).alphaMap!.image as Canvas
    expect([cv.width, cv.height]).toEqual([Math.round(width * 3), Math.round(height * 3)])
    const px = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
    const alpha = (x: number, y: number): number => px[(y * cv.width + x) * 4 + 3]!
    expect([alpha(0, 0), alpha(cv.width - 1, cv.height - 1), alpha(0, cv.height - 1)]).toEqual([0, 0, 0])
    let most = 0
    for (let x = Math.round(pad * 3); x < Math.round((pad + w) * 3); x++) most = Math.max(most, alpha(x, Math.round(cv.height / 2)))
    expect(most).toBeGreaterThan(200)
  })
  it('weight changes the font; the material is basic, transparent, no depth write, its colour the given one', () => {
    const bold = textPlane('出库', { size: 13, weight: 600, color: [0.76, 0.09, 0.36, 0.8], createCanvas: napi })
    expect(bold.userData.ink).toBeCloseTo(ink('出库', 13, 600), 6)
    const mat = bold.material as MeshBasicNodeMaterial, want = linear([0.76, 0.09, 0.36, 1])
    expect(mat.type).toBe('MeshBasicNodeMaterial'); expect(mat.transparent).toBe(true); expect(mat.depthWrite).toBe(false)
    expect(mat.color.r).toBeCloseTo(want.r, 6); expect(mat.opacity).toBe(0.8)
  })
  it('align puts the origin at the text\'s left end, centre or right end', () => {
    const box = (align: 'left' | 'center' | 'right'): Box3 => { const m = textPlane('10-14', { size: 15, color: [0, 0, 0, 1], align, createCanvas: napi }); m.geometry.computeBoundingBox(); return m.geometry.boundingBox! }
    const w = ink('10-14', 15), pad = TEXT_PLANE.pad * 15
    // the plane's vertices are Float32: to 1e-4 pt
    expect(box('left').min.x).toBeCloseTo(-pad, 4)
    expect(box('center').min.x).toBeCloseTo(-pad - w / 2, 4)
    expect(box('right').min.x).toBeCloseTo(-pad - w, 4)
    for (const a of ['left', 'center', 'right'] as const) expect(box(a).min.y).toBeCloseTo(-box(a).max.y, 4)
  })
})
