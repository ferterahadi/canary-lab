import { describe, expect, it } from 'vitest'
import { missingFromRoster } from './mapping-roster'

describe('mapping roster completeness', () => {
  it('keeps missing names in roster order including duplicates', () => {
    expect(missingFromRoster(['missing-b', 'mapped', 'missing-a', 'missing-b', 'unmappable'], [{ testName: 'mapped' }, { testName: 'mapped' }], ['unmappable'])).toEqual(['missing-b', 'missing-a', 'missing-b'])
  })

  it('accepts an answer containing only unmappable tests', () => {
    expect(missingFromRoster(['a', 'b'], [], ['a', 'b'])).toEqual([])
  })

  it('checks only the supplied pinned roster', () => {
    expect(missingFromRoster(['original'], [{ testName: 'original' }, { testName: 'added-later' }], [])).toEqual([])
    expect(missingFromRoster([], [], [])).toEqual([])
    expect(missingFromRoster(['original'], [], [])).toEqual(['original'])
  })
})
