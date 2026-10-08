import { describe, expect, it } from 'vitest'
import { buildPlaybackIdentity, latestPlaybackAttempt, reconcilePlaybackCases } from './playback-identity'
import type { PlaywrightPlaybackEvent } from './playback'

const test = (line: number, id?: string) => ({ name: 'renders', title: 'renders', location: `page.spec.ts:${line}`, ...(id ? { id } : {}) })
const end = (line: number, time: string, passed = true): PlaywrightPlaybackEvent => ({ type: 'test-end', test: test(line), time, status: passed ? 'passed' : 'failed', passed, retry: 0, durationMs: 1 })

describe('playback identity', () => {
  it('separates declared duplicate titles, including column suffixes and unlisted evidence', () => {
    const events = [end(10, '1', false), end(20, '2'), end(30, '3')]
    const projection = buildPlaybackIdentity(events, [test(10), { ...test(20), location: 'page.spec.ts:20:3' }])
    expect(new Set(projection.eventKeys.map((key) => key?.caseKey)).size).toBe(3)
  })
  it('folds a moved declared test but preserves ambiguous legacy evidence', () => {
    const events = [end(10, '1'), end(20, '2')]
    expect(new Set(buildPlaybackIdentity(events, [test(10)]).eventKeys.map((key) => key?.caseKey)).size).toBe(1)
    expect(new Set(buildPlaybackIdentity(events).eventKeys.map((key) => key?.caseKey)).size).toBe(2)
    expect(new Set(buildPlaybackIdentity(events, [], [{ file: 'page.spec.ts', title: 'renders' }]).eventKeys.map((key) => key?.caseKey)).size).toBe(1)
  })
  it('assigns concurrent steps by id and leaves ambiguous legacy steps unassigned', () => {
    const events: PlaywrightPlaybackEvent[] = [
      { type: 'test-begin', test: test(10, 'a'), time: '1' },
      { type: 'test-begin', test: test(20, 'b'), time: '2' },
      { type: 'step-begin', test: { id: 'a', name: 'renders', title: 'renders' }, time: '3', step: { title: 'click', category: 'pw:api' } },
      { type: 'step-begin', test: { name: 'renders', title: 'renders' }, time: '4', step: { title: 'click', category: 'pw:api' } },
    ]
    const keys = buildPlaybackIdentity(events).eventKeys
    expect(keys[2]).toEqual(keys[0])
    expect(keys[3]).toBeNull()
    expect(keys[0]).not.toEqual(keys[1])
  })
  it('selects the latest timestamp, then event order, including live attempts', () => {
    const a = { endedAt: '3' }
    const b = { endedAt: '2' }
    const live = { startedAt: '4' }
    expect(latestPlaybackAttempt([a, b])).toBe(a)
    expect(latestPlaybackAttempt([a, live])).toBe(live)
    expect(latestPlaybackAttempt([a, { endedAt: '3' }])).not.toBe(a)
    expect(latestPlaybackAttempt([])).toBeUndefined()
  })
  it('retains declared entries without attempts and deduplicates exact roster rows', () => {
    expect(reconcilePlaybackCases([test(10), test(10)], [])).toEqual([{ entry: test(10), declared: true, attempts: [] }])
  })
})

it('preserves unlocated legacy entries and opaque locations', () => {
  const known = [{ name: 'legacy' }]
  expect(reconcilePlaybackCases(known, [{ name: 'legacy' }])).toHaveLength(1)
  expect(reconcilePlaybackCases([], [{ name: 'legacy', location: 'opaque' }])[0].entry.location).toBe('opaque')
  expect(latestPlaybackAttempt([{}, {}])).toEqual({})
})
it('uses name and location when legacy active attempts share a name', () => {
  const events: PlaywrightPlaybackEvent[] = [
    { type: 'test-begin', test: test(10), time: '1' },
    { type: 'test-begin', test: test(20), time: '2' },
    end(20, '3'),
    { type: 'step-end', time: '4', test: { name: 'other', title: 'other' }, step: { title: 'click', category: 'pw:api' } },
    { ...end(30, '5'), test: { name: 'other', title: 'other', location: 'other.spec.ts:30' } },
  ]
  const keys = buildPlaybackIdentity(events).eventKeys
  expect(keys[2]).toEqual(keys[1])
  expect(keys[4]).toEqual(keys[3])
  expect(keys[0]).not.toEqual(keys[1])
})
it('honors supplied case identities even when source declarations later change', () => {
  const attempts = [{ ...test(10), caseKey: 'first' }, { ...test(20), caseKey: 'second' }]
  expect(reconcilePlaybackCases([], attempts, [{ file: 'page.spec.ts', title: 'renders' }])).toHaveLength(2)
})
