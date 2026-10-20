import { describe, expect, it } from 'vitest'
import { Euler, Quaternion, Vector3 } from 'three'
import { gridSlots } from '@glassui/vue'
import { BLOCKS, GRID, inFrameOf, SLOTS } from '../src/scenes/spatial-grid'

describe('the WMS overview grid', () => {
  it('uses the same three-column grid slots as Space in the specified order', () => {
    const names = ['orders', 'dashboard', 'network', 'inbound', 'twin', 'settings'] as const
    expect(Object.keys(BLOCKS)).toEqual(names)
    expect(SLOTS).toEqual(gridSlots(names.map(name => ({ width: BLOCKS[name].width / 244, height: BLOCKS[name].height / 244 })), GRID.columns, GRID.radius, GRID.gap))
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
