import { describe, it, expect } from 'vitest'
import { createCanvas } from '@napi-rs/canvas'
import { SystemFontEngine } from '../src/system'

const engine = () => new SystemFontEngine({ createCanvas: (w, h) => createCanvas(w, h) as never, pageSize: 512 })
const font = { family: 'sans-serif', size: 20, weight: 500 }

describe('SystemFontEngine', () => {
  it('measures a single line and uses 1.3× line height', () => {
    const m = engine().measure({ text: 'hello', font }, {})
    expect(m.lines).toHaveLength(1); expect(m.width).toBeGreaterThan(30); expect(m.height).toBe(26)
  })
  it('wraps Latin at spaces and CJK between characters', () => {
    const e = engine()
    const latin = e.measure({ text: 'the quick brown fox jumps', font }, { maxWidth: 120 })
    expect(latin.lines.length).toBeGreaterThan(1)
    for (const l of latin.lines) { expect(l.width).toBeLessThanOrEqual(120 + 0.01); expect(l.text.startsWith(' ')).toBe(false) }
    const cjk = e.measure({ text: '这是一段需要自动换行的中文文本', font }, { maxWidth: 100 })
    expect(cjk.lines.length).toBe(Math.ceil(15 / 5))   // 15 chars, 20px glyphs → 5 per 100px line
  })
  it('mixed CJK + Latin with no spaces breaks between CJK chars and keeps a fitting Latin word whole', () => {
    const lines = engine().measure({ text: '用户名userName必填', font }, { maxWidth: 110 }).lines.map(l => l.text)
    expect(lines.some(l => l.includes('userName'))).toBe(true)
    expect(lines.join('')).toBe('用户名userName必填')
  })
  it('breaks an over-long Latin word by character instead of overflowing', () => {
    const m = engine().measure({ text: 'supercalifragilistic', font }, { maxWidth: 60 })
    for (const l of m.lines) expect(l.width).toBeLessThanOrEqual(60 + 0.01)
  })
  it('lays out glyphs with atlas uvs and rasterizes each glyph once', () => {
    const e = engine()
    const g = e.layout({ text: '你好你', font }, undefined, 'left')
    expect(g).toHaveLength(3)
    expect(g[0]!.u1).toBeGreaterThan(g[0]!.u0)
    expect(g[2]!.u0).toBe(g[0]!.u0)       // same glyph → same atlas slot
    expect(g[1]!.x).toBeGreaterThan(g[0]!.x)
    expect(e.atlas.dirtyPages.size).toBe(1)
    const data = e.atlas.pages[0]!.getContext('2d').getImageData(0, 0, 64, 64).data
    expect(Array.from(data).some(v => v > 0)).toBe(true)   // something was drawn
  })
  it('aligns centre and right', () => {
    const e = engine()
    const left = e.layout({ text: 'ab', font }, 200, 'left'), right = e.layout({ text: 'ab', font }, 200, 'right')
    expect(right[0]!.x).toBeGreaterThan(left[0]!.x)
    // Glyph quads carry PAD / oversample of padding on each side, so the quad edge sits ~1pt past the text edge.
    expect(Math.abs(right[1]!.x + right[1]!.width - 200)).toBeLessThan(3)
  })
})

describe('SystemFontEngine wrapping', () => {
  it('hangs spaces at a soft line end: they neither overflow, start the next line, nor count towards the width', () => {
    const e = engine()
    const w = e.measure({ text: 'aaaa', font }, {}).width
    const m = e.measure({ text: 'aaaa  aaaa', font }, { maxWidth: w })
    expect(m.lines.map(l => l.text)).toEqual(['aaaa  ', 'aaaa'])
    expect(m.lines[0]!.width).toBe(w)
  })
  it('breaks by character when the word carried to a new line still overflows it', () => {
    const e = engine()
    const max = e.measure({ text: 'i WW', font }, {}).width + 1   // 'WW' + 'W' is wider than 'i WW' + 1
    const m = e.measure({ text: 'i WWWW', font }, { maxWidth: max })
    expect(m.lines[0]!.text).toBe('i ')
    for (const l of m.lines) expect(l.width).toBeLessThanOrEqual(max)
  })
  it('keeps every line within maxWidth, loses no text and never starts a wrapped line with a space', () => {
    const e = engine()
    const text = 'GlassUI 用户名userName必填，请输入 supercalifragilistic 文本 ok'
    for (const maxWidth of [25, 40, 60, 90, 130, 200]) {
      const { lines } = e.measure({ text, font }, { maxWidth })
      expect(lines.map(l => l.text).join('')).toBe(text)
      lines.forEach((l, k) => {
        expect(l.width).toBeLessThanOrEqual(maxWidth)
        expect(text.slice(l.start, l.end)).toBe(l.text)
        expect(l.start).toBe(k === 0 ? 0 : lines[k - 1]!.end)
        expect(l.y).toBe(k * 26)
        if (k > 0) expect(l.text.startsWith(' ')).toBe(false)
      })
    }
  })
  it('starts a new line at each hard break, keeping empty lines', () => {
    const m = engine().measure({ text: 'ab\n\ncd\r\nef', font }, {})
    expect(m.lines.map(l => [l.text, l.start, l.end])).toEqual([['ab', 0, 2], ['', 3, 3], ['cd', 4, 6], ['ef', 8, 10]])
    expect(m.height).toBe(4 * 26)
  })
  it('treats a grapheme cluster as one glyph and reports UTF-16 offsets on cluster boundaries', () => {
    const e = engine()
    const text = 'é👍🏽x'   // decomposed é (2 units), thumbs-up + skin tone (4 units), x
    expect(e.layout({ text, font }, undefined, 'left').map(g => g.char)).toEqual(['é', '👍🏽', 'x'])
    expect(e.measure({ text, font }, {}).lines[0]!.end).toBe(text.length)
    const width = e.measure({ text, font }, {}).width
    const hits = new Set<number>()
    for (let x = -5; x <= width + 5; x += 0.5) hits.add(e.caretFromPoint({ text, font }, undefined, x, 5))
    expect([...hits].sort((a, b) => a - b)).toEqual([0, 2, 6, 7])
  })
})

describe('SystemFontEngine layout', () => {
  it('centres glyph quads vertically in a custom line height', () => {
    const g = engine().layout({ text: 'ab\nc', font, lineHeight: 40 }, undefined, 'left')
    expect(g.map(q => q.y + q.height / 2)).toEqual([20, 20, 60])
  })
  it('aligns lines within the widest line when no maxWidth is given', () => {
    const e = engine()
    const right = e.layout({ text: 'a\nlonger', font }, undefined, 'right')
    const a = right[0]!, r = right[right.length - 1]!
    expect(Math.abs(a.x + a.width - (r.x + r.width))).toBeLessThan(1)   // right edges line up (± quad rounding)
    const centre = e.layout({ text: 'a\nlonger', font }, undefined, 'center')
    expect(centre[0]!.x).toBeGreaterThan(0)
  })
  it('skips whitespace when rasterising', () => {
    const e = engine()
    expect(e.layout({ text: 'a b　c', font }, undefined, 'left').map(g => g.char)).toEqual(['a', 'b', 'c'])
  })
})

describe('SystemFontEngine caret and selection', () => {
  const e = engine(), lh = 26
  const width = (text: string) => e.measure({ text, font }, {}).width   // trailing spaces excluded (they hang)
  const space = width('a a') - width('aa')
  const run = { text: 'hello world', font }
  const max = Math.max(width('hello'), width('world')) + 1   // → 'hello ' | 'world'

  it('places a soft-wrap index at the start of the next line and clamps out-of-range indices', () => {
    expect(e.measure(run, { maxWidth: max }).lines.map(l => l.text)).toEqual(['hello ', 'world'])
    expect(e.caretRect(run, max, 0)).toEqual({ x: 0, y: 0, height: lh })
    expect(e.caretRect(run, max, 5)).toEqual({ x: width('hello'), y: 0, height: lh })
    expect(e.caretRect(run, max, 6)).toEqual({ x: 0, y: lh, height: lh })
    expect(e.caretRect(run, max, 11)).toEqual({ x: width('world'), y: lh, height: lh })
    expect(e.caretRect(run, max, 99)).toEqual(e.caretRect(run, max, 11))
    expect(e.caretRect(run, max, -3)).toEqual(e.caretRect(run, max, 0))
  })
  it('keeps the caret on its own line at a hard break and after trailing spaces on the last line', () => {
    const r = { text: 'ab\ncd ', font }
    expect(e.caretRect(r, undefined, 2)).toEqual({ x: width('ab'), y: 0, height: lh })
    expect(e.caretRect(r, undefined, 3)).toEqual({ x: 0, y: lh, height: lh })
    expect(e.caretFromPoint(r, undefined, 1000, 5)).toBe(2)
    expect(e.caretFromPoint(r, undefined, -10, lh + 5)).toBe(3)
    expect(e.caretFromPoint(r, undefined, 1000, lh + 5)).toBe(6)   // after the typed trailing space
    expect(e.caretRect(r, undefined, 6).x).toBeCloseTo(width('cd') + space, 6)
  })
  it('maps a point to the nearest caret index on the line under it', () => {
    const wh = width('h')
    expect(e.caretFromPoint(run, max, wh * 0.4, 5)).toBe(0)
    expect(e.caretFromPoint(run, max, wh * 0.6, 5)).toBe(1)
    expect(e.caretFromPoint(run, max, 1000, 5)).toBe(5)        // past a wrapped line: before its hanging space
    expect(e.caretFromPoint(run, max, -10, lh + 5)).toBe(6)
    expect(e.caretFromPoint(run, max, 1000, 1000)).toBe(11)    // below the text → last line
    expect(e.caretFromPoint(run, max, 1000, -1000)).toBe(5)    // above the text → first line
    for (const [x, y] of [[0, 5], [width('hell'), 5], [1000, 5], [0, lh + 5], [width('wo'), lh + 5]] as const) {
      expect(e.caretRect(run, max, e.caretFromPoint(run, max, x, y)).y).toBe(Math.floor(y / lh) * lh)   // caret stays on the clicked line
    }
  })
  it('returns one selection rect per covered line, in either direction', () => {
    const rects = e.selectionRects(run, max, 3, 8)
    expect(rects).toHaveLength(2)
    expect(rects[0]).toMatchObject({ x: width('hel'), y: 0, height: lh })
    expect(rects[0]!.width).toBeCloseTo(width('lo') + space, 6)   // runs to the line end, hanging space included
    expect(rects[1]).toEqual({ x: 0, y: lh, width: width('wo'), height: lh })
    expect(e.selectionRects(run, max, 8, 3)).toEqual(rects)
    expect(e.selectionRects(run, max, 4, 4)).toEqual([])
  })
})

describe('SystemFontEngine validation', () => {
  it('rejects fonts, sizes and widths that would silently measure with a stale font or produce NaN geometry', () => {
    const e = engine()
    expect(() => e.measure({ text: 'a', font: { ...font, size: 0 } }, {})).toThrow(/\[text\] font size/)
    expect(() => e.measure({ text: 'a', font: { ...font, size: NaN } }, {})).toThrow(/font size/)
    expect(() => e.measure({ text: 'a', font: { ...font, weight: 0 } }, {})).toThrow(/font weight/)
    expect(() => e.measure({ text: 'a', font: { ...font, family: ' ' } }, {})).toThrow(/font family/)
    expect(() => e.measure({ text: 'a', font, lineHeight: 0 }, {})).toThrow(/lineHeight/)
    expect(() => e.measure({ text: 'a', font, letterSpacing: NaN }, {})).toThrow(/letterSpacing/)
    expect(() => e.measure({ text: 'a', font }, { maxWidth: NaN })).toThrow(/maxWidth/)
    expect(() => e.layout({ text: 'a', font }, -1, 'left')).toThrow(/maxWidth/)
    expect(() => new SystemFontEngine({ createCanvas: (w, h) => createCanvas(w, h) as never, oversample: 0 })).toThrow(/oversample/)
  })
  it('treats an infinite maxWidth as unconstrained', () => {
    const e = engine()
    expect(e.measure({ text: 'a b c', font }, { maxWidth: Infinity }).lines).toHaveLength(1)
    expect(e.layout({ text: 'a', font }, Infinity, 'right')[0]!.x).toBe(e.layout({ text: 'a', font }, undefined, 'right')[0]!.x)
  })
})
