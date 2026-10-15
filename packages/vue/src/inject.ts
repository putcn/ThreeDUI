import { getCurrentScope, inject, onScopeDispose, ref, unref, type Ref } from '@vue/runtime-core'
import { GlassUIError, type ColorScheme } from '@glassui/core'
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

/** The Surface the component renders into (a provided ref is read now); null in a detached container. */
export function useSurface(): Surface | null {
  return unref(inject(GLASS_SURFACE, null))
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
