import { describe, expect, it } from 'vitest'
import { failedNames, passedNames } from './summary-names'

describe('passedNames', () => {
  it('keeps string entries in order, including empty ones', () => {
    expect(passedNames({ passedNames: ['a', 3, '', null, 'b'] })).toEqual(['a', '', 'b'])
  })

  it('reads a missing or non-array list as no names', () => {
    expect(passedNames({})).toEqual([])
    expect(passedNames({ passedNames: 'a' })).toEqual([])
  })
})

describe('failedNames', () => {
  it('keeps each entry\'s non-empty string name in order', () => {
    expect(failedNames({ failed: [{ name: 'a' }, { name: '' }, {}, null, 'b', { name: 7 }, { name: 'c' }] })).toEqual(['a', 'c'])
  })

  it('reads a missing or non-array list as no names', () => {
    expect(failedNames({})).toEqual([])
    expect(failedNames({ failed: { name: 'a' } })).toEqual([])
  })
})
