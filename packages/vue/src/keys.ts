import type { InjectionKey } from '@vue/runtime-core'
import type { Surface } from '@glassui/render'
import type { GlassRoot } from './root'
import type { GlassAppOptions } from './app'

/** The app's render root (`createGlassApp`'s `opts.root`). */
export const GLASS_ROOT: InjectionKey<GlassRoot> = Symbol('glass-root')
/** The Surface the subtree renders into: the one `mount(surface)` took or a `<Surface>` made; null in a detached container. */
export const GLASS_SURFACE: InjectionKey<Surface | null> = Symbol('glass-surface')
/** The app options components read, defaults filled in. */
export const GLASS_OPTIONS: InjectionKey<Required<Pick<GlassAppOptions, 'motion' | 'createCanvas'>>> = Symbol('glass-options')
