import { describe, it, expect } from 'vitest'
import { InstancedBufferGeometry, Matrix3, Vector3 } from 'three'
import { Node, IDENTITY, scaleAbout, type GlassInstance, type ResolvedGlass } from '@glassui/core'
import { GlassBatch, GLASS_ATTRS } from '../src/glass/batch'
import { slabVertex } from '../src/glass/vertex'
import { createSlabBaseGeometry, evalSlabVertex, type SlabInstanceParams } from '../src/glass/slab9'
import { instanceMatrix } from '../src/transform'
import { srgbToLinear } from '../src/color'
import { evalNode } from './fixtures/tsl-eval'

const s = { width: 400, height: 300, ptPerUnit: 100 }
const params: ResolvedGlass = { thickness: 8, fillet: 2.4, filletBottom: 1.6, profile: 'fillet', scatter: 0.05, lift: 0.1, edgeGlow: 0.8, ior: 1.5, dispersion: 0.8, roughness: 0.06, tint: null, absorption: 0, glow: { color: [0.42, 0.39, 0.96, 1], strength: 1.1, split: 0.6 }, cornerExponent: 2, envIntensity: 1, specularIntensity: 1, innerGlow: 0, adaptive: true, variant: 'regular' }
function inst(id: string, z: number, extra: Partial<GlassInstance> = {}): GlassInstance {
  return { node: new Node('glass', id), rect: { x: 10, y: 10, width: 100, height: 40 }, radius: 20, z, params, elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1, ...extra }
}
/** Instance attributes are float32: the expected value of a stored number is its float32 rounding. */
const f32 = (v: number[]) => v.map(Math.fround)

describe('GlassBatch', () => {
  it('packs instances sorted by z with units, linear colours and matrices', () => {
    const b = new GlassBatch()
    b.update([inst('b', 2), inst('a', 1)], s)
    expect(b.buffer.count).toBe(2)
    expect(b.nodes[0]!.id).toBe('a'); expect(b.indexOf(b.nodes[1]!)).toBe(1)
    expect(b.buffer.get(0, 'iRect')).toEqual(f32([-1.4, 1.2, 1, 0.4]))
    expect(b.buffer.get(0, 'iShape')).toEqual(f32([0.2, 0.08, 0.024, 0.016]))
    expect(b.buffer.get(0, 'iCorner').slice(0, 2)).toEqual([2, 0])
    expect(b.buffer.get(0, 'iGlow')).toEqual(f32([srgbToLinear(0.42), srgbToLinear(0.39), srgbToLinear(0.96), 1.1]))
    expect(b.buffer.get(0, 'iGlow2')).toEqual(f32([0.6, 0.04, 1, -1]))   // regular variant: no adaptive darkening (luma index −1)
    expect(b.buffer.get(0, 'iTint')).toEqual([1, 1, 1, 0])
    expect(b.buffer.get(0, 'iMat0')).toEqual(f32([1, 0, 0, -1.4])); expect(b.buffer.get(0, 'iMat1')).toEqual(f32([0, 1, 0, 1.2]))
    expect(b.buffer.get(0, 'iClipRect')[2]).toBe(-1)
    expect(b.geometry.instanceCount).toBe(2)
    expect(GLASS_ATTRS).toHaveLength(14)
  })
  it('clear + adaptive glass gets its batch index as luma index', () => {
    const b = new GlassBatch()
    b.update([inst('b', 2), inst('a', 1, { params: { ...params, variant: 'clear', adaptive: true } })], s)
    expect(b.buffer.get(0, 'iGlow2')[3]).toBe(0); expect(b.buffer.get(1, 'iGlow2')[3]).toBe(-1)
  })
  it('writes clip rect and inverse transform', () => {
    const b = new GlassBatch()
    b.update([inst('a', 1, { clip: { x: 0, y: 0, width: 200, height: 100, radius: 12, transform: scaleAbout(100, 50, 0.5) } })], s)
    expect(b.buffer.get(0, 'iClipRect')).toEqual([0, 0, 200, 100])
    expect(b.buffer.get(0, 'iClipInv')).toEqual([2, 0, 0, 2])          // inverse of scale .5 about (100,50)
    expect(b.buffer.get(0, 'iClipT')).toEqual([-100, -50, 12, 0])
  })
  it('carries touch state and grows with the list', () => {
    const b = new GlassBatch()
    const list = Array.from({ length: 40 }, (_, i) => inst(`g${i}`, i))
    const touch = new Map([[list[3]!.node, { u: 0.1, v: -0.2, press: 0.5 }]])
    b.update(list, s, touch)
    expect(b.buffer.count).toBe(40)
    expect(b.buffer.get(3, 'iTouch')).toEqual(f32([0.1, -0.2, 0.5, 0.2]))
    expect(b.buffer.get(4, 'iTouch')).toEqual(f32([0, 0, 0, 0.2]))
  })
})

describe('slabVertex', () => {
  it('builds position/normal/local nodes from a populated batch geometry', () => {
    const b = new GlassBatch()
    b.update([inst('a', 1)], s)
    const v = slabVertex(b.geometry, b.K)
    expect(v.position).toBeTruthy(); expect(v.normal).toBeTruthy(); expect(v.local).toBeTruthy(); expect(v.slabLocal).toBeTruthy()
  })
  it('matches evalSlabVertex at every base vertex (fillet, flat-bottom squircle, lens)', () => {
    const K = 10, S = 10
    const shapes: SlabInstanceParams[] = [
      { width: 3.11, height: 0.344, radius: 0.172, thickness: 0.0656, fillet: 0.0205, filletBottom: 0.0123, cornerExponent: 2, profile: 0 },
      { width: 2, height: 1, radius: 0.2, thickness: 0.1, fillet: 0.03, filletBottom: 0, cornerExponent: 4.5, profile: 0 },
      { width: 2, height: 1, radius: 0.3, thickness: 0.12, fillet: 0.03, filletBottom: 0.01, cornerExponent: 4.5, profile: 1 },
    ]
    const b = new GlassBatch(K, S)
    const v = slabVertex(b.geometry, K)
    const slab = b.geometry.getAttribute('slab')
    for (const p of shapes) {
      let worst = 0
      for (let i = 0; i < slab.count; i++) {
        const vert = { ax: slab.getX(i), ay: slab.getY(i), angle: slab.getZ(i), ring: slab.getW(i) }
        const cpu = evalSlabVertex(vert, p, K)
        const attrs = {
          slab: [vert.ax, vert.ay, vert.angle, vert.ring], iRect: [0, 0, p.width, p.height], iShape: [p.radius, p.thickness, p.fillet, p.filletBottom],
          iCorner: [p.cornerExponent, p.profile, 0, 0], iMat0: [1, 0, 0, 0], iMat1: [0, 1, 0, 0], iMat2: [0, 0, 1, 0],
        }
        const pos = evalNode(v.slabLocal, attrs), nrm = evalNode(v.normal, attrs), local = evalNode(v.local, attrs)
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(pos[k]! - cpu.position[k]!), Math.abs(local[k]! - cpu.position[k]!), Math.abs(nrm[k]! - cpu.normal[k]!))
      }
      expect(worst).toBeLessThan(1e-12)
    }
  })
  it('places and orients the slab with the packed instance attributes and matrix rows', () => {
    const K = 8
    const b = new GlassBatch(K, 8)
    const g = inst('a', 1, { rect: { x: 40, y: 60, width: 160, height: 64 }, radius: 18, elevation: 12, scale: 0.8, transform: scaleAbout(120, 92, 0.8), tilt: { x: 0.3, y: -0.2 }, params: { ...params, cornerExponent: 4.5 } })
    b.update([g], s)
    const v = slabVertex(b.geometry, K)
    // the same instance in units, built from the GlassInstance (not from the packing) so a mis-packed field shows up
    const p: SlabInstanceParams = { width: 1.6, height: 0.64, radius: 0.18, thickness: 0.08, fillet: 0.024, filletBottom: 0.016, cornerExponent: 4.5, profile: 0 }
    const m = instanceMatrix(g, s), m3 = new Matrix3().setFromMatrix4(m)
    const packed = Object.fromEntries(GLASS_ATTRS.map(name => [name, b.buffer.get(0, name)]))
    const slab = b.geometry.getAttribute('slab')
    let worst = 0
    for (let i = 0; i < slab.count; i++) {
      const vert = { ax: slab.getX(i), ay: slab.getY(i), angle: slab.getZ(i), ring: slab.getW(i) }
      const cpu = evalSlabVertex(vert, p, K)
      const wantPos = new Vector3(...cpu.position).applyMatrix4(m), wantN = new Vector3(...cpu.normal).applyMatrix3(m3).normalize()
      const attrs = { ...packed, slab: [vert.ax, vert.ay, vert.angle, vert.ring] }
      const pos = evalNode(v.position, attrs), nrm = evalNode(v.normal, attrs)
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(pos[k]! - wantPos.getComponent(k)), Math.abs(nrm[k]! - wantN.getComponent(k)))
    }
    expect(worst).toBeLessThan(1e-5)   // float32 packing
  })
  it('rejects a geometry without the slab and instance attributes, or laid out for another K', () => {
    expect(() => slabVertex(new InstancedBufferGeometry(), 8)).toThrow(/slab/)
    expect(() => slabVertex(createSlabBaseGeometry(8, 8), 8)).toThrow(/iRect/)
    const b = new GlassBatch(6, 8)
    expect(b.K).toBe(6)
    expect(() => slabVertex(b.geometry, 8)).toThrow(/K/)
  })
})
