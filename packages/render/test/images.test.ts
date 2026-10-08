import { describe, it, expect, vi } from 'vitest'
import { uniform } from 'three/tsl'
import { Vector2, Vector3, Texture, TextureLoader, RenderTarget, Mesh, NormalBlending, SRGBColorSpace, NoColorSpace, LinearSRGBColorSpace } from 'three'
import type { MeshBasicNodeMaterial } from 'three/webgpu'
import { Node, IDENTITY, scaleAbout, type ClipRect, type ImageInstance } from '@glassui/core'
import { ImageSet, IMAGE_ATTRS, defaultImageLoader } from '../src/image/images'
import { AA_MARGIN_PT } from '../src/flat'
import { instanceMatrix } from '../src/transform'
import { srgbToLinear } from '../src/color'
import type { InstanceBuffer } from '../src/instances'
import { evalNode } from './fixtures/tsl-eval'
import { buildShaders } from './fixtures/build-shaders'

const s = { width: 400, height: 300, ptPerUnit: 100 }
const su = { size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(100) }
const img = (id: string, src: unknown): ImageInstance => ({ node: new Node('image', id), rect: { x: 10, y: 10, width: 100, height: 100 }, src, radius: 50, z: 1.25, elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 0.8 })
/** Instance attributes are float32: the expected value of a stored number is its float32 rounding. */
const f32 = (v: number[]) => v.map(Math.fround)
const bufferOf = (mesh: Mesh) => mesh.userData.buffer as InstanceBuffer
const meshOf = (set: ImageSet, node: Node) => set.container.children.find(c => c.userData.node === node) as Mesh
/** The mesh's packed attributes by name, as `evalNode` takes them. */
const packed = (mesh: Mesh) => Object.fromEntries(IMAGE_ATTRS.map(name => [name, bufferOf(mesh).get(0, name)]))
const close = (got: number[], want: number[]) => got.forEach((x, k) => expect(x).toBeCloseTo(want[k]!, 6))
/** Stands in for `ImageBitmap` (absent under Node) through `vi.stubGlobal`. */
class FakeBitmap { width = 2; height = 2 }

describe('ImageSet', () => {
  it('creates one mesh per image, reuses by node, removes stale ones', () => {
    const calls: unknown[] = []
    const set = new ImageSet(su, src => { calls.push(src); return new Texture() })
    const a = img('a', 'a.png'), b = img('b', new Texture())
    set.update([a, b], s)
    expect(set.container.children).toHaveLength(2); expect(calls).toHaveLength(2)
    const meshA = set.container.children.find(c => c.userData.node === a.node) as Mesh
    set.update([a], s)
    expect(set.container.children).toHaveLength(1); expect(set.container.children[0]).toBe(meshA); expect(calls).toHaveLength(2)
    expect(IMAGE_ATTRS).toHaveLength(8)
  })
  it('packs radius as a capsule exponent and opacity', () => {
    const set = new ImageSet(su, () => new Texture())
    set.update([img('a', 'a.png')], s)
    const mesh = set.container.children[0] as Mesh
    const shape = (mesh.userData.buffer as { get(i: number, n: string): number[] }).get(0, 'iShape')
    expect(shape).toEqual(f32([0.5, 2, 0.8, 0]))   // float32 storage: 0.8 reads back as fround(0.8)
  })
  it('packs a non-capsule radius as the continuous corner (4.5), the rect in units and the clip', () => {
    const clip: ClipRect = { x: 0, y: 0, width: 200, height: 100, radius: 12, transform: IDENTITY }
    const set = new ImageSet(su, () => new Texture())
    set.update([{ ...img('a', 'a.png'), rect: { x: 10, y: 10, width: 100, height: 40 }, radius: 12, clip }], s)
    const b = bufferOf(set.container.children[0] as Mesh)
    expect(b.get(0, 'iRect')).toEqual(f32([-1.4, 1.2, 1, 0.4]))
    expect(b.get(0, 'iShape')).toEqual(f32([0.12, 4.5, 0.8, 0]))
    expect(b.get(0, 'iClipRect')).toEqual([0, 0, 200, 100]); expect(b.get(0, 'iClipT')[2]).toBe(12)
    expect(b.count).toBe(1); expect(b.geometry.instanceCount).toBe(1)
  })
  it('places the image through its transform, lifted by elevation + lift', () => {
    const set = new ImageSet(su, () => new Texture())
    const a: ImageInstance = { ...img('a', 'a.png'), elevation: 2, transform: scaleAbout(60, 60, 0.5), tilt: { x: 0.2, y: 0 } }
    set.update([a], s, i => (i === a ? 8 : 0))
    const b = bufferOf(set.container.children[0] as Mesh)
    const M = instanceMatrix({ ...a, elevation: 10 }, s), el = M.elements
    expect(b.get(0, 'iMat0')).toEqual(f32([el[0]!, el[4]!, el[8]!, el[12]!]))
    expect(b.get(0, 'iMat1')).toEqual(f32([el[1]!, el[5]!, el[9]!, el[13]!]))
    expect(b.get(0, 'iMat2')).toEqual(f32([el[2]!, el[6]!, el[10]!, el[14]!]))
  })
  it('draws each image as its own transparent, unculled mesh ordered by z (normal blending, no depth write)', () => {
    const set = new ImageSet(su, () => new Texture())
    const near = { ...img('near', 'n.png'), z: 3.25 }, far = img('far', 'f.png')
    set.update([near, far], s)
    const mn = meshOf(set, near.node), mf = meshOf(set, far.node)
    expect([mf.renderOrder, mn.renderOrder]).toEqual([0, 0.25])   // by z rank within [base, base + ½)
    expect([mn.frustumCulled, mf.frustumCulled]).toEqual([false, false])
    const mat = mn.material as MeshBasicNodeMaterial
    expect([mat.transparent, mat.depthWrite, mat.blending]).toEqual([true, false, NormalBlending])
    expect(mn.geometry).not.toBe(mf.geometry)
    set.update([{ ...near, z: 0.25 }, far], s)
    expect(meshOf(set, near.node)).toBe(mn); expect(mn.renderOrder).toBeLessThan(mf.renderOrder)
  })
  it('places the set at a base renderOrder, below base + ½ however deep the tree is', () => {
    const set = new ImageSet(su, () => new Texture())
    const many = Array.from({ length: 40 }, (_, k) => ({ ...img(`i${k}`, `${k}.png`), z: 1000 + k * 7.25 }))
    set.update(many, s, undefined, 1.5)
    const orders = many.map(i => meshOf(set, i.node).renderOrder)
    expect(orders[0]).toBe(1.5); expect(Math.max(...orders)).toBeLessThan(2)
    expect(orders).toEqual([...orders].sort((a, b) => a - b))
    expect(set.container.isObject3D).toBe(true); expect((set.container as { isGroup?: boolean }).isGroup).toBeUndefined()   // keeps its layer's group order
  })
  it('pollChanged reports a texture whose version moved since the last poll', () => {
    const t = new Texture({ width: 2, height: 2 })
    const set = new ImageSet(su, () => t)
    set.update([img('a', 'a.png')], s)
    expect(set.pollChanged()).toBe(false)         // the update that made it has drawn it already
    t.needsUpdate = true                          // a URL finished loading, a video frame, a caller's update
    expect(set.pollChanged()).toBe(true); expect(set.pollChanged()).toBe(false)
  })
  it('pollChanged re-uploads an element that finished loading after its first upload', () => {
    const el = { width: 2, height: 2, complete: false }
    const t = defaultImageLoader(el), set = new ImageSet(su, () => t)
    set.update([img('a', 'a.png')], s)
    const v = t.version
    expect(set.pollChanged()).toBe(false)
    el.complete = true
    expect(set.pollChanged()).toBe(true); expect(t.version).toBe(v + 1)   // three skips an incomplete image and never retries
    expect(set.pollChanged()).toBe(false)
  })
  it('pollChanged does not mark a texture again when its loader already did (URL load)', () => {
    const t = new Texture()                       // TextureLoader's: no image until it arrives, then image + needsUpdate
    const set = new ImageSet(su, () => t)
    set.update([img('a', 'a.png')], s)
    expect(set.pollChanged()).toBe(false)
    t.image = { width: 2, height: 2 }; t.needsUpdate = true
    const v = t.version
    expect(set.pollChanged()).toBe(true); expect(t.version).toBe(v)
  })
  it('re-creates the mesh when src changes, disposing the old one and the texture the loader made for it', () => {
    const made: Texture[] = []
    const set = new ImageSet(su, () => { const t = new Texture(); made.push(t); return t })
    const a = img('a', 'a.png')
    set.update([a], s)
    const old = meshOf(set, a.node)
    const disposed = { material: vi.fn(), geometry: vi.fn(), texture: vi.fn() }
    ;(old.material as MeshBasicNodeMaterial).addEventListener('dispose', disposed.material as never)
    old.geometry.addEventListener('dispose', disposed.geometry as never)
    made[0]!.addEventListener('dispose', disposed.texture as never)
    set.update([{ ...a, src: 'b.png' }], s)
    const fresh = meshOf(set, a.node)
    expect(fresh).not.toBe(old); expect(set.container.children).toHaveLength(1); expect(made).toHaveLength(2)
    expect([disposed.material, disposed.geometry, disposed.texture].map(f => f.mock.calls.length)).toEqual([1, 1, 1])
  })
  it('never disposes a texture passed as the src itself (the caller owns it)', () => {
    const own = new Texture(), onDispose = vi.fn()
    own.addEventListener('dispose', onDispose as never)
    const set = new ImageSet(su)   // the default loader returns a Texture src as is
    const a = img('a', own)
    set.update([a], s)
    set.update([{ ...a, src: new Texture() }], s)   // src change
    set.update([], s)                              // removal
    set.dispose()
    expect(onDispose).not.toHaveBeenCalled()
  })
  it('disposes a loader-made texture when its image leaves the list or loses its src, and on dispose', () => {
    const made: Texture[] = [], disposed = new Set<Texture>()
    const set = new ImageSet(su, () => { const t = new Texture(); made.push(t); t.addEventListener('dispose', () => { disposed.add(t) }); return t })
    const a = img('a', 'a.png'), b = img('b', 'b.png'), c = img('c', 'c.png')
    set.update([a, b, c], s)
    set.update([b, { ...c, src: null }], s)   // a leaves; c's src goes to null
    expect(set.container.children).toHaveLength(1); expect(meshOf(set, b.node)).toBeDefined(); expect(meshOf(set, c.node)).toBeUndefined()
    expect(disposed).toEqual(new Set([made[0], made[2]]))
    set.dispose()
    expect(disposed).toEqual(new Set(made))
  })
  it('shows nothing for an image without a src, and hides empty or fully transparent ones without reloading', () => {
    const calls: unknown[] = []
    const set = new ImageSet(su, src => { calls.push(src); return new Texture() })
    set.update([img('none', undefined), img('null', null)], s)
    expect(set.container.children).toHaveLength(0); expect(calls).toHaveLength(0)
    const a = img('a', 'a.png')
    for (const [inst, visible] of [
      [{ ...a, rect: { ...a.rect, width: 0 } }, false], [{ ...a, rect: { ...a.rect, height: 0 } }, false],
      [{ ...a, opacity: 0 }, false], [a, true],
    ] as const) {
      set.update([inst], s)
      expect(meshOf(set, a.node).visible).toBe(visible)
    }
    expect(set.container.children).toHaveLength(1); expect(calls).toEqual(['a.png'])
  })
  it('dispose releases every mesh and empties the group', () => {
    const set = new ImageSet(su, () => new Texture())
    set.update([img('a', 'a.png'), img('b', 'b.png')], s)
    const onDispose = vi.fn()
    for (const c of set.container.children) (c as Mesh).geometry.addEventListener('dispose', onDispose as never)
    set.dispose()
    expect(set.container.children).toHaveLength(0); expect(onDispose).toHaveBeenCalledTimes(2)
    set.update([img('a', 'a.png')], s)   // usable again
    expect(set.container.children).toHaveLength(1)
  })
})

describe('defaultImageLoader', () => {
  it('returns a Texture src as is: colour space and alpha mode untouched', () => {
    const t = new Texture(), tagged = new Texture(); tagged.colorSpace = SRGBColorSpace
    expect(defaultImageLoader(t)).toBe(t); expect(defaultImageLoader(tagged)).toBe(tagged)
    expect([t.colorSpace, t.premultiplyAlpha, tagged.colorSpace, tagged.premultiplyAlpha]).toEqual([NoColorSpace, false, SRGBColorSpace, false])
  })
  it('wraps an element (any TexImageSource) in a raw (untagged sRGB), premultiplied texture marked for upload', () => {
    const el = { width: 4, height: 2 }
    const t = defaultImageLoader(el)
    expect(t.image).toBe(el); expect(t.version).toBeGreaterThan(0)
    expect([t.colorSpace, t.premultiplyAlpha]).toEqual([NoColorSpace, true])
  })
  it('loads a URL through three\'s TextureLoader into a raw, premultiplied texture returned immediately', () => {
    const pending = new Texture<HTMLImageElement>()
    const spy = vi.spyOn(TextureLoader.prototype, 'load').mockImplementation(() => pending)
    try {
      expect(defaultImageLoader('icons/a.png')).toBe(pending)
      expect(spy).toHaveBeenCalledWith('icons/a.png'); expect([pending.colorSpace, pending.premultiplyAlpha]).toEqual([NoColorSpace, true])
    } finally { spy.mockRestore() }
  })
  it('leaves an ImageBitmap straight (WebGL ignores the unpack flags for one: its alpha mode is fixed when it is created)', () => {
    vi.stubGlobal('ImageBitmap', FakeBitmap)
    try {
      const t = defaultImageLoader(new FakeBitmap())
      expect([t.colorSpace, t.premultiplyAlpha]).toEqual([NoColorSpace, false])
    } finally { vi.unstubAllGlobals() }
  })
})

describe('image material', () => {
  /** A texture of the given colour space and alpha mode. */
  const tex = (colorSpace: string, premultiplyAlpha: boolean) => { const t = new Texture(); t.colorSpace = colorSpace; t.premultiplyAlpha = premultiplyAlpha; return t }
  // the fragment at quad-local q (units) of a 100 × 100 pt image (1 × 1 units) grown by the AA margin, footprint 1 pt
  // per pixel (aa = 0.0075 units), through a sampler that records the uv and returns `texel` (by default from a straight
  // sRGB-tagged texture, which the hardware decodes: the shader passes its sample through)
  const frag = (inst: ImageInstance, qx: number, qy: number, t = tex(SRGBColorSpace, false), texel = [0.2, 0.4, 0.6, 0.5]) => {
    const uvs: number[][] = []
    const set = new ImageSet(su, () => t); set.update([inst], s)
    const mesh = set.container.children[0] as Mesh, m = mesh.material as MeshBasicNodeMaterial
    const sample = (got: unknown, uv: readonly number[]) => { expect(got).toBe(t); uvs.push([...uv]); return texel }
    const grow = (2 * AA_MARGIN_PT) / s.ptPerUnit
    const at = { ...packed(mesh), position: [qx / (inst.rect.width / 100 + grow), qy / (inst.rect.height / 100 + grow), 0] }
    return { rgba: [...evalNode(m.colorNode, at, undefined, 0.01, sample), ...evalNode(m.opacityNode, at, undefined, 0.01, sample)], uv: uvs[0]!, mask: evalNode(m.maskNode, at)[0] }
  }
  it('maps the image upright over the rect: its top-left at uv (0, 1), its bottom-right at (1, 0)', () => {
    // three uploads images flipped (flipY): image row 0 (the top) lies at v = 1, and q.y runs up
    const a = { ...img('a', 'a.png'), radius: 0 }
    close(frag(a, -0.5, 0.5).uv, [0, 1]); close(frag(a, 0.5, -0.5).uv, [1, 0]); close(frag(a, 0, 0).uv, [0.5, 0.5])
    close(frag({ ...a, rect: { ...a.rect, width: 200 } }, 0.5, 0.25).uv, [0.75, 0.75])   // a 2 × 1 rect
  })
  it('colours by the sample; opacity = SDF coverage × sample alpha × instance opacity, antialiased past the edge', () => {
    const a = img('a', 'a.png')   // a capsule: radius 0.5 units, n = 2 (a circle)
    close(frag(a, 0, 0).rgba, [0.2, 0.4, 0.6, 0.5 * 0.8])
    close(frag(a, 0.5, 0).rgba, [0.2, 0.4, 0.6, 0.5 * 0.5 * 0.8])                // on the edge: half covered
    close(frag(a, 0.5 + 0.00375, 0).rgba, [0.2, 0.4, 0.6, 0.15625 * 0.5 * 0.8])  // the outer half of the ramp (the margin)
    expect(frag(a, 0.5 + 0.0075, 0).rgba[3]).toBe(0)
    // the corner is rounded: the rect's corner is outside the circle, so uncovered
    expect(frag(a, 0.5, 0.5).rgba[3]).toBe(0)
    expect(frag({ ...a, radius: 0 }, 0.5 - 0.01, 0.5 - 0.01).rgba[3]).toBeCloseTo(0.5 * 0.8, 6)
  })
  it('un-premultiplies a premultiplied texture; decodes only the default loader\'s (raw sRGB) ones, after un-premultiplying', () => {
    const a = img('a', 'a.png'), texel = [0.25, 0.25, 0.25, 0.5]
    const rgb = (t: Texture) => frag(a, 0, 0, t, texel).rgba.slice(0, 3)
    // a caller's texture follows three: the hardware decodes a tagged one, an untagged one is read raw; the shader only
    // divides alpha out of a premultiplied sample
    for (const cs of [SRGBColorSpace, LinearSRGBColorSpace, NoColorSpace]) {
      close(rgb(tex(cs, true)), [0.5, 0.5, 0.5]); close(rgb(tex(cs, false)), [0.25, 0.25, 0.25])
    }
    // the default loader's: sRGB bytes, decoded after alpha is divided out (an ImageBitmap's stay straight)
    const loaded = defaultImageLoader({ width: 1, height: 1 })
    close(rgb(loaded), Array(3).fill(srgbToLinear(0.5)))
    vi.stubGlobal('ImageBitmap', FakeBitmap)
    try { close(rgb(defaultImageLoader(new FakeBitmap())), Array(3).fill(srgbToLinear(0.25))) } finally { vi.unstubAllGlobals() }
    for (const t of [loaded, tex(SRGBColorSpace, false)]) expect(frag(a, 0, 0, t, texel).rgba[3]).toBeCloseTo(0.5 * 0.8, 6)
    close(frag(a, 0, 0, loaded, [0, 0, 0, 0]).rgba, [0, 0, 0, 0])   // a transparent texel: no 0/0
  })
  it('reads an untagged caller texture (a render target\'s) raw, as three means NoColorSpace', () => {
    const rt = new RenderTarget(1, 1)
    expect(rt.texture.colorSpace).toBe(NoColorSpace)
    close(frag(img('a', 'a.png'), 0, 0, rt.texture, [0.5, 0.5, 0.5, 1]).rgba, [0.5, 0.5, 0.5, 0.8])
  })
  it('keeps the colour of a partially transparent texel of the default loader\'s texture', () => {
    // the browser premultiplies the encoded bytes (sRGB 0.8 at alpha 0.5 arrives as 0.4): divided out, then decoded, it
    // is the colour again. A hardware sRGB texture would decode the product, and decode(0.4) / 0.5 is 56 % darker
    const [r] = frag(img('a', 'a.png'), 0, 0, defaultImageLoader({ width: 1, height: 1 }), [0.4, 0.4, 0.4, 0.5]).rgba
    expect(r).toBeCloseTo(srgbToLinear(0.8), 6)
  })
  it('masks by the instance clip', () => {
    const clip: ClipRect = { x: 0, y: 0, width: 60, height: 300, radius: 0, transform: IDENTITY }   // the image spans x 10–110
    expect(frag({ ...img('a', 'a.png'), clip }, -0.25, 0).mask).toBe(1)
    expect(frag({ ...img('a', 'a.png'), clip }, 0.25, 0).mask).toBe(0)
  })
  it('grows the rasterised quad by the AA margin around the placed rect', () => {
    const set = new ImageSet(su, () => new Texture())
    const a = { ...img('a', 'a.png'), transform: scaleAbout(60, 60, 0.8) }
    set.update([a], s)
    const mesh = set.container.children[0] as Mesh, m = mesh.material as MeshBasicNodeMaterial
    const M = instanceMatrix(a, s), grow = (2 * AA_MARGIN_PT) / s.ptPerUnit
    let worst = 0
    for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]] as const) {
      const got = evalNode(m.positionNode, { ...packed(mesh), position: [x, y, 0] })
      const want = new Vector3(x * (1 + grow), y * (1 + grow), 0).applyMatrix4(M)
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(got[k]! - want.getComponent(k)))
    }
    expect(worst).toBeLessThan(1e-5)   // float32 packing
  })
  for (const forceWebGL of [false, true]) {
    it(`${forceWebGL ? 'GLSL' : 'WGSL'}: builds with flatVertex's varyings plus iShape, one texture sample and the clip discard`, () => {
      const warnings: string[] = []
      const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { warnings.push(a.map(String).join(' ')) })
      try {
        // the default loader's texture: the full path (un-premultiply, then the sRGB decode)
        const set = new ImageSet(su, () => defaultImageLoader({ width: 4, height: 4 })); set.update([img('a', 'a.png')], s)
        const mesh = set.container.children[0] as Mesh
        const out = buildShaders(mesh.material as MeshBasicNodeMaterial, mesh.geometry, forceWebGL)
        // q/size (the uv comes from q, not the grown quad's uv attribute), the clip pair and iShape; unlit, so no view position
        expect([...out.varyings].sort()).toEqual(['vFlatClip', 'vFlatClipR', 'vFlatQ', 'v_iShape'])
        expect(out.fragment.match(forceWebGL ? /\btexture\s*\(/g : /\btextureSample\s*\(/g)).toHaveLength(1)
        expect(out.fragment).toContain('discard')   // the clip mask
      } finally { spy.mockRestore() }
      expect(warnings).toEqual([])
    })
  }
})
