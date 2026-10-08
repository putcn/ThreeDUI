import { Node } from './node'

/** A Surface's data (spec §3.2): sizes in pt; the render package wraps it in an `Object3D`. */
export interface SurfaceModel { id: string; root: Node; width: number; height: number; ptPerUnit: number; placement: 'screen' | 'world'; background: 'none' | 'glass' | string; cornerRadius: number }

let n = 0

/** A Surface with a `box` root (`${id}-root`) sized to `width × height`. */
export function createSurface(opts: Partial<Omit<SurfaceModel, 'root'>> & { width: number; height: number }): SurfaceModel {
  const id = opts.id ?? `surface-${++n}`
  const root = new Node('box', `${id}-root`)
  root.setStyle({ width: opts.width, height: opts.height })
  return { id, root, width: opts.width, height: opts.height, ptPerUnit: opts.ptPerUnit ?? 244, placement: opts.placement ?? 'screen', background: opts.background ?? 'none', cornerRadius: opts.cornerRadius ?? 0 }
}
