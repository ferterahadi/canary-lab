import { expect, it } from 'vitest'
import { coverageTimeout } from './test-coverage'

it('bounds coverage by default and accepts an explicit wall-clock budget', () => {
  expect(coverageTimeout(undefined)).toBe(180_000)
  expect(coverageTimeout('1000')).toBe(1000)
  for (const value of ['', '0', '-1', 'Infinity', 'NaN', '1.5']) expect(() => coverageTimeout(value)).toThrow('positive integer')
})
