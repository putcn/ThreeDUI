// SPIKE: temporary Canvas2D text, icons and flat shapes → texture quads
// (the real text engine and panel renderer come in Phase 1/2).

import { CanvasTexture, SRGBColorSpace, LinearFilter, Mesh, PlaneGeometry, AdditiveBlending } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'

export const PX_PER_UNIT = 512
const FONT = '-apple-system, "SF Pro Text", "SF Pro Display", "PingFang SC", system-ui, sans-serif'

function quad(cv: HTMLCanvasElement) {
  const tex = new CanvasTexture(cv)
  tex.colorSpace = SRGBColorSpace
  tex.minFilter = LinearFilter
  tex.generateMipmaps = false
  const mat = new MeshBasicNodeMaterial({ map: tex, transparent: true, depthWrite: false })
  const m = new Mesh(new PlaneGeometry(cv.width / PX_PER_UNIT, cv.height / PX_PER_UNIT), mat)
  m.renderOrder = 10
  return m
}

export function label(text: string, opts: { size?: number; weight?: number; color?: string; align?: 'left' | 'center' } = {}) {
  const size = opts.size ?? 0.14, weight = opts.weight ?? 600
  const fontPx = size * PX_PER_UNIT
  const cv = document.createElement('canvas')
  const ctx = cv.getContext('2d')!
  const font = `${weight} ${fontPx}px ${FONT}`
  ctx.font = font
  const w = Math.ceil(ctx.measureText(text).width + fontPx * 0.2)
  const h = Math.ceil(fontPx * 1.3)
  cv.width = w; cv.height = h
  ctx.font = font
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillStyle = opts.color ?? '#1c1c22'
  ctx.fillText(text, w / 2, h / 2)
  const m = quad(cv)
  if (opts.align === 'left') m.geometry.translate(m.geometry.parameters.width / 2, 0, 0)
  return m
}

export type IconName = 'check' | 'arrow-right' | 'arrow-left' | 'search' | 'plus' | 'menu' | 'x' | 'chevron-right' | 'user' | 'mail' | 'lock' | 'eye' | 'apple' | 'google'

export function icon(name: IconName, size: number, color = '#1c1c22', stroke = 0.12) {
  const px = Math.ceil(size * PX_PER_UNIT)
  const cv = document.createElement('canvas')
  cv.width = px; cv.height = px
  const ctx = cv.getContext('2d')!
  ctx.strokeStyle = color
  ctx.lineWidth = stroke * px
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  const P = (x: number, y: number) => [x * px, y * px] as const
  const line = (pts: [number, number][]) => { ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(...P(...p)) : ctx.moveTo(...P(...p))); ctx.stroke() }
  switch (name) {
    case 'check': line([[0.24, 0.52], [0.42, 0.70], [0.76, 0.32]]); break
    case 'arrow-right': line([[0.24, 0.5], [0.74, 0.5]]); line([[0.54, 0.3], [0.74, 0.5], [0.54, 0.7]]); break
    case 'arrow-left': line([[0.76, 0.5], [0.26, 0.5]]); line([[0.46, 0.3], [0.26, 0.5], [0.46, 0.7]]); break
    case 'chevron-right': line([[0.38, 0.28], [0.62, 0.5], [0.38, 0.72]]); break
    case 'search': ctx.beginPath(); ctx.arc(0.44 * px, 0.44 * px, 0.2 * px, 0, Math.PI * 2); ctx.stroke(); line([[0.6, 0.6], [0.78, 0.78]]); break
    case 'plus': line([[0.5, 0.25], [0.5, 0.75]]); line([[0.25, 0.5], [0.75, 0.5]]); break
    case 'menu': line([[0.26, 0.36], [0.74, 0.36]]); line([[0.26, 0.5], [0.74, 0.5]]); line([[0.26, 0.64], [0.74, 0.64]]); break
    case 'x': line([[0.3, 0.3], [0.7, 0.7]]); line([[0.7, 0.3], [0.3, 0.7]]); break
    case 'user': ctx.beginPath(); ctx.arc(0.5 * px, 0.36 * px, 0.14 * px, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath(); ctx.arc(0.5 * px, 0.86 * px, 0.3 * px, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke(); break
    case 'mail': ctx.beginPath(); ctx.roundRect(0.2 * px, 0.28 * px, 0.6 * px, 0.44 * px, 0.06 * px); ctx.stroke(); line([[0.22, 0.32], [0.5, 0.54], [0.78, 0.32]]); break
    case 'lock': ctx.beginPath(); ctx.roundRect(0.26 * px, 0.46 * px, 0.48 * px, 0.36 * px, 0.06 * px); ctx.stroke(); ctx.beginPath(); ctx.arc(0.5 * px, 0.42 * px, 0.16 * px, Math.PI, 0); ctx.stroke(); break
    case 'eye': ctx.beginPath(); ctx.moveTo(0.2 * px, 0.5 * px); ctx.quadraticCurveTo(0.5 * px, 0.15 * px, 0.8 * px, 0.5 * px); ctx.quadraticCurveTo(0.5 * px, 0.85 * px, 0.2 * px, 0.5 * px); ctx.stroke(); ctx.beginPath(); ctx.arc(0.5 * px, 0.5 * px, 0.1 * px, 0, Math.PI * 2); ctx.stroke(); break
    case 'apple': {
      // Apple mark outline (24×24 viewBox), scaled to fit
      const path = new Path2D('M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701')
      ctx.save()
      ctx.translate(px * 0.1, px * 0.08)
      ctx.scale(px * 0.8 / 24, px * 0.8 / 24)
      ctx.fillStyle = color
      ctx.fill(path)
      ctx.restore()
      break
    }
    case 'google': {
      const cx = 0.5 * px, cy = 0.5 * px, r = 0.3 * px
      ctx.lineWidth = 0.17 * px
      ctx.lineCap = 'butt'
      const seg = (a0: number, a1: number, c: string) => { ctx.strokeStyle = c; ctx.beginPath(); ctx.arc(cx, cy, r, a0 * Math.PI / 180, a1 * Math.PI / 180); ctx.stroke() }
      seg(0, 52, '#4285F4'); seg(50, 142, '#34A853'); seg(140, 232, '#FBBC05'); seg(230, 318, '#EA4335')
      ctx.fillStyle = '#4285F4'
      ctx.fillRect(cx, cy - 0.085 * px, r + 0.085 * px, 0.17 * px)
      break
    }
  }
  return quad(cv)
}

/** flat rounded rectangle (units), optional soft drop shadow and 1px highlight edge */
export function roundedRect(w: number, h: number, r: number, fill: string, opts: { shadow?: number; edge?: string; alpha?: number } = {}) {
  const pad = (opts.shadow ?? 0) * 3
  const W = Math.ceil((w + pad * 2) * PX_PER_UNIT), H = Math.ceil((h + pad * 2) * PX_PER_UNIT)
  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const ctx = cv.getContext('2d')!
  const x = pad * PX_PER_UNIT, y = pad * PX_PER_UNIT, ww = w * PX_PER_UNIT, hh = h * PX_PER_UNIT, rr = Math.min(r * PX_PER_UNIT, ww / 2, hh / 2)
  if (opts.shadow) {
    ctx.shadowColor = 'rgba(30,30,60,0.22)'
    ctx.shadowBlur = opts.shadow * PX_PER_UNIT * 2
    ctx.shadowOffsetY = opts.shadow * PX_PER_UNIT * 0.8
  }
  ctx.globalAlpha = opts.alpha ?? 1
  ctx.fillStyle = fill
  ctx.beginPath(); ctx.roundRect(x, y, ww, hh, rr); ctx.fill()
  ctx.shadowColor = 'transparent'
  if (opts.edge) {
    ctx.strokeStyle = opts.edge
    ctx.lineWidth = 2
    ctx.beginPath(); ctx.roundRect(x + 1, y + 1, ww - 2, hh - 2, rr); ctx.stroke()
  }
  return quad(cv)
}

export function circle(d: number, fill: string, opts: { shadow?: number; edge?: string; alpha?: number } = {}) {
  return roundedRect(d, d, d / 2, fill, opts)
}

/** additive light pool under a glass element (transmitted light / caustic) */
export function glow(w: number, h: number, color: string, alpha = 0.3) {
  const W = Math.ceil(w * PX_PER_UNIT), H = Math.ceil(h * PX_PER_UNIT)
  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const ctx = cv.getContext('2d')!
  const g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) / 2)
  g.addColorStop(0, color)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.globalAlpha = alpha
  ctx.fillStyle = g
  ctx.save(); ctx.scale(1, H / Math.max(W, H)); ctx.translate(0, (Math.max(W, H) - H) / 2 * (Math.max(W, H) / H))
  ctx.fillRect(0, 0, W, Math.max(W, H)); ctx.restore()
  const tex = new CanvasTexture(cv)
  tex.colorSpace = SRGBColorSpace
  tex.minFilter = LinearFilter
  tex.generateMipmaps = false
  const mat = new MeshBasicNodeMaterial({ map: tex, transparent: true, depthWrite: false, blending: AdditiveBlending })
  const m = new Mesh(new PlaneGeometry(w, h), mat)
  m.renderOrder = 0.5
  return m
}

/** rim decal: thin bright outline + brighter lower band (light caught by the bottom round-over) */
export function rimDecal(w: number, h: number, r: number, strength = 1) {
  const W = Math.ceil(w * PX_PER_UNIT), H = Math.ceil(h * PX_PER_UNIT)
  const cv = document.createElement('canvas')
  cv.width = W; cv.height = H
  const ctx = cv.getContext('2d')!
  const rr = Math.min(r * PX_PER_UNIT, W / 2, H / 2)
  // lower band: clipped to the shape, vertical gradient
  ctx.save()
  ctx.beginPath(); ctx.roundRect(1, 1, W - 2, H - 2, rr); ctx.clip()
  const g = ctx.createLinearGradient(0, H * 0.55, 0, H)
  g.addColorStop(0, 'rgba(255,255,255,0)')
  g.addColorStop(0.85, `rgba(255,255,255,${0.10 * strength})`)
  g.addColorStop(1, `rgba(255,255,255,${0.42 * strength})`)
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
  const gt = ctx.createLinearGradient(0, 0, 0, H * 0.35)
  gt.addColorStop(0, `rgba(255,255,255,${0.22 * strength})`)
  gt.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = gt; ctx.fillRect(0, 0, W, H)
  ctx.restore()
  // outline
  ctx.strokeStyle = `rgba(255,255,255,${0.75 * strength})`
  ctx.lineWidth = 2.5
  ctx.beginPath(); ctx.roundRect(1.5, 1.5, W - 3, H - 3, rr); ctx.stroke()
  const tex = new CanvasTexture(cv)
  tex.colorSpace = SRGBColorSpace
  tex.minFilter = LinearFilter
  tex.generateMipmaps = false
  const mat = new MeshBasicNodeMaterial({ map: tex, transparent: true, depthWrite: false })
  const m = new Mesh(new PlaneGeometry(w, h), mat)
  m.renderOrder = 9
  return m
}
