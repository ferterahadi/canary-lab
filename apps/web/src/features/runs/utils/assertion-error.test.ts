import { describe, expect, it } from 'vitest'
import { errorLayout, matcherCaption, parseAssertionError, parseCodeFrame } from './assertion-error'

describe('parseAssertionError', () => {
  it('splits a matcher failure into its headline and the expected/received pair', () => {
    expect(parseAssertionError('Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "ready"\nReceived: "broken"')).toEqual({
      headline: 'Error: expect(received).toBe(expected) // Object.is equality',
      expected: { label: 'Expected', value: '"ready"' },
      received: { label: 'Received', value: '"broken"' },
      rest: '',
    })
  })

  it('keeps qualified labels and every unplaced line, in order', () => {
    const parts = parseAssertionError([
      'Error: expect(locator).toHaveText(expected) failed',
      '',
      'Locator: getByRole(\'heading\')',
      'Expected pattern: /Order confirmed/',
      'Received string:  "Checkout"',
      'Timeout: 5000ms',
      '',
      'Call log:',
      '  - waiting for getByRole(\'heading\')',
    ].join('\n'))
    expect(parts?.expected).toEqual({ label: 'Expected pattern', value: '/Order confirmed/' })
    expect(parts?.received).toEqual({ label: 'Received string', value: '"Checkout"' })
    expect(parts?.rest).toBe('Locator: getByRole(\'heading\')\nTimeout: 5000ms\n\nCall log:\n  - waiting for getByRole(\'heading\')')
  })

  it('leaves a message without both sides to the verbatim block', () => {
    expect(parseAssertionError('TypeError: cannot read properties of undefined')).toBeNull()
    expect(parseAssertionError('Error: expect(received).toEqual(expected)\n\n- Expected  - 1\n+ Received  + 1')).toBeNull()
    expect(parseAssertionError('Expected: "a"\nReceived: "b"')).toBeNull()
  })
})

describe('matcherCaption', () => {
  it('names the matcher and its comparison note', () => {
    expect(matcherCaption('expect(received).toBe(expected) // Object.is equality')).toBe('toBe · Object.is equality')
    expect(matcherCaption('Error: expect(locator).not.toBeVisible()')).toBe('toBeVisible')
  })

  it('leaves a sentence alone', () => {
    expect(matcherCaption('Error: RERATE_MONTH run started off minute 17')).toBeNull()
  })
})

describe('errorLayout', () => {
  it('moves a custom message forward and the matcher line into the caption', () => {
    const parts = parseAssertionError('Error: run started off minute 17\n\nexpect(received).toBe(expected) // Object.is equality\n\nExpected: "0"\nReceived: "1"\n\nCall log:\n  - waited')!
    expect(errorLayout(parts)).toEqual({ message: 'run started off minute 17', caption: 'toBe · Object.is equality', rest: 'Call log:\n  - waited' })
  })

  it('has no sentence when the headline is the matcher line', () => {
    const parts = parseAssertionError('Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "ready"\nReceived: "broken"')!
    expect(errorLayout(parts)).toEqual({ message: '', caption: 'toBe · Object.is equality', rest: '' })
  })

  it('keeps context that is not a matcher line', () => {
    const parts = parseAssertionError('Error: total is off\nExpected: 90\nReceived: 95\nTimeout 5000ms exceeded.')!
    expect(errorLayout(parts)).toEqual({ message: 'total is off', caption: null, rest: 'Timeout 5000ms exceeded.' })
  })
})

describe('parseCodeFrame', () => {
  it('numbers each line, marks the failing one, and drops the caret row', () => {
    expect(parseCodeFrame("   97 |   `run`,\n>  98 |   ).toBe('0')\n      |     ^\n   99 | }")).toEqual([
      { line: 97, text: '  `run`,', failing: false },
      { line: 98, text: "  ).toBe('0')", failing: true },
      { line: 99, text: '}', failing: false },
    ])
  })

  it('declines a snippet that is not a code frame', () => {
    expect(parseCodeFrame('at checkout.spec.ts:12')).toBeNull()
    expect(parseCodeFrame('\n')).toBeNull()
  })
})
