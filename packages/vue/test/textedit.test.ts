import { describe, it, expect } from 'vitest'
import { filterNumber, fitLength, mask, oneLine, parseNumber, scrollToShow, textOf, wordAt } from '../src/textedit'

describe('filterNumber', () => {
  it.each([
    ['', '1', '1'], ['1', '1.', '1.'], ['1.', '1..', null], ['', '-', '-'], ['1', '1a', null],
    ['', '.', '.'], ['-1', '--1', null], ['1', '1-', null], ['12', '1-2', null], ['', ' 1', null], ['1.5', '1.5.', null],
  ] as const)('%j → %j: %j', (prev, next, want) => {
    expect(filterNumber(prev, next)).toBe(want)
  })
  it('takes the full-width forms a Chinese IME types (digits, ．, －) and its 。 as the ASCII ones, one for one', () => {
    expect(filterNumber('', '１２')).toBe('12')
    expect(filterNumber('3', '3。')).toBe('3.')
    expect(filterNumber('', '－４．５')).toBe('-4.5')
  })
  it('an edit that leaves the text as it was (a caret move) is never refused, whatever the text', () => {
    expect(filterNumber('1e+21', '1e+21')).toBe('1e+21')
  })
})

describe('parseNumber', () => {
  it.each([
    ['-', null], ['1.5', 1.5], ['', null], ['.', null], ['-.', null], ['1.', 1], ['.5', 0.5], ['-0.25', -0.25], ['007', 7],
  ] as const)('%j → %j', (text, want) => {
    expect(parseNumber(text)).toBe(want)
  })
})

describe('wordAt', () => {
  it('the word around a character, by Intl.Segmenter\'s word boundaries', () => {
    expect(wordAt('hello world', 7)).toEqual([6, 11])
    expect(wordAt('hello world', 0)).toEqual([0, 5])
    expect(wordAt('hello world', 5)).toEqual([5, 6])               // the space is its own segment
    expect(wordAt('hello world', 11)).toEqual([6, 11])             // past the end: the last character's word
    const s = [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment('你好世界')]
    const hit = s.find(x => x.index <= 1 && 1 < x.index + x.segment.length)!
    expect(wordAt('你好世界', 1)).toEqual([hit.index, hit.index + hit.segment.length])
    expect(wordAt('你好世界', 1)).toEqual([0, 2])                   // ICU's dictionary: 你好 | 世界
    expect(wordAt('', 0)).toEqual([0, 0])
  })
  it('without Intl.Segmenter: runs of letters and digits, of spaces, or of anything else', () => {
    const saved = Intl.Segmenter
    Object.defineProperty(Intl, 'Segmenter', { value: undefined, configurable: true, writable: true })
    try {
      expect(wordAt('hello world', 7)).toEqual([6, 11])
      expect(wordAt('a  b', 1)).toEqual([1, 3])
      expect(wordAt('x+=y', 1)).toEqual([1, 3])
      expect(wordAt('ab 你好', 4)).toEqual([3, 5])
    } finally {
      Object.defineProperty(Intl, 'Segmenter', { value: saved, configurable: true, writable: true })
    }
  })
})

describe('scrollToShow', () => {
  it('scrolls a caret past the right edge to width − pad, one left of the view to pad; one inside stays', () => {
    expect(scrollToShow(0, 300, 260)).toBe(300 - 260 + 2)
    expect(scrollToShow(100, 50, 260)).toBe(50 - 2)
    expect(scrollToShow(40, 150, 260)).toBe(40)
    expect(scrollToShow(0, 300, 260, 5)).toBe(300 - 260 + 5)
  })
  it('never scrolls before the start', () => {
    expect(scrollToShow(10, 1, 260)).toBe(0)
    expect(scrollToShow(0, 0, 260)).toBe(0)
  })
})

describe('mask', () => {
  it('one bullet per UTF-16 code unit (the caret indices stay the value\'s)', () => {
    expect(mask('ab')).toBe('••')
    expect(mask('')).toBe('')
    expect(mask('a😀')).toBe('•••')
  })
})

describe('oneLine', () => {
  it('each line break becomes a space (CRLF one), the selection and composition moved with the text', () => {
    expect(oneLine({ value: 'a\nb', selectionStart: 3, selectionEnd: 3, composition: null })).toEqual({ value: 'a b', selectionStart: 3, selectionEnd: 3, composition: null })
    expect(oneLine({ value: 'a\r\nb\rc', selectionStart: 4, selectionEnd: 6, composition: { start: 4, end: 6 } }))
      .toEqual({ value: 'a b c', selectionStart: 3, selectionEnd: 5, composition: { start: 3, end: 5 } })
  })
  it('a one-line state is returned as it is', () => {
    const s = { value: 'ab', selectionStart: 1, selectionEnd: 1, composition: null }
    expect(oneLine(s)).toBe(s)
  })
})

describe('fitLength', () => {
  const st = (value: string, at = value.length) => ({ value, selectionStart: at, selectionEnd: at, composition: null })
  it('an edit within the limit, or one that shortens the text, stands as it is', () => {
    const s = st('abc'); expect(fitLength('ab', s, 4)).toBe(s)
    const d = st('abcde'); expect(fitLength('abcdef', d, 4)).toBe(d)
  })
  it('cuts the inserted text to what fits, the caret after it', () => {
    expect(fitLength('abc', st('abXYZc', 5), 4)).toEqual(st('abXc', 3))
    expect(fitLength('abcd', st('aXYZd', 4), 4)).toEqual(st('aXYd', 3))    // 'bc' replaced by a paste
  })
  it('null when nothing of the insert fits; a surrogate pair is never split', () => {
    expect(fitLength('abcd', st('abcdX'), 4)).toBeNull()
    expect(fitLength('ab', st('ab😀'), 3)).toBeNull()
    expect(fitLength('ab', st('abc😀'), 4)).toEqual(st('abc'))
  })
})

describe('textOf', () => {
  it('a model value as a field shows it: on one line, held to maxLength (never splitting a surrogate pair)', () => {
    expect(textOf('a\r\nb\nc', 'text')).toBe('a b c')
    expect(textOf('abcdef', 'text', 4)).toBe('abcd')
    expect(textOf('abc😀', 'password', 4)).toBe('abc')
    expect(textOf(42, 'text')).toBe('42'); expect(textOf(null, 'text')).toBe(''); expect(textOf(undefined, 'text')).toBe('')
  })
  it('a number field\'s format: a number as plain decimals, a string only as far as it is a number', () => {
    expect(textOf(2.5, 'number')).toBe('2.5'); expect(textOf(-0.25, 'number')).toBe('-0.25')
    expect(textOf(1e21, 'number')).toBe('1000000000000000000000'); expect(textOf(1e-7, 'number')).toBe('0.0000001')
    expect(textOf(Number.NaN, 'number')).toBe(''); expect(textOf(null, 'number')).toBe('')
    expect(textOf(' 12 ', 'number')).toBe('12'); expect(textOf('１２。５', 'number')).toBe('12.5'); expect(textOf('12a', 'number')).toBe('')
    expect(textOf(123456, 'number', 4)).toBe('1234')
  })
})
