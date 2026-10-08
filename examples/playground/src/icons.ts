export type IconName = 'check' | 'arrow-right' | 'search' | 'x' | 'user' | 'mail' | 'lock' | 'eye' | 'apple' | 'google'

/** The Apple mark (24 × 24 viewBox). */
const APPLE = 'M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701'

/**
 * A line icon on a square canvas (the drawing of `spikes/glass3d/text.ts` `icon()`), for an `image` node's `src`.
 * Drawn at 2× (`sizePx · 2` canvas px) so it stays crisp at DPR 2; `stroke` is the line width as a fraction of the
 * size. The Apple mark is filled with `color`; the Google G keeps its four brand colours.
 */
export function iconCanvas(name: IconName, sizePx: number, color = '#1c1c22', stroke = 0.12): HTMLCanvasElement {
  const px = Math.max(1, Math.ceil(sizePx * 2))
  const cv = document.createElement('canvas')
  cv.width = px; cv.height = px
  const ctx = cv.getContext('2d')
  if (!ctx) return cv
  ctx.strokeStyle = color
  ctx.lineWidth = stroke * px
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const line = (pts: readonly (readonly [number, number])[]): void => {
    ctx.beginPath()
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x * px, y * px) : ctx.moveTo(x * px, y * px)))
    ctx.stroke()
  }
  const ring = (cx: number, cy: number, r: number, a0 = 0, a1 = Math.PI * 2): void => {
    ctx.beginPath(); ctx.arc(cx * px, cy * px, r * px, a0, a1); ctx.stroke()
  }
  switch (name) {
    case 'check': line([[0.24, 0.52], [0.42, 0.70], [0.76, 0.32]]); break
    case 'arrow-right': line([[0.24, 0.5], [0.74, 0.5]]); line([[0.54, 0.3], [0.74, 0.5], [0.54, 0.7]]); break
    case 'search': ring(0.44, 0.44, 0.2); line([[0.6, 0.6], [0.78, 0.78]]); break
    case 'x': line([[0.3, 0.3], [0.7, 0.7]]); line([[0.7, 0.3], [0.3, 0.7]]); break
    case 'user': ring(0.5, 0.36, 0.14); ring(0.5, 0.86, 0.3, Math.PI * 1.15, Math.PI * 1.85); break
    case 'mail':
      ctx.beginPath(); ctx.roundRect(0.2 * px, 0.28 * px, 0.6 * px, 0.44 * px, 0.06 * px); ctx.stroke()
      line([[0.22, 0.32], [0.5, 0.54], [0.78, 0.32]])
      break
    case 'lock':
      ctx.beginPath(); ctx.roundRect(0.26 * px, 0.46 * px, 0.48 * px, 0.36 * px, 0.06 * px); ctx.stroke()
      ring(0.5, 0.42, 0.16, Math.PI, 0)
      break
    case 'eye':
      ctx.beginPath()
      ctx.moveTo(0.2 * px, 0.5 * px)
      ctx.quadraticCurveTo(0.5 * px, 0.15 * px, 0.8 * px, 0.5 * px)
      ctx.quadraticCurveTo(0.5 * px, 0.85 * px, 0.2 * px, 0.5 * px)
      ctx.stroke()
      ring(0.5, 0.5, 0.1)
      break
    case 'apple': {
      ctx.save()
      ctx.translate(px * 0.1, px * 0.08)
      ctx.scale(px * 0.8 / 24, px * 0.8 / 24)
      ctx.fillStyle = color
      ctx.fill(new Path2D(APPLE))
      ctx.restore()
      break
    }
    case 'google': {
      const cx = 0.5 * px, cy = 0.5 * px, r = 0.3 * px
      ctx.lineWidth = 0.17 * px
      ctx.lineCap = 'butt'
      const seg = (a0: number, a1: number, c: string): void => {
        ctx.strokeStyle = c
        ctx.beginPath(); ctx.arc(cx, cy, r, a0 * Math.PI / 180, a1 * Math.PI / 180); ctx.stroke()
      }
      seg(0, 52, '#4285F4'); seg(50, 142, '#34A853'); seg(140, 232, '#FBBC05'); seg(230, 318, '#EA4335')
      ctx.fillStyle = '#4285F4'
      ctx.fillRect(cx, cy - 0.085 * px, r + 0.085 * px, 0.17 * px)
      break
    }
  }
  return cv
}

/**
 * The switch knob (spec §5: a flat decal riding on the switch's top face, not geometry): a white disc with a soft
 * drop shadow, centred on a square canvas `sizePx` across at 2×; the disc is `discPx` across.
 */
export function knobCanvas(sizePx: number, discPx: number): HTMLCanvasElement {
  const px = Math.max(1, Math.ceil(sizePx * 2)), k = px / sizePx
  const cv = document.createElement('canvas')
  cv.width = px; cv.height = px
  const ctx = cv.getContext('2d')
  if (!ctx) return cv
  ctx.shadowColor = 'rgba(30, 30, 60, 0.28)'
  ctx.shadowBlur = 5 * k
  ctx.shadowOffsetY = 1.5 * k
  ctx.fillStyle = '#ffffff'
  ctx.beginPath(); ctx.arc(px / 2, px / 2, discPx / 2 * k, 0, Math.PI * 2); ctx.fill()
  return cv
}
