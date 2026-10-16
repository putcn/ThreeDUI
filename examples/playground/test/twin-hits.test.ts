import { describe, it, expect, beforeAll } from 'vitest'
import { Matrix4, PerspectiveCamera, Raycaster, Vector2, Vector3, type Material, type Mesh } from 'three'
import { AnimationRuntime, createYogaLayout, defaultTheme as theme, Node } from '@glassui/core'
import { SystemFontEngine, type CanvasFactory } from '@glassui/text'
import { AtlasPages, createMeasureFn, hitSurfaces, Surface, type SurfaceContext } from '@glassui/render/internal'
import { napiCanvas } from '../../../packages/vue/test/fixtures/mount'
import { bins } from '../src/wms/data'
import { createWarehouse } from '../src/wms/warehouse'

let ctx: SurfaceContext
beforeAll(async () => {
  const text = new SystemFontEngine({ createCanvas: napiCanvas as unknown as CanvasFactory, pageSize: 256 })
  ctx = { theme, scheme: 'light', layout: await createYogaLayout(), measure: createMeasureFn(text, theme, 'light'), anim: new AnimationRuntime(theme, 'light'), text, pages: new AtlasPages(text.atlas), contrast: false, quality: { contentType: 'byte', contentScale: 1, backFaces: false, depthReject: false, blur: 'mip', glassMode: 'refract', dispersion: 'always' } }
})

/** The twin's model attached to a real world Surface the size of its Viewport3D (1200 × 680 pt), seen from where the rig would stand. */
function twin() {
  const s = new Surface({ id: 'twin', width: 1200, height: 680, ptPerUnit: 244, placement: 'world' }, ctx)
  const vp = new Node('box'); vp.setStyle({ position: 'absolute', left: 0, top: 0, width: 1200, height: 680 })
  s.root.appendChild(vp)
  const w = createWarehouse({ bins })
  s.attach3D(vp, w.group, { update: (dt, c) => w.update(dt, c), depth: 460 })
  s.tick(0); s.updateMatrixWorld(true)
  const camera = new PerspectiveCamera(38, 16 / 9, 0.1, 50); camera.position.set(0, 0, 6.2); camera.updateMatrixWorld(true)
  return { s, w, vp, camera }
}

describe('the twin on a render Surface', () => {
  it('a ray at a bin hits that bin: the hit names the bins mesh and the instance, and binAt gives the bin', () => {
    const { s, w, vp, camera } = twin(), rc = new Raycaster(), m = new Matrix4(), p = new Vector3()
    // the top level of the front row (F), every bay: nothing stands in front of those
    for (let bay = 0; bay < 10; bay++) {
      const i = 5 * 40 + bay * 4 + 3
      w.bins.getMatrixAt(i, m); p.setFromMatrixPosition(m).applyMatrix4(w.bins.matrixWorld).project(camera)
      rc.setFromCamera(new Vector2(p.x, p.y), camera)
      const hit = hitSurfaces(rc, [s])!
      expect(hit.target).toEqual({ node: vp, object: w.bins, instanceId: i, point: expect.any(Array) })
      // the hit point (anchor pt) is on that bin: within half its diagonal (30 × 15 × 22 model pt, scaled to fit) of its centre
      w.bins.getMatrixAt(i, m)
      const centre = s.viewports.get(vp)!.anchor.worldToLocal(new Vector3().setFromMatrixPosition(m).applyMatrix4(w.bins.matrixWorld))
      expect(new Vector3(...hit.target!.point!).distanceTo(centre)).toBeLessThan(Math.hypot(30, 15, 22) / 2)
      expect(w.binAt(hit.target!.instanceId!).id).toBe(`F-${String(bay + 1).padStart(2, '0')}-4`)
    }
  })
  it('across the box, most bins can be hit; the model is adopted (transparent queue, shadows) without a throw', () => {
    const { s, w, camera } = twin(), rc = new Raycaster(), seen = new Set<number>()
    for (let x = -1; x <= 1; x += 0.02) for (let y = -0.7; y <= 0.7; y += 0.015) {
      rc.setFromCamera(new Vector2(x, y), camera)
      const t = hitSurfaces(rc, [s])?.target
      if (t?.object === w.bins && t.instanceId !== undefined) seen.add(t.instanceId)
    }
    expect(seen.size).toBeGreaterThan(160)                                         // the low levels of the back rows hide behind the row in front
    w.group.traverse(o => {
      const mat = (o as Mesh).material as Material | undefined
      if (!mat) return
      expect(mat.transparent).toBe(true); expect(o.castShadow).toBe(true)
    })
  })
})
