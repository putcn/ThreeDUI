import { describe, it, expect, beforeAll } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { PerspectiveCamera, OrthographicCamera, Vector3 } from 'three'
import { createYogaLayout, AnimationRuntime, defaultTheme as theme } from '@glassui/core'
import { SystemFontEngine } from '@glassui/text'
import { Surface, type SurfaceContext } from '../src/surface/surface'
import { AtlasPages } from '../src/text/pages'
import { createMeasureFn } from '../src/text/measure'
import { ScreenLayer, screenUnitsPerPx } from '../src/surface/screen'

let ctx: SurfaceContext
beforeAll(async () => {
  const text = new SystemFontEngine({ createCanvas: ((w: number, h: number) => createCanvas(w, h)) as never, pageSize: 256 })
  ctx = { theme, scheme: 'light', layout: await createYogaLayout(), measure: createMeasureFn(text, theme, 'light'), anim: new AnimationRuntime(theme, 'light'), text, pages: new AtlasPages(text.atlas), quality: { contentType: 'byte', contentScale: 1, backFaces: false, depthReject: false } }
})

/** CSS px (from the viewport's top-left) of `s`'s local point (x, y) seen through `cam`. */
function px(s: Surface, cam: PerspectiveCamera | OrthographicCamera, x: number, y: number, vw: number, vh: number): [number, number] {
  const p = new Vector3(x, y, 0).applyMatrix4(s.matrixWorld).project(cam)
  return [(p.x + 1) / 2 * vw, (1 - p.y) / 2 * vh]
}

describe('screenUnitsPerPx', () => {
  it('perspective and orthographic', () => {
    const p = new PerspectiveCamera(60, 1, 0.1, 100)
    expect(screenUnitsPerPx(p, 800, 1)).toBeCloseTo(2 * Math.tan(Math.PI / 6) / 800, 12)
    const o = new OrthographicCamera(-4, 4, 3, -3, 0.1, 100)
    expect(screenUnitsPerPx(o, 600, 1)).toBeCloseTo(6 / 600, 12)
  })
  it('divides by the camera zoom', () => {
    const p = new PerspectiveCamera(60, 1, 0.1, 100); p.zoom = 2
    expect(screenUnitsPerPx(p, 800, 1)).toBeCloseTo(Math.tan(Math.PI / 6) / 800, 12)
    const o = new OrthographicCamera(-4, 4, 3, -3, 0.1, 100); o.zoom = 2
    expect(screenUnitsPerPx(o, 600, 1)).toBeCloseTo(3 / 600, 12)
  })
})

describe('ScreenLayer', () => {
  it('a fill surface covers the viewport exactly in NDC', () => {
    const cam = new PerspectiveCamera(50, 800 / 600, 0.1, 100); cam.position.set(1, 2, 3); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true)
    const layer = new ScreenLayer()
    const s = new Surface({ width: 10, height: 10, ptPerUnit: 1, placement: 'screen' }, ctx)
    layer.add(s); layer.place(s, { fill: true })
    layer.update(cam, { width: 800, height: 600 })
    layer.updateMatrixWorld(true)
    expect(s.model.width).toBe(800); expect(s.model.height).toBe(600)
    const tl = new Vector3(-400, 300, 0).applyMatrix4(s.matrixWorld).project(cam)
    const br = new Vector3(400, -300, 0).applyMatrix4(s.matrixWorld).project(cam)
    expect(tl.x).toBeCloseTo(-1, 6); expect(tl.y).toBeCloseTo(1, 6); expect(br.x).toBeCloseTo(1, 6); expect(br.y).toBeCloseTo(-1, 6)
    expect(tl.z).toBeLessThan(1); expect(tl.z).toBeGreaterThan(-1)
  })
  it('a placed surface sits at its CSS offset', () => {
    const cam = new PerspectiveCamera(50, 800 / 600, 0.1, 100); cam.updateMatrixWorld(true)
    const layer = new ScreenLayer()
    const s = new Surface({ width: 200, height: 100, ptPerUnit: 1, placement: 'screen' }, ctx)
    layer.add(s); layer.place(s, { left: 20, top: 30 })
    layer.update(cam, { width: 800, height: 600 }); layer.updateMatrixWorld(true)
    expect(s.position.x).toBe(20 + 100 - 400); expect(s.position.y).toBe(300 - (30 + 50))
    const tl = new Vector3(-100, 50, 0).applyMatrix4(s.matrixWorld).project(cam)
    expect((tl.x + 1) / 2 * 800).toBeCloseTo(20, 4); expect((1 - tl.y) / 2 * 600).toBeCloseTo(30, 4)
  })
  it('a scaled surface places its scaled top-left at the CSS offset', () => {
    const cam = new PerspectiveCamera(50, 800 / 600, 0.1, 100); cam.position.set(-2, 1, 4); cam.lookAt(0, 0, 0); cam.updateMatrixWorld(true)
    const layer = new ScreenLayer()
    const s = new Surface({ width: 200, height: 100, ptPerUnit: 1, placement: 'screen' }, ctx)
    s.scale.setScalar(0.5)
    layer.place(s, { left: 20, top: 30 })
    expect(s.parent).toBe(layer)
    layer.update(cam, { width: 800, height: 600 }); layer.updateMatrixWorld(true)
    expect(s.position.x).toBe(20 + 50 - 400); expect(s.position.y).toBe(300 - (30 + 25))
    const [l, t] = px(s, cam, -100, 50, 800, 600), [r, b] = px(s, cam, 100, -50, 800, 600)
    expect(l).toBeCloseTo(20, 4); expect(t).toBeCloseTo(30, 4)
    expect(r).toBeCloseTo(120, 4); expect(b).toBeCloseTo(80, 4)
  })
  it('re-applies every placement on each update and clamps the viewport to 1 px', () => {
    const cam = new OrthographicCamera(-4, 4, 3, -3, 0.1, 100); cam.position.set(0, 0, 5); cam.updateMatrixWorld(true)
    const layer = new ScreenLayer()
    const fill = new Surface({ width: 10, height: 10, ptPerUnit: 1, placement: 'screen' }, ctx)
    const box = new Surface({ width: 40, height: 20, ptPerUnit: 1, placement: 'screen' }, ctx)
    layer.place(fill, { fill: true }); layer.place(box, { left: 10, top: 10 })
    expect([...layer.surfaces]).toEqual([fill, box])
    layer.update(cam, { width: 800, height: 600 })
    layer.update(cam, { width: 1024, height: 768 }); layer.updateMatrixWorld(true)
    expect(fill.model.width).toBe(1024); expect(fill.model.height).toBe(768)
    expect(box.position.x).toBe(10 + 20 - 512); expect(box.position.y).toBe(384 - (10 + 10))
    const [l, t] = px(box, cam, -20, 10, 1024, 768)
    expect(l).toBeCloseTo(10, 4); expect(t).toBeCloseTo(10, 4)
    layer.update(cam, { width: 0, height: 0 })
    expect(layer.viewport).toEqual({ width: 1, height: 1 })
    expect(Number.isFinite(layer.scale.x)).toBe(true)
    expect(fill.model.width).toBe(1); expect(fill.model.height).toBe(1)
  })
  it('rejects a surface whose ptPerUnit is not 1', () => {
    const layer = new ScreenLayer()
    expect(() => layer.place(new Surface({ width: 1, height: 1, ptPerUnit: 244 }, ctx), { fill: true })).toThrow(/ptPerUnit/)
  })
})
