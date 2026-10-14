# GlassUI Plan 3 — Vue layer, components, IME, manifest

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phase 3 of the spec: a Vue 3 custom renderer (`@glassui/vue`) over the core node tree, the eleven first-phase components (Surface, Box, Text, Icon, Stack, Button, Input, Switch, Checkbox, Dialog, GlassContainer), a Chinese-capable IME bridge, a generated `manifest.json` an AI agent can write UIs from, a Vue playground, visual and performance baselines — plus the render carry-overs Plan 2's final review assigned to Plan 3's first task.

**Architecture:** `@glassui/vue` builds a `createRenderer<Node, Node>` whose `nodeOps` create and patch core `Node`s; `createGlassApp(App, { root })` binds it to a `UIRoot` from `@glassui/render`. Components are `defineGlassComponent` wrappers: a zod props schema (validated into `GlassUIError`s, exported to the manifest) around a setup that renders only the host primitives (`box`, `text`, `image`, `glass`, `scroll`, `portal`). `<Surface>` and `<Dialog>` create render Surfaces through the root and `Teleport` their slots into the Surface's root node. Text editing goes through `root.ime`, a proxy-`<textarea>` bridge positioned at the projected caret. GlassContainer fuses nearby glass shapes into one CPU-extruded slab drawn through the existing glass material on a plain-mesh vertex path.

**Tech Stack:** TypeScript 5.9 (strict), Vue 3.5.44 (`@vue/runtime-core` in the library, `vue` + `@vitejs/plugin-vue` 6.0.10 in the playground), zod 4 (`z.toJSONSchema` for the manifest), three.js r186 WebGPURenderer + TSL (render package only), yoga-layout 3, Vitest 5, Playwright 1.64.

**Spec:** `docs/superpowers/specs/2026-10-07-glassui-core-design.md` (§3, §4, §7, §8, §9, §10, §11 Phase 3, §12 "Plan 3 第一项任务"). Plan 2 (as built): `docs/superpowers/plans/2026-10-08-glassui-plan-2-render.md`.

## Global Constraints

- Work happens directly on `main` in `/Users/xichen/ThreeDUI` (no feature branches or worktrees; the project has no other collaborators). Each task ends with one or more commits on `main`; push at the end of the plan.
- Spec §2: `render` is the only package that imports `three`. `core`, `text` and the new `vue` package never import it (type-only imports of `@glassui/render` are allowed in `vue`); each keeps a `no-three.test.ts`.
- Spec §5.7 / Plan 2: all materials in TSL; no WGSL/GLSL literals, no MRT, no compute; TSL `If` only inside `Fn` (prefer JS-time branches and `select`); no `pow` with a zero base; varyings ≤ 11 per glass variant; every visual change must look the same on WebGPU and `forceWebGL`.
- Spec §8.1: `nodeOps.createElement(tag)` creates `box/text/image/glass/scroll/portal`; `createText/createComment` → `text`/`anchor`; `patchProp(el, key, prev, next)`: `on*` → events, `style`/`tw`/`class` merge into the style, everything else `setProp`; `querySelector` by id or portal name only; Vue `<Teleport>` maps onto `portal` nodes; `<Transition>` uses the §4.4 animation runtime.
- Spec §8.2 metrics (80 pt reference control): control padding 26, leading/trailing icon 28, icon–text gap 14, centred icon+text group gap 12, checkbox 44 × 44 radius 12, switch 136 × 62 with knob 48 at margin 7 (knob centre = half width − margin − knob radius); `theme.metrics` already holds these.
- Spec §8.2: every component = `defineComponent` + zod props schema → exported to `manifest.json` (name, description, props with type/default/doc, events with payload, slots, 2–3 example snippets, common mistakes). Components render only the primitives and Style; the render package is reached only through the `UIRoot` API (`root.createSurface`, `root.text`, `root.ime`, `root.anim`).
- Spec §8.3: glass only on controls (buttons, inputs, switches, dialog panels, toolbars), never on content areas; button = glow layer + clear glass shell + decoration layer; primary button glow ≈ 1.1; secondary = clear glass without glow; checkbox = 44 pt square clear glass + check; switch glow split softly at the knob; default shape capsule, panels fixed radius, nested children `radius: 'concentric'`; press `scale 0.96` with `snappy`; hover = glint up + tilt ≤ 3° (pointer devices only); appear/disappear modulates refraction and blur with scale 0.9 → 1; `prefers-reduced-transparency` → minimal; `prefers-reduced-motion` → no springs, no tilt; `prefers-contrast` → black/white solid + border.
- Spec §9: validation failures throw `GlassUIError` synchronously, message `[<Component>.<prop>] <原因>。允许值：… 你可能想要：…` (the core class already formats `allowed`/`got`); dev builds also draw an error marker in the canvas.
- Spec §7.3: IME through a transparent proxy `<textarea>` (`caret-color: transparent`, `opacity: 0.01`, `position: fixed`) placed at the projected caret rect (world layer projected too); `beforeinput/input/compositionstart/update/end/keydown/select` synced back; composition text drawn underlined in the canvas; clipboard, undo and system shortcuts come from the proxy.
- Plan 1/2 conventions: TS strict + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`; errors are `GlassUIError(scope, reason, { allowed?, got? })` (scope without brackets; the class adds them) with Chinese reasons; optional fields stay absent, never `undefined`; every package has `tsconfig.json` (src) and `tsconfig.test.json` (src + test) and is listed in the root `typecheck` script; tests live in `packages/<pkg>/test/*.test.ts` (Vitest, `environment: 'node'`).
- Commits end with the two trailer lines the session's attribution instruction names (currently `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and the `Claude-Session:` URL).
- Visual verification is done by the controller in Chrome (`pnpm playground`, 127.0.0.1:5176, run outside the sandbox) at the checkpoints named in the tasks; Playwright baselines (`examples/visual`) are generated by the controller on the reference machine; implementers verify what Node can verify (`pnpm test`, `pnpm typecheck`, `pnpm playground:build`).

## Review Focus

1. **Reactive churn.** A parent re-render patches `style`/`tw` with equal content, and `v-for` reorders keyed children: node identity, animation state and focus must survive, and an unchanged style must not mark the node dirty (Task 6 tests "equal style patch keeps the node clean" and "keyed reorder moves nodes").
2. **Unmounting live nodes.** `v-if` removes a node that is focused, pressed, hovered, mid-transition or the active IME field: focus reconciles, the press is released, the IME detaches, and the next frame has no error (Tasks 6, 7, 13 tests "remove a focused/pressed node", "leave during enter", "unmount while composing").
3. **Composition at the edge.** Composing CJK text while the Input's value overflows and the caret is at the right edge, and on a world-layer Surface tilted 30°: the field scrolls to keep the composition visible and the proxy textarea sits on the projected caret (Task 13 test "composition scrolls into view"; Task 12 test "world caret projects through the tilt").
4. **Rapid toggling.** Opening and closing a Dialog within one frame, or toggling `v-if` during an enter transition: the leave cancels the enter, `done()` runs exactly once, no Surface or node is orphaned (Task 7 test "leave cancels enter"; Task 14 test "open/close in one frame leaves no surfaces").
5. **Agent mistakes.** Unknown variant, wrong prop type, unknown prop, unknown icon name, bad `tw` class, `v-model` on the wrong prop name: a `GlassUIError` with `[Comp.prop]`, the allowed values and a suggestion, raised synchronously from render (console + canvas marker), never a silent default (Task 7 tests "unknown prop suggests", "enum value suggests"; Task 8 test "unknown icon suggests").

## File Structure

```
packages/
  core/src/
    node.ts              + focusVisible state, element handlers (setHandler), replaceStyle
    events/dispatch.ts   + handlers in dispatch, dblclick, contextmenu
    focus.ts             + focusFromPointer, focus-visible tracking
    renderlist.ts        + focus ring panel, glassContainer clusters (FusedGlassInstance)
    animation/runtime.ts + whenSettled, seed; glass.glowSplit animatable
    layout/yoga.ts       + per-root sweep of removed nodes' yoga nodes
  render/src/
    surface/surface.ts   + lazy behind-capture on 'none' Surfaces, takesPointer, worldFromPoint, billboard, trapFocus, markFailed, fused draws
    pointer.ts           + fall-through hits, focusFromPointer, contextmenu, setActive, focus trap
    root.ts              + setTheme/setScheme, contrast, afterTick, screenFromPoint, ime, guards, render isolation
    surface/screen.ts    + { center: true } placement
    glass/fused.ts       NEW: smooth-union outline + extrusion (CPU)
    glass/vertex.ts      + meshVertex (plain-mesh path)
    glass/material.ts    + `vertex: 'slab9' | 'mesh'`
    ime.ts               NEW: ImeBridge (proxy textarea)
    index.ts / internal.ts   public API vs internals (`@glassui/render/internal`)
  vue/                   NEW package @glassui/vue
    src/renderer.ts      nodeOps + createGlassRenderer
    src/app.ts           createGlassApp, mount, parent sharing, error marker
    src/define.ts        defineGlassComponent, registry, prop validation
    src/inject.ts        useRoot, useSurface, useTheme (reactive scheme)
    src/transition.ts    GlassTransition (BaseTransition + AnimationRuntime)
    src/control.ts       useGlassControl (hover/tilt/press/keyboard/focus)
    src/icons.ts         built-in icon set (canvas paths)
    src/components/*.ts  Box, Text, Icon, Stack, Surface, Button, Switch, Checkbox, Input, Dialog, GlassContainer
    src/manifest.ts      generateManifest()
    manifest.json        generated, committed
examples/
  playground/            Vue app: signup.vue, world.vue, gallery.vue, perf.vue, agent/ (acceptance)
  visual/                + gallery/state/tier/IME/perf specs
```

---
### Task 1: Glass over transparent content on default Surfaces; pointers fall through empty Surfaces (Plan 2 I7)

**Files:**
- Modify: `packages/render/src/surface/surface.ts` (lazy behind-capture for `'none'` Surfaces, `takesPointer`)
- Modify: `packages/render/src/pointer.ts` (`hitSurfaces` falls through Surfaces that take no pointer there)
- Modify: `packages/render/src/luma.ts` only if `SurfaceLuma.update` needs the new capture passed in (it takes the glass Surface's capture today; pass the behind-capture the same way)
- Test: `packages/render/test/surface.test.ts`, `packages/render/test/pointer.test.ts`

**Interfaces:**
- Consumes: `ScreenCapture` (`glass/material.ts`), `createGlassMaterial` options `screen`/`screenLevel`/`screenLift` (the "behind" sample), `hitTest`, `effectiveStyle` (`@glassui/core`), `SURFACE_ORDER`.
- Produces:
  - `Surface.takesPointer(x: number, y: number): boolean` — true when the Surface's background is `'glass'` or a colour, or a node other than a bare root is hit at (x, y) Surface pt. A bare root is the root node with no effective `bg` (or `'none'`), no `border`, and `type !== 'glass'`.
  - `Surface.hitNode(x: number, y: number): Node | null` — `hitTest(this.root, x, y, theme)`.
  - `hitSurfaces(raycaster, surfaces)` keeps its signature; it now returns the nearest hit (coplanar ties by `drawOrder`, highest first) whose Surface `takesPointer` at the hit point, or null.
  - A `'none'` Surface with glass instances (and a glass mode other than `'fill'`) owns `behindCapture: ScreenCapture` and a `captureProbe` mesh at `SURFACE_ORDER.slab`; element glass samples it through the existing behind path with `screenLevel: 0`, `screenLift: 0` (no frost on a `'none'` Surface). Without glass, both are dropped and no draw references a capture.

The probe exists because three copies the framebuffer at the first draw of a frame that samples a `ViewportTextureNode`; on a `'glass'` Surface that draw is the background slab, which is the Surface's first draw. A `'none'` Surface has no slab, so its first sampling draw would be the element glass, after the content quad: the copy would already contain this Surface's own content, and the "behind" sample would double-count it (the bug Plan 2's Task 21 review found). The probe draws nothing (`colorWrite = false`) but samples the capture, at `SURFACE_ORDER.slab`, so the copy happens before the content quad.

- [ ] **Step 1: Write the failing Surface tests**

In `packages/render/test/surface.test.ts`, replace the test `"a 'none' Surface takes no capture: its element glass refracts the content RT alone"` with:

```ts
const CAPTURES = ['ViewportTextureNode', 'ViewportDepthTextureNode']
const capturesIn = (ms: Mesh[]) => ms.flatMap(m => materialGraph(m.material as Material)).filter(n => CAPTURES.includes(n.constructor.type!))
const probeOf = (s: Surface) => meshes(s).filter(m => m.renderOrder === SURFACE_ORDER.slab)

it("a 'none' Surface without glass takes no capture", () => {
  const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, { ...ctx })
  const card = new Node('box'); card.setStyle({ position: 'absolute', left: 0, top: 0, width: 100, height: 100, bg: 'fill' })
  s.root.appendChild(card); s.tick(0)
  expect(capturesIn([...meshes(s), ...meshes(s.contentPass.scene)])).toEqual([])
  expect(probeOf(s)).toEqual([])
})

it("a 'none' Surface with glass captures what is behind it before its content quad, and drops the capture with the glass", () => {
  const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, { ...ctx })
  const g = new Node('glass', 'g'); g.setStyle({ position: 'absolute', left: 20, top: 20, width: 200, height: 60, radius: 'capsule' })
  s.root.appendChild(g); s.tick(0)
  const probe = probeOf(s)
  expect(probe).toHaveLength(1)
  expect(probe[0]!.renderOrder).toBeLessThan(SURFACE_ORDER.content)
  const base = (ms: Mesh[]) => new Set(ms.flatMap(m => materialGraph(m.material as Material)).filter(n => n.constructor.type === 'ViewportTextureNode').map(n => n.getBase!()))
  const probeBase = base(probe)
  expect(probeBase.size).toBe(1)
  expect(base(elementGlass(s))).toEqual(probeBase)                     // element glass reads the probe's copy: one copy
  g.remove(); s.tick(0)
  expect(probeOf(s)).toEqual([])
  expect(capturesIn([...meshes(s), ...meshes(s.contentPass.scene)])).toEqual([])
})

it("a 'none' Surface in the 'fill' glass mode takes no capture even with glass", () => {
  const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, { ...ctx, quality: QUALITY.minimal })
  const g = new Node('glass'); g.setStyle({ position: 'absolute', left: 20, top: 20, width: 200, height: 60 })
  s.root.appendChild(g); s.tick(0)
  expect(probeOf(s)).toEqual([])
  expect(capturesIn(meshes(s))).toEqual([])
})

it('the probe builds on both backends and copies the framebuffer', () => {
  const s = new Surface({ width: 400, height: 300, ptPerUnit: 100 }, { ...ctx })
  const g = new Node('glass'); g.setStyle({ position: 'absolute', left: 20, top: 20, width: 200, height: 60 })
  s.root.appendChild(g); s.tick(0)
  for (const forceWebGL of [false, true]) {
    const probe = probeOf(s)[0]!
    expect(buildShaders(probe.material as never, probe.geometry, forceWebGL).updateBefore.length).toBeGreaterThan(0)
  }
})

it('takesPointer: a bare root takes nothing, a hit node, a coloured root or a glass background takes the pointer', () => {
  const s = new Surface({ width: 400, height: 300, ptPerUnit: 1 }, { ...ctx })
  const b = new Node('box'); b.setStyle({ position: 'absolute', left: 10, top: 10, width: 50, height: 50, bg: 'fill' })
  s.root.appendChild(b); s.tick(0)
  expect(s.takesPointer(20, 20)).toBe(true)
  expect(s.takesPointer(300, 200)).toBe(false)
  s.root.setStyle({ bg: '#00000040' }); s.tick(0)
  expect(s.takesPointer(300, 200)).toBe(true)
  const glass = new Surface({ width: 400, height: 300, ptPerUnit: 1, background: 'glass' }, { ...ctx }); glass.tick(0)
  expect(glass.takesPointer(300, 200)).toBe(true)
})
```

- [ ] **Step 2: Write the failing pointer test**

In `packages/render/test/pointer.test.ts`, add to `describe('hitSurfaces', …)` (reusing `two()`, where `a` fills the viewport and `b` draws above it at 400, 300):

```ts
it('falls through a Surface that takes no pointer at the hit point', () => {
  const { a, b, rc } = two()
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
```

If `two()` does not return a raycaster already, give it one and an `aimAt(rc, px, py)` helper that sets `rc` from the camera at canvas px (800 × 600) — the existing tests build the same ray inline.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run packages/render/test/surface.test.ts packages/render/test/pointer.test.ts`
Expected: FAIL — `takesPointer` is not a function; no probe mesh; `hitSurfaces` returns `b`.

- [ ] **Step 4: Implement the behind-capture**

In `surface.ts`:

```ts
import { MeshBasicNodeMaterial } from 'three/webgpu'
import { float, screenUV } from 'three/tsl'
import { hitTest, effectiveStyle } from '@glassui/core'

/** The draw that makes a 'none' Surface's behind-capture copy the framebuffer before its content quad. */
function createCaptureProbe(capture: ScreenCapture): Mesh {
  const m = new MeshBasicNodeMaterial()
  m.colorNode = capture.sample(screenUV).rgb     // sampling is what schedules the copy (updateBefore)
  m.opacityNode = float(0)
  m.colorWrite = false; m.depthWrite = false; m.depthTest = false; m.transparent = true; m.toneMapped = false
  const probe = new Mesh(new PlaneGeometry(1e-3, 1e-3), m)
  probe.renderOrder = SURFACE_ORDER.slab; probe.frustumCulled = false
  probe.name = 'capture-probe'
  return probe
}
```

Fields: `private behindCapture: ScreenCapture | null = null`, `private captureProbe: Mesh | null = null`.

Method, called from `tick` after the render list is partitioned (where the glass batch is updated), and from `setQuality` before `buildGlass`:

```ts
/**
 * A 'none' Surface's capture of what is behind it: made while it has glass to show it through (and the glass mode
 * samples a backdrop), dropped when not. True when it appeared or went away (the glass materials must be rebuilt).
 */
private syncBehind(wanted: boolean): boolean {
  if (this.model.background !== 'none') return false
  if (wanted === (this.behindCapture !== null)) return false
  if (wanted) {
    this.behindCapture = new ScreenCapture()
    this.captureProbe = createCaptureProbe(this.behindCapture)
    this.layer.add(this.captureProbe)
  } else {
    this.captureProbe!.removeFromParent()
    ;(this.captureProbe!.material as Material).dispose(); this.captureProbe!.geometry.dispose()
    this.behindCapture!.dispose()
    this.captureProbe = null; this.behindCapture = null
  }
  return true
}
```

In `tick` (after the glass batch update, where `list.glass.length` is known): `if (this.syncBehind(list.glass.length > 0 && this.quality.glassMode !== 'fill')) this.buildGlass(this.quality)`. In `setQuality(q)`: `this.syncBehind(this.glass.buffer.count > 0 && q.glassMode !== 'fill')` before `buildGlass(q)` (read the batch's live instance count however `GlassBatch` exposes it). In `dispose`: `this.syncBehind(false)` is wrong for a disposed Surface whose background may differ; dispose `behindCapture`/`captureProbe` directly if present.

In `buildGlass`, extend the element glass's `behind`:

```ts
const behind = slab && screen && mode !== 'fill'
  ? { screen, screenLevel: SLAB_BEHIND.level, screenLift: SLAB_BEHIND.lift, depthReject: reject, ...(depth ? { depth } : {}) }
  : this.behindCapture && mode !== 'fill'
    ? { screen: this.behindCapture, screenLevel: 0, screenLift: 0 }   // a 'none' Surface: no frost, no depth reject
    : {}
```

Wherever `SurfaceLuma` receives the glass Surface's capture for its behind term (search `luma.update` in `prepare`), hand it `this.screen ?? this.behindCapture` so a `'none'` Surface's clear glass measures what it shows.

- [ ] **Step 5: Implement `takesPointer` and the fall-through**

```ts
/** The node under (x, y) Surface pt in this Surface's tree, or null (core `hitTest` with the Surface's theme). */
hitNode(x: number, y: number): Node | null { return hitTest(this.model.root, x, y, this.ctx.theme) }

/**
 * Whether a pointer at (x, y) belongs to this Surface: always for a glass or coloured background (the panel is UI);
 * otherwise only where a node other than a bare root is hit — a full-screen HUD lets the pointer through its empty
 * areas to what is behind it (other Surfaces, then the host app).
 */
takesPointer(x: number, y: number): boolean {
  if (this.model.background !== 'none') return true
  const hit = this.hitNode(x, y)
  if (!hit) return false
  if (hit !== this.model.root) return true
  const s = effectiveStyle(hit)
  return hit.type === 'glass' || (s.bg !== undefined && s.bg !== 'none') || s.border !== undefined
}
```

In `pointer.ts`, `hitSurfaces`: sort the raycaster hits into coplanar groups (as today), order each group by `drawOrder` descending, and return the first hit whose `uv` exists and whose Surface `takesPointer(x, y)` at `pointFromUV(uv)`; null when none does.

- [ ] **Step 6: Run the tests**

Run: `pnpm vitest run packages/render`
Expected: PASS. Existing pointer tests that pressed on an empty part of a bare fill Surface now see no hit there. Update each to put a node under the pointer, or to expect the no-hit behaviour, which is the same for focus (`activate(null)` blurs). Say which tests changed in the report.

- [ ] **Step 7: Typecheck, build, commit**

Run: `pnpm typecheck && pnpm playground:build`
Expected: both exit 0.

```bash
git add packages/render/src/surface/surface.ts packages/render/src/pointer.ts packages/render/src/luma.ts packages/render/test/surface.test.ts packages/render/test/pointer.test.ts
git commit -m "fix(render): glass on 'none' Surfaces sees what is behind them; pointers fall through empty Surfaces"
```

---

### Task 2: Core interaction seams — element handlers, click-to-focus, focus-visible ring, dblclick, contextmenu

**Files:**
- Modify: `packages/core/src/node.ts` (`handlers`, `setHandler`, `replaceStyle`, `focusVisible` state)
- Modify: `packages/core/src/events/dispatch.ts` (handlers in `dispatch`; `dblclick`; `contextmenu`)
- Modify: `packages/core/src/focus.ts` (`focusFromPointer`, focus-visible)
- Modify: `packages/core/src/renderlist.ts` (`FOCUS_RING` panel)
- Modify: `packages/render/src/pointer.ts` (press focuses; right button → `contextmenu`)
- Test: `packages/core/test/{node,dispatch,focus,renderlist}.test.ts`, `packages/render/test/pointer.test.ts`

**Interfaces:**
- Produces (core):
  - `UIEventType` gains `'dblclick' | 'contextmenu'`.
  - `Node.handlers: ReadonlyMap<string, (e: UIEvent) => void>`; `Node.setHandler(type: UIEventType, fn: ((e: UIEvent) => void) | null): void`. `EventDispatcher.dispatch` runs, on each node of the path, the dispatcher's listeners for the type, then the node's handler for it (Vue's `on*` props land here, so a node needs no Surface to carry listeners).
  - `Node.replaceStyle(style: Style): void` — replaces (not merges) the style and marks `layout` + `paint`; a no-op when `style` deep-equals the current one (Review Focus 1).
  - `NodeState.focusVisible: boolean` (not a style branch). `FocusManager.focus(node, opts?: { visible?: boolean })` sets `focused` and `focusVisible`; keyboard navigation (`next`/`prev`/`key`) focuses visibly; `focusFromPointer(node: Node | null)` focuses the nearest node at or above `node` whose `props.tabIndex` is a finite number (any value, as the DOM's `tabindex`), not disabled and shown, without the ring, or blurs when there is none.
  - `PointerTracker.contextMenu(x, y, pointerType)` dispatches `contextmenu` at the hit node. `click` followed by a second `click` on the same node within 500 ms and 4 pt dispatches `dblclick` after the second `click`. The tracker takes an optional clock: `new PointerTracker(root, d, theme, { now?: () => number })`.
  - `FOCUS_RING = { width: 2.5, offset: 3, color: 'accent' } as const` (core, exported). `buildRenderList` emits, for a node with `state.focused && state.focusVisible && props.focusRing !== false`, a border-only `PanelInstance`: rect grown by `offset` on every side, radius + `offset`, `color: [0,0,0,0]`, `border: { width, color: resolveColor('accent') }`, `z: sortKey(myZ, 'pool')`.
- Produces (render): the bridge calls `s.focus.focusFromPointer(s.pointer.pressed)` after a primary-button down and `s.pointer.contextMenu(...)` (no press) on a right-button down.

- [ ] **Step 1: Write the failing core tests**

`packages/core/test/dispatch.test.ts` (add):

```ts
it('runs a node\'s element handler after the dispatcher\'s listeners, bubbling like them', () => {
  const d = new EventDispatcher(), root = new Node('box'), child = new Node('box'); root.appendChild(child)
  const order: string[] = []
  d.on(child, 'click', () => order.push('listener'))
  child.setHandler('click', () => order.push('child handler'))
  root.setHandler('click', e => order.push(`root handler ${e.currentTarget === root}`))
  d.dispatch(child, 'click')
  expect(order).toEqual(['listener', 'child handler', 'root handler true'])
  child.setHandler('click', null); order.length = 0
  d.dispatch(child, 'click')
  expect(order).toEqual(['listener', 'root handler true'])
})

it('dblclick after two clicks on one node within 500 ms and 4 pt', () => {
  let t = 0
  const d = new EventDispatcher(), root = new Node('box')
  root.layout = { x: 0, y: 0, width: 100, height: 100 }
  const tr = new PointerTracker(root, d, defaultTheme, { now: () => t })
  const got: string[] = []
  root.setHandler('click', () => got.push('click')); root.setHandler('dblclick', () => got.push('dblclick'))
  tr.down(10, 10); tr.up(10, 10); t = 300; tr.down(12, 11); tr.up(12, 11)
  expect(got).toEqual(['click', 'click', 'dblclick'])
  got.length = 0; t = 2000; tr.down(10, 10); tr.up(10, 10); t = 2700; tr.down(10, 10); tr.up(10, 10)
  expect(got).toEqual(['click', 'click'])                                 // too slow
})

it('contextMenu dispatches contextmenu at the hit node and presses nothing', () => {
  const d = new EventDispatcher(), root = new Node('box'); root.layout = { x: 0, y: 0, width: 100, height: 100 }
  const tr = new PointerTracker(root, d)
  const got: string[] = []; root.setHandler('contextmenu', e => got.push(`${e.x},${e.y}`))
  tr.contextMenu(5, 6)
  expect(got).toEqual(['5,6']); expect(tr.pressed).toBeNull(); expect(root.state.pressed).toBe(false)
})
```

`packages/core/test/focus.test.ts` (add):

```ts
it('focusFromPointer focuses the nearest node with a tabIndex, without the ring; keys focus with it', () => {
  const d = new EventDispatcher(), root = new Node('box')
  const field = new Node('glass'); field.setProp('tabIndex', 0)
  const icon = new Node('image'); field.appendChild(icon); root.appendChild(field)
  const plain = new Node('box'); root.appendChild(plain)
  const f = new FocusManager(root, d)
  f.focusFromPointer(icon)
  expect(f.current).toBe(field); expect(field.state.focused).toBe(true); expect(field.state.focusVisible).toBe(false)
  f.focusFromPointer(plain)
  expect(f.current).toBeNull(); expect(field.state.focused).toBe(false)
  f.key('Tab')
  expect(f.current).toBe(field); expect(field.state.focusVisible).toBe(true)
  f.focus(null)
  expect(field.state.focusVisible).toBe(false)
})
it('focusFromPointer skips disabled nodes and counts tabIndex -1 as focusable (DOM tabindex)', () => {
  const d = new EventDispatcher(), root = new Node('box')
  const outer = new Node('box'); outer.setProp('tabIndex', -1)
  const inner = new Node('box'); inner.setProp('tabIndex', 0); inner.setState({ disabled: true })
  outer.appendChild(inner); root.appendChild(outer)
  const f = new FocusManager(root, d)
  f.focusFromPointer(inner)
  expect(f.current).toBe(outer)
})
```

`packages/core/test/node.test.ts` (add):

```ts
it('replaceStyle replaces, and an equal style leaves the node clean', () => {
  const n = new Node('box'); n.setStyle({ width: 10, bg: 'fill' })
  n.dirty = { layout: false, paint: false, text: false, tree: false }
  n.replaceStyle({ width: 10, bg: 'fill' })
  expect(n.dirty.paint).toBe(false)
  n.replaceStyle({ width: 10 })
  expect(n.style).toEqual({ width: 10 }); expect(n.dirty.paint).toBe(true); expect(n.dirty.layout).toBe(true)
})
```

`packages/core/test/renderlist.test.ts` (add):

```ts
it('draws the focus ring around a visibly focused node, outside its rect', () => {
  const s = createSurface({ width: 200, height: 100 })
  const b = new Node('glass', 'b'); b.setStyle({ position: 'absolute', left: 20, top: 20, width: 100, height: 40, radius: 8 })
  b.setState({ focused: true, focusVisible: true })
  s.root.appendChild(b); layoutOf(s)              // the file's existing layout helper
  const ring = buildRenderList(s, defaultTheme, 'light').panels.find(p => p.node === b)!
  expect(ring.rect).toEqual({ x: 17, y: 17, width: 106, height: 46 })
  expect(ring.radius).toBe(11); expect(ring.color).toEqual([0, 0, 0, 0])
  expect(ring.border).toEqual({ width: FOCUS_RING.width, color: resolveColor('accent', defaultTheme, 'light') })
  b.setState({ focusVisible: false })
  expect(buildRenderList(s, defaultTheme, 'light').panels.find(p => p.node === b)).toBeUndefined()
  b.setState({ focusVisible: true }); b.setProp('focusRing', false)
  expect(buildRenderList(s, defaultTheme, 'light').panels.find(p => p.node === b)).toBeUndefined()
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run packages/core`
Expected: FAIL — `setHandler`, `replaceStyle`, `focusFromPointer`, `contextMenu`, `FOCUS_RING` missing.

- [ ] **Step 3: Implement in core**

`node.ts`:

```ts
import type { UIEvent, UIEventType } from './events/dispatch'   // type-only: no runtime cycle
export interface NodeState { hover: boolean; pressed: boolean; focused: boolean; disabled: boolean; focusVisible: boolean }
const STATES = ['hover', 'pressed', 'focused', 'disabled', 'focusVisible'] as const

// in class Node:
private readonly hs = new Map<string, (e: UIEvent) => void>()
/** Element-level handlers, one per event type (Vue's `on*` props): `EventDispatcher` runs them after its own listeners. */
get handlers(): ReadonlyMap<string, (e: UIEvent) => void> { return this.hs }
setHandler(type: UIEventType, fn: ((e: UIEvent) => void) | null): void { if (fn) this.hs.set(type, fn); else this.hs.delete(type) }

/** Replaces the whole style (unvalidated, like `setStyle`); an equal style is a no-op, so re-patching it costs nothing. */
replaceStyle(style: Style): void {
  if (deepEqual(this.style, style)) return
  this.style = style
  this.markDirty('layout'); this.markDirty('paint')
}
```

with a small `deepEqual(a: unknown, b: unknown): boolean` (plain objects, arrays, primitives; key order ignored) in `node.ts`. `changesLayout` looks up `this.style[k]` only for the four branch keys: skip `focusVisible` there.

`dispatch.ts`:

```ts
export type UIEventType = 'pointerdown' | 'pointerup' | 'pointermove' | 'pointerenter' | 'pointerleave' | 'pointercancel' | 'click' | 'dblclick' | 'contextmenu' | 'wheel' | 'keydown' | 'keyup' | 'focus' | 'blur' | 'press' | 'change'
export const UI_EVENT_TYPES: readonly UIEventType[] = ['pointerdown', 'pointerup', 'pointermove', 'pointerenter', 'pointerleave', 'pointercancel', 'click', 'dblclick', 'contextmenu', 'wheel', 'keydown', 'keyup', 'focus', 'blur', 'press', 'change']

// in dispatch(), per node of the path:
const fns = this.listeners.get(n)?.get(type)
const own = n.handlers.get(type)
if (fns?.size || own) {
  e.currentTarget = n
  const r = absoluteRect(n); e.localX = e.x - r.x; e.localY = e.y - r.y
  if (fns) for (const fn of [...fns]) fn(e)
  if (own && !e.immediateStopped) own(e)
}
```

(`immediateStopped` does not exist: run `own` unconditionally after the listeners, as the DOM runs every listener of the current node.)

`PointerTracker`: constructor `(root, d, theme = defaultTheme, opts: { now?: () => number } = {})`, `private now = opts.now ?? (() => performance.now())`, `private lastClick: { node: Node; t: number; x: number; y: number } | null = null`. In `up`, after dispatching `click` at `target`: if `lastClick` has the same node, `t − lastClick.t ≤ 500` and `hypot(x − lastClick.x, y − lastClick.y) ≤ 4`, dispatch `dblclick` at `target` and clear `lastClick`; else set `lastClick`. Add:

```ts
/** A secondary-button press: `contextmenu` at the hit node; no press state (the DOM presses nothing either). */
contextMenu(x: number, y: number, pointerType: PointerType = 'mouse'): void {
  const hit = this.locate(x, y, pointerType)
  if (hit) this.d.dispatch(hit, 'contextmenu', this.last)
}
```

`focus.ts`:

```ts
private keyboard = false   // the last focus change came from keys: the ring shows (CSS :focus-visible)

focus(node: Node | null, opts: { visible?: boolean } = {}): void {
  // … as today, with setState({ focused: false, focusVisible: false }) on blur and
  // setState({ focused: true, focusVisible: opts.visible ?? this.keyboard }) on focus
}
next()/prev(): set this.keyboard = true before stepping
key(): set this.keyboard = true when it moves focus (Tab / Shift+Tab)

/** A press: focus the nearest focusable at or above `node` (DOM rule: any `tabIndex`), without the ring; else blur. */
focusFromPointer(node: Node | null): void {
  this.keyboard = false
  for (let n = node; n; n = n.parent) {
    if (Number.isFinite(tabIndexOf(n)) && this.canFocus(n)) { this.focus(n, { visible: false }); return }
    if (n === this.root) break
  }
  this.focus(null)
}
```

`renderlist.ts`:

```ts
/** The focus-visible ring (spec §7.2): a border outside the node's shape, drawn in the content layer under its glass edge. */
export const FOCUS_RING = { width: 2.5, offset: 3, color: 'accent' } as const

// in visit(), after the node's own panel/glass:
if (n.state.focused && n.state.focusVisible && n.props.focusRing !== false) {
  const o = FOCUS_RING.offset
  rl.panels.push({ ...base, rect: { x: rect.x - o, y: rect.y - o, width: rect.width + 2 * o, height: rect.height + 2 * o }, radius: radius + o, color: [0, 0, 0, 0], border: { width: FOCUS_RING.width, color: resolveColor(FOCUS_RING.color, theme, scheme) }, z: sortKey(myZ, 'pool') })
}
```

- [ ] **Step 4: Wire the bridge**

In `pointer.ts` `handle('pointerdown')`: a `button === 2` down casts, and if a Surface takes it, calls `hit.surface.pointer.contextMenu(hit.x, hit.y, ptype)` and returns (no press, no capture, focus unchanged). After a primary down's `hit.surface.pointer.down(...)`, call `hit.surface.focus.focusFromPointer(hit.surface.pointer.pressed)`. A down on nothing already blurs through `activate(null)`. Add a test in `pointer.test.ts`: pressing `btn` (tabIndex 0) focuses it with `focusVisible: false`; a right-button down dispatches `contextmenu` and does not press.

- [ ] **Step 5: Run all tests, typecheck, commit**

Run: `pnpm vitest run packages/core packages/render && pnpm typecheck`
Expected: PASS. Existing tests that enumerate `NodeState` keys or `UIEventType` values need the new members; update them and say which.

```bash
git add packages/core/src packages/core/test packages/render/src/pointer.ts packages/render/test/pointer.test.ts
git commit -m "feat(core): element handlers, click-to-focus with focus-visible ring, dblclick and contextmenu"
```

---

### Task 3: Animation hooks for transitions and shape morphs

**Files:**
- Modify: `packages/core/src/animation/runtime.ts` (`whenSettled`, `seed`)
- Modify: `packages/core/src/node.ts` (`GlassNumericKey` + `'glowSplit'`), `packages/core/src/renderlist.ts` (`resolveGlass` reads it)
- Test: `packages/core/test/animation.test.ts` (or the file that tests `AnimationRuntime`)

**Interfaces:**
- Produces:
  - `AnimationRuntime.whenSettled(node: Node): Promise<void>` — resolves at the end of the first `tick` (of any root) after the call in which `node` has no live channel: settled, never animated, or no longer in a ticked tree (removed nodes resolve on the next tick of the root they were last seen under, or of any root when never seen). Never rejects.
  - `AnimationRuntime.seed(node: Node, from: Partial<Record<'x' | 'y' | 'width' | 'height' | 'opacity' | 'scale', number>>): void` — records `from` as the node's previous targets, so the first tick that sees it animates those keys from `from` to its real targets (when its style has a transition for them); used by `<GlassTransition>` (Task 7) and the glassId morph (Task 17). Keys not in `from` are recorded on first sight as today.
  - `GlassNumericKey` gains `'glowSplit'`; `resolveGlass` uses `v.glowSplit ?? g.glow?.split`; the runtime animates it like the other glass numbers (target `g.glow?.split ?? 0.5`).

- [ ] **Step 1: Write the failing tests**

```ts
describe('AnimationRuntime hooks', () => {
  const box = (style: Style) => { const n = new Node('box'); n.setStyle(style); n.layout = { x: 0, y: 0, width: 100, height: 40 }; return n }
  it('whenSettled resolves on the tick the node stops moving', async () => {
    const rt = new AnimationRuntime(defaultTheme, 'light'), root = new Node('box'); root.layout = { x: 0, y: 0, width: 400, height: 400 }
    const n = box({ opacity: 1, transition: { opacity: { duration: 0.1, easing: 'linear' } } }); root.appendChild(n)
    rt.tick(root, 0)                                         // first sight
    n.setStyle({ opacity: 0 })
    let done = false; void rt.whenSettled(n).then(() => { done = true })
    rt.tick(root, 0.05); await Promise.resolve(); expect(done).toBe(false)
    rt.tick(root, 0.06); await Promise.resolve(); expect(done).toBe(true)
  })
  it('whenSettled resolves for a node that never animates, and for one removed from the tree', async () => {
    const rt = new AnimationRuntime(defaultTheme, 'light'), root = new Node('box'); root.layout = { x: 0, y: 0, width: 400, height: 400 }
    const still = box({}); root.appendChild(still)
    const gone = box({ opacity: 1, transition: { opacity: 'smooth' } }); root.appendChild(gone)
    rt.tick(root, 0); gone.setStyle({ opacity: 0 }); rt.tick(root, 0.01)
    const a = rt.whenSettled(still), b = rt.whenSettled(gone)
    gone.remove(); rt.tick(root, 0.01)
    await expect(Promise.all([a, b])).resolves.toBeDefined()
  })
  it('seed makes the first sight animate from the seeded values', () => {
    const rt = new AnimationRuntime(defaultTheme, 'light'), root = new Node('box'); root.layout = { x: 0, y: 0, width: 400, height: 400 }
    const n = box({ transition: { x: { duration: 0.2, easing: 'linear' }, width: { duration: 0.2, easing: 'linear' } } })
    n.layout = { x: 200, y: 0, width: 100, height: 40 }; root.appendChild(n)
    rt.seed(n, { x: 0, width: 50 })
    rt.tick(root, 0.1)
    expect(n.visual?.x).toBeCloseTo(100); expect(n.visual?.width).toBeCloseTo(75)
  })
  it('glowSplit animates like the other glass numbers', () => {
    const rt = new AnimationRuntime(defaultTheme, 'light'), root = new Node('box'); root.layout = { x: 0, y: 0, width: 400, height: 400 }
    const g = new Node('glass'); g.layout = { x: 0, y: 0, width: 136, height: 62 }
    g.setStyle({ glass: { glow: { color: 'accent', strength: 1, split: 0.2 } }, transition: { glass: { duration: 0.2, easing: 'linear' } } })
    root.appendChild(g); rt.tick(root, 0)
    g.setStyle({ glass: { glow: { color: 'accent', strength: 1, split: 0.8 } } })
    rt.tick(root, 0.1)
    expect(g.visual?.glass?.glowSplit).toBeCloseTo(0.5)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/core/test/animation.test.ts`
Expected: FAIL — `whenSettled`/`seed` missing; `glowSplit` not in the visual values.

- [ ] **Step 3: Implement**

In `runtime.ts`:

```ts
private waiting = new Map<Node, (() => void)[]>()

/** Resolves after the first tick in which `node` has no live channel (see the class doc). */
whenSettled(node: Node): Promise<void> {
  return new Promise(resolve => { const w = this.waiting.get(node); if (w) w.push(resolve); else this.waiting.set(node, [resolve]) })
}

/** Records `from` as `node`'s previous targets: its first sighting animates them toward the real ones. */
seed(node: Node, from: Partial<Record<'x' | 'y' | 'width' | 'height' | 'opacity' | 'scale', number>>): void {
  const targets = new Map<string, number>()
  for (const [k, v] of Object.entries(from)) if (v !== undefined && Number.isFinite(v)) targets.set(k, v)
  this.state.set(node, { root: node.root, targets, channels: new Map() })
}
```

`step()` today returns early on first sight (`!anim`). A seeded node has an `anim` whose `targets` hold only the seeded keys. The existing loop then animates exactly those keys (`prev` defined, `prev !== to`) and records the rest (`prev === undefined` → continue), so no change is needed there. At the end of `tick(root, …)`:

```ts
for (const [n, fns] of [...this.waiting]) {
  const a = this.state.get(n)
  const live = a !== undefined && a.root === root && a.channels.size > 0
  const elsewhere = a !== undefined && a.root !== root
  if (live || elsewhere) continue
  this.waiting.delete(n); for (const f of fns) f()
}
```

A node waiting under another root resolves on that root's tick. A node never tracked anywhere has no `anim`, so it resolves on the first tick of any root.

`node.ts`: `GlassNumericKey` adds `'glowSplit'`. In `runtime.ts` `targets()`: `glowSplit: g.glow?.split ?? 0.5` in `nums`. In `renderlist.ts` `resolveGlass`, the `glow` object becomes `{ color: glowColor, strength: glowStrength, ...defined({ split: o.glowSplit ?? g.glow?.split }) }`.

- [ ] **Step 4: Run, typecheck, commit**

Run: `pnpm vitest run packages/core && pnpm typecheck`
Expected: PASS.

```bash
git add packages/core/src packages/core/test
git commit -m "feat(core): AnimationRuntime.whenSettled/seed and an animatable glow split"
```

---

### Task 4: The root API the Vue layer needs

**Files:**
- Modify: `packages/render/src/root.ts`, `packages/render/src/surface/surface.ts`, `packages/render/src/surface/screen.ts`, `packages/render/src/pointer.ts`, `packages/render/src/quality.ts` (only if the contrast pin needs it)
- Create: `packages/render/src/internal.ts`; Modify: `packages/render/src/index.ts`, `packages/render/package.json`
- Modify: `packages/core/src/style/theme.ts` (`scrim` colour token)
- Test: `packages/render/test/root.test.ts`, `packages/render/test/screen.test.ts`, `packages/render/test/surface.test.ts`, `packages/render/test/exports.test.ts` (new)

**Interfaces:**
- Produces:
  - `UIRoot.setTheme(theme: Theme): void` and `UIRoot.setScheme(scheme: ColorScheme): void`: they swap the shared `SurfaceContext` theme/scheme and measure function, call `anim.setTheme`, and call a new `Surface.restyle()` on every Surface, which recomputes the fill colours and the opaque background clear, rebuilds the glass, and marks the tree dirty (`layout`, `paint`, `text` on every node). `UIRoot.theme` and `UIRoot.scheme` become getters for the current values. A new root event `theme: { theme: Theme; scheme: ColorScheme }` fires after the swap.
  - `UIRootOptions.increasedContrast?: boolean`: default is the `(prefers-contrast: more)` media query, followed live like the other two. Increased contrast pins the minimal tier, exactly like reduced transparency (spec §8.3: "黑/白实心 + 边框"), and switches the fill colours to `fillColors(theme, scheme, { contrast: true })`: slab and element fill pure white (light) or `#000000` (dark), border the `label` token. The pin is `reducedTransparency || increasedContrast`, passed to `quality.setReducedTransparency(pin)`. `UIRoot.contrast: boolean` getter.
  - `fillColors(theme, scheme, opts?: { contrast?: boolean })`.
  - `SurfaceOptions.billboard?: boolean` and `Surface.billboard: boolean`: in `root.tick`, a world Surface with `billboard` turns to face the camera (its world quaternion = the camera's world quaternion) before its matrices are read.
  - `ScreenPlacement` adds `{ center: true }`: the Surface's scaled rect is centred in the viewport. `CreateSurfaceOptions` gains `center?: boolean`, which `createSurface` turns into that placement (`fill` wins over `center`, which wins over `left/top`).
  - `UIRoot.afterTick(): Promise<void>`: resolves at the end of the next `tick` (after the content passes and the shadow fit).
  - `Surface.worldFromPoint(x: number, y: number, target: Vector3): Vector3`: the world position of Surface pt (x, y) on its content plane. `UIRoot.screenFromPoint(surface, x, y): { x: number; y: number } | null`: that point projected to CSS px relative to the canvas's top-left; null when it is behind the camera.
  - `PointerBridge.setActive(s: Surface | null): void` (public `activate`): the Surface that receives keys (Dialog, Task 14). `Surface.trapFocus: boolean` (default false): Tab past the last focusable wraps to the first (Shift+Tab: the reverse) instead of leaving the canvas.
  - `theme.colors.light.scrim = '#00000047'`, `theme.colors.dark.scrim = '#00000080'` (Dialog backdrop).
  - `@glassui/render` exports only the public API: `createUIRoot`, `UIRoot`, `UIRootOptions`, `UIRootEventMap`, `CreateSurfaceOptions`, `UIRenderer`, `Surface`, `SurfaceOptions`, `SurfaceEventMap`, `ScreenLayer`, `ScreenPlacement`, `QUALITY`, `QualityTier`, `QualityProfile`, `QualityController`, `defaultImageLoader`, `ImageLoader`, `ImageSource`, `fillColors`, and from Task 12 `ImeBridge` with its types. Everything else moves to `@glassui/render/internal` (`internal.ts` re-exports every module, as `index.ts` does today). `package.json` gains `"exports": { ".": "./src/index.ts", "./internal": "./src/internal.ts" }`. The playground and `examples/visual` import only the public names; tests keep importing `../src/...`.

- [ ] **Step 1: Write the failing tests**

`packages/render/test/root.test.ts` (with the file's stub renderer; `createRoot()` stands for its existing setup):

```ts
it('setScheme restyles every Surface and fires a theme event', async () => {
  const root = await createRoot()
  const s = root.createSurface({ width: 100, height: 100, background: '#ffffff' })
  const n = new Node('text'); n.setProp('value', 'a'); s.root.appendChild(n); root.tick(0)
  const seen: string[] = []; root.on('theme', e => seen.push(e.scheme))
  root.setScheme('dark')
  expect(root.scheme).toBe('dark'); expect(seen).toEqual(['dark'])
  expect(n.dirty.paint && n.dirty.text).toBe(true)
  root.tick(0)                                             // no throw: the dark tokens resolve
})
it('increased contrast pins minimal and uses label borders', async () => {
  const root = await createRoot({ increasedContrast: true, quality: 'high' })
  expect(root.quality.tier).toBe('minimal'); expect(root.contrast).toBe(true)
  expect(fillColors(root.theme, 'light', { contrast: true }).border.getHexString()).toBe(toColor(resolveColor('label', root.theme, 'light')).getHexString())
})
it('afterTick resolves after the next tick', async () => {
  const root = await createRoot(); let done = false
  void root.afterTick().then(() => { done = true })
  await Promise.resolve(); expect(done).toBe(false)
  root.tick(0); await Promise.resolve(); expect(done).toBe(true)
})
it('a billboard world Surface faces the camera after a tick', async () => {
  const root = await createRoot()
  const s = root.createSurface({ layer: 'world', width: 100, height: 100, billboard: true })
  camera.position.set(3, 1, 5); camera.lookAt(0, 0, 0); camera.updateMatrixWorld()
  root.tick(0)
  expect(s.getWorldQuaternion(new Quaternion()).angleTo(camera.getWorldQuaternion(new Quaternion()))).toBeLessThan(1e-6)
})
it('screenFromPoint projects a Surface pt to canvas px', async () => {
  const root = await createRoot()                          // the stub's size is 800 × 600
  const s = root.createSurface({ width: 200, height: 100, left: 300, top: 250 }); root.tick(0)
  const p = root.screenFromPoint(s, 100, 50)!
  expect(p.x).toBeCloseTo(400, 3); expect(p.y).toBeCloseTo(300, 3)
})
```

`packages/render/test/screen.test.ts`:

```ts
it('centres a { center: true } Surface', () => {
  const layer = new ScreenLayer(), s = new Surface({ width: 200, height: 100, ptPerUnit: 1 }, ctx)
  layer.place(s, { center: true }); layer.update(camera, { width: 800, height: 600 })
  expect(s.position.x).toBeCloseTo(0); expect(s.position.y).toBeCloseTo(0)
})
```

`packages/render/test/exports.test.ts`:

```ts
import * as pub from '../src/index'
import * as internal from '../src/internal'
it('the public entry exports only the public API; internal keeps the rest', () => {
  expect(Object.keys(pub).sort()).toEqual(['QUALITY', 'QualityController', 'RENDER_VERSION', 'ScreenLayer', 'Surface', 'createUIRoot', 'defaultImageLoader', 'fillColors'].sort())
  for (const k of ['GlassBatch', 'createGlassMaterial', 'ContentPass', 'hitSurfaces', 'KawasePyramid']) expect(k in internal).toBe(true)
})
```

(Type-only exports do not show up in `Object.keys`; Task 12 adds `ImeBridge` to this list.)

Also in `surface.test.ts`: `Surface.worldFromPoint` maps (0, 0) and (W, H) to the content quad's corners (compare with `contentMesh.localToWorld` of (∓0.5, ±0.5, 0)); and `trapFocus` wraps Tab (a bridge test in `pointer.test.ts`: two focusables, `trapFocus = true`, Tab on the last focuses the first and calls `preventDefault`).

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/render`
Expected: FAIL on every new test.

- [ ] **Step 3: Implement**

`root.ts`:

```ts
let theme = opts.theme ?? defaultTheme, scheme = opts.scheme ?? 'light'
const contrastQuery = opts.increasedContrast === undefined ? media('(prefers-contrast: more)') : null
let contrast = opts.increasedContrast ?? contrastQuery?.matches ?? false
let transparency = reducedTransparency          // the live value, followed below
const pin = () => quality.setReducedTransparency(transparency || contrast)
// replace `follow(transparencyQuery, on => quality.setReducedTransparency(on))` with
follow(transparencyQuery, on => { transparency = on; pin() })
follow(contrastQuery, on => { contrast = on; ctx.contrast = on; each(s => s.restyle()); pin() })

function restyleAll(): void {
  ctx.theme = theme; ctx.scheme = scheme; ctx.measure = createMeasureFn(text, theme, scheme)
  anim.setTheme(theme, scheme)
  each(s => s.restyle())
  emit('theme', { theme, scheme })
}
// in the root object:
get theme() { return theme }, get scheme() { return scheme }, get contrast() { return contrast },
setTheme(t) { theme = t; restyleAll() },
setScheme(sc) { if (sc !== scheme) { scheme = sc; restyleAll() } },
afterTick() { return new Promise<void>(r => afterTickWaiters.push(r)) },
screenFromPoint(s, x, y) {
  const p = s.worldFromPoint(x, y, tmp).project(camera)
  if (p.z > 1 || p.z < -1) return null
  const r = canvas.getBoundingClientRect()
  return { x: (p.x + 1) / 2 * r.width, y: (1 - p.y) / 2 * r.height }
},
```

`SurfaceContext` gains `contrast: boolean`, and `ctx` is built with `contrast`. At the end of `tick`, resolve and clear `afterTickWaiters`. In `tick`, before `s.updateWorldMatrix`, for every world Surface with `billboard`:

```ts
camera.getWorldQuaternion(qCam)
const parentQ = s.parent ? s.parent.getWorldQuaternion(qParent) : qParent.identity()
s.quaternion.copy(parentQ.invert().multiply(qCam))
```

`UIRootEventMap` gains `theme`. `createSurface` passes `billboard` through. The pinned initial tier uses `reducedTransparency || contrast`.

`surface.ts`:

```ts
billboard: boolean            // ctor: opts.billboard ?? false
trapFocus = false

/** Re-reads the theme and scheme from the shared context: fill colours, an opaque background, the glass, every node. */
restyle(): void {
  if (this.error) return
  try {
    this.fills = fillColors(this.ctx.theme, this.ctx.scheme, { contrast: this.ctx.contrast })
    const bg = this.model.background
    if (bg !== 'glass' && bg !== 'none') { toColor(resolveColor(bg, this.ctx.theme, this.ctx.scheme), this.contentClear.color); this.contentClear.alpha = 1 }
    this.buildGlass(this.quality)
    this.root.walk(n => { n.markDirty('layout'); n.markDirty('paint'); n.dirty.text = true })
    this.contentDirty = true
  } catch (e) { this.fail(e) }
}

worldFromPoint(x: number, y: number, target: Vector3): Vector3 {
  const { width: w, height: h } = this.model
  return this.contentMesh.localToWorld(target.set(x / w - 0.5, 0.5 - y / h, 0))   // content quad: unit plane scaled to W×H
}
```

`fillColors(theme, scheme, opts = {})`: with `opts.contrast`, use `slab = glass = (scheme === 'light' ? white : black)` and `border = label`.

`screen.ts`: `export type ScreenPlacement = { fill: true } | { center: true } | { left: number; top: number }`, and in `apply`:

```ts
if ('center' in at) { s.position.set(0, 0, 0 - s.contentPlaneZ * s.scale.z); return }
```

`pointer.ts`:
- Rename the private `activate` to a public `setActive(s)`, keeping the blur-on-change behaviour.
- In the Tab branch, a Surface with `trapFocus` wraps: past the last focusable it focuses the first (Shift+Tab: the reverse), calls `preventDefault`, and never blurs out.

`theme.ts`: add `scrim` to both colour tables.

Exports: create `src/internal.ts` holding today's `index.ts` list, and rewrite `index.ts` to the public names above. Check `examples/playground/src/*.ts` and `examples/visual/**` for imports of non-public names, and move them to `@glassui/render/internal` or to public API.

- [ ] **Step 4: Run, typecheck, build, commit**

Run: `pnpm vitest run packages/render packages/core && pnpm typecheck && pnpm playground:build`
Expected: PASS / exit 0.

```bash
git add packages/render packages/core/src/style/theme.ts examples/playground/src
git commit -m "feat(render): setTheme/setScheme, increased contrast, billboard, centred placement, afterTick, screenFromPoint, public entry"
```

---

### Task 5: Root hardening — disposed guards, render-time isolation, yoga sweep

**Files:**
- Modify: `packages/render/src/root.ts`, `packages/render/src/surface/surface.ts`
- Modify: `packages/core/src/layout/yoga.ts` (per-root sweep of yoga nodes of removed subtrees)
- Test: `packages/render/test/root.test.ts`, `packages/render/test/surface.test.ts`, `packages/core/test/layout.test.ts`

**Interfaces:**
- Produces:
  - After `root.dispose()`: `tick`, `render`, `renderUI`, `frame` are no-ops; `createSurface` throws `GlassUIError('UIRoot.createSurface', 'root 已经 dispose')`; `setTheme`/`setScheme` are no-ops.
  - `Surface.dispose()` is idempotent and dispatches a `dispose` event (`SurfaceEventMap.dispose: {}`); a Surface disposed directly (not through `removeSurface`) is dropped from `root.surfaces`, `pointer.forget(s)` and `screen.unplace(s)` run, and `tick`/`prepare` on a disposed Surface do nothing.
  - `Surface.markFailed(e: unknown): void` (public form of `fail`): stops the Surface (hidden, `error` set, `error` event).
  - `UIRootEventMap.error` becomes `{ surface: Surface | null; error: Error }`.
  - Render isolation (spec §9, Plan 2 M1): when `renderer.render(uiScene, camera)` throws in `renderUI`, the root renders each visible Surface's `layer` alone (all other layers `visible = false`, restored in `finally`) to find the ones that throw, `markFailed`s them, and emits `error` for each; when no Surface reproduces the error, it emits `error` with `surface: null`. Neither case rethrows, so the next frame draws the remaining Surfaces. Shared mode does the same around `renderer.render(scene, camera)`.
  - `LayoutEngine` gains `readonly liveNodes: number` (debug; yoga nodes currently allocated). `YogaLayout.compute(root, …)` frees the yoga nodes of nodes that were last synced under `root` and were not visited in this compute (removed subtrees), so a Vue app that mounts and unmounts thousands of nodes does not leak wasm memory.

- [ ] **Step 1: Write the failing tests**

```ts
// root.test.ts
it('after dispose, frames do nothing and createSurface throws', async () => {
  const root = await createRoot(); root.dispose()
  expect(() => root.tick(0)).not.toThrow(); expect(() => root.frame(0)).not.toThrow()
  expect(() => root.createSurface({ width: 1, height: 1 })).toThrow(/dispose/)
})
it('a Surface disposed directly leaves the root', async () => {
  const root = await createRoot(); const s = root.createSurface({ width: 10, height: 10 })
  s.dispose(); s.dispose()
  expect(root.surfaces).not.toContain(s); expect(root.screen.surfaces.has(s)).toBe(false)
})
it('a throwing UI render fails the Surface that throws and the next frame draws the others', async () => {
  const renderer = stubRenderer()
  const root = await createRoot({ renderer })
  const good = root.createSurface({ width: 10, height: 10 }), bad = root.createSurface({ width: 10, height: 10 })
  const errors: unknown[] = []; root.on('error', e => errors.push(e.surface))
  renderer.render.mockImplementation((scene: Scene) => {
    let badShown = false; bad.layer.traverseVisible(() => { badShown = true })
    if (scene === root.uiScene && badShown && bad.visible) throw new Error('shader')
  })
  root.tick(0); expect(() => root.renderUI()).not.toThrow()
  expect(errors).toEqual([bad]); expect(bad.error).toBeTruthy(); expect(good.error).toBeNull()
})
```

```ts
// core layout.test.ts
it('frees the yoga nodes of removed subtrees on the next compute of their root', async () => {
  const y = await createYogaLayout(), root = new Node('box')
  const sub = new Node('box'); for (let i = 0; i < 50; i++) sub.appendChild(new Node('box'))
  root.appendChild(sub); y.compute(root, 100, 100)
  const before = y.liveNodes
  sub.remove(); y.compute(root, 100, 100)
  expect(y.liveNodes).toBe(before - 51)
})
it('a subtree moved to another root is re-synced there, not freed under the old one', async () => {
  const y = await createYogaLayout(), a = new Node('box'), b = new Node('box'), sub = new Node('box')
  a.appendChild(sub); y.compute(a, 100, 100)
  b.appendChild(sub); y.compute(b, 100, 100); y.compute(a, 100, 100)
  expect(() => y.compute(b, 100, 100)).not.toThrow(); expect(sub.layout.width).toBe(100)
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/render/test/root.test.ts packages/core/test/layout.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`yoga.ts`:
- `Entry` gains `owner: Node`, the root it was last synced under.
- `entries` becomes a `Map<Node, Entry>`, so it can be iterated.
- `compute(root)` records the visited nodes during `sync`, setting `owner = root` on each.
- Afterwards, every entry with `owner === root` that was not visited is freed and deleted.
- `liveNodes` returns `entries.size`.
- `dispose(root)` stays as is.

`root.ts`:
- Add a `disposed` early return in `tick`, `render`, `renderUI`, `frame`, `setTheme` and `setScheme`, and a throw in `createSurface`.
- `createSurface` adds a `dispose` listener on `s` that removes it from `surfaces`, calls `pointer?.forget(s)`, `screen.unplace(s)` and `lastPose.delete(s)`, and does not call `dispose` again.
- `renderUI`'s `try` becomes a `catch` that runs `isolate(uiScene)`:

```ts
function isolate(sceneToDraw: Scene, e: unknown): void {
  const shown = surfaces.filter(s => s.visible && !s.error)
  const culprits: Surface[] = []
  for (const s of shown) {
    const others = shown.filter(o => o !== s)
    for (const o of others) o.layer.visible = false
    try { renderer.render(sceneToDraw, camera) } catch { culprits.push(s) } finally { for (const o of others) o.layer.visible = true }
  }
  if (!culprits.length) emit('error', { surface: null, error: e instanceof Error ? e : new Error(String(e)) })
  for (const s of culprits) s.markFailed(e)   // markFailed emits through the Surface's error listener
}
```

`surface.ts`:
- Rename `fail` to `markFailed`, keeping a private alias or updating the callers.
- `dispose` gets a `disposed` flag: it returns at once if already disposed, and otherwise dispatches `{ type: 'dispose' }` after freeing everything.
- `tick` and `prepare` return when `disposed`.
- `SurfaceEventMap` gains `dispose: object`.

- [ ] **Step 4: Run, typecheck, commit**

Run: `pnpm vitest run packages/core packages/render && pnpm typecheck`
Expected: PASS.

```bash
git add packages/core/src/layout packages/core/test packages/render/src packages/render/test
git commit -m "fix(render,core): disposed guards, per-Surface render isolation, yoga sweep of removed subtrees"
```

---
### Task 6: `@glassui/vue` — the custom renderer and `createGlassApp`

**Files:**
- Create: `packages/vue/package.json`, `packages/vue/tsconfig.json`, `packages/vue/tsconfig.test.json`
- Create: `packages/vue/src/{index.ts, root.ts, renderer.ts, app.ts, keys.ts}`
- Create: `packages/vue/test/{renderer.test.ts, app.test.ts, no-three.test.ts}`, `packages/vue/test/fixtures/{fake-root.ts, tree.ts, fake-text.ts}`
- Modify: root `package.json` (`typecheck` adds `packages/vue` and `packages/vue/tsconfig.test.json`), `pnpm-lock.yaml` (via `pnpm install`)

**Interfaces:**
- Consumes: core `Node`, `NodeType`, `parseTw`, `validateStyle`, `UI_EVENT_TYPES`, `GlassUIError`, `Node.setHandler`, `Node.replaceStyle` (Task 2); render types `UIRoot`, `Surface`, `CreateSurfaceOptions` (type-only imports).
- Produces:
  - `export type GlassRoot = Pick<UIRoot, 'theme' | 'scheme' | 'contrast' | 'anim' | 'text' | 'surfaces' | 'pointer' | 'createSurface' | 'removeSurface' | 'afterTick' | 'on' | 'screenFromPoint'>` (`src/root.ts`). Task 12 adds `ime`. Everything in `@glassui/vue` talks to the render package through this type, which keeps the vue tests free of three.
  - `export const HOST_TAGS = ['box', 'text', 'image', 'glass', 'scroll', 'portal'] as const; export type HostTag = (typeof HOST_TAGS)[number]`.
  - `export function createGlassRenderer(opts: { root: GlassRoot }): { render: RootRenderFunction<Node>; createApp: CreateAppFunction<Node> }`.
  - `export function setStyleLayer(node: Node, layer: 'control' | 'morph' | 'transition', style: Style | null): void`. A style layer is merged over a node's own style (tw < class < style < control < morph < transition). Composition (`useGlassControl`, the glassId morph, `GlassTransition`) uses it without fighting Vue's patches or each other. It recomputes the node's style via `replaceStyle`.
  - `export function createGlassApp(component: Component, opts: GlassAppOptions, rootProps?: Record<string, unknown>): GlassApp` with:
    - `GlassAppOptions = { root: GlassRoot; parent?: App; motion?: 'live' | 'frozen'; errorMarker?: boolean; createCanvas?: (w: number, h: number) => CanvasLike }`
    - `interface GlassApp extends App<Node> { mount(target?: Surface | Node): ComponentPublicInstance }`.
    - `mount()` without a target mounts into a detached container node, for apps made only of `<Surface>`s.
    - `mount(surface)` mounts into `surface.root` and provides the Surface (`GLASS_SURFACE`) to the tree.
  - Injection keys (`src/keys.ts`): `GLASS_ROOT: InjectionKey<GlassRoot>`, `GLASS_SURFACE: InjectionKey<Surface | null>`, `GLASS_OPTIONS: InjectionKey<Required<Pick<GlassAppOptions, 'motion' | 'createCanvas'>>>`.
  - The renderer's `nodeOps`:
    - `createElement(tag)`: makes a `Node` of that type. An unknown tag throws `GlassUIError('renderer', '未知元素 <x>', { allowed: HOST_TAGS, got })`.
    - `createText(text)`: makes a `text` node with `props.value = text`, absolutely positioned while its value is `''`, so Vue's empty anchors never take layout space or a flex gap.
    - `createComment()`: makes an `anchor` node, `position: 'absolute'`, 0 × 0.
    - `setText(n, t)`: sets `props.value` and toggles the empty-text positioning.
    - `setElementText(el, t)`: on a `text` node sets its value; on any other node, replaces its children with one text child, or removes them when `t === ''`.
    - `insert(c, p, a)` → `p.insertBefore(c, a ?? null)`; `remove(c)` → `c.remove()`; `parentNode(n)` → `n.parent`; `nextSibling(n)` → the next child of its parent, or null.
    - `querySelector(sel)`: `#id` finds a node by id; a bare name finds a `portal` node whose `props.name` equals it. It searches the mounted containers and every `root.surfaces[i].root`.
    - `patchProp`: `on<Type>` sets the node's handler for the lower-cased type, and an unknown type throws `GlassUIError` with the allowed `UI_EVENT_TYPES`. `style`, `tw` and `class` go through the style layers. `disabled` is `setState({ disabled: !!v })` plus `setProp`. Anything else is `setProp(key, v)`.

- [ ] **Step 1: Scaffold the package**

`packages/vue/package.json`:

```json
{
  "name": "@glassui/vue",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "@glassui/core": "workspace:*", "@glassui/text": "workspace:*", "@vue/runtime-core": "3.5.44", "zod": "^4.0.0" },
  "devDependencies": { "@glassui/render": "workspace:*", "@napi-rs/canvas": "^1.0.10" }
}
```

(Use the zod version `@glassui/core` already depends on. `@glassui/render` is a dev dependency because `src` imports only its types, and the playground depends on both.)

`tsconfig.json` and `tsconfig.test.json` mirror `packages/render`'s: references core, text and render, `lib: ["ES2022", "DOM"]`. Add both to the root `typecheck` script. Run `pnpm install --prefer-offline` (registry.npmjs.org may be needed).

`test/no-three.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
const files = (d: string): string[] => readdirSync(d).flatMap(f => statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)])
it('src never imports three or the render package at runtime', () => {
  for (const f of files(join(__dirname, '../src')).filter(f => f.endsWith('.ts'))) {
    const src = readFileSync(f, 'utf8')
    expect(src, f).not.toMatch(/from ['"]three/)
    expect(src, f).not.toMatch(/^import (?!type)[^\n]*from ['"]@glassui\/render/m)
  }
})
```

- [ ] **Step 2: Write the test fixtures**

`test/fixtures/fake-text.ts`: a monospace `TextEngine` for tests. Each UTF-16 code unit is `0.6 × size` pt wide, and the line height is `run.lineHeight ?? round(1.3 × size)`.
- `measure`: returns a single line, or wraps at `maxWidth` when `wrap !== false`.
- `caretRect(run, w, i)`: `{ x: i·cw, y: 0, height: lh }`.
- `caretFromPoint(run, w, x)`: `clamp(round(x / cw), 0, len)`.
- `selectionRects(run, w, a, b)`: `[{ x: a·cw, y: 0, width: (b − a)·cw, height: lh }]`.
- `atlas`: an `AtlasManager` over `@napi-rs/canvas`.

`test/fixtures/fake-root.ts`: `createFakeRoot(opts?)` returns a `GlassRoot & { tick(dt?: number): void; surfacesMade: FakeSurface[] }` built from real core pieces:
- Theme and scheme come from `defaultTheme` and `'light'`. `anim` is `new AnimationRuntime(theme, scheme)`, layout is `createYogaLayout()`, and `text` is the fake engine.
- `createSurface(o)` returns a `FakeSurface` with:
  - `model` from core `createSurface`, and `root`.
  - `events`, `pointer: new PointerTracker(...)` and `focus: new FocusManager(...)`.
  - `position`, `rotation` and `scale` as `{ x, y, z, set(x, y, z), setScalar(v) }`.
  - `setSize(w, h)`, `billboard`, `trapFocus`, `interactive`, `dispose()`, `disposed`.
- `removeSurface` disposes the Surface and drops it.
- `tick(dt = 1/60)`: for each Surface, lays out its root at its model size (with the measure function built from the fake engine), runs `anim.tick(root, dt, cornerRadius)`, then resolves the `afterTick` waiters.
- `afterTick()`, `on()` (a tiny emitter) and `screenFromPoint(s, x, y)` (returns `{ x, y }` offset by the Surface's `position.x/y`) are provided.
- `pointer` is `{ setActive: vi.fn(), active: null }`.

`test/fixtures/tree.ts`: `tree(n: Node)` returns a compact snapshot `{ type, id?, value?, style?, children? }`. It omits anchors and empty text nodes (they are layout-neutral) unless called with `{ anchors: true }`.

- [ ] **Step 3: Write the failing renderer tests**

`test/renderer.test.ts`:

```ts
import { h, nextTick, ref, Teleport, Fragment, defineComponent } from '@vue/runtime-core'
import { Node, defaultTheme } from '@glassui/core'
import { createGlassRenderer, setStyleLayer } from '../src/renderer'
import { createFakeRoot } from './fixtures/fake-root'
import { tree } from './fixtures/tree'

const mount = (comp: unknown) => {
  const root = createFakeRoot(), container = new Node('box', 'c')
  const app = createGlassRenderer({ root }).createApp(comp as never)
  const errors: unknown[] = []; app.config.errorHandler = e => { errors.push(e) }
  app.mount(container)
  return { root, container, app, errors }
}

describe('nodeOps', () => {
  it('creates host nodes, text and anchors; v-if and v-for keep keyed identity', async () => {
    const show = ref(true), items = ref(['a', 'b', 'c'])
    const { container } = mount(() => h('box', { id: 'outer' }, [
      show.value ? h('text', { id: 't' }, 'hello') : null,
      ...items.value.map(k => h('glass', { key: k, id: k })),
    ]))
    expect(tree(container)).toEqual({ type: 'box', id: 'c', children: [{ type: 'box', id: 'outer', children: [
      { type: 'text', id: 't', value: 'hello' }, { type: 'glass', id: 'a' }, { type: 'glass', id: 'b' }, { type: 'glass', id: 'c' }] }] })
    const b = container.children[0]!.children.find(n => n.id === 'b')!
    items.value = ['c', 'b', 'a']; show.value = false; await nextTick()
    expect(tree(container).children![0]!.children!.map(c => c.id)).toEqual(['c', 'b', 'a'])
    expect(container.children[0]!.children.find(n => n.id === 'b')).toBe(b)          // same Node: moved, not recreated
  })
  it('empty text anchors take no layout space', () => {
    const { container } = mount(() => h(Fragment, [h('box', { id: 'x' })]))
    const anchors = container.children.filter(n => n.type === 'text')
    expect(anchors.length).toBeGreaterThan(0)
    expect(anchors.every(n => n.style.position === 'absolute')).toBe(true)
  })
  it('an unknown element names the allowed tags', () => {
    const { errors } = mount(() => h('div'))
    expect(String(errors[0])).toMatch(/\[renderer\] 未知元素 <div>.*允许值：box, text, image, glass, scroll, portal/)
  })
  it('on* props become element handlers; an unknown event type is an error', async () => {
    const got: string[] = []
    const { container, errors } = mount(() => h('glass', { id: 'g', onClick: () => got.push('click'), onPress: () => got.push('press') }))
    const g = container.children.find(n => n.id === 'g')!
    g.handlers.get('click')!({} as never); g.handlers.get('press')!({} as never)
    expect(got).toEqual(['click', 'press'])
    const bad = mount(() => h('box', { onClik: () => {} }))
    expect(String(bad.errors[0])).toMatch(/\[renderer\] 未知事件 "onClik".*你可能想要：onClick/)
  })
  it('style, tw and class merge (style wins); an equal style patch leaves the node clean', async () => {
    const pad = ref(8)
    const { container } = mount(() => h('box', { id: 'b', tw: 'flex-row p-2', class: 'items-center', style: { padding: pad.value, bg: 'fill' } }))
    const b = container.children.find(n => n.id === 'b')!
    expect(b.style).toMatchObject({ flexDirection: 'row', alignItems: 'center', padding: 8, bg: 'fill' })
    b.dirty = { layout: false, paint: false, text: false, tree: false }
    pad.value = 8; await nextTick()                       // re-render, same style
    expect(b.dirty.paint).toBe(false)
    pad.value = 12; await nextTick()
    expect(b.style.padding).toBe(12); expect(b.dirty.layout).toBe(true)
  })
  it('a style layer composes over the props and survives patches', async () => {
    const w = ref(100)
    const { container } = mount(() => h('box', { id: 'b', style: { width: w.value, opacity: 1 } }))
    const b = container.children.find(n => n.id === 'b')!
    setStyleLayer(b, 'transition', { opacity: 0 })
    w.value = 120; await nextTick()
    expect(b.style).toMatchObject({ width: 120, opacity: 0 })
    setStyleLayer(b, 'transition', null)
    expect(b.style.opacity).toBe(1)
  })
  it('an invalid style reports the prop path', () => {
    const { errors } = mount(() => h('box', { style: { pading: 4 } }))
    expect(String(errors[0])).toMatch(/\[style\] 未知键 "pading".*你可能想要：padding/)
  })
  it('Teleport moves children to a portal by name and to a node object', async () => {
    const target = new Node('box', 'target')
    const C = defineComponent(() => () => h('box', [
      h('portal', { name: 'overlay' }),
      h(Teleport, { to: 'overlay' }, [h('text', { id: 'in-portal' }, 'a')]),
      h(Teleport, { to: target }, [h('text', { id: 'in-target' }, 'b')]),
    ]))
    const { container } = mount(C); await nextTick()
    const portal = container.children[0]!.children.find(n => n.type === 'portal')!
    expect(tree(portal).children!.map(c => c.id)).toEqual(['in-portal'])
    expect(tree(target).children!.map(c => c.id)).toEqual(['in-target'])
  })
  it('removing a focused, pressed node reconciles focus and releases the press (Review Focus 2)', async () => {
    const show = ref(true)
    const { root, container } = mount(() => h('box', show.value ? [h('glass', { id: 'g', tabIndex: 0 })] : []))
    const s = root.createSurface({ width: 100, height: 100 })
    s.root.appendChild(container)                         // the app's tree inside a Surface
    const g = container.children[0]!.children[0]!
    s.focus.focus(g); g.setState({ pressed: true })
    show.value = false; await nextTick()
    s.focus.reconcile()
    expect(s.focus.current).toBeNull()
    expect(() => root.tick()).not.toThrow()
  })
})
```

`test/app.test.ts`:

```ts
it('mount(surface) mounts into its root and provides it; mount() uses a detached container', async () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 200, height: 100 })
  let seen: unknown
  const App = defineComponent(() => { seen = inject(GLASS_SURFACE); return () => h('box', { id: 'x' }) })
  createGlassApp(App, { root }).mount(s as never)
  expect(seen).toBe(s); expect(s.root.children.map(n => n.id)).toEqual(['x'])
  const a2 = createGlassApp(defineComponent(() => () => h('box', { id: 'y' })), { root })
  expect(() => a2.mount()).not.toThrow()
})
it('parent sharing copies provides, components and global properties', () => {
  const parent = createApp({})                      // any Vue app object (runtime-core createRenderer of a DOM-free stub is fine)
  parent.provide('store', 42); parent.component('Hello', defineComponent(() => () => null)); parent.config.globalProperties.$t = (k: string) => k
  let got: unknown
  const App = defineComponent(() => { got = inject('store'); return () => null })
  const app = createGlassApp(App, { root: createFakeRoot(), parent })
  app.mount()
  expect(got).toBe(42); expect(app.component('Hello')).toBeDefined(); expect(app.config.globalProperties.$t).toBeDefined()
})
it('a render error reaches the console and leaves a marker in the container', () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {})
  const app = createGlassApp(defineComponent(() => () => h('nope')), { root: createFakeRoot() })
  const container = new Node('box')
  app.mount(container)
  expect(err).toHaveBeenCalled()
  expect(container.children.some(n => n.id === 'glassui-error' && String(n.props.value).includes('未知元素'))).toBe(true)
  err.mockRestore()
})
```

(`createApp` for the parent: use `createGlassRenderer({ root: createFakeRoot() }).createApp({})`; any `App` works since only `_context` and `config` are read.)

- [ ] **Step 4: Run to verify failure**

Run: `pnpm vitest run packages/vue`
Expected: FAIL — modules not found.

- [ ] **Step 5: Implement `renderer.ts`**

```ts
import { createRenderer, type RendererOptions } from '@vue/runtime-core'
import { GlassUIError, Node, parseTw, validateStyle, UI_EVENT_TYPES, type NodeType, type Style, type UIEventType } from '@glassui/core'
import type { GlassRoot } from './root'

export const HOST_TAGS = ['box', 'text', 'image', 'glass', 'scroll', 'portal'] as const
export type HostTag = (typeof HOST_TAGS)[number]

interface Raw { tw?: string; class?: string; style?: Style; layers: Partial<Record<'control' | 'morph' | 'transition', Style>> }
const raw = new WeakMap<Node, Raw>()
const rawOf = (n: Node): Raw => { let r = raw.get(n); if (!r) { r = { layers: {} }; raw.set(n, r) } return r }

/** Merges `b` over `a`; `glass` and `transition` merge key by key (as effectiveStyle does for state branches). */
function over(a: Style, b: Style | undefined): Style {
  if (!b) return a
  const out: Record<string, unknown> = { ...a }
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined) continue
    out[k] = (k === 'glass' || k === 'transition') && typeof v === 'object' && v && typeof out[k] === 'object' ? { ...(out[k] as object), ...v } : v
  }
  return out as Style
}

/** tw < class < style < control < morph < transition; theme from the root at call time. */
function compose(n: Node, root: GlassRoot): void {
  const r = rawOf(n)
  const tw = [r.tw, r.class].filter(Boolean).join(' ')
  let s: Style = tw ? parseTw(tw, root.theme, 'tw') : {}
  if (r.style) s = over(s, validateStyle(r.style, 'style'))
  s = over(over(over(s, r.layers.control), r.layers.morph), r.layers.transition)
  n.replaceStyle(s)
}

let current: GlassRoot | null = null   // the root of the renderer that last patched (for setStyleLayer's theme)
const owner = new WeakMap<Node, GlassRoot>()

export function setStyleLayer(n: Node, layer: 'control' | 'morph' | 'transition', style: Style | null): void {
  const r = rawOf(n)
  if (style) r.layers[layer] = style; else delete r.layers[layer]
  const root = owner.get(n) ?? current
  if (root) compose(n, root)
}

const EMPTY: Style = { position: 'absolute', width: 0, height: 0 }

export function createGlassRenderer(opts: { root: GlassRoot }) {
  const { root } = opts
  const containers = new Set<Node>()
  const textNode = (t: string) => { const n = new Node('text'); n.setProp('value', t); if (t === '') n.replaceStyle({ position: 'absolute' }); return n }
  const find = (pred: (n: Node) => boolean): Node | null => {
    const roots = [...containers, ...root.surfaces.map(s => s.root)]
    let hit: Node | null = null
    for (const r of roots) { r.walk(n => { if (!hit && pred(n)) hit = n }); if (hit) break }
    return hit
  }
  const ops: RendererOptions<Node, Node> = {
    createElement(tag) {
      if (!(HOST_TAGS as readonly string[]).includes(tag)) throw new GlassUIError('renderer', `未知元素 <${tag}>`, { allowed: HOST_TAGS, got: tag })
      const n = new Node(tag as NodeType); owner.set(n, root); return n
    },
    createText: textNode,
    createComment() { const n = new Node('anchor'); n.replaceStyle(EMPTY); return n },
    setText(n, t) { n.setProp('value', t); if (!rawOf(n).style) n.replaceStyle(t === '' ? { position: 'absolute' } : {}) },
    setElementText(el, t) {
      if (el.type === 'text') { el.setProp('value', t); return }
      for (const c of [...el.children]) c.remove()
      if (t !== '') el.appendChild(textNode(t))
    },
    insert(c, p, a) { p.insertBefore(c, a ?? null) },
    remove(c) { c.remove() },
    parentNode: n => n.parent,
    nextSibling(n) { const p = n.parent; if (!p) return null; const i = p.children.indexOf(n); return p.children[i + 1] ?? null },
    querySelector(sel) { return sel.startsWith('#') ? find(n => n.id === sel.slice(1)) : find(n => n.type === 'portal' && n.props.name === sel) },
    patchProp(el, key, _prev, next) {
      current = root; owner.set(el, root)
      if (/^on[A-Z]/.test(key)) {
        const type = key.slice(2).toLowerCase()
        if (!(UI_EVENT_TYPES as readonly string[]).includes(type)) throw new GlassUIError('renderer', `未知事件 "${key}"`, { allowed: UI_EVENT_TYPES.map(t => `on${t[0]!.toUpperCase()}${t.slice(1)}`), got: key })
        el.setHandler(type as UIEventType, typeof next === 'function' ? next : null)
        return
      }
      if (key === 'style' || key === 'tw' || key === 'class') {
        const r = rawOf(el)
        if (key === 'style') { if (next == null) delete r.style; else r.style = next } else { if (next == null || next === '') delete r[key]; else r[key] = String(next) }
        compose(el, root)
        return
      }
      if (key === 'disabled') el.setState({ disabled: !!next })
      el.setProp(key, next)
    },
  }
  const renderer = createRenderer(ops)
  return { ...renderer, containers }
}
```

`class` values from Vue arrive normalised to a string (`normalizeClass`). `style` arrives as an object, or as an array merged by `normalizeStyle`. Validate after the merge. A `style` that is a string is not supported and throws through `validateStyle` (`[style] …`).

- [ ] **Step 6: Implement `app.ts`, `keys.ts`, `root.ts`, `index.ts`**

```ts
// app.ts
export interface GlassAppOptions { root: GlassRoot; parent?: App; motion?: 'live' | 'frozen'; errorMarker?: boolean; createCanvas?: (w: number, h: number) => CanvasLike }
export interface GlassApp extends App<Node> { mount(target?: Surface | Node): ComponentPublicInstance }

const domCanvas = (w: number, h: number) => Object.assign(document.createElement('canvas'), { width: w, height: h }) as unknown as CanvasLike
const isSurface = (t: unknown): t is Surface => typeof t === 'object' && t !== null && 'model' in t && 'root' in t && (t as Surface).root instanceof Node

export function createGlassApp(component: Component, opts: GlassAppOptions, rootProps?: Record<string, unknown>): GlassApp {
  const { createApp, containers } = createGlassRenderer({ root: opts.root })
  const app = createApp(component, rootProps) as unknown as GlassApp
  app.provide(GLASS_ROOT, opts.root)
  app.provide(GLASS_OPTIONS, { motion: opts.motion ?? 'live', createCanvas: opts.createCanvas ?? domCanvas })
  if (opts.parent) {
    const from = opts.parent._context, to = app._context
    Object.setPrototypeOf(to.provides, from.provides)      // parent provides (Pinia, i18n) visible, own provides win
    Object.assign(to.components, from.components); Object.assign(to.directives, from.directives)
    Object.assign(to.config.globalProperties, from.config.globalProperties)
    to.mixins.push(...from.mixins)
  }
  let container: Node | null = null
  app.config.errorHandler = (err) => {
    console.error('[glassui]', err)
    if (opts.errorMarker !== false && container) showErrorMarker(container, err)
  }
  const mount = app.mount
  app.mount = ((target?: Surface | Node) => {
    container = isSurface(target) ? target.root : target ?? new Node('box', 'glass-app')
    app.provide(GLASS_SURFACE, isSurface(target) ? target : null)
    containers.add(container)
    return mount(container)
  }) as GlassApp['mount']
  return app
}

function showErrorMarker(container: Node, err: unknown): void {
  let n = container.children.find(c => c.id === 'glassui-error')
  if (!n) { n = new Node('text', 'glassui-error'); container.appendChild(n) }
  n.replaceStyle({ position: 'absolute', left: 8, top: 8, maxWidth: 600, padding: 8, bg: 'danger', color: '#ffffff', fontSize: 14, radius: 8 })
  n.setProp('value', `⚠ ${err instanceof Error ? err.message : String(err)}`)
}
```

`index.ts` exports `createGlassApp`, `createGlassRenderer`, `setStyleLayer`, `HOST_TAGS`, the keys, `GlassRoot` and `GlassApp`.

- [ ] **Step 7: Run, typecheck, commit**

Run: `pnpm vitest run packages/vue && pnpm typecheck`
Expected: PASS.

```bash
git add packages/vue package.json pnpm-lock.yaml
git commit -m "feat(vue): custom renderer over core nodes and createGlassApp"
```

---

### Task 7: Component infrastructure — `defineGlassComponent`, prop validation, injection, `GlassTransition`

**Files:**
- Create: `packages/vue/src/{define.ts, validate.ts, inject.ts, transition.ts, motion.ts}`
- Modify: `packages/vue/src/index.ts`
- Test: `packages/vue/test/{define.test.ts, transition.test.ts}`

**Interfaces:**
- Consumes: `GLASS_ROOT`, `GLASS_SURFACE`, `GLASS_OPTIONS`, `setStyleLayer` (Task 6); `AnimationRuntime.whenSettled` (Task 3); `GlassRoot.afterTick` (Task 4).
- Produces:
  - `defineGlassComponent<P extends z.ZodObject>(meta: GlassComponentMeta<P>, setup: (props: ComputedRef<z.output<P>>, ctx: SetupContext) => () => VNodeChild): Component & { readonly glass: GlassComponentMeta<P> }` where

    ```ts
    export interface GlassComponentMeta<P extends z.ZodObject> {
      name: string                                   // PascalCase, e.g. 'Button'
      description: string                            // one paragraph, for the manifest
      props: P                                       // every field .describe('…'); defaults via .default()
      events?: Record<string, { payload: string; description: string }>
      slots?: Record<string, string>
      examples: string[]                             // 2–3 template snippets, each a complete <Comp …> usage
      mistakes?: { mistake: string; fix: string }[]
    }
    ```

  - The registry: `glassComponents(): readonly (Component & { glass: GlassComponentMeta<z.ZodObject> })[]`, in definition order. Task 18's manifest reads it.
  - Prop validation (`validate.ts`): `parseProps(name, schema, raw): z.output` throws `GlassUIError(\`${name}.${path}\`, reason, { allowed?, got? })`:
    - enum or literal failure: reason `非法取值 "x"`, with `allowed` set to the options;
    - wrong type: reason `类型应为 <expected>，得到 <typeof>`, plus a hint `（模板里数字和布尔值要写成 :prop="…"）` when a string was given for a number or boolean;
    - refinement: the zod message.
  - Unknown props: attributes not in the schema, other than `on*`, `class`, `style`, `tw`, `id`, `key` and `ref`, throw `GlassUIError(name, \`未知属性 "${k}"\`, { allowed: <schema keys>, got: k })`. They are checked in `setup` and again on each render.
  - Vue prop declarations come from the schema: `z.boolean()` (optionally wrapped in `.optional()`/`.default()`) → `{ type: Boolean, default: undefined }`; everything else → `{ type: null, default: undefined }`. zod's defaults apply in `parseProps`.
  - `useRoot(): GlassRoot`. Outside `createGlassApp` it throws `GlassUIError('useRoot', '组件必须在 createGlassApp 创建的应用里使用')`. `useSurface(): Surface | null`. `useMotion(): 'live' | 'frozen'`. `useCanvasFactory()`.
  - `useScheme(): Ref<ColorScheme>`: reactive, updated by the root's `theme` event. Components that rasterise colours (Icon) re-render on it.
  - `GlassTransition` (`transition.ts`): props `{ preset?: 'glass' | 'fade' | 'scale' (default 'glass'); appear?: boolean; mode?: 'out-in' | 'in-out' }`, slot default (one child). Presets (spec §8.3 "折射与模糊强度从 0 调制到目标值，同时 scale 0.9→1"):
    - `glass`: from and to `{ opacity: 0, scale: 0.9, glass: { ior: 1, dispersion: 0, roughness: 0.35 } }`;
    - `fade`: `{ opacity: 0 }`;
    - `scale`: `{ opacity: 0, scale: 0.9 }`;
    - every preset adds `transition: { opacity: 'smooth', scale: 'smooth', glass: 'smooth' }` for the keys the user's style has no transition for.
  - The `glass` keys only affect glass nodes. The runtime animates `ior`, `dispersion` and `roughness` (GlassNumericKey).
  - With motion `'frozen'`, every hook calls `done()` synchronously and applies no layer. Visual tests rely on this.

- [ ] **Step 1: Write the failing tests**

`test/define.test.ts`:

```ts
const Btn = defineGlassComponent({
  name: 'Btn', description: 'test',
  props: z.object({ variant: z.enum(['glass', 'filled']).default('glass').describe('look'), size: z.number().default(10).describe('pt'), disabled: z.boolean().default(false).describe('off') }),
  events: { press: { payload: '{}', description: 'pressed' } }, examples: ['<Btn />', '<Btn variant="filled" />'],
}, (p) => () => h('box', { id: 'btn', style: { width: p.value.size } }))

const run = (vnode: () => VNode) => {
  const errors: string[] = []
  const app = createGlassApp(defineComponent(() => vnode), { root: createFakeRoot() })
  app.config.errorHandler = e => { errors.push(String(e)) }
  const c = new Node('box'); app.mount(c)
  return { c, errors }
}

it('validates props with readable errors and suggestions (Review Focus 5)', () => {
  expect(run(() => h(Btn, { variant: 'filed' })).errors[0]).toMatch(/\[Btn\.variant\] 非法取值 "filed"。允许值：glass, filled。你可能想要：filled/)
  expect(run(() => h(Btn, { size: '12' })).errors[0]).toMatch(/\[Btn\.size\] 类型应为 number，得到 string.*:prop/)
  expect(run(() => h(Btn, { colour: 'red' })).errors[0]).toMatch(/\[Btn\] 未知属性 "colour"/)
})
it('casts boolean attributes and applies zod defaults', () => {
  const { c } = run(() => h(Btn, { disabled: '' }))            // <Btn disabled> in a template
  expect(c.children[0]!.style.width).toBe(10)
})
it('registers the component with its metadata', () => {
  expect(glassComponents().map(c => c.glass.name)).toContain('Btn')
})
it('useRoot outside a glass app is a readable error', () => {
  const { errors } = (() => { const app = createGlassRenderer({ root: createFakeRoot() }).createApp(defineComponent(() => { useRoot(); return () => null })); const errs: string[] = []; app.config.errorHandler = e => { errs.push(String(e)) }; app.mount(new Node('box')); return { errors: errs } })()
  expect(errors[0]).toMatch(/\[useRoot\] 组件必须在 createGlassApp/)
})
```

(The last test uses a bare renderer, without the `createGlassApp` provides.)

`test/transition.test.ts` uses the fake root's real `AnimationRuntime` and `tick()`:

```ts
it('enter animates from the preset to the node style, then calls done once', async () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 200, height: 200 })
  const show = ref(false), after: string[] = []
  const App = defineComponent(() => () => h(GlassTransition, { onAfterEnter: () => after.push('entered') }, () => show.value ? [h('glass', { id: 'g', style: { width: 80, height: 40 } })] : []))
  createGlassApp(App, { root }).mount(s as never)
  show.value = true; await nextTick()
  const g = byId(s.root, 'g')!                        // fixture helper (tree.ts): depth-first find by id
  expect(g.style.opacity).toBe(0)
  root.tick(); await flush()                           // records the from-values; the layer comes off
  expect(g.style.opacity).toBeUndefined()
  for (let i = 0; i < 120 && !after.length; i++) { root.tick(); await flush() }
  expect(after).toEqual(['entered'])
})
it('leave cancels a running enter: done runs once, the node goes away (Review Focus 4)', async () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 200, height: 200 })
  const show = ref(false), events: string[] = []
  const App = defineComponent(() => () => h(GlassTransition, { onAfterEnter: () => events.push('entered'), onAfterLeave: () => events.push('left') },
    () => show.value ? [h('glass', { id: 'g', style: { width: 80, height: 40 } })] : []))
  createGlassApp(App, { root }).mount(s as never)
  show.value = true; await nextTick()
  root.tick(); await flush(); root.tick(); await flush()   // the enter is running
  show.value = false; await nextTick()
  for (let i = 0; i < 200 && byId(s.root, 'g'); i++) { root.tick(); await flush() }
  expect(byId(s.root, 'g')).toBeNull()
  for (let i = 0; i < 10; i++) { root.tick(); await flush() }
  expect(events).toEqual(['left'])                     // the cancelled enter never reported
})
it('frozen motion completes synchronously', async () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 200, height: 200 })
  const show = ref(false), events: string[] = []
  const App = defineComponent(() => () => h(GlassTransition, { onAfterEnter: () => events.push('entered') },
    () => show.value ? [h('glass', { id: 'g', style: { width: 80, height: 40, opacity: 1 } })] : []))
  createGlassApp(App, { root, motion: 'frozen' }).mount(s as never)
  show.value = true; await nextTick()
  expect(byId(s.root, 'g')!.style.opacity).toBe(1); expect(events).toEqual(['entered'])
})
```

(`flush` = `await Promise.resolve(); await Promise.resolve()`: the hooks chain two promises per step.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/vue`
Expected: FAIL.

- [ ] **Step 3: Implement**

`validate.ts`:

```ts
export function parseProps<P extends z.ZodObject>(name: string, schema: P, raw: Record<string, unknown>): z.output<P> {
  const input = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined))
  const r = schema.safeParse(input)
  if (r.success) return r.data
  const issue = r.error.issues[0]!
  const path = issue.path.map(String).join('.')
  const scope = path ? `${name}.${path}` : name
  const got = valueAt(input, issue.path)
  if (issue.code === 'invalid_value') throw new GlassUIError(scope, `非法取值 "${show(got)}"`, { allowed: issue.values.map(String), got: show(got) })
  if (issue.code === 'invalid_type') {
    const hint = typeof got === 'string' && (issue.expected === 'number' || issue.expected === 'boolean') ? '（模板里数字和布尔值要写成 :prop="…"）' : ''
    throw new GlassUIError(scope, `类型应为 ${issue.expected}，得到 ${got === null ? 'null' : typeof got}${hint}`)
  }
  throw new GlassUIError(scope, issue.message)
}
```

(`valueAt`/`show` as in `core/style/schema.ts`. Export them from core, or copy the two small helpers.)

`define.ts`:

```ts
const registry: (Component & { glass: GlassComponentMeta<z.ZodObject> })[] = []
export const glassComponents = (): readonly (Component & { glass: GlassComponentMeta<z.ZodObject> })[] => registry

const FALLTHROUGH = new Set(['class', 'style', 'tw', 'id', 'key', 'ref'])
const isBool = (s: z.ZodType): boolean => { let t: z.ZodType = s; while (t instanceof z.ZodOptional || t instanceof z.ZodDefault) t = t.unwrap() as z.ZodType; return t instanceof z.ZodBoolean }

export function defineGlassComponent<P extends z.ZodObject>(meta: GlassComponentMeta<P>, setup: (props: ComputedRef<z.output<P>>, ctx: SetupContext) => () => VNodeChild) {
  const keys = Object.keys(meta.props.shape)
  const props = Object.fromEntries(keys.map(k => [k, isBool(meta.props.shape[k] as z.ZodType) ? { type: Boolean, default: undefined } : { type: null, default: undefined }]))
  const checkAttrs = (attrs: Record<string, unknown>) => {
    for (const k of Object.keys(attrs)) if (!FALLTHROUGH.has(k) && !/^on[A-Z]/.test(k)) throw new GlassUIError(meta.name, `未知属性 "${k}"`, { allowed: keys, got: k })
  }
  const comp = defineComponent({
    name: meta.name, props, emits: Object.keys(meta.events ?? {}),
    setup(raw, ctx) {
      checkAttrs(ctx.attrs)
      const p = computed(() => parseProps(meta.name, meta.props, raw as Record<string, unknown>))
      const render = setup(p, ctx)
      return () => { checkAttrs(ctx.attrs); return render() }
    },
  })
  const out = Object.assign(comp, { glass: meta as unknown as GlassComponentMeta<z.ZodObject> })
  registry.push(out)
  return out as typeof comp & { readonly glass: GlassComponentMeta<P> }
}
```

`inject.ts`: `useRoot`, `useSurface`, `useMotion`, `useCanvasFactory`, and `useScheme()` (a `ref(root.scheme)`, `root.on('theme', …)` updates it, and `onScopeDispose` unsubscribes).

`transition.ts`:

```ts
const PRESETS = {
  glass: { opacity: 0, scale: 0.9, glass: { ior: 1, dispersion: 0, roughness: 0.35 } },
  fade: { opacity: 0 },
  scale: { opacity: 0, scale: 0.9 },
} as const satisfies Record<string, Style>
const CFG: Style['transition'] = { opacity: 'smooth', scale: 'smooth', glass: 'smooth' }

export const GlassTransition = defineComponent({
  name: 'GlassTransition',
  props: { preset: { type: String as PropType<keyof typeof PRESETS>, default: 'glass' }, appear: Boolean, mode: String as PropType<'out-in' | 'in-out'> },
  setup(props, { slots, attrs }) {
    const root = useRoot(), motion = useMotion()
    const token = new WeakMap<Node, number>()
    const bump = (el: Node) => { const t = (token.get(el) ?? 0) + 1; token.set(el, t); return t }
    const cfg = (el: Node): Style => ({ transition: { ...CFG, ...(el.style.transition ?? {}) } })
    const hooks = {
      onBeforeEnter(el: Node) { if (motion === 'live') setStyleLayer(el, 'transition', { ...PRESETS[props.preset], ...cfg(el) }) },
      onEnter(el: Node, done: () => void) {
        if (motion === 'frozen') { done(); return }
        const t = bump(el)
        void root.afterTick().then(() => {
          if (token.get(el) !== t) return
          setStyleLayer(el, 'transition', cfg(el))
          return root.anim.whenSettled(el)
        }).then(() => { if (token.get(el) === t) { setStyleLayer(el, 'transition', null); done() } })
      },
      onEnterCancelled(el: Node) { bump(el) },
      onLeave(el: Node, done: () => void) {
        if (motion === 'frozen') { done(); return }
        const t = bump(el)
        setStyleLayer(el, 'transition', { ...PRESETS[props.preset], ...cfg(el) })
        void root.afterTick().then(() => token.get(el) === t ? root.anim.whenSettled(el) : undefined)
          .then(() => { if (token.get(el) === t) done() })
      },
      onLeaveCancelled(el: Node) { bump(el); setStyleLayer(el, 'transition', null) },
    }
    return () => h(BaseTransition, { ...attrs, appear: props.appear, mode: props.mode, ...hooks }, slots)
  },
})
```

Vue's `BaseTransition` wraps `done` so a cancelled enter's `done` is ignored, and the token keeps the continuation from touching a node that has moved on. Forward the user's `onAfterEnter`/`onAfterLeave` from `attrs`. `BaseTransition` calls them, because they are in the props object passed to it.

- [ ] **Step 4: Run, typecheck, commit**

Run: `pnpm vitest run packages/vue && pnpm typecheck`
Expected: PASS.

```bash
git add packages/vue
git commit -m "feat(vue): defineGlassComponent with zod props, injection helpers and GlassTransition"
```

---

### Task 8: Primitives — Box, Text, Icon, Stack; the playground goes Vue

**Files:**
- Create: `packages/vue/src/components/{Box.ts, Text.ts, Icon.ts, Stack.ts}`, `packages/vue/src/icons.ts`
- Modify: `packages/vue/src/index.ts`
- Test: `packages/vue/test/primitives.test.ts`
- Modify: `examples/playground/package.json` (`vue` 3.5.44, `@vitejs/plugin-vue` 6.0.10, `@glassui/vue`), `examples/playground/vite.config.ts`, `examples/playground/tsconfig.json` (`.vue` shims), `examples/playground/src/main.ts`
- Create: `examples/playground/src/gallery/Gallery.vue`, `examples/playground/src/env.d.ts`

**Interfaces:**
- Consumes: `defineGlassComponent`, `useScheme`, `useCanvasFactory`, `useRoot`.
- Produces (each a `defineGlassComponent` with meta for the manifest):
  - `Box`: no props of its own (style/tw/class fall through); slot default. Renders `h('box', slots.default?.())`.
  - `Text`:
    - props `value?: string | TextFragment[]`, `size?: number | FontSizeToken`, `weight?: 100…900`, `color?: string` (token or `#hex`), `maxLines?: number`, `align?: 'left' | 'center' | 'right'`, `wrap?: boolean`;
    - slot default (plain text);
    - renders `h('text', { style }, value or slot text)`;
    - `TextFragment = { text: string; color?: string; weight?: number; size?: number }`: an array renders a wrapping flex row of text nodes. Fragments do not re-wrap inside each other; that is documented in the description.
  - `Icon`:
    - props `name: IconName` (enum of the built-in set), `size?: number` (default 24), `color?: string` (default `'label'`), `weight?: number` (stroke as a fraction of size, default 0.1);
    - renders `h('image', { src: iconCanvas(name, size, rgba, weight, factory), style: { width: size, height: size, flexShrink: 0 } })`, drawn at 2× size;
    - canvases are cached by `name|size|rgba|weight`;
    - colour tokens resolve against `useScheme()`, so a scheme change redraws.
  - `ICON_NAMES`: the playground's `user, mail, lock, eye, check, x, arrow-right, apple, google`, plus `eye-slash, chevron-left, chevron-right, chevron-up, chevron-down, plus, minus, search, gear, info, warning, star, heart` (SF-Symbols-like strokes on a 24-unit grid). `export function iconCanvas(name, size, rgba, weight, createCanvas): CanvasLike`.
  - `Stack`:
    - props `direction?: 'horizontal' | 'vertical' | 'z'` (default `'vertical'`), `gap?: number` (pt, default 8), `align?: 'start' | 'center' | 'end' | 'stretch'`, `justify?: 'start' | 'center' | 'end' | 'between'`, `wrap?: boolean`;
    - `z` wraps each child in an absolutely positioned box with `inset: 0`.
- Playground:
  - `?scene=gallery` mounts `Gallery.vue` with `createGlassApp(Gallery, { root, motion })` into a full-screen screen Surface (`root.createSurface({ fill: true, background: 'none' })`);
  - `motion` comes from `?motion=frozen|live` (default `live`; the harness passes `frozen`);
  - the other scenes stay as they are until Task 19;
  - Vite: `vue({ template: { compilerOptions: { isCustomElement: tag => ['box', 'text', 'image', 'glass', 'scroll', 'portal'].includes(tag) } } })`.

- [ ] **Step 1: Write the failing tests**

```ts
it('Text renders a text node with its typography', () => {
  const { c } = mountGlass(() => h(Text, { value: '你好', size: 20, weight: 600, color: 'secondaryLabel' }))
  const t = first(c, 'text')
  expect(t.props.value).toBe('你好'); expect(t.style).toMatchObject({ fontSize: 20, fontWeight: 600, color: 'secondaryLabel' })
})
it('Text takes slot text', () => {
  const { c } = mountGlass(() => h(Text, null, () => 'from slot'))
  expect(first(c, 'text').props.value).toBe('from slot')
})
it('Text fragments render as a wrapping row of runs', () => {
  const { c } = mountGlass(() => h(Text, { value: [{ text: 'A ' }, { text: 'link', color: 'accent', weight: 700 }] }))
  const row = first(c, 'box'); expect(row.style).toMatchObject({ flexDirection: 'row', flexWrap: 'wrap' })
  expect(row.children.map(n => n.props.value)).toEqual(['A ', 'link'])
})
it('Icon rasterises at 2× into a cached canvas; an unknown name suggests (Review Focus 5)', () => {
  const { c } = mountGlass(() => h('box', [h(Icon, { name: 'check', size: 20 }), h(Icon, { name: 'check', size: 20 })]))
  const [a, b] = c.children[0]!.children.filter(n => n.type === 'image')
  expect((a!.props.src as { width: number }).width).toBe(40); expect(a!.props.src).toBe(b!.props.src)
  expect(mountGlass(() => h(Icon, { name: 'chek' })).errors[0]).toMatch(/\[Icon\.name\] 非法取值 "chek".*你可能想要：check/)
})
it('Stack maps direction, gap, align and justify; z stacks children', () => {
  const { c } = mountGlass(() => h(Stack, { direction: 'horizontal', gap: 12, align: 'center', justify: 'between' }, () => [h(Box), h(Box)]))
  expect(first(c, 'box').style).toMatchObject({ flexDirection: 'row', gap: 12, alignItems: 'center', justifyContent: 'space-between' })
  const z = mountGlass(() => h(Stack, { direction: 'z' }, () => [h(Box), h(Box)])).c
  expect(first(z, 'box').children.every(w => w.style.position === 'absolute' && w.style.inset === 0)).toBe(true)
})
```

(`mountGlass(render)` is a test helper (`fixtures/mount.ts`): `createGlassApp` with a fake root, a `@napi-rs/canvas` factory and an `errorHandler` that collects errors; it returns `{ c, errors, root }`. `first(c, type)` is a depth-first find.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/vue/test/primitives.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the components and the icon set**

Port `examples/playground/src/icons.ts` into `packages/vue/src/icons.ts` (keep its stroke style) and add the new names on the same 24-unit grid with round caps and joins. Keep `knobCanvas` there too (the Switch uses it in Task 11). Each component's `examples` holds 2–3 snippets, e.g. for `Icon`: `<Icon name="check" :size="20" color="accent" />`, and its `mistakes`: `{ mistake: 'size="20" (a string)', fix: ':size="20"' }`, `{ mistake: 'name="close"', fix: 'name="x"' }`.

```ts
// Text.ts (shape)
const Fragment = z.object({ text: z.string(), color: z.string().optional(), weight: z.number().int().min(100).max(900).optional(), size: z.number().optional() }).strict()
export const Text = defineGlassComponent({
  name: 'Text',
  description: '一段文字（支持中文与系统字体回退）。value 或默认插槽给出内容；value 也可以是片段数组（各自颜色/字重，按行排成可换行的一排，片段内部不再跨片段重排）。不可选择、不可编辑：输入用 Input。',
  props: z.object({
    value: z.union([z.string(), z.array(Fragment)]).optional().describe('文字内容；省略时用默认插槽的纯文本'),
    size: z.union([z.number().positive(), z.string()]).optional().describe('字号，pt 数字或 fontSize token（xs/sm/base/lg/xl/2xl/3xl/4xl）'),
    weight: z.number().int().min(100).max(900).optional().describe('字重 100–900'),
    color: z.string().optional().describe('颜色 token（label、secondaryLabel、accent…）或 #hex'),
    maxLines: z.number().int().min(1).optional().describe('最多行数，超出以 … 截断'),
    align: z.enum(['left', 'center', 'right']).optional().describe('对齐'),
    wrap: z.boolean().optional().describe('是否在宽度处换行（默认 true）'),
  }),
  slots: { default: '纯文本内容（value 省略时）' },
  examples: ['<Text value="创建账号" :size="24" :weight="700" />', '<Text color="secondaryLabel" :max-lines="2">很长的说明文字…</Text>', '<Text :value="[{ text: \'已有账号？\' }, { text: \'登录\', color: \'accent\', weight: 600 }]" />'],
  mistakes: [{ mistake: 'size="20"', fix: ':size="20"（数字要绑定）' }, { mistake: '<Text>{{ a }}<Icon /></Text>', fix: 'Text 只放文字；图标与文字并排用 Stack direction="horizontal"' }],
}, (p, { slots }) => () => {
  const v = p.value
  const style = textStyle(v)
  if (Array.isArray(v.value)) return h('box', { style: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline' } }, v.value.map(f => h('text', { style: { ...style, ...frag(f) } }, f.text)))
  return h('text', { style }, v.value ?? slotText(slots.default?.()))
})
```

`slotText(vnodes)` concatenates the string children of text vnodes, and throws `GlassUIError('Text', '默认插槽只能是纯文本')` for non-text children.

Playground:
- Add the dependencies and the Vite plugin, and an `env.d.ts` with `declare module '*.vue'`.
- `main.ts` handles `scene === 'gallery'`:
  - creates a fill screen Surface and mounts `createGlassApp(Gallery, { root, motion: params.get('motion') === 'frozen' ? 'frozen' : 'live' })` into it;
  - extends the `window.__glassui` handle with `rectOf(id)`, which returns the CSS px rect of a node by id in any Surface, via `absoluteRect` and `root.screenFromPoint` on its corners (the harness uses it to hover and press).
- `Gallery.vue` starts with a "Primitives" section: Texts in several sizes and colours, including Chinese, an icon strip of every icon, and Stacks. Later tasks add sections.

- [ ] **Step 4: Run, typecheck, build, commit**

Run: `pnpm vitest run packages/vue && pnpm typecheck && pnpm playground:build`
Expected: PASS / exit 0.

```bash
git add packages/vue examples/playground pnpm-lock.yaml
git commit -m "feat(vue): Box, Text, Icon, Stack; a Vue gallery scene in the playground"
```

---

### Task 9: `<Surface>`, `<ScreenLayer>`, `<WorldLayer>`

**Files:**
- Create: `packages/vue/src/components/Surface.ts`
- Test: `packages/vue/test/surface.test.ts`
- Modify: `examples/playground/src/gallery/Gallery.vue` (a small world-layer Surface beside the gallery, rotated)

**Interfaces:**
- Consumes: `GlassRoot.createSurface/removeSurface`, `Surface` fields (`position`, `rotation`, `scale`, `setSize`, `billboard`, `interactive`), `GLASS_SURFACE`.
- Produces:
  - `Surface` (component) props:
    - placement: `layer?: 'screen' | 'world'` (default: the nearest `<ScreenLayer>`/`<WorldLayer>`, else `'world'`), `width: number`, `height: number`, `fill?: boolean`, `left?: number`, `top?: number`, `center?: boolean` (screen layer);
    - transform: `position?: [number, number, number]`, `rotation?: [number, number, number]` (radians, XYZ), `scale?: number | [number, number, number]` (world layer);
    - look: `background?: 'none' | 'glass' | string` (default `'none'`), `radius?: number` (cornerRadius, pt), `billboard?: boolean`, `interactive?: boolean` (default true), `ptPerUnit?: number` (world), `contentScale?: number`;
    - slot default (the Surface's content);
    - events: `error` (payload `Error`).
  - It creates the Surface in `setup`, applies the props in a `watchEffect` (size → `setSize`, transform → `position.set`, `rotation.set`, `scale`), provides `GLASS_SURFACE`, renders `h(Teleport, { to: surface.root }, slots.default?.())`, and calls `root.removeSurface(surface)` in `onBeforeUnmount`. A placement change (`layer`, `fill`, `left`, `top`, `center`) recreates the Surface. Changing the `background` also recreates it (the Surface fixes it at creation).
  - `ScreenLayer` and `WorldLayer`: components that provide the default layer to their subtree and render their slot.
  - Not in Phase 1: `shadow` (`castToWorld` has no effect yet). The description says so.

- [ ] **Step 1: Write the failing tests**

```ts
it('creates a world Surface, teleports its slot into it, and applies the transform', async () => {
  const root = createFakeRoot()
  const pos = ref<[number, number, number]>([0, 1.5, -2])
  mountGlass(() => h(Surface, { width: 400, height: 300, position: pos.value, rotation: [0, -0.3, 0], background: 'glass' }, () => [h(Text, { value: 'hi' })]), { root })
  const s = root.surfacesMade[0]!
  expect(s.model).toMatchObject({ width: 400, height: 300, background: 'glass', placement: 'world' })
  expect([s.position.x, s.position.y, s.position.z]).toEqual([0, 1.5, -2]); expect(s.rotation.y).toBeCloseTo(-0.3)
  expect(first(s.root, 'text').props.value).toBe('hi')
  pos.value = [1, 1, 1]; await nextTick(); expect(s.position.x).toBe(1)
})
it('ScreenLayer makes its Surfaces screen Surfaces; fill/left/top/center pass through', () => {
  const root = createFakeRoot()
  mountGlass(() => h(ScreenLayer, () => [h(Surface, { width: 200, height: 100, center: true })]), { root })
  expect(root.surfacesMade[0]!.created).toMatchObject({ layer: 'screen', center: true })
})
it('unmounting removes the Surface; a size change resizes it', async () => {
  const root = createFakeRoot(), show = ref(true), w = ref(200)
  mountGlass(() => show.value ? h(Surface, { width: w.value, height: 100 }) : null, { root })
  const s = root.surfacesMade[0]!
  w.value = 300; await nextTick(); expect(s.model.width).toBe(300)
  show.value = false; await nextTick(); expect(s.disposed).toBe(true); expect(root.surfaces).not.toContain(s)
})
it('children see their Surface through useSurface', () => {
  const root = createFakeRoot(); let seen: unknown
  const Probe = defineComponent(() => { seen = useSurface(); return () => null })
  mountGlass(() => h(Surface, { width: 10, height: 10 }, () => [h(Probe)]), { root })
  expect(seen).toBe(root.surfacesMade[0])
})
```

(`FakeSurface.created` records the options `createSurface` was called with.)

- [ ] **Step 2: Run to verify failure, implement, run again**

Run: `pnpm vitest run packages/vue/test/surface.test.ts` (FAIL), implement `Surface.ts` as specified, run again (PASS).

```ts
const LAYER: InjectionKey<'screen' | 'world'> = Symbol('glassui.layer')
export const ScreenLayer = defineComponent({ name: 'ScreenLayer', setup(_, { slots }) { provide(LAYER, 'screen'); return () => slots.default?.() } })
export const WorldLayer = defineComponent({ name: 'WorldLayer', setup(_, { slots }) { provide(LAYER, 'world'); return () => slots.default?.() } })

export const Surface = defineGlassComponent({ name: 'Surface', description: '…', props: SurfaceProps, events: { error: { payload: 'Error', description: '该 Surface 的渲染失败（它已停止绘制）' } }, slots: { default: 'Surface 的内容' }, examples: [ /* world panel; screen HUD fill; centred card */ ] },
(p, { slots, emit }) => {
  const root = useRoot(), layer = inject(LAYER, 'world')
  const key = computed(() => JSON.stringify({ layer: p.value.layer ?? layer, fill: p.value.fill, left: p.value.left, top: p.value.top, center: p.value.center, background: p.value.background, ptPerUnit: p.value.ptPerUnit }))
  const surface = shallowRef<Surface>()
  watch(key, () => {
    if (surface.value) root.removeSurface(surface.value)
    const v = p.value, l = v.layer ?? layer
    surface.value = root.createSurface({ layer: l, width: v.width, height: v.height, background: v.background ?? 'none', cornerRadius: v.radius ?? 0, interactive: v.interactive ?? true, billboard: v.billboard ?? false, ...defined({ fill: v.fill, left: v.left, top: v.top, center: v.center, ptPerUnit: v.ptPerUnit, contentScale: v.contentScale }) })
  }, { immediate: true })
  watchEffect(() => {
    const s = surface.value!, v = p.value
    if (s.model.width !== v.width || s.model.height !== v.height) s.setSize(v.width, v.height)
    if (v.position) s.position.set(...v.position)
    if (v.rotation) s.rotation.set(...v.rotation)
    if (v.scale !== undefined) typeof v.scale === 'number' ? s.scale.setScalar(v.scale) : s.scale.set(...v.scale)
    s.interactive = v.interactive ?? true; s.billboard = v.billboard ?? false
  })
  // forward Surface errors to @error (removed with the Surface)
  provide(GLASS_SURFACE, surface as never)     // consumers read `.value` through useSurface (see inject.ts)
  onBeforeUnmount(() => { if (surface.value) root.removeSurface(surface.value) })
  return () => h(Teleport, { to: surface.value!.root }, slots.default?.())
})
```

`useSurface()` unwraps a provided ref, so a Surface that is recreated is seen by later reads.

- [ ] **Step 3: Typecheck, build, commit**

Run: `pnpm typecheck && pnpm playground:build`
Expected: exit 0.

```bash
git add packages/vue examples/playground
git commit -m "feat(vue): <Surface> with screen/world layers, teleporting its slot into a render Surface"
```

---
### Task 10: `useGlassControl` and `<Button>` — visual checkpoint 3

**Files:**
- Create: `packages/vue/src/control.ts`, `packages/vue/src/components/Button.ts`, `packages/vue/src/colors.ts`
- Test: `packages/vue/test/button.test.ts`
- Modify: `examples/playground/src/gallery/Gallery.vue` (Buttons section)

**Interfaces:**
- Consumes: Task 2 handlers, `focusVisible`; Task 6 `setStyleLayer`; `GlassRoot.anim.reducedMotion`; `useMotion`.
- Produces:
  - `useGlassControl(el: Ref<Node | undefined>, opts: { disabled: Ref<boolean>; onActivate(e: { pointerType: PointerType | 'keyboard' }): void; tilt?: boolean; lift?: number }): { handlers: Record<string, (e: UIEvent) => void>; pressing: Ref<boolean> }`. The `handlers` object goes onto the control's host node: `onPointerenter`, `onPointermove`, `onPointerleave`, `onPointerdown`, `onPointerup`, `onPointercancel`, `onClick`, `onKeydown`, `onKeyup`. Behaviour (spec §8.3):
    - hover with a mouse or pen lifts the node by `lift` (default 6 pt) and tilts it toward the pointer, at most 3° (0.052 rad) about each axis;
    - with `anim.reducedMotion`, or `tilt === false`, there is no tilt; touch never tilts;
    - leaving the node resets the lift and the tilt;
    - `click` activates;
    - `Enter` on keydown activates; `Space` presses the node visually (`setState({ pressed: true })`) on keydown and activates on keyup;
    - a disabled control ignores everything.
  - `controlStyle(opts: { pressScale?: number }): Style` returns `{ transition: { scale: 'snappy', elevation: 'snappy', tilt: 'snappy' }, pressed: { scale: pressScale ?? 0.96 }, hover: { glass: { specularIntensity: 1.35, edgeGlow: 1.1 } } }` (the glint).
  - `colors.ts`: `glowingTint(theme, scheme): string` gives the accent lifted 15 % toward white as `#rrggbb` (the playground's `GLOWING.tint` for the default accent). `withAlpha(token | hex, a, theme, scheme): string` gives a `rgba(…)` literal.
  - `Button` props:
    - `variant?: 'glass' | 'glassProminent' | 'filled' | 'tinted' | 'plain'` (default `'glass'`)
    - `size?: 'small' | 'regular' | 'large'` (default `'regular'`)
    - `shape?: 'capsule' | 'roundedRectangle' | 'circle'` (default `'capsule'`)
    - `label?: string`, `leadingIcon?: IconName`, `trailingIcon?: IconName`
    - `loading?: boolean`, `disabled?: boolean`
    - `fullWidth?: boolean` (`alignSelf: 'stretch'`)
    - `glassId?: string` (Task 17)
  - Its events are `press` (payload `{ pointerType }`). Its slots are `default` (replaces the label), `leading` and `trailing`.
  - Size table (height / font / padX / icon / gap):

    | size | height | font | padX | icon | gap |
    |---|---|---|---|---|---|
    | small | 36 | 15 | 14 | 18 | 6 |
    | regular | 52 | 18 | 20 | 22 | 8 |
    | large | 80 | 25 | 26 (`metrics.controlPadding`) | 28 (`metrics.icon`) | 12 (`metrics.groupGap`) |

  - Variants (spec §8.3):

    | variant | host | glass / background | label |
    |---|---|---|---|
    | glass | `glass` | clear (theme glass) | `label`, weight 600 |
    | glassProminent | `glass` | `glow: { color: 'accent', strength: 1.1 }`, `tint: glowingTint`, `absorption: 1.4` | `#ffffff`, weight 700 |
    | filled | `box` | `bg: 'accent'`; pressed `opacity: 0.85` | `#ffffff`, weight 600 |
    | tinted | `box` | `bg: withAlpha('accent', 0.15)` | `accent`, weight 600 |
    | plain | `box` | none; pressed `opacity: 0.55` | `accent`, weight 600 |

  - Shapes:
    - `capsule` → `radius: 'capsule'`;
    - `roundedRectangle` → `radius: round(height × 0.23)`;
    - `circle` → width = height and `radius: 'capsule'`; the label must be absent, so a `circle` with a `label` throws `GlassUIError('Button.shape', 'circle 只能放图标（去掉 label 或改 shape）')`.
  - `loading`:
    - the content becomes three 6 pt dots, one bright at a time;
    - the bright dot steps every 300 ms on a timer while `motion === 'live'`; with `'frozen'` the middle dot is bright;
    - the Button is inert while loading (no press, `aria`-like `busy` prop on the node: `props.busy = true`).
  - `disabled` sets the node's `disabled` state, `tabIndex -1` and `opacity: 0.4`.

- [ ] **Step 1: Write the failing tests**

```ts
it('glassProminent is glowing glass with a white label; glass is clear', () => {
  const { c } = mountGlass(() => h(Stack, () => [h(Button, { variant: 'glassProminent', label: 'Create account', size: 'large' }), h(Button, { label: 'Cancel' })]))
  const [p, g] = all(c, 'glass')
  expect(p!.style.glass).toMatchObject({ glow: { color: 'accent', strength: 1.1 }, absorption: 1.4 })
  expect(p!.style.height).toBe(80); expect(first(p!, 'text').style.color).toBe('#ffffff')
  expect(g!.style.glass?.glow).toBeUndefined(); expect(g!.style.height).toBe(52)
})
it('press fires on click and Enter, not when disabled or loading', async () => {
  const got: string[] = [], disabled = ref(false), loading = ref(false)
  const { c } = mountGlass(() => h(Button, { label: 'Go', disabled: disabled.value, loading: loading.value, onPress: (e: { pointerType: string }) => got.push(e.pointerType) }))
  const b = first(c, 'glass')
  fire(b, 'click', { pointerType: 'mouse' }); fire(b, 'keydown', { key: 'Enter' })
  disabled.value = true; await nextTick(); fire(b, 'click')
  disabled.value = false; loading.value = true; await nextTick(); fire(b, 'click')
  expect(got).toEqual(['mouse', 'keyboard'])
  expect(b.props.busy).toBe(true)
})
it('Space presses visually on keydown and activates on keyup', () => {
  let n = 0
  const { c } = mountGlass(() => h(Button, { label: 'Go', onPress: () => n++ }))
  const b = first(c, 'glass')
  fire(b, 'keydown', { key: ' ' }); expect(b.state.pressed).toBe(true); expect(n).toBe(0)
  fire(b, 'keyup', { key: ' ' }); expect(b.state.pressed).toBe(false); expect(n).toBe(1)
})
it('hover lifts and tilts toward a mouse, never a finger; reduced motion keeps it flat', () => {
  const root = createFakeRoot()
  const { c } = mountGlass(() => h(Button, { label: 'Go' }), { root })
  const b = first(c, 'glass'); b.layout = { x: 0, y: 0, width: 200, height: 52 }
  fire(b, 'pointerenter', { pointerType: 'mouse' }); fire(b, 'pointermove', { pointerType: 'mouse', localX: 200, localY: 0 })
  expect(b.elevation).toBe(6); expect(Math.abs(b.tilt.y)).toBeCloseTo(0.052, 3); expect(Math.abs(b.tilt.x)).toBeCloseTo(0.052, 3)
  fire(b, 'pointerleave', { pointerType: 'mouse' }); expect(b.elevation).toBe(0); expect(b.tilt).toEqual({ x: 0, y: 0 })
  fire(b, 'pointerenter', { pointerType: 'touch' }); fire(b, 'pointermove', { pointerType: 'touch', localX: 200, localY: 0 }); expect(b.tilt).toEqual({ x: 0, y: 0 })
  root.anim.reducedMotion = true
  fire(b, 'pointermove', { pointerType: 'mouse', localX: 200, localY: 0 }); expect(b.tilt).toEqual({ x: 0, y: 0 })
})
it('rejects a circle with a label and an unknown variant', () => {
  expect(mountGlass(() => h(Button, { shape: 'circle', label: 'x' })).errors[0]).toMatch(/\[Button\.shape\] circle 只能放图标/)
  expect(mountGlass(() => h(Button, { variant: 'primary' })).errors[0]).toMatch(/\[Button\.variant\].*允许值：glass, glassProminent, filled, tinted, plain/)
})
it('loading dots: the middle one is bright with frozen motion', () => {
  const { c } = mountGlass(() => h(Button, { label: 'Go', loading: true }), { motion: 'frozen' })
  const dots = all(c, 'box').filter(n => n.props.dot !== undefined)
  expect(dots.map(d => d.style.opacity)).toEqual([0.35, 1, 0.35])
})
```

(`fire(node, type, init)` builds a `UIEvent` (`target = currentTarget = node`, `x`, `y`, `localX`, `localY`, `pointerType`, `key`, `stopPropagation`) and calls `node.handlers.get(type)`. Add it to the fixtures.)

- [ ] **Step 2: Run to verify failure, implement, run again**

Run: `pnpm vitest run packages/vue/test/button.test.ts` (FAIL). Implement `control.ts`, `colors.ts`, `Button.ts` as specified, then run again (PASS).

```ts
// control.ts (core of it)
const MAX_TILT = 0.052   // 3°
export function useGlassControl(el: Ref<Node | undefined>, opts: { disabled: Ref<boolean>; onActivate(e: { pointerType: PointerType | 'keyboard' }): void; tilt?: boolean; lift?: number }) {
  const root = useRoot(), pressing = ref(false)
  const hoverable = (t: PointerType) => t === 'mouse' || t === 'pen'
  const reset = () => { const n = el.value; if (n) { n.elevation = 0; n.tilt = { x: 0, y: 0 } } }
  const handlers = {
    onPointerenter(e: UIEvent) { if (!opts.disabled.value && hoverable(e.pointerType) && el.value) el.value.elevation = opts.lift ?? 6 },
    onPointermove(e: UIEvent) {
      const n = el.value
      if (!n || opts.disabled.value || !hoverable(e.pointerType) || opts.tilt === false || root.anim.reducedMotion) return
      if (!(n.layout.width > 0 && n.layout.height > 0)) return
      const u = Math.max(0, Math.min(1, e.localX / n.layout.width)) - 0.5, v = Math.max(0, Math.min(1, e.localY / n.layout.height)) - 0.5
      n.tilt = { x: -v * 2 * MAX_TILT, y: u * 2 * MAX_TILT }
    },
    onPointerleave() { reset() },
    onPointerdown() { if (!opts.disabled.value) pressing.value = true },
    onPointerup() { pressing.value = false },
    onPointercancel() { pressing.value = false },
    onClick(e: UIEvent) { if (!opts.disabled.value) opts.onActivate({ pointerType: e.pointerType }) },
    onKeydown(e: UIEvent) {
      if (opts.disabled.value) return
      if (e.key === 'Enter') opts.onActivate({ pointerType: 'keyboard' })
      if (e.key === ' ') { el.value?.setState({ pressed: true }); pressing.value = true }
    },
    onKeyup(e: UIEvent) {
      if (e.key !== ' ') return
      el.value?.setState({ pressed: false }); pressing.value = false
      if (!opts.disabled.value) opts.onActivate({ pointerType: 'keyboard' })
    },
  }
  return { handlers, pressing }
}
```

Button: build the style from the variant/size/shape tables, merge `controlStyle()`, put `tabIndex` and `busy` on the host, put the `handlers` on it, and render the children: leading (slot or Icon), label (slot or Text), trailing. For the loading dots, a `setInterval` while loading and live motion is cleared on unmount or when loading ends. The description and examples go in the meta. The examples include the reference's primary action: `<Button variant="glassProminent" size="large" label="Create account" trailing-icon="arrow-right" full-width @press="submit" />`.

- [ ] **Step 3: Gallery and the visual checkpoint**

Add a "Buttons" section to `Gallery.vue`: every variant in every size, a disabled and a loading Button, icon-only `circle`s, a `roundedRectangle`, and Chinese labels. `pnpm typecheck && pnpm playground:build` must pass.

**Visual checkpoint 3 (controller):** open `?scene=gallery` in Chrome on WebGPU and `&webgl`, high and minimal. Check:
- glassProminent matches the reference's primary pill;
- glass buttons are clear with rims;
- hover lifts and tilts and the press scales to 0.96;
- the Tab key shows the focus ring and a pointer press does not;
- disabled reads as disabled;
- no console errors.

The controller writes a findings sheet for anything off; the implementer fixes it in the review loop.

- [ ] **Step 4: Commit**

```bash
git add packages/vue examples/playground
git commit -m "feat(vue): useGlassControl and <Button> (five variants, three sizes, shapes, loading)"
```

---

### Task 11: `<Switch>` and `<Checkbox>`

**Files:**
- Create: `packages/vue/src/components/{Switch.ts, Checkbox.ts}`
- Test: `packages/vue/test/toggles.test.ts`
- Modify: `examples/playground/src/gallery/Gallery.vue`

**Interfaces:**
- Consumes: `useGlassControl`, `controlStyle`, `knobCanvas`, `Icon`, `GlassTransition`, `glowingTint`, Task 3 `glowSplit`.
- Produces:
  - `Switch`:
    - props `checked?: boolean` (`v-model:checked`), `disabled?: boolean`, `label?: string`;
    - events `update:checked` (boolean), `change` (boolean);
    - the label slot, or `label`, renders to the switch's left, right-aligned (the reference's "Remember me").
    - Geometry (spec §8.2): 136 × 62 capsule glass; knob 48 at margin 7, drawn as a flat decal (an `image`, as in the playground); knob centre `x = W/2 ± (W/2 − margin − knob/2)`.
    - On: `glass: { glow: { color: 'accent', strength: 1.1, split: 0.5 + knobX/W }, tint: glowingTint, absorption: 1.4 }`. Off: the same glow with `strength: 0` and `split: 0.5 − knobX/W`, no tint.
    - `transition: { glass: 'smooth', … controlStyle }`, so glow strength and split animate.
    - The knob's `left` changes with `transition: { x: 'snappy', width: 'snappy' }`.
    - While pressing, the knob widens to 58 pt and keeps its outer edge (press stretch).
    - Click, Enter and Space toggle.
  - `Checkbox`:
    - props `checked?: boolean` (`v-model:checked`), `indeterminate?: boolean`, `disabled?: boolean`, `label?: string`;
    - events `update:checked`, `change`; slot `default` for the label.
    - A 44 × 44 radius-12 clear glass button (`glass: { thickness: 14, fillet: 4, filletBottom: 2 }`, press scale 0.9).
    - Contains `Icon name="check"` (or `minus` when indeterminate), size 30, colour `accent`, in a `GlassTransition preset="scale"`.
    - The row (box + label) is the activation target: clicking the label toggles. `indeterminate` shows `minus` regardless of `checked`, and toggling clears it (emits `update:checked: true`; the parent clears `indeterminate`).

- [ ] **Step 1: Write the failing tests**

```ts
it('Switch toggles through v-model and moves the knob with a transition', async () => {
  const on = ref(false)
  const { c } = mountGlass(() => h(Switch, { checked: on.value, 'onUpdate:checked': (v: boolean) => { on.value = v } }))
  const sw = first(c, 'glass'), knob = first(sw, 'image')
  const offLeft = knob.style.left
  fire(sw, 'click'); await nextTick()
  expect(on.value).toBe(true)
  expect(knob.style.left).toBeGreaterThan(offLeft as number)
  expect(knob.style.transition).toMatchObject({ x: 'snappy' })
  expect(sw.style.glass).toMatchObject({ glow: { color: 'accent', strength: 1.1 } })
  fire(sw, 'keydown', { key: 'Enter' }); await nextTick(); expect(on.value).toBe(false)
  expect(sw.style.glass?.glow?.strength).toBe(0)
})
it('Switch knob stretches while pressed, keeping its outer edge', async () => {
  const { c } = mountGlass(() => h(Switch, { checked: true }))
  const sw = first(c, 'glass'), knob = first(sw, 'image')
  const right = (knob.style.left as number) + (knob.style.width as number)
  fire(sw, 'pointerdown', { pointerType: 'mouse' }); await nextTick()
  expect((knob.style.width as number)).toBeGreaterThan(48 + 8)
  expect((knob.style.left as number) + (knob.style.width as number)).toBe(right)
})
it('Checkbox shows a check, or a dash when indeterminate; the label toggles too', async () => {
  const v = ref(false)
  const { c } = mountGlass(() => h(Checkbox, { checked: v.value, label: '同意条款', 'onUpdate:checked': (x: boolean) => { v.value = x } }))
  expect(all(c, 'image')).toHaveLength(0)
  fire(first(c, 'text'), 'click'); await nextTick()
  expect(v.value).toBe(true); expect(all(c, 'image')).toHaveLength(1)
  const d = mountGlass(() => h(Checkbox, { checked: false, indeterminate: true })).c
  expect(all(d, 'image')).toHaveLength(1)                       // the minus icon
})
```

(For the label click to reach the row's handler, put the handler on the row container; the label text's click bubbles to it via `dispatch`. In the test, call the row container's handler directly, or `fire` with bubbling through a test `EventDispatcher`. Pick one and keep it consistent across tasks.)

- [ ] **Step 2: Run to verify failure, implement, run again, gallery, commit**

Run: `pnpm vitest run packages/vue/test/toggles.test.ts`. Implement. Add the Switches and Checkboxes to the gallery (on, off, disabled, with Chinese labels). Then `pnpm typecheck && pnpm playground:build`.

```bash
git add packages/vue examples/playground
git commit -m "feat(vue): <Switch> with a glowing split track and stretching knob, <Checkbox> with indeterminate"
```

---

### Task 12: `ImeBridge` — the proxy textarea (render)

**Files:**
- Create: `packages/render/src/ime.ts`
- Modify: `packages/render/src/root.ts` (`root.ime`, reposition per tick, dispose), `packages/render/src/index.ts` (public export), `packages/render/test/exports.test.ts`
- Modify: `packages/vue/src/root.ts` (`GlassRoot` adds `'ime'`)
- Test: `packages/render/test/ime.test.ts`

**Interfaces:**
- Consumes: `UIRoot.screenFromPoint` (Task 4), `Surface.focus` (`FocusManager.key` for Tab), `PointerBridge.setActive`.
- Produces:

```ts
/** What an editable node hands the bridge (the Input component implements it). */
export interface ImeField {
  surface: Surface
  value: string
  selectionStart: number
  selectionEnd: number
  /** 'text' | 'password' | 'number': the proxy's `type`/`inputMode` (number → inputmode="decimal"). */
  kind: 'text' | 'password' | 'number'
  /** The caret's rect in Surface pt (x, y = top, height): where the proxy and the IME candidate window go. */
  caret(): { x: number; y: number; height: number }
  /** The proxy's state after every edit, selection move or composition step. */
  onChange(s: ImeState): void
  /** Keys the field handles itself: Enter (submit), Escape (blur). `handled` → the bridge prevents the default. */
  onKey(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean
  /** The proxy lost focus to something outside the canvas UI (another page element, the window). */
  onBlur(): void
}
export interface ImeState { value: string; selectionStart: number; selectionEnd: number; composition: { start: number; end: number } | null }

export interface DocLike { createElement(tag: 'textarea'): TextareaLike; body: { appendChild(n: unknown): void; removeChild(n: unknown): void }; addEventListener(t: string, fn: () => void): void; removeEventListener(t: string, fn: () => void): void; activeElement: unknown }
export interface TextareaLike { value: string; selectionStart: number; selectionEnd: number; style: Record<string, string>; setAttribute(k: string, v: string): void; addEventListener(t: string, fn: (e: any) => void): void; removeEventListener(t: string, fn: (e: any) => void): void; focus(opts?: { preventScroll?: boolean }): void; blur(): void; setSelectionRange(a: number, b: number): void }

export class ImeBridge {
  constructor(opts: { canvas: { getBoundingClientRect(): { left: number; top: number; width: number; height: number }; focus?(opts?: { preventScroll?: boolean }): void }; screenFromPoint: UIRoot['screenFromPoint']; doc?: DocLike; viewport?: { addEventListener(t: string, fn: () => void): void; removeEventListener(t: string, fn: () => void): void } })
  get active(): ImeField | null
  /** Make `field` the edited one: the proxy takes its value, selection and kind, moves to its caret and takes focus. */
  focus(field: ImeField): void
  /** Stop editing `field` (if it is the active one): the proxy blurs, the canvas takes focus back (keys keep working). */
  blur(field: ImeField): void
  /** The app changed the field's value or selection (v-model, click): push it to the proxy (outside a composition). */
  sync(field: ImeField): void
  /** Re-place the proxy at the active caret (the root calls this every tick while a field is active). */
  reposition(): void
  dispose(): void
}
```

  - `UIRoot.ime: ImeBridge | null`: created lazily on first access when `document` exists (null under Node unless the root was given `ime: { doc }` in tests). The root calls `ime.reposition()` at the end of `tick` while `ime.active`, and disposes it in `dispose`. A Surface removal blurs the field if it lives there.
  - Proxy styling (spec §7.3):
    - `position: fixed`, `opacity: 0.01`, `caret-color: transparent`, `color: transparent`, `background: transparent`, `border: 0`, `outline: none`, `resize: none`, `overflow: hidden`, `white-space: pre`, `padding: 0`, `margin: 0`;
    - `width: 2px`, `height` and `font-size` equal to the caret height in CSS px (so the candidate window sits under the line);
    - `line-height: 1`, `z-index: 2147483647`, `pointer-events: none`;
    - attributes `autocomplete="off"`, `autocorrect="off"`, `autocapitalize="off"`, `spellcheck="false"`, `aria-hidden="true"`, and `enterkeyhint="done"`.
    - For a password field the proxy is an `<input type="password">` so OS password managers and IMEs treat it as one. `TextareaLike` covers both; create `input` for passwords.
  - Events:
    - `input`, `select`, `keyup` and the document's `selectionchange` → `field.onChange(read())`;
    - `compositionstart` records `compStart = selectionStart` and `composing = true`;
    - `compositionupdate(e)` → `field.onChange({ …read(), composition: { start: compStart, end: compStart + e.data.length } })`;
    - `compositionend` → `composing = false` → `field.onChange(read())`;
    - `keydown`:
      - `Tab`/`Shift+Tab` → `preventDefault`, then `field.surface.focus.key(shift ? 'Shift+Tab' : 'Tab')`; the field's blur detaches the bridge;
      - otherwise, when not composing, if `field.onKey(e)` returns true → `preventDefault`;
    - `blur` → when not caused by `ImeBridge.blur`, `field.onBlur()`;
    - `visualViewport` `resize`/`scroll` → `reposition()`.
  - `EditContext` is deferred (recorded in the deferred list); the textarea path works on every engine.

- [ ] **Step 1: Write the failing tests**

A fake `DocLike` and textarea: plain objects with an event table and `fire(type, e)`. The fixture:

```ts
function fakeDoc() {
  const doc = {
    created: [] as FakeArea[], activeElement: null as unknown, listeners: new Map<string, () => void>(),
    createElement(tag: string) { const t = fakeArea(tag, doc); doc.created.push(t); return t },
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
    addEventListener(t: string, fn: () => void) { doc.listeners.set(t, fn) }, removeEventListener(t: string) { doc.listeners.delete(t) },
  }
  return doc
}
// fakeArea(tag, doc): { tag, value: '', selectionStart: 0, selectionEnd: 0, style: {}, attrs: {}, setAttribute(k, v), addEventListener,
//   removeEventListener, fire(type, e), focus() { doc.activeElement = this }, blur() { if (doc.activeElement === this) { doc.activeElement = null; this.fire('blur', {}) } },
//   setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b } }
function setup(opts: { kind?: ImeField['kind']; screenFromPoint?: UIRoot['screenFromPoint'] } = {}) {
  const doc = fakeDoc(), canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), focus: vi.fn() }
  const changes: ImeState[] = [], keys: string[] = [], surfaceKeys: string[] = [], blurs: number[] = []
  const surface = { focus: { key: (k: string) => surfaceKeys.push(k) } } as unknown as Surface
  const field: ImeField = {
    surface, value: 'abc', selectionStart: 1, selectionEnd: 2, kind: opts.kind ?? 'text',
    caret: () => ({ x: 10, y: 20, height: 24 }),
    onChange: s => changes.push(s), onKey: e => { keys.push(e.key); return e.key === 'Enter' }, onBlur: () => blurs.push(1),
  }
  const bridge = new ImeBridge({ canvas, doc, screenFromPoint: opts.screenFromPoint ?? ((_s, x, y) => ({ x: x + 100, y: y + 50 })) })
  return { bridge, doc, field, changes, keys, surfaceKeys, blurs, canvas }
}
```

(Write `fakeArea` in full in the test file; the comment above gives its members.) The tests:

```ts
it('focus copies the field into the proxy, places it at the projected caret, and focuses it', () => {
  const { bridge, doc, field } = setup()                    // screenFromPoint: (s, x, y) => ({ x: x + 100, y: y + 50 })
  bridge.focus(field)
  const ta = doc.created[0]!
  expect(ta.value).toBe('abc'); expect([ta.selectionStart, ta.selectionEnd]).toEqual([1, 2])
  expect(ta.style.left).toBe('110px'); expect(ta.style.top).toBe('70px'); expect(ta.style.fontSize).toBe('24px')
  expect(doc.activeElement).toBe(ta)
})
it('edits flow back through onChange; composition reports its range', () => {
  const { bridge, doc, field, changes } = setup(); bridge.focus(field); const ta = doc.created[0]!
  ta.value = 'abXc'; ta.selectionStart = ta.selectionEnd = 3; ta.fire('input', {})
  ta.fire('compositionstart', {}); ta.value = 'abXnic'; ta.selectionStart = ta.selectionEnd = 5; ta.fire('compositionupdate', { data: 'ni' })
  ta.value = 'abX你c'; ta.selectionStart = ta.selectionEnd = 4; ta.fire('compositionend', { data: '你' })
  expect(changes).toEqual([
    { value: 'abXc', selectionStart: 3, selectionEnd: 3, composition: null },
    { value: 'abXnic', selectionStart: 5, selectionEnd: 5, composition: { start: 3, end: 5 } },
    { value: 'abX你c', selectionStart: 4, selectionEnd: 4, composition: null },
  ])
})
it('Tab moves focus in the Surface; Enter goes to the field; keys are not stolen while composing', () => {
  const { bridge, doc, field, keys, surfaceKeys } = setup(); bridge.focus(field); const ta = doc.created[0]!
  const tab = { key: 'Tab', shiftKey: false, preventDefault: vi.fn() }; ta.fire('keydown', tab)
  expect(surfaceKeys).toEqual(['Tab']); expect(tab.preventDefault).toHaveBeenCalled()
  ta.fire('compositionstart', {}); ta.fire('keydown', { key: 'Enter', preventDefault: vi.fn() })
  expect(keys).toEqual([])
  ta.fire('compositionend', { data: '' }); const enter = { key: 'Enter', preventDefault: vi.fn() }; ta.fire('keydown', enter)
  expect(keys).toEqual(['Enter']); expect(enter.preventDefault).toHaveBeenCalled()
})
it('blur from outside calls onBlur; ImeBridge.blur does not, and hands focus back to the canvas', () => {
  const a = setup(); a.bridge.focus(a.field)
  a.doc.created[0]!.blur()                                     // the user clicked another page element
  expect(a.blurs).toEqual([1]); expect(a.bridge.active).toBeNull()
  const b = setup(); b.bridge.focus(b.field)
  b.bridge.blur(b.field)
  expect(b.blurs).toEqual([]); expect(b.canvas.focus).toHaveBeenCalled(); expect(b.bridge.active).toBeNull()
})
it('a world caret projects through the tilt (Review Focus 3)', () => {
  const camera = new PerspectiveCamera(50, 800 / 600, 0.1, 100); camera.position.set(0, 0, 5); camera.updateMatrixWorld()
  const plane = new Object3D(); plane.rotation.y = 0.5; plane.updateMatrixWorld()
  // a Surface stand-in: 400 × 300 pt at 244 pt per unit, its content plane = plane's local z = 0
  const toWorld = (x: number, y: number) => plane.localToWorld(new Vector3((x - 200) / 244, (150 - y) / 244, 0))
  const project = (_s: unknown, x: number, y: number) => { const p = toWorld(x, y).project(camera); return { x: (p.x + 1) / 2 * 800, y: (1 - p.y) / 2 * 600 } }
  const { bridge, doc, field } = setup({ screenFromPoint: project as never })
  bridge.focus(field)
  const want = project(null, 10, 20)
  expect(parseFloat(doc.created[0]!.style.left!)).toBeCloseTo(want.x, 0)
  expect(parseFloat(doc.created[0]!.style.top!)).toBeCloseTo(want.y, 0)
})
it('a password field uses an input of type password; a number field asks for the decimal keypad', () => {
  const p = setup({ kind: 'password' }); p.bridge.focus(p.field)
  expect(p.doc.created[0]!.tag).toBe('input'); expect(p.doc.created[0]!.attrs.type).toBe('password')
  const n = setup({ kind: 'number' }); n.bridge.focus(n.field)
  expect(n.doc.created[0]!.attrs.inputmode).toBe('decimal')
})
```

The caret height maps to `font-size` and `height` in CSS px. With a projection, the height is the projected distance between the caret's top and bottom points. In the world test, it is enough that `top` and `left` match.

- [ ] **Step 2: Run to verify failure, implement, run again**

Run: `pnpm vitest run packages/render/test/ime.test.ts` (FAIL). Implement `ime.ts` as specified, wire `root.ime`, and add `ImeBridge` to the public entry. Run again (PASS). Then `pnpm typecheck`.

- [ ] **Step 3: Commit**

```bash
git add packages/render packages/vue/src/root.ts
git commit -m "feat(render): ImeBridge — a proxy textarea at the projected caret for IME and clipboard"
```

---

### Task 13: `<Input>` — visual checkpoint 4 (IME)

**Files:**
- Create: `packages/vue/src/components/Input.ts`, `packages/vue/src/textedit.ts` (pure editing helpers)
- Test: `packages/vue/test/{input.test.ts, textedit.test.ts}`
- Modify: `examples/playground/src/gallery/Gallery.vue`

**Interfaces:**
- Consumes: `GlassRoot.ime`, `GlassRoot.text` (`caretRect`, `caretFromPoint`, `selectionRects`), core `resolveTextStyle`, `absoluteRect`, `useGlassControl` (hover/tilt only), `Icon`, `useMotion`, `useSurface`.
- Produces:
  - `Input`:
    - props:
      - `modelValue?: string | number | null` (`v-model`), `placeholder?: string`
      - `type?: 'text' | 'password' | 'number'` (default `'text'`)
      - `clearable?: boolean`, `disabled?: boolean`
      - `size?: 'small' | 'regular' | 'large'` (default `'regular'`), `leadingIcon?: IconName`, `maxLength?: number`
    - size table (height / font / padX / icon / gap): small 36 / 15 / 14 / 18 / 8; regular 52 / 18 / 20 / 22 / 10; large 84 / 23 / 26 / 28 / 14 (large is the reference's field: 84 pt, weight 500 text, `metrics.controlPadding`, `metrics.icon`, `metrics.iconGap`);
    - slots `leading`, `trailing`;
    - events `update:modelValue` (string, or number | null for `type="number"`), `submit` (the value), `focus`, `blur`.
  - Structure: a capsule `glass` host (clear glass, `controlStyle()`, `tabIndex 0`) in a row: leading slot or icon, then the **field**, then the trailing slot, the clear button and, for passwords, an eye toggle (`eye` / `eye-slash` shows the plain text). The field is a `box` with `flexGrow: 1`, `height: lineHeight`, `overflow: 'hidden'`. It contains:
    - the selection panels (`bg: withAlpha('accent', 0.25)`, absolutely positioned from `selectionRects`);
    - the text node (`position: absolute`, `left: −scrollX`, `wrap: false`, `maxLines: 1`) showing the value, `•` × length for passwords, or the placeholder in `tertiaryLabel` when the value and composition are empty;
    - the composition underline (a 1.5 pt `box` with `bg: 'label'` under the composition range);
    - the caret (`box`, 2 pt × 0.9 × line height, `bg: 'accent'`, `radius: 1`), shown only when focused with a collapsed selection; it blinks every 530 ms with live motion and stays on when frozen.
    - Every internal node carries `props.part`: `'field'`, `'text'`, `'caret'`, `'selection'`, `'composition'`, `'clear'`, `'eye'`. The tests and the visual harness find parts this way, never by tree position.
  - `textedit.ts` (pure, unit-tested):
    - `filterNumber(prev, next): string | null`: the accepted text for a `number` field (an optional leading `-`, digits, one `.`); null means reject, so the proxy is reset to `prev`;
    - `parseNumber(text): number | null`;
    - `wordAt(text, index): [start, end]` (via `Intl.Segmenter` word granularity, with an ASCII fallback);
    - `scrollToShow(scrollX, caretX, fieldWidth, pad = 2): number`;
    - `mask(value): string`.
  - Behaviour:
    - Focusing the host (keyboard Tab or click-to-focus, Task 2) calls `ime.focus(field)` and emits `focus`; blur calls `ime.blur(field)` and emits `blur`.
    - `pointerdown` on the field puts the caret at `caretFromPoint(localX + scrollX)`; a drag (`pointermove` while pressed) extends the selection; `dblclick` selects the word; each one ends with `ime.sync(field)`.
    - On each `onChange` from the bridge, the value and selection update, `update:modelValue` is emitted when the value changed (number filtering and `maxLength` applied first; a rejected edit re-syncs the proxy to the previous state), and the composition range is stored.
    - `scrollX` follows the caret, or the composition end while composing (`scrollToShow`).
    - Enter emits `submit`; Escape blurs (`surface.focus.focus(null)`). The clear button empties the value and keeps focus.
    - An external `modelValue` change while focused re-syncs the proxy, outside a composition.
    - Unmounting while focused or composing calls `ime.blur(field)` (Review Focus 2).

- [ ] **Step 1: Write the failing tests**

`textedit.test.ts`: table tests for `filterNumber` (`'' → '1'` ok, `'1' → '1.'` ok, `'1.' → '1..'` null, `'' → '-'` ok, `'1' → '1a'` null), `parseNumber` (`'-'` → null, `'1.5'` → 1.5), `wordAt('hello world', 7)` → `[6, 11]`, `wordAt('你好世界', 1)` (Segmenter boundaries), `scrollToShow` (caret past the right edge scrolls to `caretX − width + pad`; left of the view scrolls to `caretX − pad`; inside stays), `mask('ab')` → `'••'`.

`input.test.ts` (fake root with the monospace fake text engine and a fake `ime` that records calls and lets the test call `field.onChange`):

```ts
it('focus attaches the IME at the caret; typing updates v-model; Enter submits', async () => {
  const v = ref(''), submitted: string[] = []
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: v.value, placeholder: '邮箱', 'onUpdate:modelValue': (x: string) => { v.value = x }, onSubmit: (x: string) => submitted.push(x) }))
  const host = first(c, 'glass'); surface.focus.focus(host); await nextTick()
  const field = root.ime.active!
  expect(field.kind).toBe('text')
  field.onChange({ value: 'a@b', selectionStart: 3, selectionEnd: 3, composition: null }); await nextTick()
  expect(v.value).toBe('a@b'); expect(first(c, 'text').props.value).toBe('a@b')
  expect(field.onKey({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false })).toBe(true)
  expect(submitted).toEqual(['a@b'])
})
it('shows the placeholder only when empty and not composing; draws the composition underline', async () => {
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: '', placeholder: '邮箱', style: { width: 300 } }))
  expect(part(c, 'text').props.value).toBe('邮箱'); expect(part(c, 'text').style.color).toBe('tertiaryLabel')
  surface.focus.focus(first(c, 'glass')); await nextTick()
  root.ime.active!.onChange({ value: 'ni', selectionStart: 2, selectionEnd: 2, composition: { start: 0, end: 2 } }); await nextTick(); root.tick()
  expect(part(c, 'text').props.value).toBe('ni'); expect(part(c, 'text').style.color).toBe('label')
  expect(part(c, 'composition').style).toMatchObject({ left: 0, width: 2 * CW, height: 1.5 })
})
it('the caret follows the selection and the field scrolls to keep it (and a composition) visible (Review Focus 3)', async () => {
  const long = 'x'.repeat(30)                                   // 30 · CW = 324 pt, wider than the 260 pt field
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: long, style: { width: 300 } }))
  surface.focus.focus(first(c, 'glass')); await nextTick()
  const f = root.ime.active!
  f.onChange({ value: long, selectionStart: 30, selectionEnd: 30, composition: null }); await nextTick(); root.tick()
  expect(part(c, 'field').layout.width).toBeCloseTo(260)
  expect(part(c, 'text').style.left).toBeCloseTo(-(30 * CW - 260 + 2))
  expect(part(c, 'caret').style.left).toBeCloseTo(260 - 2)
  f.onChange({ value: long, selectionStart: 0, selectionEnd: 0, composition: null }); await nextTick(); root.tick()
  expect(part(c, 'text').style.left).toBeCloseTo(0)
  const typed = long + 'nihao'                                  // a composition running past the right edge
  f.onChange({ value: typed, selectionStart: 35, selectionEnd: 35, composition: { start: 30, end: 35 } }); await nextTick(); root.tick()
  expect(part(c, 'text').style.left).toBeCloseTo(-(35 * CW - 260 + 2))
})
it('number fields reject letters and emit numbers', async () => {
  const emitted: unknown[] = []
  const { c, root, surface } = mountInSurface(() => h(Input, { type: 'number', modelValue: null, 'onUpdate:modelValue': (x: unknown) => emitted.push(x), style: { width: 300 } }))
  surface.focus.focus(first(c, 'glass')); await nextTick()
  const f = root.ime.active!
  expect(f.kind).toBe('number')
  f.onChange({ value: 'a', selectionStart: 1, selectionEnd: 1, composition: null }); await nextTick()
  expect(emitted).toEqual([]); expect(root.ime.synced.at(-1)).toMatchObject({ value: '', selectionStart: 0, selectionEnd: 0 })
  f.onChange({ value: '-', selectionStart: 1, selectionEnd: 1, composition: null }); await nextTick()
  f.onChange({ value: '-1.5', selectionStart: 4, selectionEnd: 4, composition: null }); await nextTick()
  expect(emitted).toEqual([null, -1.5])
})
it('password fields mask, and the eye toggle reveals', async () => {
  const { c } = mountInSurface(() => h(Input, { type: 'password', modelValue: 'abcd', style: { width: 300 } }))
  expect(part(c, 'text').props.value).toBe('••••')
  fire(part(c, 'eye'), 'click'); await nextTick()
  expect(part(c, 'text').props.value).toBe('abcd')
})
it('clicking places the caret; dblclick selects a word', async () => {
  const { c, root, surface } = mountInSurface(() => h(Input, { modelValue: 'hello world', style: { width: 300 } }))
  surface.focus.focus(first(c, 'glass')); await nextTick(); root.tick()
  fire(part(c, 'field'), 'pointerdown', { localX: 2.4 * CW, localY: 5, pointerType: 'mouse' }); await nextTick()
  expect(root.ime.synced.at(-1)).toMatchObject({ selectionStart: 2, selectionEnd: 2 })
  fire(part(c, 'field'), 'dblclick', { localX: 8 * CW, localY: 5, pointerType: 'mouse' }); await nextTick()
  expect(root.ime.synced.at(-1)).toMatchObject({ selectionStart: 6, selectionEnd: 11 })
})
it('unmounting while composing detaches the IME (Review Focus 2)', async () => {
  const show = ref(true)
  const { c, root, surface } = mountInSurface(() => show.value ? h(Input, { modelValue: '', style: { width: 300 } }) : null)
  surface.focus.focus(first(c, 'glass')); await nextTick()
  const f = root.ime.active!
  f.onChange({ value: 'ni', selectionStart: 2, selectionEnd: 2, composition: { start: 0, end: 2 } })
  show.value = false; await nextTick()
  expect(root.ime.blurred).toContain(f); expect(root.ime.active).toBeNull()
  expect(() => root.tick()).not.toThrow()
})
it('the caret blinks with live motion and is steady when frozen', async () => {
  vi.useFakeTimers()
  try {
    const live = mountInSurface(() => h(Input, { modelValue: 'a', style: { width: 300 } }))
    live.surface.focus.focus(first(live.c, 'glass')); await nextTick()
    const op = () => part(live.c, 'caret').style.opacity
    expect(op()).toBe(1); vi.advanceTimersByTime(530); await nextTick(); expect(op()).toBe(0)
    vi.advanceTimersByTime(530); await nextTick(); expect(op()).toBe(1)
    const frozen = mountInSurface(() => h(Input, { modelValue: 'a', style: { width: 300 } }), { motion: 'frozen' })
    frozen.surface.focus.focus(first(frozen.c, 'glass')); await nextTick()
    vi.advanceTimersByTime(2000); await nextTick(); expect(part(frozen.c, 'caret').style.opacity).toBe(1)
  } finally { vi.useRealTimers() }
})
```

Fixtures for these tests (add them to `test/fixtures`):
- `mountInSurface(render, opts?)` mounts the app into a fake Surface of 800 × 600, runs one `root.tick()` (layout), and returns `{ c: surface.root, root, surface }`.
- `part(c, name)` finds the node whose `props.part === name`.
- `CW = 0.6 × 18`, the regular size's font in the fake engine.
- The fake root's `ime` is `{ active, synced: ImeState[], blurred: ImeField[], focus(f) { this.active = f }, blur(f) { this.blurred.push(f); if (this.active === f) this.active = null }, sync(f) { this.synced.push({ value: f.value, selectionStart: f.selectionStart, selectionEnd: f.selectionEnd, composition: null }) }, reposition() {} }`.

- [ ] **Step 2: Run to verify failure, implement, run again**

Run: `pnpm vitest run packages/vue/test/input.test.ts packages/vue/test/textedit.test.ts` (FAIL). Implement, then run again (PASS).

The caret geometry comes from the text node's resolved style:

```ts
const run = (text: string): TextRun => {
  const t = resolveTextStyle(textNode.value!, root.theme, root.scheme)
  return { text, font: { family: t.family, size: t.size, weight: t.weight }, lineHeight: t.lineHeight, letterSpacing: t.letterSpacing, wrap: false }
}
const caretX = (i: number) => root.text.caretRect(run(shown.value), undefined, i).x
field.caret = () => { const r = absoluteRect(fieldBox.value!); return { x: r.x + caretX(sel.value[1]) - scrollX.value, y: r.y, height: lineHeight.value } }
```

- [ ] **Step 3: Gallery and visual checkpoint 4**

Add an "Inputs" section to `Gallery.vue`: empty with a placeholder, filled, password, number, clearable, disabled, with leading icons, and one with Chinese text.

**Visual checkpoint 4 (controller), in Chrome:**
- type in English and with the macOS Chinese IME (Pinyin): the candidate window appears under the caret, the composition is underlined in the canvas, and committing inserts the characters;
- select with the mouse; copy and paste with Cmd+C/V; undo with Cmd+Z (all from the proxy);
- Tab between fields;
- type a long value: the field scrolls;
- password masking works.

Do this on the screen layer and on a world-layer Surface (gallery's world panel).

- [ ] **Step 4: Commit**

```bash
git add packages/vue examples/playground
git commit -m "feat(vue): <Input> with caret, selection, scrolling, password and number kinds, IME composition"
```

---

### Task 14: `<Dialog>` — visual checkpoint 5

**Files:**
- Create: `packages/vue/src/components/Dialog.ts`, `packages/vue/src/spring.ts` (a tiny `useSpring` over core `Spring` driven by `root.afterTick`)
- Test: `packages/vue/test/dialog.test.ts`
- Modify: `examples/playground/src/gallery/Gallery.vue` (a button that opens a dialog with an Input and two Buttons)

**Interfaces:**
- Consumes: `GlassRoot.createSurface/removeSurface/afterTick/pointer.setActive`, `Surface.trapFocus`, `Surface.focus`, core `Spring`, `GlassTransition`, `Text`, `Stack`, theme `scrim`.
- Produces:
  - `Dialog`:
    - props `open?: boolean` (`v-model:open`), `title?: string`, `width?: number` (default 480), `closeOnBackdrop?: boolean` (default true), `closeOnEscape?: boolean` (default true);
    - slots `default`, `footer`;
    - events `update:open` (false on dismiss), `close`.
  - While open (and through its leave animation), the Dialog owns two screen Surfaces created through the root:
    1. a **backdrop**: `fill: true`, background `'none'`, root box `bg: 'scrim'` with `transition: { opacity: 'smooth' }`, fading from opacity 0 to 1; a click on it closes when `closeOnBackdrop`;
    2. a **panel**: `center: true`, `background: 'glass'`, `cornerRadius: 32`, width `width`, height measured from its content.
  - Layout:
    - the panel root is a column with padding 28 and gap 20: title (`Text`, size 22, weight 700), the default slot, then the footer slot in a right-aligned row with gap 12;
    - the Surface is created at a provisional height of 200; after each `root.afterTick()` the Dialog reads the column's laid-out height and calls `setSize(width, h)` when it differs by more than 0.5 pt;
    - the panel shows only once measured (its `scale` stays 0 until then).
  - Enter and leave:
    - the panel's Surface `scale` springs 0.9 → 1 (`useSpring`, `snappy`) and the backdrop fades in;
    - leave reverses both, then both Surfaces are removed;
    - with frozen motion both are immediate.
  - Focus:
    - opening sets `panel.trapFocus = true`, `root.pointer.setActive(panel)` and focuses the panel's first focusable (`panel.focus.next()`);
    - closing restores the previously active Surface and its focused node.
  - Escape (keydown reaching the panel root) closes when `closeOnEscape`.
  - Opening and closing within one frame creates and removes the Surfaces cleanly (Review Focus 4).

- [ ] **Step 1: Write the failing tests**

```ts
it('opening creates a backdrop and a centred glass panel holding the slots', async () => {
  const open = ref(false), { root } = mountGlass(() => h(Dialog, { open: open.value, title: '删除项目？' }, { default: () => h(Text, { value: '此操作不可撤销。' }), footer: () => h(Button, { label: '删除', variant: 'filled' }) }), { motion: 'frozen' })
  open.value = true; await nextTick()
  const [backdrop, panel] = root.surfacesMade
  expect(backdrop!.created).toMatchObject({ layer: 'screen', fill: true, background: 'none' })
  expect(panel!.created).toMatchObject({ layer: 'screen', center: true, background: 'glass', cornerRadius: 32, width: 480 })
  expect(all(panel!.root, 'text').map(t => t.props.value)).toEqual(expect.arrayContaining(['删除项目？', '此操作不可撤销。', '删除']))
  root.tick(); await flush()
  expect(panel!.model.height).toBeGreaterThan(100)                       // measured from the content
})
it('Escape, a backdrop click and v-model all close; the surfaces go away', async () => {
  for (const how of ['escape', 'backdrop', 'model'] as const) {
    const open = ref(true), closes: string[] = []
    const { root } = mountGlass(() => h(Dialog, { open: open.value, title: 't', 'onUpdate:open': (v: boolean) => { open.value = v }, onClose: () => closes.push(how) },
      { default: () => h(Text, { value: 'x' }) }), { motion: 'frozen' })
    await nextTick()
    const [backdrop, panel] = root.surfacesMade
    if (how === 'escape') fire(panel!.root, 'keydown', { key: 'Escape' })
    if (how === 'backdrop') fire(backdrop!.root, 'click', { pointerType: 'mouse' })
    if (how === 'model') open.value = false
    await nextTick(); root.tick(); await flush()
    expect(open.value).toBe(false)
    expect(closes).toEqual(how === 'model' ? [] : [how])          // `close` reports a dismissal, not a parent's v-model change
    expect(root.surfaces).toEqual([])
  }
})
it('closeOnBackdrop and closeOnEscape can be turned off', async () => {
  const open = ref(true)
  const { root } = mountGlass(() => h(Dialog, { open: open.value, closeOnBackdrop: false, closeOnEscape: false, 'onUpdate:open': (v: boolean) => { open.value = v } }), { motion: 'frozen' })
  await nextTick()
  const [backdrop, panel] = root.surfacesMade
  fire(panel!.root, 'keydown', { key: 'Escape' }); fire(backdrop!.root, 'click', { pointerType: 'mouse' }); await nextTick()
  expect(open.value).toBe(true)
})
it('focus is trapped in the panel while open and restored on close', async () => {
  const open = ref(false)
  const { root, c } = mountGlass(() => h(Stack, () => [
    h(Button, { id: 'opener', label: 'Open', onPress: () => { open.value = true } }),
    h(Dialog, { open: open.value, 'onUpdate:open': (v: boolean) => { open.value = v } }, { default: () => h(Input, { modelValue: '' }), footer: () => h(Button, { id: 'ok', label: 'OK' }) }),
  ]), { motion: 'frozen' })
  const host = root.createSurface({ width: 800, height: 600 }); host.root.appendChild(c)
  const opener = byId(c, 'opener')!
  host.focus.focus(opener); root.pointer.active = host
  open.value = true; await nextTick(); root.tick(); await flush()
  const panel = root.surfacesMade.find(s => s.created.center)!
  expect(panel.trapFocus).toBe(true); expect(root.pointer.setActive).toHaveBeenLastCalledWith(panel)
  expect(panel.focus.current?.type).toBe('glass')                     // the Input's host, the first focusable
  open.value = false; await nextTick(); root.tick(); await flush()
  expect(root.pointer.setActive).toHaveBeenLastCalledWith(host); expect(host.focus.current).toBe(opener)
})
it('open and close in the same frame leaves no surfaces (Review Focus 4)', async () => {
  const open = ref(false), { root } = mountGlass(() => h(Dialog, { open: open.value }), { motion: 'live' })
  open.value = true; await nextTick(); open.value = false; await nextTick()
  for (let i = 0; i < 200 && root.surfaces.length; i++) { root.tick(); await flush() }
  expect(root.surfaces).toEqual([])
})
```

- [ ] **Step 2: Run to verify failure, implement, run again**

Run: `pnpm vitest run packages/vue/test/dialog.test.ts` (FAIL). Implement `spring.ts` and `Dialog.ts`, then run again (PASS).

- [ ] **Step 3: Gallery and visual checkpoint 5**

Add the dialog demo to the gallery.

**Visual checkpoint 5 (controller):**
- the panel is frosted glass over the dimmed scene and scales in;
- the Input inside it takes text (IME too);
- Tab cycles inside the dialog;
- Escape and a backdrop click close it, and focus returns to the opening button;
- WebGPU and WebGL2, high and minimal (minimal: an opaque panel with borders).

- [ ] **Step 4: Commit**

```bash
git add packages/vue examples/playground
git commit -m "feat(vue): <Dialog> on its own glass Surface over a scrim, focus-trapped, springing in"
```

---
### Task 15: Fused glass geometry — smooth-union outline, extrusion, and a plain-mesh glass path

**Files:**
- Create: `packages/render/src/glass/fused.ts`
- Modify: `packages/render/src/glass/slab9.ts` (export `profileAt`), `packages/render/src/glass/batch.ts` (`GlassBatch` with a mesh base), `packages/render/src/glass/vertex.ts` (`meshVertex`), `packages/render/src/glass/material.ts` (vertex path by geometry)
- Test: `packages/render/test/fused.test.ts`, `packages/render/test/glass-material.test.ts` (mesh variants)

**Interfaces:**
- Consumes: `profileAt`/`slabProfile` (slab9.ts), three's `ShapeUtils.triangulateShape`, `GLASS_ATTRS`, `InstanceBuffer`.
- Produces:
  - `export interface FusedShape { x: number; y: number; width: number; height: number; radius: number }`: an axis-aligned rounded rect in Surface pt (already through its instance transform).
  - `fusedOutline(shapes: readonly FusedShape[], spacing: number, opts?: { step?: number }): Contour[]`, where `type Contour = [number, number][]`. It returns the zero contours of the smooth union of the shapes' rounded-rect SDFs, with smoothing `k = spacing`: polynomial smin, `h = max(k − |a − b|, 0)/k`, `smin = min(a, b) − h²k/4`. Each contour is closed (the last point does not repeat the first). Outer boundaries are counter-clockwise in y-up coordinates, holes clockwise.
    - `step` defaults to `clamp(minSide / 24, 0.5, 2)` pt over a grid covering the shapes' bounds plus `spacing + 2·step`.
    - The marching-squares points are simplified (Douglas–Peucker, ε = 0.1 · step).
    - Shapes farther apart than `spacing` give separate contours; shapes within it give one contour with a smooth bridge.
  - `fusedNormal(shapes, spacing, x, y): [number, number]`: the unit outward gradient of the same field at (x, y), by central differences.
  - `extrudeSlab(contours: readonly Contour[], shapes, spacing, profile: { thickness: number; fillet: number; filletBottom: number; minSide: number }, K: number): { positions: Float32Array; normals: Float32Array; index: Uint32Array }` builds a slab mesh in pt:
    - centred at the outline bounds' centre, y up, back face at z = 0;
    - for each contour point P with outward normal n, ring `k` (0 … 2K+1, Plan 2's fillet profile via `profileAt(k, K, …)` with `width = height = minSide`) sits at `P − n·inset_k`, z = `z_k`, with normal `normalize(n·nr_k, nz_k)`;
    - walls join consecutive rings;
    - the top cap (z = thickness, normal +z) triangulates the innermost ring with `ShapeUtils.triangulateShape` (holes included);
    - the back cap (z = 0, normal −z) triangulates ring 0's contour.
  - `GlassBatch` gains a constructor overload `new GlassBatch({ mesh: { positions, normals, index } })`: its geometry has `position`, `normal` and an index instead of the 9-slice `slab` attribute, `userData.vertex = 'mesh'`, and the same `GLASS_ATTRS` instance buffer. `update()` is unchanged. Positions are in slab-local units: the caller scales pt by 1/ptPerUnit when building, centred on the instance's `iRect` centre.
  - `meshVertex(geometry)`: the vertex provider for `userData.vertex === 'mesh'`:
    - `slabLocal = attribute('position')`;
    - `local = (iMat0·p, iMat1·p, iMat2·p)` with `p = vec4(slabLocal, 1)`;
    - `normal = normalize((iMat rows' 3×3)·attribute('normal'))`;
    - it returns the same `{ position, normal, local, slabLocal }` as `slabVertex`.
  - `createGlassMaterial` picks `meshVertex` when `geometry.userData.vertex === 'mesh'` (no `K` check then). The `'fill'` mode and a mesh geometry together throw `GlassUIError('createGlassMaterial', 'fill 模式不画融合玻璃（应拆回单个玻璃实例）')`.

- [ ] **Step 1: Write the failing tests**

```ts
const area = (c: Contour) => c.reduce((s, [x, y], i) => { const [x2, y2] = c[(i + 1) % c.length]!; return s + x * y2 - x2 * y }, 0) / 2
const rect = (x: number, y: number, w: number, h: number, r = 0): FusedShape => ({ x, y, width: w, height: h, radius: r })

it('two distant shapes keep two contours; within spacing they fuse into one with a bridge', () => {
  const far = fusedOutline([rect(0, 0, 40, 40, 20), rect(100, 0, 40, 40, 20)], 16)
  expect(far).toHaveLength(2)
  const near = fusedOutline([rect(0, 0, 40, 40, 20), rect(48, 0, 40, 40, 20)], 16)
  expect(near).toHaveLength(1)
  const circle = Math.PI * 20 * 20
  expect(Math.abs(area(near[0]!))).toBeGreaterThan(2 * circle * 1.02)              // the bridge adds area
})
it('a single shape traces its own rounded rect (area within 1 %)', () => {
  const [c] = fusedOutline([rect(0, 0, 200, 60, 30)], 16)
  const exact = 200 * 60 - (4 - Math.PI) * 30 * 30
  expect(Math.abs(Math.abs(area(c!)) - exact) / exact).toBeLessThan(0.01)
})
it('outer contours wind counter-clockwise (y up) and holes clockwise', () => {
  const ring = [rect(0, 0, 100, 20), rect(0, 80, 100, 20), rect(0, 0, 20, 100), rect(80, 0, 20, 100)]
  const cs = fusedOutline(ring, 4)
  expect(cs.filter(c => area(c) > 0)).toHaveLength(1); expect(cs.filter(c => area(c) < 0)).toHaveLength(1)
})
it('extrudes the fillet profile: unit normals, top cap at the thickness, walls between rings', () => {
  const shapes = [rect(0, 0, 80, 40, 20), rect(88, 0, 80, 40, 20)]
  const cs = fusedOutline(shapes, 16)
  const m = extrudeSlab(cs, shapes, 16, { thickness: 8, fillet: 2.4, filletBottom: 1.6, minSide: 40 }, 4)
  for (let i = 0; i < m.normals.length; i += 3) expect(Math.hypot(m.normals[i]!, m.normals[i + 1]!, m.normals[i + 2]!)).toBeCloseTo(1, 5)
  const zs = [...m.positions].filter((_, i) => i % 3 === 2)
  expect(Math.max(...zs)).toBeCloseTo(8, 5); expect(Math.min(...zs)).toBeCloseTo(0, 5)
  expect(m.index.length % 3).toBe(0)
  expect(Math.max(...m.index)).toBeLessThan(m.positions.length / 3)
})
it('a mesh-based GlassBatch builds front and back materials on both backends within 11 varyings', () => {
  const shapes = [rect(0, 0, 80, 40, 20), rect(88, 0, 80, 40, 20)]
  const m = extrudeSlab(fusedOutline(shapes, 16), shapes, 16, { thickness: 8, fillet: 2.4, filletBottom: 1.6, minSide: 40 }, 4)
  const batch = new GlassBatch({ mesh: m })
  for (const side of ['front', 'back'] as const) for (const forceWebGL of [false, true]) {
    const gm = createGlassMaterial({ geometry: batch.geometry, K: 0, backdrop: 'panel', side, surface: su(), content: new Texture() })
    const built = buildShaders(gm.material, batch.geometry, forceWebGL)
    expect(built.varyings).toBeLessThanOrEqual(11)
  }
  expect(() => createGlassMaterial({ geometry: batch.geometry, K: 0, backdrop: 'panel', side: 'front', surface: su(), content: new Texture(), mode: 'fill' })).toThrow(/融合玻璃/)
})
```

(Use the shader fixture's existing varying count. If `buildShaders` reports varyings differently, count them the way `glass-material.test.ts` does.)

- [ ] **Step 2: Run to verify failure**

Run: `pnpm vitest run packages/render/test/fused.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `fused.ts`**

```ts
export type Contour = [number, number][]
export interface FusedShape { x: number; y: number; width: number; height: number; radius: number }

/** Signed distance to a rounded rect (pt; negative inside), y down like the shapes. */
function sdRound(s: FusedShape, x: number, y: number): number {
  const hx = s.width / 2, hy = s.height / 2, r = Math.min(s.radius, hx, hy)
  const qx = Math.abs(x - (s.x + hx)) - (hx - r), qy = Math.abs(y - (s.y + hy)) - (hy - r)
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
function smin(a: number, b: number, k: number): number { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25 }
export function fusedField(shapes: readonly FusedShape[], k: number, x: number, y: number): number {
  let d = Infinity
  for (const s of shapes) { const e = sdRound(s, x, y); d = d === Infinity ? e : smin(d, e, k) }
  return d
}
export function fusedNormal(shapes: readonly FusedShape[], k: number, x: number, y: number): [number, number] {
  const e = 0.25, gx = fusedField(shapes, k, x + e, y) - fusedField(shapes, k, x - e, y), gy = fusedField(shapes, k, x, y + e) - fusedField(shapes, k, x, y - e)
  const l = Math.hypot(gx, gy) || 1
  return [gx / l, -gy / l]                                   // y down → y up
}
```

`fusedOutline`:
1. Sample `fusedField` on the grid.
2. Run marching squares (16 cases; resolve the saddle cases with the cell-centre value), with edge points linearly interpolated.
3. Chain the segments into loops through a hash on rounded endpoints.
4. Convert to y up (`[x, −y]`) relative to the bounds' centre, so the output matches `extrudeSlab`'s frame.
5. Orient each loop: outer loops counter-clockwise, holes clockwise. A loop is a hole when its interior samples have a positive field, i.e. its signed area is negative after orienting by the field gradient.
6. Simplify with Douglas–Peucker.

Document in the file that the outline and extrusion share one frame (pt, y up, centred on the bounds' centre).

`extrudeSlab`: as specified. Rings 0 … 2K+1 come from `profileAt(k, K, { width: minSide, height: minSide, thickness, fillet, filletBottom, profile: 0, radius: 0, cornerExponent: 2 })`. Interleave positions and normals, and index the quads `(k, i) (k, i+1) (k+1, i+1) (k+1, i)` with the winding outward. The caps use `ShapeUtils.triangulateShape(outer.map(p => new Vector2(...p)), holes.map(...))`.

`GlassBatch({ mesh })`: build a `BufferGeometry` from the arrays (`position`, `normal`, `index`), wrap it in `InstancedBufferGeometry` (copy the attributes and index), set `userData.vertex = 'mesh'` and `userData.K = 0`, and attach the `InstanceBuffer` exactly as the 9-slice path does.

`meshVertex` and the material branch: as specified. The material's `slabUV` (`vGeom.zw`) divides `slabLocal.xy` by `iRect.zw` (the instance's width and height in units), so the caller writes the outline bounds into `iRect`.

- [ ] **Step 4: Run, typecheck, commit**

Run: `pnpm vitest run packages/render && pnpm typecheck`
Expected: PASS.

```bash
git add packages/render
git commit -m "feat(render): fused glass outlines (smooth union) extruded with the fillet profile, drawn through the glass material"
```

---

### Task 16: GlassContainer in the render list and the Surface — visual checkpoint 6

**Files:**
- Modify: `packages/core/src/renderlist.ts` (`FusedGlassInstance`, clustering under `props.glassContainer`)
- Modify: `packages/render/src/surface/partition.ts` (members count as glass for what rides on them), `packages/render/src/surface/surface.ts` (fused draws, cache, fill-mode fallback)
- Test: `packages/core/test/renderlist.test.ts`, `packages/render/test/surface.test.ts`

**Interfaces:**
- Produces (core):
  - `export interface FusedGlassInstance extends InstanceTransform { node: Node; members: GlassInstance[]; shapes: { x: number; y: number; width: number; height: number; radius: number }[]; spacing: number; params: ResolvedGlass; rect: Rect; z: number; clip?: ClipRect }`
    - `shapes` are the members' rects through their own transforms (a pressed member shrinks), in Surface pt;
    - `params` is the first member's;
    - `elevation` is the largest member elevation and `opacity` the first member's;
    - `transform` is `IDENTITY` (the shapes are already transformed).
  - `RenderList.fused: FusedGlassInstance[]`.
  - A node with `props.glassContainer = { spacing: number }` collects the glass instances whose nearest container it is. After its subtree, it clusters them: two members join when the gap between their transformed rects is ≤ `spacing` (transitively).
    - A one-member cluster is emitted as a normal glass instance with its rim and pool.
    - A larger cluster becomes one `FusedGlassInstance`; its members keep their pools, and their rims are dropped (the fused slab's own edges are lit by the shell).
- Produces (render):
  - `partition` adds every fused member to its glass map, so text and images on a member still ride on top (`liftFor` uses the member's thickness).
  - The `Surface` keeps a map from container node to `{ key, batch: GlassBatch({ mesh }), meshes, materials }`:
    - `key` hashes the shapes (rounded to 0.25 pt), the spacing, the thickness and the fillets;
    - a changed key rebuilds the mesh and disposes the old one;
    - materials are made like the element glass (same content, pyramid, behind, mode, dispersion, back faces);
    - the one instance written is the synthesized `GlassInstance` (`rect` = outline bounds, `radius` 0, the cluster's params, elevation, opacity, clip, identity transform);
    - `buildGlass` rebuilds the fused materials too.
  - In the `'fill'` glass mode, fused clusters are not drawn fused: their members go into the ordinary glass batch with their rims (`fillRims` includes them), since the minimal tier draws flat bordered fills.

- [ ] **Step 1: Write the failing tests**

```ts
// core
it('fuses glass within spacing under a glassContainer, keeps the rest single', () => {
  const s = createSurface({ width: 400, height: 100 })
  const box = new Node('box'); box.setProp('glassContainer', { spacing: 16 }); box.setStyle({ width: 400, height: 100, flexDirection: 'row' })
  const a = glass(0, 0, 80, 40), b = glass(90, 0, 80, 40), c = glass(300, 0, 80, 40)    // a–b gap 10 ≤ 16, c far
  box.appendChild(a); box.appendChild(b); box.appendChild(c); s.root.appendChild(box); layoutOf(s)
  const rl = buildRenderList(s, defaultTheme, 'light')
  expect(rl.fused).toHaveLength(1); expect(rl.fused[0]!.members.map(m => m.node)).toEqual([a, b])
  expect(rl.glass.map(g => g.node)).toEqual([c])
  expect(rl.decorations.filter(d => d.kind === 'rim').map(d => d.node)).toEqual([c])
  expect(rl.decorations.filter(d => d.kind === 'pool').map(d => d.node).sort()).toEqual([a, b, c].sort())
})
it('a pressed member fuses with its shrunken shape', () => {
  const s = createSurface({ width: 400, height: 100 })
  const box = new Node('box'); box.setProp('glassContainer', { spacing: 16 }); box.setStyle({ width: 400, height: 100 })
  const a = glass(0, 0, 80, 40), b = glass(90, 0, 80, 40); box.appendChild(a); box.appendChild(b); s.root.appendChild(box); layoutOf(s)
  a.setVisual({ scale: 0.9 })
  const f = buildRenderList(s, defaultTheme, 'light').fused[0]!
  expect(f.shapes[0]).toMatchObject({ x: 4, y: 2, width: 72, height: 36 })          // 80 × 40 at (0, 0) scaled 0.9 about its centre
  expect(f.shapes[1]).toMatchObject({ x: 90, y: 0, width: 80, height: 40 })
})
// render (surface.test.ts): a Surface whose root holds a container with two close glass nodes and one far one
function fusedSurface(c: SurfaceContext = ctx) {
  const s = new Surface({ width: 400, height: 100, ptPerUnit: 1 }, c)
  const box = new Node('box', 'bar'); box.setProp('glassContainer', { spacing: 16 }); box.setStyle({ position: 'absolute', left: 0, top: 0, width: 400, height: 100 })
  const at = (id: string, left: number) => { const g = new Node('glass', id); g.setStyle({ position: 'absolute', left, top: 30, width: 80, height: 40, radius: 'capsule' }); box.appendChild(g); return g }
  const a = at('a', 0), b = at('b', 90), far = at('far', 300)
  s.root.appendChild(box); s.tick(0)
  return { s, a, b, far }
}
const meshBatches = (s: Surface) => meshes(s).filter(m => (m.geometry as { userData?: { vertex?: string } }).userData?.vertex === 'mesh')
it('draws a fused cluster as one mesh-based glass batch and rebuilds only when the shapes change', () => {
  const { s, b, far } = fusedSurface()
  const fused = meshBatches(s)
  expect(fused.length).toBeGreaterThan(0)                                      // front (+ back when backFaces)
  expect(s.glass.nodes).toEqual([far])                                          // members left the instanced batch
  const geometry = fused[0]!.geometry
  s.tick(0); expect(meshBatches(s)[0]!.geometry).toBe(geometry)                 // nothing changed: same mesh
  let disposed = 0; geometry.addEventListener('dispose', () => { disposed++ })
  b.setStyle({ left: 100 }); s.tick(0)
  expect(meshBatches(s)[0]!.geometry).not.toBe(geometry); expect(disposed).toBe(1)
})
it("in the 'fill' mode a fused cluster draws its members as single glass with rims", () => {
  const { s, a, b, far } = fusedSurface({ ...ctx, quality: QUALITY.minimal })
  expect(meshBatches(s)).toEqual([])
  expect([...s.glass.nodes].sort()).toEqual([a, b, far].sort())
  expect(s.rims.buffer.count).toBe(0)                                           // fill mode draws no rims at all (Plan 2)
})
```

Write the two render tests in full:
- With the `signup()`-style setup and a container holding two close glass nodes, assert one `GlassBatch` whose geometry has `userData.vertex === 'mesh'`, and that the element glass batch excludes the members.
- A second `tick` with nothing changed keeps the same geometry object; moving one member rebuilds it and disposes the old one (listen for `dispose`).
- `QUALITY.minimal`: no mesh batch, and both members are in `s.glass.nodes`.

- [ ] **Step 2: Run to verify failure, implement, run again**

Run: `pnpm vitest run packages/core/test/renderlist.test.ts packages/render/test/surface.test.ts` (FAIL). Implement as specified, then run again (PASS). Then `pnpm typecheck`.

- [ ] **Step 3: Visual checkpoint 6 (controller, after Task 17's component exists — do it at the end of Task 17)**

- [ ] **Step 4: Commit**

```bash
git add packages/core packages/render
git commit -m "feat(core,render): glass containers fuse nearby glass into one slab"
```

---

### Task 17: `<GlassContainer>` and `glassId` morphing — visual checkpoint 6

**Files:**
- Create: `packages/vue/src/components/GlassContainer.ts`
- Modify: `packages/vue/src/renderer.ts` (tree observer for `glassId`), `packages/vue/src/components/Button.ts` (passes `glassId` to its host)
- Test: `packages/vue/test/container.test.ts`
- Modify: `examples/playground/src/gallery/Gallery.vue` (a toolbar of icon buttons in a container; a toggle that swaps a button between two places with one `glassId`)

**Interfaces:**
- Consumes: Task 16 `props.glassContainer`; Task 3 `anim.seed`; core `absoluteRect`.
- Produces:
  - `GlassContainer`:
    - props `spacing?: number` (default 16 pt; spec: "子玻璃形状按 spacing 融合"), `direction?: 'horizontal' | 'vertical'` (default `'horizontal'`), `gap?: number` (default 8);
    - slot default;
    - renders `h('box', { glassContainer: { spacing }, style: { flexDirection, gap, alignItems: 'center' } }, slots)`.
  - `glassId` (on Button, and on any host glass node via the `glassId` prop):
    - when a node with `props.glassId = id` leaves the tree (`nodeOps.remove`), the renderer records its last absolute rect under `id` with a timestamp;
    - when a node with the same `glassId` is inserted (`nodeOps.insert`) within 500 ms, the renderer calls `root.anim.seed(node, { x, y, width, height })`, with x and y converted into the new parent's frame (`oldAbs − absoluteRect(newParent)`);
    - it also puts a `morph` style layer on the node: `{ transition: { x: 'smooth', y: 'smooth', width: 'smooth', height: 'smooth' } }` for keys the node's style has none for, removed after `whenSettled` (its own layer, so a `GlassTransition` around the same node keeps working);
    - so the new glass grows out of where the old one was (Apple's `glassEffectID` morph); within a container the shapes fuse as they meet.
  - `glassId` matching is scoped to the root and does not cross apps.

- [ ] **Step 1: Write the failing tests**

```ts
it('GlassContainer marks its box and lays children out with the gap', () => {
  const { c } = mountGlass(() => h(GlassContainer, { spacing: 20, gap: 6 }, () => [h(Button, { leadingIcon: 'plus', shape: 'circle' }), h(Button, { leadingIcon: 'minus', shape: 'circle' })]))
  const box = first(c, 'box')
  expect(box.props.glassContainer).toEqual({ spacing: 20 }); expect(box.style).toMatchObject({ flexDirection: 'row', gap: 6 })
})
it('a glassId swap seeds the new node with the old rect and animates it to its own', async () => {
  const root = createFakeRoot(), s = root.createSurface({ width: 400, height: 200 }), where = ref<'left' | 'right'>('left')
  const App = defineComponent(() => () => h(Stack, { direction: 'horizontal', style: { width: 400, justifyContent: 'space-between' } }, () => [
    where.value === 'left' ? h(Button, { key: 'l', glassId: 'go', label: 'Go' }) : h(Box, { key: 'lx' }),
    where.value === 'right' ? h(Button, { key: 'r', glassId: 'go', label: 'Go' }) : h(Box, { key: 'rx' }),
  ]))
  createGlassApp(App, { root }).mount(s as never); root.tick()
  const before = absoluteRect(first(s.root, 'glass'))
  where.value = 'right'; await nextTick(); root.tick()
  const moved = first(s.root, 'glass')
  expect(moved.visual?.x).toBeCloseTo(before.x - absoluteRect(moved.parent!).x, 0)      // starts where the old one was
  for (let i = 0; i < 120; i++) root.tick()
  expect(moved.visual).toBeNull()                                                     // settled at its own place
})
```

- [ ] **Step 2: Run to verify failure, implement, run again**

Run: `pnpm vitest run packages/vue/test/container.test.ts` (FAIL). Implement, then run again (PASS). Then `pnpm typecheck && pnpm playground:build`.

- [ ] **Step 3: Visual checkpoint 6 (controller)**

In the gallery:
- the toolbar's icon buttons fuse into one liquid slab where they sit within `spacing`, and separate when the toolbar widens;
- the `glassId` swap grows the button from its old place;
- hovering one fused member still lifts it and the slab follows (the fused shape uses member elevations);
- WebGPU and WebGL2, high and minimal (minimal: separate bordered fills).

- [ ] **Step 4: Commit**

```bash
git add packages/vue examples/playground
git commit -m "feat(vue): <GlassContainer> and glassId morph transitions"
```

---
### Task 18: `manifest.json` — what an agent reads

**Files:**
- Create: `packages/vue/src/manifest.ts`, `packages/vue/manifest.json` (generated), `packages/vue/README.md`
- Create: `packages/vue/test/manifest.test.ts`
- Modify: root `package.json` (`"manifest": "GLASSUI_WRITE_MANIFEST=1 vitest run packages/vue/test/manifest.test.ts"`), `packages/vue/package.json` (devDependency `@vue/compiler-dom` 3.5.44; `"files"`/`"exports"` include `manifest.json`)

**Interfaces:**
- Consumes: `glassComponents()` and each component's `glass` meta; core `StyleSchema`, `STYLE_KEYS`, `defaultTheme`, the tw grammar (export core's `known(theme)` list as `twClasses(theme)`); `HOST_TAGS`.
- Produces: `generateManifest(): GlassManifest`, serialised with 2-space JSON, keys in a stable order:

```ts
export interface GlassManifest {
  name: '@glassui/vue'; version: string
  /** How to start: createUIRoot + createGlassApp + mount, as a complete TS snippet; the playground's minimal setup. */
  setup: string
  components: {
    name: string; description: string
    props: { name: string; type: unknown /* JSON Schema from z.toJSONSchema */; required: boolean; default?: unknown; description: string }[]
    events: { name: string; payload: string; description: string }[]
    slots: { name: string; description: string }[]
    vModel: string[]                       // props bound by v-model (modelValue → 'v-model', checked → 'v-model:checked', open → 'v-model:open')
    examples: string[]
    mistakes: { mistake: string; fix: string }[]
  }[]
  style: { keys: { name: string; type: unknown }[]; states: ['hover', 'pressed', 'focused', 'disabled']; tw: string[] }
  theme: { colors: string[]; fontSize: Record<string, number>; radius: Record<string, number>; spacing: number[]; metrics: Record<string, number> }
  rules: string[]                          // spec §8.3 rules in one line each (glass only on controls, capsule default, …)
}
```

  - `pnpm manifest` regenerates `packages/vue/manifest.json`. The test fails, with that command in its message, when the committed file differs from a fresh generation.
  - `packages/vue/README.md` holds a 30-line quickstart (install, `createUIRoot`, `createGlassApp`, a sample `.vue` using Surface, Stack, Text, Input, Button, Switch and Dialog) and points to `manifest.json` as the reference.

- [ ] **Step 1: Write the failing test**

```ts
import { compile } from '@vue/compiler-dom'
import { generateManifest } from '../src/manifest'
import committed from '../manifest.json'

const m = generateManifest()
it('is up to date', () => {
  if (process.env.GLASSUI_WRITE_MANIFEST) writeFileSync(join(__dirname, '../manifest.json'), JSON.stringify(m, null, 2) + '\n')
  else expect(m, 'manifest.json is stale: run `pnpm manifest`').toEqual(committed)
})
it('documents every component completely', () => {
  expect(m.components.map(c => c.name)).toEqual(['Surface', 'Box', 'Text', 'Icon', 'Stack', 'Button', 'Switch', 'Checkbox', 'Input', 'Dialog', 'GlassContainer'])
  for (const c of m.components) {
    expect(c.description.length, c.name).toBeGreaterThan(40)
    expect(c.examples.length, c.name).toBeGreaterThanOrEqual(2)
    for (const p of c.props) expect(p.description, `${c.name}.${p.name}`).not.toBe('')
  }
})
it('every example compiles and uses only known components, props and events', () => {
  const byTag = new Map(m.components.map(c => [c.name, c]))
  for (const c of m.components) for (const ex of c.examples) {
    const errors: unknown[] = []
    const { ast } = compile(ex, { onError: e => errors.push(e), isCustomElement: t => (HOST_TAGS as readonly string[]).includes(t) })
    expect(errors, ex).toEqual([])
    walkElements(ast, el => {
      const comp = byTag.get(pascal(el.tag)); if (!comp) return
      for (const name of attrNames(el)) expect(knownAttr(comp, name), `${ex}: ${el.tag} ${name}`).toBe(true)
    })
  }
})
```

(`walkElements`, `attrNames` and `knownAttr` are test helpers.
- `attrNames` returns static attribute names, `:x`/`v-bind:x` → `x`, `@x`/`v-on:x` → `on:x`, and `v-model:x` → `x` (bare `v-model` → `modelValue`). Each is camelized.
- `knownAttr` accepts props, `on:<event>` for declared events, and the fallthrough `class`, `style`, `tw`, `id`, `key`, `ref`.)

- [ ] **Step 2: Run to verify failure, implement, generate, run again**

Run: `pnpm vitest run packages/vue/test/manifest.test.ts` (FAIL). Implement `manifest.ts`, then run `pnpm manifest` and check the result passes (PASS). Read `manifest.json` once yourself and fix any component description that would not let a newcomer write a form: the descriptions are the product here.

- [ ] **Step 3: Commit**

```bash
git add packages/vue package.json pnpm-lock.yaml
git commit -m "feat(vue): generated manifest.json — components, props, events, slots, examples, style and theme vocabulary"
```

---

### Task 19: The playground in Vue — sign-up, world, gallery, performance scene

**Files:**
- Create: `examples/playground/src/scenes/{SignUp.vue, World.vue, Both.vue, Perf.vue}`
- Modify: `examples/playground/src/main.ts`, `examples/playground/src/gallery/Gallery.vue`
- Delete: `examples/playground/src/signup.ts`, `examples/playground/src/world.ts`, `examples/playground/src/icons.ts` (moved to `@glassui/vue` in Task 8); keep `wall.ts` (the host scene)

**Interfaces:**
- Consumes: every component; `createGlassApp`.
- Produces:
  - `?scene=signup|world|both|gallery|perf`, plus `&webgl`, `&quality=…`, `&hud=0`, `&motion=frozen|live`, `&scheme=light|dark`.
  - `SignUp.vue` rebuilds the reference form (`docs/images/signup-front.jpg`) from components only:
    - a centred `Surface` (885 × 1045, `background="glass"`, radius 48, scaled to fit as today);
    - title and Chinese subtitle `Text`s;
    - a close `Button` (circle, `x` icon);
    - three large `Input`s (leading icons user / mail / lock; password with the eye);
    - a `Checkbox` with its label;
    - a `Switch` labelled "Remember me";
    - the primary `Button` (`glassProminent`, large, `arrow-right`, full width);
    - "or continue with";
    - two `Button`s (Apple, Google, with their logos as `leading` slot images);
    - the "Already have an account? Sign in" `Text` fragments.
  - Positions use Stack layout (not absolute coordinates) wherever the reference allows.
  - `World.vue`: the world-layer card from Plan 2 (`Surface layer="world"` with a Switch and two Buttons) behind the wall.
  - `Perf.vue` (spec §10): a screen Surface with 100 Buttons (5 variants × 20) and 20 `GlassContainer`s of 3 circle buttons each, all visible at 1280 × 900.
  - `window.__glassui` keeps `{ renderer, ready, root, surfaces }` and adds:
    - `rectOf(id): { x, y, width, height } | null`, in CSS px;
    - `stats(): { frameMs: number; draws: number }`, where `frameMs` is the mean rAF interval over the last 60 frames and `draws` is `renderer.info.render.drawCalls` of the last frame;
    - `ime(): boolean` (whether the IME proxy is focused), for the harness.

- [ ] **Step 1: Implement the scenes and the entry; keep the old URLs working**

The sign-up scene must keep the ids the harness reads (`name`, `email`, `password`, `terms`, `remember`, `submit`, `apple`, `google`, `close`, `signin`) through `id` attributes on the components (they fall through to the host nodes).

- [ ] **Step 2: Verify**

Run: `pnpm typecheck && pnpm playground:build`
Expected: exit 0.

**Controller check:** `?scene=signup` side by side with Plan 2's baseline (`examples/visual/tests/visual.spec.ts-snapshots/signup-webgpu.png`). The Vue form must read as the same design. List the differences in the report: the Inputs are real fields now, and the layout comes from Stack. Then check `?scene=perf` and `?scene=gallery` in the dark scheme.

- [ ] **Step 3: Commit**

```bash
git add -A examples/playground
git commit -m "feat(playground): scenes rebuilt in Vue from the component library; perf scene; harness hooks"
```

(`git add -A` is safe here: it is scoped to `examples/playground`.)

---

### Task 20: Visual regression for the component library — visual checkpoint 7

**Files:**
- Modify: `examples/visual/tests/visual.spec.ts` (cases), `examples/visual/playwright.config.ts` (if a project is added), `examples/visual/README.md`
- Create: `examples/visual/tests/ime.spec.ts`
- Baselines: regenerated by the controller

**Interfaces:**
- Consumes: Task 19's scenes and hooks.
- Produces (spec §10: every component in each state, screen and world layers, all four tiers, Chinese, IME composition, both backends):
  - Cases (all `&hud=0&motion=frozen`, 1280 × 900, DPR 1, each on `webgl2` and `webgpu`):
    - `signup` at `high`, `medium`, `minimal`, and `signup` with `scheme=dark`;
    - `world` (clipped to the card with `toHaveScreenshot({ clip })`, the region from `rectOf('world-card')` plus 24 px: Plan 2's M9);
    - `gallery` at high, medium, low and minimal (the full page);
    - `gallery` state shots, each clipped to its section:
      - hover on a glass Button (`page.mouse.move` to `rectOf` centre, then wait 500 ms);
      - pressed (`mouse.down` without up);
      - focus-visible (Tab from the start until the Button is focused);
      - disabled;
      - Switch on and off;
      - Checkbox checked and indeterminate;
      - Input empty, with a value and a selection, and focused;
    - `dialog` (the gallery's open-dialog button clicked).
  - `ime.spec.ts` (Chromium CDP):
    1. Click the email Input and assert `__glassui.ime()`.
    2. Send `Input.imeSetComposition { text: 'ni', selectionStart: 2, selectionEnd: 2 }` and screenshot the field clipped (the composition underlined).
    3. Send `Input.insertText { text: '你' }` and assert the field's text node value via a hook, then screenshot again.
  - The error gate from Plan 2 stays on for every case.

- [ ] **Step 1: Write the cases; run `--list`**

Run: `pnpm --filter visual exec playwright test --list`
Expected: every case × 2 projects listed.

- [ ] **Step 2: Visual checkpoint 7 (controller, outside the sandbox)**

`pnpm test:visual:update`. Inspect every new PNG for:
- WebGPU and WebGL2 parity;
- states visibly distinct;
- minimal with bordered fills;
- Chinese glyphs present;
- the composition underlined.

Then run `pnpm test:visual --repeat-each=2` and confirm it passes. Commit the PNGs.

- [ ] **Step 3: Commit**

```bash
git add examples/visual
git commit -m "test(visual): component states, tiers, dark scheme, dialog and IME composition on both backends"
```

---

### Task 21: Performance baseline and the render hot paths

**Files:**
- Create: `examples/visual/tests/perf.spec.ts`, `examples/visual/perf-baseline.json`
- Modify: `packages/core/src/animation/runtime.ts`, `packages/render/src/root.ts`, `packages/render/src/surface/surface.ts`, `packages/render/src/glass/material.ts`, `packages/render/src/surface/content.ts`, `packages/render/src/luma.ts` (as the measurements direct)
- Test: existing suites; new unit tests for each optimisation's behaviour

**Interfaces:**
- Produces:
  - `perf.spec.ts`:
    - loads `?scene=perf&quality=high&hud=0&motion=frozen` on `webgl2` (spec §10: "CI 上只做回归阈值（Chrome headless，WebGL 路径）") and `webgpu`;
    - waits 2 s, samples `stats()` for 120 frames, and writes `test-results/perf.json` with `{ frameMs, draws }` per backend;
    - fails when `draws > baseline.draws × 1.05` or `frameMs > baseline.frameMs × 1.5`.
  - `perf-baseline.json`: the controller's first measurement on the reference machine, committed with the date and machine.
  - Optimisations (Plan 2 carry-overs M4, f, the pyramid crop and RT shrink hysteresis), each kept only when it measurably helps the perf scene or the unit-level counters:
    1. `AnimationRuntime.tick` skips subtrees with no transitions without allocating: cache `transitionKeys` per style object (`WeakMap<Style, Set>`), and read `effectiveStyle` only for nodes with keys or state branches that set `display`.
    2. Per-frame allocations in the root's `each`/`filter`/`sort`, `glassBounds`, and luma's screen rects reuse scratch arrays and boxes.
    3. The high tier's backdrop fetches drop from 15 to 6 per fragment (Plan 2 f): each colour channel samples only the two pyramid levels bracketing `k = roughness·levels` (`select` on ⌊k⌋, no TSL `If` outside `Fn`). Prove it with the shader fixture (texture-sample count per channel) and a CPU `tsl-eval` equality test against today's mix.
    4. The Kawase pyramid covers the union of the glass rects plus a 2 × blur-radius margin (spec §5.6 "仅覆盖玻璃矩形并集 + 位移余量"): render each pass with a scissor or viewport over that rect, sample the same uv as today, and leave texels outside it untouched (never sampled).
    5. Content RT shrink hysteresis: a smaller projected size only shrinks the RT after it has stayed smaller for 30 consecutive frames, or by more than half (no ping-pong reallocations while a camera dollies).
    6. A world Surface seen at a grazing angle, wholly in front of the camera, projects to a huge bounding box (Plan 2 residual: up to the 4096 cap). Cap a world Surface's RT at the texels it can actually show: 2 × the viewport's device px on each axis. Pin it with a `projectedPx` test at a grazing angle.

- [ ] **Step 1: The harness and the first baseline**

Write `perf.spec.ts`. The controller runs it outside the sandbox and commits `perf-baseline.json` with the numbers before any optimisation.

- [ ] **Step 2: Each optimisation as its own commit, test first**

For each of 1–5:
1. Write a unit test that pins the behaviour: identical output, and the count or allocation it removes.
2. Implement.
3. Run `pnpm test`.
4. The controller re-measures, and the commit message records before → after.

Drop an optimisation that does not move the numbers, and say so in the report.

- [ ] **Step 3: Update the baseline**

The controller commits the final `perf-baseline.json`. The thresholds then guard the optimised state.

```bash
git add examples/visual packages/core packages/render
git commit -m "perf(render,core): baseline harness; allocation-free animation walk, 6-fetch frost, cropped pyramid, RT hysteresis"
```

---

### Task 22: Render polish carry-overs — DPR below 1, the mip/Kawase match

**Files:**
- Modify: `packages/render/src/surface/surface.ts` (`prepare`), `packages/render/src/glass/frost.ts`, `packages/render/src/glass/material.ts`
- Test: `packages/render/test/surface.test.ts`, `packages/render/test/glass-material.test.ts`

**Interfaces:**
- Produces:
  - The content RT floor becomes `max(q.contentScale, min(1, 1/dpr))`. At DPR < 1 (a zoomed-out browser) the RT stays at one texel per device pixel instead of one per CSS px (Plan 2's residual).
  - `frost.ts` exports two pure functions the test compares, both returning the RMS blur radius in content-RT texels:
    - `kawaseRadius(roughness)`: the level mix the glass samples, with `k = roughness · 4`; 0 at k = 0, interpolated linearly to the first level's 5 texels at k = 1, then `5 · 2^(k−1)` between levels (Plan 2 Task 22's measured 5 / 10 / 20 / 41);
    - `mipRadius(roughness)`: the RMS radius of the trilinear mip sample at the tier's `lod`, a box of 2^lod texels per axis, so `2^lod / √12 · √2` for the 2-D RMS.
  - The mip tiers' blur width matches the high tier's at the same roughness (Plan 2 e). The roughness → mip-level map becomes `lod = log2(1 + roughness · levels · R)`, where `R` makes the RMS radius of the mip blur equal the Kawase level radius at `k = roughness · 4` (≈ 5 · 2^k texels). Derive `R` and the formula in `frost.ts` with a comment, and pin it with a CPU test: the Kawase radius from Task 22 of Plan 2's simulation vs the box-filtered mip RMS at roughness 0.06, 0.25, 0.5 and 1.0, within 25 %.

- [ ] **Step 1: Tests first**

```ts
it('keeps one texel per device px when DPR < 1', () => {
  const s = new Surface({ width: 400, height: 300, ptPerUnit: 1 }, { ...ctx, quality: QUALITY.high })
  s.tick(0); s.prepare(stubRenderer(), { width: 400, height: 300 }, 0.5)
  const at1 = contentRTSize({ width: 400, height: 300 }, 0.5, { scale: 1 })    // the RT size function the Surface uses
  expect([s.contentPass.target.width, s.contentPass.target.height]).toEqual([at1.width, at1.height])
  expect(s.contentPass.target.width).toBeLessThan(contentRTSize({ width: 400, height: 300 }, 0.5, { scale: 2 }).width)
})
it('the mip blur width follows the Kawase level at the same roughness', () => {
  for (const r of [0.06, 0.25, 0.5, 1]) expect(Math.abs(mipRadius(r) / kawaseRadius(r) - 1)).toBeLessThan(0.25)
})
```

- [ ] **Step 2: Implement, then the visual check (controller)**

Compare `?scene=gallery&quality=high` and `&quality=medium`: the frost of the same glass reads alike. Re-run `pnpm test:visual`; the medium and low baselines change (expected) and are regenerated and inspected.

- [ ] **Step 3: Commit**

```bash
git add packages/render examples/visual
git commit -m "fix(render): device-pixel RT floor below DPR 1; mip frost width matched to the Kawase levels"
```

---

### Task 23: Docs, manifest acceptance, push

**Files:**
- Modify: `docs/superpowers/specs/2026-10-07-glassui-core-design.md` (§3.1, §7, §8, §10, §11, §12: as built), `README.md`, `README.zh-CN.md`, `packages/vue/README.md`
- Create: `examples/playground/src/agent/AgentDemo.vue` (written by a fresh agent from the manifest alone; see Step 2)

**Interfaces:**
- Produces:
  - Spec amendments, each short and in the spec's style:
    - §3.1: the root API added in Plan 3 (`setTheme`, `setScheme`, `contrast`, `afterTick`, `screenFromPoint`, `ime`, `billboard`, centred placement, `/internal`);
    - §7.1: fall-through and click-to-focus;
    - §7.2: focus-visible ring as built;
    - §7.3: `ImeBridge` as built, EditContext deferred;
    - §8.1: the renderer as built (style layers, anchors, `mount()` without a target);
    - §8.2: the component table as built (props that differ from the spec's sketch: Button `size`/`shape`/`loading`, Input `size`/`type`, Dialog `width`/`closeOnEscape`; `Surface.shadow` deferred);
    - §10: the test suites as built;
    - §11: Phase 3 done (Plan 3 path);
    - §12: remaining deferred items (this plan's Deferred list).
  - READMEs: status table (Plan 3 done), "Try it" with `pnpm playground` scenes and `pnpm manifest`, and a 15-line Vue example.

- [ ] **Step 1: Docs**

Write the amendments and READMEs. `pnpm test` (unaffected).

- [ ] **Step 2: Manifest acceptance (controller) — spec §0 success criterion 1**

The controller dispatches a fresh agent that has never seen this repo's sources:
- it gets only `packages/vue/manifest.json` and `packages/vue/README.md`;
- its task is: "write `AgentDemo.vue`: a settings panel on a centred glass Surface with a title, a name Input, an email Input, a 'Notifications' Switch, a 'Terms' Checkbox, a primary 'Save' Button that opens a confirmation Dialog with Cancel/Confirm buttons";
- it may not read anything else.

The controller then:
1. drops the file into `examples/playground/src/agent/`;
2. adds `?scene=agent`;
3. checks it compiles (`pnpm playground:build`) and renders correctly on WebGPU and WebGL2 with no console errors.

Every place the agent got stuck or guessed wrong is a manifest defect: fix the description or example, regenerate, and record it. The acceptance passes when the agent's file works unchanged, or with fixes that only the manifest needed.

- [ ] **Step 3: Commit and push**

```bash
git add docs README.md README.zh-CN.md packages/vue examples/playground
git commit -m "docs: Plan 3 as built; manifest acceptance demo written from the manifest alone"
git push origin main
```

---

## Deferred (known, not in this plan)

- **Per-layer shadow fit** (Plan 2 g / M8).
  - A second key light would double the lighting budget, and three applies lights to every receiver, so screen and world layers cannot be lit separately without per-object light layers.
  - The mixed `?scene=both` case keeps one fit. A real fix needs shadow-only lights or light layers.
- **`EditContext`** (spec §7.3 "Chromium 上若有则优先"): the proxy textarea works on every engine; EditContext only adds exact character bounds on Chromium.
- **Text `selectable`, inline rich text that re-wraps across runs, ThemeProvider (subtree themes).** One theme per root for now; `setScheme` covers dark mode.
- **`@glassui/tres`** (TresJS adapter, spec §2): not in Phase 3's list (§11).
- **`Surface.shadow` / `castToWorld`** (spec §3.2, §5.4): UI shadows stay inside the UI.
- **Touch drag scrolling with inertia** (core `ScrollPhysics` is not wired to the bridge; wheel scrolling works). This comes with the first list component.
- **Icons in the glyph atlas** (one draw for all icons). Icons are image draws for now; revisit if the perf baseline shows them.
- **Plan 2's remaining deferred items:**
  - `physicalStacking`;
  - analytic shadows for low/minimal;
  - medium `dispersion: 'auto'`;
  - adaptive luma → text colour;
  - `@pmndrs/pointer-events`;
  - GPU timestamps / idle-rAF seeding for `'auto'`;
  - host shadow-map save/restore;
  - archiving `spikes/*`.
- **The `safeArea` / `visualViewport` response of fill Surfaces** to a mobile soft keyboard (spec §7.3, last sentence). The IME proxy follows the visual viewport; layout does not yet.

## Self-review

**Spec coverage (Phase 3, §11):**

| Spec item | Task |
|---|---|
| Renderer (§8.1) | 6 |
| Component infrastructure, prop validation, Transition (§8.2, §9, §4.4) | 7 |
| Surface / Box / Text / Icon / Stack | 8–9 |
| Button | 10 |
| Switch, Checkbox | 11 |
| IME bridge (§7.3) | 12 |
| Input | 13 |
| Dialog / Portal | 14 |
| GlassContainer, shape fusion and glassId (§5.2, §8.2) | 15–17 |
| manifest (§8.2) | 18 |
| playground (§2) | 19 |
| visual regression (§10) | 20 |
| performance baseline (§10) | 21 |
| §7.1 fall-through, click-to-focus, dblclick, contextmenu | 1–2 |
| §7.2 focus-visible ring and glint | 2, 10 |
| §8.3 contrast | 4 |
| §9 dev error marker | 6 |
| §0 success criterion 1 (an agent writes a UI from the manifest) | 23 |

Plan 2's "Plan 3 first task" list:

| Item | Task |
|---|---|
| I7 | 1 |
| exports | 4 |
| M3, M1 | 5 |
| M4, f, pyramid crop, hysteresis, grazing cap | 21 |
| e and the DPR < 1 floor | 22 |
| M9 | 20 |
| g | deferred, with the reason above |

The spec's Vue `<Transition>` is provided as `GlassTransition`: runtime-dom's `<Transition>` is CSS-class based and cannot run under a custom renderer. Task 23 records this in §8.1.

**Placeholder scan:** every test step shows its test code; the fixtures are specified by their members.

**Type consistency:**
- `GlassRoot` grows only by Task 12's `ime`;
- `setStyleLayer` layers are `control < morph < transition` everywhere;
- `ImeField`/`ImeState` match between Tasks 12 and 13;
- `FusedShape` (render) and `FusedGlassInstance.shapes` (core) carry the same fields;
- `CreateSurfaceOptions.center` (Task 4) is used by Surface (9) and Dialog (14).

**Review Focus:** each of the five lines names its test and the task that owns it.
