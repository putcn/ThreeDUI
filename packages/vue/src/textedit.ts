import type { ImeField, ImeState } from '@glassui/render'

/**
 * Pure text-editing helpers for `<Input>`. Indices are UTF-16 code units (the proxy's `selectionStart` / `End`, a
 * native field's `maxlength`).
 */

/** Full-width forms a Chinese or Japanese IME types for digits, the point and the minus (and its 。), one for one. */
const NUMBER_FORMS: Readonly<Record<string, string>> = { '．': '.', '。': '.', '－': '-', '−': '-' }
/** A number being typed: an optional leading minus, digits, at most one point (`-`, `.`, `1.` count). */
const PARTIAL_NUMBER = /^-?\d*\.?\d*$/

/**
 * The text a `number` field takes for the edit `prev` → `next`: `next` with the IME's full-width digits, point and
 * minus (and its `。`) as ASCII, when that is an optional leading `-`, digits and one `.`; null refuses the edit (the
 * proxy goes back to `prev`). An edit that leaves the text as it was (a caret move) is never refused.
 */
export function filterNumber(prev: string, next: string): string | null {
  if (next === prev) return next
  const ascii = next.replace(/[０-９．。－−]/g, c => NUMBER_FORMS[c] ?? String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  return PARTIAL_NUMBER.test(ascii) ? ascii : null
}

/** The number a `number` field's text stands for; null for none yet (empty, `-`, `.`). */
export function parseNumber(text: string): number | null {
  if (!/\d/.test(text)) return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

/** Letters and digits of any script, and `_`: the fallback's word characters. */
const WORD = /[\p{L}\p{N}_]/u
const classOf = (c: string): number => /\s/.test(c) ? 0 : WORD.test(c) ? 1 : 2

/**
 * The word around the character at `index` (the last character for `index` at the end), as `[start, end)`: a double
 * click's selection. Word boundaries are `Intl.Segmenter`'s (CJK by dictionary: 你好 | 世界); where there is none, a
 * run of word characters, of spaces, or of anything else.
 */
export function wordAt(text: string, index: number): [number, number] {
  if (!text) return [0, 0]
  const i = Math.max(0, Math.min(text.length - 1, index))
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const s = new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text).containing(i)
    if (s) return [s.index, s.index + s.segment.length]
  }
  const k = classOf(text[i]!)
  let a = i, b = i + 1
  while (a > 0 && classOf(text[a - 1]!) === k) a--
  while (b < text.length && classOf(text[b]!) === k) b++
  return [a, b]
}

/**
 * The horizontal scroll (pt, ≥ 0) that keeps `caretX` (pt, in the text) in a field `fieldWidth` wide, starting from
 * `scrollX`: a caret past the right edge comes to `pad` short of it, one left of the view to `pad` inside it; one already
 * in view stays where it is.
 */
export function scrollToShow(scrollX: number, caretX: number, fieldWidth: number, pad = 2): number {
  if (caretX - scrollX > fieldWidth - pad) return caretX - fieldWidth + pad
  if (caretX - scrollX < pad) return Math.max(0, caretX - pad)
  return scrollX
}

/** A password as shown: one `•` per UTF-16 code unit, so the caret indices stay the value's. */
export const mask = (value: string): string => '•'.repeat(value.length)

/**
 * `s` on one line: each line break (`\r\n`, `\r` or `\n`: a paste, or a soft keyboard's Enter, into the proxy textarea)
 * becomes a space, the selection and the composition moved with the text. `s` itself when it has none.
 */
export function oneLine(s: ImeState): ImeState {
  if (!/[\r\n]/.test(s.value)) return s
  // a CRLF's CR goes (its LF becomes the space): each index moves left by the CRs of CRLFs before it
  const at = (i: number): number => i - (s.value.slice(0, i).match(/\r(?=\n)/g)?.length ?? 0)
  return {
    value: s.value.replace(/\r\n|[\r\n]/g, ' '),
    selectionStart: at(s.selectionStart), selectionEnd: at(s.selectionEnd),
    composition: s.composition && { start: at(s.composition.start), end: at(s.composition.end) },
  }
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff

/**
 * The edit `prev` → `s` held to `max` code units, as a native `maxlength` does: one that keeps within it, or does not
 * lengthen the text, stands (`s` itself); otherwise its inserted text is cut to what fits (never between a surrogate
 * pair), the caret after it. Null when nothing of the insert fits (the edit is refused).
 */
export function fitLength(prev: string, s: ImeState, max: number): ImeState | null {
  const next = s.value
  if (next.length <= max || next.length <= prev.length) return s
  // the edit: what it kept of `prev` before (head) and after (tail) the text it inserted
  let head = 0
  while (head < prev.length && head < next.length && prev[head] === next[head]) head++
  let tail = 0
  while (tail < prev.length - head && tail < next.length - head && prev[prev.length - 1 - tail] === next[next.length - 1 - tail]) tail++
  let keep = Math.max(0, max - head - tail)
  if (keep > 0 && isHigh(next.charCodeAt(head + keep - 1))) keep--
  if (keep === 0) return null
  const caret = head + keep
  return { value: next.slice(0, caret) + next.slice(next.length - tail), selectionStart: caret, selectionEnd: caret, composition: null }
}

/** A number as a field shows it: plain decimals (`String` writes 1e21 and 1e-7 with an exponent). */
const decimal = (n: number): string => {
  const s = String(n)
  return s.includes('e') ? n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 }) : s
}

/**
 * A model value as a field of `kind` shows it, as an edit would have left it: on one line (each line break a space), a
 * number field's as a number's text (a finite number in plain decimals; a string only when it is one, the IME's
 * full-width forms taken; anything else empty), held to `maxLength` code units (never splitting a surrogate pair).
 */
export function textOf(model: unknown, kind: ImeField['kind'], maxLength?: number): string {
  let t: string
  if (kind === 'number') t = typeof model === 'number' ? (Number.isFinite(model) ? decimal(model) : '') : typeof model === 'string' ? filterNumber('', model.trim()) ?? '' : ''
  else t = (typeof model === 'string' ? model : typeof model === 'number' && Number.isFinite(model) ? String(model) : '').replace(/\r\n|[\r\n]/g, ' ')
  if (maxLength === undefined || t.length <= maxLength) return t
  return t.slice(0, maxLength > 0 && isHigh(t.charCodeAt(maxLength - 1)) ? maxLength - 1 : maxLength)
}
