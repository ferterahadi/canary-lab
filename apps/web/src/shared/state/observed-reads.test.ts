import { expect, it } from 'vitest'
import { createObservedReads } from './observed-reads'

it('suppresses duplicate reads and lets observations supersede them independently', () => {
  const reads = createObservedReads()
  const first = reads.begin('a')!
  const other = reads.begin('b')!
  expect(reads.begin('a')).toBeNull()
  reads.invalidate('a')
  const next = reads.begin('a')!
  reads.finish('a', first)
  expect(reads.current('a', first)).toBe(false)
  expect(reads.current('a', next)).toBe(true)
  expect(reads.current('b', other)).toBe(true)
  reads.finish('a', next)
  expect(reads.begin('a')).not.toBeNull()
  reads.clear()
  expect(reads.current('b', other)).toBe(false)
  expect(reads.begin('b')).not.toBeNull()
})
