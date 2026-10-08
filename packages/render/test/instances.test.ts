import { describe, it, expect } from 'vitest'
import { InstancedBufferGeometry } from 'three'
import { InstanceBuffer } from '../src/instances'

describe('InstanceBuffer', () => {
  it('packs vec4 attributes and sets instanceCount on commit', () => {
    const b = new InstanceBuffer(new InstancedBufferGeometry(), ['iRect', 'iColor'], 2)
    b.begin(2)
    b.set(0, 'iRect', 1, 2, 3, 4); b.set(1, 'iColor', 0.5, 0.5, 0.5, 1)
    b.commit()
    expect(b.geometry.instanceCount).toBe(2)
    expect(b.get(0, 'iRect')).toEqual([1, 2, 3, 4]); expect(b.get(1, 'iColor')).toEqual([0.5, 0.5, 0.5, 1])
    expect(b.geometry.getAttribute('iRect').count).toBe(2)
  })
  it('grows past its capacity without losing earlier instances', () => {
    const b = new InstanceBuffer(new InstancedBufferGeometry(), ['iRect'], 2)
    b.begin(2); b.set(0, 'iRect', 9, 9, 9, 9); b.set(1, 'iRect', 8, 8, 8, 8); b.commit()
    const before = b.geometry.getAttribute('iRect')
    b.begin(300)
    for (let i = 2; i < 300; i++) b.set(i, 'iRect', i, 0, 0, 0)
    b.commit()
    expect(b.geometry.getAttribute('iRect')).not.toBe(before)
    expect(b.geometry.getAttribute('iRect').count).toBeGreaterThanOrEqual(300)
    expect(b.get(0, 'iRect')).toEqual([9, 9, 9, 9]); expect(b.get(1, 'iRect')).toEqual([8, 8, 8, 8]); expect(b.get(299, 'iRect')[0]).toBe(299)
    expect(b.geometry.instanceCount).toBe(300)
  })
  it('rejects unknown attribute names', () => {
    const b = new InstanceBuffer(new InstancedBufferGeometry(), ['iRect'])
    b.begin(1)
    expect(() => b.set(0, 'iNope', 0, 0)).toThrow(/iNope/)
  })
})
