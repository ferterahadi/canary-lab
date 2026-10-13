import { describe, expect, it } from 'vitest'
import { fileCountLabel, isTestPath } from './repair-files'

describe('isTestPath', () => {
  it('flags the spec and unit-test suffixes a repair must not have touched', () => {
    expect(isTestPath('e2e/checkout.spec.ts')).toBe(true)
    expect(isTestPath('src/lib/tax.test.ts')).toBe(true)
    expect(isTestPath('apps/web/src/ui/Card.test.tsx')).toBe(true)
    expect(isTestPath('src/store.spec.mjs')).toBe(true)
  })

  it('leaves product code inside a test-shaped directory alone', () => {
    // Matching on a `tests/` path segment would flag a product fixture folder
    // as a broken repair rule; the suffix is the honest signal.
    expect(isTestPath('src/tests/fixtures/order.ts')).toBe(false)
    expect(isTestPath('e2e/helpers/login.ts')).toBe(false)
    expect(isTestPath('src/api/orders.ts')).toBe(false)
  })
})

describe('fileCountLabel', () => {
  it('agrees with itself on one', () => {
    expect(fileCountLabel(1)).toBe('1 file')
    expect(fileCountLabel(0)).toBe('0 files')
    expect(fileCountLabel(40)).toBe('40 files')
  })
})
