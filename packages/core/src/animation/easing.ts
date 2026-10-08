export type Easing = 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'

/** Cubic easings on t ∈ [0, 1] (clamped). */
export function ease(name: Easing, t: number): number {
  const x = Math.max(0, Math.min(1, t))
  switch (name) {
    case 'linear': return x
    case 'ease-in': return x * x * x
    case 'ease-out': return 1 - Math.pow(1 - x, 3)
    case 'ease-in-out': return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
  }
}
