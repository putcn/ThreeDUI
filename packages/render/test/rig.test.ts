import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { PerspectiveCamera, Quaternion, Vector3 } from 'three'
import { createYogaLayout, AnimationRuntime, defaultTheme as theme } from '@glassui/core'
import { SystemFontEngine } from '@glassui/text'
import { Surface, type SurfaceContext } from '../src/surface/surface'
import { AtlasPages } from '../src/text/pages'
import { createMeasureFn } from '../src/text/measure'
import { CameraRig, fitDistance, focusPose } from '../src/rig'

let ctx: SurfaceContext
beforeAll(async () => {
  const text = new SystemFontEngine({ createCanvas: ((w: number, h: number) => createCanvas(w, h)) as never, pageSize: 512, maxPages: 2 })
  ctx = { theme, scheme: 'light', layout: await createYogaLayout(), measure: createMeasureFn(text, theme, 'light'), anim: new AnimationRuntime(theme, 'light'), text, pages: new AtlasPages(text.atlas), contrast: false, quality: { contentType: 'byte', contentScale: 1, backFaces: true, depthReject: true, blur: 'mip', glassMode: 'refract', dispersion: 'always' } }
})

const listeners = new Map<string, (e: unknown) => void>()
const canvas = {
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  addEventListener: (t: string, fn: (e: unknown) => void) => { listeners.set(t, fn) },
  removeEventListener: vi.fn((t: string) => { listeners.delete(t) }),
}
let aspect = 4 / 3, reduced = false
const camera = new PerspectiveCamera(50, aspect, 0.1, 100)
const rig = () => new CameraRig({ camera, canvas, aspect: () => aspect, reducedMotion: () => reduced })
const surface = (pos = [0, 0, 0], rotY = 0) => { const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, placement: 'world' }, ctx); s.position.set(pos[0]!, pos[1]!, pos[2]!); s.rotation.y = rotY; s.updateMatrixWorld(true); return s }
const run = (r: CameraRig, s: number) => { for (let t = 0; t < s; t += 1 / 60) r.update(1 / 60) }
const forward = () => new Vector3(0, 0, -1).applyQuaternion(camera.quaternion)

describe('CameraRig', () => {
  it('fitDistance fits the taller or the wider side with the margin', () => {
    expect(fitDistance(2, 4, 90, 1, 0)).toBeCloseTo(2)
    expect(fitDistance(8, 2, 90, 2, 0)).toBeCloseTo(2)
    expect(fitDistance(2, 4, 90, 1, 0.25)).toBeCloseTo(3)
  })
  it('focusPose faces the Surface square-on along its normal', () => {
    const out = { position: new Vector3(), quaternion: new Quaternion() }
    focusPose(surface([1, 2, 0]), 50, 4 / 3, 0.08, out)
    expect(out.position.x).toBeCloseTo(1); expect(out.position.y).toBeCloseTo(2)
    expect(out.position.z).toBeCloseTo(fitDistance(4, 3, 50, 4 / 3, 0.08))   // no glass background: contentPlaneZ is 0
    const s = surface([0, 0, 0], -0.6); focusPose(s, 50, 4 / 3, 0.08, out)
    const n = new Vector3(Math.sin(-0.6), 0, Math.cos(-0.6))
    expect(out.position.clone().normalize().dot(n)).toBeCloseTo(1)
    expect(new Vector3(0, 0, -1).applyQuaternion(out.quaternion).dot(n)).toBeCloseTo(-1)
  })
  it('aims at the rest pose of a Surface still flying in', () => {
    const s = surface(); void s.animateTo({ position: [3, 0, 0] })
    const out = { position: new Vector3(), quaternion: new Quaternion() }
    focusPose(s, 50, 4 / 3, 0.08, out); expect(out.position.x).toBeCloseTo(3)
  })
  it('springs to the focus pose without overshoot and resolves true', async () => {
    camera.position.set(-5, 0, 5); camera.quaternion.identity()
    const r = rig(), s = surface(), done = r.focus(s)
    const goal = { position: new Vector3(), quaternion: new Quaternion() }; focusPose(s, 50, aspect, 0.08, goal)
    let last = Infinity
    for (let i = 0; i < 240; i++) { r.update(1 / 60); const d = camera.position.distanceTo(goal.position); expect(d).toBeLessThanOrEqual(last + 1e-9); last = d }
    expect(last).toBeLessThan(1e-3); await expect(done).resolves.toBe(true)
  })
  it('a second focus resolves the first false and does not jump', async () => {
    camera.position.set(0, 0, 8); const r = rig(), a = surface([0, 0, 0]), b = surface([4, 0, 0])
    const first = r.focus(a); run(r, 0.1)
    const p0 = camera.position.clone(); const second = r.focus(b); r.update(1 / 60)
    expect(camera.position.distanceTo(p0)).toBeLessThan(0.5)                  // one frame's travel, not a cut to b
    await expect(first).resolves.toBe(false); run(r, 4); await expect(second).resolves.toBe(true)
  })
  it('immediate and reduced motion jump to the pose', async () => {
    const r = rig(), s = surface([2, 0, 0]), goal = { position: new Vector3(), quaternion: new Quaternion() }
    focusPose(s, 50, aspect, 0.08, goal)
    const p = r.focus(s, { immediate: true }); r.update(1 / 60)
    expect(camera.position.distanceTo(goal.position)).toBeLessThan(1e-9); await expect(p).resolves.toBe(true)
    reduced = true
    try { const s2 = surface([-2, 0, 0]); void r.focus(s2); r.update(1 / 60); focusPose(s2, 50, aspect, 0.08, goal); expect(camera.position.distanceTo(goal.position)).toBeLessThan(1e-9) }
    finally { reduced = false }
  })
  it('refits when the aspect changes', () => {
    const r = rig(), s = surface(); void r.focus(s, { immediate: true }); r.update(1 / 60)
    aspect = 0.5; run(r, 4)
    expect(camera.position.z).toBeCloseTo(fitDistance(4, 3, 50, 0.5, 0.08), 3); aspect = 4 / 3
  })
  it('parallax orbits the centre with a mouse, not with touch, and returns on leave', () => {
    const r = rig(), s = surface(); void r.focus(s, { immediate: true }); r.update(1 / 60)
    listeners.get('pointermove')!({ clientX: 800, clientY: 300, pointerType: 'mouse' }); run(r, 3)
    expect(camera.position.x).toBeGreaterThan(0.05)
    expect(forward().dot(new Vector3().sub(camera.position).normalize())).toBeCloseTo(1, 5)   // still looking at the centre
    listeners.get('pointerleave')!({}); run(r, 3); expect(Math.abs(camera.position.x)).toBeLessThan(1e-3)
    listeners.get('pointermove')!({ clientX: 800, clientY: 300, pointerType: 'touch' }); run(r, 3); expect(Math.abs(camera.position.x)).toBeLessThan(1e-3)
    r.parallax = false; listeners.get('pointermove')!({ clientX: 800, clientY: 300, pointerType: 'mouse' }); run(r, 3); expect(Math.abs(camera.position.x)).toBeLessThan(1e-3)
  })
  it('a target that goes away resolves false and the camera stays', async () => {
    const r = rig(), s = surface([3, 0, 0]), done = r.focus(s); run(r, 0.1)
    s.dispose(); r.update(1 / 60); const p = camera.position.clone(); run(r, 1)
    await expect(done).resolves.toBe(false); expect(camera.position.equals(p)).toBe(true)
  })
  it('dispose stops writing the camera and removes its listeners', () => {
    const r = rig(), s = surface(); void r.focus(s); r.dispose()
    const p = camera.position.clone(); r.update(1 / 60)
    expect(camera.position.equals(p)).toBe(true); expect(r.disposed).toBe(true); expect(listeners.size).toBe(0)
  })

  it('pitch follows the pointer up and down, and the pointer maps from the canvas rect', () => {
    const r = rig(), s = surface(); void r.focus(s, { immediate: true }); r.update(1 / 60)
    listeners.get('pointermove')!({ clientX: 400, clientY: 0, pointerType: 'pen' }); run(r, 3)   // top centre: px 0, py 1
    const d = fitDistance(4, 3, 50, aspect, 0.08), a = 2.5 * Math.PI / 180
    expect(camera.position.x).toBeCloseTo(0, 6); expect(camera.position.y).toBeCloseTo(d * Math.sin(a), 6); expect(camera.position.z).toBeCloseTo(d * Math.cos(a), 6)
    expect(forward().dot(new Vector3().sub(camera.position).normalize())).toBeCloseTo(1, 6)
    r.dispose()
  })
  it('a dead target, a disposed rig and dispose itself end the focus false; dispose is idempotent', async () => {
    const r = rig(), dead = surface(); dead.dispose()
    await expect(r.focus(dead)).resolves.toBe(false); expect(r.target).toBeNull()
    const s = surface(), pending = r.focus(s); expect(r.target).toBe(s)
    r.dispose(); r.dispose()
    await expect(pending).resolves.toBe(false); expect(r.target).toBeNull()
    await expect(r.focus(s)).resolves.toBe(false)
  })
  it('a zero-size canvas leaves the camera alone until it has a size again', async () => {
    const r = rig(), s = surface([1, 0, 0]); camera.position.set(0, 0, 9)
    const done = r.focus(s, { immediate: true })
    aspect = NaN
    try { r.update(1 / 60); expect(camera.position.toArray()).toEqual([0, 0, 9]) } finally { aspect = 4 / 3 }
    r.update(1 / 60); expect(camera.position.x).toBeCloseTo(1); await expect(done).resolves.toBe(true)
    r.dispose()
  })
  it('rejects a screen Surface and bad options with readable errors', () => {
    const r = rig(), screen = new Surface({ width: 100, height: 100, placement: 'screen' }, ctx)
    expect(() => r.focus(screen)).toThrow(/\[CameraRig\.focus\].*世界层/)
    r.dispose()
    expect(() => new CameraRig({ camera, canvas, aspect: () => aspect, reducedMotion: () => reduced }, { response: 0 })).toThrow(/\[CameraRig\.response\]/)
    expect(() => new CameraRig({ camera, canvas, aspect: () => aspect, reducedMotion: () => reduced }, { margin: -0.1 })).toThrow(/\[CameraRig\.margin\]/)
    expect(() => new CameraRig({ camera, canvas, aspect: () => aspect, reducedMotion: () => reduced }, { parallax: NaN })).toThrow(/\[CameraRig\.parallax\]/)
    expect(() => new CameraRig({ camera, canvas, aspect: () => aspect, reducedMotion: () => reduced }, { parallaxResponse: Infinity })).toThrow(/\[CameraRig\.parallaxResponse\]/)
  })
})
