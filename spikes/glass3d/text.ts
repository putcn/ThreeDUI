// SPIKE: temporary Canvas2D text & icon → texture quads (real text engine comes in Phase 1).

import { CanvasTexture, SRGBColorSpace, LinearFilter, Mesh, PlaneGeometry } from 'three'
import { MeshBasicNodeMaterial } from 'three/webgpu'

const PX_PER_UNIT = 512
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

export type IconName = 'check' | 'arrow-right' | 'arrow-left' | 'search' | 'plus' | 'menu' | 'x' | 'chevron-right'

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
  }
  return quad(cv)
}
