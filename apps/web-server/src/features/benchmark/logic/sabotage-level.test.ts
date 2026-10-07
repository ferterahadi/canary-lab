import { describe, expect, it } from 'vitest'
import { normalizeSabotageLevel } from './sabotage-level'

describe('normalizeSabotageLevel', () => {
  it.each([
    ['min', 'min'], ['med', 'med'], ['max', 'max'],
    [undefined, 'med'], [null, 'med'], ['', 'med'], ['MIN', 'med'],
    [' max ', 'med'], ['unknown', 'med'], [1, 'med'], [false, 'med'], [{}, 'med'],
  ])('normalizes %j to %s', (value, expected) => {
    expect(normalizeSabotageLevel(value)).toBe(expected)
  })
})
