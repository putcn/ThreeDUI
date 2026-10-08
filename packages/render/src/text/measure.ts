import { resolveTextStyle, type ColorScheme, type MeasureFn, type Node, type TextInstance, type Theme } from '@glassui/core'
import type { TextEngine, TextRun } from '@glassui/text'

/** The engine run a text instance lays out (the same typography the measure function used for its node). */
export function runFor(t: Pick<TextInstance, 'text' | 'font' | 'lineHeight' | 'letterSpacing' | 'maxLines' | 'wrap'>): TextRun {
  return { text: t.text, font: t.font, lineHeight: t.lineHeight, letterSpacing: t.letterSpacing, maxLines: t.maxLines, wrap: t.wrap }
}

/**
 * The yoga measure callback: core text style → text run → engine measure, memoised (spec §6) by text, typography and
 * `maxWidth`, least recently used first out beyond `cacheSize` (default 2000). `clear()` drops every entry (e.g. once
 * a web font has loaded and earlier measurements used a fallback).
 */
export function createMeasureFn(engine: TextEngine, theme: Theme, scheme: ColorScheme, opts: { cacheSize?: number } = {}): MeasureFn & { clear(): void } {
  const cacheSize = opts.cacheSize ?? 2000
  const cache = new Map<string, { width: number; height: number }>()
  const fn = ((node: Node, maxWidth: number | undefined) => {
    const t = resolveTextStyle(node, theme, scheme)
    const text = String(node.props.value ?? '')
    const key = `${text}\u0000${t.family}|${t.size}|${t.weight}|${t.lineHeight}|${t.letterSpacing}|${t.maxLines ?? ''}|${t.wrap}|${maxWidth ?? ''}`
    const hit = cache.get(key)
    if (hit) { cache.delete(key); cache.set(key, hit); return hit }   // re-inserted: Map order is the recency order
    const m = engine.measure({ text, font: { family: t.family, size: t.size, weight: t.weight }, lineHeight: t.lineHeight, letterSpacing: t.letterSpacing, maxLines: t.maxLines, wrap: t.wrap }, { maxWidth })
    const r = { width: m.width, height: m.height }
    cache.set(key, r)
    if (cache.size > cacheSize) cache.delete(cache.keys().next().value as string)
    return r
  }) as MeasureFn & { clear(): void }
  fn.clear = () => cache.clear()
  return fn
}
