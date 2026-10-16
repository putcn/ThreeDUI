/** Where a Block stands on the Space's arc: its position (world units) and rotation (radians, XYZ). */
export interface ArcSlot { position: [number, number, number]; rotation: [number, number, number] }

/**
 * Spatial spec §3.1: slot i on the arc about C = (0, 0, radius); the first at the origin facing +z, then rightwards.
 * Each next Block turns on by (w[i-1] / 2 + gap + w[i] / 2) / radius, and faces the centre (rotation −θ about y).
 * `widths` in world units.
 */
export function arcSlots(widths: readonly number[], radius: number, gap: number): ArcSlot[] {
  const out: ArcSlot[] = []; let theta = 0
  widths.forEach((w, i) => {
    if (i > 0) theta += (widths[i - 1]! / 2 + gap + w / 2) / radius
    out.push({ position: [radius * Math.sin(theta), 0, radius - radius * Math.cos(theta)], rotation: [0, -theta, 0] })
  })
  return out
}
