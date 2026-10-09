import { expect, it } from 'vitest'
import { plural, pluralSuffix } from './plural'

it('pairs a count with its regular noun', () => {
  expect(plural(1, 'repo')).toBe('1 repo')
  expect(plural(0, 'repo')).toBe('0 repos')
  expect(plural(3, 'repo')).toBe('3 repos')
})

it('gives the suffix alone for copy that prints the count elsewhere', () => {
  expect(pluralSuffix(1)).toBe('')
  expect(pluralSuffix(0)).toBe('s')
  expect(pluralSuffix(2)).toBe('s')
})
