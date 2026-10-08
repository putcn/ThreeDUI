import { describe, it, expect, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { Box3, PerspectiveCamera, Scene, Texture, Vector2, Vector3, VSMShadowMap, type DirectionalLight } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { Node } from '@glassui/core'
import { createUIRoot, type UIRenderer, type UIRootOptions } from '../src/root'
import type { Surface } from '../src/surface/surface'

// Type-level guard (checked by `pnpm typecheck`): the real renderer satisfies the stub-able subset.
export const asUIRenderer = (r: WebGPURenderer): UIRenderer => r

function stubRenderer(init?: () => Promise<void>) {
  const r = {
    domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), addEventListener: vi.fn(), removeEventListener: vi.fn(), tabIndex: -1, style: { touchAction: 'auto' } },
    getSize: (t: Vector2) => t.set(800, 600), getPixelRatio: () => 2,
    shadowMap: { enabled: false, type: 0 } as UIRenderer['shadowMap'], autoClear: true,
    setRenderTarget: vi.fn(), render: vi.fn(), setClearColor: vi.fn(), getClearColor: vi.fn(c => c), getClearAlpha: () => 1,
    init: init ?? (async () => {}), setAnimationLoop: vi.fn(), backend: { isWebGPUBackend: true },
  }
  return r satisfies UIRenderer
}
const base = () => ({
  renderer: stubRenderer(), scene: new Scene(), camera: new PerspectiveCamera(50, 800 / 600, 0.1, 100), environment: null,
  createCanvas: ((w: number, h: number) => createCanvas(w, h)) as never, quality: 'medium',
} satisfies UIRootOptions)

/** `boxes` in the key light's shadow-camera space (as `fitShadowCamera` measures them). */
function lightSpace(key: DirectionalLight, boxes: Box3[]): Box3 {
  const out = new Box3(), p = new Vector3(), cam = key.shadow.camera
  for (const b of boxes) for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) out.expandByPoint(p.set(x, y, z).applyMatrix4(cam.matrixWorldInverse))
  return out
}
const worldBox = (s: Surface) => s.glassBounds.applyMatrix4(s.matrixWorld)

describe('createUIRoot', () => {
  it('initialises the renderer for transmitted VSM shadows and reports the backend', async () => {
    const o = base(); const root = await createUIRoot(o)
    expect(o.renderer.shadowMap).toMatchObject({ enabled: true, type: VSMShadowMap, transmitted: true })
    expect(root.backend).toBe('webgpu'); expect(root.quality.tier).toBe('medium')
    expect(root.uiScene.children).toContain(root.screen); expect(root.uiScene.children).toContain(root.world); expect(root.uiScene.children).toContain(root.lights.group)
    expect(o.scene.children).toHaveLength(0)
    expect(o.renderer.domElement.addEventListener).toHaveBeenCalled()   // pointer bridge attached
    expect(root.pointer).not.toBeNull(); expect(o.renderer.domElement.tabIndex).toBe(0)
    expect(o.renderer.domElement.style.touchAction).toBe('none')         // touch drags are the UI's, not the page's
    expect(root.uiScene.environment).toBeNull()                          // environment: null skips the PMREM
  })
  it('reports the WebGL2 fallback and an unknown backend', async () => {
    const webgl = { ...base(), renderer: { ...stubRenderer(), backend: { isWebGPUBackend: false } } }
    expect((await createUIRoot(webgl)).backend).toBe('webgl2')
    const { backend: _, ...bare } = stubRenderer()
    expect((await createUIRoot({ ...base(), renderer: bare })).backend).toBe('unknown')
  })
  it('rejects readably when the backend cannot initialise', async () => {
    const o = { ...base(), renderer: stubRenderer(async () => { throw new Error('no adapter') }) }
    await expect(createUIRoot(o)).rejects.toThrow(/WebGPU 与 WebGL2 都不可用.*no adapter/)
  })
  it('creates a filling screen surface and a world surface, ticks and renders them', async () => {
    const o = base(); const root = await createUIRoot(o)
    const s = root.createSurface({ width: 10, height: 10, fill: true })
    const w = root.createSurface({ width: 400, height: 300, layer: 'world' })
    w.position.set(0, 0, -5)
    const btn = new Node('glass'); btn.setStyle({ position: 'absolute', left: 10, top: 10, width: 120, height: 48 }); s.root.appendChild(btn)
    root.tick(1 / 60)
    expect(s.model.width).toBe(800); expect(s.model.height).toBe(600); expect(s.model.ptPerUnit).toBe(1)
    expect(s.model.placement).toBe('screen'); expect(root.screen.surfaces.has(s)).toBe(true)
    expect(w.model.ptPerUnit).toBe(244); expect(w.model.placement).toBe('world'); expect(root.world.children).toContain(w)
    expect(root.surfaces).toHaveLength(2); expect(root.surfaces[0]).toBe(s); expect(root.surfaces[1]).toBe(w)
    expect(o.renderer.render).toHaveBeenCalledTimes(2)         // two content passes
    // 800 px · dpr 2 · medium's content scale ½ = 800 → the next 64 px step
    expect(s.contentPass.target.width).toBe(832); expect(s.contentPass.target.height).toBe(640)
    expect(root.lights.key.shadow.needsUpdate).toBe(true)
    root.render()
    expect(o.renderer.render).toHaveBeenCalledTimes(4)         // host scene + UI scene
    expect(o.renderer.render.mock.calls[2]![0]).toBe(o.scene); expect(o.renderer.render.mock.calls[3]![0]).toBe(root.uiScene)
    expect(o.renderer.render.mock.calls[3]![1]).toBe(o.camera)
  })
  it('sizes a world Surface\'s content RT by its projected size, and a scaled screen Surface by its scaled size', async () => {
    const o = base(); const root = await createUIRoot(o)
    const w = root.createSurface({ width: 488, height: 244, layer: 'world' })   // 2 × 1 units
    w.position.set(0, 0, -5)
    const form = root.createSurface({ width: 400, height: 300, left: 20, top: 20 })
    form.scale.setScalar(0.5)
    root.tick(1 / 60)
    // 1 unit at distance 5 spans 600 / (2·5·tan 25°) px
    const pxPerUnit = 600 / (2 * 5 * Math.tan(25 * Math.PI / 180))
    const step = (px: number) => Math.ceil(px * 2 * 0.5 / 64) * 64
    expect(w.contentPass.target.width).toBe(step(2 * pxPerUnit)); expect(w.contentPass.target.height).toBe(step(pxPerUnit))
    expect(form.contentPass.target.width).toBe(step(200)); expect(form.contentPass.target.height).toBe(step(150))
  })
  it('the overlay renders the host scene, then the UI scene without clearing in between', async () => {
    const o = base(); const root = await createUIRoot(o)
    const autoClear: boolean[] = []
    o.renderer.render.mockImplementation(() => { autoClear.push(o.renderer.autoClear) })
    root.render()
    expect(autoClear).toEqual([true, false]); expect(o.renderer.autoClear).toBe(true)
    root.renderUI()
    expect(o.renderer.render).toHaveBeenLastCalledWith(root.uiScene, o.camera); expect(autoClear).toEqual([true, false, false])
    expect(o.renderer.autoClear).toBe(true)
  })
  it('shared mode puts the layers into the host scene and renders once', async () => {
    const o = { ...base(), mode: 'shared' as const }; const root = await createUIRoot(o)
    expect(o.scene.children).toContain(root.screen); expect(o.scene.children).toContain(root.world); expect(o.scene.children).toContain(root.lights.group)
    root.render()
    expect(o.renderer.render).toHaveBeenCalledTimes(1); expect(o.renderer.render).toHaveBeenCalledWith(o.scene, o.camera)
    root.renderUI()
    expect(o.renderer.render).toHaveBeenCalledTimes(1)
  })
  it('a given environment lights the UI scene (and a shared host scene that has none), and is not disposed', async () => {
    const env = new Texture()
    let freed = 0
    env.addEventListener('dispose', () => { freed++ })
    const overlay = await createUIRoot({ ...base(), environment: env })
    expect(overlay.uiScene.environment).toBe(env)
    const o = { ...base(), environment: env, mode: 'shared' as const }
    const shared = await createUIRoot(o)
    expect(o.scene.environment).toBe(env)
    const own = new Texture(), hosted = { ...base(), environment: env, mode: 'shared' as const }
    hosted.scene.environment = own
    await createUIRoot(hosted)
    expect(hosted.scene.environment).toBe(own)                // the host's own environment stays
    shared.dispose(); overlay.dispose()
    expect(o.scene.environment).toBeNull(); expect(freed).toBe(0)
  })
  it('re-emits surface errors and changes quality on demand', async () => {
    const o = base(); const root = await createUIRoot(o)
    const s = root.createSurface({ width: 10, height: 10, fill: true })
    const bad = new Node('box'); bad.setStyle({ bg: 'nope' }); s.root.appendChild(bad)
    const onError = vi.fn(), onQuality = vi.fn()
    root.on('error', onError); root.on('quality', onQuality)
    root.tick(1 / 60)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ surface: s, error: s.error }))
    root.quality.set('low')
    expect(onQuality).toHaveBeenCalledWith(expect.objectContaining({ tier: 'low', prev: 'medium' }))
    expect(root.lights.key.shadow.mapSize.x).toBe(512)
  })
  it('a quality change rebuilds every Surface and new Surfaces start at the new tier', async () => {
    const o = base(); const root = await createUIRoot(o)
    const a = root.createSurface({ width: 10, height: 10, fill: true })
    const set = vi.spyOn(a, 'setQuality')
    root.quality.set('high')
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ tier: 'high', backFaces: true }))
    expect(a.contentDirty).toBe(true); expect(root.lights.key.shadow.mapSize.x).toBe(2048)
    const b = root.createSurface({ width: 200, height: 100, left: 0, top: 0 })
    root.tick(1 / 60)
    expect(b.contentPass.target.width).toBe(Math.ceil(200 * 2 * 1 / 64) * 64)   // high: content scale 1
  })
  it('an unsubscribed listener hears nothing, and a throwing listener does not stop the others', async () => {
    const o = base(); const root = await createUIRoot(o)
    const quiet = vi.fn(), after = vi.fn()
    const off = root.on('quality', quiet); off()
    root.on('quality', () => { throw new Error('listener bug') }); root.on('quality', after)
    const logged: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a) })
    try { root.quality.set('low') } finally { spy.mockRestore() }
    expect(quiet).not.toHaveBeenCalled(); expect(after).toHaveBeenCalledTimes(1)
    expect(logged).toHaveLength(1); expect((logged[0]![1] as Error).message).toBe('listener bug')
  })
  it('auto quality starts from the environment and adapts; an explicit tier stays put', async () => {
    const auto = await createUIRoot({ ...base(), quality: 'auto' })
    expect(auto.quality.tier).toBe('high')                    // no touch (Node), transparency allowed
    const sample = vi.spyOn(auto.quality, 'sample')
    auto.frame(0); expect(sample).toHaveBeenCalledTimes(1)
    const pinned = await createUIRoot({ ...base(), quality: 'auto', reducedTransparency: true })
    expect(pinned.quality.tier).toBe('minimal')
    pinned.quality.setReducedTransparency(false)
    expect(pinned.quality.tier).toBe('high')                  // the cap ignores the pin
    const fixed = await createUIRoot(base())
    const fixedSample = vi.spyOn(fixed.quality, 'sample')
    fixed.frame(0); expect(fixedSample).not.toHaveBeenCalled()
  })
  it('applies reduced motion to the shared animation runtime', async () => {
    expect((await createUIRoot({ ...base(), reducedMotion: true })).anim.reducedMotion).toBe(true)
    expect((await createUIRoot(base())).anim.reducedMotion).toBe(false)   // no matchMedia under Node
  })
  it('orders Surfaces: screen ones above world ones, later placed higher, nearer world ones higher', async () => {
    const o = base(); const root = await createUIRoot(o)
    const a = root.createSurface({ width: 10, height: 10, fill: true })
    const far = root.createSurface({ width: 400, height: 300, layer: 'world' }); far.position.set(0, 0, -8)
    const b = root.createSurface({ width: 200, height: 100, left: 20, top: 20 })
    const near = root.createSurface({ width: 400, height: 300, layer: 'world' }); near.position.set(0.5, 0, -3)
    const tie = root.createSurface({ width: 400, height: 300, layer: 'world' }); tie.position.set(-0.5, 0, -3)
    root.tick(1 / 60)
    expect([a.drawOrder, b.drawOrder]).toEqual([1000, 1001])
    expect([far.drawOrder, near.drawOrder, tie.drawOrder]).toEqual([1, 2, 3])   // equidistant: the later one above
    near.position.set(0, 0, -10)
    root.tick(1 / 60)
    expect([near.drawOrder, far.drawOrder, tie.drawOrder]).toEqual([1, 2, 3])
  })
  it('the lights follow the camera, and the shadow camera is re-fitted when it moves', async () => {
    const o = base(); const root = await createUIRoot(o)
    const s = root.createSurface({ width: 10, height: 10, fill: true })
    const w = root.createSurface({ width: 400, height: 300, layer: 'world' }); w.position.set(0, 0, -5)
    const key = root.lights.key
    root.tick(1 / 60)
    expect(key.shadow.needsUpdate).toBe(true)
    key.shadow.needsUpdate = false                             // the shadow pass drew the map
    root.tick(1 / 60)
    expect(key.shadow.needsUpdate).toBe(false)                // nothing changed: the map stays
    const right = key.shadow.camera.right
    o.camera.position.set(1, 0.5, 0); o.camera.lookAt(0, 0, -5)
    root.tick(1 / 60)
    expect(key.shadow.needsUpdate).toBe(true)
    expect(root.lights.group.position.toArray()).toEqual([1, 0.5, 0]); expect(root.lights.group.quaternion.angleTo(o.camera.quaternion)).toBeLessThan(1e-6)
    expect(key.shadow.camera.right).not.toBe(right)
    // screen and world Surfaces fitted together, with a margin proportional to their union (not a fixed 0.2)
    const boxes = [worldBox(s), worldBox(w)], union = boxes.reduce((u, b) => u.union(b), new Box3())
    const margin = 0.05 * Math.max(...union.getSize(new Vector3()).toArray())
    const ls = lightSpace(key, boxes)
    expect(ls.min.x - key.shadow.camera.left).toBeCloseTo(margin, 6); expect(key.shadow.camera.top - ls.max.y).toBeCloseTo(margin, 6)
  })
  it('re-fits the shadow when a Surface animates, rebuilds or moves', async () => {
    const o = base(); const root = await createUIRoot(o)
    const w = root.createSurface({ width: 400, height: 300, layer: 'world' }); w.position.set(0, 0, -5)
    const key = root.lights.key
    root.tick(1 / 60); key.shadow.needsUpdate = false
    w.position.x = 0.5                                         // moved
    root.tick(1 / 60); expect(key.shadow.needsUpdate).toBe(true); key.shadow.needsUpdate = false
    const glass = new Node('glass'); glass.setStyle({ position: 'absolute', left: 10, top: 10, width: 120, height: 48, transition: { scale: 'snappy' }, pressed: { scale: 0.9 } })
    w.root.appendChild(glass)
    root.tick(1 / 60); expect(key.shadow.needsUpdate).toBe(true); key.shadow.needsUpdate = false   // rebuilt its lists
    root.tick(1 / 60); expect(key.shadow.needsUpdate).toBe(false)
    glass.setState({ pressed: true })
    root.tick(1 / 60); expect(w.needsFrame).toBe(true); key.shadow.needsUpdate = false
    root.tick(1 / 60); expect(key.shadow.needsUpdate).toBe(true)   // still animating
  })
  it('re-lays out glyphs another Surface\'s glyphs evicted earlier in the same tick, before drawing the content', async () => {
    const o = base(); const root = await createUIRoot(o)
    const a = root.createSurface({ width: 200, height: 100, left: 0, top: 0 })
    const b = root.createSurface({ width: 200, height: 100, left: 0, top: 200 })
    const label = new Node('text'); label.setProp('value', 'Hello'); a.root.appendChild(label)
    const tickB = b.tick.bind(b)
    vi.spyOn(b, 'tick').mockImplementationOnce(dt => { tickB(dt); root.text.atlas.invalidate() })   // b's glyphs evicted a's
    const refresh = vi.spyOn(a, 'refreshText'), prepare = vi.spyOn(a, 'prepare')
    root.tick(1 / 60)
    expect(refresh).toHaveReturnedWith(true)
    expect(refresh.mock.invocationCallOrder[0]!).toBeLessThan(prepare.mock.invocationCallOrder[0]!)
    expect(a.contentDirty).toBe(false)                         // drawn after the refresh
  })
  it('removeSurface forgets, unplaces and disposes it', async () => {
    const o = base(); const root = await createUIRoot(o)
    const s = root.createSurface({ width: 10, height: 10, fill: true })
    const forget = vi.spyOn(root.pointer!, 'forget'), dispose = vi.spyOn(s, 'dispose')
    root.removeSurface(s)
    expect(forget).toHaveBeenCalledWith(s); expect(root.screen.surfaces.has(s)).toBe(false); expect(dispose).toHaveBeenCalledTimes(1)
    expect(root.surfaces).not.toContain(s); expect(s.parent).toBeNull()
    root.removeSurface(s)                                      // not (any more) this root's: nothing to do
    expect(dispose).toHaveBeenCalledTimes(1)
  })
  it('without the pointer option it leaves the canvas alone', async () => {
    const o = { ...base(), pointer: false }; const root = await createUIRoot(o)
    expect(root.pointer).toBeNull(); expect(o.renderer.domElement.addEventListener).not.toHaveBeenCalled()
    expect(o.renderer.domElement.style.touchAction).toBe('auto')
  })
  it('frame uses the scheduler and autoTick installs the loop', async () => {
    const o = base(); const root = await createUIRoot(o)
    const tick = vi.spyOn(root, 'tick')
    root.frame(0); root.frame(16)
    expect(o.renderer.render).toHaveBeenCalled()
    expect(tick.mock.calls.map(c => c[0])).toEqual([0, 0.016])
    root.autoTick(true); expect(o.renderer.setAnimationLoop).toHaveBeenCalledWith(expect.any(Function))
    root.autoTick(false); expect(o.renderer.setAnimationLoop).toHaveBeenLastCalledWith(null)
    root.dispose()
    expect(o.renderer.domElement.removeEventListener).toHaveBeenCalled()
    const { setAnimationLoop: _, ...noLoop } = stubRenderer()
    const manual = await createUIRoot({ ...base(), renderer: noLoop })
    expect(() => manual.autoTick(true)).toThrow(/setAnimationLoop.*root\.frame/)
  })
  it('dispose frees the Surfaces and detaches everything, clearing only a loop it installed', async () => {
    const o = base(); const root = await createUIRoot(o)
    const s = root.createSurface({ width: 10, height: 10, fill: true })
    const dispose = vi.spyOn(s, 'dispose')
    root.dispose()
    expect(o.renderer.setAnimationLoop).not.toHaveBeenCalled()   // the host's own loop keeps running
    expect(dispose).toHaveBeenCalled(); expect(root.surfaces).toHaveLength(0)
    expect(root.screen.parent).toBeNull(); expect(root.world.parent).toBeNull(); expect(root.lights.group.parent).toBeNull()
    expect(o.renderer.domElement.style.touchAction).toBe('auto'); expect(o.renderer.domElement.tabIndex).toBe(-1)
    const looped = base(); const r2 = await createUIRoot(looped)
    r2.autoTick(true); r2.dispose()
    expect(looped.renderer.setAnimationLoop).toHaveBeenLastCalledWith(null)
  })
})
