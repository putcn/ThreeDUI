import { Euler, MathUtils, Matrix4, Quaternion, Vector3, type PerspectiveCamera } from 'three'
import { GlassUIError, Spring, springFromResponse, type SpringConfig } from '@glassui/core'
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
  /** Seconds (> 0): the period of the light pose's springs (`CameraRig.lightPose`), critically damped. Default 1.2. */
  lightResponse?: number
}

/** What a rig drives and reads; the root hands it its camera, its canvas, its viewport's aspect and the reduced-motion flag. */
export interface RigEnvironment {
  /** Written every `update` while there is a target: position, quaternion, then `updateMatrixWorld`. */
  camera: PerspectiveCamera
  /** Where the pointer is read (`pointermove`, `pointerleave`) until `dispose`. */
  canvas: CanvasLike
  /** Viewport width / height, read every `update`. */
  aspect: () => number
  /** Read at every `focus` and `update`: true puts the camera and the light pose on their goal at once and holds the parallax at 0. */
  reducedMotion: () => boolean
}

const DEFAULTS = { response: 0.8, margin: 0.08, parallax: 2.5, parallaxResponse: 0.4, lightResponse: 1.2 } as const
/** Each option's lower bound (`> 0` or `≥ 0`) and unit, for the error. */
const LIMITS = [['response', true, '秒'], ['parallaxResponse', true, '秒'], ['lightResponse', true, '秒'], ['margin', false, '每边占 Surface 尺寸的比例'], ['parallax', false, '度']] as const

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

type Pose = { position: Vector3; quaternion: Quaternion }

/**
 * A pose following a goal pose: three critically damped position springs, and an orientation slerped from its
 * quaternion at the last `retarget` to the goal's by a critically damped progress spring 0 → 1.
 */
class Follower {
  /** Where it is: written by `place` and `step`. */
  readonly pose: Pose = { position: new Vector3(), quaternion: new Quaternion() }
  private readonly pos: readonly [Spring, Spring, Spring]
  /** The slerp's progress, 0 → 1, from `from` to the goal's quaternion. */
  private readonly turn: Spring
  private readonly from = new Quaternion()

  constructor(cfg: SpringConfig) {
    this.pos = [new Spring(0, cfg), new Spring(0, cfg), new Spring(0, cfg)]
    this.turn = new Spring(1, cfg)
  }

  /** Puts it on this pose, at rest. */
  place(position: Vector3, quaternion: Quaternion): void {
    this.pos.forEach((sp, i) => { sp.jump(position.getComponent(i)) })
    this.pose.position.copy(position); this.pose.quaternion.copy(quaternion)
  }

  /** A new goal ahead: the position springs carry on, velocity and all (no jump); the slerp restarts from where it is. */
  retarget(): void { this.from.copy(this.pose.quaternion); this.turn.jump(0); this.turn.set(1) }

  /** One step of `dt` s toward `goal`; `snap` puts it there. */
  step(goal: Pose, snap: boolean, dt: number): void {
    this.pos.forEach((sp, i) => { const v = goal.position.getComponent(i); if (snap) sp.jump(v); else { sp.set(v); sp.step(dt) } })
    if (snap) this.turn.jump(1); else this.turn.step(dt)
    this.pose.position.set(this.pos[0].value, this.pos[1].value, this.pos[2].value)
    const k = this.turn.value
    if (k >= 1) this.pose.quaternion.copy(goal.quaternion); else this.pose.quaternion.slerpQuaternions(this.from, goal.quaternion, Math.max(0, k))
  }

  /** On the goal of the last `step`, at rest. */
  get settled(): boolean { return this.turn.done && this.pos.every(sp => sp.done) }
}

/**
 * Drives the camera to face one Surface at a time (spatial spec §2.2) and holds a light pose anchored in space for the
 * UI lights (§11.1); `UIRoot.createCameraRig` makes it, the root's `tick` calls `update` (before the screen layer
 * follows the camera and the lights take `lightPose`), `dispose` lets go.
 *
 * Each `update` with a target: the goal is the target's `focusPose` for the current aspect and the camera's (effective,
 * zoomed) fov — recomputed every tick, so a resize refits and a Surface still flying in is aimed at where it lands. Two
 * poses follow it, each on three critically damped position springs (no overshoot) and an orientation that slerps from
 * its quaternion at the last `focus` to the goal's by a critically damped progress spring 0 → 1: the camera's plain
 * pose (`response`) and the light pose (`lightResponse`, slower: on a focus change the light lags the camera). The
 * camera is then the plain pose orbited about the target's centre by the smoothed pointer — yaw `px × parallax` about
 * the target's up axis, pitch `−py × parallax` about its right one — so the centre stays where the plain pose has it
 * (in the middle of the frame, once it faces the target) however fast the pointer moves; the light pose takes no
 * parallax, so the pointer moves the camera under a still light. Then `camera.updateMatrixWorld()`. The camera's parent,
 * if it has one, must be untransformed: the rig writes world poses into `position` and `quaternion`.
 *
 * Pointer: a `pointermove` from a mouse or pen aims the parallax at its position on the canvas ([−1, 1] each way, y up);
 * any other move (touch has no hover) and `pointerleave` aim it back at (0, 0). The smoothed value follows on
 * critically damped springs (`parallaxResponse`). `parallax = false` springs it back to 0; reduced motion holds it at
 * 0 (it jumps there).
 *
 * `focus` resolves `true` when the plain pose settles (the pointer does not hold it up; the light may still be on its
 * way), `false` when a later `focus` or `dispose` cuts it short or its target goes away (disposed or failed: the rig
 * drops it and leaves the camera where it is). `immediate`, or reduced motion, puts the camera and the light pose on the
 * goal at the next `update` (and resolves then).
 */
export class CameraRig {
  /** Pointer parallax (default true); false springs the camera back to the plain focus pose. */
  parallax = true
  private readonly env: RigEnvironment
  private readonly margin: number
  /** Radians: the `parallax` option, converted once. */
  private readonly amplitude: number
  /** The camera's world pose without the parallax: the focus pose followed at `response`. */
  private readonly plain: Follower
  /** The lights' world pose: the focus pose followed at `lightResponse`. */
  private readonly light: Follower
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
  /** The parallax as a world rotation about the target's centre, and the inverse of the target's orientation. */
  private readonly orbit = new Quaternion()
  private readonly unturn = new Quaternion()

  /** Reads `opts` (a readable `GlassUIError` for one out of range), then listens on the canvas. */
  constructor(env: RigEnvironment, opts: CameraRigOptions = {}) {
    checkOptions(opts)
    this.env = env
    this.margin = opts.margin ?? DEFAULTS.margin
    this.amplitude = MathUtils.degToRad(opts.parallax ?? DEFAULTS.parallax)
    this.plain = new Follower(springFromResponse(opts.response ?? DEFAULTS.response, 1))
    this.light = new Follower(springFromResponse(opts.lightResponse ?? DEFAULTS.lightResponse, 1))
    const smooth = springFromResponse(opts.parallaxResponse ?? DEFAULTS.parallaxResponse, 1)
    this.px = new Spring(0, smooth); this.py = new Spring(0, smooth)
    env.canvas.addEventListener('pointermove', this.onMove)
    env.canvas.addEventListener('pointerleave', this.onLeave)
  }

  /** The Surface the camera faces (or is on its way to); null before the first `focus`, after its target went away, after `dispose`. */
  get target(): Surface | null { return this.current }
  /** `dispose` has run: the rig no longer writes the camera or listens to the canvas. */
  get disposed(): boolean { return this.isDisposed }
  /**
   * Where the UI lights belong (spatial spec §11.1): the focus pose without the parallax, followed on springs slower than
   * the camera's (`lightResponse`); the root's `tick` copies it into the lights. Null whenever `target` is (before the
   * first `focus`, after its target went away, after `dispose`): the lights then follow the camera. The rig owns these
   * objects and rewrites them every `update`: copy them, do not keep or change them.
   */
  get lightPose(): { position: Vector3; quaternion: Quaternion } | null { return this.current ? this.light.pose : null }

  /**
   * Turns the camera to face `target` (a world Surface; a screen one, which follows the camera, throws a readable
   * `GlassUIError`). Ends the previous focus `false`. Already driving: the plain pose's and the light's position
   * springs keep their velocity (no jump), their slerps restart from where they are. Idle: both start at rest on the
   * camera's pose (where the lights were), the parallax at 0. Resolves `true` when the camera's plain pose settles on the
   * goal; `immediate` (or reduced motion now) puts it and the light there at the next `update` and resolves then.
   * `false` at once for a disposed or failed target (the rig then has none) and on a disposed rig.
   */
  focus(target: Surface, opts: { immediate?: boolean } = {}): Promise<boolean> {
    if (this.isDisposed) return Promise.resolve(false)
    if (target.model.placement === 'screen') throw new GlassUIError('CameraRig.focus', '只能对焦世界层 Surface：屏幕层 Surface 跟着相机走')
    this.end(false)
    if (target.disposed || target.error) { this.current = null; return Promise.resolve(false) }
    // driving: the springs carry on, velocity and all; idle: they start at rest where the camera (and so the lights)
    // is, and with no parallax the camera stays put on the first step
    if (!this.current) {
      const cam = this.env.camera
      this.plain.place(cam.position, cam.quaternion); this.light.place(cam.position, cam.quaternion)
      this.px.jump(0); this.py.jump(0)
    }
    this.plain.retarget(); this.light.retarget()
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
    // the parallax angles: toward the pointer's aim, or back toward 0 with parallax off; reduced motion holds them at 0
    if (reduced) { this.px.jump(0); this.py.jump(0) }
    else { this.px.set(this.parallax ? this.aim.x : 0); this.py.set(this.parallax ? this.aim.y : 0); this.px.step(dt); this.py.step(dt) }
    // the goal: the plain focus pose, which the camera's plain pose and the light follow, each on its own springs
    const d = restFrame(t, cam.getEffectiveFOV(), aspect, this.margin, this.centre, this.goal.quaternion)
    this.goal.position.set(0, 0, d).applyQuaternion(this.goal.quaternion).add(this.centre)
    const snap = this.snap || reduced
    this.snap = false
    this.plain.step(this.goal, snap, dt); this.light.step(this.goal, snap, dt)
    // the camera: the plain pose orbited about the target's centre — yaw about the target's up axis, then pitch about
    // its right one: the rotation R in the target's frame G, G·R·G⁻¹ in the world
    const g = this.goal.quaternion
    this.orbit.setFromEuler(orbitEuler.set(-this.py.value * this.amplitude, this.px.value * this.amplitude, 0, 'YXZ')).premultiply(g).multiply(this.unturn.copy(g).invert())
    cam.position.copy(this.plain.pose.position).sub(this.centre).applyQuaternion(this.orbit).add(this.centre)
    cam.quaternion.multiplyQuaternions(this.orbit, this.plain.pose.quaternion)
    cam.updateMatrixWorld()
    if (this.plain.settled) this.end(true)
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
