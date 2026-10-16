import { getCurrentScope, onScopeDispose } from '@vue/runtime-core'
import { Spring, type Theme } from '@glassui/core'
import { useMotion, useRoot } from './inject'

/** A theme spring preset (`theme.springs`). */
export type SpringPreset = keyof Theme['springs']

/** A number on a spring (`useSpring`). */
export interface SpringValue {
  /** Where it is now. */
  readonly value: number
  /**
   * Springs to `target` from where it is, keeping its velocity. Resolves true once it rests there; false when a later
   * `to` or `jump` takes over, or the calling scope ends first. Frozen motion and reduced motion jump at once (true).
   */
  to(target: number): Promise<boolean>
  /** Puts it at `value`, at rest, now (`onStep` gets it); a running `to` resolves false. */
  jump(value: number): void
}

/**
 * A core `Spring` (the theme's `spring` preset, as the theme is at the call) for what the style system does not animate,
 * such as a render Surface's own scale: while it moves it steps once per root tick, after it (`root.afterTick`), by
 * the time that tick covered, and hands each new value to `onStep`. Frozen motion (`useMotion`) and reduced motion
 * (`root.anim.reducedMotion`, also when it turns on mid-flight) jump to the target. A root with no Surfaces left (a
 * disposed one, whose `afterTick` resolves at once) has nothing to draw: the spring rests at its target there, so the
 * loop never spins. Stepping ends with the calling scope (a component's setup).
 */
export function useSpring(initial: number, opts: { spring: SpringPreset; onStep: (value: number) => void }): SpringValue {
  const root = useRoot(), frozen = useMotion() === 'frozen'
  const spring = new Spring(initial, root.theme.springs[opts.spring])
  /** The running `to`'s resolver; whether a step waits on the next tick; whether the scope still runs. */
  let pending: ((rested: boolean) => void) | null = null, armed = false, live = true
  const settle = (rested: boolean): void => { const r = pending; pending = null; r?.(rested) }
  const step = (dt: number): void => {
    armed = false
    if (!live || !pending) return
    if (root.surfaces.length === 0 || root.anim.reducedMotion) spring.jump(spring.target); else spring.step(dt)
    opts.onStep(spring.value)
    if (spring.done) settle(true); else arm()
  }
  const arm = (): void => {
    if (armed) return
    armed = true
    void root.afterTick().then(step)
  }
  if (getCurrentScope()) onScopeDispose(() => { live = false; settle(false) })
  return {
    get value() { return spring.value },
    to(target) {
      settle(false)
      if (frozen || root.anim.reducedMotion) { spring.jump(target); opts.onStep(target); return Promise.resolve(true) }
      spring.set(target)
      if (spring.done) return Promise.resolve(true)
      const p = new Promise<boolean>(resolve => { pending = resolve })
      arm()
      return p
    },
    jump(value) { settle(false); spring.jump(value); opts.onStep(value) },
  }
}
