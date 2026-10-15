import {
  cloneVNode, computed, defineComponent, isVNode, normalizeClass, Suspense, Teleport,
  type Component, type ComputedRef, type SetupContext, type VNodeChild,
} from '@vue/runtime-core'
import { z } from 'zod'
import { GlassUIError } from '@glassui/core'
import { mergeStyle } from './renderer'
import { parseProps } from './validate'

/** A component's manifest entry (spec §8.2): what an agent reads to use it. */
export interface GlassComponentMeta<P extends z.ZodObject> {
  /** PascalCase, e.g. 'Button'. */
  name: string
  /** One paragraph, for the manifest. */
  description: string
  /** Every field `.describe('…')`d; defaults via `.default()`. */
  props: P
  events?: Record<string, { payload: string; description: string }>
  slots?: Record<string, string>
  /** 2–3 template snippets, each a complete `<Comp …>` usage. */
  examples: string[]
  mistakes?: { mistake: string; fix: string }[]
}
export type GlassComponent<P extends z.ZodObject = z.ZodObject> = Component & { readonly glass: GlassComponentMeta<P> }

const registry: GlassComponent[] = []
/** Every `defineGlassComponent` component, in definition order (the manifest reads it). */
export const glassComponents = (): readonly GlassComponent[] => registry

/** Attributes a glass component takes besides its props and `on*` listeners; they fall through to its root. */
const FALLTHROUGH: ReadonlySet<string> = new Set(['class', 'style', 'tw', 'id', 'key', 'ref'])
const isBool = (s: z.ZodType): boolean => {
  let t: z.ZodType = s
  while (t instanceof z.ZodOptional || t instanceof z.ZodDefault) t = t.unwrap() as z.ZodType
  return t instanceof z.ZodBoolean
}
const joinClasses = (own: unknown, user: unknown): string => [normalizeClass(own), normalizeClass(user)].filter(Boolean).join(' ')

/**
 * `root` with the fallthrough `attrs` applied, when it is an element or a component (anything else, a Fragment, a
 * Teleport, text, has nowhere to put them: they are dropped). Unlike Vue's own fallthrough, nothing of the root's is
 * lost: `class` and `tw` are the root's then the user's (the user's win a conflict), `style` merges key by key with
 * nested `glass` / `transition` / state branches (`mergeStyle`), `on*` listeners both run, anything else (`id`) is set.
 * A component root receives them the same way and applies them to its own root in turn.
 */
function fallthrough(root: VNodeChild, attrs: Record<string, unknown>): VNodeChild {
  if (!isVNode(root) || Object.keys(attrs).length === 0) return root
  const t: unknown = root.type
  if (!(typeof t === 'string' || typeof t === 'function' || (typeof t === 'object' && t !== Teleport && t !== Suspense))) return root
  const own = root.props ?? {}, extra: Record<string, unknown> = { ...attrs }
  if ('style' in attrs) extra.style = mergeStyle(own.style, attrs.style)
  if ('tw' in attrs) extra.tw = joinClasses(own.tw, attrs.tw)
  return cloneVNode(root, extra, true)   // Vue's mergeProps: `class` concatenated, `on*` both kept, the rest from `extra`
}

/**
 * A component with a zod props schema and manifest metadata (spec §8.2), registered for the manifest.
 *
 * - Props are declared from the schema (a boolean one with Vue's boolean casting, so `<Btn disabled>` is true) and
 *   parsed by `parseProps` (zod's defaults applied): `setup` gets them as `props.value`, which throws the readable
 *   `GlassUIError` while they are invalid; every render re-raises it until they are fixed.
 * - Attributes other than the props, `on*` listeners, `class`, `style`, `tw`, `id`, `key` and `ref` throw
 *   `[<name>] 未知属性 "x"` (in setup and on every render), with the props as the allowed values.
 * - `meta.events` are its emits; the other listeners, `class`, `style`, `tw` and `id` fall through to its root
 *   (`fallthrough`: merged, never replacing the root's own).
 */
export function defineGlassComponent<P extends z.ZodObject>(meta: GlassComponentMeta<P>, setup: (props: ComputedRef<z.output<P>>, ctx: SetupContext) => () => VNodeChild): GlassComponent<P> {
  const keys = Object.keys(meta.props.shape)
  // skipCheck: zod checks the types (Vue's own check would warn about the same mistake first)
  const props = Object.fromEntries(keys.map(k => [k, isBool(meta.props.shape[k] as z.ZodType) ? { type: Boolean, default: undefined, skipCheck: true } : { type: null, default: undefined }]))
  const checkAttrs = (attrs: Record<string, unknown>): void => {
    for (const k of Object.keys(attrs)) if (!FALLTHROUGH.has(k) && !/^on[A-Z]/.test(k)) throw new GlassUIError(meta.name, `未知属性 "${k}"`, { allowed: keys, got: k })
  }
  const comp = defineComponent({
    name: meta.name, props, emits: Object.keys(meta.events ?? {}), inheritAttrs: false,
    setup(raw, ctx) {
      checkAttrs(ctx.attrs)
      // `parsed` never throws, so the render reads the parse from it: a computed that threw hands its last value to
      // the next reader until its sources change (`p` throws, for the setup's own reads)
      const parsed = computed((): { data: z.output<P> } | { error: unknown } => {
        try { return { data: parseProps(meta.name, meta.props, raw as Record<string, unknown>) } } catch (error) { return { error } }
      })
      const p = computed(() => { const r = parsed.value; if ('error' in r) throw r.error; return r.data })
      const render = setup(p, ctx as SetupContext)
      return () => {
        checkAttrs(ctx.attrs)
        const r = parsed.value
        if ('error' in r) throw r.error
        return fallthrough(render(), ctx.attrs)
      }
    },
    // what a setup that threw leaves (Vue reports the error; without a render it would also warn "missing render function")
    render: () => null,
  })
  const out: GlassComponent = Object.assign(comp, { glass: meta as unknown as GlassComponentMeta<z.ZodObject> })
  registry.push(out)
  // typed as any Component: zod checks the props at run time (and a test may pass wrong ones on purpose)
  return out as GlassComponent<P>
}
