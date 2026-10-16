/** Slack in a tick's floor / ceil, in steps: 4.2 / 0.2 is 21.000000000000004, which must not round up to a 22nd step. */
const EPS = 1e-9

/**
 * "Nice" axis ticks for the values `min`..`max` (finite): evenly spaced by a step of 1, 2 or 5 × 10ⁿ, from the
 * largest multiple of the step ≤ `min` to the least ≥ `max`, 3–6 ticks. Of the steps that give 3–6, the one whose
 * number of gaps between ticks is closest to `target` wins, the smaller step on a tie (0..97 → 0, 20, …, 100;
 * 0..236 → 0, 50, …, 250). Each tick is rounded to the step's decimals, so 0.1 · 3 comes out as 0.3. A range with no
 * width (`max` ≤ `min`) is widened to `min` + |min| (+ 1 at 0).
 */
export function niceTicks(min: number, max: number, target = 4): number[] {
  const lo = Math.min(min, max), hi = max > min ? max : lo + (Math.abs(lo) || 1)
  const e = Math.floor(Math.log10((hi - lo) / target))
  let best: { step: number; k: number; a: number; gaps: number } | null = null
  // from the smallest step up, so a tie keeps the smaller; 10^(e−1)…5·10^(e+2) always holds a step with 2–5 gaps
  for (let k = e - 1; k <= e + 2; k++) {
    for (const m of [1, 2, 5]) {
      // a negative power divides (0.2 is 2 / 10, not 2 × 0.1): the step is the plain decimal
      const step = k < 0 ? m / 10 ** -k : m * 10 ** k
      const a = Math.floor(lo / step + EPS), gaps = Math.ceil(hi / step - EPS) - a
      if (gaps < 2 || gaps > 5) continue
      if (!best || Math.abs(gaps - target) < Math.abs(best.gaps - target)) best = { step, k, a, gaps }
    }
  }
  const { step, k, a, gaps } = best!
  return Array.from({ length: gaps + 1 }, (_, i) => Number(((a + i) * step).toFixed(Math.max(0, -k))))
}

/**
 * `v` rounded up to a "nice" axis maximum: the top of `niceTicks(0, v)` (236 → 250, 17 → 20, 0.3 → 0.3), and 1 for
 * v ≤ 0. `BarChart3D`'s default `max`.
 */
export function niceMax(v: number): number {
  return v <= 0 ? 1 : niceTicks(0, v).at(-1)!
}

/** `v` with at most two decimals, trailing zeros dropped (1.5, 2, 0.33): the charts' default `format`. */
export function formatValue(v: number): string {
  return String(Number(v.toFixed(2)))
}
