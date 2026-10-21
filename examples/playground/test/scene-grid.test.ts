import { describe, expect, it } from 'vitest'
import { Euler, Quaternion, Vector3 } from 'three'
import { gridSlots } from '@glassui/vue'
import { BLOCKS, DEPTH_BY_NAME, GRID, inFrameOf, SLOTS } from '../src/scenes/spatial-grid'

describe('the WMS overview grid', () => {
  it('preserves the grid order while giving the main dashboard the nearest plane', () => {
    const names = ['orders', 'dashboard', 'network', 'twin', 'inventory', 'settings'] as const
    expect(Object.keys(BLOCKS)).toEqual(names)
    expect(GRID.gap).toBeGreaterThanOrEqual(1.5)
    const base = gridSlots(names.map(name => ({ width: BLOCKS[name].width / 244, height: BLOCKS[name].height / 244 })), GRID.columns, GRID.radius, GRID.gap)
    SLOTS.forEach((slot, i) => {
      expect(slot.rotation).toEqual(base[i]!.rotation)
      expect(slot.position[0]).toBe(base[i]!.position[0])
      expect(slot.position[1]).toBe(base[i]!.position[1])
      expect(slot.position[2]).toBeCloseTo(base[i]!.position[2] + DEPTH_BY_NAME[names[i]!])
    })
    expect(SLOTS[1]!.position[2]).toBeGreaterThan(SLOTS[0]!.position[2])
  })

  it('places panel offsets in the slot’s complete rotated frame, including pitch', () => {
    const slot = { position: [1, 2, 3] as [number, number, number], rotation: [0.4, -0.7, 0.2] as [number, number, number] }
    const offset = [1.1, -0.8, 2.05] as const
    const expected = new Vector3(...offset).applyQuaternion(new Quaternion().setFromEuler(new Euler(...slot.rotation))).add(new Vector3(...slot.position))
    const actual = inFrameOf(slot, offset)
    expect(actual.position).toEqual([expected.x, expected.y, expected.z])
    expect(actual.rotation).toEqual(slot.rotation)
  })
})
