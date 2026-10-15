import type { InjectionKey, Ref } from '@vue/runtime-core'
import type { Surface } from '@glassui/render'
import type { GlassRoot } from './root'
import type { GlassAppOptions } from './app'

/** The app's render root (`createGlassApp`'s `opts.root`). */
export const GLASS_ROOT: InjectionKey<GlassRoot> = Symbol('glass-root')
/**
 * The Surface the subtree renders into: the one `mount(surface)` took, or a ref to the one a `<Surface>` made (it may
 * make it again); null in a detached container. Read it with `useSurface()`, which unwraps the ref.
 */
export const GLASS_SURFACE: InjectionKey<Surface | null | Readonly<Ref<Surface | null>>> = Symbol('glass-surface')
/** The app options components read, defaults filled in. */
export const GLASS_OPTIONS: InjectionKey<Required<Pick<GlassAppOptions, 'motion' | 'createCanvas'>>> = Symbol('glass-options')
