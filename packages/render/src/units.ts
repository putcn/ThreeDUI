/** What converting Surface pt to Surface-local world units needs. */
export interface SurfaceDims { width: number; height: number; ptPerUnit: number }

export function ptToUnits(pt: number, ppu: number): number { return pt / ppu }

/** Surface pt (origin top-left, y down) → Surface-local units (origin at the centre, y up, z toward the viewer). */
export function surfaceToLocal(x: number, y: number, s: SurfaceDims): [number, number] {
  return [(x - s.width / 2) / s.ptPerUnit, (s.height / 2 - y) / s.ptPerUnit]
}

export function localToSurface(ux: number, uy: number, s: SurfaceDims): [number, number] {
  return [ux * s.ptPerUnit + s.width / 2, s.height / 2 - uy * s.ptPerUnit]
}
