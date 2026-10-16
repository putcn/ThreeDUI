import { Euler, Quaternion, type Vector3 } from 'three'
import { GlassUIError, Spring, springFromResponse, type SpringConfig, type Theme } from '@glassui/core'

/**
 * Where `Surface.animateTo` takes a Surface (spatial spec §2.1): its position in world units, its rotation in radians
 * (an XYZ Euler), a uniform or per-axis scale, and the whole Surface's opacity (0–1). A field left out is a channel the
 * call leaves alone.
 */
export interface SurfacePose { position?: [number, number, number]; rotation?: [number, number, number]; scale?: number | [number, number, number]; opacity?: number }
/** A Surface's pose as three holds it, plus its opacity. */
export interface ResolvedPose { position: Vector3; quaternion: Quaternion; scale: Vector3; opacity: number }
/**
 * The spring a pose animation runs on (core spec §4.4 without the duration form): a theme preset, the Apple-style
 * response form, or a raw `SpringConfig`.
 */
export type PoseSpring = 'snappy' | 'smooth' | 'bouncy' | { response: number; dampingFraction: number } | SpringConfig
/** The default pose spring (spatial spec §2.1): a 0.55 s period, barely overshooting. */
export const POSE_SPRING = { response: 0.55, dampingFraction: 0.86 } as const

type Channel = 'position' | 'rotation' | 'scale' | 'opacity'
const CHANNELS: readonly Channel[] = ['position', 'rotation', 'scale', 'opacity']
const PRESETS = ['snappy', 'smooth', 'bouncy'] as const
const SCOPE = 'Surface.animateTo'
/** One `to` call: the channels it still owns (each leaves as it settles) and its promise's resolver. */
interface Call { channels: Set<Channel>; resolve: (ok: boolean) => void }

/** `v` as an error message shows it (NaN and Infinity as themselves, not as JSON's null). */
function show(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(show).join(', ')}]`
  if (typeof v === 'string') return `"${v}"`
  if (typeof v === 'object' && v !== null) return `{ ${Object.entries(v).map(([k, x]) => `${k}: ${show(x)}`).join(', ')} }`
  return String(v)
}
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
/** Three finite numbers that each pass `ok`. */
const triple = (v: unknown, ok: (x: number) => boolean): boolean => Array.isArray(v) && v.length === 3 && v.every(x => finite(x) && ok(x))

/** Throws a readable `GlassUIError` (scope `scope`) unless `v` is a number in [0, 1]. */
export function checkOpacity(scope: string, v: unknown): void {
  if (!(finite(v) && v >= 0 && v <= 1)) throw new GlassUIError(scope, `opacity 必须是 0 到 1 之间的数，收到 ${show(v)}`)
}

/** Throws a readable `GlassUIError` unless `spring` is a `PoseSpring` whose numbers are finite and positive. */
function checkSpring(spring: unknown): void {
  if (typeof spring === 'string') {
    if (!(PRESETS as readonly string[]).includes(spring)) throw new GlassUIError(SCOPE, `未知的弹簧预设 "${spring}"`, { allowed: PRESETS, got: spring })
    return
  }
  const o = (typeof spring === 'object' && spring !== null ? spring : {}) as Record<string, unknown>
  const positive = (k: string): boolean => { const v = o[k]; return finite(v) && v > 0 }
  const ok = 'response' in o ? positive('response') && positive('dampingFraction')
    : positive('stiffness') && positive('damping') && (o.mass === undefined || positive('mass'))
  if (!ok) {
    throw new GlassUIError(SCOPE, `spring 必须是 ${PRESETS.join(' / ')}、{ response, dampingFraction } 或 { stiffness, damping, mass? }，各项为大于 0 的有限数（无阻尼的弹簧停不下来），收到 ${show(spring)}`)
  }
}

/** Throws a readable `GlassUIError` unless `target` is a `SurfacePose` (and `spring`, when given, a `PoseSpring`). */
function check(target: SurfacePose, spring: PoseSpring | undefined): void {
  if (typeof target !== 'object' || target === null) throw new GlassUIError(SCOPE, `目标姿态必须是对象 { position?, rotation?, scale?, opacity? }，收到 ${show(target)}`)
  for (const k of Object.keys(target)) if (!(CHANNELS as readonly string[]).includes(k)) throw new GlassUIError(SCOPE, `未知的姿态字段 "${k}"`, { allowed: CHANNELS, got: k })
  const { position, rotation, scale, opacity } = target
  if (position !== undefined && !triple(position, () => true)) throw new GlassUIError(SCOPE, `position 必须是三个有限数 [x, y, z]（世界单位），收到 ${show(position)}`)
  if (rotation !== undefined && !triple(rotation, () => true)) throw new GlassUIError(SCOPE, `rotation 必须是三个有限数 [x, y, z]（弧度，XYZ 顺序），收到 ${show(rotation)}`)
  if (scale !== undefined && !(finite(scale) && scale > 0) && !triple(scale, x => x > 0)) {
    throw new GlassUIError(SCOPE, `scale 必须是大于 0 的有限数，或三个这样的数 [x, y, z]，收到 ${show(scale)}`)
  }
  if (opacity !== undefined) checkOpacity(SCOPE, opacity)
  if (spring !== undefined) checkSpring(spring)
}

/** A preset from `theme.springs`; the response form through `springFromResponse`; a `SpringConfig` as is. */
function springOf(spring: PoseSpring, theme: Theme): SpringConfig {
  if (typeof spring === 'string') return theme.springs[spring]
  if ('response' in spring) return springFromResponse(spring.response, spring.dampingFraction)
  return spring
}

/**
 * One component's spring toward `target` under `cfg`: a running one hands on its value and velocity (a retarget stays
 * continuous); otherwise it starts at `from`, at rest. `jump`: at `target`, at rest (the next `step` writes it and
 * settles).
 */
function retarget(running: Spring | null, from: number, target: number, cfg: SpringConfig, jump: boolean): Spring {
  const s = new Spring(running ? running.value : from, cfg)
  if (jump) { s.jump(target); return s }
  if (running) s.velocity = running.velocity
  s.set(target)
  return s
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))
/** Advances each component's spring and writes it into `v`. */
function stepInto(springs: readonly Spring[], dt: number, v: Vector3): void { springs.forEach((s, i) => { v.setComponent(i, s.step(dt)) }) }

/**
 * The pose springs of one Surface (spatial spec §2.1); the Surface steps them every root `tick` (`Surface.stepMotion`).
 *
 * Channels: position and scale run one `Spring` per component, opacity one (what it writes is clamped to [0, 1]: an
 * underdamped spring overshoots). Rotation is a progress spring 0 → 1 slerping from the quaternion at the call to the
 * target's along the short arc (three's `slerp`); the progress is clamped to [0, 1], so a rotation never swings past its
 * target (an overshooting spring bounces position, scale and opacity, not rotation).
 *
 * Retargets: a call naming a moving position, scale or opacity channel keeps each spring's value and velocity (only its
 * target and config change), so a retarget stays continuous. A rotation restarts its slerp from the current quaternion
 * at zero progress velocity: the progress of the old arc has no meaning on the new one.
 *
 * Promises: each call owns the channels it names. A newer call naming one of them ends the older call's promise `false`
 * at once (the older call's other channels run on to their targets, owned by no call). A call resolves `true` when all
 * its channels have settled (at once when it names none). `immediate` puts its springs at their targets, at rest: the
 * next `step` writes them and resolves it `true`.
 */
export class SurfaceMotion {
  /** What the presets resolve against: the Surface hands it the root's current theme (`Surface.restyle`). */
  theme: Theme
  private pos: Spring[] | null = null
  private scl: Spring[] | null = null
  private op: Spring | null = null
  private rot: { from: Quaternion; to: Quaternion; p: Spring } | null = null
  private readonly owner = new Map<Channel, Call>()

  constructor(theme: Theme) { this.theme = theme }

  /**
   * Starts or retargets the channels `target` names. A channel not already moving starts from `from` (read now: the
   * caller may reuse it). Throws a readable `GlassUIError` (scope `Surface.animateTo`) on a bad pose or spring.
   */
  to(target: SurfacePose, from: ResolvedPose, opts: { spring?: PoseSpring; immediate?: boolean } = {}): Promise<boolean> {
    check(target, opts.spring)
    const cfg = springOf(opts.spring ?? POSE_SPRING, this.theme)
    const channels = new Set(CHANNELS.filter(c => target[c] !== undefined))
    const jump = opts.immediate === true
    return new Promise<boolean>(resolve => {
      if (!channels.size) { resolve(true); return }
      const call: Call = { channels, resolve }
      for (const c of channels) { const prev = this.owner.get(c); if (prev) this.supersede(prev); this.owner.set(c, call) }
      const { position, rotation, scale, opacity } = target
      if (position) this.pos = position.map((v, i) => retarget(this.pos?.[i] ?? null, from.position.getComponent(i), v, cfg, jump))
      if (scale !== undefined) {
        const s = typeof scale === 'number' ? [scale, scale, scale] : scale
        this.scl = s.map((v, i) => retarget(this.scl?.[i] ?? null, from.scale.getComponent(i), v, cfg, jump))
      }
      if (opacity !== undefined) this.op = retarget(this.op, from.opacity, opacity, cfg, jump)
      if (rotation) {
        const p = new Spring(0, cfg)
        if (jump) p.jump(1); else p.set(1)
        this.rot = { from: from.quaternion.clone(), to: new Quaternion().setFromEuler(new Euler(...rotation)), p }
      }
    })
  }

  /** Advances the moving channels and writes them into `out`; the idle ones are left as `out` has them. True while any channel moves. */
  step(dt: number, out: ResolvedPose): boolean {
    if (this.pos) stepInto(this.pos, dt, out.position)
    if (this.scl) stepInto(this.scl, dt, out.scale)
    if (this.op) out.opacity = clamp01(this.op.step(dt))
    if (this.rot) {
      const { from, to, p } = this.rot, t = clamp01(p.step(dt))
      if (t >= 1) out.quaternion.copy(to); else out.quaternion.slerpQuaternions(from, to, t)
    }
    if (this.pos?.every(s => s.done)) { this.pos = null; this.settle('position') }
    if (this.scl?.every(s => s.done)) { this.scl = null; this.settle('scale') }
    if (this.op?.done) { this.op = null; this.settle('opacity') }
    if (this.rot?.p.done) { this.rot = null; this.settle('rotation') }
    return this.active
  }

  /** Where `current` ends up: the moving channels' targets, the idle ones from `current`. */
  rest(current: ResolvedPose, into: ResolvedPose): ResolvedPose {
    into.position.copy(current.position); this.pos?.forEach((s, i) => { into.position.setComponent(i, s.target) })
    into.quaternion.copy(this.rot ? this.rot.to : current.quaternion)
    into.scale.copy(current.scale); this.scl?.forEach((s, i) => { into.scale.setComponent(i, s.target) })
    into.opacity = this.op ? this.op.target : current.opacity
    return into
  }

  /** Some channel is moving. */
  get active(): boolean { return this.pos !== null || this.scl !== null || this.op !== null || this.rot !== null }

  /** Every channel idle; every pending promise resolves false. */
  stop(): void {
    this.pos = null; this.scl = null; this.op = null; this.rot = null
    const calls = new Set(this.owner.values())
    this.owner.clear()
    for (const call of calls) call.resolve(false)
  }

  /** `c` settled: its owner (if any) lets go of it, and resolves `true` once it owns nothing more. */
  private settle(c: Channel): void {
    const call = this.owner.get(c)
    if (!call) return
    this.owner.delete(c); call.channels.delete(c)
    if (!call.channels.size) call.resolve(true)
  }

  /** A newer call took one of `call`'s channels: `call` lets go of all of them and resolves `false`. */
  private supersede(call: Call): void {
    for (const c of call.channels) if (this.owner.get(c) === call) this.owner.delete(c)
    call.resolve(false)
  }
}
