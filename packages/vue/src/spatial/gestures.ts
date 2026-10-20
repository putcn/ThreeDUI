import type { KeyGesture, WheelGesture } from '@glassui/render'
import type { SpaceContext } from './context'

export function createSpaceGestures(ctx: SpaceContext, opts: {
  columns: () => number
  names: () => string[]
  focusedSurface: () => unknown
  surfaceName: (surface: unknown) => string | null
  composing: () => boolean
}): { wheel(g: WheelGesture): boolean; key(g: KeyGesture): boolean } {
  let total = 0, last = -Infinity
  return {
    wheel(g) {
      if (!g.ctrlKey && !g.metaKey) { total = 0; last = -Infinity; return false }
      const now = Date.now()
      total = now - last <= 300 ? total + g.deltaY : g.deltaY
      last = now
      if (ctx.focused.value !== null && total >= 40) { ctx.requestFocus(null); total = 0 }
      else if (ctx.focused.value === null && total <= -40 && g.surface) {
        const name = opts.surfaceName(g.surface)
        if (name) { ctx.requestFocus(name); total = 0 }
      }
      return true
    },
    key(g: KeyGesture) {
      const names = opts.names()
      if (g.type !== 'keydown') return false
      if (ctx.mode.value === 'overview') {
        if (!names.length) return true
        let i = names.indexOf(ctx.highlighted.value ?? '')
        if (g.key === 'Tab') { i = i < 0 ? 0 : (i + (g.shiftKey ? -1 : 1) + names.length) % names.length; ctx.highlight(names[i]!, 'keys'); return true }
        const columns = Math.max(1, opts.columns()), row = i < 0 ? 0 : Math.floor(i / columns), col = i < 0 ? 0 : i % columns
        if (g.key === 'ArrowLeft') i = i < 0 ? 0 : row * columns + Math.max(0, col - 1)
        else if (g.key === 'ArrowRight') i = i < 0 ? 0 : Math.min(names.length - 1, row * columns + Math.min(columns - 1, col + 1))
        else if (g.key === 'ArrowUp') i = Math.max(0, (row - 1) * columns + col)
        else if (g.key === 'ArrowDown') i = Math.min(names.length - 1, (row + 1) * columns + col)
        else if (g.key === 'Enter' || g.key === ' ') { if (i < 0) i = 0; ctx.requestFocus(names[i]!); return true }
        else return false
        ctx.highlight(names[i]!, 'keys'); return true
      }
      if (g.key !== 'Escape' || !ctx.focused.value || g.surface !== opts.focusedSurface()) return false
      if (g.focused?.props.textField === true || opts.composing()) return false
      ctx.requestFocus(null); return true
    },
  }
}
