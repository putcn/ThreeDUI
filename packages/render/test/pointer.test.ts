import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { BoxGeometry, InstancedMesh, Matrix4, Mesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Ray, Raycaster, Vector2, Vector3 } from 'three'
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
  ctx = { theme, scheme: 'light', layout: await createYogaLayout(), measure: createMeasureFn(text, theme, 'light'), anim: new AnimationRuntime(theme, 'light'), text, pages: new AtlasPages(text.atlas), contrast: false, quality: { contentType: 'byte', contentScale: 1, backFaces: false, depthReject: false, blur: 'mip', glassMode: 'refract', dispersion: 'always' } }
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
  return { camera, layer, a, b, ab, bb, canvas, bridge, list, rc: rayAt(camera, 0, 0) }
}

function rayAt(camera: PerspectiveCamera, x: number, y: number): Raycaster {
  const rc = new Raycaster(); rc.setFromCamera(new Vector2((x / 800) * 2 - 1, -((y / 600) * 2 - 1)), camera)
  return rc
}
/** Re-aims `rc` through canvas px (x, y) of the 800 × 600 canvas, from the camera it was last set from. */
function aimAt(rc: Raycaster, x: number, y: number): Raycaster {
  rc.setFromCamera(new Vector2((x / 800) * 2 - 1, -((y / 600) * 2 - 1)), rc.camera)
  return rc
}
/** A `bg: 'fill'` box over the whole of `s`, on top of its other nodes, so `s` takes the pointer everywhere. */
function cover(s: Surface): Node {
  const n = new Node('box', `${s.name}-cover`); n.setStyle({ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', bg: 'fill' })
  s.root.appendChild(n); s.tick(0)
  return n
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
    cover(a)                                                           // a must take the pointer there to win it
    a.drawOrder = 2
    expect(hitSurfaces(rc, [a, b])!.surface).toBe(a); expect(hitSurfaces(rc, [b, a])!.surface).toBe(a)
  })
  it('skips hidden (also through an ancestor), failed and non-interactive Surfaces', () => {
    const { camera, layer, a, b } = two()
    const rc = rayAt(camera, 450, 350)
    cover(a)                                                           // a takes the pointer where b no longer does
    b.visible = false; expect(hitSurfaces(rc, [a, b])!.surface).toBe(a); b.visible = true
    b.error = new Error('boom'); expect(hitSurfaces(rc, [a, b])!.surface).toBe(a); b.error = null
    b.interactive = false; expect(hitSurfaces(rc, [a, b])!.surface).toBe(a); b.interactive = true
    layer.visible = false; expect(hitSurfaces(rc, [a, b])).toBeNull()
  })
  it('falls through a Surface that takes no pointer at the hit point', () => {
    const { a, b, bb, rc } = two()
    bb.remove(); b.tick(0)                                             // two() covers b with glass: bare it
    const n = new Node('box', 'under'); n.setStyle({ position: 'absolute', left: 0, top: 0, width: 800, height: 600, bg: 'fill' })
    a.root.appendChild(n); a.tick(0); b.tick(0)
    // b's root is bare: the ray through b's quad lands on a
    aimAt(rc, 450, 320)
    expect(hitSurfaces(rc, [a, b])!.surface).toBe(a)
    const k = new Node('box', 'chip'); k.setStyle({ position: 'absolute', left: 0, top: 0, width: 200, height: 100, bg: 'fill' })
    b.root.appendChild(k); b.tick(0)
    expect(hitSurfaces(rc, [a, b])!.surface).toBe(b)
    n.remove(); a.tick(0)
    k.remove(); b.tick(0)
    expect(hitSurfaces(rc, [a, b])).toBeNull()                         // nothing anywhere: the pointer is the host's
  })
  it('falls through to a farther Surface when the nearer takes no pointer there', () => {
    const far = new Surface({ width: 400, height: 400, ptPerUnit: 100 }, ctx), near = new Surface({ width: 400, height: 400, ptPerUnit: 100 }, ctx)
    far.position.z = -6; near.position.z = -3
    const world = new Object3D(); world.add(far, near); world.updateMatrixWorld(true)
    const rc = new Raycaster(new Vector3(0, 0, 0), new Vector3(0, 0, -1))
    cover(far); near.tick(0)
    const hit = hitSurfaces(rc, [far, near])!
    expect(hit.surface).toBe(far); expect(hit.distance).toBeCloseTo(6, 9); expect(hit.x).toBeCloseTo(200, 6); expect(hit.y).toBeCloseTo(200, 6)
  })
  it('the nearest Surface wins over a higher drawOrder behind it', () => {
    const far = new Surface({ width: 400, height: 400, ptPerUnit: 100 }, ctx), near = new Surface({ width: 400, height: 400, ptPerUnit: 100 }, ctx)
    far.position.z = -6; near.position.z = -3; far.drawOrder = 5; near.drawOrder = 0
    cover(far); cover(near)                                            // both take the pointer at the hit point
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
  it('every pointer event it dispatches carries the pointer\'s canvas px (screenX, screenY), the canvas offset taken off', () => {
    const { btn, bridge, canvas } = scene(), got: unknown[] = []
    canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 800, height: 600 })
    for (const t of ['pointerenter', 'pointermove', 'pointerdown', 'pointerup', 'click', 'wheel', 'contextmenu', 'pointerleave'] as const) btn.setHandler(t, e => got.push([t, e.screenX, e.screenY]))
    bridge.handle('pointermove', { clientX: 210, clientY: 160, pointerType: 'mouse' })
    bridge.handle('pointerdown', { clientX: 211, clientY: 160, pointerType: 'mouse', pointerId: 1, button: 0 })
    bridge.handle('pointerup', { clientX: 212, clientY: 161, pointerType: 'mouse', pointerId: 1, button: 0 })
    bridge.handle('wheel', { clientX: 213, clientY: 162, deltaY: 10 })
    bridge.handle('pointerdown', { clientX: 214, clientY: 163, pointerType: 'mouse', button: 2 })
    bridge.handle('pointermove', { clientX: 5, clientY: 5, pointerType: 'mouse' })   // off the button, and the canvas's (−5, −15)
    expect(got).toEqual([
      ['pointerenter', 200, 140], ['pointermove', 200, 140], ['pointerdown', 201, 140], ['pointerup', 202, 141], ['click', 202, 141],
      ['pointermove', 203, 142], ['wheel', 203, 142], ['contextmenu', 204, 143], ['pointerleave', -5, -15],   // a wheel hovers where it is first
    ])
  })
  it('pointer events carry the DOM\'s buttons and shiftKey when it had them (spatial spec §12.5); a right drag is moves with buttons & 2', () => {
    const { btn, bridge, canvas } = scene(), got: unknown[] = []
    for (const t of ['pointerenter', 'pointermove', 'pointerdown', 'pointerup', 'click', 'wheel', 'contextmenu', 'pointerleave'] as const) {
      btn.setHandler(t, e => got.push([t, 'buttons' in e ? e.buttons : '-', 'shiftKey' in e ? e.shiftKey : '-']))
    }
    bridge.handle('pointermove', { clientX: 200, clientY: 140, pointerType: 'mouse', buttons: 0, shiftKey: false })
    bridge.handle('pointerdown', { clientX: 200, clientY: 140, pointerType: 'mouse', pointerId: 1, button: 0, buttons: 1, shiftKey: true })
    bridge.handle('pointermove', { clientX: 201, clientY: 140, pointerType: 'mouse', pointerId: 1, buttons: 1, shiftKey: true })
    bridge.handle('pointerup', { clientX: 201, clientY: 140, pointerType: 'mouse', pointerId: 1, button: 0, buttons: 0, shiftKey: false })
    bridge.handle('wheel', { clientX: 201, clientY: 140, deltaY: 10, buttons: 0, shiftKey: true })
    // the right button: its down only dispatches contextmenu (no press, no capture); the moves that follow say it is held
    bridge.handle('pointerdown', { clientX: 202, clientY: 140, pointerType: 'mouse', pointerId: 1, button: 2, buttons: 2, shiftKey: false })
    expect(btn.state.pressed).toBe(false); expect(canvas.setPointerCapture).toHaveBeenCalledTimes(1)
    bridge.handle('pointermove', { clientX: 210, clientY: 145, pointerType: 'mouse', pointerId: 1, buttons: 2, shiftKey: false })
    bridge.handle('pointermove', { clientX: 220, clientY: 150, pointerType: 'mouse', pointerId: 1 })   // a bridge event without them
    bridge.handle('pointermove', { clientX: 5, clientY: 5, pointerType: 'mouse', buttons: 2, shiftKey: true })   // off the button
    expect(got).toEqual([
      ['pointerenter', 0, false], ['pointermove', 0, false], ['pointerdown', 1, true], ['pointermove', 1, true],
      ['pointerup', 0, false], ['click', 0, false], ['pointermove', 0, true], ['wheel', 0, true], ['contextmenu', 2, false],
      ['pointermove', 2, false], ['pointermove', '-', '-'], ['pointerleave', 2, true],
    ])
  })
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
    expect(s.focus.current).toBe(btn)                                                // the press focused it
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
  it('a wheel at a new point (no move before it: the Surface moved under a still pointer) re-hovers there first, as a move would, and goes to the node under it', () => {
    const { s, btn, bridge } = scene()
    const other = new Node('box', 'other'); other.setStyle({ position: 'absolute', left: 400, top: 300, width: 200, height: 100, bg: 'fill' }); s.root.appendChild(other); s.tick(0)
    const wheels: string[] = [], hovers: string[] = []
    for (const n of [btn, other]) {
      s.events.on(n, 'wheel', e => { if (e.currentTarget === n) wheels.push(n.id!) })
      s.events.on(n, 'pointerenter', () => hovers.push(`enter ${n.id}`)); s.events.on(n, 'pointerleave', () => hovers.push(`leave ${n.id}`))
    }
    bridge.handle('pointermove', { clientX: 200, clientY: 140 })                   // on btn
    expect(btn.state.hover).toBe(true)
    bridge.handle('wheel', { clientX: 450, clientY: 350, deltaY: 30 })              // on `other`, with no move in between
    expect(wheels).toEqual(['other'])
    expect(other.state.hover).toBe(true); expect(btn.state.hover).toBe(false)
    expect(hovers).toEqual(['enter btn', 'leave btn', 'enter other'])
    bridge.handle('wheel', { clientX: 455, clientY: 352, deltaY: 30 })              // still on it: no new enter
    expect(wheels).toEqual(['other', 'other']); expect(hovers).toHaveLength(3)
    // off every Surface: nothing hovered, no wheel dispatched
    bridge.handle('wheel', { clientX: -50, clientY: -50, deltaY: 30 })
    expect(wheels).toHaveLength(2); expect(other.state.hover).toBe(false); expect(bridge.hovered).toBeNull()
  })
  it('a wheel during a press (the pointer captured) goes to the pressed Surface, as before', () => {
    const { s, btn, bridge } = scene()
    const seen = vi.fn(); s.events.on(btn, 'wheel', seen)
    bridge.handle('pointerdown', { clientX: 200, clientY: 140, pointerId: 1, button: 0 })
    bridge.handle('wheel', { clientX: 2000, clientY: 2000, deltaY: 30 })            // off the canvas: still the captured Surface's
    expect(seen).toHaveBeenCalledTimes(1); expect(btn.state.pressed).toBe(true)
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
  it('a chorded release ends the press: pointerup comes with the LAST button released', () => {
    const { a, b, ab, bb, bridge } = two()
    const click = vi.fn(); a.events.on(ab, 'click', click)
    bridge.handle('pointerdown', { clientX: 100, clientY: 100, pointerId: 1, button: 0 })
    bridge.handle('pointermove', { clientX: 100, clientY: 100, pointerId: 1, button: 2 })   // right down: a move
    bridge.handle('pointermove', { clientX: 100, clientY: 100, pointerId: 1, button: 0 })   // left up: a move
    bridge.handle('pointerup', { clientX: 100, clientY: 100, pointerId: 1, button: 2 })
    expect(ab.state.pressed).toBe(false); expect(click).toHaveBeenCalledTimes(1)
    bridge.handle('pointermove', { clientX: 450, clientY: 350 })                             // no capture left
    expect(bb.state.hover).toBe(true); expect(bridge.hovered).toBe(b)
  })
  it('ignores secondary pointers and non-primary buttons', () => {
    const { s, btn, bridge } = scene()
    const click = vi.fn(); s.events.on(btn, 'click', click)
    const ups = vi.fn(); s.events.on(btn, 'pointerup', ups)
    bridge.handle('pointerdown', { clientX: 200, clientY: 140, pointerId: 1, button: 2 })
    expect(btn.state.pressed).toBe(false); expect(bridge.active).toBeNull()
    bridge.handle('pointerup', { clientX: 200, clientY: 140, pointerId: 1, button: 2 })     // a stray non-primary up
    expect(ups).not.toHaveBeenCalled()
    bridge.handle('pointerdown', { clientX: 200, clientY: 140, pointerId: 1, pointerType: 'touch', button: 0, isPrimary: true })
    bridge.handle('pointerdown', { clientX: 600, clientY: 500, pointerId: 2, pointerType: 'touch', isPrimary: false })
    bridge.handle('pointermove', { clientX: 600, clientY: 500, pointerId: 2, pointerType: 'touch', isPrimary: false })
    bridge.handle('pointerup', { clientX: 600, clientY: 500, pointerId: 2, pointerType: 'touch', isPrimary: false })
    // adjusted (Task 10 M2): a touch hovers no node's state (spec §8.3), so the primary's hover is the tracker's
    expect(btn.state.pressed).toBe(true); expect(s.pointer.hovered).toBe(btn); expect(btn.state.hover).toBe(false)
    bridge.handle('pointerup', { clientX: 200, clientY: 140, pointerId: 1, pointerType: 'touch', button: 0, isPrimary: true })
    expect(click).toHaveBeenCalledTimes(1); expect(click.mock.calls[0]![0].pointerType).toBe('touch')
  })
  it('a primary press focuses the nearest focusable without the ring; a right-button down dispatches contextmenu and presses nothing', () => {
    const { s, btn, bridge, canvas } = scene()
    const label = new Node('box', 'label'); label.setStyle({ position: 'absolute', left: 20, top: 20, width: 100, height: 20 }); btn.appendChild(label)
    const plain = new Node('box', 'plain'); plain.setStyle({ position: 'absolute', left: 400, top: 100, width: 100, height: 80, bg: 'fill' }); s.root.appendChild(plain); s.tick(0)
    bridge.handle('pointerdown', { clientX: 150, clientY: 130, pointerId: 1, button: 0 })   // on the label inside btn
    expect(s.pointer.pressed).toBe(label)
    expect(s.focus.current).toBe(btn); expect(btn.state.focused).toBe(true); expect(btn.state.focusVisible).toBe(false)
    bridge.handle('pointerup', { clientX: 150, clientY: 130, pointerId: 1, button: 0 })
    const menu = vi.fn(); btn.setHandler('contextmenu', menu)
    const down = vi.fn(); s.events.on(btn, 'pointerdown', down)
    bridge.handle('pointerdown', { clientX: 210, clientY: 150, pointerId: 1, button: 2 })
    expect(menu).toHaveBeenCalledTimes(1)
    const e = menu.mock.calls[0]![0]
    expect(e.target).toBe(btn); expect(e.x).toBeCloseTo(210, 3); expect(e.y).toBeCloseTo(150, 3)
    expect(down).not.toHaveBeenCalled(); expect(btn.state.pressed).toBe(false); expect(s.pointer.pressed).toBeNull()
    expect(canvas.setPointerCapture).toHaveBeenCalledTimes(1)                        // only the primary press captured
    expect(s.focus.current).toBe(btn)
    bridge.handle('pointerup', { clientX: 210, clientY: 150, pointerId: 1, button: 2 })
    bridge.handle('pointerdown', { clientX: 210, clientY: 150, pointerId: 1, button: 1 })   // middle: ignored
    expect(menu).toHaveBeenCalledTimes(1); expect(down).not.toHaveBeenCalled()
    bridge.handle('pointerdown', { clientX: 450, clientY: 140, pointerId: 1, button: 0 })   // nothing focusable there: blurs
    expect(s.pointer.pressed).toBe(plain); expect(bridge.active).toBe(s)
    expect(s.focus.current).toBeNull(); expect(btn.state.focused).toBe(false)
  })
  it('a right-button down leaves the active Surface and its focus alone, and cancels a press whose up was lost', () => {
    const { a, b, ab, bb, bridge } = two()
    ab.setProp('tabIndex', 0)
    bridge.handle('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 }); bridge.handle('pointerup', { clientX: 100, clientY: 100, pointerId: 1 })
    expect(a.focus.current).toBe(ab)
    const menu = vi.fn(); bb.setHandler('contextmenu', menu)
    bridge.handle('pointerdown', { clientX: 450, clientY: 350, pointerId: 1, button: 2 })   // on b
    expect(menu).toHaveBeenCalledTimes(1); expect(bb.state.pressed).toBe(false)
    expect(bridge.active).toBe(a); expect(a.focus.current).toBe(ab)
    bridge.handle('pointerdown', { clientX: 2000, clientY: 2000, pointerId: 1, button: 2 })  // on nothing
    expect(bridge.active).toBe(a); expect(a.focus.current).toBe(ab)
    const cancel = vi.fn(); a.events.on(ab, 'pointercancel', cancel)
    bridge.handle('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 })              // its up is lost…
    bridge.handle('pointerdown', { clientX: 450, clientY: 350, pointerId: 1, button: 2 })   // …a chord would be a move
    expect(cancel).toHaveBeenCalledTimes(1); expect(ab.state.pressed).toBe(false); expect(menu).toHaveBeenCalledTimes(2)
    bridge.handle('pointermove', { clientX: 450, clientY: 350 })                             // no capture left
    expect(bridge.hovered).toBe(b); expect(bb.state.hover).toBe(true)
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
    bridge.handle('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 }); bridge.handle('pointerup', { clientX: 100, clientY: 100, pointerId: 1 })
    ab.setProp('tabIndex', 0); ac.setProp('tabIndex', 0)                            // after the press, which would focus ab
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
  })
  it('a key with no active Surface adopts the topmost shown, interactive, error-free one', () => {
    const { a, b, ab, bb, bridge } = two()
    ab.setProp('tabIndex', 0); bb.setProp('tabIndex', 0)
    const prevent = vi.fn()
    bridge.handle('keydown', { key: 'Tab', preventDefault: prevent })              // Tab onto the canvas, no click yet
    expect(bridge.active).toBe(b); expect(b.focus.current).toBe(bb); expect(prevent).toHaveBeenCalledTimes(1)
    bridge.active = null; b.focus.focus(null); b.interactive = false
    bridge.handle('keydown', { key: 'Tab' })
    expect(bridge.active).toBe(a); expect(a.focus.current).toBe(ab)
    bridge.active = null; a.focus.focus(null); b.interactive = true; b.error = new Error('boom')
    bridge.handle('keydown', { key: 'Tab' }); expect(bridge.active).toBe(a)
    bridge.active = null; a.focus.focus(null); b.error = null; b.visible = false
    bridge.handle('keydown', { key: 'Tab' }); expect(bridge.active).toBe(a)
    bridge.active = null; a.focus.focus(null); b.visible = true; b.drawOrder = a.drawOrder   // tie: list order
    bridge.handle('keydown', { key: 'Tab' }); expect(bridge.active).toBe(a)
    bridge.active = null; a.focus.focus(null)
    const esc = vi.fn(); a.events.on(a.root, 'keyup', esc)
    bridge.handle('keyup', { key: 'Escape' })                                       // any key adopts, not only Tab
    expect(bridge.active).toBe(a); expect(esc).toHaveBeenCalledTimes(1)
  })
  it('Tab past the last focusable (Shift+Tab before the first) blurs and lets the browser move focus out', () => {
    const { s, btn, bridge } = scene()
    const btn2 = new Node('glass', 'btn2'); btn2.setStyle({ position: 'absolute', left: 400, top: 100, width: 100, height: 80 }); btn2.setProp('tabIndex', 0)
    s.root.appendChild(btn2); s.tick(0)
    const tab = (shiftKey = false) => { const preventDefault = vi.fn(); bridge.handle('keydown', { key: 'Tab', shiftKey, preventDefault }); return preventDefault }
    expect(tab()).toHaveBeenCalledTimes(1); expect(s.focus.current).toBe(btn)
    expect(tab()).toHaveBeenCalledTimes(1); expect(s.focus.current).toBe(btn2)
    expect(tab()).not.toHaveBeenCalled(); expect(s.focus.current).toBeNull(); expect(btn2.state.focused).toBe(false)
    expect(tab()).toHaveBeenCalledTimes(1); expect(s.focus.current).toBe(btn)          // Tab back in: the first again
    expect(tab(true)).not.toHaveBeenCalled(); expect(s.focus.current).toBeNull(); expect(btn.state.focused).toBe(false)
    expect(tab(true)).toHaveBeenCalledTimes(1); expect(s.focus.current).toBe(btn2)     // Shift+Tab back in: the last
    expect(tab(true)).toHaveBeenCalledTimes(1); expect(s.focus.current).toBe(btn)
  })
  it('trapFocus: Tab past the last focusable wraps to the first (Shift+Tab: the reverse), prevented, never blurring out', () => {
    const { s, btn, bridge } = scene()
    const btn2 = new Node('glass', 'btn2'); btn2.setStyle({ position: 'absolute', left: 400, top: 100, width: 100, height: 80 }); btn2.setProp('tabIndex', 0)
    s.root.appendChild(btn2); s.tick(0)
    s.trapFocus = true
    const tab = (shiftKey = false) => { const preventDefault = vi.fn(); bridge.handle('keydown', { key: 'Tab', shiftKey, preventDefault }); return preventDefault }
    expect(tab()).toHaveBeenCalledTimes(1); expect(s.focus.current).toBe(btn)
    expect(tab()).toHaveBeenCalledTimes(1); expect(s.focus.current).toBe(btn2)
    expect(tab()).toHaveBeenCalledTimes(1); expect(s.focus.current).toBe(btn)            // wrapped
    expect(btn.state.focusVisible).toBe(true)
    expect(tab(true)).toHaveBeenCalledTimes(1); expect(s.focus.current).toBe(btn2)       // Shift+Tab before the first: the last
    btn.setProp('tabIndex', undefined); btn2.setProp('tabIndex', undefined); s.focus.focus(null)
    expect(tab()).toHaveBeenCalledTimes(1); expect(s.focus.current).toBeNull()           // nothing to focus: Tab still stays in
  })
  it('setActive makes a Surface the key target, blurring the one it replaces', () => {
    const { a, b, ab, bb, bridge } = two()
    ab.setProp('tabIndex', 0); bb.setProp('tabIndex', 0)
    bridge.setActive(a)
    bridge.handle('keydown', { key: 'Tab' })
    expect(a.focus.current).toBe(ab)
    bridge.setActive(b)
    expect(bridge.active).toBe(b); expect(a.focus.current).toBeNull(); expect(ab.state.focused).toBe(false)
    bridge.handle('keydown', { key: 'Tab' })
    expect(b.focus.current).toBe(bb)
    bridge.setActive(b)                                                              // the same Surface: its focus stays
    expect(b.focus.current).toBe(bb)
    bridge.setActive(null)
    expect(bridge.active).toBeNull(); expect(b.focus.current).toBeNull()
  })
  it('setActive away from a Surface holding a press cancels that press: the capture cannot stay on it', () => {
    const { a, b, ab, bridge } = two()
    bridge.handle('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 })
    expect(ab.state.pressed).toBe(true)
    const cancel = vi.fn(); a.events.on(ab, 'pointercancel', cancel)
    bridge.setActive(b)
    expect(cancel).toHaveBeenCalledTimes(1); expect(ab.state.pressed).toBe(false)
    bridge.handle('pointermove', { clientX: 120, clientY: 100, pointerId: 1 })        // no capture held: moves hover again
    expect(bridge.hovered).toBe(a)
  })
  it('a pointerdown listener that moves activity elsewhere (a dialog opening) ends that press: no focus, no capture, no click', () => {
    const { a, b, ab, canvas, bridge } = two()
    ab.setProp('tabIndex', 0)
    const cancel = vi.fn(), click = vi.fn()
    a.events.on(ab, 'pointerdown', () => bridge.setActive(b)); a.events.on(ab, 'pointercancel', cancel); a.events.on(ab, 'click', click)
    bridge.handle('pointerdown', { clientX: 100, clientY: 100, pointerId: 1 })
    expect(bridge.active).toBe(b); expect(cancel).toHaveBeenCalledTimes(1)
    expect(ab.state.pressed).toBe(false); expect(a.focus.current).toBeNull(); expect(ab.state.focused).toBe(false)
    expect(canvas.setPointerCapture).not.toHaveBeenCalled()
    bridge.handle('pointerup', { clientX: 100, clientY: 100, pointerId: 1 })
    expect(click).not.toHaveBeenCalled(); expect(canvas.releasePointerCapture).not.toHaveBeenCalled()
    expect(bridge.active).toBe(b)                                                    // the keys stay with the dialog
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

describe('3D viewport hits', () => {
  /** A 400 × 300 pt world Surface (100 pt a unit) facing a camera 5 units away; `object` (default `mesh`) attached to a 100 × 80 box at its centre. */
  const world = (object?: Object3D) => {
    const camera = new PerspectiveCamera(50, 800 / 600, 0.1, 100); camera.position.set(0, 0, 5); camera.updateMatrixWorld(true)
    const s = new Surface({ id: 'w', width: 400, height: 300, ptPerUnit: 100, placement: 'world' }, ctx); s.updateMatrixWorld(true)
    const vp = new Node('box'); vp.setStyle({ position: 'absolute', left: 150, top: 110, width: 100, height: 80 })
    const host = new Node('box'); host.setStyle({ width: 400, height: 300, bg: 'fill' }); host.appendChild(vp); s.root.appendChild(host)
    const mesh = new Mesh(new BoxGeometry(40, 40, 60), new MeshBasicMaterial()); mesh.position.z = 30   // stands 60 pt proud
    s.attach3D(vp, object ?? mesh); s.tick(0); s.updateMatrixWorld(true)
    const bridge = new PointerBridge({ canvas: fakeCanvas(), camera, surfaces: () => [s] })
    return { camera, s, vp, host, mesh, bridge }
  }
  it('a 3D object nearer than the quad wins and names its node and object', () => {
    const { camera, s, vp, mesh } = world()
    const h = hitSurfaces(rayAt(camera, 400, 300), [s])!
    expect(h.target).toEqual({ node: vp, object: mesh, point: expect.any(Array) }); expect(h.x).toBeCloseTo(200, 0); expect(h.y).toBeCloseTo(150, 0)
    const blank = hitSurfaces(rayAt(camera, 400 - 60, 300), [s])!      // on the box, beside the mesh
    expect(blank.target).toBeUndefined()
  })
  it('the node hovers over its object and its box alike; moves carry the object only over the object', () => {
    const { vp, mesh, bridge } = world(), seen: unknown[] = []
    vp.setHandler('pointermove', e => seen.push(e.object))
    bridge.handle('pointermove', { clientX: 400, clientY: 300, pointerType: 'mouse' })
    expect(vp.state.hover).toBe(true); expect(seen.at(-1)).toBe(mesh)
    bridge.handle('pointermove', { clientX: 340, clientY: 300, pointerType: 'mouse' })
    expect(vp.state.hover).toBe(true); expect(seen.at(-1)).toBeUndefined()
    bridge.handle('pointermove', { clientX: 20, clientY: 20, pointerType: 'mouse' })
    expect(vp.state.hover).toBe(false)
  })
  it('a node that cannot take the pointer is skipped: the press goes where hitTest says', () => {
    const { host, vp, bridge } = world(); host.setStyle({ pointerEvents: 'none' })
    const down = vi.fn(); vp.setHandler('pointerdown', down)
    const rootDown = vi.fn(); host.parent!.setHandler('pointerdown', rootDown)
    bridge.handle('pointerdown', { clientX: 400, clientY: 300, pointerType: 'mouse', pointerId: 1, button: 0 })
    expect(down).not.toHaveBeenCalled(); expect(rootDown).toHaveBeenCalledWith(expect.not.objectContaining({ object: expect.anything() }))
  })
  it('a 3D object takes the pointer over an empty area of a bare Surface; a hidden part or anchor is not hit', () => {
    const { camera, s, vp, host, mesh } = world(); host.setStyle({ bg: 'none' }); s.tick(0)
    const rc = rayAt(camera, 400, 300)
    expect(s.takesPointer(200, 150)).toBe(false)
    expect(hitSurfaces(rc, [s])?.target).toEqual({ node: vp, object: mesh, point: expect.any(Array) })
    mesh.visible = false; expect(hitSurfaces(rc, [s])).toBeNull()
    mesh.visible = true; s.viewports.get(vp)!.anchor.visible = false; expect(hitSurfaces(rc, [s])).toBeNull()
  })
  it('a press on the object and its up over it both carry the object', () => {
    const { vp, mesh, bridge } = world(), ups: unknown[] = []
    for (const t of ['pointerdown', 'pointerup', 'click'] as const) vp.setHandler(t, e => ups.push([t, e.object]))
    bridge.handle('pointerdown', { clientX: 400, clientY: 300, pointerType: 'mouse', pointerId: 1, button: 0 })
    bridge.handle('pointerup', { clientX: 400, clientY: 300, pointerType: 'mouse', pointerId: 1, button: 0 })
    expect(ups).toEqual([['pointerdown', mesh], ['pointerup', mesh], ['click', mesh]])
  })
  it('an InstancedMesh hit names the instance (instanceId) on the target and on the events; a plain mesh hit has none', () => {
    // three 30 pt cubes in a row, 50 pt apart, their fronts 55 pt proud: instance 0 over Surface x = 150, 1 over 200, 2 over 250
    const row = new InstancedMesh(new BoxGeometry(30, 30, 30), new MeshBasicMaterial(), 3)
    for (let i = 0; i < 3; i++) row.setMatrixAt(i, new Matrix4().makeTranslation((i - 1) * 50, 0, 40))
    const { camera, s, vp, bridge } = world(row)
    /** Canvas px x over Surface x `pt` at the cubes' fronts (0.55 units proud: 4.45 from the camera). */
    const at = (pt: number): number => 400 + (pt - 200) / 100 * 300 / (Math.tan(25 * Math.PI / 180) * 4.45)
    expect(hitSurfaces(rayAt(camera, at(250), 300), [s])!.target).toEqual({ node: vp, object: row, instanceId: 2, point: expect.any(Array) })
    expect(hitSurfaces(rayAt(camera, at(150), 300), [s])!.target).toEqual({ node: vp, object: row, instanceId: 0, point: expect.any(Array) })   // 0 is an instance
    const seen: unknown[] = []
    vp.setHandler('pointermove', e => seen.push([e.object, e.instanceId]))
    bridge.handle('pointermove', { clientX: at(200), clientY: 300, pointerType: 'mouse' })
    expect(seen).toEqual([[row, 1]])
    const plain = world(), hit = hitSurfaces(rayAt(plain.camera, 400, 300), [plain.s])!
    expect(hit.target).toEqual({ node: plain.vp, object: plain.mesh, point: expect.any(Array) }); expect('instanceId' in hit.target!).toBe(false)
  })
  it('a 3D hit carries its point in the anchor\'s frame (pt), where the ray meets the object (Task 9N)', () => {
    const { camera, s, vp, mesh, bridge } = world(), anchor = s.viewports.get(vp)!.anchor
    // off-centre on the mesh's front face (60 pt proud, 40 × 40 pt): about 7 pt right of and above its centre
    const rc = rayAt(camera, 410, 290), h = hitSurfaces(rc, [s])!
    const world3 = rc.intersectObject(mesh)[0]!.point
    const exact = anchor.worldToLocal(world3.clone()), own = mesh.worldToLocal(world3.clone()).add(mesh.position)
    expect(h.target!.point).toHaveLength(3)
    h.target!.point!.forEach((v, i) => {
      expect(Math.abs(v - exact.getComponent(i))).toBeLessThan(1e-6)
      expect(Math.abs(v - own.getComponent(i))).toBeLessThan(1e-6)   // the mesh's local hit, placed where the mesh sits
    })
    const [x, y, z] = h.target!.point!
    expect(z).toBeCloseTo(60, 4); expect(x).toBeGreaterThan(3); expect(x).toBeLessThan(20); expect(y).toBeGreaterThan(3); expect(y).toBeLessThan(20)
    // and the node's events carry it
    const seen: unknown[] = []
    vp.setHandler('pointermove', e => seen.push(e.point))
    bridge.handle('pointermove', { clientX: 410, clientY: 290, pointerType: 'mouse' })
    expect(seen).toEqual([h.target!.point])
    bridge.handle('pointermove', { clientX: 340, clientY: 300, pointerType: 'mouse' })   // on the box beside the mesh: none
    expect(seen.at(-1)).toBeUndefined()
  })
})
