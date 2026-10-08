import { describe, it, expect } from 'vitest'
import { Vector3 } from 'three'
import { IDENTITY, scaleAbout, multiply } from '@glassui/core'
import { instanceMatrix } from '../src/transform'

const s = { width: 400, height: 300, ptPerUnit: 100 }
const base = { elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1 }
const rect = { x: 10, y: 10, width: 100, height: 40 }
const map = (m: ReturnType<typeof instanceMatrix>, x: number, y: number, z: number) => new Vector3(x, y, z).applyMatrix4(m).toArray().map(v => +v.toFixed(9))

describe('instanceMatrix', () => {
  it('places the local origin at the rect centre in surface-local units (y up)', () => {
    const m = instanceMatrix({ rect, ...base }, s)
    expect(map(m, 0, 0, 0)).toEqual([-1.4, 1.2, 0])       // centre (60,30)pt → ((60−200)/100, (150−30)/100)
    expect(map(m, 1, 0, 0)).toEqual([-0.4, 1.2, 0])
    expect(map(m, 0, 1, 0)).toEqual([-1.4, 2.2, 0])
  })
  it('elevation lifts along +z in units', () => {
    expect(map(instanceMatrix({ rect, ...base, elevation: 50 }, s), 0, 0, 0.1)).toEqual([-1.4, 1.2, 0.6])
  })
  it('a composed scale about the node centre scales x, y and thickness', () => {
    const t = scaleAbout(60, 30, 0.5)
    const m = instanceMatrix({ rect, ...base, scale: 0.5, transform: t }, s)
    expect(map(m, 0, 0, 0)).toEqual([-1.4, 1.2, 0])
    expect(map(m, 1, 0, 0)).toEqual([-0.9, 1.2, 0])
    expect(map(m, 0, 0, 1)).toEqual([-1.4, 1.2, 0.5])
  })
  it('a parent scale about another pivot moves the centre', () => {
    const t = multiply(scaleAbout(0, 0, 0.5), IDENTITY)
    const m = instanceMatrix({ rect, ...base, scale: 0.5, transform: t }, s)
    // centre (60,30) → (30,15)pt → ((30−200)/100, (150−15)/100)
    expect(map(m, 0, 0, 0)).toEqual([-1.7, 1.35, 0])
  })
  it('tilt rotates about the transformed centre', () => {
    const m = instanceMatrix({ rect, ...base, tilt: { x: Math.PI / 2, y: 0 } }, s)
    expect(map(m, 0, 0, 0)).toEqual([-1.4, 1.2, 0])
    const p = map(m, 0, 1, 0)                             // +y rotates toward +z about x
    expect(p[0]).toBeCloseTo(-1.4, 6); expect(p[1]).toBeCloseTo(1.2, 6); expect(p[2]).toBeCloseTo(1, 6)
  })
})
