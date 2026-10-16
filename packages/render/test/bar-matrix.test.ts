import { describe, it, expect, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { Box3, Color, Line, Mesh, Raycaster, SRGBColorSpace, Vector3, type BufferGeometry, type Material, type Object3D, type Texture } from 'three'
import type { MeshBasicNodeMaterial, MeshStandardNodeMaterial, NodeMaterial } from 'three/webgpu'
import { defaultTheme, resolveColor, type RGBA } from '@glassui/core'
import type { CanvasFactory } from '@glassui/text'
import { BarMatrix, MATRIX, type BarMatrixData } from '../src/chart/matrix'
import { FRAME } from '../src/chart/frame'
import { SurfaceChart } from '../src/chart/surface'
import { textPlaneHeight } from '../src/chart/labels'
import type { Viewport3DContext } from '../src/viewport'
import { buildShaders } from './fixtures/build-shaders'

const napi: CanvasFactory = (w, h) => createCanvas(w, h) as never
const ctx3 = (o: Partial<Viewport3DContext> = {}): Viewport3DContext => ({ width: 600, height: 280, reducedMotion: false, theme: defaultTheme, scheme: 'light', ...o })
/** 2 rows × 3 columns; the largest (8) at row 1, column 2; a zero at row 0, column 0. */
const VALUES = [[0, 2, 4], [1, 3, 8]]
const COLORS: RGBA[][] = [
  [[0.2, 0.78, 0.35, 1], [0.5, 0.7, 0.3, 1], [1, 0.72, 0.42, 1]],
  [[0.9, 0.6, 0.4, 1], [1, 0.5, 0.45, 1], [1, 0.42, 0.42, 1]],
]
const data = (o: Partial<BarMatrixData> = {}): BarMatrixData => ({ values: VALUES, max: 8, colors: COLORS, ...o })
const make = (o?: Partial<BarMatrixData>): BarMatrix => { const c = new BarMatrix({ createCanvas: napi }); c.set(data(o)); return c }
const run = (c: BarMatrix, s: number, o?: Partial<Viewport3DContext>): void => { for (let t = 0; t < s; t += 1 / 60) c.update(1 / 60, ctx3(o)) }
/** A rows × cols matrix of `v`, and its colours. */
const full = (rows: number, cols: number, v = 8): Pick<BarMatrixData, 'values' | 'colors'> => ({
  values: Array.from({ length: rows }, () => Array.from({ length: cols }, () => v)),
  colors: Array.from({ length: rows }, () => Array.from({ length: cols }, (): RGBA => [0.5, 0.5, 0.5, 1])),
})
/** pt: the 600 × 280 box's tallest bar (0.45 × its shorter side). */
const Z_MAX = 0.45 * 280
const bar = (c: BarMatrix, row: number, col: number, cols = 3): Mesh => c.bars[row * cols + col] as Mesh
/** A bar's box as drawn now, in the grid's frame (the tilted `inner`'s, the bars' parent). */
const boxOf = (m: Mesh): Box3 => { m.updateMatrix(); m.geometry.computeBoundingBox(); return m.geometry.boundingBox!.clone().applyMatrix4(m.matrix) }
const top = (c: BarMatrix, row: number, col: number, cols = 3): number => boxOf(bar(c, row, col, cols)).max.z
const linear = (c: RGBA): Color => new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)
const colorOf = (m: Mesh): Color => (m.material as MeshStandardNodeMaterial).color
const expectColor = (got: Color, want: Color, k = 1): void => { expect(got.r).toBeCloseTo(want.r * k, 5); expect(got.g).toBeCloseTo(want.g * k, 5); expect(got.b).toBeCloseTo(want.b * k, 5) }
const drawables = (o: Object3D): (Mesh | Line)[] => { const out: (Mesh | Line)[] = []; o.traverse(x => { if (x instanceof Mesh || x instanceof Line) out.push(x) }); return out }
const LABELS = { rows: ['A 区', 'B 区'], cols: ['日化', '食品', '家电'] }

describe('BarMatrix (spatial spec §12.2)', () => {
  it('one rounded-box mesh per cell, row-major, its userData { row, col }; a grid over 0.8 of the box, each footprint 0.55 of its cell', () => {
    const c = make(); run(c, 3)
    expect(c.bars.length).toBe(6)
    // the 600 × 280 box: a 480 × 224 grid, cells 160 × 112, footprints 88 × 61.6, standing on the plate (z = 0)
    for (let r = 0; r < 2; r++) for (let k = 0; k < 3; k++) {
      const m = bar(c, r, k), b = boxOf(m)
      expect(m.userData).toEqual({ row: r, col: k })
      expect(m.geometry.type).toBe('RoundedBoxGeometry'); expect(m.parent).toBe(c.inner)
      expect((b.min.x + b.max.x) / 2).toBeCloseTo(-160 + k * 160, 4); expect((b.min.y + b.max.y) / 2).toBeCloseTo(r === 0 ? 56 : -56, 4)
      expect(b.max.x - b.min.x).toBeCloseTo(0.55 * 160, 4); expect(b.max.y - b.min.y).toBeCloseTo(0.55 * 112, 4)
      expect(b.min.z).toBeCloseTo(0, 6)
    }
    expect([MATRIX.fill, MATRIX.footprint, MATRIX.height]).toEqual([0.8, 0.55, 0.45])
    const big = make(full(6, 7)); big.update(0, ctx3())
    expect(big.bars.length).toBe(42); expect(big.bars[41]!.userData).toEqual({ row: 5, col: 6 })
  })
  it('heights after growth: value / max of 0.45 × the shorter side, the geometry built at that height; a zero stands hidden; above max is capped', () => {
    const c = make(); run(c, 3)
    for (let r = 0; r < 2; r++) for (let k = 0; k < 3; k++) if (VALUES[r]![k]! > 0) expect(top(c, r, k)).toBeCloseTo(VALUES[r]![k]! / 8 * Z_MAX, 3)
    const tall = bar(c, 1, 2) as Mesh<BufferGeometry & { parameters: { height: number } }>
    expect(tall.geometry.parameters.height).toBeCloseTo(Z_MAX, 6); expect(tall.scale.z).toBeCloseTo(1, 6)
    const zero = bar(c, 0, 0)
    expect(zero.visible).toBe(false); expect(zero.scale.z).toBeGreaterThanOrEqual(1e-4)
    expect(c.update(1 / 60, ctx3())).toBe(false)
    const capped = make({ values: [[0, 2, 4], [1, 3, 20]] }); run(capped, 3)
    expect(top(capped, 1, 2)).toBeCloseTo(Z_MAX, 3)
  })
  it('grows in diagonally: cell (r, c) starts (r + c) × 25 ms after cell (0, 0)', () => {
    const c = make(full(2, 3)); c.update(0, ctx3())
    for (const m of c.bars) expect(m.visible).toBe(false)
    expect(MATRIX.stagger).toBe(0.025)
    c.update(1 / 60, ctx3())                                                    // 17 ms: only (0, 0) has started
    expect(top(c, 0, 0)).toBeGreaterThan(0); expect(bar(c, 0, 1).visible).toBe(false); expect(bar(c, 1, 0).visible).toBe(false)
    c.update(1 / 60, ctx3())                                                    // 33 ms: (0, 1) and (1, 0), together
    expect(top(c, 0, 1)).toBeGreaterThan(0); expect(top(c, 0, 1)).toBeCloseTo(top(c, 1, 0), 9)
    expect(top(c, 0, 1)).toBeLessThan(top(c, 0, 0))
    expect(bar(c, 0, 2).visible).toBe(false); expect(bar(c, 1, 1).visible).toBe(false)
    c.update(1 / 60, ctx3()); c.update(1 / 60, ctx3())                          // 67 ms: (0, 2) and (1, 1); (1, 2) waits for 75 ms
    expect(top(c, 0, 2)).toBeGreaterThan(0); expect(top(c, 0, 2)).toBeCloseTo(top(c, 1, 1), 9); expect(bar(c, 1, 2).visible).toBe(false)
    c.update(1 / 60, ctx3()); expect(top(c, 1, 2)).toBeGreaterThan(0)
    run(c, 3); for (const m of c.bars) expect(boxOf(m).max.z).toBeCloseTo(Z_MAX, 3)
  })
  it('colours each bar from colors (sRGB, alpha ignored); a new set recolours it', () => {
    const c = make(); run(c, 1)
    for (let r = 0; r < 2; r++) for (let k = 0; k < 3; k++) expectColor(colorOf(bar(c, r, k)), linear(COLORS[r]![k]!))
    const next = COLORS.map(row => row.map((): RGBA => [0.1, 0.2, 0.9, 0.3]))
    c.set(data({ colors: next })); c.update(1 / 60, ctx3())
    expectColor(colorOf(bar(c, 1, 1)), linear([0.1, 0.2, 0.9, 1]))
  })
  it('a real ray onto a bar hits that bar, its userData naming its cell; the plate and labels let the pointer through', () => {
    const c = make({ values: [[8, 6, 4], [1, 2, 3]] }); c.labels(LABELS); run(c, 3); c.updateMatrixWorld(true)
    for (let r = 0; r < 2; r++) for (let k = 0; k < 3; k++) {
      const m = bar(c, r, k), b = boxOf(m), at = new Vector3((b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, b.max.z).applyMatrix4(c.inner.matrix)
      const hit = new Raycaster(at.clone().add(new Vector3(0, 0, 2000)), new Vector3(0, 0, -1)).intersectObject(c, true)[0]!
      expect(hit.object).toBe(m); expect(hit.object.userData).toEqual({ row: r, col: k })
    }
    const hits = new Set<Object3D>()
    for (const o of drawables(c)) {
      o.geometry.computeBoundingSphere()
      const centre = o.geometry.boundingSphere!.center.clone().applyMatrix4(o.matrixWorld)
      for (const h of new Raycaster(centre.clone().add(new Vector3(0, 0, 2000)), new Vector3(0, 0, -1)).intersectObject(c, true)) hits.add(h.object)
    }
    expect([...hits].every(o => c.bars.includes(o as Mesh))).toBe(true)
  })
  it('hover springs the bar brighter (× 1.2) and taller (× 1.08); another hover or null springs it back', () => {
    const c = make(); run(c, 3)
    expect([MATRIX.hoverBrightness, MATRIX.hoverDepth]).toEqual([1.2, 1.08])
    c.hover({ row: 1, col: 2 }); c.update(1 / 60, ctx3())
    const k = colorOf(bar(c, 1, 2)).r / linear(COLORS[1]![2]!).r
    expect(k).toBeGreaterThan(1); expect(k).toBeLessThan(1.2)                   // a spring, not a jump
    run(c, 3)
    expectColor(colorOf(bar(c, 1, 2)), linear(COLORS[1]![2]!), 1.2); expect(top(c, 1, 2)).toBeCloseTo(Z_MAX * 1.08, 3)
    expectColor(colorOf(bar(c, 0, 1)), linear(COLORS[0]![1]!)); expect(top(c, 0, 1)).toBeCloseTo(2 / 8 * Z_MAX, 3)
    c.hover({ row: 0, col: 1 }); run(c, 3)
    expect(top(c, 0, 1)).toBeCloseTo(2 / 8 * Z_MAX * 1.08, 3); expect(top(c, 1, 2)).toBeCloseTo(Z_MAX, 3)
    expectColor(colorOf(bar(c, 1, 2)), linear(COLORS[1]![2]!))
    c.hover({ row: 5, col: 0 }); run(c, 3)                                       // not a cell of the data: none
    expect(top(c, 0, 1)).toBeCloseTo(2 / 8 * Z_MAX, 3)
    c.hover({ row: 0, col: 2 }); run(c, 3); c.hover(null); run(c, 3)
    for (let r = 0; r < 2; r++) for (let j = 0; j < 3; j++) expectColor(colorOf(bar(c, r, j)), linear(COLORS[r]![j]!))
    expect(top(c, 0, 2)).toBeCloseTo(4 / 8 * Z_MAX, 3)
  })
  it('reduced motion stands every bar at once (no stagger) and hovers at once', () => {
    const c = make()
    expect(c.update(1 / 60, ctx3({ reducedMotion: true }))).toBe(false)
    expect(top(c, 1, 2)).toBeCloseTo(Z_MAX, 6); expect(top(c, 0, 1)).toBeCloseTo(2 / 8 * Z_MAX, 6)
    c.hover({ row: 0, col: 2 })
    expect(c.update(1 / 60, ctx3({ reducedMotion: true }))).toBe(false)
    expect(top(c, 0, 2)).toBeCloseTo(4 / 8 * Z_MAX * 1.08, 6); expectColor(colorOf(bar(c, 0, 2)), linear(COLORS[0]![2]!), 1.2)
  })
  it('a later set springs from the current heights (no stagger), rebuilding a bar at its new height; a reshaped one grows in anew', () => {
    const c = make(); run(c, 3)
    const was = bar(c, 1, 2).geometry
    c.set(data({ values: [[0, 2, 4], [1, 3, 4]] })); c.update(1 / 60, ctx3())
    expect(bar(c, 1, 2).geometry).not.toBe(was)
    const z = top(c, 1, 2)
    expect(z).toBeLessThan(Z_MAX); expect(z).toBeGreaterThan(Z_MAX / 2 + 1)    // on its way down, not jumped
    run(c, 3); expect(top(c, 1, 2)).toBeCloseTo(Z_MAX / 2, 3); expect(bar(c, 1, 2).scale.z).toBeCloseTo(1, 6)
    c.set(data({ values: [[1, 2]], colors: [[COLORS[0]![0]!, COLORS[0]![1]!]] })); c.update(0, ctx3())
    expect(c.bars.length).toBe(2); expect(c.bars.every(m => !m.visible)).toBe(true)
    c.update(1 / 60, ctx3()); expect(top(c, 0, 0, 2)).toBeGreaterThan(0); expect(bar(c, 0, 1, 2).visible).toBe(false)
  })
  it('tilts and seats like SurfaceChart: the same tilt, nothing below the plate, the lowest point just on the glass, centred', () => {
    const c = make(full(2, 3)); c.labels(LABELS); run(c, 3)
    expect(c.inner.rotation.x).toBe(FRAME.tilt); expect(c.inner.rotation.x).toBe(new SurfaceChart({ createCanvas: napi }).inner.rotation.x)
    c.updateMatrixWorld(true)
    const all = new Box3().setFromObject(c.inner, true)
    expect(all.min.z).toBeGreaterThanOrEqual(0); expect(all.min.z).toBeLessThan(FRAME.seat + 1)
    expect(Math.abs(all.min.y + all.max.y) / 2).toBeLessThan(20)
    expect(Math.abs(all.min.x + all.max.x) / 2).toBeLessThan(1)
    expect(all.max.y - all.min.y).toBeLessThan(280)
    // a height rises toward the viewer and up
    const b = boxOf(bar(c, 1, 1)), foot = new Vector3(0, -56, 0).applyMatrix4(c.inner.matrix), head = new Vector3(0, -56, b.max.z).applyMatrix4(c.inner.matrix)
    expect(head.z).toBeGreaterThan(foot.z + 1); expect(head.y).toBeGreaterThan(foot.y + 1)
  })
  it('labels lie on the plate in the surface\'s style: columns under the front edge, rows left of the grid, secondaryLabel', () => {
    const c = make(); c.labels(LABELS); run(c, 1)
    const { rows, cols } = c.labelPlanes
    expect([rows.length, cols.length]).toEqual([2, 3])
    cols.forEach((m, k) => {
      expect(m.position.x).toBeCloseTo(-160 + k * 160, 6); expect(m.position.y).toBeLessThan(-112); expect(m.position.z).toBe(FRAME.label.lift)
      expect(m.rotation.x).toBe(0); expect(m.userData.text).toBe(LABELS.cols[k])
    })
    rows.forEach((m, r) => { expect(m.position.x).toBeLessThan(-240); expect(m.position.y).toBeCloseTo(r === 0 ? 56 : -56, 6); expect(m.userData.text).toBe(LABELS.rows[r]) })
    for (const m of [...rows, ...cols]) expect(m.geometry.parameters.height).toBeCloseTo(textPlaneHeight(FRAME.label.size), 6)
    const want = linear(resolveColor('secondaryLabel', defaultTheme, 'light')), got = (cols[0]!.material as MeshBasicNodeMaterial).color
    expect(got.r).toBeCloseTo(want.r, 5); expect(got.g).toBeCloseTo(want.g, 5)
    // the plate holds them; a dark scheme recolours them and the plate
    const plate = new Box3().setFromBufferAttribute(c.plate.geometry.getAttribute('position') as never)
    for (const m of [...rows, ...cols]) {
      m.geometry.computeBoundingBox(); const b = m.geometry.boundingBox!.clone().translate(m.position)
      expect(b.min.x).toBeGreaterThanOrEqual(plate.min.x - 1e-6); expect(b.min.y).toBeGreaterThanOrEqual(plate.min.y - 1e-6)
    }
    run(c, 1 / 60, { scheme: 'dark' })
    const dark = linear(resolveColor('secondaryLabel', defaultTheme, 'dark')), fill = linear(resolveColor('fill', defaultTheme, 'dark'))
    expect((rows[1]!.material as MeshBasicNodeMaterial).color.r).toBeCloseTo(dark.r, 5)
    expect((c.plate.material as MeshStandardNodeMaterial).color.r).toBeCloseTo(fill.r, 5)
  })
  it('column labels too close for their cells are thinned to every n-th, the first shown', () => {
    const cols = Array.from({ length: 24 }, (_, k) => `品类 ${k}`)
    const c = make(full(2, 24)); c.labels({ rows: ['A', 'B'], cols }); run(c, 1)
    const shown = c.labelPlanes.cols.filter(m => m.visible)
    expect(shown.length).toBeLessThan(24); expect(shown.length).toBeGreaterThan(1); expect(shown[0]).toBe(c.labelPlanes.cols[0])
    for (let k = 1; k < shown.length; k++) expect(shown[k]!.position.x - shown[k - 1]!.position.x).toBeGreaterThanOrEqual((shown[k]!.userData.ink as number) / 2 + (shown[k - 1]!.userData.ink as number) / 2)
  })
  it('only the bars cast shadows; draw order: the plate, the labels, then the bars', () => {
    const c = make(); c.labels(LABELS); run(c, 1)
    for (const o of drawables(c)) expect(o.userData.noShadow === true, o.name).toBe(!c.bars.includes(o as Mesh))
    const order = [c.plate, c.labelPlanes.cols[0]!, c.bars[0]!].map(o => o.renderOrder)
    expect([...order].sort((a, b) => a - b)).toEqual(order); expect(new Set(order).size).toBe(3)
  })
  it('riseFor bounds how far the seated matrix rises off the glass, labels, plate and a hovered front bar included, at any size', () => {
    for (const [W, H] of [[640, 280], [300, 400], [500, 60], [80, 60], [1000, 120], [240, 240]] as const) {
      const c = make({ ...full(6, 4, 150), max: 150 })
      c.labels({ rows: ['A 区', 'B 区', 'C 区', 'D 区', 'E 区', 'F 区'], cols: ['日化', '食品', '家电', '服装'] }); c.hover({ row: 5, col: 1 })
      run(c, 3, { width: W, height: H }); c.updateMatrixWorld(true)
      const reach = new Box3().setFromObject(c, true).max.z, rise = c.riseFor(W, H)
      expect(reach, `${W} × ${H}`).toBeLessThanOrEqual(rise)
      expect(rise).toBeLessThanOrEqual(c.riseFor(H, H))
      expect(c.riseFor(W * 3, H)).toBe(c.riseFor(Math.max(W, H), H))
      const bare = make({ values: [[0, 1], [2, 3]], colors: full(2, 2).colors, max: 3 }); run(bare, 3, { width: W, height: H }); bare.updateMatrixWorld(true)
      expect(new Box3().setFromObject(bare, true).max.z).toBeLessThanOrEqual(bare.riseFor(W, H))
    }
    // with many thin rows the bound is close (it holds for any number of rows)
    const many = make({ ...full(40, 4, 8) }); many.labels({ rows: ['A', 'B'], cols: ['a', 'b', 'c', 'd'] }); many.hover({ row: 39, col: 0 })
    run(many, 3, { width: 640, height: 280 }); many.updateMatrixWorld(true)
    const reach = new Box3().setFromObject(many, true).max.z
    expect(many.riseFor(640, 280) - reach).toBeLessThan(5); expect(reach).toBeLessThanOrEqual(many.riseFor(640, 280))
  })
  it('rejects bad data, changing nothing', () => {
    const c = make()
    expect(() => c.set(data({ max: 0 }))).toThrow(/\[BarMatrix\.set\].*max/)
    expect(() => c.set(data({ max: Infinity }))).toThrow(/\[BarMatrix\.set\].*max/)
    expect(() => c.set(data({ values: [], colors: [] }))).toThrow(/\[BarMatrix\.set\].*1 × 1/)
    expect(() => c.set(data({ values: [[]], colors: [[]] }))).toThrow(/\[BarMatrix\.set\].*1 × 1/)
    expect(() => c.set(data({ values: [[1, 2, 3], [4, 5]] }))).toThrow(/\[BarMatrix\.set\].*第 2 行/)
    expect(() => c.set(data({ values: [[1, 2, 3], [4, 5, -1]] }))).toThrow(/\[BarMatrix\.set\].*values\[1\]\[2\]/)
    expect(() => c.set(data({ values: [[1, 2, 3], [4, 5, NaN]] }))).toThrow(/\[BarMatrix\.set\].*values\[1\]\[2\]/)
    expect(() => c.set(data({ colors: [COLORS[0]!] }))).toThrow(/\[BarMatrix\.set\].*colors/)
    expect(() => c.set(data({ colors: [COLORS[0]!, COLORS[1]!.slice(0, 2)] }))).toThrow(/\[BarMatrix\.set\].*colors/)
    run(c, 3); expect(top(c, 1, 2)).toBeCloseTo(Z_MAX, 3); expect(c.bars.length).toBe(6)
  })
  it('dispose frees every geometry, material and label texture and empties the matrix; a set after it grows in again', () => {
    const c = make(); c.labels(LABELS); c.hover({ row: 0, col: 1 }); run(c, 1)
    const spies: ReturnType<typeof vi.spyOn>[] = [], seen = new Set<object>()
    const spy = (o: { dispose(): void } | null | undefined): void => { if (o && !seen.has(o)) { seen.add(o); spies.push(vi.spyOn(o, 'dispose')) } }
    const textures: Texture[] = []
    for (const o of drawables(c)) {
      spy(o.geometry as BufferGeometry); spy(o.material as Material)
      const t = (o.material as MeshBasicNodeMaterial).alphaMap; if (t) { textures.push(t); spy(t) }
    }
    expect(textures.length).toBe(2 + 3); expect(spies.length).toBe((6 + 1 + 5) * 2 + 5)
    c.dispose()
    for (const s of spies) expect(s).toHaveBeenCalled()
    expect(drawables(c)).toEqual([]); expect(c.bars).toEqual([])
    expect(c.update(1 / 60, ctx3())).toBe(false)
    c.set(data()); c.update(0, ctx3())
    expect(c.bars.length).toBe(6); expect(bar(c, 1, 2).visible).toBe(false)
    c.update(1 / 60, ctx3()); expect(bar(c, 0, 1).visible).toBe(false)          // staggered again
    run(c, 3); expect(top(c, 1, 2)).toBeCloseTo(Z_MAX, 3)
  })
  it('builds its bar, plate and label materials on both backends without warnings (the bar\'s shadow pass too)', () => {
    const c = make(); c.labels(LABELS); run(c, 1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const forceWebGL of [false, true]) {
        for (const m of [bar(c, 1, 2), c.plate, c.labelPlanes.rows[0]!]) expect(buildShaders(m.material as NodeMaterial, m.geometry, forceWebGL).fragment.length).toBeGreaterThan(0)
        expect(buildShaders(bar(c, 1, 2).material as NodeMaterial, bar(c, 1, 2).geometry, forceWebGL, true).fragment.length).toBeGreaterThan(0)
      }
      expect(warn).not.toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })
})
