import { describe, expect, it, vi } from 'vitest'
import { newTaskId, newTimedTaskId } from './task-id'

describe('newTaskId', () => {
  it('joins the prefix to 6 random bytes of hex by default', () => {
    expect(newTaskId('fl')).toMatch(/^fl_[0-9a-f]{12}$/)
  })

  it('takes a longer byte count when the caller needs one', () => {
    expect(newTaskId('dr', 12)).toMatch(/^dr_[0-9a-f]{24}$/)
  })
})

describe('newTimedTaskId', () => {
  it('joins the prefix, the base36 clock and six base36 chars', () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 })
    try {
      expect(newTimedTaskId('eval')).toMatch(new RegExp(`^eval-${(1_700_000_000_000).toString(36)}-[0-9a-z]{1,6}$`))
    } finally {
      vi.useRealTimers()
    }
  })
})
