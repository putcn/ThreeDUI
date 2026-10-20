import type { RGBA } from '@glassui/core'
import type { CanvasFactory, CanvasLike } from '@glassui/text'
import { cssColor as css } from './colors'

/** The built-in icons (`<Icon name>`): the playground's set, then SF-Symbols-like strokes on the same 24-unit grid. */
export const ICON_NAMES = [
  'user', 'mail', 'lock', 'eye', 'check', 'x', 'arrow-right', 'apple', 'google',
  'eye-slash', 'chevron-left', 'chevron-right', 'chevron-up', 'chevron-down', 'plus', 'minus', 'search', 'gear', 'info', 'warning', 'star', 'heart',
  'grid', 'chart', 'list', 'map', 'cube', 'inbox', 'refresh', 'logout',
] as const
export type IconName = (typeof ICON_NAMES)[number]

/**
 * Names from other icon sets → ours: an icon prop's (`Icon.name`, `Button.leadingIcon`…) error suggests the one meant
 * (an alias is still an invalid name).
 */
export const ICON_ALIASES: Readonly<Record<string, IconName>> = {
  close: 'x', cross: 'x', times: 'x', settings: 'gear', cog: 'gear', ok: 'check', tick: 'check', checkmark: 'check',
  back: 'chevron-left', previous: 'chevron-left', prev: 'chevron-left', forward: 'chevron-right', next: 'chevron-right',
  add: 'plus', remove: 'minus', subtract: 'minus', person: 'user', profile: 'user', account: 'user', email: 'mail', envelope: 'mail',
  alert: 'warning', error: 'warning', favorite: 'heart', like: 'heart', hide: 'eye-slash', show: 'eye', password: 'lock', magnifier: 'search',
  dashboard: 'grid', analytics: 'chart', inventory: 'cube', signout: 'logout',
}

/** The Canvas2D calls the icons use (a DOM canvas and `@napi-rs/canvas` both have them; `CanvasLike` types fewer). */
type Ctx = Pick<CanvasRenderingContext2D,
  'strokeStyle' | 'fillStyle' | 'lineWidth' | 'lineCap' | 'lineJoin' | 'shadowColor' | 'shadowBlur' | 'shadowOffsetY'
  | 'beginPath' | 'closePath' | 'moveTo' | 'lineTo' | 'quadraticCurveTo' | 'bezierCurveTo' | 'arc' | 'roundRect' | 'stroke' | 'fill' | 'fillRect'
  | 'save' | 'restore' | 'translate' | 'scale' | 'globalCompositeOperation'>
const ctx2d = (cv: CanvasLike): Ctx => cv.getContext('2d') as unknown as Ctx

/** The Apple mark (24 × 24 viewBox): absolute `M`, relative `c` and `z` only. */
const APPLE = 'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701'

/**
 * Traces an SVG path's `M/m L/l C/c Z/z` commands (implicit repeats included) into `ctx`: `Path2D` is DOM-only, and the
 * icons also draw in Node (`@napi-rs/canvas`).
 */
function tracePath(ctx: Ctx, d: string): void {
  const tokens = d.match(/[MmLlCcZz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? []
  let i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0
  const num = (): number => Number(tokens[i++])
  ctx.beginPath()
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i]!)) cmd = tokens[i++]!
    const rel = cmd === cmd.toLowerCase(), ox = rel ? x : 0, oy = rel ? y : 0
    switch (cmd.toLowerCase()) {
      case 'm': x = ox + num(); y = oy + num(); sx = x; sy = y; ctx.moveTo(x, y); cmd = rel ? 'l' : 'L'; break   // pairs after M are L
      case 'l': x = ox + num(); y = oy + num(); ctx.lineTo(x, y); break
      case 'c': { const a = ox + num(), b = oy + num(), c = ox + num(), e = oy + num(); x = ox + num(); y = oy + num(); ctx.bezierCurveTo(a, b, c, e, x, y); break }
      case 'z': ctx.closePath(); x = sx; y = sy; cmd = ''; break   // a number after z ends the trace (no implicit repeat)
      default: return
    }
  }
}

type Pt = readonly [number, number]

/** `name` drawn into `ctx` on the 24-unit grid (the context already scaled), strokes `lw` units wide in `color`. */
function draw(ctx: Ctx, name: IconName, color: string, lw: number): void {
  ctx.strokeStyle = color; ctx.fillStyle = color
  ctx.lineWidth = lw; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
  const trace = (pts: readonly Pt[]): void => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))) }
  const line = (...pts: Pt[]): void => { trace(pts); ctx.stroke() }
  /** A closed outline (one stroke: a translucent colour is not drawn twice where it overlaps). */
  const shape = (pts: readonly Pt[]): void => { trace(pts); ctx.closePath(); ctx.stroke() }
  const ring = (cx: number, cy: number, r: number, a0 = 0, a1 = Math.PI * 2): void => { ctx.beginPath(); ctx.arc(cx, cy, r, a0, a1); ctx.stroke() }
  /** A round dot the stroke's weight (an i's or a ! 's point: a zero-length stroke draws nothing). */
  const dot = (cx: number, cy: number): void => { ctx.beginPath(); ctx.arc(cx, cy, lw * 0.62, 0, Math.PI * 2); ctx.fill() }
  const eye = (): void => {
    ctx.beginPath(); ctx.moveTo(4.8, 12)
    ctx.quadraticCurveTo(12, 3.6, 19.2, 12); ctx.quadraticCurveTo(12, 20.4, 4.8, 12)
    ctx.stroke()
    ring(12, 12, 2.4)
  }
  /** `n` points alternating between radii `r1` and `r0` about (cx, cy), the first at the top. */
  const star = (cx: number, cy: number, n: number, r1: number, r0: number): Pt[] =>
    Array.from({ length: n * 2 }, (_, i) => { const r = i % 2 ? r0 : r1, a = -Math.PI / 2 + i * Math.PI / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as const })
  switch (name) {
    // the playground's set (Plan 2), its fractions × 24
    case 'check': line([5.76, 12.48], [10.08, 16.8], [18.24, 7.68]); break
    case 'arrow-right': line([5.76, 12], [17.76, 12]); line([12.96, 7.2], [17.76, 12], [12.96, 16.8]); break
    case 'search': ring(10.56, 10.56, 4.8); line([14.4, 14.4], [18.72, 18.72]); break
    case 'x': line([7.2, 7.2], [16.8, 16.8]); line([16.8, 7.2], [7.2, 16.8]); break
    case 'user': ring(12, 8.64, 3.36); ring(12, 20.64, 7.2, Math.PI * 1.15, Math.PI * 1.85); break
    case 'mail':
      ctx.beginPath(); ctx.roundRect(4.8, 6.72, 14.4, 10.56, 1.44); ctx.stroke()
      line([5.28, 7.68], [12, 12.96], [18.72, 7.68])
      break
    case 'lock':
      ctx.beginPath(); ctx.roundRect(6.24, 11.04, 11.52, 8.64, 1.44); ctx.stroke()
      ring(12, 10.08, 3.84, Math.PI, 0)
      break
    case 'eye': eye(); break
    case 'apple':
      ctx.save(); ctx.translate(2.4, 1.92); ctx.scale(0.8, 0.8)
      tracePath(ctx, APPLE); ctx.fill()
      ctx.restore()
      break
    case 'google': {
      // the four brand colours, whatever `color` is
      ctx.lineWidth = 4.08; ctx.lineCap = 'butt'
      const seg = (a0: number, a1: number, c: string): void => {
        ctx.strokeStyle = c
        ctx.beginPath(); ctx.arc(12, 12, 7.2, a0 * Math.PI / 180, a1 * Math.PI / 180); ctx.stroke()
      }
      seg(0, 52, '#4285F4'); seg(50, 142, '#34A853'); seg(140, 232, '#FBBC05'); seg(230, 318, '#EA4335')
      ctx.fillStyle = '#4285F4'
      ctx.fillRect(12, 12 - 2.04, 7.2 + 2.04, 4.08)
      break
    }
    // new on the same grid: round caps and joins, about 13 units across like the set above
    case 'eye-slash':
      // the eye with a gap cut along the slash (as SF's eye.slash), then the slash
      eye()
      ctx.save(); ctx.globalCompositeOperation = 'destination-out'; ctx.lineWidth = lw * 2
      line([5.4, 5.4], [18.6, 18.6])
      ctx.restore()
      line([5.4, 5.4], [18.6, 18.6])
      break
    case 'chevron-left': line([14.4, 5.6], [8.4, 12], [14.4, 18.4]); break
    case 'chevron-right': line([9.6, 5.6], [15.6, 12], [9.6, 18.4]); break
    case 'chevron-up': line([5.6, 14.4], [12, 8.4], [18.4, 14.4]); break
    case 'chevron-down': line([5.6, 9.6], [12, 15.6], [18.4, 9.6]); break
    case 'plus': line([12, 5.6], [12, 18.4]); line([5.6, 12], [18.4, 12]); break
    case 'minus': line([5.6, 12], [18.4, 12]); break
    case 'gear': {
      // eight teeth, flat-topped, about a hub
      const pts: Pt[] = []
      for (let k = 0; k < 8; k++) {
        const a = k * Math.PI / 4
        for (const [r, da] of [[6.4, -0.36], [8.6, -0.2], [8.6, 0.2], [6.4, 0.36]] as const) pts.push([12 + r * Math.cos(a + da), 12 + r * Math.sin(a + da)])
      }
      shape(pts); ring(12, 12, 2.8)
      break
    }
    case 'info': ring(12, 12, 8); dot(12, 8.1); line([12, 11.2], [12, 16.2]); break
    case 'warning': shape([[12, 4.2], [20.4, 18.8], [3.6, 18.8]]); line([12, 9.6], [12, 13.4]); dot(12, 16.1); break
    case 'star': shape(star(12, 12.6, 5, 8.4, 3.9)); break
    case 'heart':
      ctx.beginPath(); ctx.moveTo(12, 19.6)
      ctx.bezierCurveTo(12, 19.6, 3.8, 14.6, 3.8, 9.2)
      ctx.bezierCurveTo(3.8, 6.5, 5.8, 4.8, 8.1, 4.8)
      ctx.bezierCurveTo(9.9, 4.8, 11.2, 5.8, 12, 7.2)
      ctx.bezierCurveTo(12.8, 5.8, 14.1, 4.8, 15.9, 4.8)
      ctx.bezierCurveTo(18.2, 4.8, 20.2, 6.5, 20.2, 9.2)
      ctx.bezierCurveTo(20.2, 14.6, 12, 19.6, 12, 19.6)
      ctx.closePath(); ctx.stroke()
      break
    case 'grid':
      for (const x of [5, 12, 19]) for (const y of [5, 12, 19]) { ctx.beginPath(); ctx.roundRect(x - 2.1, y - 2.1, 4.2, 4.2, 0.8); ctx.stroke() }
      break
    case 'chart': line([4.8, 19], [4.8, 5]); line([4.8, 19], [20, 19]); line([7, 15], [10, 11], [13, 13], [18.5, 6]); break
    case 'list': for (const y of [6, 12, 18]) { ring(5.5, y, 0.65); line([9, y], [19, y]) }; break
    case 'map': shape([[4, 6], [10, 4], [15, 6], [20, 4], [20, 18], [14, 20], [9, 18], [4, 20]]); line([9, 5], [9, 18]); line([15, 6], [15, 20]); break
    case 'cube': shape([[12, 3.8], [20, 8], [20, 16], [12, 20.2], [4, 16], [4, 8]]); line([4, 8], [12, 12.2], [20, 8]); line([12, 12.2], [12, 20]); break
    case 'inbox': shape([[4, 6], [20, 6], [21, 18], [3, 18]]); line([4, 13], [9, 13], [10.5, 16], [13.5, 16], [15, 13], [20, 13]); break
    case 'refresh': line([19, 9], [19, 4], [14, 4]); ctx.beginPath(); ctx.arc(12, 12, 7, -0.5, Math.PI * 1.15); ctx.stroke(); line([5, 15], [5, 20], [10, 20]); break
    case 'logout': line([10, 5], [5, 5], [5, 19], [10, 19]); line([9, 12], [20, 12]); line([16, 8], [20, 12], [16, 16]); break
  }
}


/** Canvases made per factory, by `name|size|colour|weight`; the oldest go past `CACHE_MAX` (a node keeps its own). */
const caches = new WeakMap<CanvasFactory, Map<string, CanvasLike>>()
const CACHE_MAX = 512

/**
 * `name` as a line icon on a square canvas from `createCanvas`, for an `image` node's `src`: drawn at 2× (`size · 2`
 * canvas px, so it stays crisp at DPR 2) on a 24-unit grid, strokes `weight · size` wide with round caps and joins, in
 * `rgba`. The Apple mark is filled with it; the Google G keeps its four brand colours. Cached: the same arguments
 * (and factory) return the same canvas, which must not be drawn on.
 */
export function iconCanvas(name: IconName, size: number, rgba: RGBA, weight: number, createCanvas: CanvasFactory): CanvasLike {
  let cache = caches.get(createCanvas)
  if (!cache) caches.set(createCanvas, cache = new Map())
  const color = css(rgba), key = `${name}|${size}|${color}|${weight}`
  const hit = cache.get(key)
  if (hit) return hit
  const px = Math.max(1, Math.ceil(size * 2))
  const cv = createCanvas(px, px), ctx = ctx2d(cv)
  ctx.scale(px / 24, px / 24)
  draw(ctx, name, color, weight * 24)
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
  cache.set(key, cv)
  return cv
}

/** Knob canvases made per factory, by `size|disc|stretch` (a theme's metrics make a handful). */
const knobs = new WeakMap<CanvasFactory, Map<string, CanvasLike>>()

/**
 * The switch knob (spec §5: a flat decal riding on the switch's top face, not geometry): a white disc with a soft
 * drop shadow, centred on a square canvas `sizePx` across at 2×; the disc is `discPx` across. `stretchPx` widens the
 * canvas and the disc by that much, the disc into a capsule as tall (the Switch's press stretch: an image stretched
 * to the wider rect would draw an ellipse). Cached as `iconCanvas` is: the same arguments (and factory) return the
 * same canvas, which must not be drawn on.
 */
export function knobCanvas(sizePx: number, discPx: number, createCanvas: CanvasFactory, stretchPx = 0): CanvasLike {
  let cache = knobs.get(createCanvas)
  if (!cache) knobs.set(createCanvas, cache = new Map())
  const key = `${sizePx}|${discPx}|${stretchPx}`
  const hit = cache.get(key)
  if (hit) return hit
  const h = Math.max(1, Math.ceil(sizePx * 2)), k = h / sizePx, w = Math.max(1, Math.ceil((sizePx + stretchPx) * 2))
  const cv = createCanvas(w, h), ctx = ctx2d(cv)
  ctx.shadowColor = 'rgba(30, 30, 60, 0.28)'
  ctx.shadowBlur = 5 * k
  ctx.shadowOffsetY = 1.5 * k
  ctx.fillStyle = '#ffffff'
  const d = discPx * k, across = (discPx + stretchPx) * k
  ctx.beginPath(); ctx.roundRect((w - across) / 2, (h - d) / 2, across, d, d / 2); ctx.fill()
  cache.set(key, cv)
  return cv
}
