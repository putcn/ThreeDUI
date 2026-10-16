import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three'
import { Node, createYogaLayout, AnimationRuntime, defaultTheme as theme } from '@glassui/core'
import { SystemFontEngine } from '@glassui/text'
import { Surface, SURFACE_ORDER, type SurfaceContext } from '../src/surface/surface'
import { AtlasPages } from '../src/text/pages'
import { createMeasureFn } from '../src/text/measure'

let ctx: SurfaceContext
beforeAll(async () => {
  const text = new SystemFontEngine({ createCanvas: ((w: number, h: number) => createCanvas(w, h)) as never, pageSize: 512, maxPages: 2 })
  ctx = { theme, scheme: 'light', layout: await createYogaLayout(), measure: createMeasureFn(text, theme, 'light'), anim: new AnimationRuntime(theme, 'light'), text, pages: new AtlasPages(text.atlas), contrast: false, quality: { contentType: 'byte', contentScale: 1, backFaces: true, depthReject: true, blur: 'mip', glassMode: 'refract', dispersion: 'always' } }
})

const make = () => {
  const s = new Surface({ id: 'v', width: 400, height: 300, ptPerUnit: 100, placement: 'world' }, ctx)
  const card = new Node('box'); card.setStyle({ position: 'absolute', left: 40, top: 40, width: 200, height: 150, bg: 'glass', glass: { thickness: 12 } })
  const vp = new Node('box'); vp.setStyle({ position: 'absolute', left: 20, top: 20, width: 100, height: 80 })
  card.appendChild(vp); s.root.appendChild(card)
  const mat = new MeshStandardMaterial({ opacity: 0.8 })
  const mesh = new Mesh(new BoxGeometry(100, 80, 50), mat)
  return { s, card, vp, mesh, mat }
}

describe('Surface.attach3D', () => {
  it('anchors the object at the node centre on top of its glass, 1 unit = 1 pt', () => {
    const { s, vp, mesh } = make(); s.attach3D(vp, mesh); s.tick(1 / 60)
    const a = s.viewports.get(vp)!
    expect(a.anchor.parent).toBe(s.plane); expect(mesh.parent).toBe(a.anchor)
    expect(a.anchor.position.toArray().map(v => +v.toFixed(6))).toEqual([-0.9, 0.5, 0.12])   // centre (110, 100) pt; card glass 12 pt thick
    expect(a.anchor.scale.x).toBeCloseTo(0.01)
  })
  it('adopts the materials into the transparent queue and fades them with the Surface; detach restores', () => {
    const { s, vp, mesh, mat } = make(); const detach = s.attach3D(vp, mesh); s.tick(1 / 60)
    expect(mat.transparent).toBe(true); expect(mesh.renderOrder).toBe(SURFACE_ORDER.viewport); expect(mesh.castShadow).toBe(true)
    s.opacity = 0.5; s.tick(1 / 60); expect(mat.opacity).toBeCloseTo(0.4)
    detach()
    expect(mat.transparent).toBe(false); expect(mat.opacity).toBe(0.8); expect(mesh.renderOrder).toBe(0); expect(mesh.castShadow).toBe(false)
    expect(s.viewports.size).toBe(0); expect(mesh.parent).toBe(null)
  })
  it('calls update with the box size; true asks for a frame; a throw fails the Surface', () => {
    const { s, vp, mesh } = make(), update = vi.fn(() => true)
    s.attach3D(vp, mesh, { update }); s.tick(1 / 60)
    expect(update).toHaveBeenCalledWith(1 / 60, expect.objectContaining({ width: 100, height: 80, reducedMotion: false, scheme: 'light' }))
    expect(s.needsFrame).toBe(true)
    update.mockImplementation(() => { throw new Error('boom') }); s.tick(1 / 60); expect(s.error?.message).toBe('boom')
  })
  it('hides the anchor while the node is out of the tree; glassBounds covers depth', () => {
    const { s, card, vp, mesh } = make(); s.attach3D(vp, mesh, { depth: 50 }); s.tick(1 / 60)
    expect(s.glassBounds.max.z).toBeGreaterThanOrEqual(s.contentPlaneZ + 0.62 - 1e-6)
    card.removeChild(vp); s.tick(1 / 60); expect(s.viewports.get(vp)!.anchor.visible).toBe(false)
    card.appendChild(vp); s.tick(1 / 60); expect(s.viewports.get(vp)!.anchor.visible).toBe(true)
  })
  it('refuses what it cannot place', () => {
    const { s, vp, mesh } = make()
    const screen = new Surface({ width: 10, height: 10, ptPerUnit: 1, placement: 'screen' }, ctx)
    const n = new Node('box'); screen.root.appendChild(n)
    expect(() => screen.attach3D(n, mesh)).toThrow(/\[Surface\.attach3D\].*世界层/)
    expect(() => s.attach3D(new Node('box'), mesh)).toThrow(/不在这个 Surface/)
    s.attach3D(vp, mesh); expect(() => s.attach3D(vp, new Mesh())).toThrow(/已经挂了/)
    const other = new Node('box'); s.root.appendChild(other)
    expect(() => s.attach3D(other, {} as never)).toThrow(/Object3D/)
  })
  it('dispose restores the materials', () => {
    const { s, vp, mesh, mat } = make(); s.attach3D(vp, mesh); s.tick(1 / 60); s.dispose()
    expect(mat.transparent).toBe(false); expect(mesh.parent).toBe(null)
  })
  it('adopts meshes added later and lets go of meshes that leave; an opacity the owner sets becomes its own', () => {
    const { s, vp, mesh, mat } = make(); s.attach3D(vp, mesh); s.opacity = 0.5; s.tick(1 / 60)
    const late = new MeshStandardMaterial({ opacity: 0.6 }), child = new Mesh(new BoxGeometry(1, 1, 1), late)
    mesh.add(child); s.tick(1 / 60)
    expect([late.transparent, late.opacity, child.renderOrder, child.castShadow]).toEqual([true, 0.3, SURFACE_ORDER.viewport, true])
    mesh.remove(child); s.tick(1 / 60)
    expect([late.transparent, late.opacity, child.renderOrder, child.castShadow]).toEqual([false, 0.6, 0, false])
    mat.opacity = 0.2; s.tick(1 / 60); expect(mat.opacity).toBeCloseTo(0.1)
    s.opacity = 1; s.tick(1 / 60); expect(mat.opacity).toBeCloseTo(0.2)
  })
  it('a material two attachments share fades once, and goes back when the last one lets go', () => {
    const { s, card, vp, mesh, mat } = make()
    const vp2 = new Node('box'); vp2.setStyle({ position: 'absolute', left: 120, top: 20, width: 60, height: 60 }); card.appendChild(vp2)
    const twin = new Mesh(new BoxGeometry(1, 1, 1), mat)
    s.attach3D(vp, mesh); const detach2 = s.attach3D(vp2, twin)
    s.opacity = 0.5; for (let i = 0; i < 3; i++) s.tick(1 / 60)
    expect(mat.opacity).toBeCloseTo(0.4)
    detach2(); expect(mat.transparent).toBe(true); expect(twin.renderOrder).toBe(0)
    s.viewports.get(vp)!.dispose(); expect([mat.transparent, mat.opacity]).toEqual([false, 0.8])
  })
  it('the anchor and every Group inside the object carry the Surface\'s drawOrder (three sorts by the nearest Group first); detach restores', () => {
    const { s, vp, mesh } = make(), g = new Group(); g.renderOrder = 7; g.add(mesh)
    s.drawOrder = 3; const detach = s.attach3D(vp, g); s.tick(1 / 60)
    const a = s.viewports.get(vp)!
    expect([a.anchor.renderOrder, g.renderOrder, mesh.renderOrder]).toEqual([3, 3, SURFACE_ORDER.viewport])
    s.drawOrder = 5; expect([a.anchor.renderOrder, g.renderOrder]).toEqual([5, 5])
    const inner = new Group(); g.add(inner); s.tick(1 / 60); expect(inner.renderOrder).toBe(5)
    detach(); expect([g.renderOrder, inner.renderOrder, mesh.renderOrder]).toEqual([7, 0, 0])
  })
  it('fades what update writes and adopts what update adds, in the same tick', () => {
    const { s, vp, mesh, mat } = make(), late = new MeshStandardMaterial({ opacity: 0.5 }), added = new Mesh(new BoxGeometry(1, 1, 1), late)
    s.attach3D(vp, mesh, { update: () => { mat.opacity = 0.6; if (!added.parent) mesh.add(added); return false } }); s.opacity = 0.5
    s.tick(1 / 60)
    expect(mat.opacity).toBeCloseTo(0.3)
    expect([late.transparent, added.renderOrder, added.castShadow]).toEqual([true, SURFACE_ORDER.viewport, true]); expect(late.opacity).toBeCloseTo(0.25)
    s.tick(1 / 60); expect(mat.opacity).toBeCloseTo(0.3)
  })
  it('an update that detaches its own attachment leaves nothing adopted', () => {
    const { s, vp, mesh, mat } = make(); s.opacity = 0.5
    const detach = s.attach3D(vp, mesh, { update: () => { detach(); return false } }); s.tick(1 / 60)
    expect([mat.transparent, mat.opacity, mesh.renderOrder, mesh.parent]).toEqual([false, 0.8, 0, null]); expect(s.viewports.size).toBe(0)
  })
  it('skips update while the node is not shown; a stale detach leaves a new attachment alone', () => {
    const { s, card, vp, mesh } = make(), update = vi.fn(() => false)
    const detach = s.attach3D(vp, mesh, { update }); vp.setStyle({ display: 'none' }); s.tick(1 / 60)
    expect(s.viewports.get(vp)!.anchor.visible).toBe(false); expect(update).not.toHaveBeenCalled()
    detach(); const again = s.attach3D(vp, mesh); detach()
    expect(s.viewports.size).toBe(1); expect(mesh.parent).toBe(s.viewports.get(vp)!.anchor)
    again(); expect(s.viewports.size).toBe(0); expect(card.children).toContain(vp)
  })
})
