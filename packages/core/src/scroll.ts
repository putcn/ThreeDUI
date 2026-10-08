import { GlassUIError } from './errors'
import { Spring, type SpringConfig } from './animation/spring'

/** Length scale (pt) of the rubber band: how fast resistance grows with the overshoot. */
const RUBBER_SCALE = 300
/** An inertial glide below this speed (pt/s) stops. */
const REST_SPEED = 1

/** One scroll axis: wheel, drag with rubber-banding past the edges, inertia after release, spring back into bounds. */
export class ScrollPhysics {
  offset = 0; velocity = 0; min = 0; max = 0
  private dragging = false
  private readonly decay: number
  /** Content/finger travel ratio right at an edge (1 − rubber). */
  private readonly stretch: number
  private readonly back: Spring
  /** Bound the snap-back spring is returning to; the spring keeps control through underdamped swings into the content. */
  private edge: 'min' | 'max' | null = null

  /**
   * @param opts.decay per-second velocity retention of the glide after release, 0 ≤ decay < 1 (default 0.002)
   * @param opts.rubber resistance right at an edge, 0..1 (1 = rigid); it grows further with the overshoot (default 0.55)
   * @param opts.snapBack spring that pulls an overshoot back to the nearest bound (default { stiffness: 220, damping: 28 })
   */
  constructor(opts: { decay?: number | undefined; rubber?: number | undefined; snapBack?: SpringConfig | undefined } = {}) {
    const { decay = 0.002, rubber = 0.55, snapBack = { stiffness: 220, damping: 28 } } = opts
    if (!(decay >= 0 && decay < 1)) throw new GlassUIError('scroll', `非法 decay=${decay}（需 0 ≤ decay < 1）`)
    if (!(rubber >= 0 && rubber <= 1)) throw new GlassUIError('scroll', `非法 rubber=${rubber}（需 0 ≤ rubber ≤ 1）`)
    this.decay = decay; this.stretch = 1 - rubber
    this.back = new Spring(0, snapBack)   // validates the config now rather than at the first overshoot
  }

  /** `max < min` (content shorter than the viewport) collapses to `min`. An offset left outside springs back on `step`. */
  setBounds(min: number, max: number): void {
    if (!Number.isFinite(min) || !Number.isFinite(max)) throw new GlassUIError('scroll', `非法滚动范围 min=${min} max=${max}（需为有限数）`)
    const hi = Math.max(min, max)
    if (min === this.min && hi === this.max) return
    this.min = min; this.max = hi; this.edge = null
  }

  /** Grab: stops any glide or snap-back where it is. */
  beginDrag(): void { this.dragging = true; this.velocity = 0; this.edge = null }
  /**
   * Move by a finger delta. Inside the bounds the content follows 1:1; only the travel past an edge goes through the
   * rubber band, so the content position is a function of the finger position (one big move = many small ones, and it
   * comes back under the finger). `dt` is the time since the previous sample; when it is not positive (coalesced
   * events) the content still moves but the velocity estimate is kept.
   */
  drag(delta: number, dt: number): void {
    if (!Number.isFinite(delta)) return
    const { min, max } = this, from = this.offset
    const finger = (from < min ? min - this.unband(min - from) : from > max ? max + this.unband(from - max) : from) + delta
    this.offset = finger < min ? min - this.band(min - finger) : finger > max ? max + this.band(finger - max) : finger
    if (dt > 0 && dt < Infinity) this.velocity = (this.offset - from) / dt
  }
  /** Release: the last sample's velocity carries on. If the finger rested before lifting, report it first with `drag(0, elapsed)`. */
  endDrag(): void { this.dragging = false }
  /** Immediate and clamped to the bounds; cancels any glide or snap-back. */
  wheel(delta: number): void {
    if (!Number.isFinite(delta)) return
    this.offset = this.clamp(this.offset + delta); this.velocity = 0; this.edge = null
  }

  /** Advance the glide or the snap-back by `dt` seconds; a no-op while dragging or for non-positive/non-finite `dt`. */
  step(dt: number): number {
    if (this.dragging || !(dt > 0 && dt < Infinity)) return this.offset
    this.edge ??= this.offset < this.min ? 'min' : this.offset > this.max ? 'max' : null
    if (this.edge) {
      const s = this.back
      s.value = this.offset; s.velocity = this.velocity; s.target = this.edge === 'min' ? this.min : this.max
      this.offset = s.step(dt); this.velocity = s.velocity
      if (s.done) this.edge = null   // Spring snapped onto the bound with zero velocity
      return this.offset
    }
    if (this.velocity === 0) return this.offset
    // Exact integral of v(t) = v0·decay^t, so the glide distance does not depend on the frame rate.
    const k = Math.pow(this.decay, dt)
    this.offset += (this.velocity * (k - 1)) / Math.log(this.decay)
    this.velocity *= k
    if (this.offset < this.min || this.offset > this.max) this.velocity *= 0.5   // crossed an edge: the spring takes over next step
    else if (Math.abs(this.velocity) < REST_SPEED) this.velocity = 0
    return this.offset
  }

  get settled(): boolean { return !this.dragging && this.velocity === 0 && this.offset >= this.min && this.offset <= this.max }

  private clamp(v: number): number { return Math.min(this.max, Math.max(this.min, v)) }
  /**
   * Finger travel past an edge (x ≥ 0) → content travel past it: slope `stretch` at the edge, then √ growth.
   * Cancellation-free form of √(S² + 2·stretch·S·x) − S.
   */
  private band(x: number): number {
    const a = 2 * this.stretch * RUBBER_SCALE * x
    return a / (Math.sqrt(RUBBER_SCALE * RUBBER_SCALE + a) + RUBBER_SCALE)
  }
  /** Inverse of `band`. A rigid edge (stretch 0) has no finger position past it, so the drag restarts at the edge. */
  private unband(y: number): number {
    return this.stretch > 0 ? (y * (y + 2 * RUBBER_SCALE)) / (2 * this.stretch * RUBBER_SCALE) : 0
  }
}
