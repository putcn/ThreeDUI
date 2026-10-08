import { describe, it, expect, vi } from 'vitest'
import { uniform, attribute } from 'three/tsl'
import { Vector2, Vector3 } from 'three'
import { Node, IDENTITY, scaleAbout, type ClipRect, type PanelInstance } from '@glassui/core'
import { superellipseSDF, sdfNode } from '../src/panel/sdf'
import { PanelBatch, PANEL_ATTRS } from '../src/panel/batch'
import { createPanelMaterial, flatVertex } from '../src/panel/material'
import { createQuadGeometry } from '../src/quad'
import { srgbToLinear } from '../src/color'
import { instanceMatrix } from '../src/transform'
import { evalNode } from './fixtures/tsl-eval'
import { buildShaders } from './fixtures/build-shaders'

/** Instance attributes are float32: the expected value of a stored number is its float32 rounding. */
const f32 = (v: number[]) => v.map(Math.fround)
const s = { width: 400, height: 300, ptPerUnit: 100 }
const su = () => ({ size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(100) })
const p: PanelInstance = { node: new Node('box'), rect: { x: 10, y: 10, width: 100, height: 40 }, radius: 12, color: [1, 0.5, 0, 0.8], border: { width: 2, color: [0, 0, 0, 1] }, z: 1, elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 0.5 }
/** Instance `i`'s packed attributes by name, as `evalNode` takes them. */
const packed = (b: PanelBatch, i = 0) => Object.fromEntries(PANEL_ATTRS.map(name => [name, b.buffer.get(i, name)]))

describe('superellipseSDF', () => {
  it('is negative inside, zero on the straight edge, positive outside', () => {
    expect(superellipseSDF(0, 0, 50, 20, 10, 4.5)).toBeLessThan(0)
    expect(superellipseSDF(50, 0, 50, 20, 10, 4.5)).toBeCloseTo(0, 9)
    expect(superellipseSDF(60, 0, 50, 20, 10, 4.5)).toBeCloseTo(10, 9)
  })
  it('a circle corner (n=2) rounds the corner, a squircle (n=4.5) keeps more of it', () => {
    // the corner point (50,20) is outside both
    expect(superellipseSDF(50, 20, 50, 20, 10, 2)).toBeGreaterThan(0)
    // (47.5, 17.5): 10.6 from the corner centre → outside the circle; its L4.5 distance is 8.75 → inside the squircle
    expect(superellipseSDF(47.5, 17.5, 50, 20, 10, 2)).toBeGreaterThan(0)
    expect(superellipseSDF(47.5, 17.5, 50, 20, 10, 4.5)).toBeLessThan(0)
  })
  it('radius 0 is a plain box', () => { expect(superellipseSDF(50, 20, 50, 20, 0, 4.5)).toBeCloseTo(0, 9) })
})

describe('sdfNode', () => {
  it('matches superellipseSDF (circle, squircle, sharp box, capsule, oversized radius) and never feeds pow a base ≤ 0', () => {
    const a = attribute('a', 'vec4'), b = attribute('b', 'vec4')   // a = (x, y, hw, hh), b = (r, n, –, –)
    const node = sdfNode(a.xy, a.zw, b.x, b.y)
    const shapes: [number, number, number, number][] = [[50, 20, 10, 2], [50, 20, 10, 4.5], [50, 20, 0, 4.5], [50, 20, 20, 2], [50, 20, 35, 4.5], [0.5, 0.2, 0.12, 4.5]]
    for (const [hw, hh, r, n] of shapes) {
      let worst = 0, minPowBase = Infinity
      const onPow = (base: readonly number[]) => { minPowBase = Math.min(minPowBase, ...base) }
      // a grid through the centre, the straight edges, the corner centres and the corners, inside and out
      for (let i = -13; i <= 13; i++) for (let j = -13; j <= 13; j++) {
        const x = (i / 10) * hw, y = (j / 10) * hh
        const got = evalNode(node, { a: [x, y, hw, hh], b: [r, n, 0, 0] }, onPow)[0]!
        worst = Math.max(worst, Math.abs(got - superellipseSDF(x, y, hw, hh, r, n)))
      }
      expect(worst).toBeLessThan(1e-12)
      if (minPowBase !== Infinity) expect(minPowBase).toBeGreaterThan(0)   // WGSL pow is exp2(y·log2 x)
    }
  })
})

describe('PanelBatch and material', () => {
  it('packs rect, shape, colours and border', () => {
    const b = new PanelBatch()
    b.update([p], s)
    expect(b.buffer.get(0, 'iRect')).toEqual(f32([-1.4, 1.2, 1, 0.4]))
    expect(b.buffer.get(0, 'iShape')).toEqual(f32([0.12, 0.02, 4.5, 0.5]))
    expect(b.buffer.get(0, 'iColor')).toEqual(f32([1, srgbToLinear(0.5), 0, 0.8]))
    expect(b.buffer.get(0, 'iBorder')).toEqual([0, 0, 0, 1])
    expect(PANEL_ATTRS).toHaveLength(10)
  })
  it('capsule radius means n = 2, otherwise 4.5', () => {
    const b = new PanelBatch()
    b.update([{ ...p, radius: 20 }], s)   // radius == half the short side → capsule
    expect(b.buffer.get(0, 'iShape')[2]).toBe(2)
  })
  it('without a border packs width 0 and a transparent border colour', () => {
    const { border: _, ...plain } = p
    const b = new PanelBatch()
    b.update([plain], s)
    expect(b.buffer.get(0, 'iShape')[1]).toBe(0)
    expect(b.buffer.get(0, 'iBorder')).toEqual([0, 0, 0, 0])
  })
  it('sorts far→near by z and writes matrix rows and clips', () => {
    const clip: ClipRect = { x: 0, y: 0, width: 200, height: 100, radius: 12, transform: IDENTITY }
    const b = new PanelBatch()
    b.update([{ ...p, z: 3, color: [0, 0, 1, 1] }, { ...p, z: 2, clip }], s)
    expect(b.buffer.count).toBe(2); expect(b.geometry.instanceCount).toBe(2)
    expect(b.buffer.get(0, 'iClipRect')).toEqual([0, 0, 200, 100]); expect(b.buffer.get(0, 'iClipT')[2]).toBe(12)
    expect(b.buffer.get(1, 'iClipRect')[2]).toBe(-1)   // no clip
    expect(b.buffer.get(1, 'iColor')).toEqual([0, 0, 1, 1])
    expect(b.buffer.get(0, 'iMat0')).toEqual(f32([1, 0, 0, -1.4])); expect(b.buffer.get(0, 'iMat1')).toEqual(f32([0, 1, 0, 1.2]))
  })
  it('material builds with the quad geometry', () => {
    const b = new PanelBatch(); b.update([p], s)
    const m = createPanelMaterial(b.geometry, { size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(100) })
    expect(m.transparent).toBe(true); expect(m.depthWrite).toBe(false); expect(m.positionNode).toBeTruthy(); expect(m.opacityNode).toBeTruthy()
    expect(createQuadGeometry().getAttribute('position').count).toBe(4)
  })
  it('the quad is two triangles over [−0.5, 0.5]² with uvs, never frustum-culled by its own extent', () => {
    const g = createQuadGeometry()
    expect(Array.from(g.getAttribute('position').array)).toEqual([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0])
    expect(Array.from(g.getAttribute('uv').array)).toEqual([0, 0, 1, 0, 1, 1, 0, 1])
    expect(Array.from(g.getIndex()!.array)).toEqual([0, 1, 2, 0, 2, 3])
    expect(g.boundingSphere!.radius).toBeGreaterThanOrEqual(1e6)
  })
  it('places the quad through the instance matrix: iMat · (position.xy · iRect.zw, 0)', () => {
    const inst: PanelInstance = { ...p, rect: { x: 40, y: 60, width: 160, height: 64 }, elevation: 12, transform: scaleAbout(120, 92, 0.8), tilt: { x: 0.3, y: -0.2 } }
    const b = new PanelBatch(); b.update([inst], s)
    const m = createPanelMaterial(b.geometry, su())
    const M = instanceMatrix(inst, s)
    let worst = 0
    for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const) {
      const got = evalNode(m.positionNode, { ...packed(b), position: [x, y, 0] })
      const want = new Vector3(x * 1.6, y * 0.64, 0).applyMatrix4(M)
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(got[k]! - want.getComponent(k)))
    }
    expect(worst).toBeLessThan(1e-5)   // float32 packing
  })
  it('clips through maskNode: no clip, a rounded clip, a scaled clip, and a clip collapsed to zero width', () => {
    // the quad's (u, v) ∈ [−0.5, 0.5]² is surface pt (10 + 100·(u + 0.5), 10 + 40·(0.5 − v))
    const at = (u: number, v: number, clip?: ClipRect) => {
      const b = new PanelBatch(); b.update([{ ...p, ...(clip ? { clip } : {}) }], s)
      const m = createPanelMaterial(b.geometry, su())
      return evalNode(m.maskNode, { ...packed(b), position: [u, v, 0] })[0]
    }
    expect([at(-0.5, 0.5), at(0.5, -0.5), at(0, 0)]).toEqual([1, 1, 1])
    const rounded: ClipRect = { x: 20, y: 20, width: 60, height: 60, radius: 20, transform: IDENTITY }
    expect(at(-0.3, 0, rounded)).toBe(1)        // pt (30, 30): 14.1 from the corner centre (40, 40)
    expect(at(-0.39, 0.225, rounded)).toBe(0)   // pt (21, 21): inside the rect, outside its rounded corner
    expect(at(0.3, 0, rounded)).toBe(0)         // pt (90, 30): right of the clip
    const scaled: ClipRect = { x: 0, y: 0, width: 200, height: 100, radius: 0, transform: scaleAbout(100, 50, 0.5) }   // covers pt [50, 150] × [25, 75]
    expect(at(-0.2, 0, scaled)).toBe(0)   // pt (40, 30)
    expect(at(0, 0, scaled)).toBe(1)      // pt (60, 30)
    const collapsed: ClipRect = { x: 50, y: 0, width: 0, height: 100, radius: 12, transform: IDENTITY }
    expect([at(-0.3, 0, collapsed), at(0.3, 0, collapsed)]).toEqual([0, 0])
  })
  it('flatVertex hands the fragment one varying per packed attribute and the quad-local position and size', () => {
    const b = new PanelBatch(); b.update([p], s)
    const fv = flatVertex(b.geometry, su())
    expect(fv.pack('iShape')).toBe(fv.pack('iShape'))
    expect(evalNode(fv.pack('iShape'), packed(b))).toEqual(f32([0.12, 0.02, 4.5, 0.5]))
    const at = { ...packed(b), position: [-0.5, 0.5, 0] }
    expect(evalNode(fv.q, at)).toEqual(f32([-0.5, 0.2]))
    expect(evalNode(fv.size, at)).toEqual(f32([1, 0.4]))
    expect(() => fv.pack('iNope')).toThrow(/iNope/)
  })
  it('fails fast on a geometry missing an instance attribute (three would read zeros)', () => {
    for (const name of ['iClipT', 'iBorder']) {
      const b = new PanelBatch(); b.update([p], s)
      b.geometry.deleteAttribute(name)
      expect(() => createPanelMaterial(b.geometry, su())).toThrow(new RegExp(name))
    }
  })
})

describe('panel material shaders (generated under Node)', () => {
  for (const forceWebGL of [false, true]) {
    it(`${forceWebGL ? 'GLSL' : 'WGSL'}: builds with packed varyings only and the clip discard`, () => {
      const warnings: string[] = []
      const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')) })
      try {
        const b = new PanelBatch(); b.update([p], s)
        const out = buildShaders(createPanelMaterial(b.geometry, su()), b.geometry, forceWebGL)
        // flatVertex's three and the panel's three packs, nothing else: the fragment reads no instance attribute (three
        // would add a varying for each it reads there) and, unlit, no view position (a lit basic material derives a
        // flat normal from one)
        expect([...out.varyings].sort()).toEqual(['vFlatClip', 'vFlatClipR', 'vFlatQ', 'v_iBorder', 'v_iColor', 'v_iShape'])
        expect(out.fragment).toContain('discard')   // the clip mask
        expect(out.fragment).toContain('fwidth')    // the SDF's antialiasing width
      } finally { spy.mockRestore() }
      expect(warnings).toEqual([])
    })
  }
})
