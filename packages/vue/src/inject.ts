import { computed, getCurrentScope, inject, onScopeDispose, ref, shallowRef, unref, type Ref } from '@vue/runtime-core'
import { GlassUIError, type ColorScheme, type Theme } from '@glassui/core'
import type { CanvasLike } from '@glassui/text'
import type { Surface } from '@glassui/render'
import { GLASS_OPTIONS, GLASS_ROOT, GLASS_SURFACE } from './keys'
import type { GlassRoot } from './root'

const OUTSIDE = '组件必须在 createGlassApp 创建的应用里使用'

/** The app's render root. Outside an app made by `createGlassApp` it throws. */
export function useRoot(): GlassRoot {
  const root = inject(GLASS_ROOT, null)
  if (!root) throw new GlassUIError('useRoot', OUTSIDE)
  return root
}

/**
 * The Surface the component renders into, as it is at the call (a provided ref is read now); null in a detached
 * container. A `<Surface>` makes its render Surface again when a placement prop changes and moves the content over, so
 * a value kept past setup can go stale: code that keeps the Surface (projecting a caret, a focus trap) uses
 * `useSurfaceRef()`.
 */
export function useSurface(): Surface | null {
  return unref(inject(GLASS_SURFACE, null))
}

/**
 * The Surface the component renders into, as a read-only ref that follows a `<Surface>` making its Surface again. The
 * Surface `mount(surface)` took never changes; null in a detached container.
 */
export function useSurfaceRef(): Readonly<Ref<Surface | null>> {
  const provided = inject(GLASS_SURFACE, null)
  return computed(() => unref(provided))
}

/** The app's motion: `'frozen'` makes transitions complete at once (tests, screenshots). `'live'` outside an app. */
export function useMotion(): 'live' | 'frozen' {
  return inject(GLASS_OPTIONS, null)?.motion ?? 'live'
}

/** The canvas factory components draw into (icons). Outside an app made by `createGlassApp` it throws. */
export function useCanvasFactory(): (w: number, h: number) => CanvasLike {
  const opts = inject(GLASS_OPTIONS, null)
  if (!opts) throw new GlassUIError('useCanvasFactory', OUTSIDE)
  return opts.createCanvas
}

/**
 * The root's colour scheme, kept current by its `theme` event (until the calling scope, a component's setup, ends):
 * components that rasterise colours (Icon) re-render on it.
 */
export function useScheme(): Readonly<Ref<ColorScheme>> {
  const root = useRoot(), scheme = ref<ColorScheme>(root.scheme)
  const off = root.on('theme', e => { scheme.value = e.scheme })
  if (getCurrentScope()) onScopeDispose(off)
  return scheme
}

/**
 * The root's theme, kept current by its `theme` event as `useScheme` keeps the scheme: a `setTheme` that keeps the
 * scheme still swaps the colours the tokens name, so components that resolve tokens themselves (Icon, Button) read both.
 */
export function useTheme(): Readonly<Ref<Theme>> {
  const root = useRoot(), theme = shallowRef<Theme>(root.theme)
  const off = root.on('theme', e => { theme.value = e.theme })
  if (getCurrentScope()) onScopeDispose(off)
  return theme
}
