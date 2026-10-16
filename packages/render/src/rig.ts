import { Euler, MathUtils, Matrix4, Quaternion, Vector3, type PerspectiveCamera } from 'three'
import { GlassUIError, Spring, springFromResponse } from '@glassui/core'
import type { BridgeEvent, CanvasLike } from './pointer'
import type { Surface } from './surface/surface'

/** `UIRoot.createCameraRig` options (spatial spec §2.2). Out of range (or not a finite number): a readable `GlassUIError`. */
export interface CameraRigOptions {
  /** Seconds (> 0): the period of the camera's springs, position and orientation, critically damped. Default 0.8. */
  response?: number
  /** ≥ 0: the empty band the fit leaves around the Surface on each side, as a fraction of its size. Default 0.08. */
  margin?: number
  /** Degrees (≥ 0): the most the pointer turns the camera about the target's centre, in yaw and in pitch each. Default 2.5. */
  parallax?: number
  /** Seconds (> 0): the period of the pointer's smoothing springs, critically damped. Default 0.4. */
  parallaxResponse?: number
}

/** What a rig drives and reads; the root hands it its camera, its canvas, its viewport's aspect and the reduced-motion flag. */
export interface RigEnvironment {
  /** Written every `update` while there is a target: position, quaternion, then `updateMatrixWorld`. */
  camera: PerspectiveCamera
  /** Where the pointer is read (`pointermove`, `pointerleave`) until `dispose`. */
  canvas: CanvasLike
  /** Viewport width / height, read every `update`. */
  aspect: () => number
  /** Read at every `focus` and `update`: true puts the camera on its goal at once and holds the parallax at 0. */
  reducedMotion: () => boolean
}

const DEFAULTS = { response: 0.8, margin: 0.08, parallax: 2.5, parallaxResponse: 0.4 } as const
/** Each option's lower bound (`> 0` or `≥ 0`) and unit, for the error. */
const LIMITS = [['response', true, '秒'], ['parallaxResponse', true, '秒'], ['margin', false, '每边占 Surface 尺寸的比例'], ['parallax', false, '度']] as const

/** Throws a readable `GlassUIError` (scope `CameraRig.<option>`) unless every option given is a finite number in range. */
function checkOptions(o: CameraRigOptions): void {
  for (const [k, positive, unit] of LIMITS) {
    const v: unknown = o[k]
    if (v === undefined) continue
    if (!(typeof v === 'number' && Number.isFinite(v) && (positive ? v > 0 : v >= 0))) {
      throw new GlassUIError(`CameraRig.${k}`, `必须是${positive ? '大于' : '不小于'} 0 的有限数（${unit}），收到 ${String(v)}`)
    }
  }
}

/**
 * The distance at which a `width × height` rect, square to the view axis, fits a camera of vertical fov `fovDeg` and
 * viewport `aspect` with `margin` (a fraction of its size) to spare on each side: the larger of what its height needs
 * against the vertical fov and what its width needs against the horizontal one,
 * `max(h(1 + 2m) / 2 / tan(fov/2), w(1 + 2m) / 2 / (tan(fov/2) · aspect))`.
 */
export function fitDistance(width: number, height: number, fovDeg: number, aspect: number, margin: number): number {
  const t = Math.tan(MathUtils.degToRad(fovDeg) / 2), k = 1 + 2 * margin
  return Math.max(height * k / 2 / t, width * k / 2 / (t * aspect))
}

const local = new Matrix4(), world = new Matrix4(), p = new Vector3(), q = new Quaternion(), s = new Vector3(), e = new Euler(), normal = new Vector3()

/**
 * Where `target` comes to rest, in world space: its `restPose` composed under its parent's world matrix (brought up to
 * date first; identity without a parent). Writes its content-plane centre (`(0, 0, contentPlaneZ)` in that frame) into
 * `centre` and its world orientation into `quaternion`; returns the fit distance (`fitDistance`) for its world size
 * (`width / ptPerUnit × scale.x` by `height / ptPerUnit × scale.y`).
 */
function restFrame(target: Surface, fovDeg: number, aspect: number, margin: number, centre: Vector3, quaternion: Quaternion): number {
  const rest = target.restPose
  local.compose(p.fromArray(rest.position), q.setFromEuler(e.set(...rest.rotation, 'XYZ')), s.fromArray(rest.scale))
  const parent = target.parent
  if (parent) { parent.updateWorldMatrix(true, false); world.multiplyMatrices(parent.matrixWorld, local) } else world.copy(local)
  world.decompose(p, quaternion, s)
  centre.set(0, 0, target.contentPlaneZ).applyMatrix4(world)
  const { width, height, ptPerUnit } = target.model
  return fitDistance(width / ptPerUnit * Math.abs(s.x), height / ptPerUnit * Math.abs(s.y), fovDeg, aspect, margin)
}

/**
 * The camera pose that faces `target` square-on (spatial spec §2.2), written into `out`: the orientation of its rest
 * pose in world space (the camera's −z into the Surface's front), and the position its content-plane centre plus its
 * normal (`(0, 0, 1)` turned by that orientation) times `fitDistance` for its world size — so the Surface with
 * `margin` on each side just fits the view. It aims where the Surface ends up (`Surface.restPose`), not where it is
 * on the way.
 */
export function focusPose(target: Surface, fovDeg: number, aspect: number, margin: number, out: { position: Vector3; quaternion: Quaternion }): void {
  const d = restFrame(target, fovDeg, aspect, margin, out.position, out.quaternion)
  out.position.addScaledVector(normal.set(0, 0, 1).applyQuaternion(out.quaternion), d)
}

/** A client coordinate as a position in [−1, 1] across `[start, start + size]`; 0 when it is not a finite number (or the size is 0). */
function unit(v: number | undefined, start: number, size: number): number {
  const t = ((v ?? NaN) - start) / size * 2 - 1
  return Number.isFinite(t) ? Math.max(-1, Math.min(1, t)) : 0
}

const orbitEuler = new Euler()

/**
 * Drives the camera to face one Surface at a time (spatial spec §2.2); `UIRoot.createCameraRig` makes it, the root's
 * `tick` calls `update` (before the screen layer and the lights follow the camera), `dispose` lets go.
 *
 * Each `update` with a target: the goal is the target's `focusPose` for the current aspect and the camera's (effective,
 * zoomed) fov — recomputed every tick, so a resize refits and a Surface still flying in is aimed at where it lands —
 * turned about the target's centre by the smoothed pointer: yaw `px × parallax` about the target's up axis, pitch
 * `−py × parallax` about its right one (the camera keeps looking at the centre). The camera follows on three critically
 * damped position springs (`response`; no overshoot) and an orientation that slerps from its quaternion at the last
 * `focus` to the goal's, by a critically damped progress spring 0 → 1. Then `camera.updateMatrixWorld()`. The camera's
 * parent, if it has one, must be untransformed: the rig writes world poses into `position` and `quaternion`.
 *
 * Pointer: a `pointermove` from a mouse or pen aims the parallax at its position on the canvas ([−1, 1] each way, y up);
 * any other move (touch has no hover) and `pointerleave` aim it back at (0, 0). The smoothed value follows on
 * critically damped springs (`parallaxResponse`). `parallax = false` or reduced motion hold it at 0 (it jumps there).
 *
 * `focus` resolves `true` when the position and orientation springs settle, `false` when a later `focus` or `dispose`
 * cuts it short or its target goes away (disposed or failed: the rig drops it and leaves the camera where it is).
 * `immediate`, or reduced motion, puts the camera on the goal at the next `update` (and resolves then).
 */
export class CameraRig {
  /** Pointer parallax (default true); false holds the camera on the plain focus pose. */
  parallax = true
  private readonly env: RigEnvironment
  private readonly margin: number
  /** Radians: the `parallax` option, converted once. */
  private readonly amplitude: number
  /** The camera's world position, one spring per axis. */
  private readonly pos: readonly [Spring, Spring, Spring]
  /** The orientation's slerp progress, 0 → 1, from `from` to the goal's quaternion. */
  private readonly turn: Spring
  private readonly from = new Quaternion()
  /** Where the pointer aims the parallax ([−1, 1], y up), and its smoothed value. */
  private readonly aim = { x: 0, y: 0 }
  private readonly px: Spring
  private readonly py: Spring
  private current: Surface | null = null
  /** The pending `focus` promise's resolver. */
  private settle: ((ok: boolean) => void) | null = null
  /** The next `update` puts the camera on its goal (`immediate`, or reduced motion at `focus`). */
  private snap = false
  private isDisposed = false
  private readonly centre = new Vector3()
  private readonly goal = { position: new Vector3(), quaternion: new Quaternion() }
  private readonly orbit = new Quaternion()

  /** Reads `opts` (a readable `GlassUIError` for one out of range), then listens on the canvas. */
  constructor(env: RigEnvironment, opts: CameraRigOptions = {}) {
    checkOptions(opts)
    this.env = env
    this.margin = opts.margin ?? DEFAULTS.margin
    this.amplitude = MathUtils.degToRad(opts.parallax ?? DEFAULTS.parallax)
    const follow = springFromResponse(opts.response ?? DEFAULTS.response, 1), smooth = springFromResponse(opts.parallaxResponse ?? DEFAULTS.parallaxResponse, 1)
    const at = env.camera.position
    this.pos = [new Spring(at.x, follow), new Spring(at.y, follow), new Spring(at.z, follow)]
    this.turn = new Spring(1, follow)
    this.px = new Spring(0, smooth); this.py = new Spring(0, smooth)
    env.canvas.addEventListener('pointermove', this.onMove)
    env.canvas.addEventListener('pointerleave', this.onLeave)
  }

  /** The Surface the camera faces (or is on its way to); null before the first `focus`, after its target went away, after `dispose`. */
  get target(): Surface | null { return this.current }
  /** `dispose` has run: the rig no longer writes the camera or listens to the canvas. */
  get disposed(): boolean { return this.isDisposed }

  /**
   * Turns the camera to face `target` (a world Surface; a screen one, which follows the camera, throws a readable
   * `GlassUIError`). Ends the previous focus `false`; the position springs keep their velocity (no jump), the slerp
   * restarts from the camera's current quaternion. Resolves `true` when the camera settles on the goal; `immediate`
   * (or reduced motion now) puts it there at the next `update` and resolves then. `false` at once for a disposed or
   * failed target (the rig then has none) and on a disposed rig.
   */
  focus(target: Surface, opts: { immediate?: boolean } = {}): Promise<boolean> {
    if (this.isDisposed) return Promise.resolve(false)
    if (target.model.placement === 'screen') throw new GlassUIError('CameraRig.focus', '只能对焦世界层 Surface：屏幕层 Surface 跟着相机走')
    this.end(false)
    if (target.disposed || target.error) { this.current = null; return Promise.resolve(false) }
    const cam = this.env.camera
    // driving: the springs carry on from where they put the camera, velocity and all; idle: they start there at rest
    this.pos.forEach((sp, i) => { const v = cam.position.getComponent(i); if (this.current) sp.value = v; else sp.jump(v) })
    this.from.copy(cam.quaternion); this.turn.jump(0); this.turn.set(1)
    this.current = target
    this.snap = opts.immediate === true || this.env.reducedMotion()
    return new Promise<boolean>(resolve => { this.settle = resolve })
  }

  /**
   * One step of `dt` s toward the goal (see the class): the root calls it every `tick`. Does nothing without a target,
   * after `dispose`, or while the aspect is not a positive finite number (a zero-size canvas). A target found disposed
   * or failed is dropped (its focus resolves `false`) and the camera left as it is.
   */
  update(dt: number): void {
    const t = this.current
    if (this.isDisposed || !t) return
    if (t.disposed || t.error) { this.current = null; this.end(false); return }
    const aspect = this.env.aspect()
    if (!(aspect > 0 && aspect < Infinity)) return
    const cam = this.env.camera, reduced = this.env.reducedMotion()
    if (!this.parallax || reduced) { this.px.jump(0); this.py.jump(0) }
    else { this.px.set(this.aim.x); this.py.set(this.aim.y); this.px.step(dt); this.py.step(dt) }
    // the goal: the focus pose turned about the target's centre (yaw about its up axis, then pitch about its right one)
    const d = restFrame(t, cam.getEffectiveFOV(), aspect, this.margin, this.centre, this.goal.quaternion)
    this.goal.quaternion.multiply(this.orbit.setFromEuler(orbitEuler.set(-this.py.value * this.amplitude, this.px.value * this.amplitude, 0, 'YXZ')))
    this.goal.position.set(0, 0, d).applyQuaternion(this.goal.quaternion).add(this.centre)
    const snap = this.snap || reduced
    this.snap = false
    this.pos.forEach((sp, i) => { const v = this.goal.position.getComponent(i); if (snap) sp.jump(v); else { sp.set(v); sp.step(dt) } })
    if (snap) this.turn.jump(1); else this.turn.step(dt)
    cam.position.set(this.pos[0].value, this.pos[1].value, this.pos[2].value)
    const k = this.turn.value
    if (k >= 1) cam.quaternion.copy(this.goal.quaternion); else cam.quaternion.slerpQuaternions(this.from, this.goal.quaternion, Math.max(0, k))
    cam.updateMatrixWorld()
    if (this.turn.done && this.pos.every(sp => sp.done)) this.end(true)
  }

  /** Stops writing the camera (it stays where it is) and listening to the canvas; a pending focus resolves `false`. Idempotent. */
  dispose(): void {
    if (this.isDisposed) return
    this.isDisposed = true
    this.current = null
    this.env.canvas.removeEventListener('pointermove', this.onMove)
    this.env.canvas.removeEventListener('pointerleave', this.onLeave)
    this.end(false)
  }

  /** Resolves the pending focus (if any) with `ok`. */
  private end(ok: boolean): void {
    const settle = this.settle
    this.settle = null
    settle?.(ok)
  }

  /** A mouse or pen aims the parallax at its canvas position; any other pointer (touch: no hover) at the centre. */
  private readonly onMove = (ev: BridgeEvent): void => {
    if (ev.pointerType !== 'mouse' && ev.pointerType !== 'pen') { this.onLeave(); return }
    const r = this.env.canvas.getBoundingClientRect()
    this.aim.x = unit(ev.clientX, r.left, r.width)
    this.aim.y = -unit(ev.clientY, r.top, r.height)
  }

  private readonly onLeave = (): void => { this.aim.x = 0; this.aim.y = 0 }
}
