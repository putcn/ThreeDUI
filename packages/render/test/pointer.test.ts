import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { Object3D, PerspectiveCamera, Ray, Raycaster, Vector2, Vector3 } from 'three'
import { Node, createYogaLayout, AnimationRuntime, defaultTheme as theme } from '@glassui/core'
import { SystemFontEngine } from '@glassui/text'
import { Surface, type SurfaceContext } from '../src/surface/surface'
import { ScreenLayer } from '../src/surface/screen'
import { AtlasPages } from '../src/text/pages'
import { createMeasureFn } from '../src/text/measure'
import { PointerBridge, hitSurfaces, applyWheel, pointOnSurfacePlane } from '../src/pointer'

let ctx: SurfaceContext
beforeAll(async () => {
  const text = new SystemFontEngine({ createCanvas: ((w: number, h: number) => createCanvas(w, h)) as never, pageSize: 256 })
  ctx = { theme, scheme: 'light', layout: await createYogaLayout(), measure: createMeasureFn(text, theme, 'light'), anim: new AnimationRuntime(theme, 'light'), text, pages: new AtlasPages(text.atlas), quality: { contentType: 'byte', contentScale: 1, backFaces: false, depthReject: false } }
})

function fakeCanvas() {
  return { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), addEventListener: vi.fn(), removeEventListener: vi.fn(), setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), tabIndex: -1 }
}

function scene() {
  const camera = new PerspectiveCamera(50, 800 / 600, 0.1, 100); camera.updateMatrixWorld(true)
  const layer = new ScreenLayer()
  const s = new Surface({ id: 's', width: 10, height: 10, ptPerUnit: 1 }, ctx)
  layer.add(s); layer.place(s, { fill: true }); layer.update(camera, { width: 800, height: 600 }); layer.updateMatrixWorld(true)
  const btn = new Node('glass', 'btn'); btn.setStyle({ position: 'absolute', left: 100, top: 100, width: 200, height: 80 }); btn.setProp('tabIndex', 0)
  s.root.appendChild(btn); s.tick(0)
  const canvas = fakeCanvas()
  const bridge = new PointerBridge({ canvas, camera, surfaces: () => [s], keyboard: true })
  return { camera, s, btn, canvas, bridge }
}

/** Two coplanar screen Surfaces: `a` fills the viewport, `b` (200×100 px at 400, 300) draws above it. */
function two() {
  const camera = new PerspectiveCamera(50, 800 / 600, 0.1, 100); camera.updateMatrixWorld(true)
  const layer = new ScreenLayer()
  const a = new Surface({ id: 'a', width: 10, height: 10, ptPerUnit: 1 }, ctx)
  const b = new Surface({ id: 'b', width: 200, height: 100, ptPerUnit: 1 }, ctx)
  layer.place(a, { fill: true }); layer.place(b, { left: 400, top: 300 })
  a.drawOrder = 0; b.drawOrder = 1
  layer.update(camera, { width: 800, height: 600 })
  const ab = new Node('glass', 'ab'); ab.setStyle({ position: 'absolute', left: 50, top: 50, width: 200, height: 100 })
  const bb = new Node('glass', 'bb'); bb.setStyle({ position: 'absolute', left: 0, top: 0, width: 200, height: 100 })
  a.root.appendChild(ab); b.root.appendChild(bb); a.tick(0); b.tick(0)
  const canvas = fakeCanvas()
  const list = [a, b]
  const bridge = new PointerBridge({ canvas, camera, surfaces: () => list, keyboard: true })
  return { camera, layer, a, b, ab, bb, canvas, bridge, list }
}

function rayAt(camera: PerspectiveCamera, x: number, y: number): Raycaster {
  const rc = new Raycaster(); rc.setFromCamera(new Vector2((x / 800) * 2 - 1, -((y / 600) * 2 - 1)), camera)
  return rc
}

describe('hitSurfaces', () => {
  it('converts a ray through the canvas into surface pt', () => {
    const { camera, s } = scene()
    const rc = new Raycaster(); rc.setFromCamera(new Vector2((200 / 800) * 2 - 1, -((140 / 600) * 2 - 1)), camera)
    const hit = hitSurfaces(rc, [s])!
    expect(hit.surface).toBe(s); expect(hit.x).toBeCloseTo(200, 3); expect(hit.y).toBeCloseTo(140, 3)
    expect(pointOnSurfacePlane(rc.ray, s)![0]).toBeCloseTo(200, 3)
    s.interactive = false
    expect(hitSurfaces(rc, [s])).toBeNull()
  })
  it('coplanar Surfaces resolve by drawOrder (the one drawn on top), whatever the list order', () => {
    const { camera, a, b } = two()
    const rc = rayAt(camera, 450, 350)
    expect(hitSurfaces(rc, [a, b])!.surface).toBe(b); expect(hitSurfaces(rc, [b, a])!.surface).toBe(b)
    const hit = hitSurfaces(rc, [a, b])!
    expect(hit.x).toBeCloseTo(50, 3); expect(hit.y).toBeCloseTo(50, 3)
    a.drawOrder = 2
    expect(hitSurfaces(rc, [a, b])!.surface).toBe(a); expect(hitSurfaces(rc, [b, a])!.surface).toBe(a)
  })
  it('skips hidden (also through an ancestor), failed and non-interactive Surfaces', () => {
    const { camera, layer, a, b } = two()
    const rc = rayAt(camera, 450, 350)
    b.visible = false; expect(hitSurfaces(rc, [a, b])!.surface).toBe(a); b.visible = true
    b.error = new Error('boom'); expect(hitSurfaces(rc, [a, b])!.surface).toBe(a); b.error = null
    b.interactive = false; expect(hitSurfaces(rc, [a, b])!.surface).toBe(a); b.interactive = true
    layer.visible = false; expect(hitSurfaces(rc, [a, b])).toBeNull()
  })
  it('the nearest Surface wins over a higher drawOrder behind it', () => {
    const far = new Surface({ width: 400, height: 400, ptPerUnit: 100 }, ctx), near = new Surface({ width: 400, height: 400, ptPerUnit: 100 }, ctx)
    far.position.z = -6; near.position.z = -3; far.drawOrder = 5; near.drawOrder = 0
    const world = new Object3D(); world.add(far, near); world.updateMatrixWorld(true)
    const rc = new Raycaster(new Vector3(0, 0, 0), new Vector3(0, 0, -1))
    const hit = hitSurfaces(rc, [far, near])!
    expect(hit.surface).toBe(near); expect(hit.distance).toBeCloseTo(3, 9); expect(hit.x).toBeCloseTo(200, 6); expect(hit.y).toBeCloseTo(200, 6)
  })
})

describe('pointOnSurfacePlane', () => {
  /** A tilted glass-background Surface (its content plane lifted by the slab) 5 units in front of the origin. */
  function tilted() {
    const s = new Surface({ width: 400, height: 200, ptPerUnit: 100, background: 'glass' }, ctx)
    s.position.set(0.5, 0.2, -5); s.rotation.set(0.2, 0.6, 0.1); s.updateMatrixWorld(true)
    /** World point of Surface pt (x, y) on the content plane. */
    const at = (x: number, y: number) => new Vector3(x / 100 - 2, 1 - y / 100, s.contentPlaneZ).applyMatrix4(s.matrixWorld)
    return { s, at }
  }
  it('meets the CONTENT plane (lifted by a glass background), not the Surface origin plane', () => {
    const { s, at } = tilted()
    expect(s.contentPlaneZ).toBeGreaterThan(0)
    const rc = new Raycaster(new Vector3(0, 0, 0), at(100, 50).normalize())
    const hit = hitSurfaces(rc, [s])!
    expect(hit.x).toBeCloseTo(100, 6); expect(hit.y).toBeCloseTo(50, 6)
    const p = pointOnSurfacePlane(rc.ray, s)!
    expect(p[0]).toBeCloseTo(100, 6); expect(p[1]).toBeCloseTo(50, 6)
  })
  it('also outside the rect, where the quad is missed', () => {
    const { s, at } = tilted()
    const rc = new Raycaster(new Vector3(0, 0, 0), at(-50, 300).normalize())
    expect(hitSurfaces(rc, [s])).toBeNull()
    const p = pointOnSurfacePlane(rc.ray, s)!
    expect(p[0]).toBeCloseTo(-50, 6); expect(p[1]).toBeCloseTo(300, 6)
  })
  it('null for a ray pointing away from the plane or parallel to it', () => {
    const { s, at } = tilted()
    expect(pointOnSurfacePlane(new Ray(new Vector3(0, 0, 0), at(100, 50).normalize().negate()), s)).toBeNull()
    const flat = new Surface({ width: 400, height: 200, ptPerUnit: 100 }, ctx)
    flat.position.z = -5; flat.updateMatrixWorld(true)
    expect(pointOnSurfacePlane(new Ray(new Vector3(0, 0, 0), new Vector3(1, 0, 0)), flat)).toBeNull()
  })
})

describe('applyWheel', () => {
  it('chains per axis to the nearest scroll ancestor that can move that way', () => {
    const s = new Surface({ width: 400, height: 400, ptPerUnit: 1 }, ctx)
    const outer = new Node('scroll', 'outer'); outer.setStyle({ position: 'absolute', left: 0, top: 0, width: 400, height: 100 })
    const inner = new Node('scroll', 'inner'); inner.setStyle({ height: 50, flexShrink: 0, flexDirection: 'row' })
    const wide = new Node('box', 'wide'); wide.setStyle({ width: 1000, height: 50, flexShrink: 0 })
    const filler = new Node('box', 'filler'); filler.setStyle({ height: 400, flexShrink: 0 })
    inner.appendChild(wide); outer.appendChild(inner); outer.appendChild(filler); s.root.appendChild(outer); s.tick(0)
    expect(applyWheel(wide, 0, 100)).toBe(true)                  // inner has no vertical room: the outer list scrolls
    expect(outer.props.scrollY).toBe(100); expect(inner.props.scrollY).toBeUndefined()
    expect(applyWheel(wide, 100, 30)).toBe(true)                 // x stays inside, y goes out
    expect(inner.props.scrollX).toBe(100); expect(outer.props.scrollY).toBe(130); expect(outer.props.scrollX).toBeUndefined()
    expect(applyWheel(wide, 0, 1000)).toBe(true); expect(outer.props.scrollY).toBe(350)   // 50 + 400 − 100
    expect(applyWheel(wide, 0, 1)).toBe(false)                   // every scroll node is at its end
    expect(applyWheel(s.root, 0, 50)).toBe(false)                // no scroll node above
  })
  it('treats a non-finite offset or delta as 0', () => {
    const s = new Surface({ width: 400, height: 400, ptPerUnit: 1 }, ctx)
    const list = new Node('scroll', 'list'); list.setStyle({ position: 'absolute', left: 0, top: 0, width: 400, height: 100 })
    const tall = new Node('box', 'tall'); tall.setStyle({ height: 500, flexShrink: 0 }); list.appendChild(tall); s.root.appendChild(list); s.tick(0)
    list.setProp('scrollY', 'abc')
    expect(applyWheel(tall, 0, 40)).toBe(true); expect(list.props.scrollY).toBe(40)
    expect(applyWheel(tall, Number.NaN, Number.POSITIVE_INFINITY)).toBe(false); expect(list.props.scrollY).toBe(40)
  })
})

describe('PointerBridge.handle', () => {
  it('routes move/down/up into the surface tracker and emits click', () => {
    const { s, btn, bridge, canvas } = scene()
    const click = vi.fn(); s.events.on(btn, 'click', click)
    bridge.handle('pointermove', { clientX: 200, clientY: 140, pointerType: 'mouse' })
    expect(btn.state.hover).toBe(true)
    bridge.handle('pointerdown', { clientX: 200, clientY: 140, pointerType: 'mouse', pointerId: 1 })
    expect(btn.state.pressed).toBe(true); expect(bridge.active).toBe(s); expect(canvas.setPointerCapture).toHaveBeenCalledWith(1)
    bridge.handle('pointerup', { clientX: 200, clientY: 140, pointerType: 'mouse', pointerId: 1 })
    expect(click).toHaveBeenCalledTimes(1); expect(btn.state.pressed).toBe(false)
    expect(canvas.releasePointerCapture).toHaveBeenCalledWith(1)
  })
  it('clears hover when the pointer leaves every surface', () => {
    const { btn, bridge } = scene()
    bridge.handle('pointermove', { clientX: 200, clientY: 140 })
    bridge.handle('pointermove', { clientX: 2000, clientY: 2000 })
    expect(btn.state.hover).toBe(false); expect(bridge.hovered).toBeNull()
  })
  it('keyboard goes to the active surface focus manager', () => {
    const { s, btn, bridge } = scene()
    bridge.handle('pointerdown', { clientX: 200, clientY: 140, pointerId: 1 }); bridge.handle('pointerup', { clientX: 200, clientY: 140, pointerId: 1 })
    bridge.handle('keydown', { key: 'Tab' })
    expect(s.focus.current).toBe(btn)
    const onKey = vi.fn(); s.events.on(btn, 'keydown', onKey)
    bridge.handle('keydown', { key: 'Escape' })
    expect(onKey).toHaveBeenCalledTimes(1); expect(onKey.mock.calls[0]![0].key).toBe('Escape')
  })
  it('wheel scrolls the nearest scroll node and dispatches wheel', () => {
    const { s, bridge } = scene()
    const list = new Node('scroll', 'list'); list.setStyle({ position: 'absolute', left: 0, top: 300, width: 400, height: 100 })
    // flexShrink 0: core's yoga shrinks like CSS (default 1), which would fit `tall` into the 100 pt viewport
    const tall = new Node('box', 'tall'); tall.setStyle({ height: 500, flexShrink: 0 }); list.appendChild(tall); s.root.appendChild(list); s.tick(0)
    const onWheel = vi.fn(); s.events.on(list, 'wheel', onWheel)
    bridge.handle('pointermove', { clientX: 50, clientY: 350 })
    const prevent = vi.fn()
    bridge.handle('wheel', { clientX: 50, clientY: 350, deltaY: 120, preventDefault: prevent })
    expect(list.props.scrollY).toBe(120); expect(onWheel).toHaveBeenCalledTimes(1); expect(prevent).toHaveBeenCalled()
    bridge.handle('wheel', { clientX: 50, clientY: 350, deltaY: 10000 })
    expect(list.props.scrollY).toBe(400)
    expect(applyWheel(tall, 0, -10000)).toBe(true); expect(list.props.scrollY).toBe(0)
  })
  it('the wheel event carries the pointer position and deltas; nothing scrolled → no preventDefault', () => {
    const { s, btn, bridge } = scene()
    const seen = vi.fn(); s.events.on(s.root, 'wheel', seen)
    bridge.handle('pointermove', { clientX: 200, clientY: 140 })
    const prevent = vi.fn()
    bridge.handle('wheel', { clientX: 200, clientY: 140, deltaX: 3, deltaY: 7, preventDefault: prevent })
    expect(prevent).not.toHaveBeenCalled()
    const e = seen.mock.calls[0]![0]
    expect(e.target).toBe(btn); expect(e.deltaX).toBe(3); expect(e.deltaY).toBe(7); expect(e.x).toBeCloseTo(200, 3); expect(e.y).toBeCloseTo(140, 3)
  })
  it('a press captures the pointer: moves off the quad or over another Surface stay on the pressed Surface', () => {
    const { a, b, ab, bb, bridge } = two()
    const click = vi.fn(); a.events.on(ab, 'click', click)
    const moves: [number, number][] = []; a.events.on(a.root, 'pointermove', e => { moves.push([e.x, e.y]) })
    bridge.handle('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 })
    bridge.handle('pointermove', { clientX: 450, clientY: 350, pointerId: 1 })   // over b, which draws above a
    expect(bb.state.hover).toBe(false); expect(bridge.hovered).toBe(a)
    expect(moves.at(-1)![0]).toBeCloseTo(450, 3); expect(moves.at(-1)![1]).toBeCloseTo(350, 3)
    expect(ab.state.hover).toBe(false); expect(ab.state.pressed).toBe(true)
    bridge.handle('pointermove', { clientX: 2000, clientY: -500, pointerId: 1 })   // off the canvas: a's plane, outside its rect
    expect(a.root.state.hover).toBe(false); expect(ab.state.pressed).toBe(true); expect(bridge.hovered).toBe(a)
    bridge.handle('pointermove', { clientX: 100, clientY: 100, pointerId: 1 })
    expect(ab.state.hover).toBe(true)
    bridge.handle('pointerup', { clientX: 100, clientY: 100, pointerId: 1 })
    expect(click).toHaveBeenCalledTimes(1)
    bridge.handle('pointermove', { clientX: 450, clientY: 350 })                 // released: hover follows the pointer again
    expect(bb.state.hover).toBe(true); expect(bridge.hovered).toBe(b); expect(a.root.state.hover).toBe(false)
  })
  it('an up off the pressed Surface lands on its plane (no click on the pressed node) and leaves it unhovered', () => {
    const { a, ab, bridge } = two()
    const click = vi.fn(); a.events.on(ab, 'click', click)
    const ups: number[] = []; a.events.on(a.root, 'pointerup', e => { ups.push(e.x) })
    bridge.handle('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 })
    bridge.handle('pointerup', { clientX: 450, clientY: 350, pointerId: 1 })   // over b
    expect(click).not.toHaveBeenCalled(); expect(ab.state.pressed).toBe(false)
    expect(ups).toHaveLength(1); expect(ups[0]).toBeCloseTo(450, 3)
    expect(bridge.hovered).toBeNull(); expect(a.root.state.hover).toBe(false)
  })
  it('a stray up (no press) goes to the Surface under the pointer', () => {
    const { b, bb, bridge } = two()
    const ups = vi.fn(); b.events.on(bb, 'pointerup', ups)
    bridge.handle('pointerup', { clientX: 450, clientY: 350, pointerId: 1 })
    expect(ups).toHaveBeenCalledTimes(1); expect(bridge.hovered).toBe(b); expect(bb.state.hover).toBe(true)
  })
  it('a down on another Surface while a press is held (its up was lost) cancels that press', () => {
    const { a, ab, bb, bridge } = two()
    const cancel = vi.fn(); a.events.on(ab, 'pointercancel', cancel)
    bridge.handle('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 })
    bridge.handle('pointerdown', { clientX: 450, clientY: 350, pointerId: 1 })
    expect(cancel).toHaveBeenCalledTimes(1); expect(ab.state.pressed).toBe(false); expect(bb.state.pressed).toBe(true)
  })
  it('forget drops a removed Surface: its capture, hover and keys', () => {
    const { a, b, bb, bridge } = two()
    bridge.handle('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 })
    bridge.forget(b); expect(bridge.active).toBe(a)
    bridge.forget(a)
    expect(bridge.active).toBeNull(); expect(bridge.hovered).toBeNull()
    bridge.handle('pointermove', { clientX: 450, clientY: 350, pointerId: 1 })   // no capture left: hover follows
    expect(bridge.hovered).toBe(b); expect(bb.state.hover).toBe(true)
  })
  it('ignores secondary pointers and non-primary buttons', () => {
    const { s, btn, bridge } = scene()
    const click = vi.fn(); s.events.on(btn, 'click', click)
    bridge.handle('pointerdown', { clientX: 200, clientY: 140, pointerId: 1, button: 2 })
    expect(btn.state.pressed).toBe(false); expect(bridge.active).toBeNull()
    bridge.handle('pointerdown', { clientX: 200, clientY: 140, pointerId: 1, pointerType: 'touch', button: 0, isPrimary: true })
    bridge.handle('pointerdown', { clientX: 600, clientY: 500, pointerId: 2, pointerType: 'touch', isPrimary: false })
    bridge.handle('pointermove', { clientX: 600, clientY: 500, pointerId: 2, pointerType: 'touch', isPrimary: false })
    bridge.handle('pointerup', { clientX: 600, clientY: 500, pointerId: 2, pointerType: 'touch', isPrimary: false })
    expect(btn.state.pressed).toBe(true); expect(btn.state.hover).toBe(true)
    bridge.handle('pointerup', { clientX: 200, clientY: 140, pointerId: 1, pointerType: 'touch', button: 0, isPrimary: true })
    expect(click).toHaveBeenCalledTimes(1); expect(click.mock.calls[0]![0].pointerType).toBe('touch')
  })
  it('canvas pointerleave clears hover, unless a press holds the capture', () => {
    const { btn, bridge } = scene()
    bridge.handle('pointermove', { clientX: 200, clientY: 140 })
    bridge.handle('pointerleave', {})
    expect(btn.state.hover).toBe(false); expect(bridge.hovered).toBeNull()
    bridge.handle('pointerdown', { clientX: 200, clientY: 140, pointerId: 1 })
    bridge.handle('pointerleave', {})
    expect(btn.state.hover).toBe(true); expect(btn.state.pressed).toBe(true)
  })
  it('pointercancel drops the press and the hover', () => {
    const { s, btn, bridge } = scene()
    const cancel = vi.fn(); s.events.on(btn, 'pointercancel', cancel)
    const click = vi.fn(); s.events.on(btn, 'click', click)
    bridge.handle('pointerdown', { clientX: 200, clientY: 140, pointerId: 1 })
    bridge.handle('pointercancel', { pointerId: 1 })
    expect(cancel).toHaveBeenCalledTimes(1); expect(btn.state.pressed).toBe(false); expect(btn.state.hover).toBe(false); expect(bridge.hovered).toBeNull()
    bridge.handle('pointerup', { clientX: 200, clientY: 140, pointerId: 1 })
    expect(click).not.toHaveBeenCalled()
  })
  it('Shift+Tab, Tab preventDefault only when focus landed, and activating another Surface blurs the old focus', () => {
    const { a, b, ab, bridge } = two()
    const ac = new Node('glass', 'ac'); ac.setStyle({ position: 'absolute', left: 300, top: 50, width: 100, height: 100 })
    a.root.appendChild(ac); a.tick(0)
    ab.setProp('tabIndex', 0); ac.setProp('tabIndex', 0)
    bridge.handle('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 }); bridge.handle('pointerup', { clientX: 100, clientY: 100, pointerId: 1 })
    const prevent = vi.fn()
    bridge.handle('keydown', { key: 'Tab', shiftKey: true, preventDefault: prevent })
    expect(a.focus.current).toBe(ac); expect(prevent).toHaveBeenCalledTimes(1)   // Shift+Tab from nothing: the last
    const esc = vi.fn(); a.events.on(ac, 'keydown', esc)
    const preventEsc = vi.fn()
    bridge.handle('keydown', { key: 'Escape', preventDefault: preventEsc })
    expect(esc).toHaveBeenCalledTimes(1); expect(preventEsc).not.toHaveBeenCalled()
    bridge.handle('pointerdown', { clientX: 450, clientY: 350, pointerId: 1 })    // b has nothing to focus
    expect(bridge.active).toBe(b); expect(a.focus.current).toBeNull(); expect(ac.state.focused).toBe(false)
    bridge.handle('pointerup', { clientX: 450, clientY: 350, pointerId: 1 })
    const preventB = vi.fn()
    bridge.handle('keydown', { key: 'Tab', preventDefault: preventB })
    expect(preventB).not.toHaveBeenCalled()                                         // Tab may leave the canvas
    bridge.handle('pointerdown', { clientX: 2000, clientY: 2000, pointerId: 1 })
    expect(bridge.active).toBeNull()
    bridge.handle('keydown', { key: 'Tab' })                                        // no active Surface: dropped
    expect(a.focus.current).toBeNull()
  })
  it('attach wires the DOM events and sets tabIndex', () => {
    const { bridge, canvas } = scene()
    bridge.attach()
    expect(canvas.tabIndex).toBe(0)
    expect(canvas.addEventListener.mock.calls.map(c => c[0]).sort()).toEqual(['keydown', 'keyup', 'pointercancel', 'pointerdown', 'pointerleave', 'pointermove', 'pointerup', 'wheel'])
    bridge.attach()                                                                  // idempotent
    expect(canvas.addEventListener).toHaveBeenCalledTimes(8)
    bridge.detach()
    expect(canvas.removeEventListener).toHaveBeenCalledTimes(8)
    expect(canvas.tabIndex).toBe(-1)
  })
  it('the attached listeners drive handle', () => {
    const { btn, bridge, canvas } = scene()
    bridge.attach()
    const move = canvas.addEventListener.mock.calls.find(c => c[0] === 'pointermove')![1] as (e: unknown) => void
    move({ clientX: 200, clientY: 140, pointerType: 'mouse' })
    expect(btn.state.hover).toBe(true)
  })
  it('keyboard: false leaves the tab order and key events alone', () => {
    const { camera, s, canvas } = scene()
    const bridge = new PointerBridge({ canvas, camera, surfaces: () => [s], keyboard: false })
    bridge.attach()
    expect(canvas.tabIndex).toBe(-1)
    expect(canvas.addEventListener.mock.calls.map(c => c[0]).sort()).toEqual(['pointercancel', 'pointerdown', 'pointerleave', 'pointermove', 'pointerup', 'wheel'])
  })
})
