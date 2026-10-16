import { computed, markRaw, onBeforeUnmount, provide, shallowRef, watch, type ShallowRef } from '@vue/runtime-core'
import { GlassUIError, type ColorScheme, type Node, type Theme } from '@glassui/core'
import type { CreateSurfaceOptions, Surface } from '@glassui/render'
import { colorOf } from './components/tokens'
import { useRoot } from './inject'
import { GLASS_SURFACE } from './keys'

/**
 * Throws unless `bg` is a Surface background: none, glass, or a colour token or `#hex` of the theme (the scope is
 * `<name>.background`).
 */
export function checkBackground(name: string, bg: string, theme: Theme, scheme: ColorScheme): void {
  if (bg === 'none' || bg === 'glass') return
  const scope = `${name}.background`
  try { colorOf(scope, bg, theme, scheme) } catch (e) {
    if (bg.startsWith('#') || /^rgba?\(/.test(bg)) throw e
    throw new GlassUIError(scope, `未知背景 "${bg}"（none、glass，或颜色 token、#hex）`, { allowed: ['none', 'glass', ...Object.keys(theme.colors[scheme])], got: bg })
  }
}

/**
 * The render Surface a component owns (`<Surface>`, `<Block>`), from creation to removal, provided to its subtree as a
 * ref (`GLASS_SURFACE`) so a Surface made again is what later `useSurface` reads see.
 *
 * - `spec()` gives what the Surface fixes at creation: `options` for `root.createSurface`, and `key`, which changes
 *   exactly when they do. A changed key makes the Surface again: the old one is removed (its press cancelled, its focus
 *   blurred), the new one takes over the keys when the old one held them, and once the render has moved the content
 *   over, the node focused in the old one is focused again, its ring as it was. While `spec()` is null (invalid props)
 *   the Surface stays as it is.
 * - `onError` gets the Surface's render failures (`'error'` events) while the component holds it.
 * - `onCreate` sees each new Surface before it is provided (a Block places it at its enter pose there).
 * - On unmount, before the content unmounts (its blur and pointercancel listeners still run), the Surface is released
 *   and removed, or handed to `onUnmount` instead (a Block's leave), which then owns its removal.
 *
 * `release()` detaches the current Surface from the component without removing it: it clears `surface`, cancels the
 * Surface's press (the hover leaves too), blurs its focused node and stops forwarding its errors; it returns that
 * Surface. Disposing alone would leave those nodes pressed, hovered and focused for good, since the content outlives
 * the Surface (it moves into the next one, or is being unmounted). `surface` is cleared first: the cancel and blur
 * listeners see no Surface (an `<Input>` takes such a blur as its Surface being made again, and waits for the update to
 * see whether it is focused in the next one), and a field the root's IME bridge holds is not this Surface's when the
 * root removes it.
 */
export function useRenderSurface(spec: () => { key: string; options: CreateSurfaceOptions } | null, opts: {
  onError: (e: Error) => void
  onCreate?: (s: Surface) => void
  onUnmount?: (s: Surface) => void
}): { surface: Readonly<ShallowRef<Surface | null>>; release(): Surface | null } {
  const root = useRoot()
  // the creation key; while `spec()` is null it keeps its last value (the Surface stays)
  const key = computed<string | undefined>(prev => spec()?.key ?? prev)
  // the Surface (raw: never a proxy, nor proxies of its nodes, whoever holds it)
  const surface = shallowRef<Surface | null>(null)
  const forward = (e: { error: Error }): void => { opts.onError(e.error) }
  /**
   * Releases the current Surface (see `release`). Returns it with what a next Surface takes over: the focused node with
   * its ring, and whether the root's pointer bridge sent its keys to it.
   */
  const detach = (): { s: Surface; focused: Node | null; visible: boolean; keys: boolean } | null => {
    const s = surface.value
    if (!s) return null
    const focused = s.focus.current, held = { s, focused, visible: focused?.state.focusVisible ?? false, keys: root.pointer?.active === s }
    surface.value = null
    s.pointer.cancel(); s.focus.focus(null)
    s.removeEventListener('error', forward)
    return held
  }
  /** The node to focus in the new Surface once the Teleport has moved the content there (see the post watcher below). */
  let refocus: { node: Node; visible: boolean } | null = null
  watch(key, k => {
    const sp = spec()
    if (k === undefined || !sp) return
    const held = detach()
    if (held) root.removeSurface(held.s)
    const made = markRaw(root.createSurface(sp.options))
    made.addEventListener('error', forward)
    opts.onCreate?.(made)
    surface.value = made
    if (held?.keys) root.pointer?.setActive(made)     // Tab and the keys carry on here
    refocus = held?.focused ? { node: held.focused, visible: held.visible } : null
  }, { immediate: true })
  // after the render has moved the content into a new Surface: the node focused in the old one is focused again, its
  // ring as it was (a no-op when it left the tree in the same update)
  watch(surface, s => {
    const r = refocus
    refocus = null
    if (s && r) s.focus.focus(r.node, { visible: r.visible })
  }, { flush: 'post' })
  provide(GLASS_SURFACE, surface)
  onBeforeUnmount(() => {
    const s = detach()?.s
    if (!s) return
    if (opts.onUnmount) opts.onUnmount(s); else root.removeSurface(s)
  })
  return { surface, release: () => detach()?.s ?? null }
}
