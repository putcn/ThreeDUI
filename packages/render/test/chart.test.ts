import { describe, it, expect, vi } from 'vitest'
import { Raycaster, Vector3, type Mesh } from 'three'
import type { MeshStandardNodeMaterial } from 'three/webgpu'
import { defaultTheme, type RGBA } from '@glassui/core'
import { BarChart, barLayout } from '../src/chart/bar'
import type { Viewport3DContext } from '../src/viewport'

const ctx3 = (o: Partial<Viewport3DContext> = {}): Viewport3DContext => ({ width: 400, height: 200, reducedMotion: false, theme: defaultTheme, scheme: 'light', ...o })
const accent: RGBA = [0.42, 0.39, 0.96, 1]
const run = (c: BarChart, s: number, o?: Partial<Viewport3DContext>) => { for (let t = 0; t < s; t += 1 / 60) c.update(1 / 60, ctx3(o)) }
const shown = (m: Mesh) => { m.geometry.computeBoundingBox(); return (m.geometry.boundingBox!.max.y - m.geometry.boundingBox!.min.y) * m.scale.y }

describe('the bar chart (spatial spec §2.5)', () => {
  it('barLayout: equal columns, bars 0.6 of a column, heights to scale', () => {
    expect(barLayout(4, 400, 200, [10, 20, 0, 40], 40)).toEqual([
      { x: -150, width: 60, height: 50 }, { x: -50, width: 60, height: 100 }, { x: 50, width: 60, height: 0 }, { x: 150, width: 60, height: 200 },
    ])
  })
  it('bars grow from the plate, staggered, and stand at their heights', () => {
    const c = new BarChart(); c.set({ values: [10, 20, 40], colors: [accent, accent, accent], max: 40 })
    c.update(0, ctx3()); expect(c.bars.length).toBe(3); expect(c.bars.map(b => b.userData.index)).toEqual([0, 1, 2])
    expect(shown(c.bars[0] as Mesh)).toBeLessThan(0.01)
    run(c, 0.05); expect(shown(c.bars[0] as Mesh)).toBeGreaterThan(shown(c.bars[1] as Mesh))
    run(c, 3)
    expect(c.bars.map(b => +shown(b as Mesh).toFixed(3))).toEqual([50, 100, 200])
    expect(c.bars.map(b => (b as Mesh).scale.y)).toEqual([1, 1, 1]); expect((c.bars[0] as Mesh).position.y).toBe(-100)
    expect(c.update(1 / 60, ctx3())).toBe(false)
  })
  it('reduced motion stands the bars at once', () => {
    const c = new BarChart(); c.set({ values: [10], colors: [accent], max: 10 }); c.update(1 / 60, ctx3({ reducedMotion: true }))
    expect(shown(c.bars[0] as Mesh)).toBeCloseTo(200)
  })
  it('a later set animates from the current heights; an added bar grows from 0', () => {
    const c = new BarChart(); c.set({ values: [10], colors: [accent], max: 10 }); run(c, 3)
    c.set({ values: [5, 10], colors: [accent, accent], max: 10 }); c.update(1 / 60, ctx3())
    expect(shown(c.bars[0] as Mesh)).toBeGreaterThan(100); expect(shown(c.bars[0] as Mesh)).toBeLessThan(200)
    expect(shown(c.bars[1] as Mesh)).toBeLessThan(20)
  })
  it('hover brightens and thickens one bar, and lets go', () => {
    const c = new BarChart(); c.set({ values: [1, 1], colors: [accent, accent], max: 1 }); run(c, 3)
    const base = ((c.bars[1] as Mesh).material as MeshStandardNodeMaterial).color.clone()
    c.hover(1); run(c, 2)
    expect(((c.bars[1] as Mesh).material as MeshStandardNodeMaterial).color.r).toBeCloseTo(base.r * 1.2); expect((c.bars[1] as Mesh).scale.z).toBeCloseTo(1.15)
    c.hover(null); run(c, 2); expect((c.bars[1] as Mesh).scale.z).toBeCloseTo(1)
  })
  it('re-lays out on a new box size and rejects bad data', () => {
    const c = new BarChart(); c.set({ values: [1, 1], colors: [accent, accent], max: 1 }); run(c, 3)
    run(c, 1 / 60, { width: 600 }); expect((c.bars[1] as Mesh).position.x).toBeCloseTo(150)
    expect(() => c.set({ values: [1], colors: [accent], max: 0 })).toThrow(/\[BarChart\.set\].*max/)
    expect(() => c.set({ values: [-1], colors: [accent], max: 1 })).toThrow(/\[BarChart\.set\]/)
    expect(() => c.set({ values: [1, 2], colors: [accent], max: 2 })).toThrow(/colors/)
  })
  it('a fewer-bar set disposes the extra bars; a bar at 0 is hidden, its matrix still invertible', () => {
    const c = new BarChart(); c.set({ values: [1, 1, 1], colors: [accent, accent, accent], max: 1 }); run(c, 3)
    const third = c.bars[2] as Mesh, g = vi.spyOn(third.geometry, 'dispose'), m = vi.spyOn(third.material as MeshStandardNodeMaterial, 'dispose')
    c.set({ values: [1, 0], colors: [accent, accent], max: 1 })
    expect(g).toHaveBeenCalled(); expect(m).toHaveBeenCalled(); expect(third.parent).toBeNull()
    expect(c.bars.map(b => b.name)).toEqual(['bar-0', 'bar-1']); expect(c.children.length).toBe(2)
    run(c, 3)
    const zero = c.bars[1] as Mesh
    expect(zero.visible).toBe(false); zero.updateMatrixWorld(); expect(zero.matrixWorld.determinant()).not.toBe(0)
  })
  it('a ray from the front hits the bar it points at', () => {
    const c = new BarChart(); c.set({ values: [1, 0.5], colors: [accent, accent], max: 1 }); run(c, 3); c.updateMatrixWorld()
    const hit = (x: number, y: number) => new Raycaster(new Vector3(x, y, 100), new Vector3(0, 0, -1)).intersectObject(c, true)[0]?.object.userData.index
    expect(hit(-100, 50)).toBe(0); expect(hit(100, -50)).toBe(1)
    expect(hit(100, 50)).toBeUndefined()    // above bar 1 (half the box high)
    expect(hit(0, 0)).toBeUndefined()       // between the columns' bars
  })
  it('dispose frees every bar', () => {
    const c = new BarChart(); c.set({ values: [1], colors: [accent], max: 1 }); c.update(1 / 60, ctx3())
    const g = vi.spyOn((c.bars[0] as Mesh).geometry, 'dispose'); c.dispose()
    expect(g).toHaveBeenCalled(); expect(c.bars.length).toBe(0)
  })
})
