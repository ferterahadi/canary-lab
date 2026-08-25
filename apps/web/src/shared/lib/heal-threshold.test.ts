import { describe, expect, it } from 'vitest'
import { DEFAULT_HEAL_ON_FAILURE_THRESHOLD, healDisplayValue, healEnabled } from './heal-threshold'

describe('heal-threshold', () => {
  it('reads an absent threshold as enabled at the default', () => {
    expect(healEnabled(undefined)).toBe(true)
    expect(healDisplayValue(undefined)).toBe(DEFAULT_HEAL_ON_FAILURE_THRESHOLD)
  })

  it('reads an explicit 0 as opted out, still showing the default in the stepper', () => {
    expect(healEnabled(0)).toBe(false)
    // Not `0`: the toggle must come back on at a value that can actually run.
    expect(healDisplayValue(0)).toBe(DEFAULT_HEAL_ON_FAILURE_THRESHOLD)
  })

  it('keeps an explicit positive threshold', () => {
    expect(healEnabled(5)).toBe(true)
    expect(healDisplayValue(5)).toBe(5)
  })
})
