# GlassUI Plan 1 of 3 — Foundation (monorepo, `@glassui/core`, `@glassui/text`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the framework-agnostic, GPU-free foundation of GlassUI — node tree, style/theme/tw, Yoga layout, events/focus/scroll, spring animation, render-list generation, and a Canvas2D system-font text engine with CJK support — all testable in Node, plus the remaining Phase 0 spike (CJK text engine choice).

**Architecture:** `@glassui/core` owns the retained UI node tree inside a `Surface`, resolves styles against a theme, lays out with yoga-layout (behind a `LayoutEngine` interface), dispatches pointer/keyboard events, and emits per-frame *render lists* (plain data) that the later `@glassui/render` package turns into three.js draws. `@glassui/text` provides the `TextEngine` interface and a `SystemFontEngine` (Canvas2D measurement + on-demand glyph atlas pages) so Chinese text never misses glyphs. Neither package imports three.js.

**Tech Stack:** TypeScript 5.9 (strict), pnpm workspaces, Vitest 5, zod 4, yoga-layout 3.2 (wasm), @napi-rs/canvas 1.0 (Node tests only), three 0.186 / @pmndrs/glyph 0.1 (spike only).

**Spec:** `docs/superpowers/specs/2026-10-07-glassui-core-design.md` (sections 2, 3, 4, 6, 7, 9, 10, 11 are implemented here; §5 render and §8 Vue are Plans 2 and 3).

## Global Constraints

- Node 22; pnpm; TypeScript `strict: true`, ESM only (`"type": "module"`).
- `@glassui/core` and `@glassui/text` must not import `three` (spec §2: "core 不 import three"). Enforce with a test that greps the package sources.
- The layout unit is `pt`; 1 pt = 1 CSS px in the screen layer (spec §3). All layout numbers are plain `number`s in pt.
- All validation errors are `GlassUIError` with message format `[<Component>.<prop>] <原因>。允许值：… 你可能想要：…` (spec §9) — tests assert the bracket prefix and the "你可能想要" suggestion when a near-miss exists.
- Unknown style keys / tw classes throw; they are never silently ignored (spec §4.1, §4.2).
- Default control metrics from spec §8.2: padding 26, icon 28, icon-text gap 14, group gap 12, checkbox 44×44 radius 12, switch 136×62 knob 48 margin 7.
- Spring presets `snappy` / `smooth` / `bouncy` exist in the theme (spec §4.3).
- Commit after every task with the attribution lines from the session's system reminder.

## Review Focus

Input classes the spec implies but no task's tests exercise by default; each has a pinned test in the owning task:

1. **Mixed CJK + Latin wrapping with no spaces** (`SystemFontEngine`): a line like `用户名userName必填` must break between CJK characters and keep `userName` whole when it fits — Task 13.
2. **Zero-size and negative layout inputs** (`YogaLayout`): a node with `width: 0` or a parent with `padding` larger than its size must produce finite, non-negative layout rects, never `NaN` — Task 7.
3. **Pointer events on a node hidden by `display: 'none'` or outside an `overflow: 'hidden'` parent** must not be hit — Task 8.
4. **Focus traversal when the focused node is removed from the tree** must move focus to `null` without throwing and emit `blur` — Task 9.
5. **tw prefixes stacked or unknown (`hover:focus:p-2`, `dark:p-2`)** must throw a `GlassUIError` naming the unsupported prefix — Task 6.

---

## File Structure

```
package.json                      pnpm workspace root; scripts: test, typecheck, spike:*
pnpm-workspace.yaml               packages/*, examples/*, spikes/*
tsconfig.base.json                strict ESM base shared by packages
vitest.config.ts                  root vitest config (projects = packages/*)
packages/core/
  package.json                    @glassui/core (deps: zod, yoga-layout)
  tsconfig.json
  src/index.ts                    public exports
  src/errors.ts                   GlassUIError, suggest()
  src/node.ts                     Node, NodeType, Rect, DirtyFlags
  src/surface.ts                  SurfaceModel (pt size, placement data, root node)
  src/style/schema.ts             zod Style schema + Style type + validateStyle()
  src/style/theme.ts              Theme type, defaultTheme, resolveColor/resolveLength
  src/style/tw.ts                 parseTw(): tw string → Style
  src/layout/engine.ts            LayoutEngine interface, MeasureFn
  src/layout/yoga.ts              YogaLayout (yoga-layout adapter)
  src/events/hit.ts               hitTest(), absoluteRect()
  src/events/dispatch.ts          UIEvent, EventDispatcher, PointerTracker
  src/focus.ts                    FocusManager
  src/animation/spring.ts         Spring, springFromResponse(), presets
  src/scroll.ts                   ScrollPhysics
  src/renderlist.ts               buildRenderList() → RenderList (plain data)
  test/*.test.ts                  one test file per source file
packages/text/
  package.json                    @glassui/text (devDeps: @napi-rs/canvas)
  src/index.ts
  src/types.ts                    TextRun, TextEngine, GlyphPlacement, Line, CanvasFactory
  src/atlas.ts                    AtlasManager (shelf packing, LRU pages)
  src/system.ts                   SystemFontEngine
  test/*.test.ts
spikes/glyph-cjk/                 Phase 0 ③ spike (throwaway)
docs/superpowers/spikes/2026-10-08-glyph-cjk.md   spike ③ decision
```

Key shared types (defined in Task 3/4/12, repeated here so every task can see them):

```ts
// packages/core/src/node.ts
export type NodeType = 'box' | 'text' | 'image' | 'glass' | 'scroll' | 'portal' | 'anchor'
export interface Rect { x: number; y: number; width: number; height: number }
export interface DirtyFlags { layout: boolean; paint: boolean; text: boolean; tree: boolean }
export interface NodeState { hover: boolean; pressed: boolean; focused: boolean; disabled: boolean }

// packages/text/src/types.ts
export interface FontSpec { family: string; size: number; weight: number }
export interface TextRun { text: string; font: FontSpec; letterSpacing?: number; lineHeight?: number }
export interface Line { text: string; start: number; end: number; width: number; y: number }
export interface GlyphPlacement { char: string; x: number; y: number; width: number; height: number; page: number; u0: number; v0: number; u1: number; v1: number }
```

---

### Task 1: Monorepo scaffold and test harness

**Files:**
- Modify: `package.json` (root; exists with spike scripts)
- Create: `tsconfig.base.json`, `vitest.config.ts`
- Create: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`
- Create: `packages/text/package.json`, `packages/text/tsconfig.json`, `packages/text/src/index.ts`
- Test: `packages/core/test/no-three.test.ts`

**Interfaces:**
- Produces: workspace packages `@glassui/core`, `@glassui/text` importable by name; `pnpm test` runs all `packages/*/test/**/*.test.ts`; `pnpm typecheck` runs `tsc -b`.

- [ ] **Step 1: Write the failing test (core must never import three)**

`packages/core/test/no-three.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? files(p) : [p]
  })
}

describe('@glassui/core stays GPU-free', () => {
  it('never imports three', () => {
    const src = join(__dirname, '..', 'src')
    for (const f of files(src)) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/from ['"]three/)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails (no src dir / no runner yet)**

Run: `pnpm vitest run packages/core` — Expected: fails ("vitest: command not found" or no test files / ENOENT for src).

- [ ] **Step 3: Create the workspace files**

`package.json` (replace the whole file; keep the spike scripts):
```json
{
  "name": "glassui-monorepo",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -b packages/core packages/text",
    "spike:glass": "vite spikes/glass",
    "spike:glass3d": "vite spikes/glass3d --port 5174"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/three": "^0.186.0",
    "three": "^0.186.1",
    "typescript": "^5.9.3",
    "vite": "^8.3.3",
    "vitest": "^5.0.3"
  }
}
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "composite": true,
    "skipLibCheck": true,
    "types": ["node"]
  }
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
  },
})
```

`packages/core/package.json`:
```json
{
  "name": "@glassui/core",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "yoga-layout": "^3.2.1", "zod": "^4.6.5" }
}
```

`packages/core/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "rootDir": "src", "outDir": "dist" }, "include": ["src"] }
```

`packages/core/src/index.ts`:
```ts
export const CORE_VERSION = '0.0.0'
```

`packages/text/package.json`:
```json
{
  "name": "@glassui/text",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "devDependencies": { "@napi-rs/canvas": "^1.0.10" }
}
```

`packages/text/tsconfig.json`: same as core's. `packages/text/src/index.ts`: `export const TEXT_VERSION = '0.0.0'`.

- [ ] **Step 4: Install and run**

Run: `pnpm install && pnpm test && pnpm typecheck`
Expected: 1 test passes (`never imports three`); typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.base.json vitest.config.ts packages
git commit -m "chore: monorepo scaffold for @glassui/core and @glassui/text with vitest"
```

---

### Task 2: `GlassUIError` and name suggestions

**Files:**
- Create: `packages/core/src/errors.ts`
- Test: `packages/core/test/errors.test.ts`

**Interfaces:**
- Produces: `class GlassUIError extends Error { constructor(scope: string, reason: string, opts?: { allowed?: readonly string[]; got?: string }) }` — message `[scope] reason。允许值：a, b。你可能想要：b` (suggestion only when `got` is within edit distance 2 of an allowed value); `suggest(got: string, candidates: readonly string[]): string | null`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/errors.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { GlassUIError, suggest } from '../src/errors'

describe('suggest', () => {
  it('returns the nearest candidate within distance 2', () => {
    expect(suggest('flexDirecton', ['flexDirection', 'alignItems'])).toBe('flexDirection')
  })
  it('returns null when nothing is close', () => {
    expect(suggest('banana', ['flexDirection'])).toBeNull()
  })
})

describe('GlassUIError', () => {
  it('formats scope, reason, allowed values and a suggestion', () => {
    const e = new GlassUIError('Button.variant', '未知取值 "glas"', { allowed: ['glass', 'filled'], got: 'glas' })
    expect(e.message).toBe('[Button.variant] 未知取值 "glas"。允许值：glass, filled。你可能想要：glass')
    expect(e).toBeInstanceOf(Error)
    expect(e.name).toBe('GlassUIError')
  })
  it('omits the suggestion when there is no near miss', () => {
    const e = new GlassUIError('Box.style', '未知键 "zzz"', { allowed: ['padding'], got: 'zzz' })
    expect(e.message).toBe('[Box.style] 未知键 "zzz"。允许值：padding')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run packages/core/test/errors.test.ts` — Expected: FAIL, cannot resolve `../src/errors`.

- [ ] **Step 3: Implement**

`packages/core/src/errors.ts`:
```ts
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  const d: number[] = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    let prev = d[0]!
    d[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = d[j]!
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return d[n]!
}

/** Nearest candidate within edit distance 2 (case-insensitive), or null. */
export function suggest(got: string, candidates: readonly string[]): string | null {
  let best: string | null = null
  let bestD = 3
  for (const c of candidates) {
    const d = levenshtein(got.toLowerCase(), c.toLowerCase())
    if (d < bestD) { bestD = d; best = c }
  }
  return best
}

export class GlassUIError extends Error {
  override readonly name = 'GlassUIError'
  constructor(scope: string, reason: string, opts: { allowed?: readonly string[]; got?: string } = {}) {
    let msg = `[${scope}] ${reason}`
    if (opts.allowed && opts.allowed.length) msg += `。允许值：${opts.allowed.join(', ')}`
    if (opts.allowed && opts.got !== undefined) {
      const s = suggest(opts.got, opts.allowed)
      if (s) msg += `。你可能想要：${s}`
    }
    super(msg)
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run packages/core/test/errors.test.ts` — Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/errors.ts packages/core/test/errors.test.ts
git commit -m "feat(core): GlassUIError with allowed-value listing and nearest-name suggestion"
```

---

### Task 3: Node tree

**Files:**
- Create: `packages/core/src/node.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/node.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class Node {
    readonly id: string; readonly type: NodeType
    parent: Node | null; readonly children: Node[]
    props: Record<string, unknown>
    style: Style            // from Task 4 (import type; until then `Record<string, unknown>`)
    layout: Rect; state: NodeState; elevation: number; tilt: { x: number; y: number }
    dirty: DirtyFlags
    constructor(type: NodeType, id?: string)
    appendChild(child: Node): void
    insertBefore(child: Node, ref: Node | null): void   // ref null → append
    removeChild(child: Node): void
    remove(): void
    setStyle(partial: Partial<Style>): void   // marks layout+paint dirty
    setProp(key: string, value: unknown): void // marks paint dirty (text nodes: text dirty)
    markDirty(flag: keyof DirtyFlags): void   // propagates `layout` and `tree` up to the root
    walk(fn: (n: Node) => void): void          // pre-order
    get root(): Node
  }
  ```

- [ ] **Step 1: Write the failing test**

`packages/core/test/node.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { Node } from '../src/node'

describe('Node tree', () => {
  it('appends, inserts before, and removes children while keeping parent pointers', () => {
    const root = new Node('box', 'root')
    const a = new Node('box', 'a'), b = new Node('text', 'b'), c = new Node('box', 'c')
    root.appendChild(a); root.appendChild(c)
    root.insertBefore(b, c)
    expect(root.children.map(n => n.id)).toEqual(['a', 'b', 'c'])
    expect(b.parent).toBe(root)
    root.removeChild(b)
    expect(root.children.map(n => n.id)).toEqual(['a', 'c'])
    expect(b.parent).toBeNull()
  })
  it('moving a node between parents detaches it from the old parent', () => {
    const p1 = new Node('box'), p2 = new Node('box'), x = new Node('box', 'x')
    p1.appendChild(x); p2.appendChild(x)
    expect(p1.children).toHaveLength(0)
    expect(p2.children[0]).toBe(x)
  })
  it('dirty flags propagate layout and tree changes to the root', () => {
    const root = new Node('box'), child = new Node('box')
    root.appendChild(child)
    root.dirty = { layout: false, paint: false, text: false, tree: false }
    child.dirty = { layout: false, paint: false, text: false, tree: false }
    child.setStyle({ width: 10 })
    expect(child.dirty.layout).toBe(true)
    expect(root.dirty.layout).toBe(true)
    expect(root.dirty.paint).toBe(false)
  })
  it('setProp on a text node marks text dirty; walk visits pre-order', () => {
    const root = new Node('box', 'r'), t = new Node('text', 't'), b = new Node('box', 'b')
    root.appendChild(t); root.appendChild(b)
    t.setProp('value', 'hi')
    expect(t.dirty.text).toBe(true)
    const seen: string[] = []
    root.walk(n => seen.push(n.id))
    expect(seen).toEqual(['r', 't', 'b'])
    expect(b.root).toBe(root)
  })
  it('generates unique ids when none is given', () => {
    expect(new Node('box').id).not.toBe(new Node('box').id)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `pnpm vitest run packages/core/test/node.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/core/src/node.ts`:
```ts
import type { Style } from './style/schema'   // created in Task 4; until then declare `export type Style = Record<string, unknown>` in a stub file

export type NodeType = 'box' | 'text' | 'image' | 'glass' | 'scroll' | 'portal' | 'anchor'
export interface Rect { x: number; y: number; width: number; height: number }
export interface DirtyFlags { layout: boolean; paint: boolean; text: boolean; tree: boolean }
export interface NodeState { hover: boolean; pressed: boolean; focused: boolean; disabled: boolean }

let nextId = 1

export class Node {
  readonly id: string
  readonly type: NodeType
  parent: Node | null = null
  readonly children: Node[] = []
  props: Record<string, unknown> = {}
  style: Style = {} as Style
  layout: Rect = { x: 0, y: 0, width: 0, height: 0 }
  state: NodeState = { hover: false, pressed: false, focused: false, disabled: false }
  elevation = 0
  tilt = { x: 0, y: 0 }
  dirty: DirtyFlags = { layout: true, paint: true, text: true, tree: true }

  constructor(type: NodeType, id?: string) {
    this.type = type
    this.id = id ?? `${type}-${nextId++}`
  }

  get root(): Node { let n: Node = this; while (n.parent) n = n.parent; return n }

  appendChild(child: Node): void { this.insertBefore(child, null) }

  insertBefore(child: Node, ref: Node | null): void {
    if (child.parent) child.parent.removeChild(child)
    const idx = ref ? this.children.indexOf(ref) : -1
    if (ref && idx < 0) throw new Error(`insertBefore: ref ${ref.id} is not a child of ${this.id}`)
    if (idx < 0) this.children.push(child); else this.children.splice(idx, 0, child)
    child.parent = this
    this.markDirty('tree'); this.markDirty('layout')
  }

  removeChild(child: Node): void {
    const idx = this.children.indexOf(child)
    if (idx < 0) return
    this.children.splice(idx, 1)
    child.parent = null
    this.markDirty('tree'); this.markDirty('layout')
  }

  remove(): void { this.parent?.removeChild(this) }

  setStyle(partial: Partial<Style>): void {
    this.style = { ...this.style, ...partial }
    this.markDirty('layout'); this.markDirty('paint')
  }

  setProp(key: string, value: unknown): void {
    this.props = { ...this.props, [key]: value }
    this.markDirty('paint')
    if (this.type === 'text') { this.markDirty('text'); this.markDirty('layout') }
  }

  markDirty(flag: keyof DirtyFlags): void {
    this.dirty[flag] = true
    if (flag === 'layout' || flag === 'tree') {
      for (let p = this.parent; p; p = p.parent) { if (p.dirty[flag]) break; p.dirty[flag] = true }
    }
  }

  walk(fn: (n: Node) => void): void { fn(this); for (const c of this.children) c.walk(fn) }
}
```

Until Task 4 exists, create `packages/core/src/style/schema.ts` containing only `export type Style = Record<string, unknown>` (Task 4 replaces it). Add to `index.ts`: `export * from './node'; export * from './errors'`.

- [ ] **Step 4: Run to verify it passes** — `pnpm vitest run packages/core/test/node.test.ts` → 5 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src
git add packages/core/test/node.test.ts
git commit -m "feat(core): retained Node tree with dirty-flag propagation"
```

---

### Task 4: Style schema and validation

**Files:**
- Create/replace: `packages/core/src/style/schema.ts`
- Test: `packages/core/test/style-schema.test.ts`

**Interfaces:**
- Produces: `StyleSchema` (zod), `type Style = z.infer<typeof StyleSchema>`, `validateStyle(style: unknown, scope = 'style'): Style` (throws `GlassUIError`), `type Length = number | \`${number}%\` | 'auto'`, `STYLE_KEYS: readonly string[]`.

- [ ] **Step 1: Write the failing test**

`packages/core/test/style-schema.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { validateStyle, STYLE_KEYS } from '../src/style/schema'

describe('validateStyle', () => {
  it('accepts a valid flex style with tokens and state branches', () => {
    const s = validateStyle({
      flexDirection: 'row', gap: 8, padding: 12, width: '100%', bg: 'glass', radius: 'capsule',
      hover: { opacity: 0.9 }, transition: { opacity: 'snappy' },
    })
    expect(s.flexDirection).toBe('row')
    expect(s.hover?.opacity).toBe(0.9)
  })
  it('rejects unknown keys with a suggestion', () => {
    expect(() => validateStyle({ flexDirecton: 'row' }, 'Box.style'))
      .toThrow('[Box.style] 未知键 "flexDirecton"')
    expect(() => validateStyle({ flexDirecton: 'row' }, 'Box.style'))
      .toThrow('你可能想要：flexDirection')
  })
  it('rejects wrong enum values listing the allowed ones', () => {
    expect(() => validateStyle({ justifyContent: 'middle' }))
      .toThrow(/\[style\.justifyContent\].*允许值：flex-start, center, flex-end, space-between, space-around, space-evenly/)
  })
  it('rejects bad length strings', () => {
    expect(() => validateStyle({ width: '10px' })).toThrow('[style.width]')
  })
  it('exports the key list for tooling', () => {
    expect(STYLE_KEYS).toContain('padding')
    expect(STYLE_KEYS).toContain('glass')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL (`validateStyle` is not exported).

- [ ] **Step 3: Implement**

`packages/core/src/style/schema.ts`:
```ts
import { z } from 'zod'
import { GlassUIError } from '../errors'

const Length = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?%$/, 'length must be a number (pt) or "N%"'), z.literal('auto')])
const Pt = z.number()
const Token = z.string()   // design-token name or literal colour; resolved by theme.ts

export const GlassParamsSchema = z.object({
  variant: z.enum(['regular', 'clear']).optional(),
  thickness: Pt.optional(), fillet: Pt.optional(), filletBottom: Pt.optional(),
  profile: z.enum(['fillet', 'lens']).optional(),
  scatter: z.number().min(0).max(1).optional(), lift: z.number().min(0).max(1).optional(),
  edgeGlow: z.number().min(0).optional(),
  glow: z.object({ color: Token, strength: z.number().min(0), split: z.number().min(0).max(1).optional() }).nullable().optional(),
  ior: z.number().optional(), dispersion: z.number().min(0).max(1).optional(), roughness: z.number().min(0).max(1).optional(),
  tint: Token.nullable().optional(), absorption: z.number().min(0).optional(),
  envIntensity: z.number().min(0).optional(), specularIntensity: z.number().min(0).optional(),
  innerGlow: z.number().min(0).optional(), adaptive: z.boolean().optional(),
  cornerExponent: z.number().min(2).optional(),
}).strict()

const Transition = z.union([
  z.enum(['snappy', 'smooth', 'bouncy']),
  z.object({ stiffness: z.number(), damping: z.number(), mass: z.number().optional() }).strict(),
  z.object({ response: z.number(), dampingFraction: z.number() }).strict(),
  z.object({ duration: z.number(), easing: z.enum(['linear', 'ease-in', 'ease-out', 'ease-in-out']) }).strict(),
])

const Base = z.object({
  display: z.enum(['flex', 'none']).optional(),
  position: z.enum(['relative', 'absolute']).optional(),
  flexDirection: z.enum(['row', 'column', 'row-reverse', 'column-reverse']).optional(),
  justifyContent: z.enum(['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']).optional(),
  alignItems: z.enum(['flex-start', 'center', 'flex-end', 'stretch', 'baseline']).optional(),
  alignSelf: z.enum(['auto', 'flex-start', 'center', 'flex-end', 'stretch']).optional(),
  flexWrap: z.enum(['nowrap', 'wrap']).optional(),
  flex: z.number().optional(), flexGrow: z.number().optional(), flexShrink: z.number().optional(), flexBasis: Length.optional(),
  width: Length.optional(), height: Length.optional(),
  minWidth: Length.optional(), maxWidth: Length.optional(), minHeight: Length.optional(), maxHeight: Length.optional(),
  aspectRatio: z.number().optional(),
  padding: Pt.optional(), paddingX: Pt.optional(), paddingY: Pt.optional(),
  paddingTop: Pt.optional(), paddingRight: Pt.optional(), paddingBottom: Pt.optional(), paddingLeft: Pt.optional(),
  margin: Pt.optional(), marginX: Pt.optional(), marginY: Pt.optional(),
  marginTop: Pt.optional(), marginRight: Pt.optional(), marginBottom: Pt.optional(), marginLeft: Pt.optional(),
  gap: Pt.optional(), rowGap: Pt.optional(), columnGap: Pt.optional(),
  top: Length.optional(), right: Length.optional(), bottom: Length.optional(), left: Length.optional(), inset: Length.optional(),
  overflow: z.enum(['visible', 'hidden', 'scroll']).optional(),
  pointerEvents: z.enum(['auto', 'none']).optional(),
  bg: z.union([Token, z.literal('glass'), z.literal('glass-clear'), z.literal('none')]).optional(),
  radius: z.union([Pt, z.literal('capsule'), z.literal('concentric'), Token]).optional(),
  border: z.object({ width: Pt, color: Token }).strict().optional(),
  shadow: Token.optional(),
  opacity: z.number().min(0).max(1).optional(),
  font: Token.optional(), fontSize: z.union([Pt, Token]).optional(), fontWeight: z.number().int().min(100).max(900).optional(),
  lineHeight: z.number().optional(), letterSpacing: z.number().optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(), color: Token.optional(),
  maxLines: z.number().int().min(1).optional(), wrap: z.boolean().optional(),
  glass: GlassParamsSchema.partial().optional(),
  transition: z.record(z.string(), Transition).optional(),
}).strict()

export const StyleSchema: z.ZodType<Style> = Base.extend({
  hover: z.lazy(() => Base).optional(),
  pressed: z.lazy(() => Base).optional(),
  focused: z.lazy(() => Base).optional(),
  disabled: z.lazy(() => Base).optional(),
}).strict()

type BaseStyle = z.infer<typeof Base>
export interface Style extends BaseStyle { hover?: BaseStyle; pressed?: BaseStyle; focused?: BaseStyle; disabled?: BaseStyle }
export type Length = z.infer<typeof Length>
export const STYLE_KEYS: readonly string[] = [...Object.keys(Base.shape), 'hover', 'pressed', 'focused', 'disabled']

export function validateStyle(style: unknown, scope = 'style'): Style {
  const r = StyleSchema.safeParse(style)
  if (r.success) return r.data
  const issue = r.error.issues[0]!
  const path = issue.path.map(String)
  const key = path[0] ?? ''
  const where = path.length ? `${scope}.${path.join('.')}` : scope
  if (issue.code === 'unrecognized_keys') {
    const bad = (issue as { keys: string[] }).keys[0]!
    throw new GlassUIError(scope, `未知键 "${bad}"`, { allowed: STYLE_KEYS, got: bad })
  }
  if (issue.code === 'invalid_value') {
    const allowed = ((issue as { values?: unknown[] }).values ?? []).map(String)
    throw new GlassUIError(where, `非法取值`, { allowed, got: String((style as Record<string, unknown>)[key]) })
  }
  throw new GlassUIError(where, issue.message)
}
```

Note for the implementer: zod 4 reports enum mismatches as `invalid_value` with `values`; a union of enums (e.g. `bg`) reports `invalid_union` — the generic branch handles it. Verify the exact issue shape with `console.log(r.error.issues)` once, then delete the log.

- [ ] **Step 4: Run to verify it passes** — `pnpm vitest run packages/core/test/style-schema.test.ts` → 5 passed. Also `pnpm vitest run packages/core/test/node.test.ts` still passes with the real `Style` type.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/style/schema.ts packages/core/test/style-schema.test.ts
git commit -m "feat(core): zod Style schema with strict keys, state branches and readable errors"
```

---

### Task 5: Theme and token resolution

**Files:**
- Create: `packages/core/src/style/theme.ts`
- Test: `packages/core/test/theme.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface Theme { colors: { light: Record<string, string>; dark: Record<string, string> }; spacing: number[]; radius: Record<string, number>; fontSize: Record<string, number>; springs: Record<'snappy'|'smooth'|'bouncy', { stiffness: number; damping: number; mass: number }>; glass: Required<Pick<GlassParams,'thickness'|'fillet'|'filletBottom'|'scatter'|'lift'|'edgeGlow'|'ior'|'dispersion'|'roughness'>>; metrics: { controlPadding: 26; icon: 28; iconGap: 14; groupGap: 12; checkbox: 44; checkboxRadius: 12; switchWidth: 136; switchHeight: 62; knob: 48; knobMargin: 7 } }
  export const defaultTheme: Theme
  export type ColorScheme = 'light' | 'dark'
  export function resolveColor(token: string, theme: Theme, scheme: ColorScheme): [r: number, g: number, b: number, a: number]  // 0..1 linear-ish sRGB floats; accepts token names, #rgb/#rrggbb/#rrggbbaa, rgba()
  export function resolveRadius(v: Style['radius'], theme: Theme, width: number, height: number, parentRadius?: number, inset?: number): number
  export function resolveFontSize(v: Style['fontSize'], theme: Theme): number
  ```

- [ ] **Step 1: Write the failing test**

`packages/core/test/theme.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { defaultTheme, resolveColor, resolveRadius, resolveFontSize } from '../src/style/theme'

describe('theme', () => {
  it('resolves semantic colour tokens per scheme', () => {
    const light = resolveColor('label', defaultTheme, 'light')
    const dark = resolveColor('label', defaultTheme, 'dark')
    expect(light[0]).toBeLessThan(0.2)   // dark text on light
    expect(dark[0]).toBeGreaterThan(0.8) // light text on dark
  })
  it('parses hex and rgba literals', () => {
    expect(resolveColor('#6b63f5', defaultTheme, 'light')).toEqual([0x6b / 255, 0x63 / 255, 0xf5 / 255, 1])
    expect(resolveColor('#fff8', defaultTheme, 'light')).toEqual([1, 1, 1, 0x88 / 255])
    expect(resolveColor('rgba(255, 0, 0, 0.5)', defaultTheme, 'light')).toEqual([1, 0, 0, 0.5])
  })
  it('throws a GlassUIError for unknown tokens with a suggestion', () => {
    expect(() => resolveColor('acent', defaultTheme, 'light')).toThrow('你可能想要：accent')
  })
  it('resolves radius keywords', () => {
    expect(resolveRadius('capsule', defaultTheme, 200, 80)).toBe(40)
    expect(resolveRadius('concentric', defaultTheme, 200, 80, 24, 8)).toBe(16)
    expect(resolveRadius('lg', defaultTheme, 200, 80)).toBe(defaultTheme.radius.lg)
    expect(resolveRadius(7, defaultTheme, 200, 80)).toBe(7)
  })
  it('resolves font-size tokens and numbers', () => {
    expect(resolveFontSize('base', defaultTheme)).toBe(defaultTheme.fontSize.base)
    expect(resolveFontSize(17, defaultTheme)).toBe(17)
  })
  it('ships the spec control metrics and spring presets', () => {
    expect(defaultTheme.metrics).toMatchObject({ controlPadding: 26, icon: 28, iconGap: 14, groupGap: 12, checkbox: 44, checkboxRadius: 12, switchWidth: 136, switchHeight: 62, knob: 48, knobMargin: 7 })
    expect(Object.keys(defaultTheme.springs)).toEqual(['snappy', 'smooth', 'bouncy'])
  })
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/core/src/style/theme.ts`:
```ts
import { GlassUIError } from '../errors'
import type { Style } from './schema'

export type ColorScheme = 'light' | 'dark'
export type RGBA = [number, number, number, number]

export interface Theme {
  colors: { light: Record<string, string>; dark: Record<string, string> }
  spacing: number[]
  radius: Record<string, number>
  fontSize: Record<string, number>
  springs: Record<'snappy' | 'smooth' | 'bouncy', { stiffness: number; damping: number; mass: number }>
  glass: { thickness: number; fillet: number; filletBottom: number; scatter: number; lift: number; edgeGlow: number; ior: number; dispersion: number; roughness: number }
  metrics: { controlPadding: number; icon: number; iconGap: number; groupGap: number; checkbox: number; checkboxRadius: number; switchWidth: number; switchHeight: number; knob: number; knobMargin: number }
}

export const defaultTheme: Theme = {
  colors: {
    light: { accent: '#6b63f5', label: '#1c1c22', secondaryLabel: '#6a6a78', tertiaryLabel: '#8a8a98', fill: '#ffffff', separator: '#00000014', danger: '#ff3b30', success: '#34c759' },
    dark: { accent: '#8a83ff', label: '#f2f2f7', secondaryLabel: '#aeaeb8', tertiaryLabel: '#8e8e98', fill: '#1c1c22', separator: '#ffffff1f', danger: '#ff453a', success: '#30d158' },
  },
  spacing: [0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64, 80, 96],
  radius: { none: 0, sm: 8, md: 12, lg: 16, xl: 24, '2xl': 32 },
  fontSize: { xs: 12, sm: 14, base: 17, lg: 20, xl: 24, '2xl': 30, '3xl': 36, '4xl': 46 },
  springs: {
    snappy: { stiffness: 400, damping: 30, mass: 1 },
    smooth: { stiffness: 170, damping: 26, mass: 1 },
    bouncy: { stiffness: 300, damping: 15, mass: 1 },
  },
  glass: { thickness: 16, fillet: 5, filletBottom: 3, scatter: 0.05, lift: 0.1, edgeGlow: 0.8, ior: 1.5, dispersion: 0.8, roughness: 0.06 },
  metrics: { controlPadding: 26, icon: 28, iconGap: 14, groupGap: 12, checkbox: 44, checkboxRadius: 12, switchWidth: 136, switchHeight: 62, knob: 48, knobMargin: 7 },
}

function hexToRgba(hex: string): RGBA | null {
  const h = hex.slice(1)
  const n = h.length
  if (![3, 4, 6, 8].includes(n) || !/^[0-9a-f]+$/i.test(h)) return null
  const full = n <= 4 ? [...h].map(c => c + c).join('') : h
  const v = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255
  return [v(0), v(2), v(4), full.length === 8 ? v(6) : 1]
}

export function resolveColor(token: string, theme: Theme, scheme: ColorScheme): RGBA {
  if (token.startsWith('#')) {
    const c = hexToRgba(token)
    if (!c) throw new GlassUIError('color', `非法颜色 "${token}"`)
    return c
  }
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(token)
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, m[4] === undefined ? 1 : Number(m[4])]
  const table = theme.colors[scheme]
  const hex = table[token]
  if (hex === undefined) throw new GlassUIError('color', `未知颜色 token "${token}"`, { allowed: Object.keys(table), got: token })
  return resolveColor(hex, theme, scheme)
}

export function resolveRadius(v: Style['radius'], theme: Theme, width: number, height: number, parentRadius = 0, inset = 0): number {
  if (v === undefined) return 0
  if (typeof v === 'number') return v
  if (v === 'capsule') return Math.min(width, height) / 2
  if (v === 'concentric') return Math.max(parentRadius - inset, 0)
  const r = theme.radius[v]
  if (r === undefined) throw new GlassUIError('style.radius', `未知 radius token "${v}"`, { allowed: [...Object.keys(theme.radius), 'capsule', 'concentric'], got: v })
  return r
}

export function resolveFontSize(v: Style['fontSize'], theme: Theme): number {
  if (v === undefined) return theme.fontSize.base!
  if (typeof v === 'number') return v
  const s = theme.fontSize[v]
  if (s === undefined) throw new GlassUIError('style.fontSize', `未知 fontSize token "${v}"`, { allowed: Object.keys(theme.fontSize), got: v })
  return s
}
```

- [ ] **Step 4: Run to verify it passes** — 6 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/style/theme.ts packages/core/test/theme.test.ts
git commit -m "feat(core): default theme, colour/radius/font-size token resolution, control metrics"
```

---

### Task 6: `tw` string parser

**Files:**
- Create: `packages/core/src/style/tw.ts`
- Test: `packages/core/test/tw.test.ts`

**Interfaces:**
- Produces: `parseTw(tw: string, theme: Theme, scope = 'tw'): Style`. Supported classes (and only these): `flex`, `flex-row|col|row-reverse|col-reverse`, `flex-wrap|nowrap`, `flex-1`, `grow`, `shrink-0`, `items-start|center|end|stretch|baseline`, `justify-start|center|end|between|around|evenly`, `self-start|center|end|stretch`, `gap-N`, `gap-x-N`, `gap-y-N`, `p-N`, `px-N`, `py-N`, `pt-N`, `pr-N`, `pb-N`, `pl-N`, `m-*` same set, `w-N|w-full|w-auto|w-[42]|w-[50%]`, `h-*`, `min-w-*`, `max-w-*`, `rounded-{none,sm,md,lg,xl,2xl,full}`, `bg-{token}|bg-glass|bg-glass-clear|bg-[#hex]`, `text-{xs..4xl}`, `text-{colorToken}`, `text-left|center|right`, `font-{100..900}|font-bold(700)|font-medium(500)|font-semibold(600)`, `opacity-N` (0–100), `shadow-{sm,md,lg}`, `overflow-hidden|scroll|visible`, `absolute|relative`, `hidden` (display none), `inset-N|top-N|right-N|bottom-N|left-N`; prefixes `hover:`, `focus:`, `active:` (→ pressed), `disabled:`. `N` indexes `theme.spacing` (`p-3` → 12) or `[42]` literal pt.

- [ ] **Step 1: Write the failing test**

`packages/core/test/tw.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseTw } from '../src/style/tw'
import { defaultTheme as t } from '../src/style/theme'

describe('parseTw', () => {
  it('maps layout, spacing, radius and colour classes', () => {
    expect(parseTw('flex flex-row items-center justify-between gap-2 px-4 py-2 rounded-full bg-glass w-full', t)).toEqual({
      display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      gap: 8, paddingX: 16, paddingY: 8, radius: 'capsule', bg: 'glass', width: '100%',
    })
  })
  it('supports arbitrary values and typography', () => {
    expect(parseTw('w-[42] h-[50%] text-sm text-accent font-semibold opacity-80 text-center', t)).toEqual({
      width: 42, height: '50%', fontSize: 'sm', color: 'accent', fontWeight: 600, opacity: 0.8, textAlign: 'center',
    })
  })
  it('puts prefixed classes into state branches', () => {
    expect(parseTw('p-2 hover:opacity-90 active:p-1 focus:bg-accent disabled:opacity-40', t)).toEqual({
      padding: 8, hover: { opacity: 0.9 }, pressed: { padding: 4 }, focused: { bg: 'accent' }, disabled: { opacity: 0.4 },
    })
  })
  it('throws with suggestions for unknown classes', () => {
    expect(() => parseTw('flex-rwo', t, 'Box.tw')).toThrow('[Box.tw] 未知 class "flex-rwo"')
    expect(() => parseTw('flex-rwo', t, 'Box.tw')).toThrow('你可能想要：flex-row')
  })
  it('throws for unsupported or stacked prefixes', () => {
    expect(() => parseTw('dark:p-2', t)).toThrow('不支持的前缀 "dark"')
    expect(() => parseTw('hover:focus:p-2', t)).toThrow('不支持的前缀')
  })
  it('throws for a spacing index outside the scale', () => {
    expect(() => parseTw('p-99', t)).toThrow('[tw] spacing 索引 99 超出范围')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/core/src/style/tw.ts`:
```ts
import { GlassUIError } from '../errors'
import type { Style } from './schema'
import type { Theme } from './theme'

type Base = Omit<Style, 'hover' | 'pressed' | 'focused' | 'disabled'>
const PREFIX: Record<string, 'hover' | 'pressed' | 'focused' | 'disabled'> = { hover: 'hover', active: 'pressed', focus: 'focused', disabled: 'disabled' }

const ENUMS: Record<string, Partial<Base>> = {
  flex: { display: 'flex' }, hidden: { display: 'none' }, absolute: { position: 'absolute' }, relative: { position: 'relative' },
  'flex-row': { flexDirection: 'row' }, 'flex-col': { flexDirection: 'column' },
  'flex-row-reverse': { flexDirection: 'row-reverse' }, 'flex-col-reverse': { flexDirection: 'column-reverse' },
  'flex-wrap': { flexWrap: 'wrap' }, 'flex-nowrap': { flexWrap: 'nowrap' }, 'flex-1': { flex: 1 }, grow: { flexGrow: 1 }, 'shrink-0': { flexShrink: 0 },
  'items-start': { alignItems: 'flex-start' }, 'items-center': { alignItems: 'center' }, 'items-end': { alignItems: 'flex-end' }, 'items-stretch': { alignItems: 'stretch' }, 'items-baseline': { alignItems: 'baseline' },
  'justify-start': { justifyContent: 'flex-start' }, 'justify-center': { justifyContent: 'center' }, 'justify-end': { justifyContent: 'flex-end' }, 'justify-between': { justifyContent: 'space-between' }, 'justify-around': { justifyContent: 'space-around' }, 'justify-evenly': { justifyContent: 'space-evenly' },
  'self-start': { alignSelf: 'flex-start' }, 'self-center': { alignSelf: 'center' }, 'self-end': { alignSelf: 'flex-end' }, 'self-stretch': { alignSelf: 'stretch' },
  'rounded-none': { radius: 0 }, 'rounded-sm': { radius: 'sm' }, 'rounded-md': { radius: 'md' }, 'rounded-lg': { radius: 'lg' }, 'rounded-xl': { radius: 'xl' }, 'rounded-2xl': { radius: '2xl' }, 'rounded-full': { radius: 'capsule' },
  'bg-glass': { bg: 'glass' }, 'bg-glass-clear': { bg: 'glass-clear' }, 'bg-none': { bg: 'none' },
  'text-left': { textAlign: 'left' }, 'text-center': { textAlign: 'center' }, 'text-right': { textAlign: 'right' },
  'font-medium': { fontWeight: 500 }, 'font-semibold': { fontWeight: 600 }, 'font-bold': { fontWeight: 700 },
  'overflow-hidden': { overflow: 'hidden' }, 'overflow-scroll': { overflow: 'scroll' }, 'overflow-visible': { overflow: 'visible' },
  'shadow-sm': { shadow: 'sm' }, 'shadow-md': { shadow: 'md' }, 'shadow-lg': { shadow: 'lg' },
  'w-full': { width: '100%' }, 'w-auto': { width: 'auto' }, 'h-full': { height: '100%' }, 'h-auto': { height: 'auto' },
}
const SPACING: Record<string, keyof Base> = {
  p: 'padding', px: 'paddingX', py: 'paddingY', pt: 'paddingTop', pr: 'paddingRight', pb: 'paddingBottom', pl: 'paddingLeft',
  m: 'margin', mx: 'marginX', my: 'marginY', mt: 'marginTop', mr: 'marginRight', mb: 'marginBottom', ml: 'marginLeft',
  gap: 'gap', 'gap-x': 'columnGap', 'gap-y': 'rowGap', inset: 'inset', top: 'top', right: 'right', bottom: 'bottom', left: 'left',
}
const LENGTH: Record<string, keyof Base> = { w: 'width', h: 'height', 'min-w': 'minWidth', 'max-w': 'maxWidth', 'min-h': 'minHeight', 'max-h': 'maxHeight' }

function known(theme: Theme): string[] {
  return [...Object.keys(ENUMS), ...Object.keys(SPACING).map(k => `${k}-N`), ...Object.keys(LENGTH).map(k => `${k}-N`), 'text-{size|color}', 'bg-{token}', 'font-{weight}', 'opacity-N', ...Object.keys(theme.fontSize).map(k => `text-${k}`)]
}

function parseValue(raw: string, theme: Theme, scope: string): number | `${number}%` {
  const arb = /^\[(.+)\]$/.exec(raw)
  if (arb) {
    const v = arb[1]!
    if (/^-?\d+(\.\d+)?%$/.test(v)) return v as `${number}%`
    if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
    throw new GlassUIError(scope, `非法任意值 "${raw}"（允许 [42] 或 [50%]）`)
  }
  if (!/^\d+$/.test(raw)) throw new GlassUIError(scope, `非法间距 "${raw}"`)
  const idx = Number(raw)
  const pt = theme.spacing[idx]
  if (pt === undefined) throw new GlassUIError(scope, `spacing 索引 ${idx} 超出范围（0–${theme.spacing.length - 1}）`)
  return pt
}

function one(cls: string, theme: Theme, scope: string): Partial<Base> {
  const e = ENUMS[cls]; if (e) return e
  const m = /^([a-z]+(?:-[xy])?)-(\[.+\]|\d+)$/.exec(cls)
  if (m) {
    const [, key, raw] = m as unknown as [string, string, string]
    if (key in SPACING) return { [SPACING[key]!]: parseValue(raw, theme, scope) }
    if (key in LENGTH) return { [LENGTH[key]!]: parseValue(raw, theme, scope) }
    if (key === 'opacity') { const n = Number(raw); if (n < 0 || n > 100 || raw.startsWith('[')) throw new GlassUIError(scope, `opacity 取值 0–100，得到 "${raw}"`); return { opacity: n / 100 } }
    if (key === 'font') { const n = Number(raw); if (n % 100 || n < 100 || n > 900) throw new GlassUIError(scope, `font 字重 100–900，得到 "${raw}"`); return { fontWeight: n } }
  }
  const t = /^text-(.+)$/.exec(cls)
  if (t) { const v = t[1]!; if (v in theme.fontSize) return { fontSize: v }; return { color: v.startsWith('[') ? v.slice(1, -1) : v } }
  const b = /^bg-(.+)$/.exec(cls)
  if (b) { const v = b[1]!; return { bg: v.startsWith('[') ? v.slice(1, -1) : v } }
  throw new GlassUIError(scope, `未知 class "${cls}"`, { allowed: known(theme), got: cls })
}

export function parseTw(tw: string, theme: Theme, scope = 'tw'): Style {
  const out: Style = {}
  for (const token of tw.trim().split(/\s+/).filter(Boolean)) {
    const parts = token.split(':')
    if (parts.length > 2) throw new GlassUIError(scope, `不支持的前缀 "${parts.slice(0, -1).join(':')}"（只允许一个：hover/focus/active/disabled）`)
    const cls = parts[parts.length - 1]!
    const style = one(cls, theme, scope)
    if (parts.length === 2) {
      const branch = PREFIX[parts[0]!]
      if (!branch) throw new GlassUIError(scope, `不支持的前缀 "${parts[0]}"`, { allowed: Object.keys(PREFIX), got: parts[0]! })
      out[branch] = { ...(out[branch] ?? {}), ...style }
    } else Object.assign(out, style)
  }
  return out
}
```

- [ ] **Step 4: Run to verify it passes** — 6 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/style/tw.ts packages/core/test/tw.test.ts
git commit -m "feat(core): tw utility-string parser with state prefixes and strict errors"
```

---

### Task 7: Layout engine interface and Yoga adapter

**Files:**
- Create: `packages/core/src/layout/engine.ts`, `packages/core/src/layout/yoga.ts`
- Test: `packages/core/test/layout-yoga.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type MeasureFn = (node: Node, maxWidth: number | undefined) => { width: number; height: number }
  export interface LayoutEngine {
    compute(root: Node, width: number, height: number, measure?: MeasureFn): void  // writes node.layout (relative to parent), clears dirty.layout
    dispose(root: Node): void
  }
  export async function createYogaLayout(): Promise<LayoutEngine>
  ```
  Absolute rects are derived later by `absoluteRect()` (Task 8).

- [ ] **Step 1: Write the failing test**

`packages/core/test/layout-yoga.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { Node } from '../src/node'
import { createYogaLayout, type LayoutEngine } from '../src/layout/yoga'

let engine: LayoutEngine
beforeAll(async () => { engine = await createYogaLayout() })

function box(style: Parameters<Node['setStyle']>[0], id?: string) { const n = new Node('box', id); n.setStyle(style); return n }

describe('YogaLayout', () => {
  it('lays out a padded row with gap', () => {
    const root = box({ flexDirection: 'row', padding: 10, gap: 5, width: 200, height: 100 }, 'root')
    const a = box({ width: 50, height: '100%' }, 'a'), b = box({ flexGrow: 1 }, 'b')
    root.appendChild(a); root.appendChild(b)
    engine.compute(root, 200, 100)
    expect(a.layout).toEqual({ x: 10, y: 10, width: 50, height: 80 })
    expect(b.layout).toEqual({ x: 65, y: 10, width: 125, height: 80 })
    expect(root.dirty.layout).toBe(false)
  })
  it('positions absolute children with inset and respects display none', () => {
    const root = box({ width: 100, height: 100 }, 'root')
    const abs = box({ position: 'absolute', right: 0, bottom: 0, width: 20, height: 20 }, 'abs')
    const gone = box({ display: 'none', width: 50, height: 50 }, 'gone')
    root.appendChild(gone); root.appendChild(abs)
    engine.compute(root, 100, 100)
    expect(abs.layout).toEqual({ x: 80, y: 80, width: 20, height: 20 })
    expect(gone.layout.width).toBe(0)
  })
  it('measures text nodes through the measure callback', () => {
    const root = box({ flexDirection: 'column', width: 120 }, 'root')
    const t = new Node('text', 't'); t.setProp('value', 'hello world')
    root.appendChild(t)
    engine.compute(root, 120, 500, (node, maxWidth) => ({ width: Math.min(300, maxWidth ?? 300), height: 40 }))
    expect(t.layout).toEqual({ x: 0, y: 0, width: 120, height: 40 })
  })
  it('never yields NaN or negative sizes for degenerate inputs', () => {
    const root = box({ width: 0, height: 0, padding: 30 }, 'root')
    const c = box({ width: 10, height: 10 }, 'c')
    root.appendChild(c)
    engine.compute(root, 0, 0)
    for (const n of [root, c]) for (const v of Object.values(n.layout)) { expect(Number.isFinite(v)).toBe(true) }
    expect(root.layout.width).toBeGreaterThanOrEqual(0)
  })
  it('re-layout after a style change moves siblings', () => {
    const root = box({ flexDirection: 'row', width: 100, height: 10 }, 'root')
    const a = box({ width: 10, height: 10 }, 'a'), b = box({ width: 10, height: 10 }, 'b')
    root.appendChild(a); root.appendChild(b)
    engine.compute(root, 100, 10)
    a.setStyle({ width: 30 })
    engine.compute(root, 100, 10)
    expect(b.layout.x).toBe(30)
    engine.dispose(root)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL (module not found).

- [ ] **Step 3: Implement**

`packages/core/src/layout/engine.ts`:
```ts
import type { Node } from '../node'
export type MeasureFn = (node: Node, maxWidth: number | undefined) => { width: number; height: number }
export interface LayoutEngine {
  compute(root: Node, width: number, height: number, measure?: MeasureFn): void
  dispose(root: Node): void
}
```

`packages/core/src/layout/yoga.ts`:
```ts
import { loadYoga } from 'yoga-layout/load'
import { Align, Direction, Display, Edge, FlexDirection, Gutter, Justify, MeasureMode, Overflow, PositionType, Wrap } from 'yoga-layout'
import type { Node as YNode, Yoga } from 'yoga-layout'
import type { Node } from '../node'
import type { Style, Length } from '../style/schema'
import type { LayoutEngine, MeasureFn } from './engine'
export type { LayoutEngine, MeasureFn } from './engine'

const FLEX_DIR = { row: FlexDirection.Row, column: FlexDirection.Column, 'row-reverse': FlexDirection.RowReverse, 'column-reverse': FlexDirection.ColumnReverse } as const
const JUSTIFY = { 'flex-start': Justify.FlexStart, center: Justify.Center, 'flex-end': Justify.FlexEnd, 'space-between': Justify.SpaceBetween, 'space-around': Justify.SpaceAround, 'space-evenly': Justify.SpaceEvenly } as const
const ALIGN = { auto: Align.Auto, 'flex-start': Align.FlexStart, center: Align.Center, 'flex-end': Align.FlexEnd, stretch: Align.Stretch, baseline: Align.Baseline } as const

class YogaLayout implements LayoutEngine {
  private map = new WeakMap<Node, YNode>()
  constructor(private yoga: Yoga) {}

  private ynode(n: Node): YNode {
    let y = this.map.get(n)
    if (!y) { y = this.yoga.Node.create(); this.map.set(n, y) }
    return y
  }

  private setLen(y: YNode, which: 'Width' | 'Height' | 'MinWidth' | 'MaxWidth' | 'MinHeight' | 'MaxHeight' | 'FlexBasis', v: Length | undefined) {
    if (v === undefined) return
    const fn = y as unknown as Record<string, (v: number | string) => void>
    if (v === 'auto') { if (which === 'Width' || which === 'Height' || which === 'FlexBasis') fn[`set${which}Auto`]!(0 as unknown as number) }
    else if (typeof v === 'string') fn[`set${which}Percent`]!(parseFloat(v))
    else fn[`set${which}`]!(v)
  }

  private setEdge(y: YNode, kind: 'Padding' | 'Margin', s: Style) {
    const fn = y as unknown as Record<string, (e: Edge, v: number) => void>
    const set = fn[`set${kind}`]!
    const p = kind === 'Padding' ? 'padding' : 'margin'
    const g = (k: string) => (s as Record<string, number | undefined>)[k]
    if (g(p) !== undefined) set.call(y, Edge.All, g(p)!)
    if (g(`${p}X`) !== undefined) set.call(y, Edge.Horizontal, g(`${p}X`)!)
    if (g(`${p}Y`) !== undefined) set.call(y, Edge.Vertical, g(`${p}Y`)!)
    for (const [suffix, edge] of [['Top', Edge.Top], ['Right', Edge.Right], ['Bottom', Edge.Bottom], ['Left', Edge.Left]] as const)
      if (g(`${p}${suffix}`) !== undefined) set.call(y, edge, g(`${p}${suffix}`)!)
  }

  private setPos(y: YNode, s: Style) {
    const edges: [Length | undefined, Edge][] = [[s.inset, Edge.All], [s.top, Edge.Top], [s.right, Edge.Right], [s.bottom, Edge.Bottom], [s.left, Edge.Left]]
    for (const [v, e] of edges) {
      if (v === undefined || v === 'auto') continue
      if (typeof v === 'string') y.setPositionPercent(e, parseFloat(v)); else y.setPosition(e, v)
    }
  }

  private sync(n: Node, measure: MeasureFn | undefined): YNode {
    const y = this.ynode(n)
    const s = n.style
    y.setDisplay(s.display === 'none' ? Display.None : Display.Flex)
    y.setPositionType(s.position === 'absolute' ? PositionType.Absolute : PositionType.Relative)
    y.setFlexDirection(FLEX_DIR[s.flexDirection ?? 'column'])
    y.setJustifyContent(JUSTIFY[s.justifyContent ?? 'flex-start'])
    y.setAlignItems(ALIGN[s.alignItems ?? 'stretch'])
    y.setAlignSelf(ALIGN[s.alignSelf ?? 'auto'])
    y.setFlexWrap(s.flexWrap === 'wrap' ? Wrap.Wrap : Wrap.NoWrap)
    y.setOverflow(s.overflow === 'hidden' ? Overflow.Hidden : s.overflow === 'scroll' ? Overflow.Scroll : Overflow.Visible)
    if (s.flex !== undefined) y.setFlex(s.flex)
    y.setFlexGrow(s.flexGrow ?? 0); y.setFlexShrink(s.flexShrink ?? 1)
    this.setLen(y, 'FlexBasis', s.flexBasis)
    this.setLen(y, 'Width', s.width); this.setLen(y, 'Height', s.height)
    this.setLen(y, 'MinWidth', s.minWidth); this.setLen(y, 'MaxWidth', s.maxWidth)
    this.setLen(y, 'MinHeight', s.minHeight); this.setLen(y, 'MaxHeight', s.maxHeight)
    if (s.aspectRatio !== undefined) y.setAspectRatio(s.aspectRatio)
    this.setEdge(y, 'Padding', s); this.setEdge(y, 'Margin', s); this.setPos(y, s)
    if (s.gap !== undefined) y.setGap(Gutter.All, s.gap)
    if (s.rowGap !== undefined) y.setGap(Gutter.Row, s.rowGap)
    if (s.columnGap !== undefined) y.setGap(Gutter.Column, s.columnGap)

    if (n.type === 'text' && measure) {
      y.setMeasureFunc((w, wMode) => {
        const maxW = wMode === MeasureMode.Undefined ? undefined : w
        const m = measure(n, maxW)
        return { width: maxW !== undefined && wMode === MeasureMode.Exactly ? maxW : Math.min(m.width, maxW ?? m.width), height: m.height }
      })
      if (n.dirty.text) y.markDirty()
    } else y.unsetMeasureFunc()

    // children: rebuild when the tree changed
    if (n.dirty.tree) {
      while (y.getChildCount() > 0) y.removeChild(y.getChild(0))
      n.children.forEach((c, i) => y.insertChild(this.sync(c, measure), i))
    } else n.children.forEach(c => this.sync(c, measure))
    return y
  }

  compute(root: Node, width: number, height: number, measure?: MeasureFn): void {
    const y = this.sync(root, measure)
    y.calculateLayout(width, height, Direction.LTR)
    root.walk(n => {
      const yn = this.map.get(n)!
      const f = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0)
      n.layout = { x: Number.isFinite(yn.getComputedLeft()) ? yn.getComputedLeft() : 0, y: Number.isFinite(yn.getComputedTop()) ? yn.getComputedTop() : 0, width: f(yn.getComputedWidth()), height: f(yn.getComputedHeight()) }
      n.dirty.layout = false; n.dirty.tree = false; n.dirty.text = false
    })
  }

  dispose(root: Node): void {
    root.walk(n => { const y = this.map.get(n); if (y) { y.free(); this.map.delete(n) } })
  }
}

export async function createYogaLayout(): Promise<LayoutEngine> {
  return new YogaLayout(await loadYoga())
}
```

Implementer notes: yoga-layout 3.2 exports enums from the package root and `loadYoga` from `yoga-layout/load`; `setWidthAuto()` takes no argument (the cast above is only to satisfy the generic dispatcher — call it with no args if TypeScript complains). `getComputedLeft/Top` are relative to the parent, which is what `node.layout` stores. Display-none nodes get 0×0 from Yoga.

- [ ] **Step 4: Run to verify it passes** — 5 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/layout packages/core/test/layout-yoga.test.ts
git commit -m "feat(core): LayoutEngine interface and yoga-layout adapter with text measurement"
```

---

### Task 8: Hit testing and event dispatch

**Files:**
- Create: `packages/core/src/events/hit.ts`, `packages/core/src/events/dispatch.ts`
- Test: `packages/core/test/events.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // hit.ts
  export function absoluteRect(node: Node): Rect                         // sums layout x/y up to the Surface root (scroll offsets of 'scroll' ancestors subtracted: node.props.scrollX/scrollY)
  export function hitTest(root: Node, x: number, y: number): Node | null  // topmost (last sibling first), honours display none, pointerEvents none, overflow hidden/scroll clipping, rounded corners via resolveRadius(theme=default)
  // dispatch.ts
  export type UIEventType = 'pointerdown' | 'pointerup' | 'pointermove' | 'pointerenter' | 'pointerleave' | 'pointercancel' | 'click' | 'wheel' | 'keydown' | 'keyup' | 'focus' | 'blur' | 'press' | 'change'
  export interface UIEvent { type: UIEventType; target: Node; currentTarget: Node; x: number; y: number; localX: number; localY: number; pointerType: 'mouse' | 'touch' | 'pen' | 'xr'; key?: string; deltaX?: number; deltaY?: number; stopPropagation(): void; propagationStopped: boolean }
  export type Listener = (e: UIEvent) => void
  export class EventDispatcher { on(node: Node, type: UIEventType, fn: Listener): () => void; dispatch(target: Node, type: UIEventType, init?: Partial<UIEvent>): UIEvent }
  export class PointerTracker { constructor(root: Node, d: EventDispatcher); move(x, y, pointerType?): void; down(x, y, pointerType?): void; up(x, y, pointerType?): void; cancel(): void; readonly hovered: Node | null; readonly pressed: Node | null }
  ```
  `PointerTracker` sets `node.state.hover/pressed`, emits enter/leave on hover change, and emits `click` on up when the up target equals the down target.

- [ ] **Step 1: Write the failing test**

`packages/core/test/events.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { Node } from '../src/node'
import { createYogaLayout, type LayoutEngine } from '../src/layout/yoga'
import { absoluteRect, hitTest } from '../src/events/hit'
import { EventDispatcher, PointerTracker } from '../src/events/dispatch'

let engine: LayoutEngine
beforeAll(async () => { engine = await createYogaLayout() })
const box = (style: Parameters<Node['setStyle']>[0], id?: string) => { const n = new Node('box', id); n.setStyle(style); return n }

function scene() {
  const root = box({ width: 200, height: 200 }, 'root')
  const panel = box({ position: 'absolute', left: 50, top: 50, width: 100, height: 100, overflow: 'hidden' }, 'panel')
  const btn = box({ position: 'absolute', left: 10, top: 10, width: 80, height: 40, radius: 'capsule' }, 'btn')
  const over = box({ position: 'absolute', left: 90, top: 90, width: 40, height: 40 }, 'overflowing')
  const ghost = box({ position: 'absolute', left: 0, top: 0, width: 200, height: 200, pointerEvents: 'none' }, 'ghost')
  const hidden = box({ position: 'absolute', left: 0, top: 0, width: 200, height: 200, display: 'none' }, 'hidden')
  root.appendChild(panel); panel.appendChild(btn); panel.appendChild(over); root.appendChild(ghost); root.appendChild(hidden)
  engine.compute(root, 200, 200)
  return { root, panel, btn, over, ghost, hidden }
}

describe('hitTest', () => {
  it('computes absolute rects and hits the topmost visible node', () => {
    const s = scene()
    expect(absoluteRect(s.btn)).toEqual({ x: 60, y: 60, width: 80, height: 40 })
    expect(hitTest(s.root, 100, 80)?.id).toBe('btn')
    expect(hitTest(s.root, 55, 55)?.id).toBe('panel')
    expect(hitTest(s.root, 10, 10)?.id).toBe('root')
  })
  it('ignores pointerEvents none, display none, and clipped overflow', () => {
    const s = scene()
    expect(hitTest(s.root, 100, 80)?.id).not.toBe('ghost')
    expect(hitTest(s.root, 155, 155)?.id).toBe('root')      // 'overflowing' is clipped by panel
    expect(hitTest(s.root, 145, 145)?.id).toBe('overflowing')
  })
  it('respects capsule corners', () => {
    const s = scene()
    expect(hitTest(s.root, 61, 61)?.id).toBe('panel')   // outside the rounded corner of btn
    expect(hitTest(s.root, 100, 61)?.id).toBe('btn')
  })
})

describe('EventDispatcher + PointerTracker', () => {
  it('bubbles with stopPropagation and tracks hover/press/click', () => {
    const s = scene()
    const d = new EventDispatcher()
    const log: string[] = []
    d.on(s.root, 'click', e => log.push(`root:${e.target.id}`))
    d.on(s.btn, 'click', e => { log.push('btn'); e.stopPropagation() })
    d.on(s.btn, 'pointerenter', () => log.push('enter'))
    d.on(s.btn, 'pointerleave', () => log.push('leave'))
    const p = new PointerTracker(s.root, d)
    p.move(100, 80); expect(s.btn.state.hover).toBe(true)
    p.down(100, 80); expect(s.btn.state.pressed).toBe(true)
    p.up(100, 80);   expect(s.btn.state.pressed).toBe(false)
    p.move(10, 10);  expect(s.btn.state.hover).toBe(false)
    expect(log).toEqual(['enter', 'btn', 'leave'])
    p.down(55, 55); p.up(55, 55)
    expect(log.at(-1)).toBe('root:panel')
  })
  it('does not click when up happens on a different node', () => {
    const s = scene(); const d = new EventDispatcher(); let clicks = 0
    d.on(s.root, 'click', () => clicks++)
    const p = new PointerTracker(s.root, d)
    p.down(100, 80); p.up(10, 10)
    expect(clicks).toBe(0)
    expect(s.btn.state.pressed).toBe(false)
  })
  it('gives local coordinates relative to the current target', () => {
    const s = scene(); const d = new EventDispatcher(); let local: [number, number] | null = null
    d.on(s.btn, 'pointerdown', e => { local = [e.localX, e.localY] })
    new PointerTracker(s.root, d).down(70, 70)
    expect(local).toEqual([10, 10])
  })
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL (modules not found).

- [ ] **Step 3: Implement**

`packages/core/src/events/hit.ts`:
```ts
import type { Node, Rect } from '../node'
import { defaultTheme, resolveRadius } from '../style/theme'

export function absoluteRect(node: Node): Rect {
  let x = node.layout.x, y = node.layout.y
  for (let p = node.parent; p; p = p.parent) {
    x += p.layout.x; y += p.layout.y
    if (p.type === 'scroll') { x -= Number(p.props.scrollX ?? 0); y -= Number(p.props.scrollY ?? 0) }
  }
  return { x, y, width: node.layout.width, height: node.layout.height }
}

function insideRounded(r: Rect, radius: number, x: number, y: number): boolean {
  if (x < r.x || y < r.y || x > r.x + r.width || y > r.y + r.height) return false
  if (radius <= 0) return true
  const cx = Math.max(r.x + radius, Math.min(x, r.x + r.width - radius))
  const cy = Math.max(r.y + radius, Math.min(y, r.y + r.height - radius))
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius
}

function clips(n: Node): boolean { return n.style.overflow === 'hidden' || n.style.overflow === 'scroll' || n.type === 'scroll' }

/** Topmost node under (x, y) in Surface coordinates, or null. */
export function hitTest(root: Node, x: number, y: number): Node | null {
  const visit = (n: Node): Node | null => {
    if (n.style.display === 'none') return null
    const r = absoluteRect(n)
    const radius = resolveRadius(n.style.radius, defaultTheme, r.width, r.height)
    const inside = insideRounded(r, radius, x, y)
    if (clips(n) && !inside) return null
    for (let i = n.children.length - 1; i >= 0; i--) {
      const hit = visit(n.children[i]!)
      if (hit) return hit
    }
    return inside && n.style.pointerEvents !== 'none' ? n : null
  }
  return visit(root)
}
```

`packages/core/src/events/dispatch.ts`:
```ts
import type { Node } from '../node'
import { absoluteRect, hitTest } from './hit'

export type UIEventType = 'pointerdown' | 'pointerup' | 'pointermove' | 'pointerenter' | 'pointerleave' | 'pointercancel' | 'click' | 'wheel' | 'keydown' | 'keyup' | 'focus' | 'blur' | 'press' | 'change'
export type PointerType = 'mouse' | 'touch' | 'pen' | 'xr'
export interface UIEvent {
  type: UIEventType; target: Node; currentTarget: Node
  x: number; y: number; localX: number; localY: number; pointerType: PointerType
  key?: string; deltaX?: number; deltaY?: number
  propagationStopped: boolean; stopPropagation(): void
}
export type Listener = (e: UIEvent) => void

export class EventDispatcher {
  private listeners = new WeakMap<Node, Map<UIEventType, Set<Listener>>>()

  on(node: Node, type: UIEventType, fn: Listener): () => void {
    let byType = this.listeners.get(node)
    if (!byType) { byType = new Map(); this.listeners.set(node, byType) }
    let set = byType.get(type)
    if (!set) { set = new Set(); byType.set(type, set) }
    set.add(fn)
    return () => set!.delete(fn)
  }

  dispatch(target: Node, type: UIEventType, init: Partial<UIEvent> = {}): UIEvent {
    const e: UIEvent = {
      type, target, currentTarget: target, x: init.x ?? 0, y: init.y ?? 0, localX: 0, localY: 0,
      pointerType: init.pointerType ?? 'mouse', key: init.key, deltaX: init.deltaX, deltaY: init.deltaY,
      propagationStopped: false, stopPropagation() { this.propagationStopped = true },
    }
    for (let n: Node | null = target; n && !e.propagationStopped; n = n.parent) {
      e.currentTarget = n
      const r = absoluteRect(n); e.localX = e.x - r.x; e.localY = e.y - r.y
      const fns = this.listeners.get(n)?.get(type)
      if (fns) for (const fn of [...fns]) { fn(e); if (e.propagationStopped) break }
    }
    return e
  }
}

export class PointerTracker {
  hovered: Node | null = null
  pressed: Node | null = null
  constructor(private root: Node, private d: EventDispatcher) {}

  move(x: number, y: number, pointerType: PointerType = 'mouse'): void {
    const hit = hitTest(this.root, x, y)
    if (hit !== this.hovered) {
      if (this.hovered) { this.hovered.state.hover = false; this.d.dispatch(this.hovered, 'pointerleave', { x, y, pointerType }) }
      this.hovered = hit
      if (hit) { hit.state.hover = true; this.d.dispatch(hit, 'pointerenter', { x, y, pointerType }) }
    }
    if (hit) this.d.dispatch(hit, 'pointermove', { x, y, pointerType })
  }

  down(x: number, y: number, pointerType: PointerType = 'mouse'): void {
    this.move(x, y, pointerType)
    const hit = hitTest(this.root, x, y)
    this.pressed = hit
    if (hit) { hit.state.pressed = true; this.d.dispatch(hit, 'pointerdown', { x, y, pointerType }) }
  }

  up(x: number, y: number, pointerType: PointerType = 'mouse'): void {
    const hit = hitTest(this.root, x, y)
    const was = this.pressed
    this.pressed = null
    if (was) was.state.pressed = false
    if (hit) this.d.dispatch(hit, 'pointerup', { x, y, pointerType })
    if (was && hit === was) this.d.dispatch(was, 'click', { x, y, pointerType })
  }

  cancel(): void {
    if (this.pressed) { this.pressed.state.pressed = false; this.d.dispatch(this.pressed, 'pointercancel'); this.pressed = null }
  }
}
```

- [ ] **Step 4: Run to verify it passes** — 6 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/events packages/core/test/events.test.ts
git commit -m "feat(core): rounded/clipped hit testing, bubbling dispatcher, pointer tracker"
```

---

### Task 9: Focus manager and keyboard routing

**Files:**
- Create: `packages/core/src/focus.ts`
- Test: `packages/core/test/focus.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class FocusManager {
    constructor(root: Node, d: EventDispatcher)
    readonly current: Node | null
    focusables(): Node[]            // nodes with props.tabIndex >= 0, not disabled, display != none; stable sort by tabIndex then tree order
    focus(node: Node | null): void  // emits blur on old, focus on new; sets state.focused
    next(): Node | null; prev(): Node | null
    key(key: string, down = true): void   // 'Tab' / 'Shift+Tab' traverse; others dispatch keydown/keyup to current (or root)
    reconcile(): void               // call after tree changes: if current is detached, blur it and set current = null
  }
  ```

- [ ] **Step 1: Write the failing test**

`packages/core/test/focus.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { Node } from '../src/node'
import { EventDispatcher } from '../src/events/dispatch'
import { FocusManager } from '../src/focus'

function tree() {
  const root = new Node('box', 'root'), d = new EventDispatcher()
  const a = new Node('box', 'a'), b = new Node('box', 'b'), c = new Node('box', 'c'), dis = new Node('box', 'dis')
  a.setProp('tabIndex', 0); b.setProp('tabIndex', 2); c.setProp('tabIndex', 1); dis.setProp('tabIndex', 0); dis.state.disabled = true
  root.appendChild(a); root.appendChild(b); root.appendChild(c); root.appendChild(dis)
  return { root, d, a, b, c, dis, fm: new FocusManager(root, d) }
}

describe('FocusManager', () => {
  it('orders focusables by tabIndex then tree order, skipping disabled', () => {
    const t = tree()
    expect(t.fm.focusables().map(n => n.id)).toEqual(['a', 'c', 'b'])
  })
  it('moves focus with Tab and Shift+Tab, wrapping, and emits focus/blur', () => {
    const t = tree(); const log: string[] = []
    for (const n of [t.a, t.b, t.c]) { t.d.on(n, 'focus', () => log.push(`focus:${n.id}`)); t.d.on(n, 'blur', () => log.push(`blur:${n.id}`)) }
    t.fm.key('Tab'); t.fm.key('Tab'); t.fm.key('Tab'); t.fm.key('Tab')
    expect(t.fm.current?.id).toBe('a')
    t.fm.key('Shift+Tab')
    expect(t.fm.current?.id).toBe('b')
    expect(log.slice(0, 4)).toEqual(['focus:a', 'blur:a', 'focus:c', 'blur:c'])
    expect(t.a.state.focused).toBe(false); expect(t.b.state.focused).toBe(true)
  })
  it('routes other keys to the focused node', () => {
    const t = tree(); let got = ''
    t.d.on(t.a, 'keydown', e => { got = e.key ?? '' })
    t.fm.focus(t.a); t.fm.key('Enter')
    expect(got).toBe('Enter')
  })
  it('drops focus without throwing when the focused node is removed', () => {
    const t = tree(); let blurred = false
    t.d.on(t.a, 'blur', () => { blurred = true })
    t.fm.focus(t.a); t.a.remove(); t.fm.reconcile()
    expect(t.fm.current).toBeNull(); expect(blurred).toBe(true)
    expect(() => t.fm.key('Tab')).not.toThrow()
  })
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**

`packages/core/src/focus.ts`:
```ts
import type { Node } from './node'
import type { EventDispatcher } from './events/dispatch'

export class FocusManager {
  current: Node | null = null
  constructor(private root: Node, private d: EventDispatcher) {}

  focusables(): Node[] {
    const out: { n: Node; tab: number; order: number }[] = []
    let order = 0
    this.root.walk(n => {
      const tab = Number(n.props.tabIndex)
      if (Number.isFinite(tab) && tab >= 0 && !n.state.disabled && n.style.display !== 'none') out.push({ n, tab, order })
      order++
    })
    return out.sort((a, b) => a.tab - b.tab || a.order - b.order).map(o => o.n)
  }

  focus(node: Node | null): void {
    if (node === this.current) return
    const old = this.current
    this.current = node
    if (old) { old.state.focused = false; this.d.dispatch(old, 'blur') }
    if (node) { node.state.focused = true; this.d.dispatch(node, 'focus') }
  }

  private step(dir: 1 | -1): Node | null {
    const list = this.focusables()
    if (!list.length) { this.focus(null); return null }
    const i = this.current ? list.indexOf(this.current) : -1
    const next = list[(i + dir + list.length) % list.length]!
    this.focus(next)
    return next
  }
  next(): Node | null { return this.step(1) }
  prev(): Node | null { return this.step(-1) }

  key(key: string, down = true): void {
    if (down && key === 'Tab') { this.next(); return }
    if (down && key === 'Shift+Tab') { this.prev(); return }
    this.d.dispatch(this.current ?? this.root, down ? 'keydown' : 'keyup', { key })
  }

  reconcile(): void {
    if (this.current && this.current.root !== this.root) this.focus(null)
  }
}
```

- [ ] **Step 4: Run to verify it passes** — 4 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/focus.ts packages/core/test/focus.test.ts
git commit -m "feat(core): focus manager with tab order, keyboard routing and detachment reconcile"
```

---

### Task 10: Spring animation

**Files:**
- Create: `packages/core/src/animation/spring.ts`
- Test: `packages/core/test/spring.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SpringConfig { stiffness: number; damping: number; mass?: number }
  export function springFromResponse(response: number, dampingFraction: number, mass = 1): SpringConfig   // Apple-style: stiffness = m·(2π/response)², damping = 2·ζ·√(k·m)
  export class Spring {
    constructor(value: number, cfg: SpringConfig)
    value: number; velocity: number; target: number
    set(target: number): void
    jump(value: number): void          // snap, zero velocity
    step(dt: number): number           // semi-implicit Euler with sub-steps of ≤ 1/240 s; returns value
    readonly done: boolean             // |value - target| < 1e-3 and |velocity| < 1e-3
  }
  export function resolveSpring(t: Style['transition'][string], theme: Theme): SpringConfig | { duration: number; easing: string }
  ```

- [ ] **Step 1: Write the failing test**

`packages/core/test/spring.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { Spring, springFromResponse, resolveSpring } from '../src/animation/spring'
import { defaultTheme } from '../src/style/theme'

function run(s: Spring, seconds: number, dt = 1 / 60) { const out: number[] = []; for (let t = 0; t < seconds; t += dt) out.push(s.step(dt)); return out }

describe('Spring', () => {
  it('converges to the target and reports done', () => {
    const s = new Spring(0, defaultTheme.springs.smooth); s.set(1)
    run(s, 2)
    expect(s.value).toBeCloseTo(1, 3); expect(s.done).toBe(true)
  })
  it('critically damped spring never overshoots', () => {
    const s = new Spring(0, springFromResponse(0.3, 1)); s.set(1)
    expect(Math.max(...run(s, 1))).toBeLessThanOrEqual(1 + 1e-6)
  })
  it('bouncy preset overshoots at least once', () => {
    const s = new Spring(0, defaultTheme.springs.bouncy); s.set(1)
    expect(Math.max(...run(s, 1))).toBeGreaterThan(1.02)
  })
  it('is stable with a large dt (sub-stepping)', () => {
    const s = new Spring(0, { stiffness: 2000, damping: 10 }); s.set(1)
    for (let i = 0; i < 20; i++) s.step(0.1)
    expect(Number.isFinite(s.value)).toBe(true); expect(Math.abs(s.value)).toBeLessThan(3)
  })
  it('jump snaps without velocity', () => {
    const s = new Spring(0, defaultTheme.springs.snappy); s.set(5); s.step(0.016); s.jump(5)
    expect(s.value).toBe(5); expect(s.velocity).toBe(0); expect(s.done).toBe(true)
  })
  it('resolves theme presets, response form and duration form', () => {
    expect(resolveSpring('snappy', defaultTheme)).toEqual(defaultTheme.springs.snappy)
    expect(resolveSpring({ response: 0.5, dampingFraction: 0.8 }, defaultTheme)).toMatchObject({ stiffness: expect.any(Number), damping: expect.any(Number) })
    expect(resolveSpring({ duration: 200, easing: 'ease-out' }, defaultTheme)).toEqual({ duration: 200, easing: 'ease-out' })
  })
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**

`packages/core/src/animation/spring.ts`:
```ts
import type { Style } from '../style/schema'
import type { Theme } from '../style/theme'

export interface SpringConfig { stiffness: number; damping: number; mass?: number }

export function springFromResponse(response: number, dampingFraction: number, mass = 1): SpringConfig {
  const omega = (2 * Math.PI) / response
  const stiffness = mass * omega * omega
  return { stiffness, damping: 2 * dampingFraction * Math.sqrt(stiffness * mass), mass }
}

const MAX_STEP = 1 / 240

export class Spring {
  value: number; velocity = 0; target: number
  private k: number; private c: number; private m: number
  constructor(value: number, cfg: SpringConfig) {
    this.value = value; this.target = value
    this.k = cfg.stiffness; this.c = cfg.damping; this.m = cfg.mass ?? 1
  }
  set(target: number): void { this.target = target }
  jump(value: number): void { this.value = value; this.target = value; this.velocity = 0 }
  get done(): boolean { return Math.abs(this.value - this.target) < 1e-3 && Math.abs(this.velocity) < 1e-3 }
  step(dt: number): number {
    let remaining = dt
    while (remaining > 0) {
      const h = Math.min(remaining, MAX_STEP)
      const a = (-this.k * (this.value - this.target) - this.c * this.velocity) / this.m
      this.velocity += a * h
      this.value += this.velocity * h
      remaining -= h
    }
    if (this.done) { this.value = this.target; this.velocity = 0 }
    return this.value
  }
}

type Transition = NonNullable<Style['transition']>[string]
export function resolveSpring(t: Transition, theme: Theme): SpringConfig | { duration: number; easing: string } {
  if (typeof t === 'string') return theme.springs[t]
  if ('duration' in t) return t
  if ('response' in t) return springFromResponse(t.response, t.dampingFraction)
  return t
}
```

- [ ] **Step 4: Run to verify it passes** — 6 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/animation packages/core/test/spring.test.ts
git commit -m "feat(core): sub-stepped spring integrator with Apple response/damping form"
```

---

### Task 11: Scroll physics

**Files:**
- Create: `packages/core/src/scroll.ts`
- Test: `packages/core/test/scroll.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class ScrollPhysics {
    constructor(opts?: { decay?: number /* per-second velocity retention, default 0.002 */; rubber?: number /* 0..1 resistance, default 0.55 */; snapBack?: SpringConfig })
    offset = 0; velocity = 0; min = 0; max = 0
    setBounds(min: number, max: number): void
    beginDrag(): void; drag(delta: number, dt: number): void; endDrag(): void   // drag applies rubber-band outside bounds, tracks velocity
    wheel(delta: number): void          // immediate, clamped to bounds
    step(dt: number): number            // inertia + spring back into bounds; returns offset
    readonly settled: boolean
  }
  ```

- [ ] **Step 1: Write the failing test**

`packages/core/test/scroll.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { ScrollPhysics } from '../src/scroll'

const settle = (s: ScrollPhysics, seconds = 3) => { for (let t = 0; t < seconds; t += 1 / 60) s.step(1 / 60) }

describe('ScrollPhysics', () => {
  it('wheel scrolls and clamps to bounds', () => {
    const s = new ScrollPhysics(); s.setBounds(0, 500)
    s.wheel(120); expect(s.offset).toBe(120)
    s.wheel(1000); expect(s.offset).toBe(500)
    s.wheel(-9999); expect(s.offset).toBe(0)
  })
  it('a flick keeps moving after release and stops within bounds', () => {
    const s = new ScrollPhysics(); s.setBounds(0, 500)
    s.beginDrag(); for (let i = 0; i < 5; i++) s.drag(20, 1 / 60); s.endDrag()
    const atRelease = s.offset
    s.step(1 / 60); expect(s.offset).toBeGreaterThan(atRelease)
    settle(s); expect(s.offset).toBeGreaterThan(100); expect(s.offset).toBeLessThanOrEqual(500); expect(s.settled).toBe(true)
  })
  it('rubber-bands past the edge during drag and springs back after release', () => {
    const s = new ScrollPhysics(); s.setBounds(0, 500)
    s.beginDrag(); s.drag(-100, 1 / 60)
    expect(s.offset).toBeLessThan(0); expect(s.offset).toBeGreaterThan(-100)
    s.endDrag(); settle(s)
    expect(s.offset).toBeCloseTo(0, 2)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**

`packages/core/src/scroll.ts`:
```ts
import { Spring, type SpringConfig } from './animation/spring'

export class ScrollPhysics {
  offset = 0; velocity = 0; min = 0; max = 0
  private dragging = false
  private decay: number; private rubber: number
  private back: Spring | null = null
  private backCfg: SpringConfig
  constructor(opts: { decay?: number; rubber?: number; snapBack?: SpringConfig } = {}) {
    this.decay = opts.decay ?? 0.002; this.rubber = opts.rubber ?? 0.55
    this.backCfg = opts.snapBack ?? { stiffness: 220, damping: 28 }
  }
  setBounds(min: number, max: number): void { this.min = min; this.max = Math.max(min, max) }
  private clamp(v: number) { return Math.min(this.max, Math.max(this.min, v)) }
  private overshoot() { return this.offset < this.min ? this.offset - this.min : this.offset > this.max ? this.offset - this.max : 0 }

  beginDrag(): void { this.dragging = true; this.velocity = 0; this.back = null }
  drag(delta: number, dt: number): void {
    const over = Math.abs(this.overshoot())
    const resistance = over > 0 ? 1 - this.rubber * Math.min(1, over / 300 + 0.4) : 1
    this.offset += delta * resistance
    this.velocity = dt > 0 ? (delta * resistance) / dt : 0
  }
  endDrag(): void { this.dragging = false }
  wheel(delta: number): void { this.offset = this.clamp(this.offset + delta); this.velocity = 0; this.back = null }

  step(dt: number): number {
    if (this.dragging) return this.offset
    const over = this.overshoot()
    if (over !== 0) {
      if (!this.back) { this.back = new Spring(this.offset, this.backCfg); this.back.velocity = this.velocity }
      this.back.set(over < 0 ? this.min : this.max)
      this.offset = this.back.step(dt)
      this.velocity = this.back.velocity
      if (this.back.done) { this.offset = this.clamp(this.offset); this.velocity = 0; this.back = null }
      return this.offset
    }
    this.back = null
    if (Math.abs(this.velocity) < 1) { this.velocity = 0; return this.offset }
    this.velocity *= Math.pow(this.decay, dt)
    this.offset += this.velocity * dt
    if (this.offset < this.min || this.offset > this.max) this.velocity *= 0.5   // hand over to the spring next step
    return this.offset
  }
  get settled(): boolean { return !this.dragging && this.velocity === 0 && this.overshoot() === 0 }
}
```

- [ ] **Step 4: Run to verify it passes** — 3 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/scroll.ts packages/core/test/scroll.test.ts
git commit -m "feat(core): scroll physics with inertia and rubber-band spring back"
```

---

### Task 12: Text types and atlas manager

**Files:**
- Create: `packages/text/src/types.ts`, `packages/text/src/atlas.ts`
- Modify: `packages/text/src/index.ts`
- Test: `packages/text/test/atlas.test.ts`

**Interfaces:**
- Produces (types.ts): `FontSpec`, `TextRun`, `Line`, `GlyphPlacement` (see File Structure), plus
  ```ts
  export interface CanvasLike { width: number; height: number; getContext(type: '2d'): CanvasCtxLike }
  export interface CanvasCtxLike { font: string; textBaseline: string; fillStyle: string; measureText(s: string): { width: number; actualBoundingBoxAscent?: number; actualBoundingBoxDescent?: number }; fillText(s: string, x: number, y: number): void; clearRect(x: number, y: number, w: number, h: number): void; getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray; width: number; height: number } }
  export type CanvasFactory = (width: number, height: number) => CanvasLike
  export interface TextEngine { measure(run: TextRun, c: { maxWidth?: number }): { width: number; height: number; lines: Line[] }; layout(run: TextRun, maxWidth: number | undefined, align: 'left' | 'center' | 'right'): GlyphPlacement[]; caretFromPoint(run: TextRun, maxWidth: number | undefined, x: number, y: number): number; caretRect(run: TextRun, maxWidth: number | undefined, index: number): { x: number; y: number; height: number }; selectionRects(run: TextRun, maxWidth: number | undefined, start: number, end: number): { x: number; y: number; width: number; height: number }[]; atlas: AtlasManager }
  ```
  (atlas.ts):
  ```ts
  export interface AtlasSlot { page: number; x: number; y: number; width: number; height: number }
  export class AtlasManager {
    constructor(opts: { pageSize?: number /* 2048 */; maxPages?: number /* 4 */; createCanvas: CanvasFactory })
    readonly pages: CanvasLike[]
    get(key: string): AtlasSlot | undefined
    allocate(key: string, width: number, height: number, draw: (ctx: CanvasCtxLike, x: number, y: number) => void): AtlasSlot   // shelf packing; evicts least-recently-used page when full; `dirtyPages` records which pages need GPU upload
    readonly dirtyPages: Set<number>; clearDirty(): void
  }
  ```

- [ ] **Step 1: Write the failing test**

`packages/text/test/atlas.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { AtlasManager } from '../src/atlas'
import type { CanvasFactory } from '../src/types'

const factory: CanvasFactory = (w, h) => createCanvas(w, h) as never

describe('AtlasManager', () => {
  it('packs slots on shelves and returns cached slots by key', () => {
    const a = new AtlasManager({ pageSize: 64, createCanvas: factory })
    const s1 = a.allocate('a', 20, 10, () => {})
    const s2 = a.allocate('b', 20, 10, () => {})
    const s3 = a.allocate('c', 30, 12, () => {})   // does not fit on shelf 1 (64 - 40 = 24 < 30) → new shelf
    expect(s1).toMatchObject({ page: 0, x: 0, y: 0 }); expect(s2).toMatchObject({ page: 0, x: 20, y: 0 }); expect(s3).toMatchObject({ page: 0, x: 0, y: 10 })
    expect(a.get('b')).toBe(s2)
    expect(a.dirtyPages.has(0)).toBe(true)
  })
  it('opens new pages and evicts the least recently used one when full', () => {
    const a = new AtlasManager({ pageSize: 32, maxPages: 2, createCanvas: factory })
    a.allocate('p0', 32, 32, () => {})
    a.allocate('p1', 32, 32, () => {})
    a.get('p0')                              // touch page 0 → page 1 is now LRU
    const s = a.allocate('p2', 32, 32, () => {})
    expect(s.page).toBe(1)
    expect(a.get('p1')).toBeUndefined()
    expect(a.get('p0')).toBeDefined()
  })
  it('invokes the draw callback at the slot origin', () => {
    const a = new AtlasManager({ pageSize: 64, createCanvas: factory })
    let at: [number, number] | null = null
    a.allocate('x', 10, 10, (_ctx, x, y) => { at = [x, y] })
    a.allocate('y', 10, 10, (_ctx, x, y) => { at = [x, y] })
    expect(at).toEqual([10, 0])
  })
  it('throws when a glyph is larger than a page', () => {
    const a = new AtlasManager({ pageSize: 16, createCanvas: factory })
    expect(() => a.allocate('big', 20, 5, () => {})).toThrow(/page/)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**

`packages/text/src/types.ts`:
```ts
export interface FontSpec { family: string; size: number; weight: number }
export interface TextRun { text: string; font: FontSpec; letterSpacing?: number; lineHeight?: number }
export interface Line { text: string; start: number; end: number; width: number; y: number }
export interface GlyphPlacement { char: string; x: number; y: number; width: number; height: number; page: number; u0: number; v0: number; u1: number; v1: number }

export interface CanvasCtxLike {
  font: string; textBaseline: string; fillStyle: string
  measureText(s: string): { width: number; actualBoundingBoxAscent?: number; actualBoundingBoxDescent?: number }
  fillText(s: string, x: number, y: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray; width: number; height: number }
}
export interface CanvasLike { width: number; height: number; getContext(type: '2d'): CanvasCtxLike }
export type CanvasFactory = (width: number, height: number) => CanvasLike

import type { AtlasManager } from './atlas'
export interface TextEngine {
  measure(run: TextRun, c: { maxWidth?: number }): { width: number; height: number; lines: Line[] }
  layout(run: TextRun, maxWidth: number | undefined, align: 'left' | 'center' | 'right'): GlyphPlacement[]
  caretFromPoint(run: TextRun, maxWidth: number | undefined, x: number, y: number): number
  caretRect(run: TextRun, maxWidth: number | undefined, index: number): { x: number; y: number; height: number }
  selectionRects(run: TextRun, maxWidth: number | undefined, start: number, end: number): { x: number; y: number; width: number; height: number }[]
  atlas: AtlasManager
}
```

`packages/text/src/atlas.ts`:
```ts
import type { CanvasCtxLike, CanvasFactory, CanvasLike } from './types'

export interface AtlasSlot { page: number; x: number; y: number; width: number; height: number }

interface Shelf { y: number; height: number; x: number }
interface Page { canvas: CanvasLike; ctx: CanvasCtxLike; shelves: Shelf[]; nextY: number; keys: Set<string>; lastUse: number }

export class AtlasManager {
  readonly pages: CanvasLike[] = []
  readonly dirtyPages = new Set<number>()
  private pageData: Page[] = []
  private slots = new Map<string, AtlasSlot>()
  private tick = 0
  private pageSize: number; private maxPages: number; private createCanvas: CanvasFactory

  constructor(opts: { pageSize?: number; maxPages?: number; createCanvas: CanvasFactory }) {
    this.pageSize = opts.pageSize ?? 2048; this.maxPages = opts.maxPages ?? 4; this.createCanvas = opts.createCanvas
  }

  get(key: string): AtlasSlot | undefined {
    const s = this.slots.get(key)
    if (s) this.pageData[s.page]!.lastUse = ++this.tick
    return s
  }

  private newPage(): number {
    const canvas = this.createCanvas(this.pageSize, this.pageSize)
    this.pageData.push({ canvas, ctx: canvas.getContext('2d'), shelves: [], nextY: 0, keys: new Set(), lastUse: ++this.tick })
    this.pages.push(canvas)
    return this.pageData.length - 1
  }

  private evictLRU(): number {
    let idx = 0
    for (let i = 1; i < this.pageData.length; i++) if (this.pageData[i]!.lastUse < this.pageData[idx]!.lastUse) idx = i
    const p = this.pageData[idx]!
    for (const k of p.keys) this.slots.delete(k)
    p.keys.clear(); p.shelves = []; p.nextY = 0; p.lastUse = ++this.tick
    p.ctx.clearRect(0, 0, this.pageSize, this.pageSize)
    return idx
  }

  private tryPlace(pageIdx: number, w: number, h: number): { x: number; y: number } | null {
    const p = this.pageData[pageIdx]!
    for (const s of p.shelves) if (h <= s.height && s.x + w <= this.pageSize) { const at = { x: s.x, y: s.y }; s.x += w; return at }
    if (p.nextY + h <= this.pageSize) { const shelf = { y: p.nextY, height: h, x: w }; p.shelves.push(shelf); p.nextY += h; return { x: 0, y: shelf.y } }
    return null
  }

  allocate(key: string, width: number, height: number, draw: (ctx: CanvasCtxLike, x: number, y: number) => void): AtlasSlot {
    const w = Math.ceil(width), h = Math.ceil(height)
    if (w > this.pageSize || h > this.pageSize) throw new Error(`AtlasManager: glyph ${w}×${h} exceeds page size ${this.pageSize}`)
    const existing = this.get(key); if (existing) return existing
    let pageIdx = -1, at: { x: number; y: number } | null = null
    for (let i = 0; i < this.pageData.length && !at; i++) { at = this.tryPlace(i, w, h); if (at) pageIdx = i }
    if (!at) { pageIdx = this.pageData.length < this.maxPages ? this.newPage() : this.evictLRU(); at = this.tryPlace(pageIdx, w, h)! }
    const slot: AtlasSlot = { page: pageIdx, x: at.x, y: at.y, width: w, height: h }
    const p = this.pageData[pageIdx]!
    draw(p.ctx, at.x, at.y)
    p.keys.add(key); p.lastUse = ++this.tick
    this.slots.set(key, slot); this.dirtyPages.add(pageIdx)
    return slot
  }

  clearDirty(): void { this.dirtyPages.clear() }
}
```

`packages/text/src/index.ts`: `export * from './types'; export * from './atlas'`.

- [ ] **Step 4: Run to verify it passes** — `pnpm vitest run packages/text/test/atlas.test.ts` → 4 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/text/src packages/text/test/atlas.test.ts
git commit -m "feat(text): TextEngine types and shelf-packed glyph atlas with LRU pages"
```

---

### Task 13: `SystemFontEngine` — measurement, wrapping, layout, rasterization

**Files:**
- Create: `packages/text/src/system.ts`
- Modify: `packages/text/src/index.ts`
- Test: `packages/text/test/system.test.ts`

**Interfaces:**
- Produces: `class SystemFontEngine implements TextEngine { constructor(opts: { createCanvas: CanvasFactory; pageSize?: number; maxPages?: number; fallbackFamilies?: string[] /* default ['PingFang SC','Noto Sans SC','system-ui','sans-serif'] */; oversample?: number /* 2 */ }) }`. Measurement caches per `(font, char)` advance widths; wrapping breaks at spaces for Latin and between any two CJK characters (Unicode ranges 2E80–9FFF, AC00–D7AF, F900–FAFF, FF00–FFEF); a single Latin word wider than `maxWidth` is broken by character. Line height defaults to `1.3 × size`. `layout()` rasterizes each distinct `(font, char)` once into the atlas at `size × oversample` px with 2 px padding.

- [ ] **Step 1: Write the failing test**

`packages/text/test/system.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { SystemFontEngine } from '../src/system'

const engine = () => new SystemFontEngine({ createCanvas: (w, h) => createCanvas(w, h) as never, pageSize: 512 })
const font = { family: 'sans-serif', size: 20, weight: 500 }

describe('SystemFontEngine', () => {
  it('measures a single line and uses 1.3× line height', () => {
    const m = engine().measure({ text: 'hello', font }, {})
    expect(m.lines).toHaveLength(1); expect(m.width).toBeGreaterThan(30); expect(m.height).toBe(26)
  })
  it('wraps Latin at spaces and CJK between characters', () => {
    const e = engine()
    const latin = e.measure({ text: 'the quick brown fox jumps', font }, { maxWidth: 120 })
    expect(latin.lines.length).toBeGreaterThan(1)
    for (const l of latin.lines) { expect(l.width).toBeLessThanOrEqual(120 + 0.01); expect(l.text.startsWith(' ')).toBe(false) }
    const cjk = e.measure({ text: '这是一段需要自动换行的中文文本', font }, { maxWidth: 100 })
    expect(cjk.lines.length).toBe(Math.ceil(13 / 5))   // 20px glyphs → 5 per 100px line
  })
  it('mixed CJK + Latin with no spaces breaks between CJK chars and keeps a fitting Latin word whole', () => {
    const lines = engine().measure({ text: '用户名userName必填', font }, { maxWidth: 110 }).lines.map(l => l.text)
    expect(lines.some(l => l.includes('userName'))).toBe(true)
    expect(lines.join('')).toBe('用户名userName必填')
  })
  it('breaks an over-long Latin word by character instead of overflowing', () => {
    const m = engine().measure({ text: 'supercalifragilistic', font }, { maxWidth: 60 })
    for (const l of m.lines) expect(l.width).toBeLessThanOrEqual(60 + 0.01)
  })
  it('lays out glyphs with atlas uvs and rasterizes each glyph once', () => {
    const e = engine()
    const g = e.layout({ text: '你好你', font }, undefined, 'left')
    expect(g).toHaveLength(3)
    expect(g[0]!.u1).toBeGreaterThan(g[0]!.u0)
    expect(g[2]!.u0).toBe(g[0]!.u0)       // same glyph → same atlas slot
    expect(g[1]!.x).toBeGreaterThan(g[0]!.x)
    expect(e.atlas.dirtyPages.size).toBe(1)
    const data = e.atlas.pages[0]!.getContext('2d').getImageData(0, 0, 64, 64).data
    expect(Array.from(data).some(v => v > 0)).toBe(true)   // something was drawn
  })
  it('aligns centre and right', () => {
    const e = engine()
    const left = e.layout({ text: 'ab', font }, 200, 'left'), right = e.layout({ text: 'ab', font }, 200, 'right')
    expect(right[0]!.x).toBeGreaterThan(left[0]!.x)
    expect(right[1]!.x + right[1]!.width).toBeCloseTo(200, 0)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**

`packages/text/src/system.ts`:
```ts
import { AtlasManager } from './atlas'
import type { CanvasCtxLike, CanvasFactory, FontSpec, GlyphPlacement, Line, TextEngine, TextRun } from './types'

const CJK = /[⺀-鿿가-힯豈-﫿＀-￯]/
const PAD = 2

export class SystemFontEngine implements TextEngine {
  readonly atlas: AtlasManager
  private measureCtx: CanvasCtxLike
  private advances = new Map<string, number>()
  private fallback: string[]
  private oversample: number

  constructor(opts: { createCanvas: CanvasFactory; pageSize?: number; maxPages?: number; fallbackFamilies?: string[]; oversample?: number }) {
    this.atlas = new AtlasManager({ pageSize: opts.pageSize ?? 2048, maxPages: opts.maxPages ?? 4, createCanvas: opts.createCanvas })
    this.measureCtx = opts.createCanvas(8, 8).getContext('2d')
    this.fallback = opts.fallbackFamilies ?? ['PingFang SC', 'Noto Sans SC', 'system-ui', 'sans-serif']
    this.oversample = opts.oversample ?? 2
  }

  private css(f: FontSpec, scale = 1): string {
    return `${f.weight} ${f.size * scale}px ${[f.family, ...this.fallback].map(n => (n.includes(' ') ? `"${n}"` : n)).join(', ')}`
  }

  private advance(f: FontSpec, ch: string, letterSpacing = 0): number {
    const key = `${this.css(f)}|${ch}`
    let w = this.advances.get(key)
    if (w === undefined) { this.measureCtx.font = this.css(f); w = this.measureCtx.measureText(ch).width; this.advances.set(key, w) }
    return w + letterSpacing
  }

  private lineHeight(run: TextRun) { return run.lineHeight ?? Math.round(run.font.size * 1.3) }

  /** Greedy wrapping into lines: break opportunities after spaces and on either side of CJK characters. */
  private breakLines(run: TextRun, maxWidth: number | undefined): Line[] {
    const chars = [...run.text]
    const lh = this.lineHeight(run)
    const lines: Line[] = []
    let start = 0, x = 0, lastBreak = -1, lastBreakX = 0
    const push = (end: number, width: number) => { lines.push({ text: chars.slice(start, end).join(''), start, end, width, y: lines.length * lh }) }
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!
      if (ch === '\n') { push(i, x); start = i + 1; x = 0; lastBreak = -1; continue }
      const w = this.advance(run.font, ch, run.letterSpacing)
      const isCjk = CJK.test(ch), prevCjk = i > start && CJK.test(chars[i - 1]!)
      if (maxWidth !== undefined && x + w > maxWidth && i > start) {
        if (isCjk || prevCjk) { push(i, x); start = i; x = 0; lastBreak = -1 }
        else if (lastBreak > start) { push(lastBreak, lastBreakX); start = lastBreak; while (chars[start] === ' ' && start < i) start++; x = 0; for (let k = start; k < i; k++) x += this.advance(run.font, chars[k]!, run.letterSpacing); lastBreak = -1 }
        else { push(i, x); start = i; x = 0; lastBreak = -1 }   // one over-long word: break by character
      }
      x += w
      if (ch === ' ') { lastBreak = i + 1; lastBreakX = x - w }
    }
    push(chars.length, x)
    // trim trailing spaces from widths
    for (const l of lines) { let t = l.text; while (t.endsWith(' ')) { t = t.slice(0, -1); l.width -= this.advance(run.font, ' ', run.letterSpacing) } }
    return lines
  }

  measure(run: TextRun, c: { maxWidth?: number }) {
    const lines = this.breakLines(run, c.maxWidth)
    return { width: Math.max(0, ...lines.map(l => l.width)), height: lines.length * this.lineHeight(run), lines }
  }

  private glyphSlot(f: FontSpec, ch: string) {
    const scale = this.oversample
    const key = `${this.css(f)}|${ch}`
    const existing = this.atlas.get(key)
    if (existing) return existing
    const w = Math.ceil(this.advance(f, ch) * scale) + PAD * 2
    const h = Math.ceil(f.size * 1.3 * scale) + PAD * 2
    return this.atlas.allocate(key, w, h, (ctx, x, y) => {
      ctx.clearRect(x, y, w, h)
      ctx.font = this.css(f, scale); ctx.textBaseline = 'top'; ctx.fillStyle = '#fff'
      ctx.fillText(ch, x + PAD, y + PAD)
    })
  }

  layout(run: TextRun, maxWidth: number | undefined, align: 'left' | 'center' | 'right'): GlyphPlacement[] {
    const lines = this.breakLines(run, maxWidth)
    const out: GlyphPlacement[] = []
    const chars = [...run.text]
    const pageSize = this.atlas.pages[0]?.width ?? 2048
    for (const line of lines) {
      const free = maxWidth === undefined ? 0 : Math.max(0, maxWidth - line.width)
      let x = align === 'center' ? free / 2 : align === 'right' ? free : 0
      for (let i = line.start; i < line.end; i++) {
        const ch = chars[i]!
        const adv = this.advance(run.font, ch, run.letterSpacing)
        if (ch !== ' ' && ch !== '\n') {
          const s = this.glyphSlot(run.font, ch)
          const ps = this.atlas.pages[s.page]!.width || pageSize
          out.push({ char: ch, x: x - PAD / this.oversample, y: line.y - PAD / this.oversample, width: s.width / this.oversample, height: s.height / this.oversample, page: s.page, u0: s.x / ps, v0: s.y / ps, u1: (s.x + s.width) / ps, v1: (s.y + s.height) / ps })
        }
        x += adv
      }
    }
    return out
  }

  caretRect(run: TextRun, maxWidth: number | undefined, index: number) {
    const lines = this.breakLines(run, maxWidth); const chars = [...run.text]
    const line = lines.find(l => index >= l.start && index <= l.end) ?? lines[lines.length - 1]!
    let x = 0; for (let i = line.start; i < Math.min(index, line.end); i++) x += this.advance(run.font, chars[i]!, run.letterSpacing)
    return { x, y: line.y, height: this.lineHeight(run) }
  }

  caretFromPoint(run: TextRun, maxWidth: number | undefined, x: number, y: number): number {
    const lines = this.breakLines(run, maxWidth); const chars = [...run.text]
    const lh = this.lineHeight(run)
    const line = lines[Math.max(0, Math.min(lines.length - 1, Math.floor(y / lh)))]!
    let cx = 0
    for (let i = line.start; i < line.end; i++) { const w = this.advance(run.font, chars[i]!, run.letterSpacing); if (x < cx + w / 2) return i; cx += w }
    return line.end
  }

  selectionRects(run: TextRun, maxWidth: number | undefined, start: number, end: number) {
    const [a, b] = start <= end ? [start, end] : [end, start]
    const lh = this.lineHeight(run)
    return this.breakLines(run, maxWidth).filter(l => l.end > a && l.start < b).map(l => {
      const s = this.caretRect(run, maxWidth, Math.max(a, l.start)).x, e = this.caretRect(run, maxWidth, Math.min(b, l.end)).x
      return { x: s, y: l.y, width: e - s, height: lh }
    })
  }
}
```

Add `export * from './system'` to `packages/text/src/index.ts`.

- [ ] **Step 4: Run to verify it passes** — 6 passed. If the CJK line-count assertion is off by one because `@napi-rs/canvas` reports a fallback font with a different advance for CJK glyphs, change that assertion to check `every line width ≤ 100` and `lines.length ≥ 3` and note the font in a comment — do not weaken the mixed-script test.

- [ ] **Step 5: Commit**

```bash
git add packages/text/src packages/text/test/system.test.ts
git commit -m "feat(text): SystemFontEngine with CJK-aware wrapping, atlas rasterization and caret APIs"
```

---

### Task 14: Render-list generation

**Files:**
- Create: `packages/core/src/renderlist.ts`, `packages/core/src/surface.ts`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/test/renderlist.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // surface.ts
  export interface SurfaceModel { id: string; root: Node; width: number; height: number; ptPerUnit: number; placement: 'screen' | 'world'; background: 'none' | 'glass' | string; cornerRadius: number }
  export function createSurface(opts: Partial<Omit<SurfaceModel,'root'>> & { width: number; height: number }): SurfaceModel   // root = new Node('box', `${id}-root`) with style { width, height }
  // renderlist.ts
  export interface PanelInstance { node: Node; rect: Rect; radius: number; color: RGBA; border?: { width: number; color: RGBA }; clip?: Rect; z: number; elevation: number; opacity: number }
  export interface GlassInstance { node: Node; rect: Rect; radius: number; z: number; elevation: number; params: ResolvedGlass; clip?: Rect }
  export interface ResolvedGlass { thickness: number; fillet: number; filletBottom: number; profile: 'fillet' | 'lens'; scatter: number; lift: number; edgeGlow: number; ior: number; dispersion: number; roughness: number; tint: RGBA | null; absorption: number; glow: { color: RGBA; strength: number; split?: number } | null; cornerExponent: number }
  export interface TextInstance { node: Node; rect: Rect; text: string; font: { family: string; size: number; weight: number }; color: RGBA; align: 'left' | 'center' | 'right'; maxLines?: number; z: number; elevation: number; clip?: Rect }
  export interface DecorationInstance { node: Node; kind: 'rim' | 'pool'; rect: Rect; radius: number; color: RGBA; strength: number; z: number }
  export interface ImageInstance { node: Node; rect: Rect; src: unknown; radius: number; z: number; clip?: Rect }
  export interface RenderList { panels: PanelInstance[]; glass: GlassInstance[]; text: TextInstance[]; decorations: DecorationInstance[]; images: ImageInstance[] }
  export function buildRenderList(surface: SurfaceModel, theme: Theme, scheme: ColorScheme): RenderList
  ```
  Rules: `z` = pre-order index; elevation accumulates down the tree; `bg: 'glass' | 'glass-clear'` or `type === 'glass'` → `GlassInstance` (+ `rim` and `pool` decorations: pool colour = glow colour or white, strength 0.5 tinted / 0.28 clear); other `bg` tokens → `PanelInstance`; text nodes → `TextInstance` with `props.value` string; `overflow hidden/scroll` ancestors set `clip` to their absolute rect; `display: 'none'` subtrees are skipped; state branches (`hover/pressed/focused/disabled`) are merged into the effective style before resolving.

- [ ] **Step 1: Write the failing test**

`packages/core/test/renderlist.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { Node } from '../src/node'
import { createYogaLayout, type LayoutEngine } from '../src/layout/yoga'
import { createSurface } from '../src/surface'
import { buildRenderList } from '../src/renderlist'
import { defaultTheme as theme } from '../src/style/theme'

let engine: LayoutEngine
beforeAll(async () => { engine = await createYogaLayout() })

function form() {
  const s = createSurface({ id: 's', width: 400, height: 300 })
  const card = new Node('box', 'card'); card.setStyle({ position: 'absolute', left: 20, top: 20, width: 200, height: 100, bg: 'fill', radius: 'lg', overflow: 'hidden' })
  const btn = new Node('glass', 'btn'); btn.setStyle({ position: 'absolute', left: 10, top: 10, width: 120, height: 40, radius: 'capsule', glass: { glow: { color: 'accent', strength: 1.1 } } }); btn.elevation = 4
  const label = new Node('text', 'label'); label.setProp('value', '创建账号'); label.setStyle({ color: 'fill', fontSize: 'base', textAlign: 'center', width: '100%', height: '100%' })
  const hidden = new Node('box', 'hidden'); hidden.setStyle({ display: 'none', bg: 'accent' })
  s.root.appendChild(card); card.appendChild(btn); btn.appendChild(label); s.root.appendChild(hidden)
  engine.compute(s.root, 400, 300, () => ({ width: 80, height: 22 }))
  return { s, card, btn, label }
}

describe('buildRenderList', () => {
  it('emits panels, glass with decorations, and text with accumulated elevation and clips', () => {
    const { s } = form()
    const rl = buildRenderList(s, theme, 'light')
    expect(rl.panels.map(p => p.node.id)).toEqual(['card'])
    expect(rl.panels[0]).toMatchObject({ rect: { x: 20, y: 20, width: 200, height: 100 }, radius: theme.radius.lg, elevation: 0 })
    expect(rl.glass).toHaveLength(1)
    expect(rl.glass[0]).toMatchObject({ rect: { x: 30, y: 30, width: 120, height: 40 }, radius: 20, elevation: 4, clip: { x: 20, y: 20, width: 200, height: 100 } })
    expect(rl.glass[0]!.params.glow).toMatchObject({ strength: 1.1 }); expect(rl.glass[0]!.params.fillet).toBe(theme.glass.fillet)
    expect(rl.decorations.map(d => d.kind).sort()).toEqual(['pool', 'rim'])
    expect(rl.text[0]).toMatchObject({ text: '创建账号', align: 'center', elevation: 4 })
    expect(rl.text[0]!.z).toBeGreaterThan(rl.glass[0]!.z)
  })
  it('skips display:none subtrees', () => {
    const rl = buildRenderList(form().s, theme, 'light')
    expect(rl.panels.find(p => p.node.id === 'hidden')).toBeUndefined()
  })
  it('applies state branches before resolving', () => {
    const { s, card } = form()
    card.setStyle({ hover: { opacity: 0.5 } }); card.state.hover = true
    expect(buildRenderList(s, theme, 'light').panels[0]!.opacity).toBe(0.5)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL.

- [ ] **Step 3: Implement**

`packages/core/src/surface.ts`:
```ts
import { Node } from './node'
export interface SurfaceModel { id: string; root: Node; width: number; height: number; ptPerUnit: number; placement: 'screen' | 'world'; background: 'none' | 'glass' | string; cornerRadius: number }
let n = 0
export function createSurface(opts: Partial<Omit<SurfaceModel, 'root'>> & { width: number; height: number }): SurfaceModel {
  const id = opts.id ?? `surface-${++n}`
  const root = new Node('box', `${id}-root`)
  root.setStyle({ width: opts.width, height: opts.height })
  return { id, root, width: opts.width, height: opts.height, ptPerUnit: opts.ptPerUnit ?? 244, placement: opts.placement ?? 'screen', background: opts.background ?? 'none', cornerRadius: opts.cornerRadius ?? 0 }
}
```

`packages/core/src/renderlist.ts`:
```ts
import type { Node, Rect } from './node'
import type { Style } from './style/schema'
import { resolveColor, resolveFontSize, resolveRadius, type ColorScheme, type RGBA, type Theme } from './style/theme'
import { absoluteRect } from './events/hit'
import type { SurfaceModel } from './surface'

export interface ResolvedGlass { thickness: number; fillet: number; filletBottom: number; profile: 'fillet' | 'lens'; scatter: number; lift: number; edgeGlow: number; ior: number; dispersion: number; roughness: number; tint: RGBA | null; absorption: number; glow: { color: RGBA; strength: number; split?: number } | null; cornerExponent: number }
export interface PanelInstance { node: Node; rect: Rect; radius: number; color: RGBA; border?: { width: number; color: RGBA }; clip?: Rect; z: number; elevation: number; opacity: number }
export interface GlassInstance { node: Node; rect: Rect; radius: number; z: number; elevation: number; params: ResolvedGlass; clip?: Rect }
export interface TextInstance { node: Node; rect: Rect; text: string; font: { family: string; size: number; weight: number }; color: RGBA; align: 'left' | 'center' | 'right'; maxLines?: number; z: number; elevation: number; clip?: Rect }
export interface DecorationInstance { node: Node; kind: 'rim' | 'pool'; rect: Rect; radius: number; color: RGBA; strength: number; z: number }
export interface ImageInstance { node: Node; rect: Rect; src: unknown; radius: number; z: number; clip?: Rect }
export interface RenderList { panels: PanelInstance[]; glass: GlassInstance[]; text: TextInstance[]; decorations: DecorationInstance[]; images: ImageInstance[] }

export function effectiveStyle(n: Node): Style {
  const { hover, pressed, focused, disabled, ...base } = n.style
  let s: Style = base
  if (n.state.hover && hover) s = { ...s, ...hover }
  if (n.state.focused && focused) s = { ...s, ...focused }
  if (n.state.pressed && pressed) s = { ...s, ...pressed }
  if (n.state.disabled && disabled) s = { ...s, ...disabled }
  return s
}

function intersect(a: Rect | undefined, b: Rect): Rect {
  if (!a) return b
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y)
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) }
}

function resolveGlass(s: Style, theme: Theme, scheme: ColorScheme): ResolvedGlass {
  const g = s.glass ?? {}
  const d = theme.glass
  return {
    thickness: g.thickness ?? d.thickness, fillet: g.fillet ?? d.fillet, filletBottom: g.filletBottom ?? d.filletBottom, profile: g.profile ?? 'fillet',
    scatter: g.scatter ?? (s.bg === 'glass-clear' ? 0.02 : d.scatter), lift: g.lift ?? d.lift, edgeGlow: g.edgeGlow ?? d.edgeGlow,
    ior: g.ior ?? d.ior, dispersion: g.dispersion ?? d.dispersion, roughness: g.roughness ?? d.roughness,
    tint: g.tint ? resolveColor(g.tint, theme, scheme) : null, absorption: g.absorption ?? 0,
    glow: g.glow ? { color: resolveColor(g.glow.color, theme, scheme), strength: g.glow.strength, ...(g.glow.split !== undefined ? { split: g.glow.split } : {}) } : null,
    cornerExponent: g.cornerExponent ?? 4.5,
  }
}

export function buildRenderList(surface: SurfaceModel, theme: Theme, scheme: ColorScheme): RenderList {
  const rl: RenderList = { panels: [], glass: [], text: [], decorations: [], images: [] }
  let z = 0
  const visit = (n: Node, clip: Rect | undefined, elevation: number) => {
    const s = effectiveStyle(n)
    if (s.display === 'none') return
    const rect = absoluteRect(n)
    const myZ = z++
    const elev = elevation + n.elevation
    const radius = resolveRadius(s.radius, theme, rect.width, rect.height)
    const opacity = s.opacity ?? 1
    const isGlass = n.type === 'glass' || s.bg === 'glass' || s.bg === 'glass-clear'
    if (isGlass) {
      const params = resolveGlass(s, theme, scheme)
      rl.glass.push({ node: n, rect, radius, z: myZ, elevation: elev, params, ...(clip ? { clip } : {}) })
      const poolColor: RGBA = params.glow ? params.glow.color : [1, 1, 1, 1]
      rl.decorations.push({ node: n, kind: 'rim', rect, radius, color: [1, 1, 1, 1], strength: 1, z: myZ + 0.5 })
      rl.decorations.push({ node: n, kind: 'pool', rect, radius, color: poolColor, strength: params.glow ? 0.5 : 0.28, z: myZ - 0.5 })
    } else if (s.bg && s.bg !== 'none') {
      const color = resolveColor(s.bg, theme, scheme)
      rl.panels.push({ node: n, rect, radius, color, ...(s.border ? { border: { width: s.border.width, color: resolveColor(s.border.color, theme, scheme) } } : {}), ...(clip ? { clip } : {}), z: myZ, elevation: elev, opacity })
    }
    if (n.type === 'text') {
      rl.text.push({ node: n, rect, text: String(n.props.value ?? ''), font: { family: s.font ?? 'system', size: resolveFontSize(s.fontSize, theme), weight: s.fontWeight ?? 500 }, color: resolveColor(s.color ?? 'label', theme, scheme), align: s.textAlign ?? 'left', ...(s.maxLines !== undefined ? { maxLines: s.maxLines } : {}), z: myZ, elevation: elev, ...(clip ? { clip } : {}) })
    }
    if (n.type === 'image') rl.images.push({ node: n, rect, src: n.props.src, radius, z: myZ, ...(clip ? { clip } : {}) })
    const childClip = s.overflow === 'hidden' || s.overflow === 'scroll' || n.type === 'scroll' ? intersect(clip, rect) : clip
    for (const c of n.children) visit(c, childClip, elev)
  }
  visit(surface.root, undefined, 0)
  return rl
}
```

Add to `index.ts`: `export * from './surface'; export * from './renderlist'; export * from './style/schema'; export * from './style/theme'; export * from './style/tw'; export * from './layout/yoga'; export * from './events/hit'; export * from './events/dispatch'; export * from './focus'; export * from './animation/spring'; export * from './scroll'`.

- [ ] **Step 4: Run to verify it passes** — 3 passed; then `pnpm test && pnpm typecheck` → all green.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/test/renderlist.test.ts
git commit -m "feat(core): Surface model and render-list generation with glass three-layer params"
```

---

### Task 15: Phase 0 spike ③ — `@pmndrs/glyph` CJK evaluation (throwaway)

**Files:**
- Create: `spikes/glyph-cjk/index.html`, `spikes/glyph-cjk/main.ts`, `spikes/glyph-cjk/package.json`
- Create: `docs/superpowers/spikes/2026-10-08-glyph-cjk.md`
- Modify: root `package.json` scripts (`"spike:glyph": "vite spikes/glyph-cjk --port 5175"`)

**Interfaces:**
- Produces: a written decision — which engine is Plan 2's default (`SystemFontEngine` vs `@pmndrs/glyph` MSDF) and under what conditions the other is used.

- [ ] **Step 1: Scaffold the spike**

`spikes/glyph-cjk/package.json`:
```json
{ "name": "spike-glyph-cjk", "private": true, "type": "module", "dependencies": { "@pmndrs/glyph": "^0.1.0", "three": "^0.186.1" } }
```
Run `pnpm install`. `index.html` is a copy of `spikes/glass3d/index.html` with the title "GlassUI spike · glyph CJK" and `<script type="module" src="./main.ts">`.

- [ ] **Step 2: Render the comparison**

`spikes/glyph-cjk/main.ts` — two columns on a flat plane under `WebGPURenderer`: left = `@pmndrs/glyph` text (follow its README: create a `Text`/`GlyphText` with a font (bundle a Noto Sans SC subset `.ttf` via `?url` import; if the README offers a system-font/fallback option, use it), string `创建你的账号 Create your account 14天免费试用 ①②③ — 「引号」…`, sizes 14 / 17 / 24 / 46 pt); right = the same strings rendered with `SystemFontEngine` from Task 13 (`createCanvas = (w, h) => Object.assign(document.createElement('canvas'), { width: w, height: h })`) uploaded as `CanvasTexture` glyph quads. Add `?webgl` support like the other spikes. Add a camera dolly (OrbitControls) so both columns can be inspected at 3× zoom and at a 60° angle.

- [ ] **Step 3: Measure**

Record in the doc, for each engine: (a) does every character render (list any missing/blank glyphs), (b) sharpness at 1× and 3× zoom and at 60° (screenshots saved under `docs/superpowers/spikes/img/`), (c) time to first paint and bytes loaded (DevTools Network), (d) draw calls from `renderer.info`, (e) whether glyph generation happens on demand or needs a prebuilt charset, (f) WebGL2 backend parity.

- [ ] **Step 4: Decide and document**

Write `docs/superpowers/spikes/2026-10-08-glyph-cjk.md` with the table from Step 3 and one of these decisions, verbatim:
- "**默认 SystemFontEngine，glyph 后置**" if glyph misses any CJK character, needs a prebuilt charset, or fails on the WebGL2 backend; or
- "**默认 glyph（MSDF）+ SystemFontEngine 兜底 CJK**" if glyph renders all characters on demand on both backends and is sharper at 3× zoom.
Include the exact follow-up tasks the decision implies for Plan 2 (e.g. "Plan 2 Task X: add `MsdfEngine` adapter with fallback to system engine per glyph").

- [ ] **Step 5: Commit**

```bash
git add spikes/glyph-cjk docs/superpowers/spikes/2026-10-08-glyph-cjk.md package.json pnpm-lock.yaml
git commit -m "spike: @pmndrs/glyph vs SystemFontEngine for CJK — decision for Plan 2"
```

---

## Self-review

**Spec coverage (Plan 1 scope):** §2 package layout → T1; §3.3 Node → T3; §3.2 Surface data → T14; §4.1 Style → T4; §4.2 tw → T6; §4.3 theme/tokens/metrics → T5; §4.4 springs → T10; §7.1 hit/dispatch → T8; §7.2 focus → T9; §7.4 scroll physics → T11; §6 text engine/atlas/caret → T12–T13; render lists (§5.6 step 1) → T14; §9 error format → T2 (+ every validation site); §10 Node-level tests → every task; §11 Phase 0 ③ → T15. Deferred to Plan 2/3 (by design): §5 three.js rendering, §7.3 IME bridge (needs DOM + render), §8 Vue renderer/components/manifest, §3.1 `UIRoot` (needs renderer).

**Placeholder scan:** no TBD/TODO; every code step has full code; T15 is a spike with explicit measurements and a binary decision rule rather than code to keep.

**Type consistency:** `Node.setStyle(Partial<Style>)` (T3) matches `validateStyle` output (T4); `LayoutEngine.compute(root, w, h, measure)` (T7) is what T8/T14 tests call; `EventDispatcher.dispatch(target, type, init)` (T8) is what `FocusManager` (T9) calls; `Spring`/`SpringConfig` (T10) are what `ScrollPhysics` (T11) and `resolveSpring` use; `AtlasManager.allocate/get/dirtyPages/pages` (T12) are what `SystemFontEngine` (T13) uses; `ResolvedGlass` field names (T14) mirror `GlassParamsSchema` (T4) and `theme.glass` (T5).

**Review Focus → tests:** 1 → T13 "mixed CJK + Latin"; 2 → T7 "never yields NaN"; 3 → T8 "ignores pointerEvents none, display none, clipped overflow"; 4 → T9 "drops focus without throwing"; 5 → T6 "unsupported or stacked prefixes".
