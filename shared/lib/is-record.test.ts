import { expect, it } from 'vitest'
import { isRecord } from './is-record'

it.each([{}, { a: 1 }, Object.create(null)])('accepts an object (%j)', (value) => {
  expect(isRecord(value)).toBe(true)
})
it.each([null, undefined, [], 'x', 0, false])('rejects a non-object or array (%j)', (value) => {
  expect(isRecord(value)).toBe(false)
})
