import type { UIRoot } from '@glassui/render'

/**
 * The part of a render `UIRoot` the Vue layer uses. Everything in `@glassui/vue` reaches the render package through
 * this type (type-only imports), so the package and its tests never load three.
 */
export type GlassRoot = Pick<UIRoot, 'theme' | 'scheme' | 'contrast' | 'anim' | 'text' | 'surfaces' | 'pointer' | 'createSurface' | 'removeSurface' | 'afterTick' | 'on' | 'screenFromPoint' | 'createCameraRig'>
