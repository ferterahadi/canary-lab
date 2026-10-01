import { describe, expect, it } from 'vitest'
import { slugify, summaryEntryName } from './test-names'

describe('test evidence names', () => {
  it.each([
    ['A sad Checkout!', 'a-sad-checkout'],
    ['  version 1.2.3  ', 'version-1-2-3'],
    ['a   b__c!!d', 'a-b-c-d'],
    ['--hi--', 'hi'],
    ['你好', ''],
    ['', ''],
  ])('preserves the existing evidence key for %j', (title, slug) => {
    expect(slugify(title)).toBe(slug)
    expect(summaryEntryName(title)).toBe(`test-case-${slug}`)
  })

  it('preserves legacy collisions instead of minting new identities', () => {
    expect(summaryEntryName('A_B')).toBe(summaryEntryName('a b'))
  })
})
