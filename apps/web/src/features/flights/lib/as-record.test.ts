import { expect, it } from 'vitest'
import { asRecord } from './as-record'

it('passes a plain object through and maps everything else to null', () => {
  const obj = { a: 1 }
  expect(asRecord(obj)).toBe(obj)
  expect(asRecord([1])).toBeNull()
  expect(asRecord(null)).toBeNull()
  expect(asRecord(undefined)).toBeNull()
  expect(asRecord('text')).toBeNull()
  expect(asRecord(0)).toBeNull()
})
