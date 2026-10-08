# GlassUI Plan 2 of 3 — `@glassui/render` (three.js WebGPU/TSL render layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the render lists that `@glassui/core` already produces into real three.js draws — Liquid Glass slabs with real thickness, lit panels, atlas text, coloured transmitted shadows — on both the WebGPU and WebGL2 backends, with Surfaces that live either in a screen layer or anywhere in 3D, plus the small `core`/`text` seams Plan 1's final review left for this plan.

**Architecture:** `@glassui/render` is the only package that imports three. A `UIRoot` owns a UI `Scene` rendered after the host's scene with the same camera and a shared depth buffer, its own key light (VSM, transmitted shadows) and a procedural studio PMREM environment; each `Surface extends Object3D` wraps a core `SurfaceModel`, draws its non-glass content into an offscreen content RT with an orthographic camera, then draws that RT as a lit quad plus one instanced 9-slice `GlassSlab` draw (back faces then front faces), instanced panels/decorations and one instanced glyph draw per atlas page. Glass refracts by intersecting the refracted ray with the Surface plane and sampling the content RT (no screen capture) — only a Surface whose own background is glass samples the screen via `viewportMipTexture`. All materials are TSL node materials. Animation lives in `core` as a runtime that writes per-node *visual values* which the render list reads instead of the raw style, so composition (scale about centre, opacity, clips) stays in one place.

**Tech Stack:** TypeScript 5.9 strict, pnpm workspaces (`workspace:*`), Vitest 5 (Node; three objects and TSL graphs build without a GPU), three 0.186 (`three/webgpu`, `three/tsl`), yoga-layout 3.2, `@napi-rs/canvas` (tests), Vite 8 (`examples/playground`), Playwright (visual harness, WebGL2 path in CI).

**Spec:** `docs/superpowers/specs/2026-10-07-glassui-core-design.md` — §5 (all of it), §3.1 `UIRoot`, §3.2 `Surface`, §4.3 (colour → linear), §4.4 animation runtime, §7.1 pointer bridge, §7.2 keyboard routing, §9 error handling, §10 render tests. Spike findings that constrain this plan: `docs/superpowers/spikes/2026-10-07-glass-tsl-spike.md` (②b–②e), `docs/superpowers/spikes/2026-10-08-glyph-cjk.md` (Plan 2 text tasks). Reference implementation to port from: `spikes/glass3d/{slab,glass,studio,text,main}.ts`.

## Global Constraints

- Spec §2: `render` 是唯一依赖 three 的包. `core` and `text` keep passing `packages/core/test/no-three.test.ts`.
- Spec §5.7: 全部材质用 TSL 写，不写 WGSL/GLSL 字面量；不使用 MRT、compute；金字塔用普通 RT ping-pong；以 `forceWebGL: true` 跑同一套视觉回归.
- Spec §5.1: Apple 规则"玻璃不采样玻璃"按默认遵守：类 2 玻璃只看内容层. Class-2 glass samples its Surface's content RT; only a Surface with `background: 'glass'` (class 3) samples the screen.
- Spec §5.2 defaults: 厚度 = 高度 × 0.2，顶圆角 = 高度 × 0.06，底圆角 = 高度 × 0.04 (as `theme.glass.thicknessRatio/filletRatio/filletBottomRatio` × the rect's shorter side, already resolved by `buildRenderList`); capsule/circle use `cornerExponent` 2, fixed radii 4.5; profile `fillet` is the default, `lens` only for rings/decoration.
- Spec §5.2: 一个 Surface 内所有玻璃共用一份几何，用 instancing 一次绘制; glass draws 背面→正面.
- Spec §5.3: `MeshPhysicalNodeMaterial` with `backdropNode/backdropAlphaNode`; the three layers are glass shell, glow layer (`emissive = color × (0.55 + 1.2·Fresnel) × strength`, optional uv split), decoration layer; 灯光预算：不做 tone mapping，hemi + key + env 总量控制在 ≈1 (hemi 0.65 + key 1.8 + env 0.45, from spike ②c); glass depth: 深度测试开、写入关.
- Spec §5.4: VSM + `renderer.shadowMap.transmitted = true` + `material.castShadowNode = vec4(透过色, alpha)`; 默认只在 Surface 内部投影 (`castToWorld: false`); 布景要同时关掉 cast 与 receive (VSM draws receivers into the map).
- Spec §5.5: text 不受光 (unlit, readability first); 填充面板 is a lit thin plane with a superellipse SDF; decorations are flat quads riding on the element's top face.
- Spec §5.6: MSAA 4× (the host creates the renderer with `antialias: true`); quality tiers `high / medium / low / minimal` per the §5.6 table; `prefers-reduced-transparency` → minimal, `prefers-reduced-motion` → no springs/tilt.
- Spec §4.3: colours are sRGB tokens in core; the render layer converts to linear before they reach a material.
- Spec §9: 渲染循环内的异常不吞：捕获后停止该 Surface 的渲染并发 `surface.on('error')`，其它 Surface 继续; WebGPU init failure → three falls back; if WebGL2 is also missing `createUIRoot` rejects with a readable reason.
- Plan 1 conventions carried over: TS strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`; errors are `GlassUIError('[scope]', reason, { allowed, got })` in Chinese; optional fields stay absent, never `undefined`; every package has `tsconfig.json` (src) and `tsconfig.test.json` (src + test) and is listed in the root `typecheck` script; tests live in `packages/<pkg>/test/*.test.ts`.
- Pixel-level verification is done by the controller in a real browser at the **visual checkpoints** named in Tasks 21 and 24 (`pnpm --filter playground dev` on 127.0.0.1:5176, screenshots compared against `docs/images/signup-front.jpg` and `signup-depth.jpg`); implementers verify what Node can verify and build the playground without errors.

## Review Focus

Inputs the spec implies but no task's tests would otherwise exercise, most likely to bite first:

1. **A Surface projected to 0 px** (canvas hidden, window minimised, world Surface behind the camera): the content RT size must clamp to ≥ 1×1 and nothing may throw or allocate a 0-sized target — pinned in Task 14 (`contentRTSize` zero/NaN test).
2. **Tab hidden for minutes, then shown**: the first `dt` can be hundreds of seconds; springs must not explode and scroll glides must not jump — pinned in Task 19 (scheduler clamps `dt` to 1/20 s).
3. **A node removed mid-animation and re-added**: the runtime must drop its springs (no leak, no stale visual values) and restart from the target — pinned in Task 5.
4. **More glass/text instances than the buffer capacity** (a list grows from 10 to 300 buttons): instance buffers must grow without corrupting earlier instances — pinned in Task 8 (`GlassInstanceBuffer` growth test) and Task 12 (glyph batch growth).
5. **Atlas page eviction while glyph quads still reference it**: the glyph batch must rebuild every text instance that used the evicted page, not just the dirty text node — pinned in Task 4 (`epoch`) and Task 12 (rebuild on epoch change).

---

## File Structure

Changes to existing packages (Tasks 1–5):

- `packages/core/src/node.ts` — paint signal on tree changes; `elevation`/`tilt` accessors mark paint; `visual` field.
- `packages/core/src/transform2d.ts` — **new**: `Mat2D` affine helpers (compose, invert, apply, scale about a point).
- `packages/core/src/renderlist.ts` — opacity product, `transform`/`tilt` on every instance, transformed clips, `sortKey`, visual values, exported `resolveGlass`.
- `packages/core/src/events/hit.ts` — `concentric` radius uses the real parent chain; hit testing honours the composed transform.
- `packages/core/src/animation/easing.ts`, `packages/core/src/animation/runtime.ts` — **new**: tweens and the `AnimationRuntime` (spec §4.4).
- `packages/text/src/types.ts`, `atlas.ts`, `system.ts` — `maxLines`/`wrap` with ellipsis; atlas `epoch` + `invalidate()`.

New package `packages/render` (Tasks 6–20):

```
packages/render/
  package.json                 @glassui/render — deps three, @glassui/core, @glassui/text (workspace:*)
  tsconfig.json, tsconfig.test.json
  test/setup.ts                browser globals three/webgpu needs under Node (only if the import needs them)
  src/index.ts
  src/color.ts                 sRGB RGBA → linear; RGBA → three Color
  src/units.ts                 pt ↔ world units, surface pt → surface-local units (y up, centred)
  src/transform.ts             instance Matrix4 from (rect, Mat2D, elevation, tilt) in surface-local units; clip inverse packing
  src/instances.ts             InstanceBuffer: growable InstancedBufferGeometry + named vec4 attributes
  src/glass/slab9.ts           9-slice GlassSlab base geometry (attribute `slab` = anchor.xy, angle, ring) + CPU evaluator
  src/glass/vertex.ts          TSL: slab vertex position + normal from instance params (mirror of the CPU evaluator)
  src/glass/material.ts        createGlassMaterial: backdrop 'panel' | 'screen', back/front sides, glow, shadows
  src/glass/batch.ts           GlassBatch: fills the glass instance buffer from GlassInstances
  src/panel/sdf.ts             superellipse rounded-rect SDF (CPU reference + TSL)
  src/panel/material.ts        instanced lit panel material (fill, border, clip, opacity)
  src/panel/batch.ts           PanelBatch
  src/decoration/material.ts   rim + pool procedural decal materials (no Canvas2D)
  src/decoration/batch.ts      DecorationBatch
  src/text/measure.ts          createMeasureFn(engine, theme, scheme) with a cache
  src/text/pages.ts            AtlasPages: CanvasTexture per atlas page, dirty re-upload, epoch rebuild
  src/text/material.ts         glyph material (alpha mask, unlit, clip, opacity)
  src/text/batch.ts            GlyphBatch: one instanced draw per page per layer
  src/image/images.ts          ImageSet: one quad per image instance
  src/surface/partition.ts     content vs foreground split by nearest glass ancestor; draw order
  src/surface/content.ts       ContentPass: ortho camera + RT (+ mip pyramid); contentRTSize
  src/surface/surface.ts       Surface extends Object3D
  src/surface/screen.ts        ScreenLayer: camera-relative group, px ↔ units, fill surfaces
  src/lighting/studio.ts       procedural studio scene → PMREM (ported from the spike)
  src/lighting/lights.ts       UI hemi + key light, VSM, shadow-camera fit to Surface bounds
  src/blur/kawase.ts           dual-Kawase pyramid on ping-pong RTs (high tier)
  src/luma.ts                  adaptive luma: per-glass-element texel, time-smoothed ping-pong
  src/quality.ts               QualityController (tiers, hysteresis, media queries)
  src/scheduler.ts             FrameScheduler: dt clamp, tick order, needs-frame
  src/pointer.ts               canvas pointer/wheel/keyboard → Surface pt → core trackers
  src/root.ts                  createUIRoot
examples/playground/           Vite app: sign-up form on the screen layer + a world-layer scene + HUD
examples/visual/               Playwright scenes + screenshot comparison (WebGL2 in CI, WebGPU opportunistic)
```

Draw order inside one Surface, per frame (spec §5.6 steps 2–6):

1. Content RT (orthographic, Surface pt): panels → pools → content text/images (z order), rounded by the Surface's `cornerRadius`.
2. Scene: content quad (lit, depth write) → glass back faces → glass front faces (sorted far→near across Surfaces) → foreground decorations (rims) → foreground text/images (children of glass), each lifted to its glass's top face.

---

### Task 1: Core seams — paint on tree changes, `elevation`/`tilt` accessors, `visual` field

**Files:**
- Modify: `packages/core/src/node.ts`
- Test: `packages/core/test/node.test.ts` (append)

**Interfaces:**
- Consumes: `Node` (Plan 1).
- Produces: `insertBefore`/`removeChild` mark `paint`; `node.elevation = n` and `node.tilt = {x,y}` mark `paint`; `node.visual: VisualValues | null` (default `null`); `export interface VisualValues { x?: number; y?: number; width?: number; height?: number; scale?: number; opacity?: number; elevation?: number; tilt?: { x: number; y: number }; color?: RGBA; bg?: RGBA; radius?: number; glass?: Partial<Record<GlassNumericKey, number>> & { glowColor?: RGBA; tint?: RGBA | null } }` and `export type GlassNumericKey = 'thickness' | 'fillet' | 'filletBottom' | 'scatter' | 'lift' | 'edgeGlow' | 'ior' | 'dispersion' | 'roughness' | 'absorption' | 'glowStrength' | 'envIntensity' | 'specularIntensity' | 'innerGlow'`; `setVisual(v: VisualValues | null)` marks `paint`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/node.test.ts`:

```ts
describe('paint signals (Plan 2 seams)', () => {
  it('insertBefore and removeChild mark paint on the parent chain', () => {
    const root = new Node('box', 'r'); const a = new Node('box', 'a'); const b = new Node('box', 'b')
    root.appendChild(a); root.dirty.paint = false; a.dirty.paint = false
    a.appendChild(b)
    expect(a.dirty.paint).toBe(true); expect(root.dirty.paint).toBe(true)
    root.dirty.paint = false; a.dirty.paint = false
    a.removeChild(b)
    expect(a.dirty.paint).toBe(true); expect(root.dirty.paint).toBe(true)
  })
  it('elevation and tilt are accessors that mark paint', () => {
    const root = new Node('box', 'r'); const a = new Node('glass', 'a'); root.appendChild(a)
    root.dirty.paint = false; a.dirty.paint = false
    a.elevation = 4
    expect(a.elevation).toBe(4); expect(root.dirty.paint).toBe(true)
    root.dirty.paint = false; a.dirty.paint = false
    a.tilt = { x: 0.1, y: 0 }
    expect(a.tilt).toEqual({ x: 0.1, y: 0 }); expect(a.dirty.paint).toBe(true)
    a.dirty.paint = false
    a.elevation = 4   // same value: no signal
    expect(a.dirty.paint).toBe(false)
  })
  it('visual values default to null and setVisual marks paint', () => {
    const a = new Node('box', 'a')
    expect(a.visual).toBeNull()
    a.dirty.paint = false
    a.setVisual({ scale: 0.96, opacity: 0.5 })
    expect(a.visual).toEqual({ scale: 0.96, opacity: 0.5 }); expect(a.dirty.paint).toBe(true)
    a.dirty.paint = false
    a.setVisual(null)
    expect(a.visual).toBeNull(); expect(a.dirty.paint).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/test/node.test.ts -t "paint signals"`
Expected: FAIL — `setVisual is not a function`, `root.dirty.paint` is `false` after `appendChild`.

- [ ] **Step 3: Implement**

In `packages/core/src/node.ts`, add after the `NodeState` interface:

```ts
import type { RGBA } from './style/theme'

/** Glass numbers the animation runtime can drive (`glow.strength` as `glowStrength`). */
export type GlassNumericKey = 'thickness' | 'fillet' | 'filletBottom' | 'scatter' | 'lift' | 'edgeGlow' | 'ior' | 'dispersion' | 'roughness' | 'absorption' | 'glowStrength' | 'envIntensity' | 'specularIntensity' | 'innerGlow'

/**
 * Animated "visual values" (spec §4.4): what the render list draws instead of the node's layout/style targets while a
 * transition is in flight. Absolute values, not deltas; `x`/`y`/`width`/`height` replace `layout`. Written only by
 * `AnimationRuntime`; `null` when nothing is animating, so steady-state nodes cost nothing.
 */
export interface VisualValues {
  x?: number; y?: number; width?: number; height?: number
  scale?: number; opacity?: number; elevation?: number; tilt?: { x: number; y: number }
  color?: RGBA; bg?: RGBA; radius?: number
  glass?: Partial<Record<GlassNumericKey, number>> & { glowColor?: RGBA; tint?: RGBA | null }
}
```

Replace the `elevation = 0` / `tilt = { x: 0, y: 0 }` fields with private storage plus accessors, add `visual`, and mark paint in the tree mutators:

```ts
  private el = 0
  private tl = { x: 0, y: 0 }
  /** Animated overrides, see `VisualValues`; set through `setVisual`. */
  visual: VisualValues | null = null

  /** Lift along the Surface normal, pt (spec §3.3). Not laid out; assigning a new value marks `paint`. */
  get elevation(): number { return this.el }
  set elevation(v: number) { if (v !== this.el) { this.el = v; this.markDirty('paint') } }
  /** Hover tilt in radians about x and y; assigning marks `paint` when either component changes. */
  get tilt(): { x: number; y: number } { return this.tl }
  set tilt(v: { x: number; y: number }) { if (v.x !== this.tl.x || v.y !== this.tl.y) { this.tl = { x: v.x, y: v.y }; this.markDirty('paint') } }

  setVisual(v: VisualValues | null): void { this.visual = v; this.markDirty('paint') }
```

and in both `insertBefore` and `removeChild` change the final line to:

```ts
    this.markDirty('tree'); this.markDirty('layout'); this.markDirty('paint')
```

- [ ] **Step 4: Run the whole core suite**

Run: `pnpm vitest run packages/core`
Expected: PASS (existing tests that set `elevation` keep working through the setter).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/node.ts packages/core/test/node.test.ts
git commit -m "feat(core): tree changes and elevation/tilt mark paint; visual values on Node"
```

---

### Task 2: Render list — composed transforms, opacity product, transformed clips, sort keys, visual values

**Files:**
- Create: `packages/core/src/transform2d.ts`
- Modify: `packages/core/src/renderlist.ts`, `packages/core/src/index.ts`
- Test: `packages/core/test/transform2d.test.ts`, `packages/core/test/renderlist.test.ts` (append)

**Interfaces:**
- Consumes: `Node.visual` (Task 1), `effectiveStyle`, `resolveColor`, `resolveRadius`, `resolveTextStyle`.
- Produces:
  - `export interface Mat2D { a: number; b: number; c: number; d: number; tx: number; ty: number }` with `x' = a·x + c·y + tx`, `y' = b·x + d·y + ty`; `IDENTITY`, `multiply(p, q)` (apply `q` first, then `p`), `invert(m)`, `apply(m, x, y): [number, number]`, `scaleAbout(cx, cy, s)`, `isIdentity(m)`.
  - `InstanceTransform` gains `transform: Mat2D` (composed surface-pt affine of every ancestor's scale about its own centre, then this node's), `tilt: { x: number; y: number }` (own), `opacity: number` (product down the tree, 0..1); `scale` stays the product. `PanelInstance` no longer declares its own `opacity`: the field it inherits from `InstanceTransform` is the product, not the node's own value.
  - `ClipRect` gains `transform: Mat2D` — the clipping ancestor's composed transform; the clip rect is in that ancestor's *untransformed* surface-pt space.
  - `export function sortKey(z: number, layer: 'pool' | 'glass' | 'content' | 'rim'): number` = `z + {pool: -0.25, glass: 0, content: 0.25, rim: 0.5}[layer]` — every instance's `z` is now produced through it, so within one node the order is pool < glass < content (text/image) < rim.
  - `export function resolveGlass(s: Style, rect: Rect, theme: Theme, scheme: ColorScheme, visual?: VisualValues['glass']): ResolvedGlass` (exported for the animation runtime).
  - Visual values override targets: rect from `visual.x/y/width/height` (children are positioned relative to the parent's visual rect), `visual.scale/opacity/elevation/tilt/color/bg/radius/glass`.

- [ ] **Step 1: Write the failing tests**

`packages/core/test/transform2d.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { IDENTITY, multiply, invert, apply, scaleAbout, isIdentity } from '../src/transform2d'

describe('Mat2D', () => {
  it('scaleAbout keeps the pivot fixed and scales distances', () => {
    const m = scaleAbout(100, 50, 0.5)
    expect(apply(m, 100, 50)).toEqual([100, 50])
    expect(apply(m, 140, 50)).toEqual([120, 50])
  })
  it('multiply applies the right operand first', () => {
    const outer = scaleAbout(0, 0, 2), inner = scaleAbout(10, 10, 0.5)
    const m = multiply(outer, inner)
    // inner: (20,10) → (15,10); outer: → (30,20)
    expect(apply(m, 20, 10)).toEqual([30, 20])
  })
  it('invert undoes apply', () => {
    const m = multiply(scaleAbout(30, 40, 1.5), { a: 1, b: 0.2, c: -0.1, d: 1, tx: 5, ty: -3 })
    const [x, y] = apply(m, 12, 34)
    const [bx, by] = apply(invert(m), x, y)
    expect(bx).toBeCloseTo(12, 9); expect(by).toBeCloseTo(34, 9)
  })
  it('isIdentity', () => { expect(isIdentity(IDENTITY)).toBe(true); expect(isIdentity(scaleAbout(1, 1, 0.9))).toBe(false) })
})
```

Append to `packages/core/test/renderlist.test.ts`:

```ts
describe('transform, opacity and clip composition (Plan 2 seams)', () => {
  function tree() {
    const s = createSurface({ id: 't', width: 400, height: 400 })
    const outer = new Node('box', 'outer'); outer.setStyle({ position: 'absolute', left: 100, top: 100, width: 200, height: 200, bg: 'fill', scale: 0.5, opacity: 0.5, overflow: 'hidden', radius: 20 })
    const inner = new Node('box', 'inner'); inner.setStyle({ position: 'absolute', left: 50, top: 50, width: 100, height: 100, bg: 'accent', scale: 2, opacity: 0.5 })
    const glass = new Node('glass', 'g'); glass.setStyle({ position: 'absolute', left: 0, top: 0, width: 40, height: 40 }); glass.tilt = { x: 0.1, y: 0 }
    const label = new Node('text', 'l'); label.setProp('value', 'x')
    s.root.appendChild(outer); outer.appendChild(inner); inner.appendChild(glass); glass.appendChild(label)
    engine.compute(s.root, 400, 400, () => ({ width: 10, height: 10 }))
    return { s, outer, inner, glass, label }
  }
  it('composes scale about each node centre down the chain', () => {
    const { s } = tree()
    const rl = buildRenderList(s, theme, 'light')
    const outer = rl.panels.find(p => p.node.id === 'outer')!, inner = rl.panels.find(p => p.node.id === 'inner')!
    // outer: 200×200 at (100,100), centre (200,200), scale .5 → its own corner maps to (150,150)
    expect(apply(outer.transform, 100, 100)).toEqual([150, 150])
    // inner: 100×100 at (150,150), centre (200,200): scale 2 about its centre, then outer's .5 about (200,200) → net 1 about (200,200)
    expect(apply(inner.transform, 150, 150)).toEqual([150, 150])
    expect(inner.scale).toBe(1)
  })
  it('multiplies opacity down the tree and carries tilt', () => {
    const { s } = tree()
    const rl = buildRenderList(s, theme, 'light')
    expect(rl.panels.find(p => p.node.id === 'inner')!.opacity).toBeCloseTo(0.25)
    expect(rl.glass[0]!.opacity).toBeCloseTo(0.25)
    expect(rl.text[0]!.opacity).toBeCloseTo(0.25)
    expect(rl.glass[0]!.tilt).toEqual({ x: 0.1, y: 0 })
    expect(rl.text[0]!.tilt).toEqual({ x: 0, y: 0 })
  })
  it('clips carry the clipping ancestor transform and stay in its untransformed space', () => {
    const { s } = tree()
    const rl = buildRenderList(s, theme, 'light')
    const inner = rl.panels.find(p => p.node.id === 'inner')!
    expect(inner.clip).toMatchObject({ x: 100, y: 100, width: 200, height: 200, radius: 20 })
    expect(apply(inner.clip!.transform, 100, 100)).toEqual([150, 150])
  })
  it('orders pool < glass < content < rim within one node and uses sortKey', () => {
    const { s } = tree()
    const rl = buildRenderList(s, theme, 'light')
    const g = rl.glass[0]!, pool = rl.decorations.find(d => d.kind === 'pool')!, rim = rl.decorations.find(d => d.kind === 'rim')!
    expect(pool.z).toBe(sortKey(g.z, 'pool')); expect(rim.z).toBe(sortKey(g.z, 'rim'))
    expect(rl.text[0]!.z).toBe(sortKey(g.z + 1, 'content'))        // the label is the glass node's only child: next pre-order index
    expect(pool.z).toBeLessThan(g.z); expect(g.z).toBeLessThan(rl.text[0]!.z); expect(rl.text[0]!.z).toBeLessThan(rim.z)
  })
  it('reads visual values instead of style and layout targets', () => {
    const { s, outer, inner } = tree()
    outer.setVisual({ x: 110, y: 100, scale: 1, opacity: 1 })
    inner.setVisual({ bg: [0, 1, 0, 1], radius: 7, elevation: 3 })
    const rl = buildRenderList(s, theme, 'light')
    const o = rl.panels.find(p => p.node.id === 'outer')!, i = rl.panels.find(p => p.node.id === 'inner')!
    expect(o.rect.x).toBe(110); expect(o.scale).toBe(1)
    expect(i.rect.x).toBe(160)                       // child follows the parent's visual position
    expect(i.color).toEqual([0, 1, 0, 1]); expect(i.radius).toBe(7); expect(i.elevation).toBe(3)
    expect(i.opacity).toBeCloseTo(0.5)               // own .5 × parent's visual 1
  })
  it('visual glass values override resolved glass params', () => {
    const { s, glass } = tree()
    glass.setStyle({ glass: { glow: { color: 'accent', strength: 1 } } })
    glass.setVisual({ glass: { glowStrength: 0.25, thickness: 3, glowColor: [1, 0, 0, 1] } })
    const rl = buildRenderList(s, theme, 'light')
    expect(rl.glass[0]!.params.glow).toEqual({ color: [1, 0, 0, 1], strength: 0.25 })
    expect(rl.glass[0]!.params.thickness).toBe(3)
  })
})
```

Add `import { apply } from '../src/transform2d'` and `import { buildRenderList, sortKey, type RenderList } from '../src/renderlist'` at the top of the render-list test. Also update the existing test `'panel opacity is the node's own'` (if present) to expect the inherited product.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/test/transform2d.test.ts packages/core/test/renderlist.test.ts`
Expected: FAIL — module `../src/transform2d` not found; `sortKey` not exported.

- [ ] **Step 3: Implement `transform2d.ts`**

```ts
/** A 2D affine in surface pt: `x' = a·x + c·y + tx`, `y' = b·x + d·y + ty` (CSS matrix convention). */
export interface Mat2D { a: number; b: number; c: number; d: number; tx: number; ty: number }

export const IDENTITY: Readonly<Mat2D> = Object.freeze({ a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 })

/** `p ∘ q`: applies `q` first, then `p`. */
export function multiply(p: Mat2D, q: Mat2D): Mat2D {
  return {
    a: p.a * q.a + p.c * q.b, b: p.b * q.a + p.d * q.b,
    c: p.a * q.c + p.c * q.d, d: p.b * q.c + p.d * q.d,
    tx: p.a * q.tx + p.c * q.ty + p.tx, ty: p.b * q.tx + p.d * q.ty + p.ty,
  }
}

export function invert(m: Mat2D): Mat2D {
  const det = m.a * m.d - m.b * m.c
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) throw new Error(`[transform2d] matrix is singular (det=${det})`)
  const a = m.d / det, b = -m.b / det, c = -m.c / det, d = m.a / det
  return { a, b, c, d, tx: -(a * m.tx + c * m.ty), ty: -(b * m.tx + d * m.ty) }
}

export function apply(m: Mat2D, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.tx, m.b * x + m.d * y + m.ty]
}

/** Uniform scale `s` about the pivot `(cx, cy)`; the pivot maps to itself. */
export function scaleAbout(cx: number, cy: number, s: number): Mat2D {
  return { a: s, b: 0, c: 0, d: s, tx: cx * (1 - s), ty: cy * (1 - s) }
}

export function isIdentity(m: Mat2D): boolean {
  return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.tx === 0 && m.ty === 0
}
```

Add `export * from './transform2d'` to `packages/core/src/index.ts`.

- [ ] **Step 4: Implement the render-list changes**

Replace the type block and `visit` in `packages/core/src/renderlist.ts`:

```ts
import { IDENTITY, multiply, scaleAbout, type Mat2D } from './transform2d'
import type { Node, Rect, VisualValues } from './node'

/** A clip region in the clipping ancestor's untransformed surface-pt space, carried with that ancestor's `transform`. */
export interface ClipRect extends Rect { radius: number; transform: Mat2D }

/** Render-time placement every instance carries; layout and hit testing use `transform` only through `hitTest`. */
export interface InstanceTransform {
  /** The node's own `elevation` plus every ancestor's, pt. */
  elevation: number
  /** The product of the effective `scale` from the root down (kept for LOD decisions; placement uses `transform`). */
  scale: number
  /** Composed affine: each ancestor's scale about its own rect centre, then this node's. `rect` is untransformed. */
  transform: Mat2D
  /** This node's own tilt (radians); tilts do not compose. */
  tilt: { x: number; y: number }
  /** The product of the effective `opacity` from the root down, 0..1. */
  opacity: number
}

export interface PanelInstance extends InstanceTransform { node: Node; rect: Rect; radius: number; color: RGBA; border?: { width: number; color: RGBA }; clip?: ClipRect; z: number }
// GlassInstance, TextInstance, DecorationInstance, ImageInstance, RenderList: unchanged shapes (they already extend InstanceTransform)

/** Draw order inside one node: pool (below the glass), glass, content (text/image children), rim (on top). */
export function sortKey(z: number, layer: 'pool' | 'glass' | 'content' | 'rim'): number {
  return z + (layer === 'pool' ? -0.25 : layer === 'glass' ? 0 : layer === 'content' ? 0.25 : 0.5)
}
```

`resolveGlass` becomes exported and takes the visual overrides:

```ts
export function resolveGlass(s: Style, rect: Rect, theme: Theme, scheme: ColorScheme, v?: VisualValues['glass']): ResolvedGlass {
  const g = s.glass ?? {}
  const d = theme.glass
  const minSide = Math.min(rect.width, rect.height)
  const variant = g.variant ?? (s.bg === 'glass-clear' ? 'clear' : d.variant)
  const o = v ?? {}
  const glowColor = o.glowColor ?? (g.glow ? resolveColor(g.glow.color, theme, scheme) : null)
  const glowStrength = o.glowStrength ?? g.glow?.strength
  return {
    thickness: o.thickness ?? g.thickness ?? minSide * d.thicknessRatio, fillet: o.fillet ?? g.fillet ?? minSide * d.filletRatio,
    filletBottom: o.filletBottom ?? g.filletBottom ?? minSide * d.filletBottomRatio, profile: g.profile ?? 'fillet',
    scatter: o.scatter ?? g.scatter ?? (variant === 'clear' ? 0.02 : d.scatter), lift: o.lift ?? g.lift ?? d.lift, edgeGlow: o.edgeGlow ?? g.edgeGlow ?? d.edgeGlow,
    ior: o.ior ?? g.ior ?? d.ior, dispersion: o.dispersion ?? g.dispersion ?? d.dispersion, roughness: o.roughness ?? g.roughness ?? d.roughness,
    tint: o.tint !== undefined ? o.tint : g.tint ? resolveColor(g.tint, theme, scheme) : null, absorption: o.absorption ?? g.absorption ?? 0,
    glow: glowColor && glowStrength !== undefined ? { color: glowColor, strength: glowStrength, ...defined({ split: g.glow?.split }) } : null,
    cornerExponent: g.cornerExponent ?? (s.radius === 'capsule' ? 2 : 4.5),
    envIntensity: o.envIntensity ?? g.envIntensity ?? d.envIntensity, specularIntensity: o.specularIntensity ?? g.specularIntensity ?? d.specularIntensity,
    innerGlow: o.innerGlow ?? g.innerGlow ?? d.innerGlow, adaptive: g.adaptive ?? d.adaptive, variant,
  }
}
```

The walk now carries the parent's absolute origin, transform and opacity, and reads visual values. The scroll offset is subtracted exactly as `absoluteRect` does (for children of `scroll` nodes):

```ts
export function buildRenderList(surface: SurfaceModel, theme: Theme, scheme: ColorScheme): RenderList {
  const rl: RenderList = { panels: [], glass: [], text: [], decorations: [], images: [] }
  let z = 0
  const visit = (n: Node, originX: number, originY: number, clip: ClipRect | undefined, parent: { elevation: number; scale: number; transform: Mat2D; opacity: number; radius: number; w: number; h: number }): void => {
    const s = effectiveStyle(n)
    if (s.display === 'none') return
    const v = n.visual
    const layout = { x: v?.x ?? n.layout.x, y: v?.y ?? n.layout.y, width: v?.width ?? n.layout.width, height: v?.height ?? n.layout.height }
    const rect: Rect = { x: originX + layout.x, y: originY + layout.y, width: layout.width, height: layout.height }
    const myZ = z++
    const elevation = parent.elevation + (v?.elevation ?? n.elevation)
    const ownScale = v?.scale ?? s.scale ?? 1
    const scale = parent.scale * ownScale
    const transform = ownScale === 1 ? parent.transform : multiply(parent.transform, scaleAbout(rect.x + rect.width / 2, rect.y + rect.height / 2, ownScale))
    const opacity = parent.opacity * (v?.opacity ?? s.opacity ?? 1)
    const tilt = v?.tilt ?? n.tilt
    const resolved = v?.radius ?? resolveRadius(s.radius, theme, rect.width, rect.height, parent.radius, inset(layout, parent.w, parent.h))
    const radius = Math.max(0, Math.min(resolved, rect.width / 2, rect.height / 2))
    const base = { node: n, rect, elevation, scale, transform, tilt, opacity, ...defined({ clip }) }
    if (n.type === 'glass' || s.bg === 'glass' || s.bg === 'glass-clear') {
      const params = resolveGlass(s, rect, theme, scheme, v?.glass)
      rl.glass.push({ ...base, radius, z: sortKey(myZ, 'glass'), params })
      rl.decorations.push(
        { ...base, kind: 'rim', radius, color: [1, 1, 1, 1], strength: 1, z: sortKey(myZ, 'rim') },
        { ...base, kind: 'pool', radius, color: params.glow ? params.glow.color : [1, 1, 1, 1], strength: params.glow ? 0.5 : 0.28, z: sortKey(myZ, 'pool') },
      )
    } else if ((s.bg !== undefined && s.bg !== 'none') || s.border) {
      const color: RGBA = v?.bg ?? (s.bg !== undefined && s.bg !== 'none' ? resolveColor(s.bg, theme, scheme) : [0, 0, 0, 0])
      const border = s.border && { width: s.border.width, color: resolveColor(s.border.color, theme, scheme) }
      rl.panels.push({ ...base, radius, color, ...defined({ border }), z: sortKey(myZ, 'glass') })
    }
    if (n.type === 'text') {
      const t = resolveTextStyle(n, theme, scheme)
      rl.text.push({
        ...base, rect: contentBox(rect, s), text: String(n.props.value ?? ''),
        font: { family: t.family, size: t.size, weight: t.weight }, color: v?.color ?? t.color, align: t.align,
        lineHeight: t.lineHeight, letterSpacing: t.letterSpacing, wrap: t.wrap, ...defined({ maxLines: t.maxLines }),
        z: sortKey(myZ, 'content'),
      })
    }
    if (n.type === 'image') rl.images.push({ ...base, src: n.props.src, radius, z: sortKey(myZ, 'content') })
    const childClip = s.overflow === 'hidden' || s.overflow === 'scroll' || n.type === 'scroll' ? clipTo(clip, rect, radius, transform) : clip
    const sx = n.type === 'scroll' ? Number(n.props.scrollX ?? 0) : 0, sy = n.type === 'scroll' ? Number(n.props.scrollY ?? 0) : 0
    for (const c of n.children) visit(c, rect.x - sx, rect.y - sy, childClip, { elevation, scale, transform, opacity, radius, w: rect.width, h: rect.height })
  }
  visit(surface.root, 0, 0, undefined, { elevation: 0, scale: 1, transform: IDENTITY, opacity: 1, radius: surface.cornerRadius, w: surface.width, h: surface.height })
  return rl
}
```

and `clipTo` takes the transform:

```ts
function clipTo(a: ClipRect | undefined, b: Rect, radius: number, transform: Mat2D): ClipRect {
  if (!a) return { x: b.x, y: b.y, width: b.width, height: b.height, radius, transform }
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y), radius, transform }
}
```

(The intersection of two clips with different transforms is approximated by intersecting their untransformed rects and keeping the innermost transform; nested scaled clips are rare in UI and this keeps the fragment-side test to one rounded rect. Note this in the doc comment.)

Remove the `absoluteRect` import if no longer used. Fix the Plan 1 tests that relied on `PanelInstance.opacity` being the node's own value.

- [ ] **Step 5: Run the core suite and typecheck**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/transform2d.ts packages/core/src/renderlist.ts packages/core/src/index.ts packages/core/test/transform2d.test.ts packages/core/test/renderlist.test.ts
git commit -m "feat(core): render list composes transforms, opacity and clips; sortKey; visual values"
```

---

### Task 3: Hit testing — `concentric` radius from the parent chain, transform-aware hits

**Files:**
- Modify: `packages/core/src/events/hit.ts`
- Test: `packages/core/test/events.test.ts` (append)

**Interfaces:**
- Consumes: `resolveRadius`, `effectiveStyle`, `Mat2D` helpers (Task 2), `Node.visual`.
- Produces: `hitTest(root, x, y, theme?)` — same signature; `concentric` radii now resolve against the parent's resolved radius and the node's inset (same rule as the render list); a node with `scale` (style or visual) is hit in its scaled footprint: the point is mapped through the inverse of the composed transform before the rounded-rect test. Children inherit the parent's transform. `absoluteRect` is unchanged (layout space).

- [ ] **Step 1: Write the failing tests**

Append to `packages/core/test/events.test.ts`:

```ts
describe('hitTest with concentric radii and scale (Plan 2 seams)', () => {
  it('concentric resolves against the parent radius minus the inset', () => {
    const s = createSurface({ id: 'h', width: 200, height: 200 })
    const card = new Node('box', 'card'); card.setStyle({ position: 'absolute', left: 0, top: 0, width: 200, height: 200, radius: 40 })
    const inner = new Node('box', 'inner'); inner.setStyle({ position: 'absolute', left: 10, top: 10, width: 180, height: 180, radius: 'concentric', bg: 'fill' })
    s.root.appendChild(card); card.appendChild(inner)
    engine.compute(s.root, 200, 200)
    // inner radius = 40 − 10 = 30 (corner centre (40,40)); (14,14) is 36.8 from it: inside the card's 40 corner, outside inner's 30
    expect(hitTest(s.root, 14, 14, theme)?.id).toBe('card')
    expect(hitTest(s.root, 30, 30, theme)?.id).toBe('inner')
  })
  it('a scaled node is hit in its scaled footprint and children follow', () => {
    const s = createSurface({ id: 'h2', width: 200, height: 200 })
    const btn = new Node('box', 'btn'); btn.setStyle({ position: 'absolute', left: 50, top: 50, width: 100, height: 100, scale: 0.5, bg: 'fill' })
    const dot = new Node('box', 'dot'); dot.setStyle({ position: 'absolute', left: 0, top: 0, width: 20, height: 20, bg: 'accent' })
    s.root.appendChild(btn); btn.appendChild(dot)
    engine.compute(s.root, 200, 200)
    // scaled about (100,100): footprint is 75..125; the layout corner (55,55) is now empty
    expect(hitTest(s.root, 55, 55, theme)?.id).toBe(`${s.id}-root`)
    expect(hitTest(s.root, 80, 80, theme)?.id).toBe('dot')   // dot's layout (50..70) maps to 75..85
    expect(hitTest(s.root, 120, 120, theme)?.id).toBe('btn')
  })
  it('visual scale is honoured too', () => {
    const s = createSurface({ id: 'h3', width: 200, height: 200 })
    const btn = new Node('box', 'btn'); btn.setStyle({ position: 'absolute', left: 50, top: 50, width: 100, height: 100, bg: 'fill' })
    s.root.appendChild(btn); engine.compute(s.root, 200, 200)
    btn.setVisual({ scale: 0.5 })
    expect(hitTest(s.root, 55, 55, theme)?.id).toBe(`${s.id}-root`)
  })
})
```

(`engine`, `createSurface`, `hitTest`, `theme` are already imported in that file; add any that are missing.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/test/events.test.ts -t "Plan 2 seams"`
Expected: FAIL — the concentric case returns `inner`; the scaled case returns `btn` at (55,55).

- [ ] **Step 3: Implement**

Rewrite `hitTest` in `packages/core/src/events/hit.ts` as a recursive walk mirroring the render list (keep `absoluteRect` as is):

```ts
import { IDENTITY, apply, invert, multiply, scaleAbout, type Mat2D } from '../transform2d'

/** How far `layout` sits inside a `w × h` parent at its nearest edge (the concentric inset). */
function inset(layout: Rect, w: number, h: number): number {
  return Math.max(0, Math.min(layout.x, layout.y, w - layout.x - layout.width, h - layout.y - layout.height))
}

function insideRounded(px: number, py: number, r: Rect, radius: number): boolean {
  if (px < r.x || py < r.y || px >= r.x + r.width || py >= r.y + r.height) return false
  const rr = Math.max(0, Math.min(radius, r.width / 2, r.height / 2))
  if (rr === 0) return true
  const cx = Math.max(r.x + rr, Math.min(px, r.x + r.width - rr)), cy = Math.max(r.y + rr, Math.min(py, r.y + r.height - rr))
  const dx = px - cx, dy = py - cy
  return dx * dx + dy * dy <= rr * rr
}

/**
 * The topmost node under `(x, y)` (Surface pt): later siblings and descendants win; rounded corners, clips
 * (`overflow: hidden|scroll`, `scroll` nodes), `display: none`, inherited `pointerEvents: 'none'` (transparent but
 * still clipping) and composed `scale` (style or visual, about each node's centre) are honoured, matching
 * `buildRenderList`. `concentric` radii resolve against the parent's resolved radius minus the node's inset.
 */
export function hitTest(root: Node, x: number, y: number, theme: Theme = defaultTheme): Node | null {
  let best: Node | null = null
  const visit = (n: Node, originX: number, originY: number, transform: Mat2D, parentRadius: number, parentW: number, parentH: number, pointerOn: boolean): void => {
    const s = effectiveStyle(n)
    if (s.display === 'none') return
    const v = n.visual
    const layout = { x: v?.x ?? n.layout.x, y: v?.y ?? n.layout.y, width: v?.width ?? n.layout.width, height: v?.height ?? n.layout.height }
    const rect: Rect = { x: originX + layout.x, y: originY + layout.y, width: layout.width, height: layout.height }
    const ownScale = v?.scale ?? s.scale ?? 1
    const t = ownScale === 1 ? transform : multiply(transform, scaleAbout(rect.x + rect.width / 2, rect.y + rect.height / 2, ownScale))
    const [lx, ly] = apply(invert(t), x, y)
    const resolved = v?.radius ?? resolveRadius(s.radius, theme, rect.width, rect.height, parentRadius, inset(layout, parentW, parentH))
    const radius = Math.max(0, Math.min(resolved, rect.width / 2, rect.height / 2))
    const inside = insideRounded(lx, ly, rect, radius)
    const on = pointerOn && s.pointerEvents !== 'none'
    if (inside && on) best = n
    const clips = s.overflow === 'hidden' || s.overflow === 'scroll' || n.type === 'scroll'
    if (clips && !inside) return
    const sx = n.type === 'scroll' ? Number(n.props.scrollX ?? 0) : 0, sy = n.type === 'scroll' ? Number(n.props.scrollY ?? 0) : 0
    for (const c of n.children) visit(c, rect.x - sx, rect.y - sy, t, radius, rect.width, rect.height, on)
  }
  visit(root, 0, 0, IDENTITY, 0, root.layout.width, root.layout.height, true)
  return best
}
```

(`pointerEvents` inheritance: a parent with `'none'` makes descendants transparent too, as in Plan 1; if Plan 1 let a child opt back in with `'auto'`, keep that rule — check the existing tests and preserve their expectations.)

- [ ] **Step 4: Run the core suite**

Run: `pnpm vitest run packages/core`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events/hit.ts packages/core/test/events.test.ts
git commit -m "fix(core): hitTest resolves concentric radii from the parent chain and honours composed scale"
```

---

### Task 4: Text engine — `maxLines`/`wrap` with ellipsis, atlas `epoch` and `invalidate()`

**Files:**
- Modify: `packages/text/src/types.ts`, `packages/text/src/atlas.ts`, `packages/text/src/system.ts`
- Test: `packages/text/test/atlas.test.ts`, `packages/text/test/system.test.ts` (append)

**Interfaces:**
- Consumes: Plan 1 `TextRun`, `AtlasManager`, `SystemFontEngine`.
- Produces:
  - `TextRun` gains `maxLines?: number | undefined` (int ≥ 1) and `wrap?: boolean | undefined` (default `true`; `false` ignores `maxWidth` for wrapping but still truncates the single line to `maxWidth` with an ellipsis). When the text exceeds `maxLines`, the last kept line is cut so that it plus `…` (U+2026) fits `maxWidth`; `measure` reports only the kept lines; `layout` emits the ellipsis glyph; `Line.truncated: boolean`.
  - `AtlasManager.epoch: number` — starts at 0, increments on every page eviction and on `invalidate()`; `invalidate()` clears every page and all slots (for a font that finished loading); `onEvict?: (page: number) => void` optional callback property.

- [ ] **Step 1: Write the failing tests**

Append to `packages/text/test/atlas.test.ts`:

```ts
describe('epoch and invalidate', () => {
  it('epoch increments on eviction and the callback names the page', () => {
    const evicted: number[] = []
    const atlas = new AtlasManager({ pageSize: 8, maxPages: 1, createCanvas })
    atlas.onEvict = p => evicted.push(p)
    expect(atlas.epoch).toBe(0)
    atlas.allocate('a', 8, 8, () => {})
    atlas.allocate('b', 8, 8, () => {})   // page full → evict page 0
    expect(atlas.epoch).toBe(1); expect(evicted).toEqual([0])
    expect(atlas.get('a')).toBeUndefined()
  })
  it('invalidate drops every slot and bumps the epoch once', () => {
    const atlas = new AtlasManager({ pageSize: 16, maxPages: 2, createCanvas })
    atlas.allocate('a', 4, 4, () => {}); atlas.allocate('b', 4, 4, () => {})
    atlas.invalidate()
    expect(atlas.epoch).toBe(1)
    expect(atlas.get('a')).toBeUndefined(); expect(atlas.get('b')).toBeUndefined()
    expect(atlas.pages.length).toBe(1)                 // pages are kept, just cleared
    expect(atlas.dirtyPages.has(0)).toBe(true)         // the cleared page must be re-uploaded
  })
})
```

Append to `packages/text/test/system.test.ts` (reuse that file's `engine`/`font` helpers):

```ts
describe('maxLines and wrap', () => {
  it('truncates to maxLines with an ellipsis that fits maxWidth', () => {
    const run = { text: 'The quick brown fox jumps over the lazy dog again and again', font, maxLines: 2 }
    const full = engine.measure({ ...run, maxLines: undefined }, { maxWidth: 120 })
    const cut = engine.measure(run, { maxWidth: 120 })
    expect(full.lines.length).toBeGreaterThan(2)
    expect(cut.lines).toHaveLength(2)
    expect(cut.lines[1]!.text.endsWith('…')).toBe(true)
    expect(cut.lines[1]!.truncated).toBe(true); expect(cut.lines[0]!.truncated).toBe(false)
    expect(cut.lines[1]!.width).toBeLessThanOrEqual(120)
    expect(cut.height).toBe(2 * cut.lines[0]!.y + (cut.lines[1]!.y - cut.lines[0]!.y))   // lines × lineHeight
    const glyphs = engine.layout(run, 120, 'left')
    expect(glyphs.some(g => g.char === '…')).toBe(true)
  })
  it('wrap:false keeps one line and truncates it with an ellipsis', () => {
    const run = { text: '这是一段很长的中文文本用于测试不换行的情况', font, wrap: false }
    const m = engine.measure(run, { maxWidth: 100 })
    expect(m.lines).toHaveLength(1)
    expect(m.lines[0]!.text.endsWith('…')).toBe(true)
    expect(m.width).toBeLessThanOrEqual(100)
  })
  it('text that fits is never truncated', () => {
    const m = engine.measure({ text: 'short', font, maxLines: 1 }, { maxWidth: 400 })
    expect(m.lines[0]!.truncated).toBe(false); expect(m.lines[0]!.text).toBe('short')
  })
  it('rejects a non-integer or < 1 maxLines', () => {
    expect(() => engine.measure({ text: 'x', font, maxLines: 0 }, {})).toThrow(/maxLines/)
    expect(() => engine.measure({ text: 'x', font, maxLines: 1.5 }, {})).toThrow(/maxLines/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/text`
Expected: FAIL — `epoch` undefined, `invalidate` not a function, `truncated` undefined, 3+ lines.

- [ ] **Step 3: Implement the atlas changes**

In `packages/text/src/atlas.ts`:

```ts
  /** Bumped whenever slots become invalid (page eviction, `invalidate()`); renderers compare it to rebuild stale quads. */
  epoch = 0
  /** Called with the page index right after that page was wiped by eviction. */
  onEvict: ((page: number) => void) | undefined

  private evictLRU(): number {
    let idx = 0
    for (let i = 1; i < this.pageData.length; i++) if (this.pageData[i]!.lastUse < this.pageData[idx]!.lastUse) idx = i
    this.wipe(idx)
    this.epoch++
    this.onEvict?.(idx)
    return idx
  }

  private wipe(idx: number): void {
    const p = this.pageData[idx]!
    for (const k of p.keys) this.slots.delete(k)
    p.keys.clear(); p.shelves = []; p.nextY = 0; p.lastUse = ++this.tick
    p.ctx.clearRect(0, 0, this.pageSize, this.pageSize)
    this.dirtyPages.add(idx)
  }

  /** Drops every glyph (e.g. after a web font finished loading and earlier rasters used a fallback). */
  invalidate(): void {
    for (let i = 0; i < this.pageData.length; i++) this.wipe(i)
    this.epoch++
  }
```

- [ ] **Step 4: Implement `maxLines`/`wrap`**

In `packages/text/src/types.ts`:

```ts
export interface TextRun { text: string; font: FontSpec; letterSpacing?: number | undefined; lineHeight?: number | undefined; maxLines?: number | undefined; wrap?: boolean | undefined }
export interface Line { text: string; start: number; end: number; width: number; y: number; truncated: boolean }
```

In `packages/text/src/system.ts`:
- `check` validates `maxLines` (`Number.isInteger(maxLines) && maxLines >= 1`, else `throw new Error(`[text] maxLines must be an integer ≥ 1, got ${maxLines}`)`).
- `shape` computes `const wrapLimit = run.wrap === false ? undefined : limit` and wraps against `wrapLimit`; every pushed row gets `truncated: false`.
- After the rows are built, apply truncation in a new private `truncate(run, clusters, rows, limit, css, ls)`:

```ts
const ELLIPSIS = '…'

  /** Keeps at most `maxLines` rows (1 when `wrap === false`); the last kept row is cut to fit `limit` with an ellipsis. */
  private truncate(run: TextRun, clusters: Cluster[], rows: Row[], limit: number | undefined, css: string, ls: number): void {
    const max = run.wrap === false ? 1 : run.maxLines
    if (max === undefined || limit === undefined) return
    const overflow = rows.length > max
    const last = rows[Math.min(max, rows.length) - 1]!
    const lastTooWide = last.line.width > limit
    if (!overflow && !lastTooWide) return
    rows.length = Math.min(max, rows.length)
    const ell = this.advance(css, ELLIPSIS) + ls
    let c1 = last.c1, width = 0
    const widths: number[] = []
    for (let k = last.c0; k < last.c1; k++) { width += clusters[k]!.w; widths.push(width) }
    // drop clusters from the end until the row plus the ellipsis fits (an empty row keeps just the ellipsis)
    while (c1 > last.c0 && (widths[c1 - last.c0 - 1]! + ell > limit || clusters[c1 - 1]!.s === ' ')) c1--
    const start = last.line.start, end = clusters[c1]?.i ?? run.text.length
    const text = run.text.slice(start, end) + ELLIPSIS
    last.c1 = c1; last.soft = false
    last.line = { text, start, end, width: (c1 > last.c0 ? widths[c1 - last.c0 - 1]! : 0) + ell, y: last.line.y, truncated: true }
  }
```

  `shape` calls `this.truncate(run, clusters, rows, limit, css, ls)` before returning. `layout` emits the ellipsis for a truncated row: after the row's clusters `[c0, c1)` it places one more glyph for `ELLIPSIS` via `glyphSlot(css, raster, ELLIPSIS, cell)` at the running `x`. `caretFromPoint`/`caretRect`/`selectionRects` stay index-based over `[c0, c1)` (the ellipsis has no index).

- [ ] **Step 5: Run the text suite and typecheck**

Run: `pnpm vitest run packages/text && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/text
git commit -m "feat(text): maxLines/wrap with ellipsis; atlas epoch, onEvict and invalidate"
```

---

### Task 5: Animation runtime (spec §4.4) — springs and tweens writing visual values

**Files:**
- Create: `packages/core/src/animation/easing.ts`, `packages/core/src/animation/runtime.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/animation-runtime.test.ts`

**Interfaces:**
- Consumes: `Spring`, `resolveSpring`, `effectiveStyle`, `resolveColor`, `resolveRadius`, `resolveGlass` (Task 2), `Node.visual`/`setVisual` (Task 1), `Theme`, `ColorScheme`.
- Produces:
  - `export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'`; `export function ease(name: Easing, t: number): number` (cubic in/out).
  - `export class AnimationRuntime { constructor(theme: Theme, scheme: ColorScheme); tick(root: Node, dt: number): boolean; reset(node: Node): void; setTheme(theme, scheme): void; get active(): number }` — `tick` walks the tree, finds nodes whose effective style has a `transition`, compares each configured key's target with the last-seen target, starts/retargets a channel (spring or tween) on change, advances all channels by `dt` (seconds), writes `node.setVisual(...)` for nodes with live channels and `setVisual(null)` when they settle, drops state for detached nodes, and returns whether any channel is still moving. The first time a node is seen, its targets are recorded without animating. Targets per key: `x y width height` from `node.layout`; `scale` from style (default 1); `opacity` (default 1); `elevation`/`tilt` from the node; `color` (text colour token → RGBA), `bg` (token → RGBA, `'none'`/glass → not animated); `radius` (resolved, pt); `glass` → every `GlassNumericKey` plus `glowColor`/`tint` RGBA from `resolveGlass`.
  - `prefers-reduced-motion`: `runtime.reducedMotion = true` makes every change jump (no channels).

- [ ] **Step 1: Write the failing tests**

`packages/core/test/animation-runtime.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { Node } from '../src/node'
import { createSurface } from '../src/surface'
import { createYogaLayout, type LayoutEngine } from '../src/layout/yoga'
import { AnimationRuntime } from '../src/animation/runtime'
import { ease } from '../src/animation/easing'
import { defaultTheme as theme } from '../src/style/theme'

let engine: LayoutEngine
beforeAll(async () => { engine = await createYogaLayout() })

function button() {
  const s = createSurface({ id: 'a', width: 300, height: 200 })
  const btn = new Node('glass', 'btn')
  btn.setStyle({ position: 'absolute', left: 10, top: 10, width: 100, height: 40, radius: 'capsule', transition: { scale: 'snappy', opacity: { duration: 0.2, easing: 'linear' }, bg: 'smooth' }, pressed: { scale: 0.96 } })
  s.root.appendChild(btn)
  engine.compute(s.root, 300, 200)
  return { s, btn }
}

describe('ease', () => {
  it('endpoints and symmetry', () => {
    for (const e of ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const) { expect(ease(e, 0)).toBe(0); expect(ease(e, 1)).toBe(1) }
    expect(ease('ease-in', 0.5)).toBeCloseTo(0.125); expect(ease('ease-out', 0.5)).toBeCloseTo(0.875); expect(ease('ease-in-out', 0.5)).toBeCloseTo(0.5)
  })
})

describe('AnimationRuntime', () => {
  it('does not animate the first time it sees a node', () => {
    const { s, btn } = button()
    const rt = new AnimationRuntime(theme, 'light')
    expect(rt.tick(s.root, 1 / 60)).toBe(false)
    expect(btn.visual).toBeNull()
  })
  it('springs scale toward the pressed branch and settles back to null', () => {
    const { s, btn } = button()
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setState({ pressed: true })
    expect(rt.tick(s.root, 1 / 60)).toBe(true)
    const first = btn.visual!.scale!
    expect(first).toBeLessThan(1); expect(first).toBeGreaterThan(0.96)
    for (let i = 0; i < 240; i++) rt.tick(s.root, 1 / 60)
    expect(btn.visual).toBeNull()                 // settled → no overrides, the style target applies
    expect(rt.active).toBe(0)
  })
  it('tweens opacity linearly over the duration', () => {
    const { s, btn } = button()
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setStyle({ opacity: 0 })
    rt.tick(s.root, 0.1)
    expect(btn.visual!.opacity).toBeCloseTo(0.5, 5)
    rt.tick(s.root, 0.1)
    rt.tick(s.root, 1 / 60)
    expect(btn.visual).toBeNull()
  })
  it('retargets mid-flight without a jump', () => {
    const { s, btn } = button()
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setState({ pressed: true }); rt.tick(s.root, 1 / 60); rt.tick(s.root, 1 / 60)
    const mid = btn.visual!.scale!
    btn.setState({ pressed: false }); rt.tick(s.root, 1 / 600)
    expect(Math.abs(btn.visual!.scale! - mid)).toBeLessThan(0.01)
  })
  it('animates bg colour per channel', () => {
    const { s, btn } = button()
    btn.setStyle({ bg: 'fill' })
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setStyle({ bg: 'accent' })
    rt.tick(s.root, 1 / 60)
    const c = btn.visual!.bg!
    expect(c[0]).toBeLessThan(1); expect(c[0]).toBeGreaterThan(0.42)   // between fill (1) and accent (0x6b/255)
  })
  it('drops state for a removed node and restarts fresh when re-added', () => {
    const { s, btn } = button()
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setState({ pressed: true }); rt.tick(s.root, 1 / 60)
    btn.remove()
    expect(rt.tick(s.root, 1 / 60)).toBe(false)
    expect(rt.active).toBe(0)
    s.root.appendChild(btn)
    rt.tick(s.root, 1 / 60)
    expect(btn.visual).toBeNull()                 // first sight again: no animation from the stale value
  })
  it('reducedMotion jumps instead of animating', () => {
    const { s, btn } = button()
    const rt = new AnimationRuntime(theme, 'light'); rt.reducedMotion = true
    rt.tick(s.root, 1 / 60)
    btn.setState({ pressed: true })
    expect(rt.tick(s.root, 1 / 60)).toBe(false); expect(btn.visual).toBeNull()
  })
  it('marks paint on the node every tick while animating', () => {
    const { s, btn } = button()
    const rt = new AnimationRuntime(theme, 'light')
    rt.tick(s.root, 1 / 60)
    btn.setState({ pressed: true }); rt.tick(s.root, 1 / 60)
    btn.dirty.paint = false; s.root.dirty.paint = false
    rt.tick(s.root, 1 / 60)
    expect(s.root.dirty.paint).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/core/test/animation-runtime.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `easing.ts`**

```ts
export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

/** Cubic easings on t ∈ [0, 1] (clamped). */
export function ease(name: Easing, t: number): number {
  const x = Math.max(0, Math.min(1, t))
  switch (name) {
    case 'linear': return x
    case 'ease-in': return x * x * x
    case 'ease-out': return 1 - Math.pow(1 - x, 3)
    case 'ease-in-out': return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
  }
}
```

- [ ] **Step 4: Implement `runtime.ts`**

```ts
import { Node, type GlassNumericKey, type VisualValues } from '../node'
import { effectiveStyle } from '../style/effective'
import { resolveColor, resolveRadius, type ColorScheme, type RGBA, type Theme } from '../style/theme'
import { resolveTextStyle } from '../style/text'
import { resolveGlass } from '../renderlist'
import { Spring, resolveSpring, type SpringConfig } from './spring'
import { ease, type Easing } from './easing'
import type { Style } from '../style/schema'

type Transition = NonNullable<Style['transition']>
type TransitionKey = keyof Transition

/** One scalar channel: a spring or a duration tween toward `target`. */
interface Channel { spring?: Spring; from?: number; to: number; t?: number; duration?: number; easing?: Easing; value: number }

interface NodeAnim {
  targets: Map<string, number>          // channel id ("scale", "bg.0", "glass.thickness", …) → last seen target
  channels: Map<string, Channel>
}

function inset(layout: { x: number; y: number; width: number; height: number }, w: number, h: number): number {
  return Math.max(0, Math.min(layout.x, layout.y, w - layout.x - layout.width, h - layout.y - layout.height))
}

/**
 * Drives spec §4.4 transitions. Each tick it reads every transitioning node's *targets* (layout, style, state
 * branches, elevation/tilt), starts a channel per changed scalar and writes the blended values into `node.visual`.
 * Nodes are keyed by identity; a node that leaves the tree loses its state on the next tick.
 */
export class AnimationRuntime {
  reducedMotion = false
  private state = new Map<Node, NodeAnim>()
  constructor(private theme: Theme, private scheme: ColorScheme) {}

  setTheme(theme: Theme, scheme: ColorScheme): void { this.theme = theme; this.scheme = scheme }
  get active(): number { let n = 0; for (const a of this.state.values()) n += a.channels.size; return n }
  reset(node: Node): void { this.state.delete(node); if (node.visual) node.setVisual(null) }

  /** Advances by `dt` seconds; returns true while any channel is still moving. */
  tick(root: Node, dt: number): boolean {
    const seen = new Set<Node>()
    let moving = false
    const visit = (n: Node, parentRadius: number, parentW: number, parentH: number): void => {
      const s = effectiveStyle(n)
      if (s.display === 'none') return
      const tr = s.transition
      const rect = n.layout
      const radius = resolveRadius(s.radius, this.theme, rect.width, rect.height, parentRadius, inset(rect, parentW, parentH))
      if (tr && Object.keys(tr).length > 0) {
        seen.add(n)
        moving = this.step(n, s, tr, radius, dt) || moving
      }
      for (const c of n.children) visit(c, radius, rect.width, rect.height)
    }
    visit(root, 0, root.layout.width, root.layout.height)
    for (const n of [...this.state.keys()]) if (!seen.has(n)) { this.state.delete(n); if (n.visual) n.setVisual(null) }
    return moving
  }

  /** The scalar targets of `n` for the configured keys, flattened to channel ids. */
  private targets(n: Node, s: Style, tr: Transition, radius: number): Map<string, number> {
    const t = new Map<string, number>()
    const rgba = (id: string, c: RGBA) => { t.set(`${id}.0`, c[0]); t.set(`${id}.1`, c[1]); t.set(`${id}.2`, c[2]); t.set(`${id}.3`, c[3]) }
    for (const k of Object.keys(tr) as TransitionKey[]) {
      switch (k) {
        case 'x': t.set('x', n.layout.x); break
        case 'y': t.set('y', n.layout.y); break
        case 'width': t.set('width', n.layout.width); break
        case 'height': t.set('height', n.layout.height); break
        case 'scale': t.set('scale', s.scale ?? 1); break
        case 'opacity': t.set('opacity', s.opacity ?? 1); break
        case 'elevation': t.set('elevation', n.elevation); break
        case 'tilt': t.set('tilt.x', n.tilt.x); t.set('tilt.y', n.tilt.y); break
        case 'radius': t.set('radius', radius); break
        case 'color': if (n.type === 'text') rgba('color', resolveTextStyle(n, this.theme, this.scheme).color); break
        case 'bg': if (s.bg && s.bg !== 'none' && s.bg !== 'glass' && s.bg !== 'glass-clear') rgba('bg', resolveColor(s.bg, this.theme, this.scheme)); break
        case 'glass': {
          if (!(n.type === 'glass' || s.bg === 'glass' || s.bg === 'glass-clear')) break
          const g = resolveGlass(s, n.layout, this.theme, this.scheme)
          const nums: Record<GlassNumericKey, number> = {
            thickness: g.thickness, fillet: g.fillet, filletBottom: g.filletBottom, scatter: g.scatter, lift: g.lift, edgeGlow: g.edgeGlow,
            ior: g.ior, dispersion: g.dispersion, roughness: g.roughness, absorption: g.absorption, glowStrength: g.glow?.strength ?? 0,
            envIntensity: g.envIntensity, specularIntensity: g.specularIntensity, innerGlow: g.innerGlow,
          }
          for (const [key, v] of Object.entries(nums)) t.set(`glass.${key}`, v)
          if (g.glow) rgba('glass.glowColor', g.glow.color)
          if (g.tint) rgba('glass.tint', g.tint)
          break
        }
      }
    }
    return t
  }

  private step(n: Node, s: Style, tr: Transition, radius: number, dt: number): boolean {
    const targets = this.targets(n, s, tr, radius)
    let anim = this.state.get(n)
    if (!anim) { anim = { targets, channels: new Map() }; this.state.set(n, anim); return false }   // first sight: record, no animation
    for (const [id, to] of targets) {
      const prev = anim.targets.get(id)
      anim.targets.set(id, to)
      if (prev === undefined || prev === to || this.reducedMotion) continue
      const key = id.split('.')[0] as TransitionKey
      const spec = resolveSpring(tr[key]!, this.theme)
      const ch = anim.channels.get(id)
      const from = ch ? ch.value : prev
      if ('stiffness' in spec) {
        if (ch?.spring) ch.spring.set(to)
        else { const sp = new Spring(from, spec as SpringConfig); sp.set(to); anim.channels.set(id, { spring: sp, to, value: from }) }
      } else {
        anim.channels.set(id, { from, to, t: 0, duration: spec.duration, easing: spec.easing as Easing, value: from })
      }
      if (ch && !ch.spring) { ch.from = ch.value; ch.to = to; ch.t = 0 }
      else if (ch?.spring) ch.to = to
    }
    for (const id of [...anim.targets.keys()]) if (!targets.has(id)) { anim.targets.delete(id); anim.channels.delete(id) }
    if (anim.channels.size === 0) { if (n.visual) n.setVisual(null); return false }
    // advance
    for (const [id, ch] of anim.channels) {
      if (ch.spring) { ch.value = ch.spring.step(dt); if (ch.spring.done) anim.channels.delete(id) }
      else {
        ch.t = (ch.t ?? 0) + dt
        const p = ch.duration! <= 0 ? 1 : Math.min(1, ch.t / ch.duration!)
        ch.value = ch.from! + (ch.to - ch.from!) * ease(ch.easing!, p)
        if (p >= 1) anim.channels.delete(id)
      }
    }
    if (anim.channels.size === 0) { n.setVisual(null); return false }
    n.setVisual(this.compose(anim))
    return true
  }

  /** Visual values from the live channels (settled keys fall back to their targets so colours stay consistent). */
  private compose(anim: NodeAnim): VisualValues {
    const v: VisualValues = {}
    const get = (id: string) => anim.channels.get(id)?.value ?? anim.targets.get(id)!
    const has = (prefix: string) => [...anim.channels.keys()].some(k => k === prefix || k.startsWith(prefix + '.'))
    const rgba = (id: string): RGBA => [get(`${id}.0`), get(`${id}.1`), get(`${id}.2`), get(`${id}.3`)]
    for (const k of ['x', 'y', 'width', 'height', 'scale', 'opacity', 'elevation', 'radius'] as const) if (has(k)) v[k] = get(k)
    if (has('tilt')) v.tilt = { x: get('tilt.x'), y: get('tilt.y') }
    if (has('color')) v.color = rgba('color')
    if (has('bg')) v.bg = rgba('bg')
    if (has('glass')) {
      const g: NonNullable<VisualValues['glass']> = {}
      for (const [id] of anim.targets) {
        if (!id.startsWith('glass.')) continue
        const key = id.slice(6)
        if (key.startsWith('glowColor')) g.glowColor = rgba('glass.glowColor')
        else if (key.startsWith('tint')) g.tint = rgba('glass.tint')
        else g[key as GlassNumericKey] = get(id)
      }
      v.glass = g
    }
    return v
  }
}
```

Add `export * from './animation/easing'` and `export * from './animation/runtime'` to `packages/core/src/index.ts`. If `resolveSpring`'s duration form returns `easing: string`, narrow it to `Easing` in `resolveSpring` (`spring.ts`) rather than casting here.

- [ ] **Step 5: Run the core suite and typecheck**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: PASS. If the "settles back to null" test needs more than 240 ticks for `snappy`, the spring `done` threshold is 1e-3 — keep the loop at 240 (4 s) and investigate the spring rather than raising the count.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/animation packages/core/src/index.ts packages/core/test/animation-runtime.test.ts
git commit -m "feat(core): AnimationRuntime drives transitions into visual values (springs and tweens)"
```

---
### Task 6: `@glassui/render` package scaffold, colour and unit helpers, three-in-Node smoke test

**Files:**
- Create: `packages/render/package.json`, `packages/render/tsconfig.json`, `packages/render/tsconfig.test.json`, `packages/render/src/index.ts`, `packages/render/src/color.ts`, `packages/render/src/units.ts`
- Modify: `package.json` (root `typecheck` script), `vitest.config.ts` (only if the smoke test needs a setup file)
- Test: `packages/render/test/smoke.test.ts`, `packages/render/test/color.test.ts`, `packages/render/test/units.test.ts`

**Interfaces:**
- Consumes: `RGBA` from `@glassui/core`.
- Produces:
  - `export function srgbToLinear(c: number): number`; `export function toLinear(c: RGBA): RGBA`; `export function toColor(c: RGBA, out?: Color): Color` (linear, alpha dropped).
  - `export interface SurfaceDims { width: number; height: number; ptPerUnit: number }`; `export function ptToUnits(pt: number, ppu: number): number`; `export function surfaceToLocal(x: number, y: number, s: SurfaceDims): [number, number]` (surface pt, y down → surface-local units, origin at the centre, y up); `export function localToSurface(ux: number, uy: number, s: SurfaceDims): [number, number]`.
  - Package `@glassui/render` resolvable from `examples/*` and tests via `workspace:*`.

- [ ] **Step 1: Create the package files**

`packages/render/package.json`:

```json
{
  "name": "@glassui/render",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@glassui/core": "workspace:*", "@glassui/text": "workspace:*" },
  "peerDependencies": { "three": "^0.186.1" },
  "devDependencies": { "three": "^0.186.1", "@types/three": "^0.186.0", "@napi-rs/canvas": "^1.0.10" }
}
```

`packages/render/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "rootDir": "src", "outDir": "dist", "lib": ["ES2022", "DOM"] }, "include": ["src"], "references": [{ "path": "../core" }, { "path": "../text" }] }
```

`packages/render/tsconfig.test.json`:

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "noEmit": true, "composite": false, "declaration": false, "rootDir": "..", "lib": ["ES2022", "DOM"] }, "include": ["src", "test", "../core/src", "../text/src"] }
```

Root `package.json` `typecheck` becomes:

```
tsc -b packages/core packages/text packages/render && tsc -p packages/core/tsconfig.test.json && tsc -p packages/text/tsconfig.test.json && tsc -p packages/render/tsconfig.test.json
```

Run `pnpm install` (offline-capable: three is already in the root devDependencies; `@napi-rs/canvas` in text's).

- [ ] **Step 2: Write the failing tests**

`packages/render/test/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { MeshPhysicalNodeMaterial, MeshBasicNodeMaterial } from 'three/webgpu'
import { float, vec3, Fn, uniform } from 'three/tsl'
import { InstancedBufferGeometry, InstancedBufferAttribute, Matrix4 } from 'three'

describe('three/webgpu and three/tsl under Node', () => {
  it('builds node materials and TSL graphs without a GPU', () => {
    const m = new MeshPhysicalNodeMaterial()
    m.backdropNode = Fn(() => vec3(0.5))()
    m.backdropAlphaNode = float(1)
    const u = uniform(0.3)
    m.roughnessNode = u
    expect(m.backdropNode).toBeTruthy()
    expect(new MeshBasicNodeMaterial().isNodeMaterial).toBe(true)
    const g = new InstancedBufferGeometry()
    g.setAttribute('iRect', new InstancedBufferAttribute(new Float32Array(8), 4))
    g.instanceCount = 2
    expect(g.instanceCount).toBe(2)
    expect(new Matrix4().identity().elements[0]).toBe(1)
  })
})
```

`packages/render/test/color.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { srgbToLinear, toLinear, toColor } from '../src/color'

describe('colour conversion', () => {
  it('matches the sRGB transfer function', () => {
    expect(srgbToLinear(0)).toBe(0); expect(srgbToLinear(1)).toBeCloseTo(1, 9)
    expect(srgbToLinear(0.5)).toBeCloseTo(0.2140, 3)
    expect(srgbToLinear(0.04)).toBeCloseTo(0.04 / 12.92, 9)
  })
  it('converts RGBA and keeps alpha linear', () => {
    expect(toLinear([0.5, 1, 0, 0.3])).toEqual([srgbToLinear(0.5), srgbToLinear(1), 0, 0.3])
    const c = toColor([0.5, 0.5, 0.5, 1])
    expect(c.r).toBeCloseTo(0.214, 3)
  })
})
```

`packages/render/test/units.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { ptToUnits, surfaceToLocal, localToSurface } from '../src/units'

describe('units', () => {
  const s = { width: 400, height: 300, ptPerUnit: 100 }
  it('pt to units', () => { expect(ptToUnits(244, 244)).toBe(1); expect(ptToUnits(50, 100)).toBe(0.5) })
  it('surface pt (y down) to local units (centred, y up) and back', () => {
    expect(surfaceToLocal(0, 0, s)).toEqual([-2, 1.5])
    expect(surfaceToLocal(400, 300, s)).toEqual([2, -1.5])
    expect(surfaceToLocal(200, 150, s)).toEqual([0, 0])
    expect(localToSurface(-2, 1.5, s)).toEqual([0, 0])
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail (and learn whether three imports under Node)**

Run: `pnpm vitest run packages/render`
Expected: `color`/`units` FAIL with module not found. If `smoke.test.ts` fails with a `ReferenceError` on `self`, `window`, `navigator` or `document` from inside `three/webgpu`, create `packages/render/test/setup.ts`:

```ts
// three/webgpu touches a few browser globals at import time; give it harmless ones under Node.
const g = globalThis as Record<string, unknown>
if (g.self === undefined) g.self = globalThis
if (g.window === undefined) g.window = globalThis
if (g.navigator === undefined) g.navigator = { gpu: undefined, userAgent: 'node' }
```

and add `setupFiles: ['packages/render/test/setup.ts']` to `test` in `vitest.config.ts`. Do not stub more than the import needs; if the import still fails for another reason, report it (BLOCKED) with the stack rather than mocking three.

- [ ] **Step 4: Implement**

`packages/render/src/color.ts`:

```ts
import { Color } from 'three'
import type { RGBA } from '@glassui/core'

/** sRGB transfer function (IEC 61966-2-1) for one channel in 0..1. */
export function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/** Core colours are sRGB-encoded (spec §4.3); materials want linear. Alpha is left alone. */
export function toLinear(c: RGBA): RGBA {
  return [srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), c[3]]
}

/** A linear three `Color` from a core RGBA (alpha dropped). `out` avoids allocation in hot paths. */
export function toColor(c: RGBA, out = new Color()): Color {
  return out.setRGB(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]))
}
```

`packages/render/src/units.ts`:

```ts
/** What converting Surface pt to Surface-local world units needs. */
export interface SurfaceDims { width: number; height: number; ptPerUnit: number }

export function ptToUnits(pt: number, ppu: number): number { return pt / ppu }

/** Surface pt (origin top-left, y down) → Surface-local units (origin at the centre, y up, z toward the viewer). */
export function surfaceToLocal(x: number, y: number, s: SurfaceDims): [number, number] {
  return [(x - s.width / 2) / s.ptPerUnit, (s.height / 2 - y) / s.ptPerUnit]
}

export function localToSurface(ux: number, uy: number, s: SurfaceDims): [number, number] {
  return [ux * s.ptPerUnit + s.width / 2, s.height / 2 - uy * s.ptPerUnit]
}
```

`packages/render/src/index.ts`:

```ts
export const RENDER_VERSION = '0.0.0'
export * from './color'
export * from './units'
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run packages/render && pnpm typecheck && pnpm vitest run packages/core/test/no-three.test.ts`
Expected: PASS (core/text still three-free).

- [ ] **Step 6: Commit**

```bash
git add packages/render package.json pnpm-lock.yaml vitest.config.ts
git commit -m "feat(render): package scaffold, sRGB→linear and surface unit helpers"
```

---

### Task 7: 9-slice `GlassSlab` base geometry and CPU vertex evaluator

**Files:**
- Create: `packages/render/src/glass/slab9.ts`
- Test: `packages/render/test/slab9.test.ts`

**Interfaces:**
- Consumes: nothing from earlier render tasks; `spikes/glass3d/slab.ts` as the oracle in tests.
- Produces:
  - `export interface SlabInstanceParams { width: number; height: number; radius: number; thickness: number; fillet: number; filletBottom: number; cornerExponent: number; profile: 0 | 1 }` (units; `profile` 0 = fillet, 1 = lens).
  - `export interface SlabVertex { ax: number; ay: number; angle: number; ring: number }` — the per-vertex attribute `slab` (vec4: anchor x/y ∈ {−1, 1}, full contour angle in radians, ring index).
  - `export function createSlabBaseGeometry(K = 8, S = 8): InstancedBufferGeometry` with attribute `slab` (vec4) and an index; ring layout: rings `0..K−1` bottom round-over (α = ring/K · π/2), ring `K` wall bottom, ring `K+1` wall top, rings `K+2..2K+1` top round-over (α = (ring−K−1)/K · π/2), ring `2K+2` plateau centre, ring `2K+3` back centre. Each ring has `M = 4(S+1)` vertices in CCW order (corner 0 = +x+y at angles 0..π/2, then +y−x, −x−y, −y+x). Back face = ring 0 fanned to the back centre with reversed winding. `userData.K`, `userData.S`, `userData.M`.
  - `export function evalSlabVertex(v: SlabVertex, p: SlabInstanceParams, K: number): { position: [number, number, number]; normal: [number, number, number] }` — the CPU reference of the TSL vertex shader (Task 8).
  - `export function slabProfile(p: SlabInstanceParams): { fb: number; f: number; wall: number; maxInset: number; bezel: number }` — the clamped profile numbers both evaluators use.

- [ ] **Step 1: Write the failing tests**

`packages/render/test/slab9.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createSlabBaseGeometry, evalSlabVertex, slabProfile, type SlabInstanceParams } from '../src/glass/slab9'
import { createSlabGeometry } from '../../../spikes/glass3d/slab'

const K = 10, S = 10
const button: SlabInstanceParams = { width: 3.11, height: 0.344, radius: 0.172, thickness: 0.0656, fillet: 0.0205, filletBottom: 0.0123, cornerExponent: 2, profile: 0 }
const card: SlabInstanceParams = { width: 2, height: 1, radius: 0.2, thickness: 0.1, fillet: 0.03, filletBottom: 0.0, cornerExponent: 4.5, profile: 0 }

function attrs(K: number, S: number) {
  const g = createSlabBaseGeometry(K, S)
  const a = g.getAttribute('slab')
  const out = []
  for (let i = 0; i < a.count; i++) out.push({ ax: a.getX(i), ay: a.getY(i), angle: a.getZ(i), ring: a.getW(i) })
  return { g, verts: out }
}

describe('createSlabBaseGeometry', () => {
  it('has 2K+2 rings of 4(S+1) vertices plus two centres, and a closed index', () => {
    const { g, verts } = attrs(K, S)
    const M = 4 * (S + 1)
    expect(verts.length).toBe((2 * K + 2) * M + 2)
    expect(g.userData).toMatchObject({ K, S, M })
    expect(verts[0]).toEqual({ ax: 1, ay: 1, angle: 0, ring: 0 })
    expect(verts[M - 1]!.ring).toBe(0); expect(verts[M]!.ring).toBe(1)
    expect(verts[verts.length - 2]!.ring).toBe(2 * K + 2); expect(verts[verts.length - 1]!.ring).toBe(2 * K + 3)
    const idx = g.getIndex()!
    // every edge is shared by exactly two triangles (closed, consistently wound manifold)
    const edges = new Map<string, number>()
    for (let t = 0; t < idx.count; t += 3) {
      const tri = [idx.getX(t), idx.getX(t + 1), idx.getX(t + 2)]
      for (let e = 0; e < 3; e++) { const a = tri[e]!, b = tri[(e + 1) % 3]!; const key = a < b ? `${a}-${b}` : `${b}-${a}`; edges.set(key, (edges.get(key) ?? 0) + (a < b ? 1 : -1)) }
    }
    for (const [, v] of edges) expect(v).toBe(0)   // opposite directions on the two sides of each edge
  })
})

describe('evalSlabVertex', () => {
  it('reproduces the spike geometry ring by ring (fillet profile)', () => {
    for (const p of [button, card]) {
      const oracle = createSlabGeometry({ width: p.width, height: p.height, radius: p.radius, thickness: p.thickness, fillet: p.fillet, filletBottom: p.filletBottom, cornerExponent: p.cornerExponent, profile: 'fillet', cornerSegments: S, profileSegments: K })
      const pos = oracle.getAttribute('position')
      const { verts } = attrs(K, S)
      const M = 4 * (S + 1)
      const { fb } = slabProfile(p)
      // spike ring order: bottom round-over (K rings, only when fb > 0), wall bottom, wall top, top round-over (K), plateau centre
      const ringsInOracle = (fb > 1e-5 ? K : 0) + 2 + K
      let o = 0
      for (let ring = fb > 1e-5 ? 0 : K; ring <= 2 * K + 1; ring++) {
        for (let i = 0; i < M; i++) {
          const v = verts[ring * M + i]!
          const { position } = evalSlabVertex(v, p, K)
          expect(position[0]).toBeCloseTo(pos.getX(o), 6); expect(position[1]).toBeCloseTo(pos.getY(o), 6); expect(position[2]).toBeCloseTo(pos.getZ(o), 6)
          o++
        }
      }
      expect(o).toBe(ringsInOracle * M)
      const centre = evalSlabVertex(verts[verts.length - 2]!, p, K)
      expect(centre.position).toEqual([0, 0, p.thickness])
    }
  })
  it('normals are unit length and point the right way on each band', () => {
    const { verts } = attrs(K, S)
    const M = 4 * (S + 1)
    const len = (n: number[]) => Math.hypot(n[0]!, n[1]!, n[2]!)
    for (const v of verts) expect(len(evalSlabVertex(v, button, K).normal)).toBeCloseTo(1, 6)
    expect(evalSlabVertex(verts[0]!, button, K).normal[2]).toBeCloseTo(-1, 6)                  // ring 0: back face
    expect(evalSlabVertex(verts[K * M]!, button, K).normal[2]).toBeCloseTo(0, 6)               // wall: horizontal
    expect(evalSlabVertex(verts[K * M]!, button, K).normal[0]).toBeGreaterThan(0.99)           // corner 0, angle 0 → +x
    expect(evalSlabVertex(verts[verts.length - 2]!, button, K).normal).toEqual([0, 0, 1])
    expect(evalSlabVertex(verts[(K + 1) * M + S / 2]!, card, K).normal[0]).toBeGreaterThan(0)  // 45° corner of the squircle: x and y positive
  })
  it('clamps a fillet that exceeds the thickness and a radius that exceeds half the short side', () => {
    const p: SlabInstanceParams = { ...card, fillet: 1, filletBottom: 1, radius: 5 }
    const { fb, f, wall } = slabProfile(p)
    expect(fb).toBeCloseTo(0.05); expect(f).toBeCloseTo(0.05); expect(wall).toBeCloseTo(0)
    const { verts } = attrs(K, S)
    const top = evalSlabVertex(verts[(2 * K + 1) * 4 * (S + 1)]!, p, K).position
    expect(Math.abs(top[0])).toBeLessThanOrEqual(p.width / 2 + 1e-9)
  })
  it('lens profile rises from the rim to the plateau', () => {
    const p: SlabInstanceParams = { ...card, profile: 1 }
    const { verts } = attrs(K, S)
    const M = 4 * (S + 1)
    const rim = evalSlabVertex(verts[0]!, p, K).position, edge = evalSlabVertex(verts[(2 * K + 1) * M]!, p, K).position
    expect(rim[2]).toBeCloseTo(0, 9); expect(edge[2]).toBeCloseTo(p.thickness, 6)
    expect(Math.abs(edge[0])).toBeLessThan(Math.abs(rim[0]))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/render/test/slab9.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `slab9.ts`**

```ts
import { InstancedBufferGeometry, Float32BufferAttribute, Sphere, Vector3 } from 'three'

// One geometry for every glass element in a Surface (spec §5.2): vertices carry only *where on the shape* they are
// (corner anchor, contour angle, profile ring); the instance's size/radius/thickness/fillets place them, both here
// (CPU reference, used by tests) and in the TSL vertex stage (glass/vertex.ts), which must stay identical.

export interface SlabInstanceParams { width: number; height: number; radius: number; thickness: number; fillet: number; filletBottom: number; cornerExponent: number; profile: 0 | 1 }
export interface SlabVertex { ax: number; ay: number; angle: number; ring: number }

/** The clamped profile numbers: bottom round-over, top round-over, straight wall, max inset, lens bezel. */
export function slabProfile(p: SlabInstanceParams): { fb: number; f: number; wall: number; maxInset: number; bezel: number } {
  const maxInset = Math.min(p.width, p.height) / 2 - 1e-4
  const fb = Math.min(p.filletBottom, p.thickness * 0.5, maxInset)
  const f = Math.min(p.fillet, p.thickness - fb, maxInset)
  return { fb, f, wall: p.thickness - f - fb, maxInset, bezel: maxInset * 0.6 }
}

/** Inset and height of ring `ring`, plus the profile normal (radial-outward, z) — mirrors the TSL. */
function profileAt(ring: number, K: number, p: SlabInstanceParams): { inset: number; z: number; nr: number; nz: number } {
  const { fb, f, wall, bezel } = slabProfile(p)
  if (p.profile === 1) {
    const x = Math.pow(ring / (2 * K + 1), 1.6)
    const s = Math.sqrt(Math.max(1 - (1 - x) * (1 - x), 1e-4))
    const nr = p.thickness * (1 - x) / s, nz = bezel
    const l = Math.hypot(nr, nz)
    return { inset: bezel * x, z: p.thickness * s, nr: nr / l, nz: nz / l }
  }
  if (ring < K) { const a = (ring / K) * (Math.PI / 2); return { inset: fb - fb * Math.sin(a), z: fb - fb * Math.cos(a), nr: Math.sin(a), nz: -Math.cos(a) } }
  if (ring === K) return { inset: 0, z: fb, nr: 1, nz: 0 }
  if (ring === K + 1) return { inset: 0, z: fb + wall, nr: 1, nz: 0 }
  const a = ((ring - K - 1) / K) * (Math.PI / 2)
  return { inset: f - f * Math.cos(a), z: fb + wall + f * Math.sin(a), nr: Math.cos(a), nz: Math.sin(a) }
}

export function evalSlabVertex(v: SlabVertex, p: SlabInstanceParams, K: number): { position: [number, number, number]; normal: [number, number, number] } {
  if (v.ring === 2 * K + 2) return { position: [0, 0, p.thickness], normal: [0, 0, 1] }
  if (v.ring === 2 * K + 3) return { position: [0, 0, 0], normal: [0, 0, -1] }
  const { inset, z, nr, nz } = profileAt(v.ring, K, p)
  const n = p.cornerExponent
  const hw = p.width / 2 - inset, hh = p.height / 2 - inset
  const r = Math.max(Math.min(p.radius, Math.min(p.width, p.height) / 2) - inset, 0)
  const cx = Math.max(hw - r, 0), cy = Math.max(hh - r, 0)
  const c = Math.cos(v.angle), s = Math.sin(v.angle)
  const px = v.ax * cx + Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * r
  const py = v.ay * cy + Math.sign(s) * Math.pow(Math.abs(s), 2 / n) * r
  // outward normal of |x|^n + |y|^n = r^n at the parametric point, independent of r
  let ox = Math.sign(c) * Math.pow(Math.abs(c), 2 - 2 / n), oy = Math.sign(s) * Math.pow(Math.abs(s), 2 - 2 / n)
  const ol = Math.hypot(ox, oy) || 1; ox /= ol; oy /= ol
  const nx = ox * nr, ny = oy * nr
  const l = Math.hypot(nx, ny, nz) || 1
  return { position: [px, py, z], normal: [nx / l, ny / l, nz / l] }
}

/** The shared base mesh: attribute `slab` = (anchor.x, anchor.y, angle, ring); see the ring layout in the file comment. */
export function createSlabBaseGeometry(K = 8, S = 8): InstancedBufferGeometry {
  const M = 4 * (S + 1)
  const slab: number[] = []
  const indices: number[] = []
  const corners: [number, number, number][] = [[1, 1, 0], [-1, 1, Math.PI / 2], [-1, -1, Math.PI], [1, -1, Math.PI * 1.5]]
  const pushRing = (ring: number) => {
    for (const [ax, ay, a0] of corners) for (let i = 0; i <= S; i++) slab.push(ax, ay, a0 + (i / S) * (Math.PI / 2), ring)
  }
  const connect = (a: number, b: number) => {
    for (let i = 0; i < M; i++) { const j = (i + 1) % M; indices.push(a + i, a + j, b + j, a + i, b + j, b + i) }
  }
  for (let ring = 0; ring <= 2 * K + 1; ring++) pushRing(ring)
  for (let ring = 0; ring < 2 * K + 1; ring++) connect(ring * M, (ring + 1) * M)
  const centreF = slab.length / 4; slab.push(0, 0, 0, 2 * K + 2)
  const top = (2 * K + 1) * M
  for (let i = 0; i < M; i++) indices.push(centreF, top + i, top + (i + 1) % M)
  const centreB = slab.length / 4; slab.push(0, 0, 0, 2 * K + 3)
  for (let i = 0; i < M; i++) indices.push(centreB, (i + 1) % M, i)
  const g = new InstancedBufferGeometry()
  g.setAttribute('slab', new Float32BufferAttribute(slab, 4))
  g.setIndex(indices)
  g.userData = { K, S, M }
  g.boundingSphere = new Sphere(new Vector3(), 1e6)   // positions come from instances; never frustum-cull by this
  return g
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm vitest run packages/render/test/slab9.test.ts`
Expected: PASS. (The oracle comparison test covers `button` with `fb > 0` and `card` with `fb = 0`, where the spike skips the bottom round-over rings and the test skips rings `0..K−1` accordingly.)

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/glass/slab9.ts packages/render/test/slab9.test.ts
git commit -m "feat(render): 9-slice GlassSlab base geometry with a CPU vertex evaluator matching the spike"
```

---

### Task 8: Instance buffers, instance transforms, and the TSL slab vertex stage

**Files:**
- Create: `packages/render/src/instances.ts`, `packages/render/src/transform.ts`, `packages/render/src/glass/vertex.ts`, `packages/render/src/glass/batch.ts`
- Test: `packages/render/test/instances.test.ts`, `packages/render/test/transform.test.ts`, `packages/render/test/glass-batch.test.ts`

**Interfaces:**
- Consumes: `GlassInstance`, `InstanceTransform`, `ClipRect`, `Mat2D` from core; `surfaceToLocal`, `ptToUnits` (Task 6); `createSlabBaseGeometry`, `SlabInstanceParams` (Task 7); `toLinear` (Task 6).
- Produces:
  - `export class InstanceBuffer { constructor(base: InstancedBufferGeometry, names: readonly string[], capacity = 16); readonly geometry: InstancedBufferGeometry; count: number; begin(n: number): void; set(i: number, name: string, x: number, y: number, z?: number, w?: number): void; commit(): void; get(i: number, name: string): [number, number, number, number]; dispose(): void }` — every named attribute is a vec4 `InstancedBufferAttribute` (`DynamicDrawUsage`); `begin(n)` grows capacity (×2 until it fits, new attributes replace the old ones on the same geometry, old data copied) and sets `count = n`; `commit` flags `needsUpdate` and sets `geometry.instanceCount = count`.
  - `export function instanceMatrix(inst: { rect: Rect } & InstanceTransform, s: SurfaceDims, out?: Matrix4): Matrix4` — slab/quad-local units (centred, y up, z from 0) → Surface-local units: `T(centre') · Rtilt · [[a, −c, 0], [−b, d, 0], [0, 0, sz]]` with `(a,b,c,d)` from `transform`, `sz = √|ad − bc|`, `centre'` = the transformed rect centre in units at `z = elevation/ppu`; `Rtilt = Rx(tilt.x)·Ry(tilt.y)`.
  - `export function writeMatrixRows(buf: InstanceBuffer, i: number, m: Matrix4, names?: [string, string, string]): void` — writes rows 0–2 of `m` to `iMat0..2`.
  - `export function writeClip(buf: InstanceBuffer, i: number, clip: ClipRect | undefined, names?: [string, string, string]): void` — `iClipRect = (x, y, w, h)` in surface pt (`w = −1` when no clip), `iClipInv = (a, b, c, d)` and `iClipT = (tx, ty, radius, 0)` of the *inverse* of `clip.transform`.
  - `export const GLASS_ATTRS = ['iRect', 'iShape', 'iCorner', 'iMat0', 'iMat1', 'iMat2', 'iOptics', 'iTint', 'iGlow', 'iGlow2', 'iTouch', 'iClipRect', 'iClipInv', 'iClipT'] as const` with the packing below.
  - `export class GlassBatch { constructor(K?: number, S?: number); readonly buffer: InstanceBuffer; readonly geometry: InstancedBufferGeometry; update(instances: readonly GlassInstance[], s: SurfaceDims, touch?: Map<Node, { u: number; v: number; press: number }>): void; indexOf(node: Node): number; dispose(): void }` — sorts by `z` ascending, packs every instance.
  - `export function slabVertex(K: number): { position: Node; normal: Node; local: Node }` (`glass/vertex.ts`) — TSL nodes computing the slab-local position/normal from `attribute('slab')` and the instance attributes, and the Surface-local position (`iMat` applied) — assigned to `material.positionNode` / `material.normalNode` (via `transformNormalToView`) by Task 9.

Packing (all units unless noted; colours linear):

| attr | x | y | z | w |
|---|---|---|---|---|
| `iRect` | centre x (local units, unused by the vertex: the matrix carries it) | centre y | width | height |
| `iShape` | radius | thickness | fillet | filletBottom |
| `iCorner` | cornerExponent | profile 0/1 | lift | edgeGlow |
| `iMat0..2` | matrix rows (column-major `Matrix4.elements` read as rows: `e[0] e[4] e[8] e[12]`, …) | | | |
| `iOptics` | ior | dispersion | roughness | scatter |
| `iTint` | tint r | g | b | absorption (tint `null` → 1,1,1) |
| `iGlow` | glow r | g | b | strength (0 when `glow` is null) |
| `iGlow2` | split (−1 = none) | softness 0.04 | opacity | luma index (instance order) when `variant === 'clear' && adaptive`, else −1 |
| `iTouch` | touch u (−0.5..0.5) | touch v | press 0..1 | reflection strength (0.2) |
| `iClipRect` | x (pt) | y | w (−1 = none) | h |
| `iClipInv` | a | b | c | d |
| `iClipT` | tx | ty | radius (pt) | 0 |

- [ ] **Step 1: Write the failing tests**

`packages/render/test/instances.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { InstancedBufferGeometry } from 'three'
import { InstanceBuffer } from '../src/instances'

describe('InstanceBuffer', () => {
  it('packs vec4 attributes and sets instanceCount on commit', () => {
    const b = new InstanceBuffer(new InstancedBufferGeometry(), ['iRect', 'iColor'], 2)
    b.begin(2)
    b.set(0, 'iRect', 1, 2, 3, 4); b.set(1, 'iColor', 0.5, 0.5, 0.5, 1)
    b.commit()
    expect(b.geometry.instanceCount).toBe(2)
    expect(b.get(0, 'iRect')).toEqual([1, 2, 3, 4]); expect(b.get(1, 'iColor')).toEqual([0.5, 0.5, 0.5, 1])
    expect(b.geometry.getAttribute('iRect').count).toBe(2)
  })
  it('grows past its capacity without losing earlier instances', () => {
    const b = new InstanceBuffer(new InstancedBufferGeometry(), ['iRect'], 2)
    b.begin(2); b.set(0, 'iRect', 9, 9, 9, 9); b.set(1, 'iRect', 8, 8, 8, 8); b.commit()
    const before = b.geometry.getAttribute('iRect')
    b.begin(300)
    for (let i = 2; i < 300; i++) b.set(i, 'iRect', i, 0, 0, 0)
    b.commit()
    expect(b.geometry.getAttribute('iRect')).not.toBe(before)
    expect(b.geometry.getAttribute('iRect').count).toBeGreaterThanOrEqual(300)
    expect(b.get(0, 'iRect')).toEqual([9, 9, 9, 9]); expect(b.get(1, 'iRect')).toEqual([8, 8, 8, 8]); expect(b.get(299, 'iRect')[0]).toBe(299)
    expect(b.geometry.instanceCount).toBe(300)
  })
  it('rejects unknown attribute names', () => {
    const b = new InstanceBuffer(new InstancedBufferGeometry(), ['iRect'])
    b.begin(1)
    expect(() => b.set(0, 'iNope', 0, 0)).toThrow(/iNope/)
  })
})
```

`packages/render/test/transform.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Vector3 } from 'three'
import { IDENTITY, scaleAbout, multiply } from '@glassui/core'
import { instanceMatrix } from '../src/transform'

const s = { width: 400, height: 300, ptPerUnit: 100 }
const base = { elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1 }
const rect = { x: 10, y: 10, width: 100, height: 40 }
const map = (m: ReturnType<typeof instanceMatrix>, x: number, y: number, z: number) => new Vector3(x, y, z).applyMatrix4(m).toArray().map(v => +v.toFixed(9))

describe('instanceMatrix', () => {
  it('places the local origin at the rect centre in surface-local units (y up)', () => {
    const m = instanceMatrix({ rect, ...base }, s)
    expect(map(m, 0, 0, 0)).toEqual([-1.4, 1.2, 0])       // centre (60,30)pt → ((60−200)/100, (150−30)/100)
    expect(map(m, 1, 0, 0)).toEqual([-0.4, 1.2, 0])
    expect(map(m, 0, 1, 0)).toEqual([-1.4, 2.2, 0])
  })
  it('elevation lifts along +z in units', () => {
    expect(map(instanceMatrix({ rect, ...base, elevation: 50 }, s), 0, 0, 0.1)).toEqual([-1.4, 1.2, 0.6])
  })
  it('a composed scale about the node centre scales x, y and thickness', () => {
    const t = scaleAbout(60, 30, 0.5)
    const m = instanceMatrix({ rect, ...base, scale: 0.5, transform: t }, s)
    expect(map(m, 0, 0, 0)).toEqual([-1.4, 1.2, 0])
    expect(map(m, 1, 0, 0)).toEqual([-0.9, 1.2, 0])
    expect(map(m, 0, 0, 1)).toEqual([-1.4, 1.2, 0.5])
  })
  it('a parent scale about another pivot moves the centre', () => {
    const t = multiply(scaleAbout(0, 0, 0.5), IDENTITY)
    const m = instanceMatrix({ rect, ...base, scale: 0.5, transform: t }, s)
    // centre (60,30) → (30,15)pt → ((30−200)/100, (150−15)/100)
    expect(map(m, 0, 0, 0)).toEqual([-1.7, 1.35, 0])
  })
  it('tilt rotates about the transformed centre', () => {
    const m = instanceMatrix({ rect, ...base, tilt: { x: Math.PI / 2, y: 0 } }, s)
    expect(map(m, 0, 0, 0)).toEqual([-1.4, 1.2, 0])
    const p = map(m, 0, 1, 0)                             // +y rotates toward +z about x
    expect(p[0]).toBeCloseTo(-1.4, 6); expect(p[1]).toBeCloseTo(1.2, 6); expect(p[2]).toBeCloseTo(1, 6)
  })
})
```

`packages/render/test/glass-batch.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { Node, IDENTITY, scaleAbout, type GlassInstance, type ResolvedGlass } from '@glassui/core'
import { GlassBatch, GLASS_ATTRS } from '../src/glass/batch'
import { srgbToLinear } from '../src/color'

const s = { width: 400, height: 300, ptPerUnit: 100 }
const params: ResolvedGlass = { thickness: 8, fillet: 2.4, filletBottom: 1.6, profile: 'fillet', scatter: 0.05, lift: 0.1, edgeGlow: 0.8, ior: 1.5, dispersion: 0.8, roughness: 0.06, tint: null, absorption: 0, glow: { color: [0.42, 0.39, 0.96, 1], strength: 1.1, split: 0.6 }, cornerExponent: 2, envIntensity: 1, specularIntensity: 1, innerGlow: 0, adaptive: true, variant: 'regular' }
function inst(id: string, z: number, extra: Partial<GlassInstance> = {}): GlassInstance {
  return { node: new Node('glass', id), rect: { x: 10, y: 10, width: 100, height: 40 }, radius: 20, z, params, elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1, ...extra }
}

describe('GlassBatch', () => {
  it('packs instances sorted by z with units, linear colours and matrices', () => {
    const b = new GlassBatch()
    b.update([inst('b', 2), inst('a', 1)], s)
    expect(b.buffer.count).toBe(2)
    expect(b.nodes[0]!.id).toBe('a'); expect(b.indexOf(b.nodes[1]!)).toBe(1)
    expect(b.buffer.get(0, 'iRect')).toEqual([-1.4, 1.2, 1, 0.4])
    expect(b.buffer.get(0, 'iShape')).toEqual([0.2, 0.08, 0.024, 0.016])
    expect(b.buffer.get(0, 'iCorner').slice(0, 2)).toEqual([2, 0])
    expect(b.buffer.get(0, 'iGlow')).toEqual([srgbToLinear(0.42), srgbToLinear(0.39), srgbToLinear(0.96), 1.1])
    expect(b.buffer.get(0, 'iGlow2')).toEqual([0.6, 0.04, 1, -1])          // regular variant: no adaptive darkening (luma index −1)
    expect(b.buffer.get(0, 'iTint')).toEqual([1, 1, 1, 0])
    expect(b.buffer.get(0, 'iMat0')).toEqual([1, 0, 0, -1.4]); expect(b.buffer.get(0, 'iMat1')).toEqual([0, 1, 0, 1.2])
    expect(b.buffer.get(0, 'iClipRect')[2]).toBe(-1)
    expect(b.geometry.instanceCount).toBe(2)
    expect(GLASS_ATTRS).toHaveLength(14)
  })
  it('clear + adaptive glass gets its batch index as luma index', () => {
    const b = new GlassBatch()
    b.update([inst('b', 2), inst('a', 1, { params: { ...params, variant: 'clear', adaptive: true } })], s)
    expect(b.buffer.get(0, 'iGlow2')[3]).toBe(0); expect(b.buffer.get(1, 'iGlow2')[3]).toBe(-1)
  })
  it('writes clip rect and inverse transform', () => {
    const b = new GlassBatch()
    b.update([inst('a', 1, { clip: { x: 0, y: 0, width: 200, height: 100, radius: 12, transform: scaleAbout(100, 50, 0.5) } })], s)
    expect(b.buffer.get(0, 'iClipRect')).toEqual([0, 0, 200, 100])
    expect(b.buffer.get(0, 'iClipInv')).toEqual([2, 0, 0, 2])          // inverse of scale .5 about (100,50)
    expect(b.buffer.get(0, 'iClipT')).toEqual([-100, -50, 12, 0])
  })
  it('carries touch state and grows with the list', () => {
    const b = new GlassBatch()
    const list = Array.from({ length: 40 }, (_, i) => inst(`g${i}`, i))
    const touch = new Map([[list[3]!.node, { u: 0.1, v: -0.2, press: 0.5 }]])
    b.update(list, s, touch)
    expect(b.buffer.count).toBe(40)
    expect(b.buffer.get(3, 'iTouch')).toEqual([0.1, -0.2, 0.5, 0.2])
    expect(b.buffer.get(4, 'iTouch')).toEqual([0, 0, 0, 0.2])
  })
})
```

(`b['nodes']` reads the private sorted node list; alternatively expose `nodes: readonly Node[]` — do that and use `b.nodes[0]`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/render/test/instances.test.ts packages/render/test/transform.test.ts packages/render/test/glass-batch.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `instances.ts`**

```ts
import { DynamicDrawUsage, InstancedBufferAttribute, InstancedBufferGeometry } from 'three'

/** Growable per-instance vec4 attributes on one `InstancedBufferGeometry`; `begin(n)` then `set` then `commit`. */
export class InstanceBuffer {
  readonly geometry: InstancedBufferGeometry
  count = 0
  private capacity: number
  private attrs = new Map<string, InstancedBufferAttribute>()

  constructor(base: InstancedBufferGeometry, private readonly names: readonly string[], capacity = 16) {
    this.geometry = base
    this.capacity = Math.max(1, capacity)
    for (const n of names) this.create(n, this.capacity)
  }

  private create(name: string, capacity: number, copyFrom?: InstancedBufferAttribute): void {
    const a = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4)
    a.setUsage(DynamicDrawUsage)
    if (copyFrom) (a.array as Float32Array).set(copyFrom.array as Float32Array)
    this.attrs.set(name, a)
    this.geometry.setAttribute(name, a)
  }

  /** Starts a new fill of `n` instances, growing storage (×2) when needed; earlier data is kept. */
  begin(n: number): void {
    if (n > this.capacity) {
      let c = this.capacity; while (c < n) c *= 2
      for (const name of this.names) this.create(name, c, this.attrs.get(name))
      this.capacity = c
    }
    this.count = n
  }

  set(i: number, name: string, x: number, y: number, z = 0, w = 0): void {
    const a = this.attrs.get(name)
    if (!a) throw new Error(`[render] unknown instance attribute ${name}; known: ${this.names.join(', ')}`)
    const arr = a.array as Float32Array, o = i * 4
    arr[o] = x; arr[o + 1] = y; arr[o + 2] = z; arr[o + 3] = w
  }

  get(i: number, name: string): [number, number, number, number] {
    const a = this.attrs.get(name)
    if (!a) throw new Error(`[render] unknown instance attribute ${name}`)
    const arr = a.array as Float32Array, o = i * 4
    return [arr[o]!, arr[o + 1]!, arr[o + 2]!, arr[o + 3]!]
  }

  commit(): void {
    for (const a of this.attrs.values()) a.needsUpdate = true
    this.geometry.instanceCount = this.count
  }

  dispose(): void { this.geometry.dispose() }
}
```

- [ ] **Step 4: Implement `transform.ts`**

```ts
import { Matrix4, Euler, Quaternion, Vector3 } from 'three'
import { apply, invert, type ClipRect, type InstanceTransform, type Rect } from '@glassui/core'
import type { InstanceBuffer } from './instances'
import { surfaceToLocal, type SurfaceDims } from './units'

const q = new Quaternion(), e = new Euler(), v = new Vector3(), tmp = new Matrix4()

/**
 * Local (centred, y up, z from the surface) → Surface-local units. The 2D affine from core is applied in surface pt,
 * then re-expressed in units (y flipped); its √|det| scales thickness; tilt rotates about the transformed centre.
 */
export function instanceMatrix(inst: { rect: Rect } & InstanceTransform, s: SurfaceDims, out = new Matrix4()): Matrix4 {
  const { a, b, c, d } = inst.transform
  const [cx, cy] = apply(inst.transform, inst.rect.x + inst.rect.width / 2, inst.rect.y + inst.rect.height / 2)
  const [ux, uy] = surfaceToLocal(cx, cy, s)
  const sz = Math.sqrt(Math.abs(a * d - b * c))
  // linear part in units: E·A·D with E = diag(1/ppu, −1/ppu), D = diag(ppu, −ppu)
  out.set(
    a, -c, 0, 0,
    -b, d, 0, 0,
    0, 0, sz, 0,
    0, 0, 0, 1,
  )
  if (inst.tilt.x !== 0 || inst.tilt.y !== 0) {
    q.setFromEuler(e.set(inst.tilt.x, inst.tilt.y, 0, 'XYZ'))
    tmp.makeRotationFromQuaternion(q)
    out.premultiply(tmp)
  }
  v.set(ux, uy, inst.elevation / s.ptPerUnit)
  out.setPosition(v)
  return out
}

/** Rows 0–2 of `m` into three vec4 attributes (row-major, so the shader does `dot(row, vec4(p, 1))`). */
export function writeMatrixRows(buf: InstanceBuffer, i: number, m: Matrix4, names: [string, string, string] = ['iMat0', 'iMat1', 'iMat2']): void {
  const el = m.elements
  buf.set(i, names[0], el[0]!, el[4]!, el[8]!, el[12]!)
  buf.set(i, names[1], el[1]!, el[5]!, el[9]!, el[13]!)
  buf.set(i, names[2], el[2]!, el[6]!, el[10]!, el[14]!)
}

/** Clip rect (surface pt, `w = −1` for none) and the inverse of its transform, for the fragment-side rounded-rect test. */
export function writeClip(buf: InstanceBuffer, i: number, clip: ClipRect | undefined, names: [string, string, string] = ['iClipRect', 'iClipInv', 'iClipT']): void {
  if (!clip) { buf.set(i, names[0], 0, 0, -1, 0); buf.set(i, names[1], 1, 0, 0, 1); buf.set(i, names[2], 0, 0, 0, 0); return }
  const inv = invert(clip.transform)
  buf.set(i, names[0], clip.x, clip.y, clip.width, clip.height)
  buf.set(i, names[1], inv.a, inv.b, inv.c, inv.d)
  buf.set(i, names[2], inv.tx, inv.ty, clip.radius, 0)
}
```

- [ ] **Step 5: Implement `glass/batch.ts`**

```ts
import { Matrix4 } from 'three'
import type { GlassInstance, Node } from '@glassui/core'
import { InstanceBuffer } from '../instances'
import { instanceMatrix, writeClip, writeMatrixRows } from '../transform'
import { createSlabBaseGeometry } from './slab9'
import { surfaceToLocal, type SurfaceDims } from '../units'
import { srgbToLinear } from '../color'

export const GLASS_ATTRS = ['iRect', 'iShape', 'iCorner', 'iMat0', 'iMat1', 'iMat2', 'iOptics', 'iTint', 'iGlow', 'iGlow2', 'iTouch', 'iClipRect', 'iClipInv', 'iClipT'] as const
export const GLOW_SOFTNESS = 0.04
export const REFLECTION_STRENGTH = 0.2

export interface TouchState { u: number; v: number; press: number }

/** All glass elements of one Surface as instances of the shared slab geometry, sorted far→near by `z`. */
export class GlassBatch {
  readonly geometry = createSlabBaseGeometry()
  readonly buffer: InstanceBuffer
  nodes: Node[] = []
  private m = new Matrix4()
  constructor(K?: number, S?: number) {
    if (K !== undefined || S !== undefined) (this as { geometry: ReturnType<typeof createSlabBaseGeometry> }).geometry = createSlabBaseGeometry(K, S)
    this.buffer = new InstanceBuffer(this.geometry, GLASS_ATTRS)
  }
  get K(): number { return this.geometry.userData.K as number }

  update(instances: readonly GlassInstance[], s: SurfaceDims, touch?: Map<Node, TouchState>): void {
    const sorted = [...instances].sort((a, b) => a.z - b.z)
    this.nodes = sorted.map(i => i.node)
    const b = this.buffer
    b.begin(sorted.length)
    const ppu = s.ptPerUnit
    sorted.forEach((inst, i) => {
      const p = inst.params
      const [cx, cy] = surfaceToLocal(inst.rect.x + inst.rect.width / 2, inst.rect.y + inst.rect.height / 2, s)
      b.set(i, 'iRect', cx, cy, inst.rect.width / ppu, inst.rect.height / ppu)
      b.set(i, 'iShape', inst.radius / ppu, p.thickness / ppu, p.fillet / ppu, p.filletBottom / ppu)
      b.set(i, 'iCorner', p.cornerExponent, p.profile === 'lens' ? 1 : 0, p.lift, p.edgeGlow)
      writeMatrixRows(b, i, instanceMatrix(inst, s, this.m))
      b.set(i, 'iOptics', p.ior, p.dispersion, p.roughness, p.scatter)
      if (p.tint) b.set(i, 'iTint', srgbToLinear(p.tint[0]), srgbToLinear(p.tint[1]), srgbToLinear(p.tint[2]), p.absorption)
      else b.set(i, 'iTint', 1, 1, 1, p.absorption)
      if (p.glow) b.set(i, 'iGlow', srgbToLinear(p.glow.color[0]), srgbToLinear(p.glow.color[1]), srgbToLinear(p.glow.color[2]), p.glow.strength)
      else b.set(i, 'iGlow', 0, 0, 0, 0)
      b.set(i, 'iGlow2', p.glow?.split ?? -1, GLOW_SOFTNESS, inst.opacity, p.variant === 'clear' && p.adaptive ? i : -1)
      const t = touch?.get(inst.node)
      b.set(i, 'iTouch', t?.u ?? 0, t?.v ?? 0, t?.press ?? 0, REFLECTION_STRENGTH)
      writeClip(b, i, inst.clip)
    })
    b.commit()
  }

  indexOf(node: Node): number { return this.nodes.indexOf(node) }
  dispose(): void { this.buffer.dispose() }
}
```

- [ ] **Step 6: Implement `glass/vertex.ts` (TSL mirror of `evalSlabVertex`)**

```ts
import {
  Fn, attribute, instancedBufferAttribute, float, vec2, vec3, vec4, abs, sign, pow, sin, cos, sqrt, max, min, normalize, select, If, dot,
} from 'three/tsl'
import type { InstancedBufferGeometry } from 'three'

/**
 * Slab-local position/normal for the current vertex from `slab` (anchor.x, anchor.y, angle, ring) and the instance
 * attributes (see GLASS_ATTRS); `local` is the position after the instance matrix (Surface-local units). Must stay
 * numerically identical to `evalSlabVertex` in slab9.ts — the tests there are the contract.
 */
export function slabVertex(geometry: InstancedBufferGeometry, K: number) {
  const slab = attribute('slab', 'vec4')
  const iRect = instancedBufferAttribute(geometry.getAttribute('iRect') as never, 'vec4')
  const iShape = instancedBufferAttribute(geometry.getAttribute('iShape') as never, 'vec4')
  const iCorner = instancedBufferAttribute(geometry.getAttribute('iCorner') as never, 'vec4')
  const iMat0 = instancedBufferAttribute(geometry.getAttribute('iMat0') as never, 'vec4')
  const iMat1 = instancedBufferAttribute(geometry.getAttribute('iMat1') as never, 'vec4')
  const iMat2 = instancedBufferAttribute(geometry.getAttribute('iMat2') as never, 'vec4')

  const evaluate = Fn(() => {
    const ax = slab.x, ay = slab.y, angle = slab.z, ring = slab.w
    const width = iRect.z, height = iRect.w
    const radius = iShape.x, thickness = iShape.y
    const n = iCorner.x, profile = iCorner.y
    const maxInset = min(width, height).mul(0.5).sub(1e-4)
    const fb = min(iShape.w, thickness.mul(0.5), maxInset)
    const f = min(iShape.z, thickness.sub(fb), maxInset)
    const wall = thickness.sub(f).sub(fb)
    const bezel = maxInset.mul(0.6)
    const Kf = float(K)
    const HALF_PI = Math.PI / 2

    // profile: inset, z, normal (radial-outward r, z)
    const inset = float(0).toVar(), z = float(0).toVar(), nr = float(1).toVar(), nz = float(0).toVar()
    If(profile.greaterThan(0.5), () => {                                   // lens
      const x = pow(ring.div(Kf.mul(2).add(1)), 1.6)
      const s = sqrt(max(float(1).sub(float(1).sub(x).mul(float(1).sub(x))), 1e-4))
      inset.assign(bezel.mul(x)); z.assign(thickness.mul(s))
      const pr = thickness.mul(float(1).sub(x)).div(s), pz = bezel
      const l = sqrt(pr.mul(pr).add(pz.mul(pz)))
      nr.assign(pr.div(l)); nz.assign(pz.div(l))
    }).ElseIf(ring.lessThan(Kf.sub(0.5)), () => {                           // bottom round-over
      const a = ring.div(Kf).mul(HALF_PI)
      inset.assign(fb.sub(fb.mul(sin(a)))); z.assign(fb.sub(fb.mul(cos(a)))); nr.assign(sin(a)); nz.assign(cos(a).negate())
    }).ElseIf(ring.lessThan(Kf.add(0.5)), () => {                           // wall bottom
      inset.assign(0); z.assign(fb); nr.assign(1); nz.assign(0)
    }).ElseIf(ring.lessThan(Kf.add(1.5)), () => {                           // wall top
      inset.assign(0); z.assign(fb.add(wall)); nr.assign(1); nz.assign(0)
    }).Else(() => {                                                          // top round-over
      const a = ring.sub(Kf).sub(1).div(Kf).mul(HALF_PI)
      inset.assign(f.sub(f.mul(cos(a)))); z.assign(fb.add(wall).add(f.mul(sin(a)))); nr.assign(cos(a)); nz.assign(sin(a))
    })

    const hw = width.mul(0.5).sub(inset), hh = height.mul(0.5).sub(inset)
    const r = max(min(radius, min(width, height).mul(0.5)).sub(inset), 0)
    const cx = max(hw.sub(r), 0), cy = max(hh.sub(r), 0)
    const c = cos(angle), s = sin(angle)
    const e = float(2).div(n)
    const px = ax.mul(cx).add(sign(c).mul(pow(abs(c), e)).mul(r))
    const py = ay.mul(cy).add(sign(s).mul(pow(abs(s), e)).mul(r))
    const e2 = float(2).sub(e)
    const o = normalize(vec2(sign(c).mul(pow(abs(c), e2)), sign(s).mul(pow(abs(s), e2))))
    const pos = vec3(px, py, z).toVar()
    const nrm = normalize(vec3(o.x.mul(nr), o.y.mul(nr), nz)).toVar()
    // centres
    If(ring.greaterThan(Kf.mul(2).add(1.5)), () => {
      const isTop = ring.lessThan(Kf.mul(2).add(2.5))
      pos.assign(vec3(0, 0, select(isTop, thickness, float(0))))
      nrm.assign(vec3(0, 0, select(isTop, float(1), float(-1))))
    })
    return { pos, nrm }
  }

  const { pos, nrm } = evaluate()
  const p4 = vec4(pos, 1)
  const local = vec3(dot(iMat0, p4), dot(iMat1, p4), dot(iMat2, p4))
  const normal = normalize(vec3(dot(iMat0.xyz, nrm), dot(iMat1.xyz, nrm), dot(iMat2.xyz, nrm)))
  return { position: local, normal, local, slabLocal: pos }
}
```

`evaluate` is a plain TypeScript function (not a TSL `Fn`) that builds the node graph imperatively with `.toVar()` and `If/ElseIf/Else`; TSL evaluates it in the vertex stage because the material reads `position`/`normal` from `positionNode`/`normalNode`. `position` is assigned to `material.positionNode` (local space of the Surface mesh), `normal` to `material.normalNode` wrapped in `transformNormalToView(...)` (Task 9); `slabLocal` is the pre-matrix position for planar uvs. If `instancedBufferAttribute` is not exported by `three/tsl` in r186, use `attribute('iRect', 'vec4')` (the builder detects instanced attributes from the geometry); check `node_modules/three/src/nodes/accessors/BufferAttributeNode.js`. If `If` chains cannot run outside a `Fn` in r186, wrap `evaluate` in `Fn(() => …)` returning `vec4(pos, 0)` for the position and a second `Fn` for the normal, sharing the body through a helper that takes the output var as an argument.

- [ ] **Step 7: Add a Node-level sanity test for the vertex graph**

Append to `packages/render/test/glass-batch.test.ts`:

```ts
import { slabVertex } from '../src/glass/vertex'
describe('slabVertex', () => {
  it('builds position/normal/local nodes from a populated batch geometry', () => {
    const b = new GlassBatch()
    b.update([inst('a', 1)], s)
    const v = slabVertex(b.geometry, b.K)
    expect(v.position).toBeTruthy(); expect(v.normal).toBeTruthy(); expect(v.local).toBeTruthy()
  })
})
```

- [ ] **Step 8: Run tests and typecheck**

Run: `pnpm vitest run packages/render && pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/render/src/instances.ts packages/render/src/transform.ts packages/render/src/glass packages/render/test
git commit -m "feat(render): instance buffers, instance transforms, glass batch and TSL slab vertex stage"
```

---

### Task 9: Glass material (TSL) — panel-space refraction, screen backdrop variant, glow, transmitted shadows

**Files:**
- Create: `packages/render/src/glass/material.ts`
- Test: `packages/render/test/glass-material.test.ts`

**Interfaces:**
- Consumes: `slabVertex` (Task 8), `GlassBatch` geometry, instance attributes per the Task 8 table.
- Produces:
  ```ts
  export interface GlassMaterialOptions {
    geometry: InstancedBufferGeometry       // the batch geometry (for the instance attributes)
    K: number
    backdrop: 'panel' | 'screen'            // class 2 (content RT) or class 3 (viewportMipTexture)
    side: 'front' | 'back'
    surface: { size: UniformNode<Vector2>; ptPerUnit: UniformNode<number> }   // units: W,H
    content?: Texture                       // content RT texture (panel) — may be swapped later via `setContent`
    screen?: ReturnType<typeof viewportMipTexture>   // shared per layer (screen)
    luma?: Texture                          // Task 23; default: a 1×1 black DataTexture (= no darkening)
    depthReject?: boolean                   // screen only
  }
  export interface GlassMaterial { material: MeshPhysicalNodeMaterial; setContent(tex: Texture): void; setLuma(tex: Texture, count: number): void; dispose(): void }
  export function createGlassMaterial(o: GlassMaterialOptions): GlassMaterial
  ```
  The content plane is always the mesh's local `z = 0`: the Surface places every glass/foreground mesh at `position.z = contentPlaneZ` (Task 15), so the material never needs to know about it.
  Behaviour (spec §5.3, spike `glass.ts`):
  - `transparent = true`, `depthWrite = false`, `depthTest = true`, `side` per option, `toneMapped = false`, `roughness` (specular) = `iOptics.z` clamped to ≥ 0.06, `metalness 0`, `iorNode = iOptics.x`, `envMapIntensity` 1 (scaled by `envIntensity` via `envNode`? — keep `material.envMapIntensity = 1`; per-instance `envIntensity` is not wired in this task), `specularIntensity 1`, iridescence 0.
  - `backdropNode` (panel): per channel R/G/B with `eta = 1 / (ior · (1 ∓ dispersion·0.03))`: `R = refract(−V, N, eta)`; `t1 = min((local.z − zBack) / max(dot(−R, nb), 0.15), thickness·4)` where `zBack = iMat2.w` (the instance's z translation, i.e. the slab back height above the plane) and `nb` = the mesh's +z in view space; `inside = positionView + R·t1`; `t2 = max(dot(planeOrigin − inside, nb) / min(dot(−V, nb), −0.05), 0)` toward the plane `z = 0`; `exit = inside − V·t2`; `uv = localOf(exit)/size + 0.5` (via the `ex`/`ey` basis of `modelViewMatrix`); sample `texture(content).sample(uv).level(roughness·8)`. Beer–Lambert with `iTint`/absorption over `t1/thickness`; lift `mix(c, 1, roughness·0.08 + lift)`; reflection: mirror the reflected ray below the plane (`down = Rr − 2·max(dot(Rr, nb), 0)·nb`) and sample the content RT at its plane hit, `mix(c, refl, fresnel · iTouch.w)`; clip test → `Discard()`.
  - `backdropNode` (screen): as the spike — `exit = positionView + R·t1`, project with `cameraProjectionMatrix`, `suv = (ndc.x·0.5+0.5, 0.5−ndc.y·0.5)`, sample `screen.sample(suv).level(lod)`; with `depthReject`, if `viewportDepthTexture(suv) < viewportDepth` (something in front of the glass was captured) fall back to `screen.sample(screenUV)`.
  - `backdropAlphaNode = 1 − roughness·scatter`; `colorNode = tint²·0.6`; `opacityNode = iGlow2.z`.
  - `emissiveNode`: press glow `exp(−|uv−touch|²/0.36)·press·(0.45 + 0.25·tint)` + edge glow `fresnel^2.5 · edgeGlow · mix(1, tint, 0.5)` + glow layer `glowColor · (0.55 + 1.2·fresnel) · strength · mask`, `mask = split < 0 ? 1 : smoothstep(split + soft, split − soft, uv.x)` where `uv` is the slab's planar uv `(px/width + 0.5, py/height + 0.5)` (computed in the vertex stage from `pos.xy` and `iRect.zw`, passed as a varying).
  - `castShadowNode = vec4(shadowColor, 1)`: `glow.w > 0 ? mix(vec3(0.78,0.78,0.84), glowColor, 0.6) : (absorption == 0 ? vec3(0.78,0.78,0.84) : exp(−(1−tint)·absorption·0.9)·0.9)`.
  - `luma`: spec §4.1 `variant: 'clear'` darkens 35 % when the backdrop is bright: `backdrop *= mix(1, 0.65, step(0, iGlow2.w) · step(0.6, luma))` where `luma = texture(luma).sample(vec2((iGlow2.w + 0.5)/lumaCount, 0.5)).r`; `lumaCount` is a uniform (default 1) and the default texture is 1×1 black, so nothing darkens until Task 23 wires the real pass through `setLuma`. Instances with `iGlow2.w < 0` (not clear+adaptive) never darken.

- [ ] **Step 1: Write the failing tests**

`packages/render/test/glass-material.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { uniform } from 'three/tsl'
import { Vector2, Texture, BackSide, FrontSide } from 'three'
import { Node, IDENTITY, type GlassInstance, type ResolvedGlass } from '@glassui/core'
import { GlassBatch } from '../src/glass/batch'
import { createGlassMaterial } from '../src/glass/material'

const s = { width: 400, height: 300, ptPerUnit: 100 }
const params: ResolvedGlass = { thickness: 8, fillet: 2.4, filletBottom: 1.6, profile: 'fillet', scatter: 0.05, lift: 0.1, edgeGlow: 0.8, ior: 1.5, dispersion: 0.8, roughness: 0.06, tint: null, absorption: 0, glow: null, cornerExponent: 2, envIntensity: 1, specularIntensity: 1, innerGlow: 0, adaptive: true, variant: 'regular' }
const inst: GlassInstance = { node: new Node('glass'), rect: { x: 10, y: 10, width: 100, height: 40 }, radius: 20, z: 1, params, elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1 }
const surface = { size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(100) }

describe('createGlassMaterial', () => {
  it('builds the panel-backdrop variant with the spec flags', () => {
    const b = new GlassBatch(); b.update([inst], s)
    const g = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface, content: new Texture() })
    const m = g.material
    expect(m.transparent).toBe(true); expect(m.depthWrite).toBe(false); expect(m.depthTest).toBe(true)
    expect(m.side).toBe(FrontSide); expect(m.toneMapped).toBe(false)
    expect(m.backdropNode).toBeTruthy(); expect(m.backdropAlphaNode).toBeTruthy(); expect(m.emissiveNode).toBeTruthy()
    expect(m.positionNode).toBeTruthy(); expect(m.normalNode).toBeTruthy(); expect(m.castShadowNode).toBeTruthy()
    expect(m.opacityNode).toBeTruthy()
  })
  it('back side variant and screen backdrop variant build too', () => {
    const b = new GlassBatch(); b.update([inst], s)
    expect(createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'back', surface, content: new Texture() }).material.side).toBe(BackSide)
    const scr = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'screen', side: 'front', surface, depthReject: true })
    expect(scr.material.backdropNode).toBeTruthy()
  })
  it('setContent swaps the sampled texture without rebuilding the material', () => {
    const b = new GlassBatch(); b.update([inst], s)
    const t1 = new Texture(), t2 = new Texture()
    const g = createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface, content: t1 })
    const before = g.material.backdropNode
    g.setContent(t2)
    expect(g.material.backdropNode).toBe(before)
    g.setLuma(new Texture(), 8)
    expect(g.material.backdropNode).toBe(before)
  })
  it('requires content for the panel variant', () => {
    const b = new GlassBatch(); b.update([inst], s)
    expect(() => createGlassMaterial({ geometry: b.geometry, K: b.K, backdrop: 'panel', side: 'front', surface })).toThrow(/content/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/render/test/glass-material.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `glass/material.ts`**

```ts
import { BackSide, DataTexture, FrontSide, RGBAFormat, Texture, UnsignedByteType, Vector2, type InstancedBufferGeometry } from 'three'
import { MeshPhysicalNodeMaterial } from 'three/webgpu'
import {
  Fn, If, Discard, float, vec2, vec3, vec4, uniform, texture, instancedBufferAttribute, varying, positionView, positionViewDirection, normalView,
  transformNormalToView, modelViewMatrix, cameraProjectionMatrix, viewportMipTexture, viewportDepthTexture, viewportDepth, screenUV,
  refract, reflect, normalize, dot, max, min, abs, exp, mix, clamp, pow, smoothstep, step, select, length, type ShaderNodeObject,
} from 'three/tsl'
import type { UniformNode } from 'three/webgpu'
import { slabVertex } from './vertex'

export interface GlassMaterialOptions {
  geometry: InstancedBufferGeometry; K: number
  backdrop: 'panel' | 'screen'; side: 'front' | 'back'
  surface: { size: UniformNode<Vector2>; ptPerUnit: UniformNode<number> }
  content?: Texture | undefined
  screen?: ReturnType<typeof viewportMipTexture> | undefined
  luma?: Texture | undefined
  depthReject?: boolean | undefined
}
export interface GlassMaterial { material: MeshPhysicalNodeMaterial; setContent(tex: Texture): void; setLuma(tex: Texture, count: number): void; dispose(): void }

const NEUTRAL_SHADOW = [0.78, 0.78, 0.84] as const

/** 1×1 black: "backdrop is dark" → no adaptive darkening until a real luma pass is attached. */
function blackTexture(): DataTexture {
  const t = new DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, RGBAFormat, UnsignedByteType); t.needsUpdate = true; return t
}

/** Rounded-rect clip in surface pt: `pt` is the fragment's surface-pt position; returns true when it is outside. */
function outsideClip(pt: ShaderNodeObject<any>, clipRect: ShaderNodeObject<any>, clipInv: ShaderNodeObject<any>, clipT: ShaderNodeObject<any>) {
  const lx = clipInv.x.mul(pt.x).add(clipInv.z.mul(pt.y)).add(clipT.x)
  const ly = clipInv.y.mul(pt.x).add(clipInv.w.mul(pt.y)).add(clipT.y)
  const half = clipRect.zw.mul(0.5), centre = clipRect.xy.add(half), r = min(clipT.z, min(half.x, half.y))
  const q = abs(vec2(lx, ly).sub(centre)).sub(half.sub(r))
  const d = length(max(q, 0)).add(min(max(q.x, q.y), 0)).sub(r)
  return clipRect.z.greaterThan(0).and(d.greaterThan(0))
}

export function createGlassMaterial(o: GlassMaterialOptions): GlassMaterial {
  if (o.backdrop === 'panel' && !o.content) throw new Error('[render] createGlassMaterial: backdrop "panel" needs a content texture')
  const g = o.geometry
  const A = (name: string) => instancedBufferAttribute(g.getAttribute(name) as never, 'vec4')
  const iRect = A('iRect'), iShape = A('iShape'), iCorner = A('iCorner'), iOptics = A('iOptics'), iTint = A('iTint'), iGlow = A('iGlow'), iGlow2 = A('iGlow2'), iTouch = A('iTouch')
  const iClipRect = A('iClipRect'), iClipInv = A('iClipInv'), iClipT = A('iClipT'), iMat2 = A('iMat2')
  const v = slabVertex(g, o.K)
  const contentTex = texture(o.content ?? new Texture())
  const lumaTex = texture(o.luma ?? blackTexture())
  const lumaCount = uniform(1)
  const screen = o.screen ?? (o.backdrop === 'screen' ? viewportMipTexture() : undefined)

  const m = new MeshPhysicalNodeMaterial()
  m.transparent = true; m.depthWrite = false; m.depthTest = true
  m.side = o.side === 'back' ? BackSide : FrontSide
  m.toneMapped = false
  m.metalness = 0; m.envMapIntensity = 1; m.specularIntensity = 1; m.iridescence = 0
  m.roughnessNode = max(iOptics.z, 0.06)
  m.iorNode = iOptics.x
  m.positionNode = v.position
  m.normalNode = transformNormalToView(v.normal)

  // varyings from the vertex stage
  const local = varying(v.local)                                   // Surface-local units
  const slabUV = varying(slabPlanarUV(v, iRect))
  const surfacePt = vec2(local.x.mul(o.surface.ptPerUnit).add(o.surface.size.x.mul(o.surface.ptPerUnit).mul(0.5)),
                         o.surface.size.y.mul(o.surface.ptPerUnit).mul(0.5).sub(local.y.mul(o.surface.ptPerUnit)))

  const thickness = iShape.y, roughness = iOptics.z, scatter = iOptics.w, ior = iOptics.x, dispersion = iOptics.y
  const tint = iTint.xyz, absorption = iTint.w, lift = iCorner.z, edgeGlow = iCorner.w
  const lod = roughness.mul(8)
  const NdotV = clamp(dot(normalView, positionViewDirection), 0, 1)
  const fresnel = pow(float(1).sub(NdotV), 2.5)

  // Surface basis in view space (the content plane is the mesh's local z = 0)
  const origin = modelViewMatrix.mul(vec4(0, 0, 0, 1)).xyz
  const ex = modelViewMatrix.mul(vec4(1, 0, 0, 0)).xyz, ey = modelViewMatrix.mul(vec4(0, 1, 0, 0)).xyz
  const nb = normalize(modelViewMatrix.mul(vec4(0, 0, 1, 0)).xyz)
  const localOf = (P: ShaderNodeObject<any>) => { const d = P.sub(origin); return vec2(dot(d, ex).div(dot(ex, ex)), dot(d, ey).div(dot(ey, ey))) }
  const planeUV = (P: ShaderNodeObject<any>) => localOf(P).div(o.surface.size).add(0.5)

  const V = positionViewDirection, N = normalView
  const zBack = iMat2.w
  const refractChannel = (iorScale: ShaderNodeObject<any>) => {
    const eta = float(1).div(ior.mul(iorScale))
    const R = refract(V.negate(), N, eta)
    const cosb = max(dot(R.negate(), nb), 0.15)
    const depth = max(local.z.sub(zBack), 0)      // height of this fragment above the slab back
    const t1 = min(depth.div(cosb), thickness.mul(4))
    const inside = positionView.add(R.mul(t1))
    return { R, t1, inside }
  }

  m.backdropNode = Fn(() => {
    If(outsideClip(surfacePt, iClipRect, iClipInv, iClipT), () => { Discard() })
    const k = dispersion.mul(0.03)
    const samples = [float(1).sub(k), float(1), float(1).add(k)].map(scale => {
      const { R, t1, inside } = refractChannel(scale)
      if (o.backdrop === 'panel') {
        const denom = min(dot(V.negate(), nb), -0.05)
        const t2 = max(dot(origin.sub(inside), nb).div(denom), 0)
        const exit = inside.sub(V.mul(t2))
        return { c: contentTex.sample(planeUV(exit)).level(lod).rgb, t: t1 }
      }
      const clip = cameraProjectionMatrix.mul(vec4(inside, 1))
      const ndc = clip.xy.div(clip.w)
      const suv = vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)))
      let c = screen!.sample(suv).level(lod).rgb
      if (o.depthReject) {
        const captured = viewportDepthTexture(suv).r
        c = select(captured.lessThan(viewportDepth), screen!.sample(screenUV).level(lod).rgb, c)
      }
      return { c, t: t1 }
    })
    let c = vec3(samples[0]!.c.r, samples[1]!.c.g, samples[2]!.c.b)
    const sigma = float(1).sub(tint).mul(absorption)
    c = c.mul(exp(sigma.mul(samples[1]!.t.div(thickness)).negate()))
    c = mix(c, vec3(1), roughness.mul(0.08).add(lift))
    if (o.backdrop === 'panel') {
      // panel reflection (spec §5.4): mirror the reflected ray below the plane, sample where it meets the content
      const Rr = reflect(V.negate(), N)
      const down = Rr.sub(nb.mul(max(dot(Rr, nb), 0).mul(2)))   // mirror across the plane so the ray heads into the panel
      const denom = min(dot(down, nb), -0.05)
      const t3 = max(dot(origin.sub(positionView), nb).div(denom), 0)
      const hit = positionView.add(down.mul(t3))
      c = mix(c, contentTex.sample(planeUV(hit)).level(lod.add(2)).rgb, fresnel.mul(iTouch.w))
    }
    // adaptive darkening (spec §4.1 clear variant); Task 23 attaches the real luma pass, the default is black = off
    const luma = lumaTex.sample(vec2(iGlow2.w.add(0.5).div(lumaCount), 0.5)).r
    c = c.mul(mix(float(1), float(0.65), step(float(0), iGlow2.w).mul(step(0.6, luma))))
    return c
  })()
  m.backdropAlphaNode = float(1).sub(roughness.mul(scatter))
  m.colorNode = tint.mul(tint).mul(0.6)
  m.opacityNode = iGlow2.z

  m.emissiveNode = Fn(() => {
    const p = slabUV.sub(0.5)
    const d = p.sub(iTouch.xy)
    const press = exp(dot(d, d).negate().div(0.36)).mul(iTouch.z)
    const rim = fresnel.mul(edgeGlow)
    let e = vec3(press.mul(0.45)).add(tint.mul(press.mul(0.25))).add(mix(vec3(1), tint, 0.5).mul(rim))
    const split = iGlow2.x, soft = iGlow2.y
    // lit left of the split (edge0 < edge1 always: GLSL leaves a reversed smoothstep undefined)
    const mask = select(split.lessThan(0), float(1), float(1).sub(smoothstep(split.sub(soft), split.add(soft), slabUV.x)))
    const body = float(0.55).add(fresnel.mul(1.2))
    e = e.add(iGlow.xyz.mul(body).mul(iGlow.w).mul(mask))
    return e
  })()

  // coloured transmitted shadow (spec §5.4)
  m.castShadowNode = Fn(() => {
    const neutral = vec3(...NEUTRAL_SHADOW)
    const absorbed = exp(float(1).sub(tint).mul(absorption).mul(0.9).negate()).mul(0.9)
    const tinted = select(absorption.lessThan(1e-4), neutral, absorbed)
    const col = select(iGlow.w.greaterThan(0), mix(neutral, iGlow.xyz, 0.6), tinted)
    return vec4(col, 1)
  })()

  return {
    material: m,
    setContent(tex: Texture) { contentTex.value = tex },
    setLuma(tex: Texture, count: number) { lumaTex.value = tex; lumaCount.value = Math.max(1, count) },
    dispose() { m.dispose() },
  }
}

/** Planar uv of the slab (0..1 across the rect) from the slab-local (pre-matrix) position, for glow split and press glow. */
function slabPlanarUV(v: ReturnType<typeof slabVertex>, iRect: ShaderNodeObject<any>) {
  return vec2(v.slabLocal.x.div(iRect.z).add(0.5), v.slabLocal.y.div(iRect.w).add(0.5))
}
```

Type the TSL helpers with `ShaderNodeObject<any>` only where the generic types fight; prefer the inferred types. If `viewportDepthTexture`/`viewportDepth` names differ in r186, look them up in `node_modules/three/src/nodes/display/ViewportDepthTextureNode.js` and `ViewportDepthNode.js`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/render && pnpm typecheck`
Expected: PASS. (Shader compilation is verified at the Task 21 visual checkpoint; this task's gate is that the graph builds and the flags match the spec.)

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/glass packages/render/test/glass-material.test.ts
git commit -m "feat(render): TSL glass material with panel-space refraction, screen backdrop, glow and transmitted shadows"
```

---

### Task 10: Panel SDF and instanced panel material/batch

**Files:**
- Create: `packages/render/src/panel/sdf.ts`, `packages/render/src/panel/material.ts`, `packages/render/src/panel/batch.ts`, `packages/render/src/quad.ts`
- Test: `packages/render/test/panel.test.ts`

**Interfaces:**
- Consumes: `InstanceBuffer`, `instanceMatrix`, `writeMatrixRows`, `writeClip` (Task 8); `PanelInstance` from core; `toLinear`.
- Produces:
  - `export function createQuadGeometry(): InstancedBufferGeometry` (`quad.ts`) — a unit quad, attribute `position` (x, y ∈ [−0.5, 0.5], z 0) and `uv`, two triangles, large bounding sphere.
  - `export function superellipseSDF(x: number, y: number, hw: number, hh: number, r: number, n: number): number` (`sdf.ts`, CPU reference: < 0 inside) and `export const sdfNode = Fn(([p, half, r, n]) => …)` the TSL twin.
  - `export const PANEL_ATTRS = ['iRect', 'iShape', 'iColor', 'iBorder', 'iMat0', 'iMat1', 'iMat2', 'iClipRect', 'iClipInv', 'iClipT'] as const`; packing: `iRect` (cx, cy, w, h units), `iShape` (radius units, border width units, cornerExponent, opacity), `iColor` (linear rgb, a), `iBorder` (linear rgb, a).
  - `export class PanelBatch { readonly geometry; readonly buffer; update(instances: readonly PanelInstance[], s: SurfaceDims): void; dispose() }` (sorted by `z`).
  - `export function createPanelMaterial(geometry: InstancedBufferGeometry, surface: { size; ptPerUnit }): MeshBasicNodeMaterial` — unlit (the Surface's content quad is the lit, shadow-receiving surface, Task 15), `transparent`, `depthWrite false`, `positionNode` = `iMat · (position.xy · iRect.zw, 0)`, fragment: `d = sdf(q, half, radius, n)`, `aa = fwidth(d)·0.75`, `cover = 1 − smoothstep(−aa, aa, d)`, `borderMix = smoothstep(−aa, aa, d + borderWidth)` (when border width > 0), colour `mix(fill, border, borderMix)`, `opacityNode = cover · colour.a · opacity`, clip test → `Discard()`.

- [ ] **Step 1: Write the failing tests**

`packages/render/test/panel.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { uniform } from 'three/tsl'
import { Vector2 } from 'three'
import { Node, IDENTITY, type PanelInstance } from '@glassui/core'
import { superellipseSDF } from '../src/panel/sdf'
import { PanelBatch, PANEL_ATTRS } from '../src/panel/batch'
import { createPanelMaterial } from '../src/panel/material'
import { createQuadGeometry } from '../src/quad'
import { srgbToLinear } from '../src/color'

describe('superellipseSDF', () => {
  it('is negative inside, zero on the straight edge, positive outside', () => {
    expect(superellipseSDF(0, 0, 50, 20, 10, 4.5)).toBeLessThan(0)
    expect(superellipseSDF(50, 0, 50, 20, 10, 4.5)).toBeCloseTo(0, 9)
    expect(superellipseSDF(60, 0, 50, 20, 10, 4.5)).toBeCloseTo(10, 9)
  })
  it('a circle corner (n=2) rounds the corner, a squircle (n=4.5) keeps more of it', () => {
    // the corner point (50,20) is outside both; (44,14) is inside the squircle but outside the circle corner of radius 10
    expect(superellipseSDF(50, 20, 50, 20, 10, 2)).toBeGreaterThan(0)
    // (47.5, 17.5): 10.6 from the corner centre → outside the circle; its L4.5 distance is 8.75 → inside the squircle
    expect(superellipseSDF(47.5, 17.5, 50, 20, 10, 2)).toBeGreaterThan(0)
    expect(superellipseSDF(47.5, 17.5, 50, 20, 10, 4.5)).toBeLessThan(0)
  })
  it('radius 0 is a plain box', () => { expect(superellipseSDF(50, 20, 50, 20, 0, 4.5)).toBeCloseTo(0, 9) })
})

describe('PanelBatch and material', () => {
  const s = { width: 400, height: 300, ptPerUnit: 100 }
  const p: PanelInstance = { node: new Node('box'), rect: { x: 10, y: 10, width: 100, height: 40 }, radius: 12, color: [1, 0.5, 0, 0.8], border: { width: 2, color: [0, 0, 0, 1] }, z: 1, elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 0.5 }
  it('packs rect, shape, colours and border', () => {
    const b = new PanelBatch()
    b.update([p], s)
    expect(b.buffer.get(0, 'iRect')).toEqual([-1.4, 1.2, 1, 0.4])
    expect(b.buffer.get(0, 'iShape')).toEqual([0.12, 0.02, 4.5, 0.5])
    expect(b.buffer.get(0, 'iColor')).toEqual([1, srgbToLinear(0.5), 0, 0.8])
    expect(b.buffer.get(0, 'iBorder')).toEqual([0, 0, 0, 1])
    expect(PANEL_ATTRS).toHaveLength(10)
  })
  it('capsule radius means n = 2, otherwise 4.5', () => {
    const b = new PanelBatch()
    b.update([{ ...p, radius: 20 }], s)   // radius == half the short side → capsule
    expect(b.buffer.get(0, 'iShape')[2]).toBe(2)
  })
  it('material builds with the quad geometry', () => {
    const b = new PanelBatch(); b.update([p], s)
    const m = createPanelMaterial(b.geometry, { size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(100) })
    expect(m.transparent).toBe(true); expect(m.depthWrite).toBe(false); expect(m.positionNode).toBeTruthy(); expect(m.opacityNode).toBeTruthy()
    expect(createQuadGeometry().getAttribute('position').count).toBe(4)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/render/test/panel.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/render/src/quad.ts`:

```ts
import { InstancedBufferGeometry, Float32BufferAttribute, Sphere, Vector3 } from 'three'

/** A unit quad (x, y ∈ [−0.5, 0.5]) every instanced flat element scales by its own size in the vertex stage. */
export function createQuadGeometry(): InstancedBufferGeometry {
  const g = new InstancedBufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3))
  g.setAttribute('uv', new Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2))
  g.setIndex([0, 1, 2, 0, 2, 3])
  g.boundingSphere = new Sphere(new Vector3(), 1e6)
  return g
}
```

`packages/render/src/panel/sdf.ts`:

```ts
import { Fn, vec2, float, abs, max, min, pow, length, select } from 'three/tsl'

/** Signed distance to a rounded box with superellipse corners (exponent `n`; 2 = circular): < 0 inside. CPU reference. */
export function superellipseSDF(x: number, y: number, hw: number, hh: number, r: number, n: number): number {
  const rr = Math.max(0, Math.min(r, hw, hh))
  const qx = Math.abs(x) - (hw - rr), qy = Math.abs(y) - (hh - rr)
  const ox = Math.max(qx, 0), oy = Math.max(qy, 0)
  const outside = rr > 0 && n !== 2 ? Math.pow(Math.pow(ox, n) + Math.pow(oy, n), 1 / n) : Math.hypot(ox, oy)
  return outside + Math.min(Math.max(qx, qy), 0) - rr
}

/** TSL twin of `superellipseSDF`: `p` vec2, `half` vec2, `r` float, `n` float. */
export const sdfNode = Fn(([p, half, r, n]: [any, any, any, any]) => {
  const rr = max(min(r, min(half.x, half.y)), 0)
  const q = abs(p).sub(half.sub(rr))
  const o = max(q, 0)
  const ln = pow(pow(o.x, n).add(pow(o.y, n)), float(1).div(n))
  const outside = select(rr.greaterThan(0).and(n.notEqual(2)), ln, length(o))
  return outside.add(min(max(q.x, q.y), 0)).sub(rr)
})
```

`packages/render/src/panel/batch.ts`:

```ts
import { Matrix4 } from 'three'
import type { PanelInstance } from '@glassui/core'
import { InstanceBuffer } from '../instances'
import { instanceMatrix, writeClip, writeMatrixRows } from '../transform'
import { createQuadGeometry } from '../quad'
import { surfaceToLocal, type SurfaceDims } from '../units'
import { srgbToLinear } from '../color'

export const PANEL_ATTRS = ['iRect', 'iShape', 'iColor', 'iBorder', 'iMat0', 'iMat1', 'iMat2', 'iClipRect', 'iClipInv', 'iClipT'] as const

/** `cornerExponent` for a flat shape: a capsule (radius = half the short side) is circular, otherwise Apple-continuous. */
export function cornerExponentFor(rect: { width: number; height: number }, radius: number): number {
  return radius >= Math.min(rect.width, rect.height) / 2 - 1e-6 ? 2 : 4.5
}

export class PanelBatch {
  readonly geometry = createQuadGeometry()
  readonly buffer = new InstanceBuffer(this.geometry, PANEL_ATTRS)
  private m = new Matrix4()

  update(instances: readonly PanelInstance[], s: SurfaceDims): void {
    const sorted = [...instances].sort((a, b) => a.z - b.z)
    const b = this.buffer, ppu = s.ptPerUnit
    b.begin(sorted.length)
    sorted.forEach((p, i) => {
      const [cx, cy] = surfaceToLocal(p.rect.x + p.rect.width / 2, p.rect.y + p.rect.height / 2, s)
      b.set(i, 'iRect', cx, cy, p.rect.width / ppu, p.rect.height / ppu)
      b.set(i, 'iShape', p.radius / ppu, (p.border?.width ?? 0) / ppu, cornerExponentFor(p.rect, p.radius), p.opacity)
      b.set(i, 'iColor', srgbToLinear(p.color[0]), srgbToLinear(p.color[1]), srgbToLinear(p.color[2]), p.color[3])
      const bc = p.border?.color ?? [0, 0, 0, 0]
      b.set(i, 'iBorder', srgbToLinear(bc[0]), srgbToLinear(bc[1]), srgbToLinear(bc[2]), bc[3])
      writeMatrixRows(b, i, instanceMatrix(p, s, this.m))
      writeClip(b, i, p.clip)
    })
    b.commit()
  }
  dispose(): void { this.buffer.dispose() }
}
```

`packages/render/src/panel/material.ts`:

```ts
import type { InstancedBufferGeometry, Vector2 } from 'three'
import { MeshBasicNodeMaterial, type UniformNode } from 'three/webgpu'
import { Fn, If, Discard, attribute, instancedBufferAttribute, varying, vec2, vec3, vec4, float, dot, fwidth, smoothstep, mix, abs, max, min, length, select } from 'three/tsl'
import { sdfNode } from './sdf'

export interface SurfaceUniforms { size: UniformNode<Vector2>; ptPerUnit: UniformNode<number> }

/** Shared by every flat instanced material: position through the instance matrix, surface-pt varying, clip test. */
export function flatVertex(g: InstancedBufferGeometry, su: SurfaceUniforms) {
  const A = (name: string) => instancedBufferAttribute(g.getAttribute(name) as never, 'vec4')
  const iRect = A('iRect'), iMat0 = A('iMat0'), iMat1 = A('iMat1'), iMat2 = A('iMat2'), iClipRect = A('iClipRect'), iClipInv = A('iClipInv'), iClipT = A('iClipT')
  const pos = attribute('position', 'vec3')
  const q = vec2(pos.x.mul(iRect.z), pos.y.mul(iRect.w))                       // quad-local units, centred
  const p4 = vec4(q, 0, 1)
  const local = vec3(dot(iMat0, p4), dot(iMat1, p4), dot(iMat2, p4))
  const vq = varying(q), vLocal = varying(local)
  const surfacePt = vec2(vLocal.x.mul(su.ptPerUnit).add(su.size.x.mul(su.ptPerUnit).mul(0.5)), su.size.y.mul(su.ptPerUnit).mul(0.5).sub(vLocal.y.mul(su.ptPerUnit)))
  const lx = iClipInv.x.mul(surfacePt.x).add(iClipInv.z.mul(surfacePt.y)).add(iClipT.x)
  const ly = iClipInv.y.mul(surfacePt.x).add(iClipInv.w.mul(surfacePt.y)).add(iClipT.y)
  const half = iClipRect.zw.mul(0.5), centre = iClipRect.xy.add(half), r = min(iClipT.z, min(half.x, half.y))
  const cq = abs(vec2(lx, ly).sub(centre)).sub(half.sub(r))
  const cd = length(max(cq, 0)).add(min(max(cq.x, cq.y), 0)).sub(r)
  const clipped = iClipRect.z.greaterThan(0).and(cd.greaterThan(0))
  return { iRect, position: local, q: vq, surfacePt, clipped, A }
}

export function createPanelMaterial(g: InstancedBufferGeometry, su: SurfaceUniforms): MeshBasicNodeMaterial {
  const fv = flatVertex(g, su)
  const iShape = fv.A('iShape'), iColor = fv.A('iColor'), iBorder = fv.A('iBorder')
  const m = new MeshBasicNodeMaterial()
  m.transparent = true; m.depthWrite = false; m.toneMapped = false
  m.positionNode = fv.position
  const d = sdfNode(fv.q, fv.iRect.zw.mul(0.5), iShape.x, iShape.z)
  const aa = fwidth(d).mul(0.75)
  const cover = float(1).sub(smoothstep(aa.negate(), aa, d))
  const borderMix = select(iShape.y.greaterThan(0), smoothstep(aa.negate(), aa, d.add(iShape.y)), float(0))
  const col = mix(iColor, iBorder, borderMix)
  m.colorNode = Fn(() => { If(fv.clipped, () => { Discard() }); return col.rgb })()
  m.opacityNode = cover.mul(col.a).mul(iShape.w)
  return m
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/render && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/quad.ts packages/render/src/panel packages/render/test/panel.test.ts
git commit -m "feat(render): superellipse SDF, instanced panel batch and material"
```

---
### Task 11: Decoration layer — procedural rim and pool decals

**Files:**
- Create: `packages/render/src/flat.ts` (move `flatVertex`/`SurfaceUniforms` here from `panel/material.ts`), `packages/render/src/decoration/material.ts`, `packages/render/src/decoration/batch.ts`
- Modify: `packages/render/src/panel/material.ts` (import `flatVertex` from `../flat`)
- Test: `packages/render/test/decoration.test.ts`

**Interfaces:**
- Consumes: `DecorationInstance` from core; `InstanceBuffer`, `instanceMatrix`, `writeMatrixRows`, `writeClip`; `createQuadGeometry`; `sdfNode`; `cornerExponentFor`.
- Produces:
  - `export const DECOR_ATTRS = ['iRect', 'iShape', 'iColor', 'iMat0', 'iMat1', 'iMat2', 'iClipRect', 'iClipInv', 'iClipT'] as const`; `iShape` = (radius units, strength, cornerExponent, opacity), `iColor` linear rgb + 1.
  - `export class DecorationBatch { readonly kind: 'rim' | 'pool'; readonly geometry; readonly buffer; update(instances: readonly DecorationInstance[], s: SurfaceDims, lift?: (d: DecorationInstance) => number): void }` — keeps only instances of its `kind`, sorted by `z`. `lift(d)` returns extra elevation in pt (the glass thickness for rims); pools are placed at elevation 0 (they lie on the Surface plane under the glass). Pool rects are inflated: width + 0.29·h, height + 0.33·h, centre moved down by 0.11·h (the spike's 24/28/9 px at h = 84).
  - `export function rimProfile(y01: number): { lower: number; top: number }` (CPU reference of the band curves: `lower = 0.42·e^(−21·y01)·(1 − smoothstep(0.30, 0.45, y01))`, `top = 0.22·smoothstep(0.65, 1, y01)`), `export const RIM_OUTLINE_PT = 1.25`, `RIM_OUTLINE_ALPHA = 0.75`.
  - `export function createRimMaterial(geometry, su): MeshBasicNodeMaterial` (normal blending; alpha = `min(1, outline·0.75 + lower + top) · mask · strength · opacity`; colour `iColor`) and `export function createPoolMaterial(geometry, su): MeshBasicNodeMaterial` (`AdditiveBlending`; alpha = `max(0, 1 − |q/half|) · strength · opacity`).

- [ ] **Step 1: Write the failing tests**

`packages/render/test/decoration.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { uniform } from 'three/tsl'
import { Vector2, AdditiveBlending, NormalBlending } from 'three'
import { Node, IDENTITY, type DecorationInstance } from '@glassui/core'
import { DecorationBatch, DECOR_ATTRS } from '../src/decoration/batch'
import { createRimMaterial, createPoolMaterial, rimProfile } from '../src/decoration/material'

const s = { width: 400, height: 300, ptPerUnit: 100 }
const node = new Node('glass', 'g')
const base = { node, rect: { x: 10, y: 10, width: 100, height: 40 }, radius: 20, elevation: 4, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1 }
const rim: DecorationInstance = { ...base, kind: 'rim', color: [1, 1, 1, 1], strength: 1, z: 1.5 }
const pool: DecorationInstance = { ...base, kind: 'pool', color: [0.42, 0.39, 0.96, 1], strength: 0.5, z: 0.75 }

describe('rimProfile', () => {
  it('bright lower band, fading top band, nothing in the middle', () => {
    expect(rimProfile(0).lower).toBeCloseTo(0.42, 6); expect(rimProfile(0).top).toBe(0)
    expect(rimProfile(1).top).toBeCloseTo(0.22, 6); expect(rimProfile(1).lower).toBe(0)
    expect(rimProfile(0.5).lower).toBe(0); expect(rimProfile(0.5).top).toBe(0)
    expect(rimProfile(0.0675).lower).toBeCloseTo(0.10, 1)
  })
})

describe('DecorationBatch', () => {
  it('keeps its own kind, lifts rims by the glass thickness, keeps pools on the plane', () => {
    const rims = new DecorationBatch('rim'), pools = new DecorationBatch('pool')
    rims.update([rim, pool], s, () => 8); pools.update([rim, pool], s)
    expect(rims.buffer.count).toBe(1); expect(pools.buffer.count).toBe(1)
    expect(rims.buffer.get(0, 'iMat2')[3]).toBeCloseTo((4 + 8) / 100)       // elevation + thickness, in units
    expect(pools.buffer.get(0, 'iMat2')[3]).toBe(0)
    expect(rims.buffer.get(0, 'iShape')).toEqual([0.2, 1, 2, 1])
    expect(DECOR_ATTRS).toHaveLength(9)
  })
  it('inflates and lowers the pool rect', () => {
    const pools = new DecorationBatch('pool')
    pools.update([pool], s)
    const [cx, cy, w, h] = pools.buffer.get(0, 'iRect')
    expect(w).toBeCloseTo((100 + 0.29 * 40) / 100); expect(h).toBeCloseTo((40 + 0.33 * 40) / 100)
    expect(cx).toBeCloseTo(-1.4); expect(cy).toBeCloseTo(1.2 - 0.11 * 40 / 100)
  })
  it('materials build with the right blending', () => {
    const b = new DecorationBatch('rim'); b.update([rim], s)
    const su = { size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(100) }
    expect(createRimMaterial(b.geometry, su).blending).toBe(NormalBlending)
    expect(createPoolMaterial(b.geometry, su).blending).toBe(AdditiveBlending)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/render/test/decoration.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

Move `flatVertex` and `SurfaceUniforms` from `panel/material.ts` into `packages/render/src/flat.ts` unchanged (export both); update `panel/material.ts` to import them.

`packages/render/src/decoration/batch.ts`:

```ts
import { Matrix4 } from 'three'
import type { DecorationInstance } from '@glassui/core'
import { InstanceBuffer } from '../instances'
import { instanceMatrix, writeClip, writeMatrixRows } from '../transform'
import { createQuadGeometry } from '../quad'
import { cornerExponentFor } from '../panel/batch'
import { surfaceToLocal, type SurfaceDims } from '../units'
import { srgbToLinear } from '../color'

export const DECOR_ATTRS = ['iRect', 'iShape', 'iColor', 'iMat0', 'iMat1', 'iMat2', 'iClipRect', 'iClipInv', 'iClipT'] as const
/** Pool inflation relative to the element height (the spike's +24 / +28 / 9 px at h = 84). */
export const POOL_INFLATE_X = 0.29, POOL_INFLATE_Y = 0.33, POOL_DROP = 0.11

export class DecorationBatch {
  readonly geometry = createQuadGeometry()
  readonly buffer = new InstanceBuffer(this.geometry, DECOR_ATTRS)
  private m = new Matrix4()
  constructor(readonly kind: 'rim' | 'pool') {}

  update(instances: readonly DecorationInstance[], s: SurfaceDims, lift: (d: DecorationInstance) => number = () => 0): void {
    const mine = instances.filter(d => d.kind === this.kind).sort((a, b) => a.z - b.z)
    const b = this.buffer, ppu = s.ptPerUnit
    b.begin(mine.length)
    mine.forEach((d, i) => {
      let rect = d.rect, elevation = d.elevation + lift(d)
      if (this.kind === 'pool') {
        const h = d.rect.height
        rect = { x: d.rect.x - POOL_INFLATE_X * h / 2, y: d.rect.y - POOL_INFLATE_Y * h / 2 + POOL_DROP * h, width: d.rect.width + POOL_INFLATE_X * h, height: d.rect.height + POOL_INFLATE_Y * h }
        elevation = 0
      }
      const [cx, cy] = surfaceToLocal(rect.x + rect.width / 2, rect.y + rect.height / 2, s)
      b.set(i, 'iRect', cx, cy, rect.width / ppu, rect.height / ppu)
      b.set(i, 'iShape', d.radius / ppu, d.strength, cornerExponentFor(d.rect, d.radius), d.opacity)
      b.set(i, 'iColor', srgbToLinear(d.color[0]), srgbToLinear(d.color[1]), srgbToLinear(d.color[2]), 1)
      writeMatrixRows(b, i, instanceMatrix({ ...d, rect, elevation }, s, this.m))
      writeClip(b, i, d.clip)
    })
    b.commit()
  }
  dispose(): void { this.buffer.dispose() }
}
```

`packages/render/src/decoration/material.ts`:

```ts
import { AdditiveBlending, type InstancedBufferGeometry } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { Fn, If, Discard, float, vec2, abs, max, min, exp, smoothstep, fwidth, length } from 'three/tsl'
import { flatVertex, type SurfaceUniforms } from '../flat'
import { sdfNode } from '../panel/sdf'

export const RIM_OUTLINE_PT = 1.25
export const RIM_OUTLINE_ALPHA = 0.75

const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
/** The rim's lower band (light caught by the bottom round-over) and top band, by height fraction `y01` (0 = bottom). */
export function rimProfile(y01: number): { lower: number; top: number } {
  return { lower: 0.42 * Math.exp(-21 * y01) * (1 - smooth(0.30, 0.45, y01)), top: 0.22 * smooth(0.65, 1, y01) }
}

/** Thin bright outline + lower/top bands, clipped to the superellipse (spike `rimDecal`). */
export function createRimMaterial(g: InstancedBufferGeometry, su: SurfaceUniforms): MeshBasicNodeMaterial {
  const fv = flatVertex(g, su)
  const iShape = fv.A('iShape'), iColor = fv.A('iColor')
  const m = new MeshBasicNodeMaterial()
  m.transparent = true; m.depthWrite = false; m.toneMapped = false
  m.positionNode = fv.position
  const half = fv.iRect.zw.mul(0.5)
  const d = sdfNode(fv.q, half, iShape.x, iShape.z)
  const aa = fwidth(d).mul(0.75)
  const mask = float(1).sub(smoothstep(aa.negate(), aa, d))
  const ow = float(RIM_OUTLINE_PT).div(su.ptPerUnit)
  const outline = float(1).sub(smoothstep(float(0), aa.add(ow.mul(0.25)), abs(d.add(ow.mul(0.5))).sub(ow.mul(0.5))))
  const y01 = fv.q.y.div(fv.iRect.w).add(0.5)
  const lower = float(0.42).mul(exp(y01.mul(-21))).mul(float(1).sub(smoothstep(0.30, 0.45, y01)))   // edge0 < edge1 (GLSL rule)
  const top = float(0.22).mul(smoothstep(0.65, 1.0, y01))
  m.colorNode = Fn(() => { If(fv.clipped, () => { Discard() }); return iColor.rgb })()
  m.opacityNode = min(float(1), outline.mul(RIM_OUTLINE_ALPHA).add(lower).add(top)).mul(mask).mul(iShape.y).mul(iShape.w)
  return m
}

/** Additive light pool under a glass element (spike `glow`): radial falloff over the inflated rect. */
export function createPoolMaterial(g: InstancedBufferGeometry, su: SurfaceUniforms): MeshBasicNodeMaterial {
  const fv = flatVertex(g, su)
  const iShape = fv.A('iShape'), iColor = fv.A('iColor')
  const m = new MeshBasicNodeMaterial()
  m.transparent = true; m.depthWrite = false; m.toneMapped = false; m.blending = AdditiveBlending
  m.positionNode = fv.position
  const r01 = length(fv.q.div(fv.iRect.zw.mul(0.5)))
  m.colorNode = Fn(() => { If(fv.clipped, () => { Discard() }); return iColor.rgb })()
  m.opacityNode = max(float(1).sub(r01), 0).mul(iShape.y).mul(iShape.w)
  return m
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/render && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/flat.ts packages/render/src/decoration packages/render/src/panel/material.ts packages/render/test/decoration.test.ts
git commit -m "feat(render): procedural rim and pool decoration decals; shared flat vertex stage"
```

---

### Task 12: Text — measure bridge, atlas page textures, glyph material and batch

**Files:**
- Create: `packages/render/src/text/measure.ts`, `packages/render/src/text/pages.ts`, `packages/render/src/text/material.ts`, `packages/render/src/text/batch.ts`
- Test: `packages/render/test/text.test.ts`

**Interfaces:**
- Consumes: `TextEngine`, `AtlasManager` (+ `epoch`, Task 4), `GlyphPlacement`, `TextRun` (`maxLines`, `wrap`) from `@glassui/text`; `MeasureFn`, `resolveTextStyle`, `TextInstance` from core; `flatVertex`, `InstanceBuffer`, `instanceMatrix`, `writeMatrixRows`, `writeClip`, `createQuadGeometry`.
- Produces:
  - `export function createMeasureFn(engine: TextEngine, theme: Theme, scheme: ColorScheme, opts?: { cacheSize?: number }): MeasureFn & { clear(): void }` — builds the run from `resolveTextStyle(node)` + `props.value`, passes `maxWidth` through, caches by `(text, family, size, weight, lineHeight, letterSpacing, maxLines, wrap, maxWidth)` with LRU eviction at `cacheSize` (default 2000).
  - `export function runFor(t: Pick<TextInstance, 'text' | 'font' | 'lineHeight' | 'letterSpacing' | 'maxLines' | 'wrap'>): TextRun`.
  - `export class AtlasPages { constructor(atlas: AtlasManager); readonly textures: CanvasTexture[]; sync(): { uploaded: number[]; epochChanged: boolean }; dispose(): void }` — one `CanvasTexture` per atlas page (`colorSpace = NoColorSpace`, `generateMipmaps = true`, `minFilter = LinearMipmapLinearFilter`, `magFilter = LinearFilter`, `anisotropy = 4`, `premultiplyAlpha = false`); `sync` creates textures for new pages, sets `needsUpdate` on dirty pages, calls `atlas.clearDirty()`, and reports whether `atlas.epoch` changed since the last sync.
  - `export const GLYPH_ATTRS = ['iRect', 'iUV', 'iColor', 'iMat0', 'iMat1', 'iMat2', 'iClipRect', 'iClipInv', 'iClipT', 'iMisc'] as const`; `iUV` = (u0, v0, u1, v1) as the atlas reports them (top-left origin; the material flips v), `iMisc` = (opacity, lumaIndex, 0, 0).
  - `export function createGlyphMaterial(geometry, su, page: Texture): MeshBasicNodeMaterial` — unlit, `transparent`, `depthWrite false`, `toneMapped false`, `colorNode = iColor.rgb`, `opacityNode = texture(page).sample(vec2(u, 1 − v)).a · iColor.a · iMisc.x`, clip → `Discard()`.
  - `export class GlyphBatch { constructor(engine: TextEngine, pages: AtlasPages); readonly perPage: Map<number, { geometry: InstancedBufferGeometry; buffer: InstanceBuffer }>; update(instances: readonly TextInstance[], s: SurfaceDims, lift?: (t: TextInstance) => number): void; glyphCount: number; dispose() }` — lays every instance out with `engine.layout(runFor(t), t.rect.width, t.align)`, converts each placement to a surface-pt rect, applies the text instance's composed transform/elevation(+lift)/tilt/opacity/clip, groups by atlas page (buffers are created on demand and never shrink), then `pages.sync()`.

- [ ] **Step 1: Write the failing tests**

`packages/render/test/text.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { uniform } from 'three/tsl'
import { Vector2, Texture } from 'three'
import { Node, IDENTITY, defaultTheme as theme, type TextInstance } from '@glassui/core'
import { SystemFontEngine } from '@glassui/text'
import { createMeasureFn, runFor } from '../src/text/measure'
import { AtlasPages } from '../src/text/pages'
import { GlyphBatch, GLYPH_ATTRS } from '../src/text/batch'
import { createGlyphMaterial } from '../src/text/material'

const engine = new SystemFontEngine({ createCanvas: ((w: number, h: number) => createCanvas(w, h)) as never, pageSize: 256, maxPages: 2 })
const s = { width: 400, height: 300, ptPerUnit: 100 }
function text(value: string, extra: Partial<TextInstance> = {}): TextInstance {
  return { node: new Node('text'), rect: { x: 10, y: 10, width: 200, height: 40 }, text: value, font: { family: 'system-ui', size: 17, weight: 400 }, color: [0.1, 0.1, 0.13, 1], align: 'left', lineHeight: 22, letterSpacing: 0, wrap: true, z: 1.25, elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 1, ...extra }
}

describe('createMeasureFn', () => {
  it('measures through resolveTextStyle and caches', () => {
    const n = new Node('text'); n.setProp('value', '创建账号'); n.setStyle({ fontSize: 'lg' })
    const measure = createMeasureFn(engine, theme, 'light')
    const a = measure(n, undefined)
    expect(a.width).toBeGreaterThan(0); expect(a.height).toBe(Math.round(1.3 * theme.fontSize.lg!))
    expect(measure(n, undefined)).toEqual(a)
    expect(measure(n, 10).width).toBeLessThanOrEqual(a.width)
  })
  it('runFor carries maxLines and wrap', () => {
    expect(runFor(text('x', { maxLines: 2, wrap: false }))).toMatchObject({ text: 'x', maxLines: 2, wrap: false, lineHeight: 22 })
  })
})

describe('AtlasPages', () => {
  it('creates textures for pages, uploads dirty ones, reports epoch changes', () => {
    const pages = new AtlasPages(engine.atlas)
    engine.layout({ text: 'abc', font: { family: 'system-ui', size: 17, weight: 400 } }, undefined, 'left')
    const r = pages.sync()
    expect(pages.textures.length).toBe(engine.atlas.pages.length)
    expect(r.uploaded).toContain(0); expect(r.epochChanged).toBe(false)
    expect(pages.textures[0]!.needsUpdate === true || pages.textures[0]!.version > 0).toBe(true)
    expect(pages.sync().uploaded).toEqual([])
    engine.atlas.invalidate()
    expect(pages.sync().epochChanged).toBe(true)
  })
})

describe('GlyphBatch', () => {
  it('emits one quad per visible glyph, grouped by page, with the text transform', () => {
    const pages = new AtlasPages(engine.atlas)
    const b = new GlyphBatch(engine, pages)
    b.update([text('ab cd'), text('中文', { rect: { x: 0, y: 100, width: 100, height: 30 }, opacity: 0.5, elevation: 2 })], s, t => t.text === '中文' ? 8 : 0)
    expect(b.glyphCount).toBe(6)
    const pageBuf = [...b.perPage.values()]
    expect(pageBuf.reduce((n, p) => n + p.buffer.count, 0)).toBe(6)
    const first = pageBuf[0]!.buffer
    const rect = first.get(0, 'iRect')
    expect(rect[2]).toBeGreaterThan(0); expect(rect[3]).toBeGreaterThan(0)
    const uv = first.get(0, 'iUV'); expect(uv[2]).toBeGreaterThan(uv[0]); expect(uv[3]).toBeGreaterThan(uv[1])
    const cjk = pageBuf.flatMap(p => Array.from({ length: p.buffer.count }, (_, i) => p.buffer.get(i, 'iMisc')[0])).filter(o => o === 0.5)
    expect(cjk).toHaveLength(2)
    expect(GLYPH_ATTRS).toHaveLength(10)
  })
  it('lifts glyphs by elevation plus lift', () => {
    const pages = new AtlasPages(engine.atlas)
    const b = new GlyphBatch(engine, pages)
    b.update([text('A', { elevation: 2 })], s, () => 8)
    const p = [...b.perPage.values()][0]!.buffer
    expect(p.get(0, 'iMat2')[3]).toBeCloseTo(0.1)
  })
  it('grows beyond the initial capacity', () => {
    const pages = new AtlasPages(engine.atlas)
    const b = new GlyphBatch(engine, pages)
    b.update([text('x'.repeat(100), { rect: { x: 0, y: 0, width: 2000, height: 40 } })], s)
    expect(b.glyphCount).toBe(100)
  })
  it('material builds', () => {
    const pages = new AtlasPages(engine.atlas)
    const b = new GlyphBatch(engine, pages); b.update([text('A')], s)
    const g = [...b.perPage.values()][0]!.geometry
    const m = createGlyphMaterial(g, { size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(100) }, new Texture())
    expect(m.transparent).toBe(true); expect(m.opacityNode).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/render/test/text.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `text/measure.ts`**

```ts
import { resolveTextStyle, type ColorScheme, type MeasureFn, type Node, type TextInstance, type Theme } from '@glassui/core'
import type { TextEngine, TextRun } from '@glassui/text'

export function runFor(t: Pick<TextInstance, 'text' | 'font' | 'lineHeight' | 'letterSpacing' | 'maxLines' | 'wrap'>): TextRun {
  return { text: t.text, font: t.font, lineHeight: t.lineHeight, letterSpacing: t.letterSpacing, maxLines: t.maxLines, wrap: t.wrap }
}

/** The yoga measure callback: core text style → text run → engine measure, memoised (spec §6). */
export function createMeasureFn(engine: TextEngine, theme: Theme, scheme: ColorScheme, opts: { cacheSize?: number } = {}): MeasureFn & { clear(): void } {
  const cacheSize = opts.cacheSize ?? 2000
  const cache = new Map<string, { width: number; height: number }>()
  const fn = ((node: Node, maxWidth: number | undefined) => {
    const t = resolveTextStyle(node, theme, scheme)
    const text = String(node.props.value ?? '')
    const key = `${text}\u0000${t.family}|${t.size}|${t.weight}|${t.lineHeight}|${t.letterSpacing}|${t.maxLines ?? ''}|${t.wrap}|${maxWidth ?? ''}`
    const hit = cache.get(key)
    if (hit) { cache.delete(key); cache.set(key, hit); return hit }
    const m = engine.measure({ text, font: { family: t.family, size: t.size, weight: t.weight }, lineHeight: t.lineHeight, letterSpacing: t.letterSpacing, maxLines: t.maxLines, wrap: t.wrap }, { maxWidth })
    const r = { width: m.width, height: m.height }
    cache.set(key, r)
    if (cache.size > cacheSize) cache.delete(cache.keys().next().value as string)
    return r
  }) as MeasureFn & { clear(): void }
  fn.clear = () => cache.clear()
  return fn
}
```

- [ ] **Step 4: Implement `text/pages.ts`**

```ts
import { CanvasTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace } from 'three'
import type { AtlasManager } from '@glassui/text'

/** GPU textures for the atlas pages; call `sync()` once per frame after layout. */
export class AtlasPages {
  readonly textures: CanvasTexture[] = []
  private lastEpoch: number
  constructor(private readonly atlas: AtlasManager) { this.lastEpoch = atlas.epoch }

  sync(): { uploaded: number[]; epochChanged: boolean } {
    const uploaded: number[] = []
    for (let i = this.textures.length; i < this.atlas.pages.length; i++) {
      const t = new CanvasTexture(this.atlas.pages[i] as unknown as HTMLCanvasElement)
      t.colorSpace = NoColorSpace; t.generateMipmaps = true; t.minFilter = LinearMipmapLinearFilter; t.magFilter = LinearFilter
      t.anisotropy = 4; t.premultiplyAlpha = false
      this.textures.push(t)
      uploaded.push(i)
    }
    for (const i of this.atlas.dirtyPages) { this.textures[i]!.needsUpdate = true; if (!uploaded.includes(i)) uploaded.push(i) }
    this.atlas.clearDirty()
    const epochChanged = this.atlas.epoch !== this.lastEpoch
    this.lastEpoch = this.atlas.epoch
    return { uploaded: uploaded.sort((a, b) => a - b), epochChanged }
  }
  dispose(): void { for (const t of this.textures) t.dispose() }
}
```

- [ ] **Step 5: Implement `text/material.ts`**

```ts
import type { InstancedBufferGeometry, Texture } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { Fn, If, Discard, attribute, texture, vec2, float, mix } from 'three/tsl'
import { flatVertex, type SurfaceUniforms } from '../flat'

/** Unlit glyph quads sampling one atlas page's alpha (spec §5.5: readability first, no lighting). */
export function createGlyphMaterial(g: InstancedBufferGeometry, su: SurfaceUniforms, page: Texture): MeshBasicNodeMaterial {
  const fv = flatVertex(g, su)
  const iUV = fv.A('iUV'), iColor = fv.A('iColor'), iMisc = fv.A('iMisc')
  const uv = attribute('uv', 'vec2')
  const u = mix(iUV.x, iUV.z, uv.x), v = mix(iUV.y, iUV.w, float(1).sub(uv.y))   // quad uv.y is up; atlas v is down
  const m = new MeshBasicNodeMaterial()
  m.transparent = true; m.depthWrite = false; m.toneMapped = false
  m.positionNode = fv.position
  m.colorNode = Fn(() => { If(fv.clipped, () => { Discard() }); return iColor.rgb })()
  m.opacityNode = texture(page).sample(vec2(u, float(1).sub(v))).a.mul(iColor.a).mul(iMisc.x)
  return m
}
```

- [ ] **Step 6: Implement `text/batch.ts`**

```ts
import { Matrix4, type InstancedBufferGeometry } from 'three'
import type { TextInstance } from '@glassui/core'
import type { TextEngine } from '@glassui/text'
import { InstanceBuffer } from '../instances'
import { instanceMatrix, writeClip, writeMatrixRows } from '../transform'
import { createQuadGeometry } from '../quad'
import { surfaceToLocal, type SurfaceDims } from '../units'
import { srgbToLinear } from '../color'
import { runFor } from './measure'
import type { AtlasPages } from './pages'

export const GLYPH_ATTRS = ['iRect', 'iUV', 'iColor', 'iMat0', 'iMat1', 'iMat2', 'iClipRect', 'iClipInv', 'iClipT', 'iMisc'] as const

interface PageBatch { geometry: InstancedBufferGeometry; buffer: InstanceBuffer }
interface Pending { page: number; rect: { x: number; y: number; width: number; height: number }; uv: [number, number, number, number]; t: TextInstance; lift: number }

/** Every glyph of a Surface's text instances as quads, one instanced draw per atlas page. */
export class GlyphBatch {
  readonly perPage = new Map<number, PageBatch>()
  glyphCount = 0
  private m = new Matrix4()
  constructor(private readonly engine: TextEngine, private readonly pages: AtlasPages) {}

  update(instances: readonly TextInstance[], s: SurfaceDims, lift: (t: TextInstance) => number = () => 0): void {
    const pending: Pending[] = []
    for (const t of [...instances].sort((a, b) => a.z - b.z)) {
      const l = lift(t)
      for (const g of this.engine.layout(runFor(t), t.rect.width, t.align)) {
        pending.push({ page: g.page, rect: { x: t.rect.x + g.x, y: t.rect.y + g.y, width: g.width, height: g.height }, uv: [g.u0, g.v0, g.u1, g.v1], t, lift: l })
      }
    }
    this.glyphCount = pending.length
    const byPage = new Map<number, Pending[]>()
    for (const p of pending) { const arr = byPage.get(p.page) ?? []; arr.push(p); byPage.set(p.page, arr) }
    for (const [page, pb] of this.perPage) if (!byPage.has(page)) { pb.buffer.begin(0); pb.buffer.commit() }
    for (const [page, list] of byPage) {
      let pb = this.perPage.get(page)
      if (!pb) { const geometry = createQuadGeometry(); pb = { geometry, buffer: new InstanceBuffer(geometry, GLYPH_ATTRS, 64) }; this.perPage.set(page, pb) }
      const b = pb.buffer
      b.begin(list.length)
      list.forEach((p, i) => {
        const [cx, cy] = surfaceToLocal(p.rect.x + p.rect.width / 2, p.rect.y + p.rect.height / 2, s)
        b.set(i, 'iRect', cx, cy, p.rect.width / s.ptPerUnit, p.rect.height / s.ptPerUnit)
        b.set(i, 'iUV', ...p.uv)
        b.set(i, 'iColor', srgbToLinear(p.t.color[0]), srgbToLinear(p.t.color[1]), srgbToLinear(p.t.color[2]), p.t.color[3])
        writeMatrixRows(b, i, instanceMatrix({ ...p.t, rect: p.rect, elevation: p.t.elevation + p.lift }, s, this.m))
        writeClip(b, i, p.t.clip)
        b.set(i, 'iMisc', p.t.opacity, -1, 0, 0)
      })
      b.commit()
    }
    this.pages.sync()
  }
  dispose(): void { for (const pb of this.perPage.values()) pb.buffer.dispose(); this.perPage.clear() }
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm vitest run packages/render && pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/render/src/text packages/render/test/text.test.ts
git commit -m "feat(render): measure bridge, atlas page textures, glyph material and per-page glyph batches"
```

---

### Task 13: Images

**Files:**
- Create: `packages/render/src/image/images.ts`
- Test: `packages/render/test/images.test.ts`

**Interfaces:**
- Consumes: `ImageInstance` from core; `flatVertex`, `InstanceBuffer`, `createQuadGeometry`, `instanceMatrix`, `writeMatrixRows`, `writeClip`, `sdfNode`, `cornerExponentFor`.
- Produces:
  - `export type ImageSource = string | Texture | { width: number; height: number }` (the object form is any `TexImageSource`: `HTMLImageElement`, `ImageBitmap`, canvas).
  - `export type ImageLoader = (src: ImageSource) => Texture` — the default (`defaultImageLoader`) wraps a `Texture` as is, an element in a `Texture` with `needsUpdate`, and a string through three's `TextureLoader` (returns the texture immediately, three fills it when loaded); every texture gets `colorSpace = SRGBColorSpace`.
  - `export const IMAGE_ATTRS = ['iRect', 'iShape', 'iMat0', 'iMat1', 'iMat2', 'iClipRect', 'iClipInv', 'iClipT'] as const`; `iShape` = (radius units, cornerExponent, opacity, 0).
  - `export class ImageSet { constructor(su: SurfaceUniforms, loader?: ImageLoader); readonly group: Group; update(instances: readonly ImageInstance[], s: SurfaceDims, lift?: (i: ImageInstance) => number): void; dispose() }` — one `Mesh` per image instance (one-instance `InstanceBuffer` on its own quad geometry, material `createImageMaterial(geometry, su, texture)`: `colorNode = texture.sample(uv).rgb`, `opacityNode = cover · texture.a · opacity`, clip → `Discard`), reused by `node` identity across updates, removed when the instance disappears; `renderOrder = z`.

- [ ] **Step 1: Write the failing test**

`packages/render/test/images.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { uniform } from 'three/tsl'
import { Vector2, Texture, Mesh } from 'three'
import { Node, IDENTITY, type ImageInstance } from '@glassui/core'
import { ImageSet, IMAGE_ATTRS } from '../src/image/images'

const s = { width: 400, height: 300, ptPerUnit: 100 }
const su = { size: uniform(new Vector2(4, 3)), ptPerUnit: uniform(100) }
const img = (id: string, src: unknown): ImageInstance => ({ node: new Node('image', id), rect: { x: 10, y: 10, width: 100, height: 100 }, src, radius: 50, z: 1.25, elevation: 0, scale: 1, transform: IDENTITY, tilt: { x: 0, y: 0 }, opacity: 0.8 })

describe('ImageSet', () => {
  it('creates one mesh per image, reuses by node, removes stale ones', () => {
    const calls: unknown[] = []
    const set = new ImageSet(su, src => { calls.push(src); return new Texture() })
    const a = img('a', 'a.png'), b = img('b', new Texture())
    set.update([a, b], s)
    expect(set.group.children).toHaveLength(2); expect(calls).toHaveLength(2)
    const meshA = set.group.children.find(c => c.userData.node === a.node) as Mesh
    set.update([a], s)
    expect(set.group.children).toHaveLength(1); expect(set.group.children[0]).toBe(meshA); expect(calls).toHaveLength(2)
    expect(IMAGE_ATTRS).toHaveLength(8)
  })
  it('packs radius as a capsule exponent and opacity', () => {
    const set = new ImageSet(su, () => new Texture())
    set.update([img('a', 'a.png')], s)
    const mesh = set.group.children[0] as Mesh
    const shape = (mesh.userData.buffer as { get(i: number, n: string): number[] }).get(0, 'iShape')
    expect(shape).toEqual([0.5, 2, 0.8, 0])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/render/test/images.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `image/images.ts`**

```ts
import { Group, Matrix4, Mesh, SRGBColorSpace, Texture, TextureLoader, type InstancedBufferGeometry } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { Fn, If, Discard, attribute, texture, float, fwidth, smoothstep } from 'three/tsl'
import type { ImageInstance, Node } from '@glassui/core'
import { flatVertex, type SurfaceUniforms } from '../flat'
import { sdfNode } from '../panel/sdf'
import { cornerExponentFor } from '../panel/batch'
import { InstanceBuffer } from '../instances'
import { createQuadGeometry } from '../quad'
import { instanceMatrix, writeClip, writeMatrixRows } from '../transform'
import { surfaceToLocal, type SurfaceDims } from '../units'

export type ImageSource = string | Texture | { width: number; height: number }
export type ImageLoader = (src: ImageSource) => Texture
export const IMAGE_ATTRS = ['iRect', 'iShape', 'iMat0', 'iMat1', 'iMat2', 'iClipRect', 'iClipInv', 'iClipT'] as const

let loader: TextureLoader | undefined
export const defaultImageLoader: ImageLoader = src => {
  let t: Texture
  if (src instanceof Texture) t = src
  else if (typeof src === 'string') t = (loader ??= new TextureLoader()).load(src)
  else { t = new Texture(src as unknown as HTMLImageElement); t.needsUpdate = true }
  t.colorSpace = SRGBColorSpace
  return t
}

export function createImageMaterial(g: InstancedBufferGeometry, su: SurfaceUniforms, tex: Texture): MeshBasicNodeMaterial {
  const fv = flatVertex(g, su)
  const iShape = fv.A('iShape')
  const uv = attribute('uv', 'vec2')
  const m = new MeshBasicNodeMaterial()
  m.transparent = true; m.depthWrite = false; m.toneMapped = false
  m.positionNode = fv.position
  const d = sdfNode(fv.q, fv.iRect.zw.mul(0.5), iShape.x, iShape.y)
  const aa = fwidth(d).mul(0.75)
  const cover = float(1).sub(smoothstep(aa.negate(), aa, d))
  const sample = texture(tex).sample(uv)
  m.colorNode = Fn(() => { If(fv.clipped, () => { Discard() }); return sample.rgb })()
  m.opacityNode = cover.mul(sample.a).mul(iShape.z)
  return m
}

/** One quad mesh per image instance (spec §5.5: images are separate draws in this phase). */
export class ImageSet {
  readonly group = new Group()
  private meshes = new Map<Node, Mesh>()
  private m = new Matrix4()
  constructor(private readonly su: SurfaceUniforms, private readonly load: ImageLoader = defaultImageLoader) {}

  update(instances: readonly ImageInstance[], s: SurfaceDims, lift: (i: ImageInstance) => number = () => 0): void {
    const keep = new Set<Node>()
    for (const inst of instances) {
      keep.add(inst.node)
      let mesh = this.meshes.get(inst.node)
      if (!mesh || mesh.userData.src !== inst.src) {
        if (mesh) { this.group.remove(mesh); (mesh.material as MeshBasicNodeMaterial).dispose(); mesh.geometry.dispose() }
        const geometry = createQuadGeometry()
        const buffer = new InstanceBuffer(geometry, IMAGE_ATTRS, 1)
        mesh = new Mesh(geometry, createImageMaterial(geometry, this.su, this.load(inst.src as ImageSource)))
        mesh.frustumCulled = false
        mesh.userData = { node: inst.node, src: inst.src, buffer }
        this.meshes.set(inst.node, mesh); this.group.add(mesh)
      }
      const b = mesh.userData.buffer as InstanceBuffer
      b.begin(1)
      const [cx, cy] = surfaceToLocal(inst.rect.x + inst.rect.width / 2, inst.rect.y + inst.rect.height / 2, s)
      b.set(0, 'iRect', cx, cy, inst.rect.width / s.ptPerUnit, inst.rect.height / s.ptPerUnit)
      b.set(0, 'iShape', inst.radius / s.ptPerUnit, cornerExponentFor(inst.rect, inst.radius), inst.opacity, 0)
      writeMatrixRows(b, 0, instanceMatrix({ ...inst, elevation: inst.elevation + lift(inst) }, s, this.m))
      writeClip(b, 0, inst.clip)
      b.commit()
      mesh.renderOrder = inst.z
    }
    for (const [node, mesh] of this.meshes) if (!keep.has(node)) { this.group.remove(mesh); (mesh.material as MeshBasicNodeMaterial).dispose(); mesh.geometry.dispose(); this.meshes.delete(node) }
  }
  dispose(): void { for (const mesh of this.meshes.values()) { (mesh.material as MeshBasicNodeMaterial).dispose(); mesh.geometry.dispose() } this.meshes.clear(); this.group.clear() }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/render && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/image packages/render/test/images.test.ts
git commit -m "feat(render): image quads with rounded clipping and pluggable loading"
```

---

### Task 14: Render-list partition and the Surface content pass

**Files:**
- Create: `packages/render/src/surface/partition.ts`, `packages/render/src/surface/content.ts`
- Test: `packages/render/test/partition.test.ts`, `packages/render/test/content.test.ts`

**Interfaces:**
- Consumes: `RenderList`, `GlassInstance`, `TextInstance`, `ImageInstance`, `DecorationInstance`, `Node` from core.
- Produces:
  - `export interface Partition { content: { panels: PanelInstance[]; pools: DecorationInstance[]; text: TextInstance[]; images: ImageInstance[] }; foreground: { rims: DecorationInstance[]; text: TextInstance[]; images: ImageInstance[] }; glassOf: Map<Node, GlassInstance> }` and `export function partition(rl: RenderList): Partition` — a text/image instance is *foreground* when any ancestor node (walking `node.parent`) is the node of a `GlassInstance` in `rl`; `glassOf` maps each foreground item's node to that nearest glass instance (for the thickness lift; rims map to their own glass). Pools are always content; rims always foreground.
  - `export function liftFor(p: Partition, node: Node): number` — `glassOf.get(node)?.params.thickness ?? 0`.
  - `export function contentRTSize(projectedPx: { width: number; height: number }, dpr: number, opts?: { cap?: number; step?: number; scale?: number }): { width: number; height: number }` — `ceil(px·dpr·scale / step)·step`, clamped to `[1, cap]` (defaults `cap = 4096`, `step = 64`, `scale = 1`); NaN/negative → 1.
  - `export interface RendererLike { setRenderTarget(rt: RenderTarget | null): void; render(scene: Object3D, camera: Camera): unknown; getClearColor?(target: Color): Color; getClearAlpha?(): number; setClearColor?(c: Color | number, alpha?: number): void }`.
  - `export class ContentPass { constructor(opts?: { type?: 'byte' | 'half' }); readonly scene: Scene; readonly camera: OrthographicCamera; readonly target: RenderTarget; readonly texture: Texture; resize(width: number, height: number): boolean; setView(s: SurfaceDims): void; render(renderer: RendererLike, clear: { color: Color; alpha: number }): void; dispose() }` — `RenderTarget` with `generateMipmaps = true`, `minFilter = LinearMipmapLinearFilter`, `magFilter = LinearFilter`, `colorSpace = LinearSRGBColorSpace`, `type` `UnsignedByteType` or `HalfFloatType`; `resize` reallocates only on change and returns whether it did; `setView` sets the ortho frustum to the Surface rect in units (`−W/2..W/2`, `−H/2..H/2`, near −10, far 10, camera at `z = 5` looking down −z); `render` sets the clear colour/alpha, renders `scene` with `camera` into `target`, and restores the previous render target (`null`) and clear colour.

- [ ] **Step 1: Write the failing tests**

`packages/render/test/partition.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { Node, createSurface, createYogaLayout, buildRenderList, defaultTheme as theme, type LayoutEngine } from '@glassui/core'
import { partition, liftFor } from '../src/surface/partition'

let engine: LayoutEngine
beforeAll(async () => { engine = await createYogaLayout() })

describe('partition', () => {
  it('puts children of glass in the foreground, everything else in the content layer', () => {
    const s = createSurface({ id: 'p', width: 400, height: 300 })
    const card = new Node('box', 'card'); card.setStyle({ bg: 'fill', padding: 10 })
    const title = new Node('text', 'title'); title.setProp('value', 'Hi')
    const btn = new Node('glass', 'btn'); btn.setStyle({ width: 120, height: 40, glass: { thickness: 9 } })
    const label = new Node('text', 'label'); label.setProp('value', 'Go')
    const wrap = new Node('box', 'wrap'); const icon = new Node('image', 'icon'); icon.setProp('src', 'x.png')
    s.root.appendChild(card); card.appendChild(title); card.appendChild(btn); btn.appendChild(wrap); wrap.appendChild(icon); btn.appendChild(label)
    engine.compute(s.root, 400, 300, () => ({ width: 20, height: 20 }))
    const p = partition(buildRenderList(s, theme, 'light'))
    expect(p.content.panels.map(x => x.node.id)).toEqual(['card'])
    expect(p.content.text.map(x => x.node.id)).toEqual(['title'])
    expect(p.foreground.text.map(x => x.node.id)).toEqual(['label'])
    expect(p.foreground.images.map(x => x.node.id)).toEqual(['icon'])
    expect(p.content.pools).toHaveLength(1); expect(p.foreground.rims).toHaveLength(1)
    expect(liftFor(p, label)).toBe(9); expect(liftFor(p, icon)).toBe(9); expect(liftFor(p, title)).toBe(0); expect(liftFor(p, btn)).toBe(9)
  })
})
```

`packages/render/test/content.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { Color, HalfFloatType, UnsignedByteType } from 'three'
import { contentRTSize, ContentPass } from '../src/surface/content'

describe('contentRTSize', () => {
  it('steps up to a multiple of 64 and clamps', () => {
    expect(contentRTSize({ width: 100, height: 50 }, 2)).toEqual({ width: 256, height: 128 })
    expect(contentRTSize({ width: 100, height: 50 }, 1, { step: 1 })).toEqual({ width: 100, height: 50 })
    expect(contentRTSize({ width: 10000, height: 10 }, 1)).toEqual({ width: 4096, height: 64 })
    expect(contentRTSize({ width: 0, height: -5 }, 2)).toEqual({ width: 1, height: 1 })
    expect(contentRTSize({ width: NaN, height: 10 }, 2)).toEqual({ width: 1, height: 64 })
    expect(contentRTSize({ width: 100, height: 100 }, 2, { scale: 0.5 })).toEqual({ width: 128, height: 128 })
  })
})

describe('ContentPass', () => {
  it('allocates the target with mipmaps and resizes only on change', () => {
    const p = new ContentPass()
    expect(p.target.texture.generateMipmaps).toBe(true); expect(p.target.texture.type).toBe(UnsignedByteType)
    expect(p.resize(256, 128)).toBe(true); expect(p.resize(256, 128)).toBe(false)
    expect(p.target.width).toBe(256)
    expect(new ContentPass({ type: 'half' }).target.texture.type).toBe(HalfFloatType)
  })
  it('sets the ortho view to the surface rect in units', () => {
    const p = new ContentPass()
    p.setView({ width: 400, height: 300, ptPerUnit: 100 })
    expect(p.camera.left).toBe(-2); expect(p.camera.right).toBe(2); expect(p.camera.top).toBe(1.5); expect(p.camera.bottom).toBe(-1.5)
  })
  it('renders into the target and restores the default target and clear colour', () => {
    const p = new ContentPass()
    const calls: string[] = []
    const renderer = {
      setRenderTarget: vi.fn((rt: unknown) => calls.push(rt ? 'rt' : 'null')),
      render: vi.fn(() => calls.push('render')),
      setClearColor: vi.fn(), getClearColor: vi.fn((t: Color) => t.setRGB(0.2, 0.3, 0.4)), getClearAlpha: vi.fn(() => 1),
    }
    p.render(renderer, { color: new Color().setRGB(1, 0, 0), alpha: 0 })
    expect(calls).toEqual(['rt', 'render', 'null'])
    expect(renderer.setClearColor).toHaveBeenNthCalledWith(1, expect.objectContaining({ r: 1 }), 0)
    expect(renderer.setClearColor).toHaveBeenLastCalledWith(expect.objectContaining({ r: 0.2 }), 1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/render/test/partition.test.ts packages/render/test/content.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement `surface/partition.ts`**

```ts
import type { DecorationInstance, GlassInstance, ImageInstance, Node, PanelInstance, RenderList, TextInstance } from '@glassui/core'

export interface Partition {
  content: { panels: PanelInstance[]; pools: DecorationInstance[]; text: TextInstance[]; images: ImageInstance[] }
  foreground: { rims: DecorationInstance[]; text: TextInstance[]; images: ImageInstance[] }
  glassOf: Map<Node, GlassInstance>
}

/**
 * Spec §5.1/§5.6: non-glass content is drawn into the Surface's content RT; whatever sits *on* a glass element (its
 * descendants) is drawn in 3D on top of the slab. Pools lie under the glass (content), rims ride on top (foreground).
 */
export function partition(rl: RenderList): Partition {
  const glass = new Map<Node, GlassInstance>()
  for (const g of rl.glass) glass.set(g.node, g)
  const glassOf = new Map<Node, GlassInstance>()
  const nearest = (n: Node): GlassInstance | undefined => {
    const cached = glassOf.get(n)
    if (cached) return cached
    for (let p: Node | null = n; p; p = p.parent) { const g = glass.get(p); if (g) { glassOf.set(n, g); return g } }
    return undefined
  }
  const out: Partition = { content: { panels: [...rl.panels], pools: [], text: [], images: [] }, foreground: { rims: [], text: [], images: [] }, glassOf }
  for (const d of rl.decorations) { if (d.kind === 'pool') out.content.pools.push(d); else { out.foreground.rims.push(d); nearest(d.node) } }
  for (const t of rl.text) (nearest(t.node) ? out.foreground.text : out.content.text).push(t)
  for (const i of rl.images) (nearest(i.node) ? out.foreground.images : out.content.images).push(i)
  return out
}

/** The thickness of the glass a foreground item rides on (0 for content-layer items). */
export function liftFor(p: Partition, node: Node): number { return p.glassOf.get(node)?.params.thickness ?? 0 }
```

- [ ] **Step 4: Implement `surface/content.ts`**

```ts
import { Color, HalfFloatType, LinearFilter, LinearMipmapLinearFilter, LinearSRGBColorSpace, OrthographicCamera, RenderTarget, RGBAFormat, Scene, UnsignedByteType, type Camera, type Object3D, type Texture } from 'three'
import type { SurfaceDims } from '../units'

/** RT pixels for a Surface projected to `projectedPx` CSS px: integer steps avoid per-frame jitter; never 0; capped. */
export function contentRTSize(projectedPx: { width: number; height: number }, dpr: number, opts: { cap?: number; step?: number; scale?: number } = {}): { width: number; height: number } {
  const { cap = 4096, step = 64, scale = 1 } = opts
  const fit = (v: number) => { const px = v * dpr * scale; if (!(px > 0)) return 1; return Math.max(1, Math.min(cap, Math.ceil(px / step) * step)) }
  return { width: fit(projectedPx.width), height: fit(projectedPx.height) }
}

/** The subset of `WebGPURenderer` the render passes call (so tests can pass a stub). */
export interface RendererLike {
  setRenderTarget(rt: RenderTarget | null): void
  render(scene: Object3D, camera: Camera): unknown
  setClearColor?(color: Color | number, alpha?: number): void
  getClearColor?(target: Color): Color
  getClearAlpha?(): number
}

/** Spec §5.6 step 2: the Surface's non-glass content, drawn orthographically in Surface-local units into a mipmapped RT. */
export class ContentPass {
  readonly scene = new Scene()
  readonly camera = new OrthographicCamera(-1, 1, 1, -1, -10, 10)
  readonly target: RenderTarget
  private prevColor = new Color()
  constructor(opts: { type?: 'byte' | 'half' } = {}) {
    this.target = new RenderTarget(1, 1, {
      format: RGBAFormat, type: opts.type === 'half' ? HalfFloatType : UnsignedByteType,
      generateMipmaps: true, minFilter: LinearMipmapLinearFilter, magFilter: LinearFilter, colorSpace: LinearSRGBColorSpace, depthBuffer: false,
    })
    this.camera.position.z = 5
  }
  get texture(): Texture { return this.target.texture }

  resize(width: number, height: number): boolean {
    if (this.target.width === width && this.target.height === height) return false
    this.target.setSize(width, height)
    return true
  }

  setView(s: SurfaceDims): void {
    const w = s.width / s.ptPerUnit, h = s.height / s.ptPerUnit
    this.camera.left = -w / 2; this.camera.right = w / 2; this.camera.top = h / 2; this.camera.bottom = -h / 2
    this.camera.updateProjectionMatrix()
  }

  render(renderer: RendererLike, clear: { color: Color; alpha: number }): void {
    const prevAlpha = renderer.getClearAlpha?.() ?? 1
    renderer.getClearColor?.(this.prevColor)
    renderer.setClearColor?.(clear.color, clear.alpha)
    renderer.setRenderTarget(this.target)
    renderer.render(this.scene, this.camera)
    renderer.setRenderTarget(null)
    renderer.setClearColor?.(this.prevColor, prevAlpha)
  }

  dispose(): void { this.target.dispose() }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm vitest run packages/render && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/render/src/surface packages/render/test/partition.test.ts packages/render/test/content.test.ts
git commit -m "feat(render): render-list partition and the orthographic content pass"
```

---

### Task 15: `Surface extends Object3D`

**Files:**
- Create: `packages/render/src/surface/surface.ts`
- Modify: `packages/render/src/index.ts`
- Test: `packages/render/test/surface.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 8–14; `createSurface`, `SurfaceModel`, `buildRenderList`, `EventDispatcher`, `PointerTracker`, `FocusManager`, `LayoutEngine`, `MeasureFn`, `AnimationRuntime`, `Theme`, `ColorScheme` from core; `TextEngine` from text.
- Produces:
  ```ts
  export interface SurfaceOptions { id?: string; width: number; height: number; ptPerUnit?: number; placement?: 'screen' | 'world'; background?: 'none' | 'glass' | string; cornerRadius?: number; interactive?: boolean; castToWorld?: boolean; contentScale?: number }
  export interface SurfaceContext { theme: Theme; scheme: ColorScheme; layout: LayoutEngine; measure: MeasureFn; anim: AnimationRuntime; text: TextEngine; pages: AtlasPages; quality: QualitySettings }
  export interface QualitySettings { contentType: 'byte' | 'half'; contentScale: number; backFaces: boolean; depthReject: boolean }  // Task 19 produces the full tiers; this is the subset Surface reads
  export class Surface extends Object3D {
    readonly model: SurfaceModel; get root(): Node
    readonly events: EventDispatcher; readonly pointer: PointerTracker; readonly focus: FocusManager
    readonly contentMesh: Mesh                       // raycast target; its uv → surface pt via `pointFromUV(u, v)`
    readonly contentPlaneZ: number                   // units: 0, or the slab thickness for a glass Surface
    interactive: boolean; castToWorld: boolean
    error: Error | null                              // set when a frame threw; the Surface stops drawing (visible = false) and emits { type: 'error', error }
    needsFrame: boolean                              // true while animating
    constructor(opts: SurfaceOptions, ctx: SurfaceContext)
    setSize(width: number, height: number): void     // pt; marks layout
    pointFromUV(u: number, v: number): [number, number]
    tick(dt: number): void                           // layout → animation → render list → batches (sets contentDirty); catches errors
    prepare(renderer: RendererLike, projectedPx: { width: number; height: number }, dpr: number): void   // RT resize + content pass when dirty
    get glassBounds(): Box3                          // Surface-local bounds (for the shadow camera fit)
    dispose(): void
  }
  ```
  Object graph (all `frustumCulled = false`, Surface-local units, Surface's own `position/quaternion/scale` place it in the world):
  - `contentMesh`: `Mesh(PlaneGeometry(1,1), MeshStandardNodeMaterial)` scaled to `(W, H, 1)` at `z = contentPlaneZ`; `colorNode = texture(content).rgb`, `opacityNode = texture(content).a`, `roughness 1`, `metalness 0`, `transparent`, `depthWrite true`, `alphaTest 0.02`, `receiveShadow true`, `castShadow false`, `toneMapped false`, `renderOrder 0`.
  - Glass: `GlassBatch` + `Mesh(batch.geometry, backMaterial)` (`renderOrder 1`, present only when `quality.backFaces`) and `Mesh(batch.geometry, frontMaterial)` (`renderOrder 2`), both `castShadow true`, `receiveShadow false`; materials from `createGlassMaterial({ backdrop: 'panel', content: contentPass.texture, surface uniforms })`.
  - Foreground: rim `DecorationBatch('rim')` mesh (`renderOrder 3`), `GlyphBatch` meshes per page (`renderOrder 4`), `ImageSet` group (`renderOrder 4`).
  - Content scene (`contentPass.scene`): panel mesh, pool mesh, content glyph meshes per page, content `ImageSet` — rendered with the ortho camera (so their instance matrices are the same Surface-local ones).
  - `background: 'glass'`: a second `GlassBatch` with one instance covering the Surface rect (`radius = cornerRadius`, params: theme defaults but `roughness 0.4`, `scatter 0.12`, `lift 0.07`, `edgeGlow 0.3`, `thickness = min(W,H)·0.05 pt`, `fillet = thickness·0.3`, `filletBottom 0`), materials `backdrop: 'screen'` (back + front, `depthReject: quality.depthReject`), `renderOrder −1`, mesh at `z = 0`; `contentPlaneZ = thickness/ppu`; the `contentMesh`, the glass meshes, the rim mesh, the foreground glyph meshes and the foreground image group all get `position.z = contentPlaneZ` (instance matrices stay plane-relative, and the glass material treats its mesh-local `z = 0` as the content plane).
  - `seenEpoch`: the atlas epoch this Surface last built its glyph batches from; when `ctx.text.atlas.epoch` differs at tick time, the text batches are rebuilt from the last partition (shared `AtlasPages` means another Surface may have consumed `sync().epochChanged`, so each Surface tracks the epoch itself).
  - `background: <colour>`: the content pass clears to it with alpha 1; `'none'` clears transparent.
  - `tick`: `if (root.dirty.layout || root.dirty.tree) layout.compute(root, W, H, measure)`; `needsFrame = anim.tick(root, dt)`; `if (root.dirty.paint) { rl = buildRenderList(model, theme, scheme); p = partition(rl); update all batches (lifts from liftFor); clear every node's dirty.paint; contentDirty = true }`; else if the atlas epoch moved since `seenEpoch`, rebuild the glyph batches from the last partition and set `contentDirty`. Any throw → `error`, `visible = false`, `dispatchEvent({ type: 'error', error })`, and `tick` returns normally.
  - `prepare`: `contentRTSize(projectedPx, dpr, { scale: quality.contentScale·contentScale })` → `contentPass.resize` (a resize also sets `contentDirty`); if `contentDirty` → `contentPass.setView(model)` and `contentPass.render(renderer, clear)`, `contentDirty = false`.
  - Pointer: `pointer = new PointerTracker(root, events, theme)`, `focus = new FocusManager(root, events)`; the touch map for press glow comes from `pointer.pressed` (press 1 while pressed) — the Surface keeps `touch: Map<Node, TouchState>` updated in `tick` from `pointer.pressed` and the last pointer position (set by `setPointer(x, y)` from the bridge, Task 18).

- [ ] **Step 1: Write the failing tests**

`packages/render/test/surface.test.ts`:

```ts
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { Mesh } from 'three'
import { Node, createYogaLayout, AnimationRuntime, defaultTheme as theme, type LayoutEngine } from '@glassui/core'
import { SystemFontEngine } from '@glassui/text'
import { Surface, type SurfaceContext } from '../src/surface/surface'
import { AtlasPages } from '../src/text/pages'
import { createMeasureFn } from '../src/text/measure'

let ctx: SurfaceContext
beforeAll(async () => {
  const text = new SystemFontEngine({ createCanvas: ((w: number, h: number) => createCanvas(w, h)) as never, pageSize: 512, maxPages: 2 })
  ctx = { theme, scheme: 'light', layout: await createYogaLayout(), measure: createMeasureFn(text, theme, 'light'), anim: new AnimationRuntime(theme, 'light'), text, pages: new AtlasPages(text.atlas), quality: { contentType: 'byte', contentScale: 1, backFaces: true, depthReject: true } }
})

function signup() {
  const s = new Surface({ id: 'f', width: 400, height: 300, ptPerUnit: 100 }, ctx)
  const card = new Node('box', 'card'); card.setStyle({ position: 'absolute', left: 20, top: 20, width: 360, height: 260, bg: 'fill', radius: 'xl' })
  const title = new Node('text', 'title'); title.setProp('value', '创建账号'); title.setStyle({ position: 'absolute', left: 20, top: 20, fontSize: 'xl' })
  const btn = new Node('glass', 'btn'); btn.setStyle({ position: 'absolute', left: 20, top: 180, width: 320, height: 48, radius: 'capsule', glass: { glow: { color: 'accent', strength: 1.1 } }, transition: { scale: 'snappy' }, pressed: { scale: 0.96 } })
  const label = new Node('text', 'label'); label.setProp('value', 'Create account'); label.setStyle({ width: '100%', height: '100%', textAlign: 'center', color: 'fill' })
  s.root.appendChild(card); card.appendChild(title); card.appendChild(btn); btn.appendChild(label)
  return { s, btn, label }
}

describe('Surface', () => {
  it('builds the object graph and fills batches on tick', () => {
    const { s } = signup()
    s.tick(1 / 60)
    expect(s.error).toBeNull()
    expect(s.contentMesh.scale.x).toBeCloseTo(4); expect(s.contentMesh.scale.y).toBeCloseTo(3)
    expect(s.glass.buffer.count).toBe(1)
    expect(s.rims.buffer.count).toBe(1); expect(s.pools.buffer.count).toBe(1); expect(s.panels.buffer.count).toBe(1)
    expect(s.foregroundText.glyphCount).toBe('Create account'.replace(/ /g, '').length)
    expect(s.contentText.glyphCount).toBe(4)
    const order = s.children.filter((c): c is Mesh => c instanceof Mesh).map(c => c.renderOrder)
    expect(order).toContain(0); expect(order).toContain(2)
    expect(s.contentDirty).toBe(true)
  })
  it('tick is idempotent when nothing changed, and animation keeps needsFrame', () => {
    const { s, btn } = signup()
    s.tick(1 / 60); s.contentDirty = false
    s.tick(1 / 60)
    expect(s.contentDirty).toBe(false); expect(s.needsFrame).toBe(false)
    btn.setState({ pressed: true }); s.tick(1 / 60)
    expect(s.needsFrame).toBe(true); expect(s.contentDirty).toBe(true)
  })
  it('prepare sizes the RT in steps and renders the content pass when dirty', () => {
    const { s } = signup()
    s.tick(1 / 60)
    const renderer = { setRenderTarget: vi.fn(), render: vi.fn(), setClearColor: vi.fn(), getClearColor: vi.fn(c => c), getClearAlpha: vi.fn(() => 1) }
    s.prepare(renderer, { width: 400, height: 300 }, 2)
    expect(s.contentPass.target.width).toBe(832); expect(s.contentPass.target.height).toBe(640)
    expect(renderer.render).toHaveBeenCalledTimes(1); expect(s.contentDirty).toBe(false)
    s.prepare(renderer, { width: 400, height: 300 }, 2)
    expect(renderer.render).toHaveBeenCalledTimes(1)
  })
  it('maps content-quad uv to surface pt', () => {
    const { s } = signup()
    expect(s.pointFromUV(0, 1)).toEqual([0, 0]); expect(s.pointFromUV(1, 0)).toEqual([400, 300]); expect(s.pointFromUV(0.5, 0.5)).toEqual([200, 150])
  })
  it('a glass background adds the surface slab and lifts the content plane', () => {
    const s = new Surface({ width: 400, height: 300, ptPerUnit: 100, background: 'glass', cornerRadius: 24 }, ctx)
    s.tick(1 / 60)
    expect(s.contentPlaneZ).toBeGreaterThan(0)
    expect(s.backgroundGlass!.buffer.count).toBe(1)
    expect(s.contentMesh.position.z).toBeCloseTo(s.contentPlaneZ)
    const lifted = s.children.filter((c): c is Mesh => c instanceof Mesh && c.renderOrder >= 0)
    expect(lifted.length).toBeGreaterThan(1); expect(lifted.every(m => Math.abs(m.position.z - s.contentPlaneZ) < 1e-9)).toBe(true)
    expect(s.children.filter((c): c is Mesh => c instanceof Mesh && c.renderOrder < 0).every(m => m.position.z === 0)).toBe(true)
  })
  it('rebuilds glyph batches when the atlas epoch moves, even if nothing else changed', () => {
    const { s } = signup()
    s.tick(1 / 60); s.contentDirty = false
    ctx.text.atlas.invalidate()
    s.tick(1 / 60)
    expect(s.contentDirty).toBe(true); expect(s.foregroundText.glyphCount).toBe(13)
  })
  it('isolates frame errors: sets error, hides, emits, does not throw', () => {
    const { s } = signup()
    const bad = new Node('box', 'bad'); bad.setStyle({ bg: 'no-such-token' }); s.root.appendChild(bad)   // throws inside buildRenderList
    const onError = vi.fn(); s.addEventListener('error', onError)
    expect(() => s.tick(1 / 60)).not.toThrow()
    expect(s.error).toBeInstanceOf(Error); expect(s.visible).toBe(false); expect(onError).toHaveBeenCalledTimes(1)
  })
  it('setSize marks layout and resizes the content quad', () => {
    const { s } = signup()
    s.tick(1 / 60); s.setSize(200, 100); s.tick(1 / 60)
    expect(s.contentMesh.scale.x).toBeCloseTo(2); expect(s.model.width).toBe(200); expect(s.root.style.width).toBe(200)
  })
})
```

(Expose `glass`, `rims`, `pools`, `panels`, `foregroundText`, `contentText`, `backgroundGlass`, `contentPass`, `contentDirty` as public readonly fields — the root and the playground HUD read them too.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/render/test/surface.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `surface/surface.ts`**

```ts
import { Box3, Color, Mesh, Object3D, PlaneGeometry, Vector2, Vector3, type Texture } from 'three'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import { texture, uniform } from 'three/tsl'
import {
  buildRenderList, createSurface, EventDispatcher, FocusManager, PointerTracker, resolveColor, GlassUIError,
  type AnimationRuntime, type ColorScheme, type GlassInstance, type LayoutEngine, type MeasureFn, type Node, type RenderList, type SurfaceModel, type Theme,
} from '@glassui/core'
import type { TextEngine } from '@glassui/text'
import { GlassBatch, type TouchState } from '../glass/batch'
import { createGlassMaterial, type GlassMaterial } from '../glass/material'
import { PanelBatch } from '../panel/batch'
import { createPanelMaterial } from '../panel/material'
import { DecorationBatch } from '../decoration/batch'
import { createPoolMaterial, createRimMaterial } from '../decoration/material'
import { GlyphBatch } from '../text/batch'
import { createGlyphMaterial } from '../text/material'
import type { AtlasPages } from '../text/pages'
import { ImageSet } from '../image/images'
import { ContentPass, contentRTSize, type RendererLike } from './content'
import { liftFor, partition, type Partition } from './partition'
import { toColor } from '../color'
import type { SurfaceDims } from '../units'

export interface SurfaceOptions { id?: string; width: number; height: number; ptPerUnit?: number; placement?: 'screen' | 'world'; background?: 'none' | 'glass' | string; cornerRadius?: number; interactive?: boolean; castToWorld?: boolean; contentScale?: number }
export interface QualitySettings { contentType: 'byte' | 'half'; contentScale: number; backFaces: boolean; depthReject: boolean }
export interface SurfaceContext { theme: Theme; scheme: ColorScheme; layout: LayoutEngine; measure: MeasureFn; anim: AnimationRuntime; text: TextEngine; pages: AtlasPages; quality: QualitySettings }

/** Spec §3.2: a content face in 3D. Draw order and layers follow the File Structure section of the plan. */
export class Surface extends Object3D {
  readonly model: SurfaceModel
  readonly events = new EventDispatcher()
  readonly pointer: PointerTracker
  readonly focus: FocusManager
  readonly contentMesh: Mesh
  readonly contentPass: ContentPass
  readonly glass = new GlassBatch()
  readonly panels = new PanelBatch()
  readonly rims = new DecorationBatch('rim')
  readonly pools = new DecorationBatch('pool')
  readonly foregroundText: GlyphBatch
  readonly contentText: GlyphBatch
  readonly foregroundImages: ImageSet
  readonly contentImages: ImageSet
  readonly backgroundGlass: GlassBatch | null = null
  readonly contentPlaneZ: number = 0
  interactive: boolean
  castToWorld: boolean
  error: Error | null = null
  needsFrame = false
  contentDirty = true
  private readonly su: { size: ReturnType<typeof uniform<Vector2>>; ptPerUnit: ReturnType<typeof uniform<number>> }
  private glassMaterials: GlassMaterial[] = []
  private glyphMeshes = new Map<GlyphBatch, Map<number, Mesh>>()
  private touch = new Map<Node, TouchState>()
  private pointerPt: [number, number] | null = null
  private lastList: RenderList | null = null
  private lastPartition: Partition | null = null
  private seenEpoch: number
  private clearColor = new Color(); private clearAlpha = 0
  private readonly contentScale: number

  constructor(opts: SurfaceOptions, private readonly ctx: SurfaceContext) {
    super()
    this.model = createSurface(opts)
    this.name = this.model.id
    this.interactive = opts.interactive ?? true
    this.castToWorld = opts.castToWorld ?? false
    this.contentScale = opts.contentScale ?? 1
    this.pointer = new PointerTracker(this.model.root, this.events, ctx.theme)
    this.focus = new FocusManager(this.model.root, this.events)
    this.su = { size: uniform(new Vector2()), ptPerUnit: uniform(this.model.ptPerUnit) }
    this.contentPass = new ContentPass({ type: ctx.quality.contentType })
    this.seenEpoch = ctx.text.atlas.epoch

    if (this.model.background === 'glass') {
      const ppu = this.model.ptPerUnit, thicknessPt = Math.min(this.model.width, this.model.height) * 0.05
      this.contentPlaneZ = thicknessPt / ppu
      this.backgroundGlass = new GlassBatch()
      for (const side of ['back', 'front'] as const) {
        const gm = createGlassMaterial({ geometry: this.backgroundGlass.geometry, K: this.backgroundGlass.K, backdrop: 'screen', side, surface: this.su, depthReject: ctx.quality.depthReject })
        const mesh = new Mesh(this.backgroundGlass.geometry, gm.material)
        mesh.frustumCulled = false; mesh.renderOrder = -1; mesh.castShadow = false; mesh.receiveShadow = false   // stays at z = 0
        this.add(mesh); this.glassMaterials.push(gm)
      }
    } else if (this.model.background !== 'none') {
      toColor(resolveColor(this.model.background, ctx.theme, ctx.scheme), this.clearColor); this.clearAlpha = 1
    }
    /** Everything drawn on the content plane sits at `contentPlaneZ`; the glass material treats mesh-local z = 0 as that plane. */
    const onPlane = <T extends Object3D>(o: T): T => { o.position.z = this.contentPlaneZ; return o }

    const cm = new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 })
    cm.colorNode = texture(this.contentPass.texture).rgb
    cm.opacityNode = texture(this.contentPass.texture).a
    cm.transparent = true; cm.depthWrite = true; cm.alphaTest = 0.02; cm.toneMapped = false
    this.contentMesh = new Mesh(new PlaneGeometry(1, 1), cm)
    this.contentMesh.receiveShadow = true; this.contentMesh.castShadow = false; this.contentMesh.renderOrder = 0; this.contentMesh.frustumCulled = false
    this.contentMesh.userData.surface = this
    this.add(onPlane(this.contentMesh))

    const glassFor = (side: 'back' | 'front', order: number) => {
      const gm = createGlassMaterial({ geometry: this.glass.geometry, K: this.glass.K, backdrop: 'panel', side, surface: this.su, content: this.contentPass.texture })
      const mesh = new Mesh(this.glass.geometry, gm.material)
      mesh.frustumCulled = false; mesh.renderOrder = order; mesh.castShadow = true; mesh.receiveShadow = false
      this.add(onPlane(mesh)); this.glassMaterials.push(gm)
    }
    if (ctx.quality.backFaces) glassFor('back', 1)
    glassFor('front', 2)

    const rimMesh = new Mesh(this.rims.geometry, createRimMaterial(this.rims.geometry, this.su)); rimMesh.renderOrder = 3; rimMesh.frustumCulled = false; this.add(onPlane(rimMesh))
    this.foregroundText = new GlyphBatch(ctx.text, ctx.pages)
    this.foregroundImages = new ImageSet(this.su); this.foregroundImages.group.renderOrder = 4; this.add(onPlane(this.foregroundImages.group))

    const panelMesh = new Mesh(this.panels.geometry, createPanelMaterial(this.panels.geometry, this.su)); panelMesh.renderOrder = 0; panelMesh.frustumCulled = false
    const poolMesh = new Mesh(this.pools.geometry, createPoolMaterial(this.pools.geometry, this.su)); poolMesh.renderOrder = 1; poolMesh.frustumCulled = false
    this.contentPass.scene.add(panelMesh, poolMesh)
    this.contentText = new GlyphBatch(ctx.text, ctx.pages)
    this.contentImages = new ImageSet(this.su); this.contentImages.group.renderOrder = 2; this.contentPass.scene.add(this.contentImages.group)

    this.applySize()
  }

  get root(): Node { return this.model.root }
  get dims(): SurfaceDims { return this.model }

  private applySize(): void {
    const w = this.model.width / this.model.ptPerUnit, h = this.model.height / this.model.ptPerUnit
    this.su.size.value.set(w, h)
    this.contentMesh.scale.set(w, h, 1)
    this.contentPass.setView(this.model)
    if (this.backgroundGlass) this.updateBackgroundGlass()
  }

  private updateBackgroundGlass(): void {
    const t = this.ctx.theme.glass, ppu = this.model.ptPerUnit, thickness = this.contentPlaneZ * ppu
    const inst: GlassInstance = {
      node: this.model.root, rect: { x: 0, y: 0, width: this.model.width, height: this.model.height }, radius: this.model.cornerRadius, z: -1,
      elevation: 0, scale: 1, transform: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, tilt: { x: 0, y: 0 }, opacity: 1,
      params: { thickness, fillet: thickness * 0.3, filletBottom: 0, profile: 'fillet', scatter: 0.12, lift: 0.07, edgeGlow: 0.3, ior: t.ior, dispersion: 0.3, roughness: 0.4, tint: null, absorption: 0, glow: null, cornerExponent: 4.5, envIntensity: 1, specularIntensity: 1, innerGlow: 0, adaptive: false, variant: 'regular' },
    }
    this.backgroundGlass!.update([inst], this.model)
  }

  setSize(width: number, height: number): void {
    this.model.width = width; this.model.height = height
    this.root.setStyle({ width, height })
    this.applySize()
    this.contentDirty = true
  }

  /** Surface pt from the content quad's hit uv (PlaneGeometry: v = 1 at the top). */
  pointFromUV(u: number, v: number): [number, number] { return [u * this.model.width, (1 - v) * this.model.height] }
  /** The bridge's last pointer position on this Surface (pt), for the press glow. */
  setPointer(pt: [number, number] | null): void { this.pointerPt = pt }

  tick(dt: number): void {
    if (this.error) return
    try {
      const root = this.root
      if (root.dirty.layout || root.dirty.tree) this.ctx.layout.compute(root, this.model.width, this.model.height, this.ctx.measure)
      this.needsFrame = this.ctx.anim.tick(root, dt)
      this.updateTouch()
      if (root.dirty.paint || this.lastList === null) {
        const rl = buildRenderList(this.model, this.ctx.theme, this.ctx.scheme)
        this.lastList = rl; this.lastPartition = partition(rl)
        this.fill(this.lastPartition)
        root.walk(n => { n.dirty.paint = false })
        this.contentDirty = true
      } else if (this.ctx.text.atlas.epoch !== this.seenEpoch && this.lastPartition) {
        this.fillText(this.lastPartition); this.contentDirty = true
      }
      this.seenEpoch = this.ctx.text.atlas.epoch
    } catch (e) {
      this.error = e instanceof Error ? e : new Error(String(e))
      this.visible = false
      this.dispatchEvent({ type: 'error', error: this.error } as never)
    }
  }

  private updateTouch(): void {
    const pressed = this.pointer.pressed
    const prev = this.touch.size
    this.touch.clear()
    if (pressed && this.pointerPt && this.lastList) {
      const g = this.lastList.glass.find(i => i.node === pressed || isAncestor(i.node, pressed))
      if (g) this.touch.set(g.node, { u: (this.pointerPt[0] - g.rect.x) / g.rect.width - 0.5, v: 0.5 - (this.pointerPt[1] - g.rect.y) / g.rect.height, press: 1 })
    }
    if (prev !== this.touch.size) this.root.markDirty('paint')
  }

  private fill(p: Partition): void {
    const s = this.model
    this.glass.update(this.lastList!.glass, s, this.touch)
    this.panels.update(p.content.panels, s)
    this.pools.update(p.content.pools, s)
    this.rims.update(p.foreground.rims, s, d => liftFor(p, d.node))
    this.fillText(p)
    this.foregroundImages.update(p.foreground.images, s, i => liftFor(p, i.node))
    this.contentImages.update(p.content.images, s)
  }

  private fillText(p: Partition): void {
    this.foregroundText.update(p.foreground.text, this.model, t => liftFor(p, t.node))
    this.contentText.update(p.content.text, this.model)
    this.syncGlyphMeshes(this.foregroundText, this, 4)
    this.syncGlyphMeshes(this.contentText, this.contentPass.scene, 2)
  }

  /** One mesh per atlas page per batch, created when a page first appears. */
  private syncGlyphMeshes(batch: GlyphBatch, parent: Object3D, renderOrder: number): void {
    let meshes = this.glyphMeshes.get(batch)
    if (!meshes) { meshes = new Map(); this.glyphMeshes.set(batch, meshes) }
    for (const [page, pb] of batch.perPage) {
      if (meshes.has(page)) continue
      const mesh = new Mesh(pb.geometry, createGlyphMaterial(pb.geometry, this.su, this.ctx.pages.textures[page]!))
      mesh.renderOrder = renderOrder; mesh.frustumCulled = false
      if (parent === this) mesh.position.z = this.contentPlaneZ          // foreground glyphs ride on the content plane
      parent.add(mesh); meshes.set(page, mesh)
    }
  }

  prepare(renderer: RendererLike, projectedPx: { width: number; height: number }, dpr: number): void {
    if (this.error) return
    try {
      const size = contentRTSize(projectedPx, dpr, { scale: this.ctx.quality.contentScale * this.contentScale })
      if (this.contentPass.resize(size.width, size.height)) this.contentDirty = true
      if (this.contentDirty) {
        this.contentPass.setView(this.model)
        this.contentPass.render(renderer, { color: this.clearColor, alpha: this.clearAlpha })
        this.contentDirty = false
      }
    } catch (e) {
      this.error = e instanceof Error ? e : new Error(String(e))
      this.visible = false
      this.dispatchEvent({ type: 'error', error: this.error } as never)
    }
  }

  /** Surface-local bounds of the content face plus the tallest glass, for the shadow-camera fit. */
  get glassBounds(): Box3 {
    const w = this.model.width / this.model.ptPerUnit, h = this.model.height / this.model.ptPerUnit
    let top = this.contentPlaneZ
    for (const g of this.lastList?.glass ?? []) top = Math.max(top, this.contentPlaneZ + (g.elevation + g.params.thickness) / this.model.ptPerUnit)
    return new Box3(new Vector3(-w / 2, -h / 2, 0), new Vector3(w / 2, h / 2, top + 0.01))
  }

  dispose(): void {
    this.ctx.layout.dispose(this.root)
    this.contentPass.dispose(); this.glass.dispose(); this.panels.dispose(); this.rims.dispose(); this.pools.dispose()
    this.foregroundText.dispose(); this.contentText.dispose(); this.foregroundImages.dispose(); this.contentImages.dispose()
    for (const gm of this.glassMaterials) gm.dispose()
    this.backgroundGlass?.dispose()
    this.removeFromParent()
  }
}

function isAncestor(a: Node, n: Node): boolean { for (let p = n.parent; p; p = p.parent) if (p === a) return true; return false }
```

Also export from `index.ts`: `export * from './surface/surface'`, `export * from './surface/partition'`, `export * from './surface/content'`, `export * from './text/measure'`, `export * from './text/pages'`, `export * from './glass/batch'`, `export * from './glass/material'`, `export * from './glass/slab9'`, `export * from './panel/batch'`, `export * from './panel/material'`, `export * from './panel/sdf'`, `export * from './decoration/batch'`, `export * from './decoration/material'`, `export * from './text/batch'`, `export * from './text/material'`, `export * from './image/images'`, `export * from './instances'`, `export * from './transform'`, `export * from './quad'`, `export * from './flat'`.

If `GlassUIError` is unused, drop the import. If `uniform<Vector2>` typing fights, type `su` as `{ size: UniformNode<Vector2>; ptPerUnit: UniformNode<number> }` from `three/webgpu`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/render && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/surface/surface.ts packages/render/src/index.ts packages/render/test/surface.test.ts
git commit -m "feat(render): Surface object — content pass, glass/panel/decoration/text/image draws, error isolation"
```

---
### Task 16: Lighting — studio environment, UI key light with VSM, shadow-camera fit

**Files:**
- Create: `packages/render/src/lighting/studio.ts`, `packages/render/src/lighting/lights.ts`
- Test: `packages/render/test/lighting.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (ported from `spikes/glass3d/studio.ts` and `main.ts`).
- Produces:
  - `export function createStudioScene(): Scene` — verbatim port: dark room box (BackSide, `0.22, 0.23, 0.26`), key softbox 7×4 ×7 at (−5, 6, 5) warm, fill 4×6 ×2.2 at (7, 2, 4) cool, strip 10×0.6 ×3 at (0, −6, 3), hot spot 1.2×0.5 ×18 at (−1, 7, 2).
  - `export function createStudioEnvironment(renderer: { isWebGPURenderer?: boolean }): Texture` — `new PMREMGenerator(renderer as never).fromScene(createStudioScene(), 0.02).texture` (browser only; not unit-tested).
  - `export const UI_ENV_INTENSITY = 0.45`, `export const UI_HEMI = { sky: 0xffffff, ground: 0x8899bb, intensity: 0.65 }`, `export const UI_KEY = { intensity: 1.8, position: [−0.9, 3.0, 5.0], shadowIntensity: 0.55, radius: 7, blurSamples: 16, bias: −0.0005 }`.
  - `export function createUILights(opts?: { shadowMap?: number }): { group: Group; hemi: HemisphereLight; key: DirectionalLight }` — key `castShadow`, `shadow.mapSize = shadowMap` (default 2048), `shadow.autoUpdate = false`, `shadow.camera` near 0.05, target at the group origin (the target is a child of the group).
  - `export function fitShadowCamera(key: DirectionalLight, boxes: readonly Box3[], margin = 0.2): boolean` — world-space boxes → the key's light space (the shadow camera's `matrixWorldInverse`, after `updateMatrixWorld`), sets `left/right/top/bottom` to the bounds ± margin and `near/far` from the depth range (near ≥ 0.05), `updateProjectionMatrix()`, `shadow.needsUpdate = true`; returns `false` and leaves the camera alone when `boxes` is empty or every box is empty.

- [ ] **Step 1: Write the failing tests**

`packages/render/test/lighting.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { BackSide, Box3, Mesh, MeshBasicMaterial, Vector3 } from 'three'
import { createStudioScene, createUILights, fitShadowCamera, UI_KEY } from '../src/lighting/lights'

describe('studio scene', () => {
  it('has a back-side room and four emitters', () => {
    const scene = createStudioScene()
    const meshes = scene.children.filter((c): c is Mesh => c instanceof Mesh)
    expect(meshes).toHaveLength(5)
    expect((meshes[0]!.material as MeshBasicMaterial).side).toBe(BackSide)
    expect(meshes.slice(1).every(m => (m.material as MeshBasicMaterial).color.r >= 1)).toBe(true)   // emitters are > 1 (HDR)
  })
})

describe('UI lights', () => {
  it('builds hemi + VSM key light with the spike budget', () => {
    const { group, hemi, key } = createUILights()
    expect(hemi.intensity).toBe(0.65); expect(key.intensity).toBe(UI_KEY.intensity)
    expect(key.castShadow).toBe(true); expect(key.shadow.mapSize.x).toBe(2048); expect(key.shadow.autoUpdate).toBe(false)
    expect(key.shadow.intensity).toBe(0.55); expect(group.children).toContain(key); expect(group.children).toContain(key.target)
    expect(createUILights({ shadowMap: 1024 }).key.shadow.mapSize.x).toBe(1024)
  })
  it('fits the shadow camera to the given world boxes', () => {
    const { group, key } = createUILights()
    group.updateMatrixWorld(true)
    const box = new Box3(new Vector3(-2, -1.5, 0), new Vector3(2, 1.5, 0.2))
    expect(fitShadowCamera(key, [box])).toBe(true)
    const cam = key.shadow.camera
    cam.updateMatrixWorld(true)
    for (const corner of [[-2, -1.5, 0], [2, 1.5, 0.2], [2, -1.5, 0], [-2, 1.5, 0.2]] as const) {
      const p = new Vector3(...corner).applyMatrix4(cam.matrixWorldInverse)
      expect(p.x).toBeGreaterThanOrEqual(cam.left); expect(p.x).toBeLessThanOrEqual(cam.right)
      expect(p.y).toBeGreaterThanOrEqual(cam.bottom); expect(p.y).toBeLessThanOrEqual(cam.top)
      expect(-p.z).toBeGreaterThanOrEqual(cam.near); expect(-p.z).toBeLessThanOrEqual(cam.far)
    }
    expect(key.shadow.needsUpdate).toBe(true)
    expect(cam.right - cam.left).toBeLessThan(8)   // tight: not the spike's fixed ±4
  })
  it('ignores empty input', () => {
    const { key } = createUILights()
    const before = key.shadow.camera.left
    expect(fitShadowCamera(key, [])).toBe(false); expect(fitShadowCamera(key, [new Box3()])).toBe(false)
    expect(key.shadow.camera.left).toBe(before)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/render/test/lighting.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`packages/render/src/lighting/studio.ts`: copy `spikes/glass3d/studio.ts` (the `createStudioScene` function and its header comment) and add:

```ts
import { PMREMGenerator } from 'three/webgpu'
import type { Texture } from 'three'

/** The PMREM of the studio scene for `scene.environment` (spec §5.3: a uniform room cannot produce the top glint). */
export function createStudioEnvironment(renderer: { isWebGPURenderer?: boolean }): Texture {
  const pmrem = new PMREMGenerator(renderer as never)
  const tex = pmrem.fromScene(createStudioScene(), 0.02).texture
  pmrem.dispose()
  return tex
}
```

`packages/render/src/lighting/lights.ts`:

```ts
import { Box3, DirectionalLight, Group, HemisphereLight, Vector3 } from 'three'
export { createStudioScene, createStudioEnvironment } from './studio'

export const UI_ENV_INTENSITY = 0.45
export const UI_HEMI = { sky: 0xffffff, ground: 0x8899bb, intensity: 0.65 } as const
export const UI_KEY = { intensity: 1.8, position: [-0.9, 3.0, 5.0] as const, shadowIntensity: 0.55, radius: 7, blurSamples: 16, bias: -0.0005 } as const

/** Spec §5.3/§5.4 light budget (≈1 without tone mapping) and the VSM key light that casts the UI's shadows. */
export function createUILights(opts: { shadowMap?: number } = {}): { group: Group; hemi: HemisphereLight; key: DirectionalLight } {
  const group = new Group(); group.name = 'ui-lights'
  const hemi = new HemisphereLight(UI_HEMI.sky, UI_HEMI.ground, UI_HEMI.intensity)
  const key = new DirectionalLight(0xffffff, UI_KEY.intensity)
  key.position.set(...UI_KEY.position)
  key.castShadow = true
  const size = opts.shadowMap ?? 2048
  key.shadow.mapSize.set(size, size)
  key.shadow.radius = UI_KEY.radius; key.shadow.blurSamples = UI_KEY.blurSamples; key.shadow.bias = UI_KEY.bias
  key.shadow.intensity = UI_KEY.shadowIntensity
  key.shadow.camera.near = 0.05; key.shadow.camera.far = 20
  key.shadow.autoUpdate = false
  group.add(hemi, key, key.target)
  return { group, hemi, key }
}

const corners = Array.from({ length: 8 }, () => new Vector3())
const lightSpace = new Box3()

/** Fits the ortho shadow camera to `boxes` (world space); returns false when there is nothing to fit. */
export function fitShadowCamera(key: DirectionalLight, boxes: readonly Box3[], margin = 0.2): boolean {
  const cam = key.shadow.camera
  key.updateMatrixWorld(true); key.target.updateMatrixWorld(true)
  cam.position.setFromMatrixPosition(key.matrixWorld)
  cam.lookAt(new Vector3().setFromMatrixPosition(key.target.matrixWorld))
  cam.updateMatrixWorld(true)
  lightSpace.makeEmpty()
  for (const b of boxes) {
    if (b.isEmpty()) continue
    let i = 0
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) lightSpace.expandByPoint(corners[i++]!.set(x, y, z).applyMatrix4(cam.matrixWorldInverse))
  }
  if (lightSpace.isEmpty()) return false
  cam.left = lightSpace.min.x - margin; cam.right = lightSpace.max.x + margin
  cam.bottom = lightSpace.min.y - margin; cam.top = lightSpace.max.y + margin
  cam.near = Math.max(0.05, -lightSpace.max.z - margin); cam.far = -lightSpace.min.z + margin
  cam.updateProjectionMatrix()
  key.shadow.needsUpdate = true
  return true
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/render && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/lighting packages/render/test/lighting.test.ts
git commit -m "feat(render): studio environment, UI hemi/key lights with VSM and shadow-camera fit"
```

---

### Task 17: Screen layer

**Files:**
- Create: `packages/render/src/surface/screen.ts`
- Test: `packages/render/test/screen.test.ts`

**Interfaces:**
- Consumes: `Surface` (Task 15).
- Produces:
  - `export function screenUnitsPerPx(camera: PerspectiveCamera | OrthographicCamera, viewportHeightPx: number, distance: number): number` — perspective: `2·distance·tan(fov/2) / height`; orthographic: `(top − bottom) / zoom / height`.
  - `export class ScreenLayer extends Group { distanceFactor = 4 (× camera.near); viewport: { width: number; height: number }; readonly surfaces: Set<Surface>; place(surface: Surface, at: { fill: true } | { left: number; top: number }): void; update(camera, viewport): void }` — `update` positions the group `distance = camera.near · distanceFactor` in front of the camera (world position + world quaternion copied from the camera), scales it by `screenUnitsPerPx`, and for every placed surface re-applies its placement: `fill` → `setSize(viewport.width, viewport.height)` and position `(0, 0, 0)`; `{left, top}` → position `(left + w/2 − vw/2, vh/2 − (top + h/2), 0)`. Screen Surfaces are created with `ptPerUnit = 1` (1 unit = 1 CSS px before the group scale), which `place` asserts.

- [ ] **Step 1: Write the failing tests**

`packages/render/test/screen.test.ts`:

```ts
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

describe('screenUnitsPerPx', () => {
  it('perspective and orthographic', () => {
    const p = new PerspectiveCamera(60, 1, 0.1, 100)
    expect(screenUnitsPerPx(p, 800, 1)).toBeCloseTo(2 * Math.tan(Math.PI / 6) / 800, 12)
    const o = new OrthographicCamera(-4, 4, 3, -3, 0.1, 100)
    expect(screenUnitsPerPx(o, 600, 1)).toBeCloseTo(6 / 600, 12)
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
  it('rejects a surface whose ptPerUnit is not 1', () => {
    const layer = new ScreenLayer()
    expect(() => layer.place(new Surface({ width: 1, height: 1, ptPerUnit: 244 }, ctx), { fill: true })).toThrow(/ptPerUnit/)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/render/test/screen.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `surface/screen.ts`**

```ts
import { Group, Quaternion, Vector3, type OrthographicCamera, type PerspectiveCamera } from 'three'
import type { Surface } from './surface'

export type ScreenPlacement = { fill: true } | { left: number; top: number }

/** World units per CSS px on a plane `distance` in front of `camera` (spec §3.1: the screen layer is pt = px). */
export function screenUnitsPerPx(camera: PerspectiveCamera | OrthographicCamera, viewportHeightPx: number, distance: number): number {
  if ((camera as PerspectiveCamera).isPerspectiveCamera) {
    const p = camera as PerspectiveCamera
    return 2 * distance * Math.tan((p.fov * Math.PI) / 360) / viewportHeightPx
  }
  const o = camera as OrthographicCamera
  return (o.top - o.bottom) / o.zoom / viewportHeightPx
}

const fwd = new Vector3(), pos = new Vector3(), q = new Quaternion()

/** A camera-facing group near the near plane; children are Surfaces with `ptPerUnit = 1`, laid out in CSS px. */
export class ScreenLayer extends Group {
  distanceFactor = 4
  viewport = { width: 1, height: 1 }
  readonly surfaces = new Set<Surface>()
  private placements = new Map<Surface, ScreenPlacement>()

  constructor() { super(); this.name = 'ui-screen' }

  place(surface: Surface, at: ScreenPlacement): void {
    if (surface.model.ptPerUnit !== 1) throw new Error(`[render] ScreenLayer: a screen Surface needs ptPerUnit 1 (got ${surface.model.ptPerUnit})`)
    this.surfaces.add(surface); this.placements.set(surface, at)
    if (surface.parent !== this) this.add(surface)
    this.apply(surface, at)
  }

  unplace(surface: Surface): void { this.surfaces.delete(surface); this.placements.delete(surface) }

  private apply(s: Surface, at: ScreenPlacement): void {
    const { width: vw, height: vh } = this.viewport
    if ('fill' in at) { if (s.model.width !== vw || s.model.height !== vh) s.setSize(vw, vh); s.position.set(0, 0, 0); return }
    s.position.set(at.left + s.model.width / 2 - vw / 2, vh / 2 - (at.top + s.model.height / 2), 0)
  }

  update(camera: PerspectiveCamera | OrthographicCamera, viewport: { width: number; height: number }): void {
    this.viewport = { width: Math.max(1, viewport.width), height: Math.max(1, viewport.height) }
    camera.updateMatrixWorld()
    const distance = camera.near * this.distanceFactor
    camera.getWorldDirection(fwd); camera.getWorldPosition(pos); camera.getWorldQuaternion(q)
    this.position.copy(pos).addScaledVector(fwd, distance)
    this.quaternion.copy(q)
    const u = screenUnitsPerPx(camera, this.viewport.height, distance)
    this.scale.setScalar(u)
    for (const [s, at] of this.placements) this.apply(s, at)
  }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/render && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/surface/screen.ts packages/render/test/screen.test.ts
git commit -m "feat(render): ScreenLayer — camera-facing px-accurate surfaces"
```

---

### Task 18: Pointer, wheel and keyboard bridge

**Files:**
- Create: `packages/render/src/pointer.ts`
- Test: `packages/render/test/pointer.test.ts`

**Interfaces:**
- Consumes: `Surface` (`contentMesh`, `pointFromUV`, `pointer`, `focus`, `events`, `interactive`, `setPointer`), `ScrollPhysics`, `Node`, `absoluteRect` from core.
- Produces:
  - `export interface SurfaceHit { surface: Surface; x: number; y: number; distance: number }`.
  - `export function hitSurfaces(raycaster: Raycaster, surfaces: readonly Surface[]): SurfaceHit | null` — nearest `contentMesh` hit among visible, interactive, error-free surfaces, converted with `pointFromUV`.
  - `export function pointOnSurfacePlane(ray: Ray, surface: Surface): [number, number] | null` — intersection of the ray with the Surface's content plane (world), as surface pt, even outside the rect (for drags that leave the quad).
  - `export function applyWheel(node: Node, deltaX: number, deltaY: number): boolean` — finds the nearest `scroll` ancestor (or self), updates `props.scrollX/scrollY` clamped to `[0, contentSize − viewport]` (content size = the max child `layout` extent), returns whether anything scrolled.
  - `export interface CanvasLike { getBoundingClientRect(): { left: number; top: number; width: number; height: number }; addEventListener(type: string, fn: (e: any) => void): void; removeEventListener(type: string, fn: (e: any) => void): void; setPointerCapture?(id: number): void; releasePointerCapture?(id: number): void; tabIndex?: number }`.
  - `export class PointerBridge { constructor(opts: { canvas: CanvasLike; camera: Camera; surfaces: () => readonly Surface[]; keyboard?: boolean }); attach(): void; detach(): void; active: Surface | null; hovered: Surface | null; handle(type: 'pointermove' | 'pointerdown' | 'pointerup' | 'pointercancel' | 'wheel' | 'keydown' | 'keyup', e: { clientX?: number; clientY?: number; pointerType?: string; pointerId?: number; deltaX?: number; deltaY?: number; key?: string; shiftKey?: boolean; preventDefault?(): void }): void }` — `handle` is the testable core; `attach` wires the DOM events to it (and `canvas.tabIndex = 0` when keyboard is on). Behaviour: move → the hit surface's `pointer.move(x, y, type)`, `setPointer`; a previously hovered surface gets `pointer.move(−1e6, −1e6)` (clears hover) when the hover moves elsewhere; down → `active = hit.surface`, `pointer.down`, `setPointerCapture`; up → on `active`, using `pointOnSurfacePlane` when the quad is missed, then `releasePointerCapture`; cancel → `active.pointer.cancel()`; wheel → `applyWheel` on the hovered node (`surface.pointer.hovered`) and dispatch `wheel` with `deltaX/deltaY` through `surface.events`, `preventDefault` when scrolled; keydown/keyup → `active?.focus.key(shiftKey && key === 'Tab' ? 'Shift+Tab' : key, type === 'keydown')`.

- [ ] **Step 1: Write the failing tests**

`packages/render/test/pointer.test.ts`:

```ts
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { PerspectiveCamera, Raycaster, Vector2 } from 'three'
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

function scene() {
  const camera = new PerspectiveCamera(50, 800 / 600, 0.1, 100); camera.updateMatrixWorld(true)
  const layer = new ScreenLayer()
  const s = new Surface({ id: 's', width: 10, height: 10, ptPerUnit: 1 }, ctx)
  layer.add(s); layer.place(s, { fill: true }); layer.update(camera, { width: 800, height: 600 }); layer.updateMatrixWorld(true)
  const btn = new Node('glass', 'btn'); btn.setStyle({ position: 'absolute', left: 100, top: 100, width: 200, height: 80 }); btn.setProp('tabIndex', 0)
  s.root.appendChild(btn); s.tick(0)
  const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), addEventListener: vi.fn(), removeEventListener: vi.fn(), setPointerCapture: vi.fn(), releasePointerCapture: vi.fn(), tabIndex: -1 }
  const bridge = new PointerBridge({ canvas, camera, surfaces: () => [s], keyboard: true })
  return { camera, s, btn, canvas, bridge }
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
    const tall = new Node('box', 'tall'); tall.setStyle({ height: 500 }); list.appendChild(tall); s.root.appendChild(list); s.tick(0)
    const onWheel = vi.fn(); s.events.on(list, 'wheel', onWheel)
    bridge.handle('pointermove', { clientX: 50, clientY: 350 })
    const prevent = vi.fn()
    bridge.handle('wheel', { clientX: 50, clientY: 350, deltaY: 120, preventDefault: prevent })
    expect(list.props.scrollY).toBe(120); expect(onWheel).toHaveBeenCalledTimes(1); expect(prevent).toHaveBeenCalled()
    bridge.handle('wheel', { clientX: 50, clientY: 350, deltaY: 10000 })
    expect(list.props.scrollY).toBe(400)
    expect(applyWheel(tall, 0, -10000)).toBe(true); expect(list.props.scrollY).toBe(0)
  })
  it('attach wires the DOM events and sets tabIndex', () => {
    const { bridge, canvas } = scene()
    bridge.attach()
    expect(canvas.tabIndex).toBe(0)
    expect(canvas.addEventListener.mock.calls.map(c => c[0]).sort()).toEqual(['keydown', 'keyup', 'pointercancel', 'pointerdown', 'pointermove', 'pointerup', 'wheel'])
    bridge.detach()
    expect(canvas.removeEventListener).toHaveBeenCalledTimes(7)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/render/test/pointer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `pointer.ts`**

```ts
import { Matrix4, Plane, Raycaster, Vector2, Vector3, type Camera, type Ray } from 'three'
import type { Node, PointerType } from '@glassui/core'
import type { Surface } from './surface/surface'

export interface SurfaceHit { surface: Surface; x: number; y: number; distance: number }

export function hitSurfaces(raycaster: Raycaster, surfaces: readonly Surface[]): SurfaceHit | null {
  const targets = surfaces.filter(s => s.visible && s.interactive && !s.error).map(s => s.contentMesh)
  const hit = raycaster.intersectObjects(targets, false)[0]
  if (!hit || !hit.uv) return null
  const surface = hit.object.userData.surface as Surface
  const [x, y] = surface.pointFromUV(hit.uv.x, hit.uv.y)
  return { surface, x, y, distance: hit.distance }
}

const plane = new Plane(), normal = new Vector3(), origin = new Vector3(), p = new Vector3(), inv = new Matrix4()

/** Where `ray` meets the Surface's content plane, as surface pt (also outside the rect; null when parallel). */
export function pointOnSurfacePlane(ray: Ray, surface: Surface): [number, number] | null {
  const mesh = surface.contentMesh
  mesh.updateMatrixWorld(true)
  origin.setFromMatrixPosition(mesh.matrixWorld)
  normal.set(0, 0, 1).transformDirection(mesh.matrixWorld)
  plane.setFromNormalAndCoplanarPoint(normal, origin)
  if (!ray.intersectPlane(plane, p)) return null
  p.applyMatrix4(inv.copy(mesh.matrixWorld).invert())      // mesh local: a unit plane scaled to W×H units
  return surface.pointFromUV(p.x + 0.5, p.y + 0.5)
}

/** Scrolls the nearest `scroll` ancestor (or `node` itself) by the wheel delta, clamped to its content; true if it moved. */
export function applyWheel(node: Node, deltaX: number, deltaY: number): boolean {
  let s: Node | null = node
  while (s && s.type !== 'scroll') s = s.parent
  if (!s) return false
  let maxX = 0, maxY = 0
  for (const c of s.children) { maxX = Math.max(maxX, c.layout.x + c.layout.width); maxY = Math.max(maxY, c.layout.y + c.layout.height) }
  const limX = Math.max(0, maxX - s.layout.width), limY = Math.max(0, maxY - s.layout.height)
  const x = Math.max(0, Math.min(limX, Number(s.props.scrollX ?? 0) + deltaX)), y = Math.max(0, Math.min(limY, Number(s.props.scrollY ?? 0) + deltaY))
  const moved = x !== Number(s.props.scrollX ?? 0) || y !== Number(s.props.scrollY ?? 0)
  if (moved) { s.setProp('scrollX', x); s.setProp('scrollY', y) }
  return moved
}

export interface CanvasLike {
  getBoundingClientRect(): { left: number; top: number; width: number; height: number }
  addEventListener(type: string, fn: (e: any) => void): void
  removeEventListener(type: string, fn: (e: any) => void): void
  setPointerCapture?(id: number): void; releasePointerCapture?(id: number): void
  tabIndex?: number
}
export interface BridgeEvent { clientX?: number; clientY?: number; pointerType?: string; pointerId?: number; deltaX?: number; deltaY?: number; key?: string; shiftKey?: boolean; preventDefault?(): void }
type BridgeType = 'pointermove' | 'pointerdown' | 'pointerup' | 'pointercancel' | 'wheel' | 'keydown' | 'keyup'
const TYPES: BridgeType[] = ['pointermove', 'pointerdown', 'pointerup', 'pointercancel', 'wheel', 'keydown', 'keyup']
const FAR = -1e6

/** Spec §7.1/§7.2: DOM pointer/wheel/keyboard on the canvas → Surface pt → core trackers (own raycast; pmndrs can replace `hitSurfaces`). */
export class PointerBridge {
  active: Surface | null = null
  hovered: Surface | null = null
  private raycaster = new Raycaster()
  private ndc = new Vector2()
  private listeners = new Map<BridgeType, (e: BridgeEvent) => void>()
  constructor(private readonly opts: { canvas: CanvasLike; camera: Camera; surfaces: () => readonly Surface[]; keyboard?: boolean }) {}

  attach(): void {
    if (this.opts.keyboard !== false) this.opts.canvas.tabIndex = 0
    for (const t of TYPES) { const fn = (e: BridgeEvent) => this.handle(t, e); this.listeners.set(t, fn); this.opts.canvas.addEventListener(t, fn) }
  }
  detach(): void { for (const [t, fn] of this.listeners) this.opts.canvas.removeEventListener(t, fn); this.listeners.clear() }

  private ray(e: BridgeEvent): SurfaceHit | null {
    const r = this.opts.canvas.getBoundingClientRect()
    this.ndc.set(((e.clientX ?? 0) - r.left) / r.width * 2 - 1, -(((e.clientY ?? 0) - r.top) / r.height) * 2 + 1)
    this.raycaster.setFromCamera(this.ndc, this.opts.camera)
    return hitSurfaces(this.raycaster, this.opts.surfaces())
  }
  private ptype(e: BridgeEvent): PointerType { const t = e.pointerType; return t === 'touch' || t === 'pen' || t === 'xr' ? t : 'mouse' }

  handle(type: BridgeType, e: BridgeEvent): void {
    switch (type) {
      case 'pointermove': {
        const hit = this.ray(e)
        if (this.hovered && this.hovered !== hit?.surface) { this.hovered.pointer.move(FAR, FAR, this.ptype(e)); this.hovered.setPointer(null) }
        this.hovered = hit?.surface ?? null
        if (hit) { hit.surface.setPointer([hit.x, hit.y]); hit.surface.pointer.move(hit.x, hit.y, this.ptype(e)) }
        else if (this.active) { const pt = pointOnSurfacePlane(this.raycaster.ray, this.active); if (pt) { this.active.setPointer(pt); this.active.pointer.move(pt[0], pt[1], this.ptype(e)) } }
        break
      }
      case 'pointerdown': {
        const hit = this.ray(e)
        if (!hit) { this.active = null; break }
        this.active = hit.surface
        hit.surface.setPointer([hit.x, hit.y]); hit.surface.pointer.down(hit.x, hit.y, this.ptype(e))
        if (e.pointerId !== undefined) this.opts.canvas.setPointerCapture?.(e.pointerId)
        break
      }
      case 'pointerup': {
        const hit = this.ray(e)
        const s = this.active
        if (s) {
          const pt = hit?.surface === s ? [hit.x, hit.y] as [number, number] : pointOnSurfacePlane(this.raycaster.ray, s) ?? [FAR, FAR] as [number, number]
          s.pointer.up(pt[0], pt[1], this.ptype(e))
        }
        if (e.pointerId !== undefined) this.opts.canvas.releasePointerCapture?.(e.pointerId)
        break
      }
      case 'pointercancel': this.active?.pointer.cancel(); break
      case 'wheel': {
        const s = this.hovered ?? this.ray(e)?.surface ?? null
        const target = s?.pointer.hovered ?? s?.root
        if (!s || !target) break
        const scrolled = applyWheel(target, e.deltaX ?? 0, e.deltaY ?? 0)
        s.events.dispatch(target, 'wheel', { deltaX: e.deltaX ?? 0, deltaY: e.deltaY ?? 0, pointerType: this.ptype(e) })
        if (scrolled) e.preventDefault?.()
        break
      }
      case 'keydown': case 'keyup': {
        const s = this.active
        if (!s || !e.key) break
        s.focus.key(e.shiftKey && e.key === 'Tab' ? 'Shift+Tab' : e.key, type === 'keydown')
        if (e.key === 'Tab') e.preventDefault?.()
        break
      }
    }
  }
}
```

(`PointerTracker.move` with a far-away point clears hover because `hitTest` returns null there; if Plan 1's tracker throws on out-of-range coordinates, add a `leave()` method to `PointerTracker` in core instead and call it — note the change in the ledger.)

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/render && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/pointer.ts packages/render/test/pointer.test.ts
git commit -m "feat(render): pointer/wheel/keyboard bridge from the canvas into Surface trackers"
```

---

### Task 19: Quality controller and frame scheduler

**Files:**
- Create: `packages/render/src/quality.ts`, `packages/render/src/scheduler.ts`
- Test: `packages/render/test/quality.test.ts`, `packages/render/test/scheduler.test.ts`

**Interfaces:**
- Consumes: `QualitySettings` (Task 15).
- Produces:
  - `export type QualityTier = 'high' | 'medium' | 'low' | 'minimal'`; `export interface QualityProfile extends QualitySettings { tier: QualityTier; shadowMap: number; blur: 'kawase' | 'mip'; refraction: boolean; dispersion: 'always' | 'auto' | 'never' }`; `export const QUALITY: Record<QualityTier, QualityProfile>` = high `{ contentType: 'half', contentScale: 1, backFaces: true, depthReject: true, shadowMap: 2048, blur: 'kawase', refraction: true, dispersion: 'always' }`, medium `{ 'byte', 0.5, false, false, 1024, 'mip', true, 'auto' }`, low `{ 'byte', 0.25, false, false, 512, 'mip', false, 'never' }`, minimal `{ 'byte', 0.25, false, false, 512, 'mip', false, 'never' }` (spec §5.6 table; analytic shadow blobs for low/minimal are deferred — see the Deferred list).
  - `export class QualityController { constructor(opts?: { initial?: QualityTier; cap?: QualityTier; reducedTransparency?: boolean; window?: number }); readonly tier: QualityTier; get profile(): QualityProfile; sample(frameMs: number): QualityTier | null; set(tier): void; setReducedTransparency(on: boolean): void; onChange(fn: (tier: QualityTier, prev: QualityTier) => void): () => void }` — hysteresis over windows of `window` frames (default 30): a window averaging > 20 ms twice in a row steps down one tier; a window averaging < 10 ms five times in a row steps up one tier, never above `cap` (default `initial`); `reducedTransparency` pins `minimal` until cleared; `sample` returns the new tier on the frame it changes, else `null`.
  - `export function defaultTier(env: { touch: boolean; reducedTransparency: boolean }): QualityTier` — `minimal` when reduced transparency, `medium` on touch devices, else `high`.
  - `export class FrameScheduler { constructor(opts?: { maxDt?: number }); readonly maxDt: number (default 1/20); dt(nowMs: number): number; reset(): void }` — first call returns 0; later calls return `min(maxDt, (now − last)/1000)`, never negative or NaN.

- [ ] **Step 1: Write the failing tests**

`packages/render/test/quality.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { QualityController, QUALITY, defaultTier } from '../src/quality'

describe('QUALITY tiers', () => {
  it('follow the spec table', () => {
    expect(QUALITY.high).toMatchObject({ contentType: 'half', contentScale: 1, backFaces: true, shadowMap: 2048, blur: 'kawase', refraction: true, dispersion: 'always' })
    expect(QUALITY.medium).toMatchObject({ contentType: 'byte', contentScale: 0.5, shadowMap: 1024, blur: 'mip', dispersion: 'auto' })
    expect(QUALITY.low).toMatchObject({ contentScale: 0.25, refraction: false })
    expect(QUALITY.minimal.refraction).toBe(false)
  })
})

describe('QualityController', () => {
  const slow = (q: QualityController, n = 30) => { let t: string | null = null; for (let i = 0; i < n; i++) t = q.sample(25) ?? t; return t }
  const fast = (q: QualityController, n = 30) => { let t: string | null = null; for (let i = 0; i < n; i++) t = q.sample(5) ?? t; return t }
  it('steps down after two slow windows, not one', () => {
    const q = new QualityController({ initial: 'high' })
    expect(slow(q)).toBeNull(); expect(q.tier).toBe('high')
    expect(slow(q)).toBe('medium'); expect(q.tier).toBe('medium')
  })
  it('steps up after five fast windows, never above the cap', () => {
    const q = new QualityController({ initial: 'medium', cap: 'medium' })
    slow(q); slow(q); expect(q.tier).toBe('low')
    for (let i = 0; i < 4; i++) expect(fast(q)).toBeNull()
    expect(fast(q)).toBe('medium')
    for (let i = 0; i < 10; i++) fast(q)
    expect(q.tier).toBe('medium')
  })
  it('reduced transparency pins minimal and notifies', () => {
    const q = new QualityController({ initial: 'high' })
    const fn = vi.fn(); q.onChange(fn)
    q.setReducedTransparency(true)
    expect(q.tier).toBe('minimal'); expect(fn).toHaveBeenCalledWith('minimal', 'high')
    for (let i = 0; i < 10; i++) fast(q)
    expect(q.tier).toBe('minimal')
    q.setReducedTransparency(false)
    expect(q.tier).toBe('high')
  })
  it('defaultTier', () => {
    expect(defaultTier({ touch: false, reducedTransparency: false })).toBe('high')
    expect(defaultTier({ touch: true, reducedTransparency: false })).toBe('medium')
    expect(defaultTier({ touch: true, reducedTransparency: true })).toBe('minimal')
  })
})
```

`packages/render/test/scheduler.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { FrameScheduler } from '../src/scheduler'

describe('FrameScheduler', () => {
  it('first dt is 0, then real time, clamped to 1/20 s', () => {
    const f = new FrameScheduler()
    expect(f.dt(1000)).toBe(0)
    expect(f.dt(1016)).toBeCloseTo(0.016)
    expect(f.dt(1016 + 5 * 60 * 1000)).toBe(1 / 20)          // tab hidden for five minutes
    expect(f.dt(1000)).toBe(0)                                  // clock went backwards
    expect(f.dt(NaN)).toBe(0)
  })
  it('reset makes the next dt 0', () => {
    const f = new FrameScheduler({ maxDt: 0.1 })
    f.dt(0); f.dt(50); f.reset()
    expect(f.dt(1000)).toBe(0); expect(f.dt(1200)).toBe(0.1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run packages/render/test/quality.test.ts packages/render/test/scheduler.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`packages/render/src/quality.ts`:

```ts
import type { QualitySettings } from './surface/surface'

export type QualityTier = 'high' | 'medium' | 'low' | 'minimal'
export interface QualityProfile extends QualitySettings { tier: QualityTier; shadowMap: number; blur: 'kawase' | 'mip'; refraction: boolean; dispersion: 'always' | 'auto' | 'never' }

/** Spec §5.6 table. */
export const QUALITY: Record<QualityTier, QualityProfile> = {
  high: { tier: 'high', contentType: 'half', contentScale: 1, backFaces: true, depthReject: true, shadowMap: 2048, blur: 'kawase', refraction: true, dispersion: 'always' },
  medium: { tier: 'medium', contentType: 'byte', contentScale: 0.5, backFaces: false, depthReject: false, shadowMap: 1024, blur: 'mip', refraction: true, dispersion: 'auto' },
  low: { tier: 'low', contentType: 'byte', contentScale: 0.25, backFaces: false, depthReject: false, shadowMap: 512, blur: 'mip', refraction: false, dispersion: 'never' },
  minimal: { tier: 'minimal', contentType: 'byte', contentScale: 0.25, backFaces: false, depthReject: false, shadowMap: 512, blur: 'mip', refraction: false, dispersion: 'never' },
}
const ORDER: QualityTier[] = ['minimal', 'low', 'medium', 'high']

export function defaultTier(env: { touch: boolean; reducedTransparency: boolean }): QualityTier {
  return env.reducedTransparency ? 'minimal' : env.touch ? 'medium' : 'high'
}

/** Frame-time hysteresis between tiers (spec §5.6): slow twice → down, fast five times → up, never above the cap. */
export class QualityController {
  tier: QualityTier
  private cap: QualityTier
  private reduced: boolean
  private window: number
  private acc = 0; private n = 0; private slow = 0; private fast = 0
  private listeners = new Set<(tier: QualityTier, prev: QualityTier) => void>()
  constructor(opts: { initial?: QualityTier; cap?: QualityTier; reducedTransparency?: boolean; window?: number } = {}) {
    this.cap = opts.cap ?? opts.initial ?? 'high'
    this.tier = opts.initial ?? this.cap
    this.reduced = opts.reducedTransparency ?? false
    this.window = opts.window ?? 30
    if (this.reduced) this.tier = 'minimal'
  }
  get profile(): QualityProfile { return QUALITY[this.tier] }
  onChange(fn: (tier: QualityTier, prev: QualityTier) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn) }

  set(tier: QualityTier): void {
    const prev = this.tier
    if (tier === prev) return
    this.tier = tier
    for (const fn of this.listeners) fn(tier, prev)
  }
  setReducedTransparency(on: boolean): void {
    this.reduced = on
    if (on) this.set('minimal'); else this.set(this.cap)
    this.slow = this.fast = 0
  }

  sample(frameMs: number): QualityTier | null {
    if (this.reduced || !(frameMs >= 0)) return null
    this.acc += frameMs; this.n++
    if (this.n < this.window) return null
    const avg = this.acc / this.n; this.acc = 0; this.n = 0
    const idx = ORDER.indexOf(this.tier)
    if (avg > 20) { this.fast = 0; if (++this.slow >= 2 && idx > 0) { this.slow = 0; this.set(ORDER[idx - 1]!); return this.tier } }
    else if (avg < 10) { this.slow = 0; if (++this.fast >= 5 && idx < ORDER.indexOf(this.cap)) { this.fast = 0; this.set(ORDER[idx + 1]!); return this.tier } }
    else { this.slow = 0; this.fast = 0 }
    return null
  }
}
```

`packages/render/src/scheduler.ts`:

```ts
/** Frame delta with a clamp (Review Focus 2: a hidden tab must not feed minutes into the springs). */
export class FrameScheduler {
  readonly maxDt: number
  private last: number | null = null
  constructor(opts: { maxDt?: number } = {}) { this.maxDt = opts.maxDt ?? 1 / 20 }
  dt(nowMs: number): number {
    if (!Number.isFinite(nowMs)) { return 0 }
    if (this.last === null) { this.last = nowMs; return 0 }
    const dt = Math.min(this.maxDt, Math.max(0, (nowMs - this.last) / 1000))
    this.last = nowMs
    return dt
  }
  reset(): void { this.last = null }
}
```

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/render && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/quality.ts packages/render/src/scheduler.ts packages/render/test/quality.test.ts packages/render/test/scheduler.test.ts
git commit -m "feat(render): quality tiers with hysteresis and the frame scheduler"
```

---

### Task 20: `createUIRoot`

**Files:**
- Create: `packages/render/src/root.ts`
- Modify: `packages/render/src/index.ts`
- Test: `packages/render/test/root.test.ts`

**Interfaces:**
- Consumes: everything above; `defaultTheme`, `createYogaLayout`, `AnimationRuntime` from core; `SystemFontEngine` from text.
- Produces:
  ```ts
  export interface UIRenderer extends RendererLike {
    domElement: CanvasLike & { width?: number; height?: number }
    getSize(target: Vector2): Vector2; getPixelRatio(): number
    shadowMap: { enabled: boolean; type: number; transmitted?: boolean }
    autoClear: boolean
    init?(): Promise<unknown>
    setAnimationLoop?(fn: ((time: number) => void) | null): void
    backend?: { isWebGPUBackend?: boolean }
    isWebGPURenderer?: boolean
  }
  export interface UIRootOptions {
    renderer: UIRenderer; scene: Scene; camera: PerspectiveCamera | OrthographicCamera
    theme?: Theme; scheme?: ColorScheme
    quality?: QualityTier | 'auto'
    text?: TextEngine; createCanvas?: CanvasFactory          // default: SystemFontEngine over document.createElement('canvas')
    environment?: 'studio' | Texture | null                   // default 'studio'; null skips PMREM (tests)
    mode?: 'overlay' | 'shared'                               // default 'overlay'
    pointer?: boolean; keyboard?: boolean                     // default true
    reducedMotion?: boolean; reducedTransparency?: boolean    // default: read matchMedia when available
  }
  export interface UIRoot {
    readonly screen: ScreenLayer; readonly world: Group; readonly uiScene: Scene
    readonly lights: ReturnType<typeof createUILights>; readonly theme: Theme; readonly scheme: ColorScheme
    readonly text: TextEngine; readonly quality: QualityController; readonly anim: AnimationRuntime
    readonly surfaces: readonly Surface[]; readonly pointer: PointerBridge | null
    readonly backend: 'webgpu' | 'webgl2' | 'unknown'
    createSurface(opts: SurfaceOptions & { layer?: 'screen' | 'world'; fill?: boolean; left?: number; top?: number }): Surface
    removeSurface(surface: Surface): void
    tick(dt: number): void
    render(): void          // overlay: host scene then UI scene (shared depth); shared: host scene only
    renderUI(): void        // UI scene only (host rendered its own scene already)
    frame(nowMs?: number): void
    autoTick(on: boolean): void
    on(type: 'quality' | 'error', fn: (e: any) => void): () => void
    dispose(): void
  }
  export async function createUIRoot(opts: UIRootOptions): Promise<UIRoot>
  ```
  Behaviour:
  - `init`: `await renderer.init?.()`; on rejection → reject with `new GlassUIError('createUIRoot', `渲染后端初始化失败（WebGPU 与 WebGL2 都不可用）：${reason}`)`. `backend` from `renderer.backend?.isWebGPUBackend`.
  - Sets `renderer.shadowMap.enabled = true`, `.type = VSMShadowMap`, `.transmitted = true`.
  - `uiScene` with `lights.group` and `environment` (studio PMREM, `environmentIntensity = UI_ENV_INTENSITY`) when `environment !== null`; `screen` and `world` groups are children of `uiScene` (overlay) or of the host `scene` (shared, where lights also go into the host scene).
  - `quality`: `'auto'` → `defaultTier({ touch: navigator.maxTouchPoints > 0, reducedTransparency })`; the controller's `onChange` re-creates every Surface's materials via `surface.setQuality(profile)` (add `setQuality` to `Surface`: rebuilds the glass materials/back mesh with the new `QualitySettings` and marks `contentDirty`; the content pass `type` changes only on the next `resize`) and emits `'quality'`; the shadow map size follows `profile.shadowMap` (`key.shadow.mapSize.set` + `key.shadow.map?.dispose(); key.shadow.map = null`).
  - Shared `SurfaceContext` for every Surface: theme/scheme, one `LayoutEngine`, one `createMeasureFn`, one `AnimationRuntime` (`reducedMotion` applied), the text engine, one `AtlasPages`, the current profile.
  - `createSurface`: `layer: 'screen'` (default) → `ptPerUnit` forced to 1 and `screen.place(s, fill ? { fill: true } : { left, top })`; `'world'` → `world.add(s)` with the given `ptPerUnit` (default 244).
  - `tick(dt)`: `screen.update(camera, renderer.getSize())`; `lights.group` follows the camera (position + quaternion) so the key light stays top-left-front of the view; for each surface: `tick(dt)`, projected px (screen: `model.width/height`; world: the content quad's four corners projected through the camera → bounding px size), `prepare(renderer, px, dpr)`; `fitShadowCamera(key, surfaces.map(s => s.glassBounds.applyMatrix4(s.matrixWorld)))` and `key.shadow.needsUpdate = true` whenever any surface rebuilt its lists this tick; errors from a surface re-emit as root `'error'` `{ surface, error }`.
  - `render()`: overlay → `renderer.autoClear = true; renderer.render(scene, camera); renderer.autoClear = false; renderer.render(uiScene, camera); renderer.autoClear = true`; shared → `renderer.render(scene, camera)`. `renderUI()` → the second half only.
  - `frame(now)`: `tick(scheduler.dt(now ?? performance.now()))`, `render()`, `quality.sample(frameMs)` (frame time measured around `render` with `performance.now()`).
  - `autoTick(on)`: `renderer.setAnimationLoop(on ? t => this.frame(t) : null)`.
  - `dispose`: pointer detach, surfaces disposed, lights/env disposed, animation loop cleared.

- [ ] **Step 1: Write the failing tests**

`packages/render/test/root.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { PerspectiveCamera, Scene, Vector2, VSMShadowMap } from 'three'
import { Node } from '@glassui/core'
import { createUIRoot, type UIRenderer } from '../src/root'

function stubRenderer(init?: () => Promise<void>): UIRenderer & { render: ReturnType<typeof vi.fn> } {
  return {
    domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), addEventListener: vi.fn(), removeEventListener: vi.fn(), tabIndex: -1 },
    getSize: (t: Vector2) => t.set(800, 600), getPixelRatio: () => 2,
    shadowMap: { enabled: false, type: 0 }, autoClear: true,
    setRenderTarget: vi.fn(), render: vi.fn(), setClearColor: vi.fn(), getClearColor: vi.fn(c => c), getClearAlpha: () => 1,
    init: init ?? (async () => {}), setAnimationLoop: vi.fn(), backend: { isWebGPUBackend: true },
  }
}
const base = () => ({ renderer: stubRenderer(), scene: new Scene(), camera: new PerspectiveCamera(50, 800 / 600, 0.1, 100), environment: null as null, createCanvas: ((w: number, h: number) => createCanvas(w, h)) as never, quality: 'medium' as const })

describe('createUIRoot', () => {
  it('initialises the renderer for transmitted VSM shadows and reports the backend', async () => {
    const o = base(); const root = await createUIRoot(o)
    expect(o.renderer.shadowMap).toMatchObject({ enabled: true, type: VSMShadowMap, transmitted: true })
    expect(root.backend).toBe('webgpu'); expect(root.quality.tier).toBe('medium')
    expect(root.uiScene.children).toContain(root.screen); expect(root.uiScene.children).toContain(root.world); expect(root.uiScene.children).toContain(root.lights.group)
    expect(o.renderer.domElement.addEventListener).toHaveBeenCalled()   // pointer bridge attached
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
    expect(w.model.ptPerUnit).toBe(244); expect(root.world.children).toContain(w)
    expect(o.renderer.render).toHaveBeenCalledTimes(2)         // two content passes
    expect(s.contentPass.target.width).toBe(1600)
    expect(root.lights.key.shadow.needsUpdate).toBe(true)
    root.render()
    expect(o.renderer.render).toHaveBeenCalledTimes(4)         // host scene + UI scene
    expect(o.renderer.render.mock.calls[2]![0]).toBe(o.scene); expect(o.renderer.render.mock.calls[3]![0]).toBe(root.uiScene)
  })
  it('shared mode puts the layers into the host scene and renders once', async () => {
    const o = { ...base(), mode: 'shared' as const }; const root = await createUIRoot(o)
    expect(o.scene.children).toContain(root.screen); expect(o.scene.children).toContain(root.lights.group)
    root.render()
    expect(o.renderer.render).toHaveBeenCalledTimes(1)
  })
  it('re-emits surface errors and changes quality on demand', async () => {
    const o = base(); const root = await createUIRoot(o)
    const s = root.createSurface({ width: 10, height: 10, fill: true })
    const bad = new Node('box'); bad.setStyle({ bg: 'nope' }); s.root.appendChild(bad)
    const onError = vi.fn(), onQuality = vi.fn()
    root.on('error', onError); root.on('quality', onQuality)
    root.tick(1 / 60)
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ surface: s }))
    root.quality.set('low')
    expect(onQuality).toHaveBeenCalledWith(expect.objectContaining({ tier: 'low' }))
    expect(root.lights.key.shadow.mapSize.x).toBe(512)
  })
  it('frame uses the scheduler and autoTick installs the loop', async () => {
    const o = base(); const root = await createUIRoot(o)
    root.frame(0); root.frame(16)
    expect(o.renderer.render).toHaveBeenCalled()
    root.autoTick(true); expect(o.renderer.setAnimationLoop).toHaveBeenCalledWith(expect.any(Function))
    root.autoTick(false); expect(o.renderer.setAnimationLoop).toHaveBeenLastCalledWith(null)
    root.dispose()
    expect(o.renderer.domElement.removeEventListener).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/render/test/root.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `root.ts`**

```ts
import { Box3, Group, Scene, Vector2, Vector3, VSMShadowMap, type OrthographicCamera, type PerspectiveCamera, type Texture } from 'three'
import { AnimationRuntime, createYogaLayout, defaultTheme, GlassUIError, type ColorScheme, type LayoutEngine, type Theme } from '@glassui/core'
import { SystemFontEngine, type CanvasFactory, type TextEngine } from '@glassui/text'
import { Surface, type SurfaceContext, type SurfaceOptions } from './surface/surface'
import { ScreenLayer } from './surface/screen'
import type { RendererLike } from './surface/content'
import { createMeasureFn } from './text/measure'
import { AtlasPages } from './text/pages'
import { createStudioEnvironment, createUILights, fitShadowCamera, UI_ENV_INTENSITY } from './lighting/lights'
import { PointerBridge, type CanvasLike } from './pointer'
import { defaultTier, QualityController, type QualityTier } from './quality'
import { FrameScheduler } from './scheduler'

export interface UIRenderer extends RendererLike {
  domElement: CanvasLike & { width?: number; height?: number }
  getSize(target: Vector2): Vector2; getPixelRatio(): number
  shadowMap: { enabled: boolean; type: number; transmitted?: boolean }
  autoClear: boolean
  init?(): Promise<unknown>
  setAnimationLoop?(fn: ((time: number) => void) | null): void
  backend?: { isWebGPUBackend?: boolean }
  isWebGPURenderer?: boolean
}
export interface UIRootOptions {
  renderer: UIRenderer; scene: Scene; camera: PerspectiveCamera | OrthographicCamera
  theme?: Theme; scheme?: ColorScheme; quality?: QualityTier | 'auto'
  text?: TextEngine; createCanvas?: CanvasFactory
  environment?: 'studio' | Texture | null; mode?: 'overlay' | 'shared'
  pointer?: boolean; keyboard?: boolean; reducedMotion?: boolean; reducedTransparency?: boolean
}
export type CreateSurfaceOptions = SurfaceOptions & { layer?: 'screen' | 'world'; fill?: boolean; left?: number; top?: number }
export interface UIRoot {
  readonly screen: ScreenLayer; readonly world: Group; readonly uiScene: Scene
  readonly lights: ReturnType<typeof createUILights>; readonly theme: Theme; readonly scheme: ColorScheme
  readonly text: TextEngine; readonly quality: QualityController; readonly anim: AnimationRuntime
  readonly surfaces: readonly Surface[]; readonly pointer: PointerBridge | null; readonly backend: 'webgpu' | 'webgl2' | 'unknown'
  createSurface(opts: CreateSurfaceOptions): Surface
  removeSurface(surface: Surface): void
  tick(dt: number): void; render(): void; renderUI(): void; frame(nowMs?: number): void; autoTick(on: boolean): void
  on(type: 'quality' | 'error', fn: (e: any) => void): () => void
  dispose(): void
}

const media = (q: string): boolean => typeof matchMedia === 'function' && matchMedia(q).matches

export async function createUIRoot(opts: UIRootOptions): Promise<UIRoot> {
  const { renderer, scene, camera } = opts
  try { await renderer.init?.() } catch (e) {
    throw new GlassUIError('createUIRoot', `渲染后端初始化失败（WebGPU 与 WebGL2 都不可用）：${e instanceof Error ? e.message : String(e)}`)
  }
  const backend: UIRoot['backend'] = renderer.backend ? (renderer.backend.isWebGPUBackend ? 'webgpu' : 'webgl2') : 'unknown'
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = VSMShadowMap; renderer.shadowMap.transmitted = true

  const theme = opts.theme ?? defaultTheme, scheme = opts.scheme ?? 'light'
  const reducedTransparency = opts.reducedTransparency ?? media('(prefers-reduced-transparency: reduce)')
  const reducedMotion = opts.reducedMotion ?? media('(prefers-reduced-motion: reduce)')
  const touch = typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0
  const initial = opts.quality && opts.quality !== 'auto' ? opts.quality : defaultTier({ touch, reducedTransparency })
  const quality = new QualityController({ initial, reducedTransparency })

  const text = opts.text ?? new SystemFontEngine({ createCanvas: opts.createCanvas ?? ((w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c as never }) })
  const layout: LayoutEngine = await createYogaLayout()
  const anim = new AnimationRuntime(theme, scheme); anim.reducedMotion = reducedMotion
  const pages = new AtlasPages(text.atlas)
  const ctx: SurfaceContext = { theme, scheme, layout, measure: createMeasureFn(text, theme, scheme), anim, text, pages, quality: quality.profile }

  const uiScene = new Scene(); uiScene.name = 'glassui'
  const mode = opts.mode ?? 'overlay'
  const host = mode === 'overlay' ? uiScene : scene
  const screen = new ScreenLayer(), world = new Group(); world.name = 'ui-world'
  const lights = createUILights({ shadowMap: quality.profile.shadowMap })
  host.add(screen, world, lights.group)
  if (opts.environment !== null) {
    const env = opts.environment === undefined || opts.environment === 'studio' ? createStudioEnvironment(renderer) : opts.environment
    uiScene.environment = env; uiScene.environmentIntensity = UI_ENV_INTENSITY
    if (mode === 'shared' && !scene.environment) { scene.environment = env; scene.environmentIntensity = UI_ENV_INTENSITY }
  }

  const surfaces: Surface[] = []
  const listeners = { quality: new Set<(e: any) => void>(), error: new Set<(e: any) => void>() }
  const emit = (type: 'quality' | 'error', e: unknown) => { for (const fn of listeners[type]) fn(e) }
  const size = new Vector2(), corner = new Vector3(), bounds = new Box3()
  const scheduler = new FrameScheduler()

  quality.onChange((tier, prev) => {
    const p = quality.profile
    ctx.quality = p
    for (const s of surfaces) s.setQuality(p)
    lights.key.shadow.mapSize.set(p.shadowMap, p.shadowMap)
    lights.key.shadow.map?.dispose(); lights.key.shadow.map = null
    emit('quality', { tier, prev, profile: p })
  })

  const projectedPx = (s: Surface): { width: number; height: number } => {
    if (s.model.placement === 'screen') return { width: s.model.width, height: s.model.height }
    const w = s.model.width / s.model.ptPerUnit, h = s.model.height / s.model.ptPerUnit
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const [x, y] of [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] as const) {
      corner.set(x, y, 0).applyMatrix4(s.matrixWorld).project(camera)
      minX = Math.min(minX, corner.x); maxX = Math.max(maxX, corner.x); minY = Math.min(minY, corner.y); maxY = Math.max(maxY, corner.y)
    }
    renderer.getSize(size)
    return { width: (maxX - minX) / 2 * size.x, height: (maxY - minY) / 2 * size.y }
  }

  const root: UIRoot = {
    screen, world, uiScene, lights, theme, scheme, text, quality, anim, surfaces, backend,
    pointer: null,
    createSurface(o) {
      const layer = o.layer ?? 'screen'
      const s = new Surface({ ...o, ptPerUnit: layer === 'screen' ? 1 : o.ptPerUnit, placement: layer }, ctx)
      s.addEventListener('error', (e: any) => emit('error', { surface: s, error: e.error }))
      if (layer === 'screen') screen.place(s, o.fill ? { fill: true } : { left: o.left ?? 0, top: o.top ?? 0 })
      else world.add(s)
      surfaces.push(s)
      return s
    },
    removeSurface(s) { const i = surfaces.indexOf(s); if (i >= 0) surfaces.splice(i, 1); screen.unplace(s); s.dispose() },
    tick(dt) {
      renderer.getSize(size)
      screen.update(camera, { width: size.x, height: size.y })
      camera.getWorldPosition(lights.group.position); camera.getWorldQuaternion(lights.group.quaternion)
      host.updateMatrixWorld(true)
      const dpr = renderer.getPixelRatio()
      let rebuilt = false
      const boxes: Box3[] = []
      for (const s of surfaces) {
        const before = s.contentDirty
        s.tick(dt)
        if (s.error) continue
        rebuilt ||= s.contentDirty && !before || s.needsFrame
        s.prepare(renderer, projectedPx(s), dpr)
        boxes.push(bounds.copy(s.glassBounds).applyMatrix4(s.matrixWorld).clone())
      }
      if (rebuilt || boxes.length !== lastBoxCount) { fitShadowCamera(lights.key, boxes); lights.key.shadow.needsUpdate = true }
      lastBoxCount = boxes.length
    },
    render() {
      if (mode === 'shared') { renderer.render(scene, camera); return }
      renderer.autoClear = true; renderer.render(scene, camera)
      root.renderUI()
    },
    renderUI() { renderer.autoClear = false; renderer.render(uiScene, camera); renderer.autoClear = true },
    frame(nowMs) {
      const now = nowMs ?? (typeof performance !== 'undefined' ? performance.now() : Date.now())
      root.tick(scheduler.dt(now))
      const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now()
      root.render()
      quality.sample((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0)
    },
    autoTick(on) { renderer.setAnimationLoop?.(on ? t => root.frame(t) : null) },
    on(type, fn) { listeners[type].add(fn); return () => listeners[type].delete(fn) },
    dispose() {
      renderer.setAnimationLoop?.(null)
      root.pointer?.detach()
      for (const s of [...surfaces]) root.removeSurface(s)
      pages.dispose(); lights.key.shadow.dispose(); (uiScene.environment as Texture | null)?.dispose()
      host.remove(screen, world, lights.group)
    },
  }
  let lastBoxCount = -1
  if (opts.pointer !== false) {
    const bridge = new PointerBridge({ canvas: renderer.domElement, camera, surfaces: () => surfaces, keyboard: opts.keyboard !== false })
    bridge.attach()
    ;(root as { pointer: PointerBridge | null }).pointer = bridge
  }
  return root
}
```

Add to `Surface` (Task 15 file): `setQuality(q: QualitySettings): void` — disposes the glass materials and meshes, re-creates them with the new `backFaces`/`depthReject` (same construction code as the constructor, factored into a private `buildGlassMeshes()`), stores `q` into the shared `ctx.quality` reference, and sets `contentDirty = true`. Export `root.ts`, `screen.ts`, `pointer.ts`, `quality.ts`, `scheduler.ts`, `lighting/lights.ts` from `index.ts`.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/render && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/root.ts packages/render/src/surface/surface.ts packages/render/src/index.ts packages/render/test/root.test.ts
git commit -m "feat(render): createUIRoot — UI scene overlay, screen/world layers, lights, pointer, quality, frame loop"
```

---
### Task 21: Playground — the sign-up form on core + render, world-layer scene, HUD (visual checkpoint 1)

**Files:**
- Create: `examples/playground/package.json`, `examples/playground/index.html`, `examples/playground/vite.config.ts`, `examples/playground/tsconfig.json`, `examples/playground/src/main.ts`, `examples/playground/src/wall.ts`, `examples/playground/src/icons.ts`, `examples/playground/src/signup.ts`, `examples/playground/src/world.ts`
- Modify: root `package.json` (`"playground": "vite examples/playground --port 5176 --strictPort --host 127.0.0.1"`, `"playground:build": "vite build examples/playground"`), `README.md`/`README.zh-CN.md` ("Try it" section: `pnpm playground`)

**Interfaces:**
- Consumes: `createUIRoot`, `Surface`, `Node`, `parseTw`, `defaultTheme`, `defaultImageLoader`.
- Produces: a Vite app at `http://127.0.0.1:5176/` with `?webgl` (force WebGL2), `?quality=high|medium|low|minimal`, `?scene=signup|world|both` (default `both`), exposing `window.__glassui = { root, ready: Promise<void>, surfaces }` for the visual harness (Task 24); HUD shows backend · fps · draw calls · quality tier · surfaces.

- [ ] **Step 1: Scaffold the app**

`examples/playground/package.json`:

```json
{ "name": "playground", "private": true, "type": "module", "dependencies": { "@glassui/core": "workspace:*", "@glassui/text": "workspace:*", "@glassui/render": "workspace:*", "three": "^0.186.1" }, "devDependencies": { "vite": "^8.3.3", "typescript": "^5.9.3", "@types/three": "^0.186.0" } }
```

`examples/playground/tsconfig.json`: `{ "extends": "../../tsconfig.base.json", "compilerOptions": { "noEmit": true, "composite": false, "declaration": false, "lib": ["ES2022", "DOM"], "types": [] }, "include": ["src"] }` and add `tsc -p examples/playground/tsconfig.json` to the root `typecheck`.

`examples/playground/index.html`: copy `spikes/glass3d/index.html`, title `GlassUI · Playground`, script `./src/main.ts`, keep `#hud.hud`.

`examples/playground/vite.config.ts`: copy `spikes/glass3d/vite.config.ts`.

Run `pnpm install`.

- [ ] **Step 2: `wall.ts` and `icons.ts`**

`wall.ts`: export `createWall(): Mesh` — the spike's `MeshStandardNodeMaterial` wall with the TSL colour blobs and the diagonal beam (`spikes/glass3d/main.ts` lines 45–67), `PlaneGeometry(16, 11)` at `z = −2.5`, `receiveShadow = false`, `castShadow = false`; plus `createHostLights(): Object3D[]` — a `HemisphereLight(0xffffff, 0x8899bb, 0.65)` and a non-shadow `DirectionalLight(0xffffff, 1.2)` at (−0.9, 3, 5) for the host scene (the UI scene has its own lights).

`icons.ts`: `export type IconName = 'check' | 'arrow-right' | 'search' | 'x' | 'user' | 'mail' | 'lock' | 'eye' | 'apple' | 'google'` and `export function iconCanvas(name: IconName, sizePx: number, color = '#1c1c22', stroke = 0.12): HTMLCanvasElement` — the drawing code of `spikes/glass3d/text.ts` `icon()` (including the Apple `Path2D` and the four-colour Google G) returning the canvas instead of a mesh; draw at 2× (`sizePx·2` canvas px) for crispness.

- [ ] **Step 3: `signup.ts` — the form in core nodes**

```ts
import { Node, parseTw, defaultTheme as theme, type Theme } from '@glassui/core'
import type { Surface, UIRoot } from '@glassui/render'
import { iconCanvas, type IconName } from './icons'

// Reference layout (docs/images/signup-front.jpg): 1024 px wide, panel 885×1045 at (512, 642); 80 pt controls.
const M = theme.metrics
const tw = (s: string) => parseTw(s, theme)
const abs = (left: number, top: number, width: number, height: number) => ({ position: 'absolute' as const, left, top, width, height })

function text(value: string, style: Parameters<Node['setStyle']>[0], id?: string): Node {
  const n = new Node('text', id); n.setProp('value', value); n.setStyle(style); return n
}
function icon(name: IconName, size: number, color?: string): Node {
  const n = new Node('image'); n.setProp('src', iconCanvas(name, size, color)); n.setStyle({ width: size, height: size }); return n
}
/** A clear glass pill with optional leading/trailing icons and a label (spec §8.2 metrics). */
function pill(left: number, top: number, width: number, height: number, opts: { label?: string; labelColor?: string; leading?: IconName; trailing?: IconName; glow?: string; strength?: number; align?: 'center' | 'start'; id?: string; tabIndex?: number }): Node {
  const n = new Node('glass', opts.id)
  n.setStyle({
    ...abs(left, top, width, height), radius: 'capsule', ...tw('flex-row items-center'), paddingX: M.controlPadding, gap: M.iconGap,
    justifyContent: opts.align === 'start' ? 'flex-start' : 'center',
    ...(opts.glow ? { glass: { glow: { color: opts.glow, strength: opts.strength ?? 1.1 } } } : {}),
    transition: { scale: 'snappy', elevation: 'snappy' }, pressed: { scale: 0.96 },
  })
  n.setProp('tabIndex', opts.tabIndex ?? 0)
  if (opts.leading) n.appendChild(icon(opts.leading, M.icon, opts.labelColor ?? '#8a8a98'))
  if (opts.label) n.appendChild(text(opts.label, { fontSize: 23, fontWeight: 600, color: opts.labelColor ?? '#1c1c22', lineHeight: 1.2 }))
  if (opts.trailing) { const spacer = new Node('box'); spacer.setStyle({ flexGrow: 1 }); n.appendChild(spacer); n.appendChild(icon(opts.trailing, M.icon, '#8a8a98')) }
  return n
}

export function buildSignup(root: UIRoot): Surface {
  const s = root.createSurface({ id: 'signup', width: 885, height: 1045, background: 'glass', cornerRadius: 48, left: 0, top: 0 })
  const r = s.root
  r.appendChild(text('Create your account', { ...abs(122 - 70, 192 - 120 - 28, 700, 56), fontSize: 44, fontWeight: 700, color: '#1c1c22' }))
  r.appendChild(text('Start your 14-day free trial. No credit card needed.', { ...abs(52, 240 - 120 - 14, 700, 32), fontSize: 22, fontWeight: 500, color: '#6a6a78' }))
  const close = pill(878 - 70 - 26, 200 - 120 - 26, 52, 52, { id: 'close' }); close.setStyle({ paddingX: 0, glass: { scatter: 0.5 } }); close.appendChild(icon('x', 24, '#4a4a58')); r.appendChild(close)
  const L = 122 - 70, W = 760
  r.appendChild(pill(L, 345 - 120 - 42, W, 84, { leading: 'user', label: 'Full name', labelColor: '#8a8a98', align: 'start', id: 'name' }))
  r.appendChild(pill(L, 455 - 120 - 42, W, 84, { leading: 'mail', label: 'Email address', labelColor: '#8a8a98', align: 'start', id: 'email' }))
  r.appendChild(pill(L, 565 - 120 - 42, W, 84, { leading: 'lock', label: 'Password', labelColor: '#8a8a98', align: 'start', trailing: 'eye', id: 'password' }))
  // terms checkbox: 44×44 clear glass button + text on the panel
  const cb = new Node('glass', 'terms'); cb.setStyle({ ...abs(L, 680 - 120 - 22, M.checkbox, M.checkbox), radius: M.checkboxRadius, ...tw('items-center justify-center'), glass: { thickness: 14, fillet: 4, filletBottom: 2 }, transition: { scale: 'snappy' }, pressed: { scale: 0.9 } })
  cb.setProp('tabIndex', 0); cb.appendChild(icon('check', 30, '#6b63f5')); r.appendChild(cb)
  r.appendChild(text('I agree to the Terms & Privacy', { ...abs(L + M.checkbox + 16, 680 - 120 - 14, 400, 30), fontSize: 21, fontWeight: 500, color: '#3a3a48' }))
  // remember-me switch, right-aligned with the inputs; glow split at the knob centre
  const knobX = M.switchWidth / 2 - M.knobMargin - M.knob / 2
  const sw = new Node('glass', 'remember'); sw.setStyle({ ...abs(L + W - M.switchWidth, 680 - 120 - M.switchHeight / 2, M.switchWidth, M.switchHeight), radius: 'capsule', glass: { glow: { color: 'accent', strength: 1.1, split: 0.5 + knobX / M.switchWidth } } })
  const knob = new Node('box'); knob.setStyle({ ...abs(M.switchWidth / 2 + knobX - M.knob / 2, M.knobMargin, M.knob, M.knob), radius: 'capsule', bg: '#ffffff' }); sw.appendChild(knob)
  sw.setProp('tabIndex', 0); r.appendChild(sw)
  r.appendChild(text('Remember me', { ...abs(L + W - M.switchWidth - 16 - 150, 680 - 120 - 14, 150, 30), fontSize: 20, fontWeight: 500, color: '#3a3a48', textAlign: 'right' }))
  // primary
  r.appendChild(pill(L, 795 - 120 - 42, W, 84, { label: 'Create account', labelColor: '#ffffff', trailing: 'arrow-right', glow: 'accent', strength: 1.15, id: 'submit' }))
  r.appendChild(text('or continue with', { ...abs(0, 878 - 120 - 14, 885, 30), fontSize: 19, fontWeight: 500, color: '#8a8a98', textAlign: 'center' }))
  r.appendChild(pill(312 - 70 - 182, 955 - 120 - 39, 365, 78, { leading: 'apple', label: 'Apple', id: 'apple' }))
  r.appendChild(pill(692 - 70 - 182, 955 - 120 - 39, 365, 78, { leading: 'google', label: 'Google', id: 'google' }))
  r.appendChild(text('Already have an account?', { ...abs(0, 1072 - 120 - 14, 885 - 80, 30), fontSize: 20, fontWeight: 500, color: '#6a6a78', textAlign: 'right' }))
  r.appendChild(text('Sign in', { ...abs(885 - 80 + 8, 1072 - 120 - 14, 70, 30), fontSize: 20, fontWeight: 700, color: '#5b52f0' }))
  wireHover(s)
  return s
}

/** Hover tilt ≤ 3° toward the pointer and a 6 pt lift (spec §8.3; components own this in Plan 3). */
function wireHover(s: Surface): void {
  s.root.walk(n => {
    if (n.type !== 'glass') return
    s.events.on(n, 'pointermove', e => { n.tilt = { x: -(e.localY / n.layout.height - 0.5) * 0.1, y: (e.localX / n.layout.width - 0.5) * 0.1 } })
    s.events.on(n, 'pointerenter', () => { n.elevation = 6 })
    s.events.on(n, 'pointerleave', () => { n.elevation = 0; n.tilt = { x: 0, y: 0 } })
  })
}
```

The y offsets subtract 120 (the panel's top in the reference) and the x offsets 70 (its left), so the numbers stay recognisably the reference's. Where a `fontSize` number is not a theme token, the schema accepts pt numbers (Plan 1). If `pointermove` events carry no `localX/localY` for the node (they are relative to `currentTarget`), use `e.x − absoluteRect(n).x`.

- [ ] **Step 4: `world.ts` and `main.ts`**

`world.ts`: `export function buildWorld(root: UIRoot): Surface` — a world Surface 600×360 pt at `ptPerUnit 244`, `background: 'glass'`, `cornerRadius 32`, positioned at `(2.2, 0.2, −1.5)` rotated `(0, −0.35, 0)`, containing a title, two pills and a switch (reuse `pill` by exporting it from `signup.ts`), so perspective, occlusion by the wall and world-layer lighting are visible.

`main.ts`:

```ts
import { Scene, PerspectiveCamera } from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { createUIRoot, type QualityTier } from '@glassui/render'
import { createWall, createHostLights } from './wall'
import { buildSignup } from './signup'
import { buildWorld } from './world'

const params = new URLSearchParams(location.search)
const forceWebGL = params.has('webgl')
const scene = params.get('scene') ?? 'both'
const renderer = new WebGPURenderer({ antialias: true, forceWebGL })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.setSize(innerWidth, innerHeight)
document.body.appendChild(renderer.domElement)

const hostScene = new Scene()
const camera = new PerspectiveCamera(38, innerWidth / innerHeight, 0.1, 50)
camera.position.set(0, 0.55, 7.3); camera.lookAt(0, -0.05, 0)
hostScene.add(createWall(), ...createHostLights())
const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true
controls.enabled = scene !== 'signup'

const ready = (async () => {
  const root = await createUIRoot({ renderer, scene: hostScene, camera, quality: (params.get('quality') as QualityTier | null) ?? 'auto' })
  const surfaces = []
  if (scene !== 'world') { const s = buildSignup(root); fit(s); surfaces.push(s); addEventListener('resize', () => fit(s)) }
  if (scene !== 'signup') surfaces.push(buildWorld(root))
  root.on('error', e => console.error('[glassui]', e.surface.name, e.error))
  const hud = document.getElementById('hud')!
  let frames = 0, acc = 0, last = performance.now()
  renderer.setAnimationLoop(t => {
    controls.update()
    root.frame(t)
    frames++; acc += (performance.now() - last) / 1000; last = performance.now()
    if (acc > 0.5) { hud.textContent = `${root.backend} · ${(frames / acc).toFixed(0)} fps · ${(renderer as any).info.render.drawCalls} draws · ${root.quality.tier} · ${surfaces.length} surfaces`; frames = 0; acc = 0 }
  })
  ;(window as any).__glassui = { root, surfaces }
  return root
  /** Keep the 885×1045 form fully visible: scale it to the viewport height and centre it. */
  function fit(s: import('@glassui/render').Surface) {
    const k = Math.min(1, (innerHeight - 40) / 1045, (innerWidth - 40) / 885)
    s.scale.setScalar(k)
    root.screen.place(s, { left: (innerWidth - 885 * k) / 2, top: (innerHeight - 1045 * k) / 2 })
  }
})()
;(window as any).__glassui = { ready }
addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight) })
```

(`ScreenLayer.apply` positions by the Surface's unscaled size; with `scale = k` the placement maths needs the scaled size — add `scale` awareness to `ScreenLayer.apply`: use `s.model.width · s.scale.x` and `s.model.height · s.scale.y`, and add a test for it in `screen.test.ts`: a surface scaled 0.5 placed at `left 20` has its scaled top-left at 20 px.)

- [ ] **Step 5: Build and typecheck**

Run: `pnpm typecheck && pnpm playground:build`
Expected: both succeed (Vite build output under `examples/playground/dist`, gitignored via the root `dist` rule).

- [ ] **Step 6: Commit**

```bash
git add examples/playground package.json pnpm-lock.yaml README.md README.zh-CN.md packages/render/src/surface/screen.ts packages/render/test/screen.test.ts
git commit -m "feat(playground): sign-up form and world-layer scene on core + render"
```

- [ ] **Step 7: Visual checkpoint 1 (controller, real browser)**

The controller runs `pnpm playground` outside the sandbox and screenshots `http://127.0.0.1:5176/?scene=signup` and `?scene=signup&webgl`, then `?scene=both`. Acceptance, against `docs/images/signup-front.jpg` and `signup-depth.jpg`:

1. Every control is a slab with visible thickness and a crisp top glint; the lower rim band and outline are present (the class-2 single-front-pass ruling holds; if the inner-edge reflection is clearly missing compared to the spike, enable `backFaces` for the class-2 batch in `high` — it is already wired — and re-check).
2. The primary button and the switch's left half glow from inside; a purple transmitted shadow lies under the primary button on the panel.
3. Labels and icons ride on top of their buttons and lift/tilt with them on hover; pressing scales to 0.96 with a fingertip glow.
4. Text is crisp at DPR 2 and Chinese renders (temporarily set a label to `创建账号` if none is Chinese).
5. WebGL2 (`?webgl`) matches WebGPU with no console errors.
6. HUD draw calls for the form ≤ 25 (content pass + 2 glass + rims + text pages + images).
7. The world Surface is occluded by the wall where it dips behind it and shows perspective; the screen form is unaffected by orbiting.

Findings go into the ledger as fix rounds against the owning tasks (geometry → 7/8, material → 9, decoration → 11, text → 12, placement → 15/17).

---

### Task 22: Dual-Kawase pyramid for the `high` tier

**Files:**
- Create: `packages/render/src/blur/kawase.ts`
- Modify: `packages/render/src/glass/material.ts` (`pyramid` option + `setPyramid`), `packages/render/src/surface/surface.ts` (build/render the pyramid when `quality.blur === 'kawase'`)
- Test: `packages/render/test/kawase.test.ts`

**Interfaces:**
- Consumes: `RendererLike`, `QuadMesh` from `three/webgpu`, `RenderTarget`.
- Produces:
  - `export class KawasePyramid { constructor(levels = 4); readonly levels: RenderTarget[]; resize(width: number, height: number): void; render(renderer: RendererLike, source: Texture): void; get textures(): Texture[]; dispose() }` — level `i` is `⌈w/2^(i+1)⌉ × ⌈h/2^(i+1)⌉` (min 1), RGBA8 linear, no mipmaps; `render` runs the down-sample chain (source → L0 → … → Ln−1) then the up-sample chain (Ln−1 → … → L0) with the dual-Kawase kernels (down: centre ×4 + 4 diagonal taps at ±half-texel; up: 4 axis taps at ±1 texel + 4 diagonal taps at ±half-texel ×2, ÷12), each a `QuadMesh` with a `MeshBasicNodeMaterial` whose `colorNode` is the TSL kernel over `uv()` with `uniform(Vector2)` texel size — so `2·levels − 1` renders per call.
  - `createGlassMaterial` gains `pyramid?: Texture[]`; when present the panel backdrop samples `mix(level⌊k⌋, level⌈k⌉, frac(k))` with `k = clamp(roughness · levels, 0, levels − 1)` over `[content, …pyramid]` instead of `.level(lod)`; `setPyramid(textures)` swaps them.
  - `Surface`: when `ctx.quality.blur === 'kawase'` the content pass is followed by `pyramid.render(renderer, contentPass.texture)` inside `prepare`, the pyramid is resized with the RT, and the glass materials get `setPyramid`.

- [ ] **Step 1: Write the failing test**

`packages/render/test/kawase.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { Texture } from 'three'
import { KawasePyramid } from '../src/blur/kawase'

describe('KawasePyramid', () => {
  it('halves each level and never reaches 0', () => {
    const p = new KawasePyramid(4)
    p.resize(300, 100)
    expect(p.levels.map(l => [l.width, l.height])).toEqual([[150, 50], [75, 25], [38, 13], [19, 7]])
    p.resize(1, 1)
    expect(p.levels.every(l => l.width === 1 && l.height === 1)).toBe(true)
  })
  it('renders down then up (2·levels − 1 passes), restoring the default target', () => {
    const p = new KawasePyramid(3); p.resize(64, 64)
    const targets: unknown[] = []
    const renderer = { setRenderTarget: vi.fn((t: unknown) => targets.push(t)), render: vi.fn() }
    p.render(renderer, new Texture())
    expect(renderer.render).toHaveBeenCalledTimes(5)
    expect(targets.slice(0, 3)).toEqual([p.levels[0], p.levels[1], p.levels[2]])
    expect(targets.slice(3, 5)).toEqual([p.levels[1], p.levels[0]])
    expect(targets[targets.length - 1]).toBeNull()
    expect(p.textures).toHaveLength(3)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/render/test/kawase.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `blur/kawase.ts`**

```ts
import { LinearFilter, LinearSRGBColorSpace, RenderTarget, RGBAFormat, Texture, UnsignedByteType, Vector2 } from 'three'
import { MeshBasicNodeMaterial, QuadMesh } from 'three/webgpu'
import { Fn, uniform, texture, uv, vec2 } from 'three/tsl'
import type { RendererLike } from '../surface/content'

/** Spec §5.6 high tier: dual-Kawase blur pyramid on plain ping-pong targets (no MRT, no compute). */
export class KawasePyramid {
  readonly levels: RenderTarget[] = []
  private down: { mesh: QuadMesh; tex: ReturnType<typeof texture>; texel: ReturnType<typeof uniform<Vector2>> }
  private up: { mesh: QuadMesh; tex: ReturnType<typeof texture>; texel: ReturnType<typeof uniform<Vector2>> }

  constructor(readonly levelCount = 4) {
    for (let i = 0; i < levelCount; i++) this.levels.push(new RenderTarget(1, 1, { format: RGBAFormat, type: UnsignedByteType, minFilter: LinearFilter, magFilter: LinearFilter, generateMipmaps: false, colorSpace: LinearSRGBColorSpace, depthBuffer: false }))
    this.down = this.pass('down'); this.up = this.pass('up')
  }

  private pass(kind: 'down' | 'up') {
    const tex = texture(new Texture()), texel = uniform(new Vector2(1, 1))
    const m = new MeshBasicNodeMaterial(); m.toneMapped = false; m.depthTest = false; m.depthWrite = false
    m.colorNode = Fn(() => {
      const p = uv(), h = texel.mul(0.5)
      const s = (dx: number, dy: number, w: number) => tex.sample(p.add(vec2(dx, dy))).rgb.mul(w)
      if (kind === 'down') {
        return tex.sample(p).rgb.mul(4).add(s(-h.x as never, -h.y as never, 1)).add(s(h.x as never, -h.y as never, 1)).add(s(-h.x as never, h.y as never, 1)).add(s(h.x as never, h.y as never, 1)).div(8)
      }
      const t = texel
      return s(-t.x as never, 0, 1).add(s(t.x as never, 0, 1)).add(s(0, -t.y as never, 1)).add(s(0, t.y as never, 1))
        .add(s(-h.x as never, -h.y as never, 2)).add(s(h.x as never, -h.y as never, 2)).add(s(-h.x as never, h.y as never, 2)).add(s(h.x as never, h.y as never, 2)).div(12)
    })()
    return { mesh: new QuadMesh(m), tex, texel }
  }

  resize(width: number, height: number): void {
    let w = width, h = height
    for (const l of this.levels) { w = Math.max(1, Math.ceil(w / 2)); h = Math.max(1, Math.ceil(h / 2)); if (l.width !== w || l.height !== h) l.setSize(w, h) }
  }

  get textures(): Texture[] { return this.levels.map(l => l.texture) }

  render(renderer: RendererLike, source: Texture): void {
    let src = source, sw = (source.image as { width?: number })?.width ?? this.levels[0]!.width * 2, sh = (source.image as { height?: number })?.height ?? this.levels[0]!.height * 2
    for (const l of this.levels) {
      this.down.tex.value = src; this.down.texel.value.set(1 / sw, 1 / sh)
      renderer.setRenderTarget(l); this.down.mesh.render(renderer as never)
      src = l.texture; sw = l.width; sh = l.height
    }
    for (let i = this.levels.length - 2; i >= 0; i--) {
      const from = this.levels[i + 1]!, to = this.levels[i]!
      this.up.tex.value = from.texture; this.up.texel.value.set(1 / from.width, 1 / from.height)
      renderer.setRenderTarget(to); this.up.mesh.render(renderer as never)
    }
    renderer.setRenderTarget(null)
  }
  dispose(): void { for (const l of this.levels) l.dispose() }
}
```

`QuadMesh.render(renderer)` calls `renderer.render(this, camera)` internally; the stub renderer in the test counts those calls. The `dx/dy` arguments are TSL nodes typed loosely (`as never`) — tidy the helper's signature to accept `number | Node` rather than casting if the types allow.

Then in `glass/material.ts` add `pyramid?: Texture[] | undefined` to the options and the `setPyramid` method; sampling helper:

```ts
const levelsTex = (o.pyramid ?? []).map(t => texture(t))
const sampleBlurred = (uvNode: ShaderNodeObject<any>) => {
  if (levelsTex.length === 0) return contentTex.sample(uvNode).level(lod).rgb
  const k = clamp(roughness.mul(levelsTex.length), 0, levelsTex.length - 1)
  let c = contentTex.sample(uvNode).rgb
  const all = [contentTex, ...levelsTex]
  for (let i = 1; i < all.length; i++) c = mix(c, all[i]!.sample(uvNode).rgb, clamp(k.sub(i - 1), 0, 1))
  return c
}
```

and use `sampleBlurred(planeUV(exit))` in the panel path. In `Surface.prepare`, when `ctx.quality.blur === 'kawase'`, keep a `KawasePyramid`, `resize` it with the content RT and `render` it after the content pass; create glass materials with `pyramid: pyramid.textures` in that case (and in `setQuality`).

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/render && pnpm typecheck`
Expected: PASS (extend `surface.test.ts` with one case: with `quality.blur = 'kawase'` the stub renderer's `render` is called `1 + (2·4 − 1) = 8` times in `prepare`; `QualitySettings` gains `blur: 'kawase' | 'mip'` so the Surface can read it; add `blur: 'mip'` to the `quality` literals in the existing `surface`, `screen` and `pointer` tests).

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/blur packages/render/src/glass/material.ts packages/render/src/surface/surface.ts packages/render/test/kawase.test.ts packages/render/test/surface.test.ts
git commit -m "feat(render): dual-Kawase pyramid for high-tier frosted sampling"
```

---

### Task 23: Adaptive luma texels for glass elements

**Files:**
- Create: `packages/render/src/luma.ts`
- Modify: `packages/render/src/glass/material.ts` (`setLuma(texture, count)`), `packages/render/src/surface/surface.ts` (run the pass in `prepare` when any glass instance has `params.adaptive`)
- Test: `packages/render/test/luma.test.ts`

**Interfaces:**
- Consumes: `RendererLike`, `QuadMesh`, `DataTexture`, `RenderTarget`.
- Produces:
  - `export class LumaPass { constructor(maxCount = 256); readonly count: number; setRects(rects: readonly { u: number; v: number; w: number; h: number }[]): void; render(renderer: RendererLike, source: Texture, dt: number): void; get texture(): Texture; dispose() }` — `rects` are the glass instances' footprints in content-RT uv (same order as the glass batch); a `DataTexture` (`maxCount × 1`, RGBA float) carries them; two `RenderTarget`s (`maxCount × 1`, RGBA8) ping-pong; the quad's fragment for texel `i` averages 9 samples of `source` over rect `i` at mip level `log2(max(w·W, h·H)) − 1` (≥ 0), computes Rec. 709 luminance, and blends with the previous value by `1 − e^(−dt/0.2)` (τ ≈ 0.2 s, spec §5.3). The first render after `setRects` writes without smoothing.
  - `createGlassMaterial` gets `setLuma(tex: Texture, count: number)` (the `lumaTex.value` and `lumaCount.value` already in Task 9); the glass batch writes the instance index into `iGlow2.w` (already done in Task 8).
  - `Surface.prepare`: when the last render list has any glass with `params.adaptive`, `luma.setRects(...)` from the glass instances (`rect` → content uv: `u = x/W`, `v = 1 − (y + h)/H`), `luma.render(renderer, contentPass.texture, dt)` after the content pass **every frame** (the backdrop can change without the Surface being dirty only through the content RT, so running it only when `contentDirty` or `needsFrame` is enough — do that), and `setLuma` on both glass materials once.

- [ ] **Step 1: Write the failing test**

`packages/render/test/luma.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { Texture } from 'three'
import { LumaPass } from '../src/luma'

describe('LumaPass', () => {
  it('packs rects into the data texture and ping-pongs targets', () => {
    const p = new LumaPass(8)
    p.setRects([{ u: 0.1, v: 0.2, w: 0.3, h: 0.4 }, { u: 0.5, v: 0.5, w: 0.1, h: 0.1 }])
    expect(p.count).toBe(2)
    const data = p.rectTexture.image.data as Float32Array
    expect(Array.from(data.slice(0, 8))).toEqual([0.1, 0.2, 0.3, 0.4, 0.5, 0.5, 0.1, 0.1])
    expect(p.rectTexture.needsUpdate || p.rectTexture.version > 0).toBe(true)
    const targets: unknown[] = []
    const renderer = { setRenderTarget: vi.fn((t: unknown) => targets.push(t)), render: vi.fn() }
    const src = new Texture()
    p.render(renderer, src, 1 / 60); const t1 = p.texture
    p.render(renderer, src, 1 / 60); const t2 = p.texture
    expect(t1).not.toBe(t2); expect(renderer.render).toHaveBeenCalledTimes(2); expect(targets[targets.length - 1]).toBeNull()
  })
  it('rejects more rects than maxCount', () => {
    const p = new LumaPass(2)
    expect(() => p.setRects([{ u: 0, v: 0, w: 1, h: 1 }, { u: 0, v: 0, w: 1, h: 1 }, { u: 0, v: 0, w: 1, h: 1 }])).toThrow(/maxCount/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run packages/render/test/luma.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `luma.ts`**

```ts
import { DataTexture, FloatType, LinearFilter, NearestFilter, RenderTarget, RGBAFormat, Texture, UnsignedByteType, Vector2 } from 'three'
import { MeshBasicNodeMaterial, QuadMesh } from 'three/webgpu'
import { Fn, uniform, texture, uv, vec2, vec3, vec4, float, dot, max, log2, exp, mix, select } from 'three/tsl'
import type { RendererLike } from './surface/content'

/** Spec §5.3 自适应亮度: one texel per glass element holding the time-smoothed mean luminance of its backdrop. */
export class LumaPass {
  readonly rectTexture: DataTexture
  count = 0
  private targets: [RenderTarget, RenderTarget]
  private current = 0
  private first = true
  private mesh: QuadMesh
  private src = texture(new Texture()); private prev = texture(new Texture())
  private blend = uniform(1); private srcSize = uniform(new Vector2(1, 1)); private texelCount = uniform(1)

  constructor(readonly maxCount = 256) {
    this.rectTexture = new DataTexture(new Float32Array(maxCount * 4), maxCount, 1, RGBAFormat, FloatType)
    this.rectTexture.minFilter = NearestFilter; this.rectTexture.magFilter = NearestFilter
    const mk = () => new RenderTarget(maxCount, 1, { format: RGBAFormat, type: UnsignedByteType, minFilter: NearestFilter, magFilter: NearestFilter, generateMipmaps: false, depthBuffer: false })
    this.targets = [mk(), mk()]
    const rects = texture(this.rectTexture)
    const m = new MeshBasicNodeMaterial(); m.toneMapped = false; m.depthTest = false; m.depthWrite = false
    m.colorNode = Fn(() => {
      const x = uv().x
      const r = rects.sample(vec2(x, 0.5))                   // u, v, w, h of this texel's element
      const lod = max(log2(max(r.z.mul(this.srcSize.x), r.w.mul(this.srcSize.y))).sub(1), 0)
      let sum = float(0)
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
        const p = vec2(r.x.add(r.z.mul((i + 0.5) / 3)), r.y.add(r.w.mul((j + 0.5) / 3)))
        sum = sum.add(dot(this.src.sample(p).level(lod).rgb, vec3(0.2126, 0.7152, 0.0722)))
      }
      const luma = sum.div(9)
      const previous = this.prev.sample(vec2(x, 0.5)).r
      return vec4(vec3(mix(previous, luma, this.blend)), 1)
    })()
    this.mesh = new QuadMesh(m)
  }

  setRects(rects: readonly { u: number; v: number; w: number; h: number }[]): void {
    if (rects.length > this.maxCount) throw new Error(`[render] LumaPass: ${rects.length} rects exceed maxCount ${this.maxCount}`)
    const d = this.rectTexture.image.data as Float32Array
    rects.forEach((r, i) => { d[i * 4] = r.u; d[i * 4 + 1] = r.v; d[i * 4 + 2] = r.w; d[i * 4 + 3] = r.h })
    this.count = rects.length; this.rectTexture.needsUpdate = true; this.first = true
  }

  get texture(): Texture { return this.targets[this.current]!.texture }

  render(renderer: RendererLike, source: Texture, dt: number): void {
    const next = 1 - this.current
    this.src.value = source; this.prev.value = this.targets[this.current]!.texture
    const img = source.image as { width?: number; height?: number } | undefined
    this.srcSize.value.set(img?.width ?? 1, img?.height ?? 1)
    this.blend.value = this.first ? 1 : 1 - Math.exp(-dt / 0.2)
    this.first = false
    renderer.setRenderTarget(this.targets[next]!); this.mesh.render(renderer as never); renderer.setRenderTarget(null)
    this.current = next
  }
  dispose(): void { this.targets[0]!.dispose(); this.targets[1]!.dispose(); this.rectTexture.dispose() }
}
```

Wire it into `Surface` as described in the interface. The glass material's adaptive darkening (`variant: 'clear'` darkens 35 % when the backdrop luma > 0.6) is already in place from Task 9 and now receives real data.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm vitest run packages/render && pnpm typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/render/src/luma.ts packages/render/src/glass/material.ts packages/render/src/surface/surface.ts packages/render/test/luma.test.ts
git commit -m "feat(render): adaptive luma texels for glass elements"
```

---

### Task 24: Visual regression harness (Playwright) — visual checkpoint 2

**Files:**
- Create: `examples/visual/package.json`, `examples/visual/playwright.config.ts`, `examples/visual/tests/visual.spec.ts`, `examples/visual/README.md`
- Modify: root `package.json` (`"test:visual": "pnpm --filter visual test"`, `"test:visual:update": "pnpm --filter visual test -- --update-snapshots"`), `.gitignore` (`examples/visual/test-results`, `examples/visual/playwright-report`)

**Interfaces:**
- Consumes: the playground (`window.__glassui.ready`, `?scene=`, `?webgl`, `?quality=`).
- Produces: `pnpm test:visual` builds the playground, serves it with `vite preview` on 127.0.0.1:5177, and compares screenshots of `signup` and `world` at `1280×900`, DPR 1, for the WebGL2 backend (`?webgl`, required) and WebGPU (skipped with a logged reason when `navigator.gpu` is missing in the test browser); `maxDiffPixelRatio 0.02`. Baselines live in `examples/visual/tests/visual.spec.ts-snapshots/` and are generated by the controller on the reference machine with `pnpm test:visual:update`.

- [ ] **Step 1: Scaffold**

`examples/visual/package.json`:

```json
{ "name": "visual", "private": true, "type": "module", "scripts": { "test": "playwright test" }, "devDependencies": { "@playwright/test": "^1.58.0", "vite": "^8.3.3" } }
```

`examples/visual/playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.02, animations: 'disabled' } },
  use: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, baseURL: 'http://127.0.0.1:5177' },
  webServer: { command: 'pnpm --filter playground exec vite build && pnpm --filter playground exec vite preview --port 5177 --strictPort --host 127.0.0.1', url: 'http://127.0.0.1:5177', reuseExistingServer: true, timeout: 120_000 },
  projects: [
    { name: 'webgl2', use: { browserName: 'chromium', launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } } },
    { name: 'webgpu', use: { browserName: 'chromium', launchOptions: { args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan'] } } },
  ],
})
```

`examples/visual/tests/visual.spec.ts`:

```ts
import { test, expect } from '@playwright/test'

const scenes = ['signup', 'world'] as const
for (const scene of scenes) {
  test(`${scene} renders the same`, async ({ page }, info) => {
    const webgl = info.project.name === 'webgl2'
    if (!webgl) {
      const hasGpu = await page.evaluate(() => 'gpu' in navigator)
      test.skip(!hasGpu, 'WebGPU not available in this browser build')
    }
    await page.goto(`/?scene=${scene}&quality=high${webgl ? '&webgl' : ''}`)
    await page.evaluate(() => (window as any).__glassui.ready)
    await page.waitForTimeout(500)          // let springs settle and the first content passes land
    const backend = await page.evaluate(() => (window as any).__glassui.ready.then((r: any) => r.backend))
    expect(backend).toBe(webgl ? 'webgl2' : 'webgpu')
    await expect(page).toHaveScreenshot(`${scene}.png`)
  })
}
```

`examples/visual/README.md`: how to run, how baselines are produced (controller machine, Chromium from `npx playwright install chromium`), what to do on a diff (open `playwright-report/`).

- [ ] **Step 2: Verify the harness is well-formed without a browser**

Run: `pnpm install && pnpm --filter visual exec playwright test --list`
Expected: lists 4 tests (2 scenes × 2 projects). If `playwright` cannot run in the sandbox (no browser binary / network), the implementer reports DONE_WITH_CONCERNS naming the exact failure; the controller runs `npx playwright install chromium` and `pnpm test:visual:update` outside the sandbox, then commits the baselines.

- [ ] **Step 3: Commit**

```bash
git add examples/visual package.json pnpm-lock.yaml .gitignore
git commit -m "test(visual): Playwright harness for signup and world scenes on both backends"
```

- [ ] **Step 4: Visual checkpoint 2 (controller)**

`pnpm test:visual:update` on the reference machine, inspect the produced PNGs against `docs/images/*.jpg`, commit `examples/visual/tests/visual.spec.ts-snapshots/*.png`; then `pnpm test:visual` must pass for `webgl2` and either pass or skip for `webgpu`.

---

### Task 25: Documentation — spec amendments, Plan 1 as-built notes, README status

**Files:**
- Modify: `docs/superpowers/specs/2026-10-07-glassui-core-design.md` (§3.1, §5.1, §5.4, §5.6, §11), `docs/superpowers/plans/2026-10-08-glassui-plan-1-foundation.md` (add an "As built" section after the header), `README.md`, `README.zh-CN.md` (status table and "Try it")

- [ ] **Step 1: Spec amendments (keep the spec the authority)**

Add to §3.1 after the code block: "`createUIRoot` 默认以 **overlay 模式** 工作：UI 有自己的 `Scene`，在宿主场景之后用同一相机、共享深度缓冲渲染（世界层 Surface 仍被宿主几何遮挡、也遮挡宿主几何），灯光与环境贴图由 UI 场景独享，因此 §5.4 的"只在 Surface 内投影"自然成立；`mode: 'shared'` 把图层挂进宿主场景（宿主灯光生效，UI 阴影可能落到宿主的 receiveShadow 物体上）。"

Add to §5.1 after item 2: "实现（Plan 2）：类 2 玻璃默认只画正面一遍，底边亮带与轮廓由装饰层提供；`high` 档可开背面遍（`backFaces`）。" and after the physicalStacking sentence: "`physicalStacking` 后置（见 §12）。"

Replace the §5.4 面板反射 sentence with: "**面板反射**：玻璃元素把反射方向镜像到面板平面下方、与面板求交后采样内容层 RT（按磨砂取模糊层级，按 Fresnel × 0.2 混入）；不再用 `reflector` 重画场景。Surface 自身的玻璃底板不再倒映控件（spike 的 reflector 路径已删除）。"

In §5.6 step 3 add: "阴影相机按可见 Surface 的包围盒拟合（`fitShadowCamera`），只在列表重建或 Surface 移动时 `needsUpdate`。" In the tier table footnote: "low/minimal 的解析阴影贴片后置，目前用 512 VSM。"

§11 Phase 2 line → "**Phase 2 · render**：…（Plan 2：`docs/superpowers/plans/2026-10-08-glassui-plan-2-render.md`）".

- [ ] **Step 2: Plan 1 as-built notes**

Insert after Plan 1's "Review Focus" section:

```markdown
## As built (deviations recorded after execution, 2026-10-08)

The merged code (`bddfd37`) differs from the task text below in three places; the code is the reference:

1. **Tab order** (Task 9): follows the DOM rule — `tabIndex > 0` ascending (ties in tree order), then `0` in tree order; negative/missing excluded. The task text's "stable sort by tabIndex then tree order" is superseded.
2. **State writes** (Tasks 3, 8, 9, 14): `node.state` is read-only; every write goes through `node.setState(partial)`, which marks `paint` (and `layout` when the toggled branch sets a layout key). Snippets that assign `state.hover = …` directly are superseded.
3. **Glass defaults** (Tasks 5, 14): `theme.glass` holds ratios `thicknessRatio 0.2`, `filletRatio 0.06`, `filletBottomRatio 0.04` (× the rect's shorter side) plus `envIntensity`, `specularIntensity`, `innerGlow`, `adaptive`, `variant`; the absolute `thickness: 16, fillet: 5, filletBottom: 3` in the task text are superseded.

Plan 2 (`2026-10-08-glassui-plan-2-render.md`, Tasks 1–5) further changes core/text: paint on tree changes, `elevation`/`tilt` accessors, `visual` values, composed `transform`/`opacity`/clip on instances, `sortKey`, transform-aware `hitTest`, `maxLines`/`wrap`, atlas `epoch`, and the `AnimationRuntime`.
```

- [ ] **Step 3: README status**

In both READMEs: Plan 1 row → "done" / "已完成"; Plan 2 row → "in progress" / "进行中"; add under "Try the spike locally": `pnpm playground      # http://127.0.0.1:5176 — the sign-up form on @glassui/core + @glassui/render` (zh: `pnpm playground      # http://127.0.0.1:5176 ，基于 @glassui/core + @glassui/render 的注册表单`); add `examples/playground/` and `packages/render/` lines to the repository layout block.

- [ ] **Step 4: Commit**

```bash
git add docs README.md README.zh-CN.md
git commit -m "docs: spec amendments for Plan 2, Plan 1 as-built notes, README status"
```

---

## Deferred (known, not blocking; recorded for Plan 3 or later)

- `physicalStacking` (glass seeing glass) — needs a re-capture of the glass pass into a second content RT per layer.
- `GlassContainer` shape fusion (spec §5.2, "Phase 2 后半") — belongs with the component in Plan 3.
- Analytic Gaussian shadow blobs for `low`/`minimal` (spec §5.6 table) — 512 VSM for now.
- Adaptive luma → text colour (spec §5.5 "颜色可读自适应亮度 texel") — needs a `color: 'auto'`/vibrancy style signal, Plan 3.
- `dispersion: 'auto'` (medium tier: only when ≥ 0.25 px) — the material always disperses; the pixel-threshold switch is a per-instance uniform for later.
- `@pmndrs/pointer-events` integration (XR rays) — `hitSurfaces` is the single seam to replace.
- `Surface.billboard`, `Surface.shadow` (spec §3.2 props) — Plan 3 with the `<Surface>` component.
- IME bridge (spec §7.3), Vue renderer, components, manifests — Plan 3.
- Press "inner glow at the fingertip" is wired (`iTouch`); hover `glint` enhancement and `focusVisible` focus ring (spec §7.2) — Plan 3 components.
- Dropping `spikes/*` from the workspace (the glyph spike pulls React) — do it when the spikes are archived.

## Self-review

**Spec coverage (Plan 2 scope):** §3.1 `UIRoot` → T20 (+T17 screen, T18 pointer/keyboard, T19 quality/scheduler); §3.2 `Surface` → T15 (size, ptPerUnit, background, cornerRadius, interactive, contentScale; billboard/shadow deferred); §4.3 colour → linear → T6; §4.4 animation runtime → T5 (+T1/T2 visual values); §5.1 three surface classes → T9 (`panel`/`screen` backdrops), T15 (class 3 background slab); §5.2 GlassSlab 9-slice instancing, fillet/lens, back→front → T7, T8, T15; §5.3 material (backdropNode, three layers, studio env, adaptive luma, press glow, depth test on/write off, light budget) → T9, T11, T16, T23; §5.4 VSM + transmitted shadows, Surface-only shadows, shadow fit, panel reflection → T9, T16, T20; §5.5 panels/text/images/decorations → T10, T12, T13, T11; §5.6 per-frame flow → T14, T15, T20; quality tiers + media queries → T19, T20; §5.7 WebGL2 parity → T21/T24 checkpoints; §7.1/§7.2 bridge → T18; §9 error isolation + init failure → T15, T20; §10 render tests → T24; carry-over seams → T1–T5. Gaps are listed under Deferred.

**Placeholder scan:** no TBD/TODO; every code step shows code; the TSL `vertex.ts` body is given in full with its fallback stated; Task 21's playground code is complete for the signup scene and names the exact functions the world scene reuses.

**Type consistency:** `InstanceTransform` fields (`elevation, scale, transform, tilt, opacity`) are used identically by T8 `instanceMatrix`, T10/T11/T12/T13 batches and T15; `ClipRect.transform` → `writeClip`; `SurfaceDims` = `{ width, height, ptPerUnit }` everywhere (`SurfaceModel` satisfies it); `QualitySettings` (T15) ⊂ `QualityProfile` (T19); `RendererLike` (T14) ⊂ `UIRenderer` (T20); `GlassMaterial.setContent/setPyramid/setLuma` names match T9/T22/T23; `sortKey` layers match the partition's content/foreground split; `VisualValues.glass` keys = `GlassNumericKey` + `glowColor`/`tint` in T1, T2 (`resolveGlass`) and T5.

**Review Focus:** 1 → T14 `contentRTSize` zero/NaN test; 2 → T19 scheduler clamp test; 3 → T5 removed-node test; 4 → T8 `InstanceBuffer` growth test and T12 glyph growth test; 5 → T4 `epoch` tests and T12 `epochChanged` test (+ T15 rebuild path).
