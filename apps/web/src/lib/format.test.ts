import { describe, it, expect } from 'vitest'
import {
  statusBadgeClass,
  formatDuration,
  durationBetween,
  shortTime,
} from './format'

describe('statusBadgeClass', () => {
  it.each([
    ['passed', 'emerald'],
    ['failed', 'rose'],
    ['running', 'sky'],
    ['healing', 'amber'],
    ['aborted', 'zinc'],
  ] as const)('maps %s to a class containing %s', (status, hue) => {
    expect(statusBadgeClass(status)).toContain(hue)
  })

  it('falls back to a zinc-toned class for unknown statuses', () => {
    expect(statusBadgeClass('mystery' as never)).toContain('zinc')
  })
})

describe('formatDuration', () => {
  it('formats sub-second durations as ms', () => {
    expect(formatDuration(250)).toBe('250ms')
  })
  it('formats sub-minute durations with one decimal second', () => {
    expect(formatDuration(12_500)).toBe('12.5s')
  })
  it('formats multi-minute durations as Mm Ss', () => {
    expect(formatDuration(125_000)).toBe('2m 5s')
  })
  it('returns em-dash for negative or non-finite input', () => {
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
  })
})

describe('durationBetween', () => {
  it('returns null when end is missing', () => {
    expect(durationBetween('2026-01-01T00:00:00Z')).toBeNull()
  })
  it('returns positive ms when end is after start', () => {
    expect(durationBetween('2026-01-01T00:00:00Z', '2026-01-01T00:00:30Z')).toBe(30_000)
  })
  it('clamps negative ranges to zero', () => {
    expect(durationBetween('2026-01-01T00:00:30Z', '2026-01-01T00:00:00Z')).toBe(0)
  })
  it('returns null when timestamps are unparseable', () => {
    expect(durationBetween('not-a-date', 'also-bad')).toBeNull()
  })
})

describe('shortTime', () => {
  it('returns HH:MM:SS for parseable ISO timestamps', () => {
    // Build a known local-time string so the assertion is timezone-agnostic.
    const d = new Date(2026, 3, 29, 13, 4, 5)
    expect(shortTime(d.toISOString())).toBe('13:04:05')
  })
  it('returns the raw value when the input is not a date', () => {
    expect(shortTime('garbage')).toBe('garbage')
  })
})
