import { describe, it, expect, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { Box3, OrthographicCamera, PerspectiveCamera, Quaternion, RenderTarget, Scene, Texture, Vector2, Vector3, VSMShadowMap, type DirectionalLight } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import { defaultTheme, GlassUIError, Node, resolveColor, type Theme } from '@glassui/core'
import { createUIRoot, type UIRenderer, type UIRootOptions } from '../src/root'
import { fillColors, type Surface } from '../src/surface/surface'
import { toColor } from '../src/color'
import type { QualityTier } from '../src/quality'
import { BarChart } from '../src/chart/bar'

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
/** An `'auto'` root whose frames each cost `cpuMs` of CPU time: the stub renderer advances a fake `performance.now`. */
async function timedRoot(cpuMs: number) {
  let clock = 0
  const now = vi.spyOn(performance, 'now').mockImplementation(() => clock)
  const o = base()
  o.renderer.render.mockImplementation(() => { clock += cpuMs / 2 })   // overlay: the host scene, then the UI scene
  const root = await createUIRoot({ ...o, quality: 'auto' })
  return { root, restore: () => now.mockRestore() }
}

const MOTION = '(prefers-reduced-motion: reduce)', TRANSPARENCY = '(prefers-reduced-transparency: reduce)', CONTRAST = '(prefers-contrast: more)'
/** A `matchMedia` stub: one list per query, whose `change` the test fires. */
function fakeMedia() {
  const lists = new Map<string, { matches: boolean; listeners: Set<(e: { matches: boolean }) => void> }>()
  const list = (q: string) => { let l = lists.get(q); if (!l) lists.set(q, l = { matches: false, listeners: new Set() }); return l }
  const matchMedia = vi.fn((q: string) => {
    const l = list(q)
    return {
      media: q, get matches() { return l.matches },
      addEventListener: (type: string, fn: (e: { matches: boolean }) => void) => { if (type === 'change') l.listeners.add(fn) },
      removeEventListener: (type: string, fn: (e: { matches: boolean }) => void) => { if (type === 'change') l.listeners.delete(fn) },
    }
  })
  return {
    matchMedia,
    change(q: string, matches: boolean) { const l = list(q); l.matches = matches; for (const fn of [...l.listeners]) fn({ matches }) },
    listening: (q: string) => list(q).listeners.size,
  }
}

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
  it('rejects an unknown quality tier readably, at createUIRoot and at root.quality.set', async () => {
    const o = { ...base(), quality: 'ultra' as QualityTier }
    await expect(createUIRoot(o)).rejects.toThrow(GlassUIError)
    await expect(createUIRoot(o)).rejects.toThrow(/\[createUIRoot\.quality\] 未知的画质档位 "ultra"。允许值：high, medium, low, minimal, auto/)
    expect(o.renderer.shadowMap.enabled).toBe(false)             // before touching the renderer
    const root = await createUIRoot(base())
    const s = root.createSurface({ width: 10, height: 10, fill: true })
    expect(() => root.quality.set('minimum' as QualityTier)).toThrow(/未知的画质档位.*你可能想要：minimal/)
    root.tick(1 / 60)
    expect(s.error).toBeNull(); expect(root.quality.tier).toBe('medium')
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
  it('sizes a world Surface through or behind the camera plane finitely: at most the viewport, 1 × 1 when all behind', async () => {
    const o = base(); const root = await createUIRoot(o)       // the camera at the origin looking down −z; 800 × 600 CSS px, DPR 2, medium
    const wall = root.createSurface({ width: 732, height: 244, layer: 'world' })        // 3 × 1 units
    wall.position.set(0.3, 0, -0.5); wall.rotation.y = Math.PI / 2                     // local x → −z: from z = −2 to +1
    const hair = root.createSurface({ width: 2.001 * 244, height: 244, layer: 'world' })
    hair.position.set(-0.3, 0, -0.9995); hair.rotation.y = Math.PI / 2                 // its near edge 0.001 behind the eye
    const gone = root.createSurface({ width: 488, height: 244, layer: 'world' }); gone.position.set(0, 0, 3)
    root.tick(1 / 60)
    const rt = (s: Surface) => [s.contentPass.target.width, s.contentPass.target.height]
    // the viewport's 800 × 600 CSS px at DPR 2 and medium's ½ → 832 × 640; a naive per-corner projection mirrors the
    // corners behind the eye (the wall: 704 tall) or blows them up (the hair: the 4096 cap)
    for (const s of [wall, hair]) {
      const [w, h] = rt(s)
      expect(w).toBeGreaterThan(1); expect(w).toBeLessThanOrEqual(832); expect(h).toBeLessThanOrEqual(640)
    }
    expect(rt(wall)).toEqual([320, 640])                         // its visible half: from x = 0.24 (NDC) to the right edge, full height
    expect(rt(gone)).toEqual([1, 1])
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
  it('render and renderUI leave the host\'s autoClear as they found it', async () => {
    const o = base(); const root = await createUIRoot(o)
    const seen: boolean[] = []
    o.renderer.render.mockImplementation(() => { seen.push(o.renderer.autoClear) })
    o.renderer.autoClear = false                               // a host that clears by hand
    root.renderUI()
    expect(seen).toEqual([false]); expect(o.renderer.autoClear).toBe(false)
    root.render()
    expect(seen).toEqual([false, true, false]); expect(o.renderer.autoClear).toBe(false)
    o.renderer.render.mockImplementation(() => { throw new Error('lost device') })
    expect(() => root.render()).toThrow('lost device'); expect(o.renderer.autoClear).toBe(false)   // the host scene's own throw
    const errors: unknown[] = []; root.on('error', e => errors.push(e))
    expect(() => root.renderUI()).not.toThrow(); expect(o.renderer.autoClear).toBe(false)         // the UI scene's: isolated
    expect(errors).toEqual([{ surface: null, error: new Error('lost device') }])
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
    auto.frame(0); auto.frame(16); expect(sample).toHaveBeenCalledTimes(1)
    const pinned = await createUIRoot({ ...base(), quality: 'auto', reducedTransparency: true })
    expect(pinned.quality.tier).toBe('minimal')
    pinned.quality.setReducedTransparency(false)
    expect(pinned.quality.tier).toBe('high')                  // the cap ignores the pin
    const fixed = await createUIRoot(base())
    const fixedSample = vi.spyOn(fixed.quality, 'sample')
    fixed.frame(0); fixed.frame(16); expect(fixedSample).not.toHaveBeenCalled()
  })
  it('auto quality: a frame that met the refresh samples its CPU time, a dropped one its interval; a pause, nothing', async () => {
    const { root, restore } = await timedRoot(2)
    try {
      const sample = vi.spyOn(root.quality, 'sample')
      root.frame(1000); expect(sample).not.toHaveBeenCalled()   // no interval yet
      root.frame(1016); expect(sample).toHaveBeenLastCalledWith(2)        // tick + render
      root.frame(1016); expect(sample).toHaveBeenCalledTimes(1) // the same frame twice
      root.frame(6016); expect(sample).toHaveBeenCalledTimes(1) // 5 s later (a hidden tab): not a frame time
      root.frame(6066); expect(sample).toHaveBeenLastCalledWith(50)       // > 1.5 × the 16 ms refresh: dropped
    } finally { restore() }
  })
  it('auto quality holds its tier on a 30 Hz-capped loop whose frames are cheap', async () => {
    const { root, restore } = await timedRoot(2)
    try {
      let t = 0
      for (let i = 0; i < 200; i++) root.frame(t += 1000 / 30)   // 33 ms intervals with an idle GPU
      expect(root.quality.tier).toBe('high')
    } finally { restore() }
  })
  it('auto quality steps down when every other 60 Hz frame is dropped, and back up once frames meet the refresh', async () => {
    const { root, restore } = await timedRoot(2)
    try {
      let t = 0
      root.frame(t)
      for (let i = 0; i < 60; i++) root.frame(t += i % 2 ? 50 : 1000 / 60)   // per 30 samples: 15 × 2 ms + 15 × 50 ms = 26 ms average
      expect(root.quality.tier).toBe('medium')                    // two slow windows
      for (let i = 0; i < 149; i++) root.frame(t += 1000 / 60)
      expect(root.quality.tier).toBe('medium')
      root.frame(t += 1000 / 60)
      expect(root.quality.tier).toBe('high')                      // the fifth fast window
    } finally { restore() }
  })
  it('auto quality backs off a tier that is over budget while the one below fits, then settles below it', async () => {
    const { root, restore } = await timedRoot(2)
    try {
      root.quality.set('medium')                                  // not a step down: high is probed as usual
      const changes: string[] = []
      root.on('quality', e => changes.push(e.tier))
      let t = 0
      root.frame(t)
      while (t < 120_000) root.frame(t += root.quality.tier === 'high' ? 1000 / 30 : 1000 / 60)   // high drops every other refresh
      // retries after 5, 5, then 10 fast windows; after the third step down high is never probed again
      expect(changes).toEqual(['high', 'medium', 'high', 'medium', 'high', 'medium'])
      expect(root.quality.tier).toBe('medium')
    } finally { restore() }
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
    expect(prepare.mock.calls[0]![3]).toBe(o.camera)            // a glass Surface's luma projects its glass with it
    expect(a.contentDirty).toBe(false)                         // drawn after the refresh
  })
  it('a listener removing Surfaces mid-tick does not make the tick skip the next one, nor touch a removed one', async () => {
    const o = base(); const root = await createUIRoot(o)
    const bad = root.createSurface({ width: 10, height: 10, fill: true })
    const next = root.createSurface({ width: 200, height: 100, left: 0, top: 0 })
    const later = root.createSurface({ width: 200, height: 100, left: 0, top: 200 })
    const n = new Node('box'); n.setStyle({ bg: 'nope' }); bad.root.appendChild(n)
    root.on('error', e => { if (e.surface) root.removeSurface(e.surface); root.removeSurface(later) })
    const spies = [next, later].map(s => [vi.spyOn(s, 'tick'), vi.spyOn(s, 'prepare')])
    root.tick(1 / 60)
    expect(root.surfaces).toHaveLength(1); expect(root.surfaces[0]).toBe(next)
    expect(spies[0]!.map(s => s.mock.calls.length)).toEqual([1, 1])
    expect(spies[1]!.map(s => s.mock.calls.length)).toEqual([0, 0])
  })
  it('a listener removing a Surface during a quality change does not skip the next one', async () => {
    const o = base(); const root = await createUIRoot(o)
    const bad = root.createSurface({ width: 10, height: 10, fill: true })
    const next = root.createSurface({ width: 200, height: 100, left: 0, top: 0 })
    bad.glass.geometry.deleteAttribute('iTouch')               // its glass rebuild throws
    root.on('error', e => { if (e.surface) root.removeSurface(e.surface) })
    const set = vi.spyOn(next, 'setQuality')
    root.quality.set('low')
    expect(root.surfaces).toHaveLength(1); expect(root.surfaces[0]).toBe(next); expect(set).toHaveBeenCalledTimes(1)
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
  it('autoTick(false) clears the animation loop only if autoTick installed it', async () => {
    const o = base(); const root = await createUIRoot(o)
    root.autoTick(false)
    expect(o.renderer.setAnimationLoop).not.toHaveBeenCalled()    // the host's own loop keeps running
    root.autoTick(true); root.autoTick(false); root.autoTick(false)
    expect(o.renderer.setAnimationLoop.mock.calls.map(c => c[0] === null)).toEqual([false, true])
  })
  it('follows the reduced-motion and reduced-transparency media queries live, and stops listening on dispose', async () => {
    const media = fakeMedia()
    vi.stubGlobal('matchMedia', media.matchMedia)
    try {
      const root = await createUIRoot({ ...base(), quality: 'auto' })
      const s = root.createSurface({ width: 10, height: 10, fill: true })
      const set = vi.spyOn(s, 'setQuality')
      expect(root.quality.tier).toBe('high'); expect(root.anim.reducedMotion).toBe(false)
      expect(media.listening(TRANSPARENCY)).toBe(1); expect(media.listening(MOTION)).toBe(1)
      media.change(TRANSPARENCY, true)
      expect(root.quality.tier).toBe('minimal'); expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ tier: 'minimal', glassMode: 'fill' }))
      media.change(TRANSPARENCY, false)
      expect(root.quality.tier).toBe('high')
      media.change(MOTION, true); expect(root.anim.reducedMotion).toBe(true)
      media.change(MOTION, false); expect(root.anim.reducedMotion).toBe(false)
      root.dispose()
      expect(media.listening(TRANSPARENCY)).toBe(0); expect(media.listening(MOTION)).toBe(0)
      // a root created while they match starts pinned and reduced
      media.change(TRANSPARENCY, true); media.change(MOTION, true)
      const later = await createUIRoot({ ...base(), quality: 'auto' })
      expect(later.quality.tier).toBe('minimal'); expect(later.anim.reducedMotion).toBe(true)
      later.dispose()
    } finally { vi.unstubAllGlobals() }
  })
  it('an explicit reducedMotion / reducedTransparency is fixed: the media queries are not followed', async () => {
    const media = fakeMedia()
    vi.stubGlobal('matchMedia', media.matchMedia)
    try {
      const root = await createUIRoot({ ...base(), reducedMotion: false, reducedTransparency: false })
      expect(media.listening(TRANSPARENCY)).toBe(0); expect(media.listening(MOTION)).toBe(0)
      media.change(TRANSPARENCY, true); media.change(MOTION, true)
      expect(root.quality.tier).toBe('medium'); expect(root.anim.reducedMotion).toBe(false)
      root.dispose()
    } finally { vi.unstubAllGlobals() }
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

describe('the root API for the Vue layer', () => {
  /** A root over the stub renderer, with `extra` options on top of `base()`. */
  async function createRoot(extra: Omit<Partial<UIRootOptions>, 'renderer' | 'camera'> = {}) {
    const o = { ...base(), ...extra }
    return { root: await createUIRoot(o), camera: o.camera, renderer: o.renderer }
  }
  it('setScheme restyles every Surface and fires a theme event', async () => {
    const { root } = await createRoot()
    const s = root.createSurface({ width: 100, height: 100, background: '#ffffff' })
    const n = new Node('text'); n.setProp('value', 'a'); s.root.appendChild(n); root.tick(0)
    const seen: string[] = []; root.on('theme', e => seen.push(e.scheme))
    const restyle = vi.spyOn(s, 'restyle')
    root.setScheme('dark')
    expect(root.scheme).toBe('dark'); expect(seen).toEqual(['dark']); expect(restyle).toHaveBeenCalledTimes(1)
    expect(n.dirty.paint && n.dirty.text).toBe(true)
    root.tick(0)                                             // no throw: the dark tokens resolve
    expect(s.error).toBeNull()
    root.setScheme('dark')                                   // already dark: nothing to do
    expect(seen).toEqual(['dark']); expect(restyle).toHaveBeenCalledTimes(1)
  })
  it('setTheme swaps the theme for every Surface, the animation runtime and new Surfaces', async () => {
    const { root } = await createRoot()
    const s = root.createSurface({ width: 100, height: 100 })
    const theme: Theme = { ...defaultTheme, colors: { light: { ...defaultTheme.colors.light, label: '#102030' }, dark: defaultTheme.colors.dark } }
    const seen: { theme: Theme; scheme: string; contrast: boolean }[] = []; root.on('theme', e => seen.push(e))
    const restyle = vi.spyOn(s, 'restyle'), anim = vi.spyOn(root.anim, 'setTheme')
    root.setTheme(theme)
    expect(root.theme).toBe(theme); expect(seen).toEqual([{ theme, scheme: 'light', contrast: false }])
    expect(restyle).toHaveBeenCalledTimes(1); expect(anim).toHaveBeenCalledWith(theme, 'light')
    expect(s.pointer.theme).toBe(theme)                      // the tracker's hit test resolves radius tokens against it
    const later = root.createSurface({ width: 100, height: 100 })
    expect(later.pointer.theme).toBe(theme)
    root.tick(0); expect(s.error).toBeNull(); expect(later.error).toBeNull()
  })
  it('increased contrast pins minimal and uses label borders', async () => {
    const { root } = await createRoot({ increasedContrast: true, quality: 'high' })
    expect(root.quality.tier).toBe('minimal'); expect(root.contrast).toBe(true)
    expect(fillColors(root.theme, 'light', { contrast: true }).border.getHexString()).toBe(toColor(resolveColor('label', root.theme, 'light')).getHexString())
    const auto = (await createRoot({ increasedContrast: true, quality: 'auto' })).root
    expect(auto.quality.tier).toBe('minimal')
    expect((await createRoot()).root.contrast).toBe(false)   // no matchMedia under Node
  })
  it('fillColors with contrast: black/white solid fills and a label border, per scheme', () => {
    const light = fillColors(defaultTheme, 'light', { contrast: true }), dark = fillColors(defaultTheme, 'dark', { contrast: true })
    expect([light.slab, light.glass].map(c => c.getHexString())).toEqual(['ffffff', 'ffffff'])
    expect([dark.slab, dark.glass].map(c => c.getHexString())).toEqual(['000000', '000000'])
    expect(dark.border.getHexString()).toBe(toColor(resolveColor('label', defaultTheme, 'dark')).getHexString())
    expect(fillColors(defaultTheme, 'light', { contrast: false })).toEqual(fillColors(defaultTheme, 'light'))
  })
  it('follows prefers-contrast live: pins minimal with the contrast fills; the pin holds while either query matches', async () => {
    const media = fakeMedia()
    vi.stubGlobal('matchMedia', media.matchMedia)
    try {
      const { root } = await createRoot({ quality: 'auto' })
      const s = root.createSurface({ width: 10, height: 10, fill: true })
      expect(root.contrast).toBe(false); expect(media.listening(CONTRAST)).toBe(1)
      media.change(CONTRAST, true)
      expect(root.contrast).toBe(true); expect(root.quality.tier).toBe('minimal'); expect(s.error).toBeNull()
      media.change(TRANSPARENCY, true); media.change(CONTRAST, false)
      expect(root.contrast).toBe(false); expect(root.quality.tier).toBe('minimal')   // reduced transparency still pins
      media.change(TRANSPARENCY, false)
      expect(root.quality.tier).toBe('high')
      root.dispose()
      expect(media.listening(CONTRAST)).toBe(0)
      media.change(CONTRAST, true)
      const later = (await createRoot({ quality: 'auto' })).root
      expect(later.contrast).toBe(true); expect(later.quality.tier).toBe('minimal')
      later.dispose()
      const fixed = (await createRoot({ quality: 'auto', increasedContrast: false })).root
      expect(fixed.contrast).toBe(false); expect(fixed.quality.tier).toBe('high'); expect(media.listening(CONTRAST)).toBe(0)
      fixed.dispose()
    } finally { vi.unstubAllGlobals() }
  })
  it('a live contrast change emits one theme event and rebuilds each Surface\'s glass once, whether or not the tier moves', async () => {
    const media = fakeMedia()
    vi.stubGlobal('matchMedia', media.matchMedia)
    try {
      const { root } = await createRoot({ quality: 'auto' })
      const s = root.createSurface({ width: 10, height: 10, fill: true })
      const seen: { scheme: string; contrast: boolean }[] = []; root.on('theme', e => seen.push({ scheme: e.scheme, contrast: e.contrast }))
      const build = vi.spyOn(s as unknown as { buildGlass(q: unknown): void }, 'buildGlass')
      media.change(CONTRAST, true)                           // high → minimal: the tier change rebuilds (setQuality)
      expect(seen).toEqual([{ scheme: 'light', contrast: true }]); expect(build).toHaveBeenCalledTimes(1)
      media.change(TRANSPARENCY, true)                       // pinned already: nothing rebuilds
      expect(build).toHaveBeenCalledTimes(1)
      media.change(CONTRAST, false)                          // still pinned: the tier stays, restyle rebuilds
      expect(seen).toEqual([{ scheme: 'light', contrast: true }, { scheme: 'light', contrast: false }]); expect(build).toHaveBeenCalledTimes(2)
      root.setScheme('dark')
      expect(seen[2]).toEqual({ scheme: 'dark', contrast: false })
      root.dispose()
    } finally { vi.unstubAllGlobals() }
  })
  it('setScheme, setTheme and createUIRoot\'s scheme and theme reject bad input readably, changing nothing', async () => {
    const { root } = await createRoot()
    const s = root.createSurface({ width: 100, height: 100 })
    const restyle = vi.spyOn(s, 'restyle'), seen = vi.fn(); root.on('theme', seen)
    expect(() => root.setScheme('drak' as never)).toThrow(GlassUIError)
    expect(() => root.setScheme('drak' as never)).toThrow(/\[UIRoot\.setScheme\] 未知的配色方案 "drak"。允许值：light, dark。你可能想要：dark/)
    expect(root.scheme).toBe('light')
    const bare = { ...defaultTheme, colors: { light: defaultTheme.colors.light } } as unknown as Theme
    expect(() => root.setTheme(bare)).toThrow(/\[UIRoot\.setTheme\] 主题缺少颜色表/)
    expect(() => root.setTheme(null as never)).toThrow(GlassUIError)
    expect(root.theme).toBe(defaultTheme); expect(restyle).not.toHaveBeenCalled(); expect(seen).not.toHaveBeenCalled()
    const o = { ...base(), scheme: 'Dark' as never }
    await expect(createUIRoot(o)).rejects.toThrow(/\[createUIRoot\.scheme\] 未知的配色方案 "Dark"。允许值：light, dark。你可能想要：dark/)
    expect(o.renderer.shadowMap.enabled).toBe(false)         // before touching the renderer
    await expect(createUIRoot({ ...base(), theme: bare })).rejects.toThrow(/\[createUIRoot\.theme\] 主题缺少颜色表/)
  })
  it('afterTick resolves after the next tick', async () => {
    const { root } = await createRoot(); let done = false
    void root.afterTick().then(() => { done = true })
    await Promise.resolve(); expect(done).toBe(false)
    root.tick(0); await Promise.resolve(); expect(done).toBe(true)
  })
  it('afterTick resolves after the content passes and the shadow fit; a dispose settles a pending one', async () => {
    const { root, renderer } = await createRoot()
    root.createSurface({ width: 100, height: 100 })
    let at = -1
    void root.afterTick().then(() => { at = renderer.render.mock.calls.length })
    root.tick(0); await Promise.resolve()
    expect(at).toBe(1); expect(root.lights.key.shadow.needsUpdate).toBe(true)
    let settled = false
    void root.afterTick().then(() => { settled = true })
    root.dispose(); await Promise.resolve()
    expect(settled).toBe(true)                               // no tick will ever come: an await must not hang
    let late = false
    void root.afterTick().then(() => { late = true })        // after dispose: at once
    await Promise.resolve(); expect(late).toBe(true)
  })
  it('steps Surface motion in tick and tells prepare when a Surface or the camera moves', async () => {
    const { root, camera } = await createRoot()
    camera.position.set(0, 0, 5)
    const s = root.createSurface({ layer: 'world', width: 100, height: 100 })
    const prep = vi.spyOn(s, 'prepare'), moving = () => prep.mock.calls.at(-1)![4]
    root.tick(1 / 60); root.tick(1 / 60); expect(moving()).toBe(false)
    camera.position.z = 4; root.tick(1 / 60); expect(moving()).toBe(true)
    root.tick(1 / 60); expect(moving()).toBe(false)
    void s.animateTo({ position: [0.5, 0, 0] }); root.tick(1 / 60)
    expect(moving()).toBe(true); expect(s.position.x).toBeGreaterThan(0)
  })
  it('a projection-only change (a zoom, a new aspect) counts as the camera moving', async () => {
    const { root, camera } = await createRoot()
    camera.position.set(0, 0, 5)
    const s = root.createSurface({ layer: 'world', width: 100, height: 100 })
    const prep = vi.spyOn(s, 'prepare'), moving = () => prep.mock.calls.at(-1)![4]
    root.tick(1 / 60); root.tick(1 / 60); expect(moving()).toBe(false)
    camera.fov = 30; camera.updateProjectionMatrix(); root.tick(1 / 60); expect(moving()).toBe(true)
    root.tick(1 / 60); expect(moving()).toBe(false)
  })
  it('an opacity-only animation redraws the shadow map on every tick it runs', async () => {
    const { root, camera } = await createRoot()
    camera.position.set(0, 0, 5)
    const s = root.createSurface({ layer: 'world', width: 100, height: 100 }), shadow = root.lights.key.shadow
    root.tick(1 / 60); root.tick(1 / 60)
    shadow.needsUpdate = false; root.tick(1 / 60); expect(shadow.needsUpdate).toBe(false)   // quiet: no refit
    void s.animateTo({ opacity: 0.5 })
    for (let i = 0; i < 5; i++) { shadow.needsUpdate = false; root.tick(1 / 60); expect(shadow.needsUpdate).toBe(true) }
    for (let i = 0; i < 180; i++) root.tick(1 / 60)
    shadow.needsUpdate = false; root.tick(1 / 60); expect(shadow.needsUpdate).toBe(false)   // settled: quiet again
  })
  it('a world Surface out of view is neither drawn nor prepared, and redraws when it comes back', async () => {
    const { root, camera } = await createRoot()
    camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0)
    const s = root.createSurface({ layer: 'world', width: 100, height: 100 }); root.tick(1 / 60)
    expect(s.culled).toBe(false); expect(s.contentDirty).toBe(false)
    s.contentDirty = true; camera.lookAt(0, 0, 10); root.tick(1 / 60)
    expect(s.culled).toBe(true); expect(s.layer.visible).toBe(false); expect(s.contentDirty).toBe(true)
    camera.lookAt(0, 0, 0); root.tick(1 / 60)
    expect(s.layer.visible).toBe(true); expect(s.contentDirty).toBe(false)
  })
  it('the shadow fit counts only the Surfaces it draws: a hidden or culled one leaves it', async () => {
    const { root, camera } = await createRoot()
    camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0)
    const a = root.createSurface({ layer: 'world', width: 100, height: 100 })
    const b = root.createSurface({ layer: 'world', width: 100, height: 100 }); b.position.set(3, 0, 0)
    root.tick(1 / 60)
    const shadowSpan = () => { const c = root.lights.key.shadow.camera; return Math.hypot(c.right - c.left, c.top - c.bottom) }
    const both = shadowSpan()
    b.opacity = 0; root.tick(1 / 60)
    expect(shadowSpan()).toBeLessThan(both * 0.5)                     // a alone: one 0.4-unit Surface instead of 3.4 units
    b.opacity = 1; root.tick(1 / 60); expect(shadowSpan()).toBeCloseTo(both)
    b.position.set(0, 0, 10); root.tick(1 / 60); expect(b.culled).toBe(true)   // behind the camera
    expect(shadowSpan()).toBeLessThan(both * 0.5)
    expect(a.culled).toBe(false)
  })
  it('a billboard world Surface faces the camera after a tick', async () => {
    const { root, camera } = await createRoot()
    const s = root.createSurface({ layer: 'world', width: 100, height: 100, billboard: true })
    const plain = root.createSurface({ layer: 'world', width: 100, height: 100 })
    expect(s.billboard).toBe(true); expect(plain.billboard).toBe(false)
    camera.position.set(3, 1, 5); camera.lookAt(0, 0, 0); camera.updateMatrixWorld()
    root.tick(0)
    expect(s.getWorldQuaternion(new Quaternion()).angleTo(camera.getWorldQuaternion(new Quaternion()))).toBeLessThan(1e-6)
    expect(plain.quaternion.equals(new Quaternion())).toBe(true)
    root.world.rotation.set(0.3, -0.8, 0.2)                 // a rotated parent: the Surface still faces the camera
    root.tick(0)
    expect(s.getWorldQuaternion(new Quaternion()).angleTo(camera.getWorldQuaternion(new Quaternion()))).toBeLessThan(1e-6)
  })
  it('screenFromPoint projects a Surface pt to canvas px', async () => {
    const { root } = await createRoot()                     // the stub's size is 800 × 600
    const s = root.createSurface({ width: 200, height: 100, left: 300, top: 250 }); root.tick(0)
    const p = root.screenFromPoint(s, 100, 50)!
    expect(p.x).toBeCloseTo(400, 3); expect(p.y).toBeCloseTo(300, 3)
    const tl = root.screenFromPoint(s, 0, 0)!
    expect(tl.x).toBeCloseTo(300, 3); expect(tl.y).toBeCloseTo(250, 3)
  })
  it('screenFromPoint: a world Surface through the camera, null behind it', async () => {
    const { root, camera } = await createRoot()
    const w = root.createSurface({ layer: 'world', width: 488, height: 244 }); w.position.set(0, 0, -5)
    root.tick(0)
    const c = root.screenFromPoint(w, 244, 122)!
    expect(c.x).toBeCloseTo(400, 3); expect(c.y).toBeCloseTo(300, 3)
    const v = new Vector3(-1, 0.5, -5).project(camera)       // the top-left corner: 2 × 1 units about (0, 0, −5)
    const tl = root.screenFromPoint(w, 0, 0)!
    expect(tl.x).toBeCloseTo((v.x + 1) / 2 * 800, 3); expect(tl.y).toBeCloseTo((1 - v.y) / 2 * 600, 3)
    w.position.set(0, 0, 5); root.tick(0)
    expect(root.screenFromPoint(w, 244, 122)).toBeNull()
    w.position.set(0.5, 0, 0.05); root.tick(0)               // just behind the eye, still in front of nothing
    expect(root.screenFromPoint(w, 244, 122)).toBeNull()
  })
  it('screenFromPoint: a point past the far plane still projects (a caret there keeps its place)', async () => {
    const { root, camera } = await createRoot()             // far = 100
    const w = root.createSurface({ layer: 'world', width: 488, height: 244 }); w.position.set(0, 0, -150)
    root.tick(0)
    const c = root.screenFromPoint(w, 244, 122)!
    expect(c).not.toBeNull(); expect(c.x).toBeCloseTo(400, 3); expect(c.y).toBeCloseTo(300, 3)
    const v = new Vector3(-1, 0.5, -150).project(camera)
    const tl = root.screenFromPoint(w, 0, 0)!
    expect(tl.x).toBeCloseTo((v.x + 1) / 2 * 800, 3); expect(tl.y).toBeCloseTo((1 - v.y) / 2 * 600, 3)
    w.position.set(0, 0, -0.05); root.tick(0)               // nearer than the near plane (0.1), in front: projects too
    expect(root.screenFromPoint(w, 244, 122)).not.toBeNull()
  })
  it('createSurface centres a { center: true } screen Surface; fill wins over center, center over left/top', async () => {
    const { root } = await createRoot()
    const c = root.createSurface({ width: 200, height: 100, center: true, left: 10, top: 10 })
    const f = root.createSurface({ width: 200, height: 100, center: true, fill: true })
    root.tick(0)
    expect(c.position.x).toBeCloseTo(0); expect(c.position.y).toBeCloseTo(0)
    const p = root.screenFromPoint(c, 0, 0)!
    expect(p.x).toBeCloseTo(300, 3); expect(p.y).toBeCloseTo(250, 3)
    expect(f.model.width).toBe(800); expect(f.model.height).toBe(600)
  })
  it('createCameraRig: one live rig per root, perspective only, driven by tick', async () => {
    const { root, camera } = await createRoot()
    const rig = root.createCameraRig()
    expect(() => root.createCameraRig()).toThrow(/\[UIRoot\.createCameraRig\].*已经有/)
    const s = root.createSurface({ layer: 'world', width: 244, height: 244 }); s.position.set(2, 0, 0)
    void rig.focus(s, { immediate: true }); root.tick(1 / 60)
    expect(camera.position.x).toBeCloseTo(2)
    rig.dispose(); expect(() => root.createCameraRig()).not.toThrow()
    const o = base(); const ortho = await createUIRoot({ ...o, camera: new OrthographicCamera() })
    expect(() => ortho.createCameraRig()).toThrow(/PerspectiveCamera/)
  })
  it('the rig moves the camera before the screen layer and the lights follow it; root.dispose disposes the rig', async () => {
    const { root, camera } = await createRoot()
    const rig = root.createCameraRig()
    const s = root.createSurface({ layer: 'world', width: 244, height: 244 }); s.position.set(-3, 1, 0)
    void rig.focus(s, { immediate: true }); root.tick(1 / 60)
    expect(camera.position.x).toBeCloseTo(-3); expect(camera.position.y).toBeCloseTo(1)
    // the same tick: the screen layer near · 4 in front of the camera where the rig put it, the lights on it
    const ahead = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
    expect(root.screen.position.distanceTo(camera.position.clone().addScaledVector(ahead, camera.near * 4))).toBeLessThan(1e-9)
    expect(root.lights.group.position.distanceTo(camera.position)).toBeLessThan(1e-9)
    root.dispose()
    expect(rig.disposed).toBe(true)
    expect(() => root.createCameraRig()).toThrow(/\[UIRoot\.createCameraRig\].*dispose/)
  })
  it('with a focused rig the lights follow its light pose, without one the camera', async () => {
    const { root, camera } = await createRoot()
    root.tick(1 / 60); expect(root.lights.group.position.distanceTo(camera.getWorldPosition(new Vector3()))).toBeLessThan(1e-9)
    const rig = root.createCameraRig(), s = root.createSurface({ layer: 'world', width: 244, height: 244 })
    void rig.focus(s, { immediate: true }); root.tick(1 / 60)
    expect(root.lights.group.position.distanceTo(rig.lightPose!.position)).toBeLessThan(1e-9)
    expect(root.lights.group.quaternion.angleTo(rig.lightPose!.quaternion)).toBeLessThan(1e-9)
  })
  it('a moving light refits the shadow map', async () => {
    const { root } = await createRoot()
    const rig = root.createCameraRig(), a = root.createSurface({ layer: 'world', width: 244, height: 244 }), b = root.createSurface({ layer: 'world', width: 244, height: 244 })
    b.position.set(3, 0, 0); void rig.focus(a, { immediate: true }); root.tick(1 / 60); root.tick(1 / 60)
    root.lights.key.shadow.needsUpdate = false
    void rig.focus(b); root.tick(1 / 60); expect(root.lights.key.shadow.needsUpdate).toBe(true)
  })
  it('the light alone moving (the camera at rest) refits the shadow map', async () => {
    const { root, camera } = await createRoot()
    const rig = root.createCameraRig(), a = root.createSurface({ layer: 'world', width: 244, height: 244 }), b = root.createSurface({ layer: 'world', width: 244, height: 244 })
    b.position.set(3, 0, 0); void rig.focus(a, { immediate: true }); root.tick(1 / 60)
    let ok = false; void rig.focus(b).then(v => { ok = v })
    for (let i = 0; i < 300 && !ok; i++) { root.tick(1 / 60); await Promise.resolve() }
    expect(ok).toBe(true)                                                            // the camera (0.8 s) has arrived…
    const key = root.lights.key, view = camera.matrixWorld.clone(), light = root.lights.group.matrixWorld.clone()
    key.shadow.needsUpdate = false; root.tick(1 / 60)
    expect(camera.matrixWorld.equals(view)).toBe(true); expect(root.lights.group.matrixWorld.equals(light)).toBe(false)   // …the light (1.2 s) has not
    expect(key.shadow.needsUpdate).toBe(true)
    for (let i = 0; i < 360; i++) root.tick(1 / 60)                                 // the light at rest too: quiet
    key.shadow.needsUpdate = false; root.tick(1 / 60); expect(key.shadow.needsUpdate).toBe(false)
  })
  it('createBarChart makes a BarChart; throws after dispose', async () => {
    expect((await createRoot()).root.createBarChart()).toBeInstanceOf(BarChart)
    const { root } = await createRoot()
    root.dispose()
    expect(() => root.createBarChart()).toThrow(/\[UIRoot\.createBarChart\].*dispose/)
  })
})

describe('root hardening', () => {
  async function createRoot(extra: Omit<Partial<UIRootOptions>, 'renderer' | 'camera'> = {}) {
    const o = { ...base(), ...extra }
    return { root: await createUIRoot(o), renderer: o.renderer, scene: o.scene }
  }
  /** Makes the stub's `render` throw `message` whenever `scene` is drawn with `s`'s draws shown. */
  function throwOn(renderer: ReturnType<typeof stubRenderer>, scene: Scene, s: Surface, message = 'shader'): void {
    renderer.render.mockImplementation((drawn: Scene) => {
      let shown = false; s.layer.traverseVisible(() => { shown = true })
      if (drawn === scene && shown && s.visible) throw new Error(message)
    })
  }
  it('after dispose, frames do nothing and createSurface throws', async () => {
    const { root, renderer } = await createRoot(); root.dispose()
    const draws = renderer.render.mock.calls.length, sample = vi.spyOn(root.quality, 'sample')
    expect(() => root.tick(0)).not.toThrow(); expect(() => root.frame(0)).not.toThrow(); root.frame(16)
    root.render(); root.renderUI()
    expect(renderer.render).toHaveBeenCalledTimes(draws); expect(sample).not.toHaveBeenCalled()
    expect(() => root.createSurface({ width: 1, height: 1 })).toThrow(/dispose/)
    expect(() => root.createSurface({ width: 1, height: 1 })).toThrow(GlassUIError)
    expect(root.surfaces).toHaveLength(0)
  })
  it('after dispose, setTheme and setScheme are no-ops and autoTick touches no loop', async () => {
    const { root, renderer } = await createRoot()
    const seen = vi.fn(); root.on('theme', seen)
    root.autoTick(true); root.dispose()
    expect(renderer.setAnimationLoop).toHaveBeenLastCalledWith(null)
    const theme: Theme = { ...defaultTheme, colors: { light: { ...defaultTheme.colors.light }, dark: defaultTheme.colors.dark } }
    root.setTheme(theme); root.setScheme('dark')
    expect(root.theme).toBe(defaultTheme); expect(root.scheme).toBe('light'); expect(seen).not.toHaveBeenCalled()
    const loops = renderer.setAnimationLoop.mock.calls.length
    root.autoTick(true); root.autoTick(false)               // the host may have its own loop by now
    expect(renderer.setAnimationLoop).toHaveBeenCalledTimes(loops)
  })
  it('a Surface disposed directly leaves the root', async () => {
    const { root } = await createRoot(); const s = root.createSurface({ width: 10, height: 10 })
    const forget = vi.spyOn(root.pointer!, 'forget')
    s.dispose(); s.dispose()
    expect(root.surfaces).not.toContain(s); expect(root.screen.surfaces.has(s)).toBe(false)
    expect(forget).toHaveBeenCalledTimes(1); expect(forget).toHaveBeenCalledWith(s)
    const w = root.createSurface({ width: 10, height: 10, layer: 'world' }); w.dispose()
    expect(root.surfaces).toHaveLength(0); expect(w.parent).toBeNull()
    expect(() => root.tick(0)).not.toThrow()
    root.removeSurface(s)                                    // not this root's any more: nothing to do
  })
  it('removeSurface disposes once, and root.dispose disposes each Surface once', async () => {
    const { root } = await createRoot()
    const a = root.createSurface({ width: 10, height: 10 }), b = root.createSurface({ width: 10, height: 10 })
    const freed = vi.fn(); a.addEventListener('dispose', freed); b.addEventListener('dispose', freed)
    root.removeSurface(a); root.removeSurface(a)
    expect(freed).toHaveBeenCalledTimes(1)
    root.dispose()
    expect(freed).toHaveBeenCalledTimes(2); expect(root.surfaces).toHaveLength(0)
  })
  it('a throwing UI render fails the Surface that throws and the next frame draws the others', async () => {
    const { root, renderer } = await createRoot()
    const good = root.createSurface({ width: 10, height: 10 }), bad = root.createSurface({ width: 10, height: 10 })
    const errors: unknown[] = []; root.on('error', e => errors.push(e.surface))
    throwOn(renderer, root.uiScene, bad)
    root.tick(0); expect(() => root.renderUI()).not.toThrow()
    expect(errors).toEqual([bad]); expect(bad.error).toBeTruthy(); expect(good.error).toBeNull()
    expect(good.layer.visible).toBe(true); expect(bad.layer.visible).toBe(true)   // restored after the isolation
    expect(renderer.autoClear).toBe(true)
    // the next frame: one UI draw (no isolation pass), with the good Surface's draws shown and the failed one's not
    const uiDraws: { good: boolean; bad: boolean }[] = []
    const shows = (s: Surface) => { let shown = false; s.traverseVisible(o => { if (o === s.layer) shown = true }); return shown }
    renderer.render.mockImplementation((drawn: Scene) => { if (drawn === root.uiScene) uiDraws.push({ good: shows(good), bad: shows(bad) }) })
    root.tick(0); expect(() => root.renderUI()).not.toThrow()
    expect(uiDraws).toEqual([{ good: true, bad: false }]); expect(errors).toEqual([bad])
  })
  it('a UI render error no Surface reproduces, or that the scene throws without any Surface, fails none', async () => {
    const { root, renderer } = await createRoot()
    const a = root.createSurface({ width: 10, height: 10 }), b = root.createSurface({ width: 10, height: 10 })
    const errors: { surface: Surface | null; error: Error }[] = []; root.on('error', e => errors.push(e))
    renderer.render.mockImplementationOnce(() => { throw 'flaky' })   // once: every isolated draw succeeds
    root.renderUI()
    expect(errors).toEqual([{ surface: null, error: new Error('flaky') }])
    renderer.render.mockImplementation(() => { throw new Error('lost device') })   // with or without Surfaces
    root.renderUI()
    expect(errors[1]).toEqual({ surface: null, error: new Error('lost device') })
    expect(errors).toHaveLength(2); expect(a.error).toBeNull(); expect(b.error).toBeNull()
  })
  it('isolates every Surface that throws; a listener removing one meanwhile is fine', async () => {
    const { root, renderer } = await createRoot()
    const a = root.createSurface({ width: 10, height: 10 }), ok = root.createSurface({ width: 10, height: 10 }), b = root.createSurface({ width: 10, height: 10 })
    renderer.render.mockImplementation((drawn: Scene) => {
      let shown = 0; for (const s of [a, b]) s.layer.traverseVisible(() => { shown++ })
      if (drawn === root.uiScene && shown > 0) throw new Error('shader')
    })
    const errors: unknown[] = []; root.on('error', e => { errors.push(e.surface); root.removeSurface(b) })
    root.renderUI()
    expect(errors).toEqual([a]); expect(a.error).toBeTruthy(); expect(ok.error).toBeNull()
    expect(root.surfaces).toEqual([a, ok]); expect(b.disposed).toBe(true)
  })
  it('a swallowed throw puts back the render target three left bound; the isolation draws and the next frame start from it', async () => {
    for (const mode of ['overlay', 'shared'] as const) {
      const { root, renderer, scene } = await createRoot({ mode })
      const host = new RenderTarget(4, 4), fbo = new RenderTarget(4, 4)   // the host's target; three's internal framebuffer target
      let current: RenderTarget | null = host
      renderer.setRenderTarget.mockImplementation((t: RenderTarget | null) => { current = t })
      Object.assign(renderer, { getRenderTarget: () => current })
      const good = root.createSurface({ width: 10, height: 10 }), bad = root.createSurface({ width: 10, height: 10 })
      const drawn = mode === 'shared' ? scene : root.uiScene, draw = () => mode === 'shared' ? root.render() : root.renderUI()
      const seen: (RenderTarget | null)[] = []
      renderer.render.mockImplementation((s: Scene) => {
        if (s !== drawn) return
        seen.push(current)
        let shown = false; bad.layer.traverseVisible(() => { shown = true })
        if (shown && bad.visible) { current = fbo; throw new Error('shader') }   // `_renderScene` throwing inside its object loop
      })
      root.tick(0); draw()
      expect(bad.error).toBeTruthy(); expect(good.error).toBeNull()
      expect(current).toBe(host); expect(seen.length).toBeGreaterThan(2); expect(seen.every(t => t === host)).toBe(true)
      seen.length = 0
      root.tick(0); draw()
      expect(seen).toEqual([host]); expect(current).toBe(host)
    }
  })
  it('overlay: the host scene\'s own throw propagates with the render target put back', async () => {
    const { root, renderer, scene } = await createRoot()
    const host = new RenderTarget(4, 4), fbo = new RenderTarget(4, 4)
    let current: RenderTarget | null = host
    renderer.setRenderTarget.mockImplementation((t: RenderTarget | null) => { current = t })
    Object.assign(renderer, { getRenderTarget: () => current })
    renderer.render.mockImplementation((s: Scene) => { if (s === scene) { current = fbo; throw new Error('host bug') } })
    expect(() => root.render()).toThrow('host bug')
    expect(current).toBe(host); expect(renderer.autoClear).toBe(true)
  })
  it('without an error listener, a failure goes to the console; with one, only to the listener', async () => {
    const { root, renderer } = await createRoot()
    const s = root.createSurface({ width: 10, height: 10 }); s.name = 'form'
    const bad = new Node('box'); bad.setStyle({ bg: 'nope' }); s.root.appendChild(bad)
    const logged: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a) })
    try {
      root.tick(0)
      expect(logged).toEqual([['[glassui]', 'form', s.error]])
      renderer.render.mockImplementationOnce(() => { throw new Error('flaky') })
      root.renderUI()
      expect(logged[1]).toEqual(['[glassui]', '(no Surface)', new Error('flaky')])
      const heard = vi.fn(); root.on('error', heard)
      renderer.render.mockImplementationOnce(() => { throw new Error('again') })
      root.renderUI()
      expect(heard).toHaveBeenCalledWith({ surface: null, error: new Error('again') }); expect(logged).toHaveLength(2)
    } finally { spy.mockRestore() }
  })
  it('shared mode isolates the throwing Surface around the host scene\'s render', async () => {
    const { root, renderer, scene } = await createRoot({ mode: 'shared' })
    const good = root.createSurface({ width: 10, height: 10 }), bad = root.createSurface({ width: 10, height: 10, layer: 'world' })
    const errors: unknown[] = []; root.on('error', e => errors.push(e.surface))
    throwOn(renderer, scene, bad)
    expect(() => root.render()).not.toThrow()
    expect(errors).toEqual([bad]); expect(good.error).toBeNull()
    expect(() => root.render()).not.toThrow(); expect(errors).toEqual([bad])
  })
})
