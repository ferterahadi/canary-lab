import { describe, expect, it } from 'vitest'
import { parseAssertionError } from './assertion-error'

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
