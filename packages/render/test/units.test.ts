import { describe, it, expect } from 'vitest'
import { ptToUnits, surfaceToLocal, localToSurface } from '../src/units'

describe('units', () => {
  const s = { width: 400, height: 300, ptPerUnit: 100 }
  it('pt to units', () => { expect(ptToUnits(244, 244)).toBe(1); expect(ptToUnits(50, 100)).toBe(0.5) })
  it('surface pt (y down) to local units (centred, y up) and back', () => {
    expect(surfaceToLocal(0, 0, s)).toEqual([-2, 1.5])
    expect(surfaceToLocal(400, 300, s)).toEqual([2, -1.5])
    expect(surfaceToLocal(200, 150, s)).toEqual([0, 0])
    expect(localToSurface(-2, 1.5, s)).toEqual([0, 0])
  })
})
