import { describe, expect, it } from 'vitest'
import { activityDate, chronologicalActivity } from './agent-activity-timeline'

describe('chronologicalActivity', () => {
  it('orders overlapping sources by full instant and preserves replay order in the input', () => {
    const rows = [
      { id: 'answer', source: 'first', sequence: 1, timestamp: '2026-10-02T12:05:09+08:00' },
      { id: 'abort', source: 'system', sequence: 0, timestamp: '2026-10-02T11:58:30+08:00' },
      { id: 'next', source: 'second', sequence: 0, timestamp: '2026-10-02T03:59:03Z' },
      { id: 'older', source: 'external', sequence: 0, timestamp: '2026-10-01T18:17:30+08:00' },
    ]
    expect(chronologicalActivity(rows).map((row) => row.id)).toEqual(['older', 'abort', 'next', 'answer'])
    expect(rows[0].id).toBe('answer')
  })

  it('keeps unknown dates honest and equal timestamps stable across arrival order', () => {
    const rows = [
      { id: 'b', source: 'a', sequence: 1, timestamp: '2026-10-02T00:00:00Z' },
      { id: 'unknown', source: 'legacy', sequence: 0, timestamp: 'invalid' },
      { id: 'a', source: 'a', sequence: 0, timestamp: '2026-10-02T08:00:00+08:00' },
    ]
    expect(chronologicalActivity(rows).map((row) => row.id)).toEqual(['unknown', 'a', 'b'])
    expect(chronologicalActivity([...rows].reverse())).toEqual(chronologicalActivity(rows))
    expect(activityDate('invalid')).toBe('Time unavailable')
  })
})
