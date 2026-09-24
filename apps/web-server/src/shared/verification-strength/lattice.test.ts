import { describe, expect, it } from 'vitest'
import type { ExpectedShape, TestPredicate } from '../../../../../shared/verification-strength/types'
import { compareTiers, KNOWN_MATCHERS, strengthOf, TIER_RANK } from './lattice'

// Predicates are built by hand here: the lattice is a pure function of the
// collector's fields, and the collector has its own tests. `expectedText` is set
// only where a rule reads it (asymmetric matchers, thrown error types).
function pred(overrides: Partial<TestPredicate> & { matcher: string }): TestPredicate {
  const expected: ExpectedShape = overrides.expected ?? 'none'
  return {
    target: 'el',
    expected,
    expectedArity: expected === 'none' ? 0 : 1,
    negated: false,
    soft: false,
    poll: false,
    line: 1,
    source: '',
    ...overrides,
  }
}

function tierOf(overrides: Partial<TestPredicate> & { matcher: string }): string {
  const strength = strengthOf(pred(overrides))
  return strength.kind === 'ranked' ? strength.tier : `unclassifiable:${strength.reason}`
}

describe('strengthOf — value matchers', () => {
  it('ranks a concrete expected value as exact and a regex or asymmetric one as pattern', () => {
    expect(tierOf({ matcher: 'toHaveText', expected: 'literal' })).toBe('exact')
    expect(tierOf({ matcher: 'toEqual', expected: 'collection' })).toBe('exact')
    expect(tierOf({ matcher: 'toHaveText', expected: 'regex' })).toBe('pattern')
    expect(tierOf({ matcher: 'toEqual', expected: 'asymmetric', expectedText: "expect.objectContaining({ a: 1 })" })).toBe('pattern')
  })

  it('reads expect.anything() / expect.any(T) as existence, not as a pattern', () => {
    expect(tierOf({ matcher: 'toEqual', expected: 'asymmetric', expectedText: 'expect.anything()' })).toBe('existential')
    expect(tierOf({ matcher: 'toBe', expected: 'asymmetric', expectedText: 'expect.any(String)' })).toBe('existential')
  })

  it('refuses to rank a run-time expected value — a page compared with itself is invisible statically', () => {
    expect(tierOf({ matcher: 'toHaveText', expected: 'dynamic', expectedText: 'total' }))
      .toBe('unclassifiable:expected value is computed at run time')
  })

  it('refuses a value matcher with no value — malformed, so nothing can be said', () => {
    expect(tierOf({ matcher: 'toHaveText' })).toBe('unclassifiable:value matcher without a value')
  })

  it('ranks a snapshot against its stored golden: pixels are exact, an aria template is a pattern', () => {
    expect(tierOf({ matcher: 'toHaveScreenshot' })).toBe('exact')
    expect(tierOf({ matcher: 'toHaveScreenshot', expected: 'literal', expectedText: "'home.png'" })).toBe('exact')
    expect(tierOf({ matcher: 'toHaveScreenshot', optionKeys: ['maxDiffPixels'] })).toBe('pattern')
    expect(tierOf({ matcher: 'toMatchSnapshot' })).toBe('exact')
    expect(tierOf({ matcher: 'toMatchAriaSnapshot', expected: 'literal' })).toBe('pattern')
  })

  it('downgrades an exact text match to a pattern under ignoreCase', () => {
    expect(tierOf({ matcher: 'toHaveText', expected: 'literal', optionKeys: ['ignoreCase'] })).toBe('pattern')
    expect(tierOf({ matcher: 'toHaveText', expected: 'literal', optionKeys: ['timeout'] })).toBe('exact')
  })

  it('reads a one-argument attribute/property matcher as existence and two arguments as a value', () => {
    expect(tierOf({ matcher: 'toHaveAttribute', expected: 'literal', expectedArity: 1 })).toBe('existential')
    expect(tierOf({ matcher: 'toHaveAttribute', expected: 'literal', expectedArity: 2 })).toBe('exact')
    expect(tierOf({ matcher: 'toHaveAttribute', expected: 'regex', expectedArity: 2 })).toBe('pattern')
    expect(tierOf({ matcher: 'toHaveProperty', expected: 'literal', expectedArity: 1 })).toBe('existential')
    expect(tierOf({ matcher: 'toHaveCSS', expected: 'dynamic', expectedArity: 2 }))
      .toBe('unclassifiable:expected value is computed at run time')
  })
})

describe('strengthOf — containment, comparison, state, throw', () => {
  it('ranks containment and comparison as pattern whatever concrete value they carry', () => {
    expect(tierOf({ matcher: 'toContainText', expected: 'literal' })).toBe('pattern')
    expect(tierOf({ matcher: 'toMatchObject', expected: 'collection' })).toBe('pattern')
    expect(tierOf({ matcher: 'toMatch', expected: 'regex' })).toBe('pattern')
    expect(tierOf({ matcher: 'toBeGreaterThan', expected: 'literal' })).toBe('pattern')
    expect(tierOf({ matcher: 'toBeCloseTo', expected: 'literal' })).toBe('pattern')
  })

  it('still refuses a run-time value inside containment and comparison', () => {
    expect(tierOf({ matcher: 'toContain', expected: 'dynamic' })).toBe('unclassifiable:expected value is computed at run time')
    expect(tierOf({ matcher: 'toBeLessThan', expected: 'dynamic' })).toBe('unclassifiable:expected value is computed at run time')
    expect(tierOf({ matcher: 'toContainText' })).toBe('unclassifiable:value matcher without a value')
  })

  it('ranks state matchers as existential, options or not', () => {
    expect(tierOf({ matcher: 'toBeVisible' })).toBe('existential')
    expect(tierOf({ matcher: 'toBeChecked', optionKeys: ['checked'] })).toBe('existential')
    expect(tierOf({ matcher: 'toBeTruthy' })).toBe('existential')
    expect(tierOf({ matcher: 'toBeOK' })).toBe('existential')
    expect(tierOf({ matcher: 'toPass' })).toBe('existential')
    expect(tierOf({ matcher: 'toBeInstanceOf', expected: 'dynamic', expectedText: 'Date' })).toBe('existential')
  })

  it('ranks toThrow by what it names: nothing → existence, a message → pattern, an error class → existence', () => {
    expect(tierOf({ matcher: 'toThrow' })).toBe('existential')
    expect(tierOf({ matcher: 'toThrowError', expected: 'literal' })).toBe('pattern')
    expect(tierOf({ matcher: 'toThrow', expected: 'regex' })).toBe('pattern')
    expect(tierOf({ matcher: 'toThrow', expected: 'dynamic', expectedText: 'TypeError' })).toBe('existential')
    expect(tierOf({ matcher: 'toThrow', expected: 'dynamic', expectedText: 'expectedError' }))
      .toBe('unclassifiable:expected value is computed at run time')
  })
})

describe('strengthOf — modifiers and unknowns', () => {
  it('never ranks a negated predicate above existential — excluding one value pins nothing', () => {
    expect(tierOf({ matcher: 'toHaveText', expected: 'literal', negated: true })).toBe('existential')
    expect(tierOf({ matcher: 'toContainText', expected: 'literal', negated: true })).toBe('existential')
    expect(tierOf({ matcher: 'toBeVisible', negated: true })).toBe('existential')
  })

  it('ignores soft, poll and settlement — they change when a failure is reported, not what is proven', () => {
    expect(tierOf({ matcher: 'toBe', expected: 'literal', soft: true })).toBe('exact')
    expect(tierOf({ matcher: 'toBe', expected: 'literal', poll: true })).toBe('exact')
    expect(tierOf({ matcher: 'toBe', expected: 'literal', settlement: 'resolves' })).toBe('exact')
  })

  it('refuses a matcher it has no rule for, naming it', () => {
    const strength = strengthOf(pred({ matcher: 'toBeCustom', expected: 'literal' }))
    expect(strength).toEqual({ kind: 'unclassifiable', family: 'unknown', reason: 'unknown matcher toBeCustom' })
  })

  it('reports the family beside the tier', () => {
    expect(strengthOf(pred({ matcher: 'toHaveCount', expected: 'literal' })))
      .toEqual({ kind: 'ranked', tier: 'exact', family: 'value' })
    expect(strengthOf(pred({ matcher: 'toBeHidden' })))
      .toEqual({ kind: 'ranked', tier: 'existential', family: 'state' })
    expect(strengthOf(pred({ matcher: 'toHaveText', expected: 'dynamic' })))
      .toEqual({ kind: 'unclassifiable', family: 'value', reason: 'expected value is computed at run time' })
  })
})

describe('the matcher table', () => {
  it('has a rule for every matcher Playwright 1.62 declares — a new one must be triaged, not guessed', () => {
    // Read out of node_modules/playwright/types/test.d.ts (1.62). When Playwright
    // adds a matcher this list is where it gets added, with a family decision.
    const playwright162 = [
      'toBe', 'toBeAttached', 'toBeChecked', 'toBeCloseTo', 'toBeDefined', 'toBeDisabled', 'toBeEditable',
      'toBeEmpty', 'toBeEnabled', 'toBeFalsy', 'toBeFocused', 'toBeGreaterThan', 'toBeGreaterThanOrEqual',
      'toBeHidden', 'toBeInViewport', 'toBeInstanceOf', 'toBeLessThan', 'toBeLessThanOrEqual', 'toBeNaN',
      'toBeNull', 'toBeOK', 'toBeTruthy', 'toBeUndefined', 'toBeVisible', 'toContain', 'toContainClass',
      'toContainEqual', 'toContainText', 'toEqual', 'toHaveAccessibleDescription', 'toHaveAccessibleErrorMessage',
      'toHaveAccessibleName', 'toHaveAttribute', 'toHaveCSS', 'toHaveClass', 'toHaveCount', 'toHaveId',
      'toHaveJSProperty', 'toHaveLength', 'toHaveProperty', 'toHaveRole', 'toHaveScreenshot', 'toHaveText',
      'toHaveTitle', 'toHaveURL', 'toHaveValue', 'toHaveValues', 'toMatch', 'toMatchAriaSnapshot', 'toMatchObject',
      'toMatchSnapshot', 'toPass', 'toStrictEqual', 'toThrow', 'toThrowError',
    ]
    const missing = playwright162.filter((matcher) => !KNOWN_MATCHERS.has(matcher))
    expect(missing).toEqual([])
    expect(KNOWN_MATCHERS.size).toBe(playwright162.length)
  })
})

describe('compareTiers', () => {
  it('orders none < existential < pattern < exact', () => {
    expect(TIER_RANK).toEqual({ none: 0, existential: 1, pattern: 2, exact: 3 })
    expect(compareTiers('exact', 'pattern')).toBe(1)
    expect(compareTiers('pattern', 'exact')).toBe(-1)
    expect(compareTiers('existential', 'existential')).toBe(0)
    expect(compareTiers('none', 'existential')).toBe(-1)
  })
})
