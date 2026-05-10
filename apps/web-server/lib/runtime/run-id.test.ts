import { describe, it, expect } from 'vitest'
import {
  formatTimestamp,
  generateRunId,
  isValidRunId,
  randomSuffix,
  RUN_ID_RE,
} from './run-id'

describe('formatTimestamp', () => {
  it('zero-pads month/day/hour/minute', () => {
    expect(formatTimestamp(new Date(Date.UTC(2026, 0, 1, 5, 7)))).toBe(
      '2026-01-01T0507',
    )
  })

  it('handles double-digit fields', () => {
    expect(formatTimestamp(new Date(Date.UTC(2026, 11, 31, 23, 59)))).toBe(
      '2026-12-31T2359',
    )
  })
})

describe('randomSuffix', () => {
  it('emits the requested length', () => {
    expect(randomSuffix(() => 0, 6)).toHaveLength(6)
  })

  it('uses only lowercase alphanumerics', () => {
    const out = randomSuffix(() => 0.5, 100)
    expect(out).toMatch(/^[a-z0-9]+$/)
  })

  it('changes with random output', () => {
    const a = randomSuffix(() => 0)
    const b = randomSuffix(() => 0.9)
    expect(a).not.toBe(b)
  })

  it('defaults to length 4 with Math.random', () => {
    expect(randomSuffix()).toHaveLength(4)
  })
})

describe('generateRunId', () => {
  it('combines timestamp + suffix', () => {
    const id = generateRunId({
      now: () => new Date(Date.UTC(2026, 3, 28, 10, 15)),
      random: () => 0,
    })
    expect(id).toBe('2026-04-28T1015-aaaa')
  })

  it('matches the canonical regex', () => {
    const id = generateRunId({
      now: () => new Date(Date.UTC(2026, 3, 28, 10, 15)),
      random: () => 0.5,
    })
    expect(RUN_ID_RE.test(id)).toBe(true)
  })

  it('uses real defaults when no injection given', () => {
    const id = generateRunId()
    expect(isValidRunId(id)).toBe(true)
  })
})

describe('isValidRunId', () => {
  it('accepts canonical IDs', () => {
    expect(isValidRunId('2026-04-28T1015-abc1')).toBe(true)
  })

  it('rejects malformed IDs', () => {
    expect(isValidRunId('2026-04-28-abc1')).toBe(false)
    expect(isValidRunId('not-an-id')).toBe(false)
    expect(isValidRunId('')).toBe(false)
  })
})
