import { describe, it, expect, vi } from 'vitest'
import { uniform } from 'three/tsl'
import { Vector2, Vector3, NormalBlending, CustomBlending, AddEquation, SrcAlphaFactor, OneFactor, ZeroFactor } from 'three'
import { Node, IDENTITY, scaleAbout, type ClipRect, type DecorationInstance } from '@glassui/core'
import { DecorationBatch, DECOR_ATTRS } from '../src/decoration/batch'
import { createRimMaterial, createPoolMaterial, rimProfile, RIM_OUTLINE_PT, RIM_OUTLINE_ALPHA } from '../src/decoration/material'
import { AA_MARGIN_PT } from '../src/flat'
import { instanceMatrix } from '../src/transform'
import { srgbToLinear } from '../src/color'
import { evalNode } from './fixtures/tsl-eval'
import { buildShaders } from './fixtures/build-shaders'

/** Instance attributes are float32: the expected value of a stored number is its float32 rounding. */
const f32 = (v: number[]) => v.map(Math.fround)
const s = { width: 400, height: 300, ptPerUnit: 100 }
const su = () => ({ size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(100) })
const node = new Node('glass', 'g')
// a 'capsule' glass: its corner exponent is 2
const base = { node, rect: { x: 10, y: 10, width: 100, height: 40 }, radius: 20, cornerExponent: 2, elevation: 4, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1 }
const rim: DecorationInstance = { ...base, kind: 'rim', color: [1, 1, 1, 1], strength: 1, z: 1.5 }
const pool: DecorationInstance = { ...base, kind: 'pool', color: [0.42, 0.39, 0.96, 1], strength: 0.5, z: 0.75 }
/** Instance `i`'s packed attributes by name, as `evalNode` takes them. */
const packed = (b: DecorationBatch, i = 0) => Object.fromEntries(DECOR_ATTRS.map(name => [name, b.buffer.get(i, name)]))
const smooth = (lo: number, hi: number, x: number) => { const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t) }
const close = (got: number[], want: number[]) => got.forEach((x, k) => expect(x).toBeCloseTo(want[k]!, 6))

describe('rimProfile', () => {
  it('bright lower band, fading top band, nothing in the middle', () => {
    expect(rimProfile(0).lower).toBeCloseTo(0.42, 6); expect(rimProfile(0).top).toBe(0)
    expect(rimProfile(1).top).toBeCloseTo(0.22, 6); expect(rimProfile(1).lower).toBe(0)
    expect(rimProfile(0.5).lower).toBe(0); expect(rimProfile(0.5).top).toBe(0)
    expect(rimProfile(0.0675).lower).toBeCloseTo(0.10, 1)
  })
  it('below the bottom edge (the AA margin) the lower band holds its edge value instead of growing', () => {
    expect(rimProfile(-0.05)).toEqual(rimProfile(0))
  })
})

describe('DecorationBatch', () => {
  it('keeps its own kind, lifts rims by the glass thickness, keeps pools on the plane', () => {
    const rims = new DecorationBatch('rim'), pools = new DecorationBatch('pool')
    rims.update([rim, pool], s, () => 8); pools.update([rim, pool], s)
    expect(rims.buffer.count).toBe(1); expect(pools.buffer.count).toBe(1)
    expect(rims.buffer.get(0, 'iMat2')[3]).toBeCloseTo((4 + 8) / 100)       // elevation + thickness, in units
    expect(pools.buffer.get(0, 'iMat2')[3]).toBe(0)
    expect(rims.buffer.get(0, 'iShape')).toEqual(f32([0.2, 1, 2, 1]))
    expect(DECOR_ATTRS).toHaveLength(9)
    pools.update([pool], s, () => 8)
    expect(pools.buffer.get(0, 'iMat2')[3]).toBe(0)                            // a lift never raises a pool
  })
  it('sorts its instances far→near by z and packs linear colour with alpha 1', () => {
    const rims = new DecorationBatch('rim')
    rims.update([{ ...rim, z: 3, strength: 0.25, color: [1, 0.5, 0, 0.6] }, rim], s)
    expect(rims.buffer.get(0, 'iShape')[1]).toBe(1); expect(rims.buffer.get(1, 'iShape')[1]).toBe(0.25)
    expect(rims.buffer.get(1, 'iColor')).toEqual(f32([1, srgbToLinear(0.5), 0, 1]))
  })
  it('packs its glass\'s corner exponent, not one guessed from the rect', () => {
    // radius 20 is half of 40 either way: a 'capsule' glass is circular (2), a numeric radius 20 keeps 4.5, and a style
    // override is whatever it says; the rim's outline must follow the glass's silhouette in each case
    for (const kind of ['rim', 'pool'] as const) {
      const b = new DecorationBatch(kind)
      b.update([2, 4.5, 3].map((n, i) => ({ ...(kind === 'rim' ? rim : pool), cornerExponent: n, z: i })), s)
      expect([0, 1, 2].map(i => b.buffer.get(i, 'iShape')[2])).toEqual([2, 4.5, 3])
    }
  })
  it('skips degenerate and invisible decorations (zero area, zero strength or opacity)', () => {
    for (const kind of ['rim', 'pool'] as const) {
      const d = kind === 'rim' ? rim : pool
      const b = new DecorationBatch(kind)
      b.update([
        { ...d, rect: { ...d.rect, height: 0 } }, { ...d, rect: { ...d.rect, width: 0 } },
        { ...d, strength: 0 }, { ...d, opacity: 0 }, { ...d, strength: 0.7 },
      ], s)
      expect(b.buffer.count).toBe(1); expect(b.buffer.get(0, 'iShape')[1]).toBe(Math.fround(0.7))
    }
  })
  it('inflates and lowers the pool rect', () => {
    const pools = new DecorationBatch('pool')
    pools.update([pool], s)
    const [cx, cy, w, h] = pools.buffer.get(0, 'iRect')
    expect(w).toBeCloseTo((100 + 0.29 * 40) / 100); expect(h).toBeCloseTo((40 + 0.33 * 40) / 100)
    expect(cx).toBeCloseTo(-1.4); expect(cy).toBeCloseTo(1.2 - 0.11 * 40 / 100)
  })
  it('the rim sits on its glass top face, tilted and scaled with the glass (lift along the instance z axis)', () => {
    // the glass slab's top face is iMat · (x, y, thickness) in the instance frame (glass/vertex.ts); the rim's quad,
    // grown by the AA margin, must lie in that plane however the glass is tilted or scaled
    const inst: DecorationInstance = { ...rim, rect: { x: 40, y: 60, width: 160, height: 64 }, elevation: 12, transform: scaleAbout(120, 92, 0.8), tilt: { x: 0.3, y: -0.2 } }
    const T = 16
    const b = new DecorationBatch('rim'); b.update([inst], s, () => T)
    const m = createRimMaterial(b.geometry, su())
    const M = instanceMatrix(inst, s), grow = (2 * AA_MARGIN_PT) / s.ptPerUnit
    let worst = 0
    for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const) {
      const got = evalNode(m.positionNode, { ...packed(b), position: [x, y, 0] })
      const want = new Vector3(x * (1.6 + grow), y * (0.64 + grow), T / s.ptPerUnit).applyMatrix4(M)
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(got[k]! - want.getComponent(k)))
    }
    expect(worst).toBeLessThan(1e-5)   // float32 packing
  })
  it('materials build with the right blending: rims blend normally, pools add colour and leave alpha alone', () => {
    const b = new DecorationBatch('rim'); b.update([rim], s)
    const su = { size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(100) }
    expect(createRimMaterial(b.geometry, su).blending).toBe(NormalBlending)
    // the content RT's alpha is the content quad's opacity (alphaTest 0.02): a pool adding its α there would composite
    // as rgb·α² and lose its faint fringe to the alpha test
    const p = createPoolMaterial(b.geometry, su)
    expect(p.blending).toBe(CustomBlending); expect(p.premultipliedAlpha).toBe(false)
    expect([p.blendEquation, p.blendSrc, p.blendDst]).toEqual([AddEquation, SrcAlphaFactor, OneFactor])
    expect([p.blendEquationAlpha, p.blendSrcAlpha, p.blendDstAlpha]).toEqual([AddEquation, ZeroFactor, OneFactor])
  })
})

describe('rim material', () => {
  // fragment output at quad-local q (units; the 1 × 0.4 capsule, quad grown by the AA margin) for a footprint of
  // `px` units per pixel: [r, g, b, opacity]
  const frag = (inst: DecorationInstance, qx: number, qy: number, px = 0.01) => {
    const b = new DecorationBatch('rim'); b.update([inst], s)
    const m = createRimMaterial(b.geometry, su())
    const grow = (2 * AA_MARGIN_PT) / s.ptPerUnit
    const at = { ...packed(b), position: [qx / (1 + grow), qy / (0.4 + grow), 0] }
    return [...evalNode(m.colorNode, at, undefined, px), ...evalNode(m.opacityNode, at, undefined, px)]
  }
  const aa = 0.0075, ow = RIM_OUTLINE_PT / 100   // 0.75 px at 0.01 units per pixel; the outline width in units
  const y = (y01: number) => -0.2 + y01 * 0.4      // height fraction → q.y

  it('nothing in the middle; the lower and top bands inside the outline; strength and opacity scale it', () => {
    const faint: DecorationInstance = { ...rim, strength: 0.5, opacity: 0.8 }
    expect(frag(faint, 0, 0)[3]).toBe(0)
    close(frag(faint, 0, y(0.0675)).slice(3), [rimProfile(0.0675).lower * 0.4])   // 2.7 pt above the bottom edge
    close(frag(faint, 0, y(0.9)).slice(3), [rimProfile(0.9).top * 0.4])
  })
  it('a 1.25 pt outline at α 0.75 just inside the edge, fading over aa + ¼ of its width', () => {
    // the capsule's left end at mid height (no band there): d = −(0.5 + qx)
    close(frag(rim, -0.5 + ow / 2, 0, 0.001).slice(3), [RIM_OUTLINE_ALPHA])   // mid-outline, fully covered
    const fade = aa + ow / 4
    close(frag(rim, -0.5 + ow + fade / 2, 0).slice(3), [RIM_OUTLINE_ALPHA * 0.5])   // halfway down the inner fade
    expect(frag(rim, -0.5 + ow + fade * 1.01, 0)[3]).toBe(0)
  })
  it('covers by the superellipse over ±0.75 px: half on the edge, nothing past the ramp', () => {
    close(frag(rim, 0, -0.2).slice(3), [0.5])   // bottom edge: outline + lower band saturate at 1, half covered
    // the outer ramp below the bottom edge, inside the margin: the lower band keeps its edge value (y01 floored at 0)
    const d = aa / 2
    close(frag(rim, 0, -0.2 - d).slice(3), [(RIM_OUTLINE_ALPHA * (1 - smooth(0, aa + ow / 4, d)) + rimProfile(0).lower) * (1 - smooth(-aa, aa, d))])
    expect(frag(rim, 0, -0.2 - aa * 1.01)[3]).toBe(0)
  })
  it('colours by the linear instance colour', () => {
    close(frag({ ...rim, color: [1, 0.5, 0, 1] }, 0, y(0.0675)).slice(0, 3), [1, srgbToLinear(0.5), 0])
  })
})

describe('pool material', () => {
  // fragment output at (u, v) = q / half of the inflated rect (the pool's quad has no margin: its falloff is 0 on the
  // ellipse inscribed in the rect, so nothing past the rect could ever show)
  const frag = (inst: DecorationInstance, u: number, v: number) => {
    const b = new DecorationBatch('pool'); b.update([inst], s)
    const m = createPoolMaterial(b.geometry, su())
    const at = { ...packed(b), position: [u / 2, v / 2, 0] }
    return [...evalNode(m.colorNode, at), ...evalNode(m.opacityNode, at)]
  }
  it('falls off linearly with the elliptical radius, scaled by strength and opacity', () => {
    close(frag(pool, 0, 0), [srgbToLinear(0.42), srgbToLinear(0.39), srgbToLinear(0.96), 0.5])
    close(frag(pool, 0.6, 0).slice(3), [0.4 * 0.5])
    close(frag({ ...pool, opacity: 0.8 }, 0.3, 0.4).slice(3), [0.5 * 0.5 * 0.8])
  })
  it('is zero on the rect boundary and beyond the ellipse', () => {
    for (const [u, v] of [[1, 0], [0, -1], [1, 1], [-1, 0.5]] as const) expect(frag(pool, u, v)[3]).toBe(0)
  })
})

describe('decoration clipping', () => {
  it('rims and pools mask by the instance clip', () => {
    const clip: ClipRect = { x: 0, y: 0, width: 60, height: 100, radius: 0, transform: IDENTITY }   // the rect's left half
    for (const [inst, create] of [[rim, createRimMaterial], [pool, createPoolMaterial]] as const) {
      const b = new DecorationBatch(inst.kind); b.update([{ ...inst, clip }], s)
      const m = create(b.geometry, su())
      expect(evalNode(m.maskNode, { ...packed(b), position: [-0.3, 0, 0] })[0]).toBe(1)
      expect(evalNode(m.maskNode, { ...packed(b), position: [0.3, 0, 0] })[0]).toBe(0)
    }
  })
})

describe('decoration material shaders (generated under Node)', () => {
  for (const kind of ['rim', 'pool'] as const) {
    for (const forceWebGL of [false, true]) {
      it(`${kind}, ${forceWebGL ? 'GLSL' : 'WGSL'}: builds with packed varyings only and the clip discard`, () => {
        const warnings: string[] = []
        const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')) })
        try {
          const b = new DecorationBatch(kind); b.update([kind === 'rim' ? rim : pool], s)
          const m = (kind === 'rim' ? createRimMaterial : createPoolMaterial)(b.geometry, su())
          const out = buildShaders(m, b.geometry, forceWebGL)
          // flatVertex's three and the shape + colour packs: the fragment reads no instance attribute, and unlit, no
          // view position
          expect([...out.varyings].sort()).toEqual(['vFlatClip', 'vFlatClipR', 'vFlatQ', 'v_iColor', 'v_iShape'])
          expect(out.fragment).toContain('discard')   // the clip mask
          if (kind === 'rim') { expect(out.fragment).toContain('fwidth'); expect(out.fragment).toContain('exp') }
        } finally { spy.mockRestore() }
        expect(warnings).toEqual([])
      })
    }
  }
})
