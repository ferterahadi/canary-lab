import { describe, expect, it } from 'vitest'
import { flightNotificationSources, testReviewNotificationSources } from './sources'
import type { FlightIndexEntry } from '../../../../../shared/flights/types'

const flight = (over: Partial<FlightIndexEntry> = {}): FlightIndexEntry => ({ flightId: 'f1', feature: 'shop', status: 'paused', pauseReason: 'stage-failed', currentStage: 'run', ...over } as FlightIndexEntry)

describe('notification sources', () => {
  it('keeps one identity during unchanged attention even if the flight is saved again', () => {
    const [first] = flightNotificationSources([flight({ updatedAt: 't1' })])
    const [second] = flightNotificationSources([flight({ updatedAt: 't2' })])
    expect(first).toEqual(second)
    expect(first.message?.target).toEqual({ kind: 'flight', flightId: 'f1' })
    expect(first.message).toMatchObject({ title: 'shop: Test run failed', toast: true })
    expect(flightNotificationSources([flight({ currentStage: 'docs' })])[0].signature).not.toBe(first.signature)
  })
  it('does not demand input for a user pause, queue park, or external agent', () => {
    for (const over of [{ pauseReason: 'user' }, { pauseReason: 'queued' }, { stageProducer: 'external' }, { status: 'waiting-for-approval', checkpointKind: 'external-work' }] as Partial<FlightIndexEntry>[]) {
      expect(flightNotificationSources([flight(over)])[0].message).toBeUndefined()
    }
    expect(flightNotificationSources([flight({ status: 'waiting-for-approval', pauseReason: undefined, checkpointKind: 'config-approval', currentStage: 'scaffold' })])[0].message).toMatchObject({
      title: 'shop: Does this setup look right?', body: 'Suite setup cannot continue until you respond.', toast: true,
    })
    expect(flightNotificationSources([flight({ status: 'waiting-for-approval', pauseReason: undefined, checkpointKind: 'run-failed' })])[0].message?.title)
      .toBe('shop: The test run did not pass — rerun or build the report?')
    expect(flightNotificationSources([flight({ pauseReason: 'restart' })])[0].message).toMatchObject({
      title: 'shop: Test run was interrupted', body: 'The server restarted. Open Flight to resume.', toast: true,
    })
  })
  it('links a healing run with pending edits directly to test review, and retires the notification when it resumes', () => {
    const run = { runId: 'r1', feature: 'shop', status: 'healing', pendingSpecEdits: 1 }
    expect(testReviewNotificationSources([run])[0]).toMatchObject({ key: 'test-review:shop', signature: 'attention', message: { body: expect.stringContaining('Review the changes to continue the run'), toast: true, target: { kind: 'test-review', feature: 'shop', runId: 'r1' } } })
    expect(testReviewNotificationSources([{ ...run, status: 'passed' }])).toEqual([])
    expect(testReviewNotificationSources([{ ...run, pendingSpecEdits: 0 }])).toEqual([])
  })
})

describe('test changes in the shared inbox', () => {
  const changes = (verdict: 'weaker' | 'equivalent' | 'stronger' | 'unclassifiable' = 'weaker') => [{ featureId: 'shop', status: 'dirty' as const, dirtySpecs: [{ strength: { verdict } }] }]

  it('reports weakening outside an active run as an advisory review notification', () => {
    const [source] = testReviewNotificationSources([], changes())
    expect(source.message).toMatchObject({ severity: 'danger', toast: false, target: { kind: 'test-review', feature: 'shop' } })
    expect(source.message?.title).toContain('possible test weakening')
    expect(source.message?.body).toContain('A check found a possible weakening')
  })

  it('uses one feature alert while an active run owns the review and updates it in place on escalation', () => {
    const run = { runId: 'r1', feature: 'shop', status: 'healing', pendingSpecEdits: 1 }
    const [weak] = testReviewNotificationSources([run], changes())
    const [ordinary] = testReviewNotificationSources([run], changes('equivalent'))
    expect(weak).toMatchObject({ key: 'test-review:shop', signature: 'attention', message: { severity: 'danger', toast: true, target: { kind: 'test-review', feature: 'shop', runId: 'r1' } } })
    expect(ordinary).toMatchObject({ key: weak.key, signature: weak.signature, message: { severity: 'warning', toast: true } })
    expect(testReviewNotificationSources([{ ...run, status: 'passed' }], changes())[0].message).toMatchObject({ severity: 'danger', toast: false, target: { kind: 'test-review', feature: 'shop' } })
  })

  it.each(['equivalent', 'stronger', 'unclassifiable'] as const)('keeps ordinary %s edits inline unless they block an active run', (verdict) => {
    const [record] = changes(verdict)
    const [source] = testReviewNotificationSources([], [record])
    expect(source).toEqual({ key: 'test-review:shop', signature: 'quiet' })
    expect(testReviewNotificationSources([{ runId: 'r1', feature: 'shop', status: 'healing', pendingSpecEdits: 2 }], [record])[0]).toMatchObject({
      key: source.key, signature: 'attention', message: { title: 'shop: tests changed', severity: 'warning', toast: true, body: expect.stringContaining('2 test files changed'), target: { kind: 'test-review', feature: 'shop', runId: 'r1' } },
    })
    expect(testReviewNotificationSources([], [{ ...record, status: 'clean' }])[0].message).toBeUndefined()
    expect(testReviewNotificationSources([], [{ ...record, dirtySpecs: [] }])[0].message).toBeUndefined()
  })

  it('coalesces concurrent pending runs for one feature onto its newest run', () => {
    const runs = [
      { runId: 'new', feature: 'shop', status: 'healing', pendingSpecEdits: 2 },
      { runId: 'old', feature: 'shop', status: 'running', pendingSpecEdits: 1 },
    ]
    const sources = testReviewNotificationSources(runs)
    expect(sources).toHaveLength(1)
    expect(sources[0].message?.target).toEqual({ kind: 'test-review', feature: 'shop', runId: 'new' })
  })
})
