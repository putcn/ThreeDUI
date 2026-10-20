import type { ArcSlot } from './arc'

/** A row-major spherical grid whose cells are centred using their column widths and row heights. */
export function gridSlots(sizes: readonly { width: number; height: number }[], columns: number, radius: number, gap: number): ArcSlot[] {
  if (!sizes.length) return []
  columns = Math.min(columns, sizes.length)
  const rows = Math.ceil(sizes.length / columns)
  const cw = Array.from({ length: columns }, (_, c) => Math.max(0, ...sizes.filter((_, i) => i % columns === c).map(s => s.width)))
  const rh = Array.from({ length: rows }, (_, r) => Math.max(0, ...sizes.slice(r * columns, r * columns + columns).map(s => s.height)))
  const W = cw.reduce((a, b) => a + b, 0) + gap * (columns - 1), H = rh.reduce((a, b) => a + b, 0) + gap * (rows - 1)
  const xs = cw.map((w, c) => -W / 2 + cw.slice(0, c).reduce((a, b) => a + b + gap, 0) + w / 2)
  const ys = rh.map((h, r) => H / 2 - rh.slice(0, r).reduce((a, b) => a + b + gap, 0) - h / 2)
  return sizes.map((_, i) => {
    const theta = xs[i % columns]! / radius, phi = ys[Math.floor(i / columns)]! / radius
    const position: [number, number, number] = [radius * Math.sin(theta) * Math.cos(phi), radius * Math.sin(phi), radius - radius * Math.cos(theta) * Math.cos(phi)]
    const sb = Math.sin(-theta), cb = Math.cos(-theta), sa = Math.sin(phi), ca = Math.cos(phi)
    const rotation: [number, number, number] = [Math.atan2(sa, cb * ca), Math.asin(Math.max(-1, Math.min(1, sb * ca))), Math.atan2(-sb * sa, cb)].map(v => Object.is(v, -0) ? 0 : v) as [number, number, number]
    return { position, rotation }
  })
}
