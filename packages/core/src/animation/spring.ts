import { GlassUIError } from '../errors'
import type { Style } from '../style/schema'
import type { Theme } from '../style/theme'
import type { Easing } from './easing'

export interface SpringConfig { stiffness: number; damping: number; mass?: number | undefined }

/** Apple-style spring: `response` is the undamped period in seconds, `dampingFraction` is ζ (1 = critically damped). */
export function springFromResponse(response: number, dampingFraction: number, mass = 1): SpringConfig {
  const omega = (2 * Math.PI) / response
  const stiffness = mass * omega * omega
  return { stiffness, damping: 2 * dampingFraction * Math.sqrt(stiffness * mass), mass }
}

const MAX_STEP = 1 / 240
const SETTLE_EPSILON = 1e-3

export class Spring {
  value: number; velocity = 0; target: number
  private k: number; private c: number; private m: number
  /**
   * Sub-step size. Semi-implicit Euler is stable iff h²·k/m + 2h·c/m < 4; h ≤ 1/(√(k/m) + c/m) keeps that sum ≤ 2,
   * so very stiff or heavily damped configs get finer steps than MAX_STEP instead of diverging.
   */
  private h: number
  constructor(value: number, cfg: SpringConfig) {
    const { stiffness: k, damping: c, mass: m = 1 } = cfg
    const h = Math.min(MAX_STEP, 1 / (Math.sqrt(k / m) + c / m))
    if (![k, c, m].every(Number.isFinite) || !(k > 0 && c >= 0 && m > 0 && h > 0)) {
      throw new GlassUIError('spring', `非法弹簧参数 stiffness=${k} damping=${c} mass=${m}（需 stiffness>0、damping≥0、mass>0 且均为有限数）`)
    }
    this.value = value; this.target = value
    this.k = k; this.c = c; this.m = m; this.h = h
  }
  set(target: number): void { this.target = target }
  /** Snap to `value` with zero velocity. */
  jump(value: number): void { this.value = value; this.target = value; this.velocity = 0 }
  get done(): boolean { return Math.abs(this.value - this.target) < SETTLE_EPSILON && Math.abs(this.velocity) < SETTLE_EPSILON }
  /** Advance by `dt` seconds (semi-implicit Euler, sub-stepped); non-positive or non-finite `dt` is ignored. */
  step(dt: number): number {
    if (!(dt > 0 && dt < Infinity)) return this.value
    let remaining = dt
    while (remaining > 0 && !this.done) {
      const h = Math.min(remaining, this.h)
      const a = (-this.k * (this.value - this.target) - this.c * this.velocity) / this.m
      this.velocity += a * h
      this.value += this.velocity * h
      remaining -= h
    }
    if (this.done) { this.value = this.target; this.velocity = 0 }
    return this.value
  }
}

type Transitions = NonNullable<Style['transition']>
type Transition = NonNullable<Transitions[keyof Transitions]>

/** Theme preset / raw / response form → SpringConfig; the duration form passes through for a tween. */
export function resolveSpring(t: Transition, theme: Theme): SpringConfig | { duration: number; easing: Easing } {
  if (typeof t === 'string') return theme.springs[t]
  if ('duration' in t) return t
  if ('response' in t) return springFromResponse(t.response, t.dampingFraction)
  return t
}
