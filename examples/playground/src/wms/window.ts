import { Matrix4, Vector2, Vector3, type Object3D } from 'three'
import type { Node } from 'three/webgpu'
import { abs, float, Fn, length, max, min, positionWorld, uniform, vec2, vec4 } from 'three/tsl'

const vec2Uniform = (v: Vector2) => uniform(v)
/** A vec2 uniform node (its `value` the Vector2). */
export type Vec2Uniform = ReturnType<typeof vec2Uniform>

/**
 * The network map's window (map.ts): its 3D content is drawn only where the line of sight from the camera through a
 * fragment meets the plate inside the box's rounded rectangle, so a zoomed or panned map never spills over the Block.
 * `mask` is the TSL test (each material's `maskNode`); `onPlate` its JS twin, for picking and decluttering: they must
 * agree, so they live here side by side.
 *
 * The plate's frame is `group`'s (its origin the box centre on the glass, x right, y up, z out, pt). The camera there,
 * and world → that frame, are uniforms updated as each render starts (`onRenderUpdate`: the group's matrixWorld is
 * current by then); `eye` keeps the camera for the JS side (straight ahead, 1600 pt out, until a render says).
 */
export interface MapWindow {
  /** TSL: true where the fragment shows through the window (a material's `maskNode`). */
  readonly mask: Node
  /** The box's half size (pt; a uniform the plate's vignette reads too). */
  readonly half: Vec2Uniform
  /** The camera in the plate's frame, as of the last render. */
  readonly eye: Vector3
  /** The box (pt) and the corner radius. */
  setBox(width: number, height: number): void
  /**
   * Where the plate-frame point `p` shows on the plate (the line of sight from `eye` through it), written into `out`
   * (default: a new pair), or null outside the window.
   */
  onPlate(p: Vector3, out?: [number, number]): [number, number] | null
}

/** The window of `group`'s box, its corners rounded `radius` pt. */
export function createWindow(group: Object3D, radius: number): MapWindow {
  const plateFrame = new Matrix4(), eyeFrame = new Matrix4(), eye = new Vector3(0, 0, 1600)
  const toPlate = uniform(new Matrix4()).onRenderUpdate(() => plateFrame.copy(group.matrixWorld).invert())
  // each computes its own: no order between them
  const eyeU = uniform(new Vector3()).onRenderUpdate(({ camera }) => {
    if (camera) eye.setFromMatrixPosition(camera.matrixWorld).applyMatrix4(eyeFrame.copy(group.matrixWorld).invert())
    return eye
  })
  const half = vec2Uniform(new Vector2(1, 1)), r = uniform(radius)
  const mask = Fn(() => {
    const p = toPlate.mul(vec4(positionWorld, 1)).xyz
    const t = eyeU.z.div(max(eyeU.z.sub(p.z), float(1e-3)))
    const q = eyeU.xy.add(p.xy.sub(eyeU.xy).mul(t))
    const d = vec2(abs(q).sub(half.sub(r)))
    return length(max(d, vec2(0, 0))).add(min(max(d.x, d.y), float(0))).sub(r).lessThanEqual(0)
  })()
  let corner = radius
  return {
    mask, half, eye,
    setBox(width, height) {
      half.value.set(width / 2, height / 2)
      corner = Math.min(radius, width / 2, height / 2); r.value = corner
    },
    onPlate(p, out) {
      const t = eye.z / Math.max(eye.z - p.z, 1e-3), x = eye.x + (p.x - eye.x) * t, y = eye.y + (p.y - eye.y) * t
      const dx = Math.abs(x) - (half.value.x - corner), dy = Math.abs(y) - (half.value.y - corner)
      if (Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - corner > 0) return null
      if (!out) return [x, y]
      out[0] = x; out[1] = y
      return out
    },
  }
}
