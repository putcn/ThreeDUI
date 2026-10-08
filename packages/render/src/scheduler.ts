/** Frame delta with a clamp (Review Focus 2: a hidden tab must not feed minutes into the springs). */
export class FrameScheduler {
  readonly maxDt: number
  private last: number | null = null
  constructor(opts: { maxDt?: number } = {}) { this.maxDt = opts.maxDt ?? 1 / 20 }
  /** Seconds since the previous call, in [0, maxDt]: 0 on the first call, after `reset()` and for a non-finite `nowMs` (which leaves the clock where it was). */
  dt(nowMs: number): number {
    if (!Number.isFinite(nowMs)) return 0
    if (this.last === null) { this.last = nowMs; return 0 }
    const dt = Math.min(this.maxDt, Math.max(0, (nowMs - this.last) / 1000))
    this.last = nowMs
    return dt
  }
  reset(): void { this.last = null }
}

/** Intervals the refresh estimate looks back over. */
const PERIOD_WINDOW = 60
/** A longer interval is a pause (a hidden tab, a breakpoint), not a frame time. */
const MAX_INTERVAL_MS = 250

/**
 * What a frame of a continuous loop tells `QualityController.sample`, relative to the display's refresh: its absolute
 * 20/10 ms thresholds must not read a 30 Hz rAF cap (Low Power, Energy Saver) as slow, nor a 60 Hz vsync as never
 * fast. The refresh period is estimated as the shortest of the last 60 intervals, clamped to [4, 40] ms. A frame that
 * came more than 1.5 periods after the previous one dropped a refresh: its interval is the sample (GPU time included,
 * through the swap chain's back-pressure). Otherwise it met the refresh: its CPU cost is the sample (a lower bound, so
 * idle frames can step quality up). GPU timestamp queries are a later refinement.
 */
export class FrameSampler {
  private last: number | null = null
  private readonly intervals: number[] = []
  private next = 0

  /** The refresh period estimate (ms). */
  get period(): number { return Math.min(40, Math.max(4, Math.min(...this.intervals))) }

  /**
   * The sample for a frame at `nowMs` that cost `cpuMs`, or null: on the first frame, for the same stamp twice, a
   * non-finite one (the clock stays), one earlier than the last (the clock restarts from it) and after a pause.
   */
  sample(nowMs: number, cpuMs: number): number | null {
    if (!Number.isFinite(nowMs) || nowMs === this.last) return null
    const last = this.last
    this.last = nowMs
    if (last === null) return null
    const interval = nowMs - last
    if (interval <= 0 || interval > MAX_INTERVAL_MS) return null
    this.intervals[this.next] = interval
    this.next = (this.next + 1) % PERIOD_WINDOW
    return interval > 1.5 * this.period ? interval : cpuMs
  }
}
