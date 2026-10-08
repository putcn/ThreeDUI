import type { QualitySettings } from './surface/surface'

export type QualityTier = 'high' | 'medium' | 'low' | 'minimal'
/** A full tier: what a Surface reads (`QualitySettings`, `blur` included) plus what the root and the glass read. */
export interface QualityProfile extends QualitySettings { tier: QualityTier; shadowMap: number; refraction: boolean; dispersion: 'always' | 'auto' | 'never' }

/** Spec §5.6 table. Frozen: every root shares these rows, so copy one before changing it. */
export const QUALITY: Record<QualityTier, QualityProfile> = {
  high: Object.freeze({ tier: 'high', contentType: 'half', contentScale: 1, backFaces: true, depthReject: true, shadowMap: 2048, blur: 'kawase', refraction: true, dispersion: 'always' }),
  medium: Object.freeze({ tier: 'medium', contentType: 'byte', contentScale: 0.5, backFaces: false, depthReject: false, shadowMap: 1024, blur: 'mip', refraction: true, dispersion: 'auto' }),
  low: Object.freeze({ tier: 'low', contentType: 'byte', contentScale: 0.25, backFaces: false, depthReject: false, shadowMap: 512, blur: 'mip', refraction: false, dispersion: 'never' }),
  minimal: Object.freeze({ tier: 'minimal', contentType: 'byte', contentScale: 0.25, backFaces: false, depthReject: false, shadowMap: 512, blur: 'mip', refraction: false, dispersion: 'never' }),
}
const ORDER: QualityTier[] = ['minimal', 'low', 'medium', 'high']

export function defaultTier(env: { touch: boolean; reducedTransparency: boolean }): QualityTier {
  return env.reducedTransparency ? 'minimal' : env.touch ? 'medium' : 'high'
}

/**
 * Frame-time hysteresis between tiers (spec §5.6): two slow windows (> 20 ms average) in a row → one tier down, five
 * fast ones (< 10 ms) in a row → one tier up, never above the cap; a window in between resets both runs, and every
 * tier change starts them over. Reduced transparency pins `minimal` (and stops sampling) until cleared; a `set` while
 * pinned keeps `minimal` and only records where clearing the pin returns (at most the cap; without one, the cap).
 * Listeners hear every change in order, even one a listener makes itself; one that throws is reported and skipped.
 *
 * Flip-flop back-off: a tier that is over budget while the one below fits would otherwise be re-probed every few
 * seconds (each change rebuilds every Surface's glass). So the controller counts its sampled step-downs from each tier
 * this session (`set` is not one); stepping back up into a tier stepped down from `d` times takes `5 · 2^(d − 1)` fast
 * windows (5 for the first retry, then 10), and after its third step-down that tier is never probed again — `set` and
 * clearing the reduced-transparency pin can still reach it.
 */
export class QualityController {
  private current: QualityTier
  private readonly cap: QualityTier
  private reduced: boolean
  /** Where clearing the pin returns: the last `set` while pinned, else the cap. */
  private resume: QualityTier | null = null
  private readonly window: number
  private acc = 0; private n = 0; private slow = 0; private fast = 0
  /** Sampled step-downs from each tier this session (the back-off). */
  private readonly demotions: Record<QualityTier, number> = { high: 0, medium: 0, low: 0, minimal: 0 }
  private readonly listeners = new Set<(tier: QualityTier, prev: QualityTier) => void>()
  private readonly queue: [tier: QualityTier, prev: QualityTier][] = []
  constructor(opts: { initial?: QualityTier; cap?: QualityTier; reducedTransparency?: boolean; window?: number } = {}) {
    this.cap = opts.cap ?? opts.initial ?? 'high'
    this.reduced = opts.reducedTransparency ?? false
    this.window = opts.window ?? 30
    this.current = this.reduced ? 'minimal' : opts.initial ?? this.cap
  }
  get tier(): QualityTier { return this.current }
  get profile(): QualityProfile { return QUALITY[this.current] }
  onChange(fn: (tier: QualityTier, prev: QualityTier) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn) }

  /** Switches to `tier`; while pinned, records it (at most the cap) as where clearing the pin returns instead. */
  set(tier: QualityTier): void {
    if (this.reduced) { this.resume = ORDER.indexOf(tier) > ORDER.indexOf(this.cap) ? this.cap : tier; return }
    this.change(tier)
  }
  /** Pins `minimal` while on; clearing it returns to the tier `set` while pinned, else the cap. Either way the hysteresis starts over. */
  setReducedTransparency(on: boolean): void {
    if (on === this.reduced) return
    this.reduced = on
    const to = on ? 'minimal' : this.resume ?? this.cap
    this.resume = null
    this.restart()
    this.change(to)
  }

  private change(tier: QualityTier): void {
    const prev = this.current
    if (tier === prev) return
    this.current = tier
    this.restart()
    this.emit(tier, prev)
  }
  /** Frames timed at another tier (or before a pin) say nothing about this one. */
  private restart(): void { this.acc = this.n = this.slow = this.fast = 0 }
  /** Each change goes to the listeners registered when its delivery starts; a change a listener makes waits its turn. */
  private emit(tier: QualityTier, prev: QualityTier): void {
    this.queue.push([tier, prev])
    if (this.queue.length > 1) return
    for (let e = this.queue[0]; e; this.queue.shift(), e = this.queue[0])
      for (const fn of [...this.listeners]) try { fn(...e) } catch (err) { console.error('[glassui] a quality listener threw:', err) }
  }

  /** Feed one frame's time; returns the new tier on the frame it changes, else `null`. */
  sample(frameMs: number): QualityTier | null {
    if (this.reduced || !Number.isFinite(frameMs) || frameMs < 0) return null
    this.acc += frameMs; this.n++
    if (this.n < this.window) return null
    const avg = this.acc / this.n; this.acc = 0; this.n = 0
    const idx = ORDER.indexOf(this.current)
    if (avg > 20) {
      this.fast = 0
      if (++this.slow >= 2 && idx > 0) { this.demotions[this.current]++; this.change(ORDER[idx - 1]!); return this.current }
    } else if (avg < 10) {
      this.slow = 0
      const up = ORDER[idx + 1]
      if (++this.fast >= this.fastWindowsInto(up) && idx < ORDER.indexOf(this.cap)) { this.change(up!); return this.current }
    } else { this.slow = 0; this.fast = 0 }
    return null
  }

  /** Fast windows a step up into `tier` takes: 5, doubling with each step-down from it after the first; never after three. */
  private fastWindowsInto(tier: QualityTier | undefined): number {
    const d = tier ? this.demotions[tier] : 0
    return d >= 3 ? Infinity : 5 * 2 ** Math.max(0, d - 1)
  }
}
