// SPIKE (throwaway, Phase 0 ③): @pmndrs/glyph MSDF (left column) vs @glassui/text SystemFontEngine atlas (right column)
// for mixed CJK + Latin, on one flat plane under WebGPURenderer.
//
//   ?webgl       force the WebGL2 backend of WebGPURenderer
//   ?full        load the full Noto Sans SC (spikes/glyph-cjk/local/, gitignored) instead of the bundled 22 KB subset
//   ?baked       load the subset pre-baked offline (`glyph bake --msdf` → local/NotoSansSC-spike.font.glb, gitignored)
//   ?os=N        SystemFontEngine oversample (atlas px per pt, default 2)
//   ?pingfang    right column draws with the platform font instead of the same Noto subset
//
// Drag to orbit, wheel to dolly. `window.__spike` holds the timings; `__spike.measure()` renders each column alone and
// returns draw calls; `__spike.bytes()` sums the resource timing entries; `__spike.view(name)` sets a camera preset.

import {
  Scene, PerspectiveCamera, Mesh, PlaneGeometry, Group, BufferGeometry, Float32BufferAttribute, CanvasTexture,
  SRGBColorSpace, LinearFilter, LinearMipmapLinearFilter, Color, type Object3D,
} from 'three'
import { WebGPURenderer, MeshBasicNodeMaterial } from 'three/webgpu'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { glyph, msdf } from '@pmndrs/glyph'
import { ThreeConfig } from '@pmndrs/glyph/three'
import { SystemFontEngine, type GlyphPlacement } from '../../packages/text/src/index.ts'
import subsetUrl from './fonts/NotoSansSC-spike.ttf?url'

const T_MODULE = performance.now()
const params = new URLSearchParams(location.search)
const forceWebGL = params.has('webgl')
const fontUrl = params.has('full') ? '/local/NotoSansSC-Regular.ttf' : params.has('baked') ? '/local/NotoSansSC-spike.font.glb' : subsetUrl
const OS = Number(params.get('os') ?? 2)

const TEXT = '创建你的账号 Create your account 14天免费试用 ①②③ — 「引号」…'
const PROBE = 'probe: 鬱龘 (not in subset)'
const ROWS = [...[14, 17, 24, 46].map(size => ({ text: TEXT, size })), { text: PROBE, size: 24 }]
const MAXW = 520          // wrap width, pt
const S = 0.01            // world units per pt
const GAP = 22            // pt between rows
const COLOR = '#1c1c22'
// The system engine draws the same Noto Sans SC subset (registered as a CSS FontFace) so sharpness is compared on
// identical outlines; characters outside the subset fall back per glyph to the system CJK stack (PingFang SC …).
// ?pingfang draws with the platform font instead.
const SYSTEM_FAMILY = params.has('pingfang') ? 'PingFang SC' : 'Noto Sans SC Spike'
const COL_X = { glyph: -MAXW - 30, system: 30 }

const hud = document.getElementById('hud')!
hud.style.whiteSpace = 'pre'
const log = (s: string) => { hud.textContent += s + '\n'; console.log('[spike]', s) }

const spike: Record<string, unknown> = { tModule: T_MODULE, fontUrl, oversample: OS }
;(window as unknown as { __spike: typeof spike }).__spike = spike

// ---------- renderer / camera ----------
const renderer = new WebGPURenderer({ antialias: true, forceWebGL })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)
await renderer.init()
const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2'
spike.backend = backend
log(`backend ${backend} · dpr ${renderer.getPixelRatio()} · font ${fontUrl} · oversample ${OS}`)

const scene = new Scene()
spike.scene = scene
scene.background = new Color('#d9d4d2')
// 1 pt ≈ 1 CSS px at the start position: distance = S·H / (2·tan(fov/2)).
const FOV = 40
const camera = new PerspectiveCamera(FOV, innerWidth / innerHeight, 0.05, 200)
const dist = (S * innerHeight) / (2 * Math.tan((FOV / 2) * Math.PI / 180))
camera.position.set(0, 0, dist)
const controls = new OrbitControls(camera, renderer.domElement)
controls.enableDamping = true
/** Camera presets for the screenshots: front (1 pt ≈ 1 CSS px), 3× dolly onto either column's small rows, 60° tilt. */
const views: Record<string, () => void> = {
  front: () => { controls.target.set(0, 0, 0); camera.position.set(0, 0, dist) },
  zoom3glyph: () => { controls.target.set((COL_X.glyph + 230) * S, 1.1, 0); camera.position.set((COL_X.glyph + 230) * S, 1.1, dist / 3) },
  zoom3system: () => { controls.target.set((COL_X.system + 230) * S, 1.1, 0); camera.position.set((COL_X.system + 230) * S, 1.1, dist / 3) },
  angle60: () => { const a = Math.PI / 3; controls.target.set(0, 0, 0); camera.position.set(0, -Math.sin(a) * dist * 0.7, Math.cos(a) * dist * 0.7) },   // tilt about X: both columns equally far
}
spike.view = (name: string) => { controls.enableDamping = false; views[name]!(); controls.update(); controls.enableDamping = true; tick(); return name }
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight) })
Object.assign(spike, { camera, controls, renderer })

// ---------- shared layout: row tops from SystemFontEngine metrics (both columns use the same rows) ----------
const engine = new SystemFontEngine({
  createCanvas: (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h }),
  oversample: OS,
})
const run = (text: string, size: number) => ({ text, font: { family: SYSTEM_FAMILY, size, weight: 400 } })
if (SYSTEM_FAMILY !== 'PingFang SC') {
  const t = performance.now()
  document.fonts.add(await new FontFace(SYSTEM_FAMILY, `url(${subsetUrl})`).load())
  spike.systemFontFaceMs = +(performance.now() - t).toFixed(1)
}
// glyph wraps the 17 and 46 pt rows onto one more line than we do (no hanging punctuation), so they get a line of slack.
const heights = ROWS.map(r => engine.measure(run(r.text, r.size), { maxWidth: MAXW }).height + (r.size > 14 && r.text === TEXT ? Math.round(r.size * 1.3) : 0))
const total = heights.reduce((a, h) => a + h, 0) + GAP * (ROWS.length - 1)
const rowTop: number[] = []
{ let y = total / 2; for (const h of heights) { rowTop.push(y); y -= h + GAP } }

const plane = new Mesh(
  new PlaneGeometry((2 * MAXW + 140) * S, (total + 80) * S),
  new MeshBasicNodeMaterial({ color: '#f4f2ef' }),
)
plane.position.z = -0.002
scene.add(plane)

// ---------- right column: SystemFontEngine → atlas pages as CanvasTexture, one merged quad mesh per page ----------
const systemGroup = new Group()
scene.add(systemGroup)
let tSystemBuilt = 0
{
  const t = performance.now()
  const perPage = new Map<number, { pos: number[]; uv: number[] }>()
  const blank: string[] = []
  ROWS.forEach((r, i) => {
    const placements: GlyphPlacement[] = engine.layout(run(r.text, r.size), MAXW, 'left')
    for (const p of placements) {
      const acc = perPage.get(p.page) ?? { pos: [], uv: [] }
      perPage.set(p.page, acc)
      const x0 = (COL_X.system + p.x) * S, x1 = x0 + p.width * S
      const y0 = (rowTop[i]! - p.y) * S, y1 = y0 - p.height * S
      const u0 = p.u0, u1 = p.u1, v0 = 1 - p.v0, v1 = 1 - p.v1   // CanvasTexture flipY: canvas top → v = 1
      acc.pos.push(x0, y0, 0, x0, y1, 0, x1, y1, 0, x0, y0, 0, x1, y1, 0, x1, y0, 0)
      acc.uv.push(u0, v0, u0, v1, u1, v1, u0, v0, u1, v1, u1, v0)
      // (a) blank-glyph check: any coverage in the glyph's atlas slot?
      const page = engine.atlas.pages[p.page]!, size = page.width
      const data = page.getContext('2d').getImageData(Math.round(p.u0 * size), Math.round(p.v0 * size),
        Math.max(1, Math.round((p.u1 - p.u0) * size)), Math.max(1, Math.round((p.v1 - p.v0) * size))).data
      let ink = false
      for (let k = 3; k < data.length; k += 4) if (data[k]! > 0) { ink = true; break }
      if (!ink) blank.push(p.char)
    }
  })
  for (const [page, { pos, uv }] of perPage) {
    const tex = new CanvasTexture(engine.atlas.pages[page] as unknown as HTMLCanvasElement)
    tex.colorSpace = SRGBColorSpace
    tex.generateMipmaps = true
    tex.minFilter = LinearMipmapLinearFilter
    tex.magFilter = LinearFilter
    tex.anisotropy = 8
    const geo = new BufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3))
    geo.setAttribute('uv', new Float32BufferAttribute(uv, 2))
    const mesh = new Mesh(geo, new MeshBasicNodeMaterial({ map: tex, color: COLOR, transparent: true, depthWrite: false }))
    mesh.renderOrder = 10
    systemGroup.add(mesh)
  }
  tSystemBuilt = performance.now()
  spike.system = {
    layoutAndRasterMs: +(tSystemBuilt - t).toFixed(1), pages: engine.atlas.pages.length,
    pageSize: engine.atlas.pages[0]?.width, blankGlyphs: blank, glyphQuads: [...perPage.values()].reduce((n, a) => n + a.pos.length / 18, 0),
  }
  log(`SystemFontEngine: ${(tSystemBuilt - t).toFixed(1)} ms layout+raster · ${engine.atlas.pages.length} page(s) · blank: ${blank.length ? blank.join(' ') : 'none'}`)
}

// ---------- left column: @pmndrs/glyph MSDF (async; failures are recorded, the right column keeps rendering) ----------
const glyphGroup = new Group()
scene.add(glyphGroup)
type GlyphText = Object3D & { commitState(): { status: string; error?: unknown }; measure(): { missingGlyphCount: number; glyphCount: number; lineCount: number }; error: unknown }
const glyphTexts: GlyphText[] = []
let glyphInitialised = false
let tGlyphFirstPaint = 0
const glyphInfo: Record<string, unknown> = {}
spike.glyph = glyphInfo
;(async () => {
  try {
    const t0 = performance.now()
    await glyph.init()
    glyphInfo.initMs = +(performance.now() - t0).toFixed(1)
    const three = glyph.handle('main', ThreeConfig)
    const t1 = performance.now()
    const font = await glyph.fontFace(fontUrl, { format: msdf }).load()
    glyphInfo.fontLoadAndBakeMs = +(performance.now() - t1).toFixed(1)
    log(`glyph: init ${glyphInfo.initMs} ms · font load+runtime bake ${glyphInfo.fontLoadAndBakeMs} ms`)
    ROWS.forEach((r, i) => {
      try {
        const text = (three as unknown as { createText(p: unknown): GlyphText }).createText({
          font, text: r.text,
          style: { fontSize: r.size, lineHeight: 1.3, color: COLOR },
          layout: { align: 'start', wrap: 'word' },
          constraints: { width: { mode: 'at-most', size: MAXW } },
        })
        text.scale.setScalar(S)
        text.position.set(COL_X.glyph * S, rowTop[i]! * S, 0)
        glyphGroup.add(text)
        glyphTexts.push(text)
      } catch (e) {
        log(`glyph createText row ${i} threw: ${String(e)}`)
        ;((glyphInfo.rowErrors ??= []) as string[]).push(`row ${i}: ${String(e)}`)
      }
    })
    glyphInitialised = true
    tick()   // draw now: a hidden tab only gets ~1 Hz timer frames, which would inflate time-to-first-paint
    spike.glyphGpuBytes = () => ({ root: (three as unknown as { gpuBytes: number }).gpuBytes, texts: glyphTexts.map(t => (t as unknown as { gpuBytes: number }).gpuBytes) })
  } catch (e) {
    glyphInfo.fatal = String((e as Error)?.stack ?? e)
    log(`glyph FAILED: ${String(e)}`)
    console.error(e)
  }
})()

// ---------- loop + measurements ----------
let frame = 0
// rAF while visible; a timer while hidden (an automated/background tab never gets rAF, and glyph only commits on frames).
const loop = () => { tick(); if (document.visibilityState === 'visible') requestAnimationFrame(loop); else setTimeout(loop, 16) }
setTimeout(loop, 0)
spike.tick = tick
function tick() {
  controls.update()
  if (glyphInitialised) {
    try { glyph.shape() } catch (e) { if (!glyphInfo.shapeError) { glyphInfo.shapeError = String(e); log(`glyph.shape() threw: ${String(e)}`) } }
  }
  renderer.render(scene, camera)
  frame++
  if (frame === 1) { spike.firstFrameMs = +performance.now().toFixed(1); spike.systemFirstPaintMs = spike.firstFrameMs }
  if (glyphInitialised && !tGlyphFirstPaint && glyphTexts.length) {
    const states = glyphTexts.map(t => t.commitState())
    if (states.every(s => s.status !== 'pending' && s.status !== 'unbound')) {
      tGlyphFirstPaint = performance.now()
      glyphInfo.firstPaintMs = +tGlyphFirstPaint.toFixed(1)
      glyphInfo.states = states.map(s => s.status === 'failed' ? `failed: ${String(s.error)}` : s.status)
      glyphInfo.rows = glyphTexts.map((t, i) => {
        try { const m = t.measure(); return { row: i, glyphs: m.glyphCount, lines: m.lineCount, missing: m.missingGlyphCount } }
        catch (e) { return { row: i, error: String(e) } }
      })
      log(`glyph first paint @ ${glyphInfo.firstPaintMs} ms (nav-relative) · states ${JSON.stringify(glyphInfo.states)}`)
      log(`glyph rows ${JSON.stringify(glyphInfo.rows)}`)
    }
  }
}

spike.frames = () => frame
spike.glyphMeasure = () => glyphTexts.map(t => t.measure())
spike.systemMeasure = () => ROWS.map(r => engine.measure(run(r.text, r.size), { maxWidth: MAXW }))
spike.glyphStates = () => glyphTexts.map(t => { const s = t.commitState(); return s.status === 'failed' ? `failed: ${String(s.error)}` : s.status })
spike.longTasks = [] as { start: number; ms: number }[]
try {
  new PerformanceObserver(l => { for (const e of l.getEntries()) (spike.longTasks as { start: number; ms: number }[]).push({ start: Math.round(e.startTime), ms: Math.round(e.duration) }) })
    .observe({ type: 'longtask', buffered: true })
} catch { /* longtask unsupported */ }

// glyph draws through its own root Object3D added to the scene (not through `glyphGroup`), so "glyph" = everything
// that is neither the plane nor the system column.
function drawCalls(only?: 'glyph' | 'system') {
  const objs = scene.children, vis = objs.map(o => o.visible)
  for (const o of objs) o.visible = o === plane ? !only : o === systemGroup ? only !== 'glyph' : only !== 'system'
  renderer.info.reset()
  renderer.render(scene, camera)
  const { drawCalls: n, triangles } = renderer.info.render
  objs.forEach((o, i) => { o.visible = vis[i]! })
  return { drawCalls: n, triangles }
}
spike.measure = () => ({ all: drawCalls(), glyphOnly: drawCalls('glyph'), systemOnly: drawCalls('system'), memory: { ...renderer.info.memory } })
spike.bytes = () => {
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[]
  const pick = (re: RegExp) => entries.filter(e => re.test(e.name))
  const sum = (es: PerformanceResourceTiming[]) => ({
    n: es.length,
    transfer: es.reduce((a, e) => a + e.transferSize, 0),
    decoded: es.reduce((a, e) => a + e.decodedBodySize, 0),
  })
  return {
    glyphJs: sum(pick(/@pmndrs\/glyph.*\.js/)),
    glyphWasm: sum(pick(/\.wasm/)),
    font: sum(pick(/\.(ttf|otf|glb)(\?|$)/)),
    textPkg: sum(pick(/packages\/text\//)),
    three: sum(pick(/node_modules\/.*three/)),
    all: sum(entries),
    wasmFiles: pick(/\.wasm|\.(ttf|glb)(\?|$)/).map(e => ({ name: e.name.replace(location.origin, ''), transfer: e.transferSize, decoded: e.decodedBodySize, ms: +e.duration.toFixed(1) })),
  }
}
