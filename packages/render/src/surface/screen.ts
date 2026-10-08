import { Group, Quaternion, Vector3, type OrthographicCamera, type PerspectiveCamera } from 'three'
import { GlassUIError } from '@glassui/core'
import type { Surface } from './surface'

/** Where a screen Surface sits: filling the viewport, or with its (scaled) top-left at CSS px `left, top`. */
export type ScreenPlacement = { fill: true } | { left: number; top: number }

/**
 * World units per CSS px on a plane `distance` in front of `camera` (spec §3.1: the screen layer is pt = px).
 * Perspective: `2·distance·tan(fov/2) / zoom / height`; orthographic: `(top − bottom) / zoom / height` (any distance).
 */
export function screenUnitsPerPx(camera: PerspectiveCamera | OrthographicCamera, viewportHeightPx: number, distance: number): number {
  if ((camera as PerspectiveCamera).isPerspectiveCamera) {
    const p = camera as PerspectiveCamera
    return 2 * distance * Math.tan((p.fov * Math.PI) / 360) / p.zoom / viewportHeightPx
  }
  // Orthographic: u does not shrink with distance, so on a ScreenLayer (at `near · distanceFactor`, 4) only ≈ 3·near/u px
  // of rise fit before the near plane clips raised glass (≈ 30 px at near 0.1, a 6-unit frustum, 600 px); near ≤ 0 puts
  // the layer at or behind the camera. Perspective cameras are the supported path in this phase.
  const o = camera as OrthographicCamera
  return (o.top - o.bottom) / o.zoom / viewportHeightPx
}

const fwd = new Vector3(), pos = new Vector3(), q = new Quaternion()

/**
 * A camera-facing group `camera.near · distanceFactor` in front of the camera, scaled so 1 unit = 1 CSS px; its
 * children are Surfaces with `ptPerUnit = 1`, laid out in CSS px about the viewport centre (y up). Each Surface's
 * CONTENT plane (z = `contentPlaneZ`, lifted by a glass background) is the px-exact plane: it lies on the layer's z = 0.
 * `update` writes the camera's world pose into the group's own position/quaternion, so the group's parent must be
 * untransformed (a scene).
 *
 * Perspective cameras are the supported path in this phase: their rise budget before the near plane,
 * `(distanceFactor − 1)/distanceFactor · h·zoom / (2·tan(fov/2))` px, does not depend on `near` (≈ 480 px at fov 50,
 * 600 px). With an orthographic camera only ≈ `3·near/u` px fit before the near plane clips raised glass (≈ 30 px at
 * near 0.1, a 6-unit frustum, 600 px), and `near ≤ 0` puts the layer at or behind the camera.
 */
export class ScreenLayer extends Group {
  /** The layer's distance in front of the camera, in multiples of `camera.near`. */
  distanceFactor = 4
  /** CSS px, ≥ 1 each (the last `update`'s). */
  viewport = { width: 1, height: 1 }
  readonly surfaces = new Set<Surface>()
  private readonly placements = new Map<Surface, ScreenPlacement>()

  constructor() { super(); this.name = 'ui-screen' }

  /** Adds `surface` to the layer (if it is not a child yet) and places it now and on every `update`. */
  place(surface: Surface, at: ScreenPlacement): void {
    const ppu = surface.model.ptPerUnit
    if (ppu !== 1) throw new GlassUIError('ScreenLayer.place', `屏幕层 Surface 的 ptPerUnit 必须为 1（1 pt = 1 CSS px），实际为 ${ppu}`)
    this.surfaces.add(surface); this.placements.set(surface, at)
    if (surface.parent !== this) this.add(surface)
    this.apply(surface, at)
  }

  /** Stops placing `surface` (it stays a child until removed or disposed). */
  unplace(surface: Surface): void { this.surfaces.delete(surface); this.placements.delete(surface) }

  /**
   * `fill` sizes the Surface to the viewport (expects scale 1); `{left, top}` uses its scaled size. Both sink the Surface
   * by its scaled `contentPlaneZ` so its content plane sits on the layer plane (after `setSize`: the slab follows size).
   */
  private apply(s: Surface, at: ScreenPlacement): void {
    const { width: vw, height: vh } = this.viewport
    if ('fill' in at) {
      if (s.model.width !== vw || s.model.height !== vh) s.setSize(vw, vh)
      s.position.set(0, 0, 0 - s.contentPlaneZ * s.scale.z)   // `0 −`: +0, not −0, without a glass background
      return
    }
    const w = s.model.width * s.scale.x, h = s.model.height * s.scale.y
    s.position.set(at.left + w / 2 - vw / 2, vh / 2 - (at.top + h / 2), 0 - s.contentPlaneZ * s.scale.z)
  }

  /**
   * Follows `camera` (viewport in CSS px, clamped to ≥ 1), re-applies every placement and updates the world matrices,
   * so same-tick readers of a screen Surface's `matrixWorld` (the shadow fit) see this pose.
   */
  update(camera: PerspectiveCamera | OrthographicCamera, viewport: { width: number; height: number }): void {
    this.viewport = { width: Math.max(1, viewport.width), height: Math.max(1, viewport.height) }
    camera.updateMatrixWorld()
    const distance = camera.near * this.distanceFactor
    camera.getWorldDirection(fwd); camera.getWorldPosition(pos); camera.getWorldQuaternion(q)
    this.position.copy(pos).addScaledVector(fwd, distance)
    this.quaternion.copy(q)
    this.scale.setScalar(screenUnitsPerPx(camera, this.viewport.height, distance))
    for (const [s, at] of this.placements) this.apply(s, at)
    this.updateMatrixWorld()
  }
}
