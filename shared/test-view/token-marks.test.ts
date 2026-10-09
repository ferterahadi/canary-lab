import { describe, expect, it } from 'vitest'
import { compareText } from '../lib/comparison-diff'
import { markHighlightedLine } from './token-marks'

const kw = (text: string) => `<span style="color:#c678dd">${text}</span>`
const id = (text: string) => `<span style="color:#e06c75">${text}</span>`

describe('markHighlightedLine', () => {
  it('cuts inside a token and reopens it, so every segment is balanced markup', () => {
    const html = `${kw('const')}${id(' total = 0.95')}`
    const { after } = compareText('const total = 0.95', 'const total = 0.9')
    expect(markHighlightedLine(html.replace('0.95', '0.9'), after)).toEqual([
      { html: `${kw('const')}${id(' total = 0.')}`, changed: false },
      { html: id('9'), changed: true },
    ])
  })

  it('counts an entity as the one character it stands for', () => {
    const parts = [{ text: 'a < ', changed: false }, { text: 'b', changed: true }, { text: ' & "c" \u00a0éé', changed: false }]
    const segments = markHighlightedLine('a &lt; b &amp; &quot;c&quot; &nbsp;&#233;&#xe9;', parts)
    expect(segments.map((segment) => segment.changed)).toEqual([false, true, false])
    expect(segments[1].html).toBe('b')
    expect(segments[2].html).toBe(' &amp; &quot;c&quot; &nbsp;&#233;&#xe9;')
  })

  it('reopens nested spans and keeps self-closing tags in place', () => {
    const segments = markHighlightedLine('<span class="a"><span class="b">xy</span><br/>z</span>', [
      { text: 'x', changed: true }, { text: '', changed: false }, { text: 'yz', changed: false },
    ])
    expect(segments).toEqual([
      { html: '<span class="a"><span class="b">x</span></span>', changed: true },
      { html: '<span class="a"><span class="b">y</span><br/>z</span>', changed: false },
    ])
  })

  it('marks a whole line as one segment', () => {
    expect(markHighlightedLine(kw('gone'), [{ text: 'gone', changed: true }])).toEqual([{ html: kw('gone'), changed: true }])
  })

  it('returns the line unmarked when its text is not the parts\u2019 text', () => {
    const unmarked = (html: string) => [{ html, changed: false }]
    const parts = [{ text: 'ab', changed: true }]
    expect(markHighlightedLine('abc', parts)).toEqual(unmarked('abc'))
    expect(markHighlightedLine('a', parts)).toEqual(unmarked('a'))
    expect(markHighlightedLine('a&bogus;b', parts)).toEqual(unmarked('a&bogus;b'))
    expect(markHighlightedLine('a & b', parts)).toEqual(unmarked('a & b'))
    expect(markHighlightedLine('<span', parts)).toEqual(unmarked('<span'))
    // A two-unit character overshooting a one-character part cannot be split.
    expect(markHighlightedLine('&#x1F600;', [{ text: 'a', changed: true }, { text: 'b', changed: false }])).toEqual(unmarked('&#x1F600;'))
    expect(markHighlightedLine('', [])).toEqual(unmarked(''))
  })
})
