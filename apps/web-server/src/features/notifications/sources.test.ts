import { describe, expect, it } from 'vitest'
import { coverageNotificationSources, flightNotificationSources, testReviewNotificationSources, verificationNotificationSources } from './sources'
import type { FlightIndexEntry } from '../../../../../shared/flights/types'
import type { FeatureCoverageChange } from '../../../../../shared/coverage/freshness'

const flight = (over: Partial<FlightIndexEntry> = {}): FlightIndexEntry => ({ flightId: 'f1', feature: 'shop', status: 'paused', pauseReason: 'stage-failed', currentStage: 'run', ...over } as FlightIndexEntry)

describe('notification sources', () => {
  it('keeps one identity during unchanged attention even if the flight is saved again', () => {
    const [first] = flightNotificationSources([flight({ updatedAt: 't1' })])
    const [second] = flightNotificationSources([flight({ updatedAt: 't2' })])
    expect(first).toEqual(second)
    expect(first.message?.target).toEqual({ kind: 'flight', flightId: 'f1' })
    expect(first.message?.body).toContain('failed')
    expect(flightNotificationSources([flight({ currentStage: 'docs' })])[0].signature).not.toBe(first.signature)
  })
  it('does not demand input for a user pause, queue park, or external agent', () => {
    for (const over of [{ pauseReason: 'user' }, { pauseReason: 'queued' }, { stageProducer: 'external' }, { status: 'waiting-for-approval', checkpointKind: 'external-work' }] as Partial<FlightIndexEntry>[]) {
      expect(flightNotificationSources([flight(over)])[0].message).toBeUndefined()
    }
    expect(flightNotificationSources([flight({ status: 'waiting-for-approval', pauseReason: undefined, checkpointKind: 'config-approval' })])[0].message?.title).toContain('needs input')
    expect(flightNotificationSources([flight({ pauseReason: 'restart' })])[0].message?.body).toContain('interrupted')
  })
  it('links a healing run with pending edits directly to test review, and retires the notification when it resumes', () => {
    const run = { runId: 'r1', feature: 'shop', status: 'healing', pendingSpecEdits: 1 }
    expect(testReviewNotificationSources([run])[0]).toMatchObject({ key: 'test-review:shop', signature: 'attention', message: { body: expect.stringContaining('1 test file changed'), target: { kind: 'test-review', feature: 'shop', runId: 'r1' } } })
    expect(testReviewNotificationSources([{ ...run, status: 'passed' }])).toEqual([])
    expect(testReviewNotificationSources([{ ...run, pendingSpecEdits: 0 }])).toEqual([])
  })
})

describe('test changes in the shared inbox', () => {
  const changes = (verdict: 'weaker' | 'equivalent' | 'stronger' | 'unclassifiable' = 'weaker') => [{ featureId: 'shop', status: 'dirty' as const, dirtySpecs: [{ strength: { verdict } }] }]

  it('reports weakening outside an active run as an advisory review notification', () => {
    const [source] = testReviewNotificationSources([], changes())
    expect(source.message).toMatchObject({ severity: 'danger', target: { kind: 'test-review', feature: 'shop' } })
    expect(source.message?.title).toContain('possible test weakening')
    expect(source.message?.body).toContain('A check found a possible weakening')
  })

  it('uses one feature alert while an active run owns the review and updates it in place on escalation', () => {
    const run = { runId: 'r1', feature: 'shop', status: 'healing', pendingSpecEdits: 1 }
    const [weak] = testReviewNotificationSources([run], changes())
    const [ordinary] = testReviewNotificationSources([run], changes('equivalent'))
    expect(weak).toMatchObject({ key: 'test-review:shop', signature: 'attention', message: { severity: 'danger', target: { kind: 'test-review', feature: 'shop', runId: 'r1' } } })
    expect(ordinary).toMatchObject({ key: weak.key, signature: weak.signature, message: { severity: 'warning' } })
    expect(testReviewNotificationSources([{ ...run, status: 'passed' }], changes())[0].message).toMatchObject({ severity: 'danger', target: { kind: 'test-review', feature: 'shop' } })
  })

  it.each(['equivalent', 'stronger', 'unclassifiable'] as const)('reports ordinary %s edits as their own test-change topic', (verdict) => {
    const [record] = changes(verdict)
    const [source] = testReviewNotificationSources([], [record])
    expect(source).toMatchObject({ key: 'test-review:shop', signature: 'attention', message: {
      title: 'shop: tests changed', severity: 'warning', target: { kind: 'test-review', feature: 'shop' },
    } })
    expect(source.message?.body).not.toContain('weakening')
    expect(testReviewNotificationSources([], [{ ...record, dirtySpecs: [...record.dirtySpecs, ...record.dirtySpecs] }])[0]).toMatchObject({
      key: source.key, signature: source.signature, message: { body: expect.stringContaining('2 test files changed') },
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

describe('independent notification topics', () => {
  const change: FeatureCoverageChange = {
    feature: 'shop', flightId: 'f1', delivery: 'tool-response-and-wait',
    freshness: { revision: 'v1', checkedAt: 'now', state: 'stale', reasons: ['Requirements changed.'],
      changedTests: ['test without mapping provenance'], latestRunFailed: false, proofNeedsRun: false,
      nextAction: { stage: 'prd-summary', label: 'Update requirements', command: 'start_external_summary', arguments: { feature: 'shop' } },
    },
  }

  it('keeps outdated coverage in Flight and does not invent a test-change notification from mapping inputs', () => {
    expect(coverageNotificationSources([change])[0]).toMatchObject({ key: 'coverage:shop', message: {
      title: 'shop: coverage out of date', target: { kind: 'coverage', feature: 'shop', flightId: 'f1', stage: 'prd-summary' },
    } })
    expect(testReviewNotificationSources([])).toEqual([])
    expect(verificationNotificationSources([change])[0].message).toBeUndefined()
  })

  it('keeps a failed run separate even while coverage is outdated', () => {
    const failed = { ...change, freshness: { ...change.freshness, latestRunFailed: true, latestRunId: 'r1' } }
    expect(coverageNotificationSources([failed])[0].message).toMatchObject({ title: 'shop: coverage out of date', severity: 'warning' })
    expect(verificationNotificationSources([failed])[0]).toMatchObject({ key: 'verification:shop', message: {
      title: 'shop: latest run has failures', severity: 'danger', target: { kind: 'run', feature: 'shop', runId: 'r1' },
    } })
  })

  it('resolves coverage when mapping is current even if a verification run is still required', () => {
    const current = { ...change, freshness: { ...change.freshness, state: 'current' as const, proofNeedsRun: true } }
    expect(coverageNotificationSources([current])[0].message).toBeUndefined()
    expect(verificationNotificationSources([current])[0].message).toMatchObject({
      title: 'shop: current tests need verification', target: { kind: 'coverage', feature: 'shop', flightId: 'f1', stage: 'run' },
    })
  })
})
