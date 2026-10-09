import { describe, expect, it } from 'vitest'
import { playbackTests, playbackFocusCase } from './run-detail-playback'
import { collidingTests } from '@shared/__fixtures__/summary-test-identity'
import type { PlaywrightPlaybackEvent } from '@shared/playback'

const end = (test: typeof collidingTests[number], time = '2026-01-01T00:00:00Z'): PlaywrightPlaybackEvent =>
  ({ type: 'test-end', test, time, status: 'failed', passed: false, durationMs: 1, retry: 0 })

describe('playback focus', () => {
  it('distinguishes colliding names and refuses ambiguous or conflicting targets', () => {
    const tests = playbackTests(collidingTests.map((test) => end(test)), undefined, collidingTests)
    expect(playbackFocusCase(tests, collidingTests[1])).toBe(tests[1].caseKey)
    expect(playbackFocusCase(tests, { ...collidingTests[1], location: collidingTests[0].location })).toBeUndefined()
    expect(playbackFocusCase(tests, { name: 'older title', id: 'second' })).toBe(tests[1].caseKey)
    expect(playbackFocusCase(tests, { ...collidingTests[1], location: 'helpers/checkout.ts:1' })).toBe(tests[1].caseKey)
    expect(playbackFocusCase(tests, { name: collidingTests[0].name })).toBeUndefined()
    expect(playbackFocusCase(tests, { ...collidingTests[1], id: 'stale' })).toBe(tests[1].caseKey)
    expect(playbackFocusCase(tests, { name: 'wrong', location: collidingTests[0].location })).toBeUndefined()
    expect(playbackFocusCase(tests, { name: collidingTests[0].name, id: 'missing' })).toBeUndefined()
    expect(playbackFocusCase([{ ...tests[0], ids: ['shared'] }, { ...tests[1], ids: ['shared'] }], { name: 'x', id: 'shared' })).toBeUndefined()
    expect(playbackFocusCase([{ ...tests[0] }, { ...tests[0], caseKey: 'other' }], { name: tests[0].name, location: tests[0].location })).toBeUndefined()
  })
  it('retains earlier ids and locations when a unique roster test moves and returns', () => {
    const first = collidingTests[0]
    const moved = { ...first, id: 'moved', location: 'e2e/checkout.spec.ts:20' }
    const events = [end(first), end(moved, '2026-01-01T00:00:01Z'), end(first, '2026-01-01T00:00:02Z')]
    const tests = playbackTests(events, undefined, [first])
    expect(tests).toHaveLength(1)
    expect(tests[0].ids).toEqual(['first', 'moved'])
    expect(playbackFocusCase(tests, moved, [first])).toBe(tests[0].caseKey)
    expect(playbackFocusCase(tests, { ...first, id: 'old', location: 'e2e/checkout.spec.ts:90' }, [first])).toBe(tests[0].caseKey)
    expect(playbackFocusCase(tests, { ...first, id: undefined, location: undefined })).toBe(tests[0].caseKey)
    expect(playbackFocusCase([], first, [first])).toBeUndefined()
    expect(playbackTests(events, undefined, [{ name: 'absent' }, { ...first, id: undefined, location: undefined }])).toHaveLength(2)
  })
})
