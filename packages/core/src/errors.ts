function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  const d: number[] = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    let prev = d[0]!
    d[0] = i
    for (let j = 1; j <= n; j++) {
      const tmp = d[j]!
      d[j] = Math.min(d[j]! + 1, d[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1))
      prev = tmp
    }
  }
  return d[n]!
}

/** Nearest candidate within edit distance 2 (case-insensitive), or null. */
export function suggest(got: string, candidates: readonly string[]): string | null {
  let best: string | null = null
  let bestD = 3
  for (const c of candidates) {
    const d = levenshtein(got.toLowerCase(), c.toLowerCase())
    if (d < bestD) { bestD = d; best = c }
  }
  return best
}

export class GlassUIError extends Error {
  override readonly name = 'GlassUIError'
  constructor(scope: string, reason: string, opts: { allowed?: readonly string[]; got?: string } = {}) {
    let msg = `[${scope}] ${reason}`
    if (opts.allowed && opts.allowed.length) msg += `。允许值：${opts.allowed.join(', ')}`
    if (opts.allowed && opts.got !== undefined) {
      const s = suggest(opts.got, opts.allowed)
      if (s) msg += `。你可能想要：${s}`
    }
    super(msg)
  }
}
