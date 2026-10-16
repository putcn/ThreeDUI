/**
 * `v` rounded up to a "nice" axis maximum: the least of 1, 2, 5 and 10 × 10ᵏ that is ≥ v (0 → 1). `BarChart3D`'s
 * default `max`. A negative power divides (0.5 is 5 / 10, not 5 × 0.1), so the result is the plain decimal.
 */
export function niceMax(v: number): number {
  if (v <= 0) return 1
  const k = Math.floor(Math.log10(v)), at = (m: number): number => k < 0 ? m / 10 ** -k : m * 10 ** k
  return [1, 2, 5].map(at).find(n => n >= v) ?? at(10)
}

/** `v` with at most two decimals, trailing zeros dropped (1.5, 2, 0.33): `BarChart3D`'s default `format`. */
export function formatValue(v: number): string {
  return String(Number(v.toFixed(2)))
}
