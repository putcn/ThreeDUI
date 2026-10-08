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
