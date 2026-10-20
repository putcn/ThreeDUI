import { it, expect } from 'vitest'
import { gridSlots } from '../src/spatial/grid'
const rotate = ([x, y, z]: number[], [a, b, c]: number[]): number[] => {
  const x1 = x! * Math.cos(c!) - y! * Math.sin(c!), y1 = x! * Math.sin(c!) + y! * Math.cos(c!)
  const x2 = x1 * Math.cos(b!) + z! * Math.sin(b!), z2 = z! * Math.cos(b!) - x1 * Math.sin(b!)
  return [x2, y1 * Math.cos(a!) - z2 * Math.sin(a!), y1 * Math.sin(a!) + z2 * Math.cos(a!)]
}
const SIZES = [[880, 1000], [1440, 1000], [1600, 1000], [1100, 900], [1280, 900], [1000, 900]].map(([w, h]) => ({ width: w! / 244, height: h! / 244 }))
it('places a 3 × 2 grid row-major on the sphere, every Block facing the centre', () => {
  const R = 24, slots = gridSlots(SIZES, 3, R, 0.4)
  for (const s of slots) {
    const [x, y, z] = s.position, d = Math.hypot(x, y, z - R)
    expect(d).toBeCloseTo(R, 6)
    const n = rotate([0, 0, 1], s.rotation), toC = [-x / R, -y / R, (R - z) / R]
    n.forEach((v, i) => expect(v).toBeCloseTo(toC[i]!, 6))
  }
  expect(slots[0]!.position[1]).toBeGreaterThan(0); expect(slots[3]!.position[1]).toBeLessThan(0)
  expect(slots[0]!.position[0]).toBeLessThan(slots[1]!.position[0]); expect(slots[1]!.position[0]).toBeLessThan(slots[2]!.position[0])
})
it('a single Block sits at the origin facing +z', () => {
  expect(gridSlots([{ width: 4, height: 3 }], 3, 24, 0.4)[0]).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0] })
})
it('columns take their widest Block and keep the gap between cells', () => {
  const s = gridSlots([{ width: 2, height: 1 }, { width: 2, height: 1 }, { width: 4, height: 1 }, { width: 2, height: 1 }], 2, 1e6, 0.5)
  expect(s[1]!.position[0] - s[0]!.position[0]).toBeCloseTo(4 / 2 + 0.5 + 2 / 2, 3)
  expect(s[0]!.position[1] - s[2]!.position[1]).toBeCloseTo(1 + 0.5, 3)
})
