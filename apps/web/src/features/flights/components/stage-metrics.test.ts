import { describe, expect, it } from 'vitest'
import type { CoverageLedger, RunIndexEntry, RunLifecycleEvent } from '@/shared/api/types'
import {
  bootDurationMs,
  estimateTokens,
  ledgerEvidence,
  overlayDiffStat,
  runHistoryStats,
  serviceReadyMs,
} from './stage-metrics'

// The stage bands report measurements, so every derivation here is pinned: a
// wrong aggregate is indistinguishable from a right one on screen.

function run(over: Partial<RunIndexEntry> = {}): RunIndexEntry {
  return {
    runId: 'r1',
    feature: 'demo',
    startedAt: '2026-07-01T00:00:00.000Z',
    status: 'passed',
    endedAt: '2026-07-01T00:01:00.000Z',
    ...over,
  }
}

describe('runHistoryStats', () => {
  it('counts each terminal outcome separately and never folds one into another', () => {
    const stats = runHistoryStats([
      run({ runId: 'a', status: 'passed' }),
      run({ runId: 'b', status: 'failed' }),
      run({ runId: 'c', status: 'failed' }),
      run({ runId: 'd', status: 'aborted' }),
    ])
    expect(stats).toMatchObject({ total: 4, passed: 1, failed: 2, aborted: 1, active: 0 })
  })

  it('keeps in-flight runs out of the outcome counts but inside the total', () => {
    const stats = runHistoryStats([
      run({ runId: 'a', status: 'passed' }),
      run({ runId: 'b', status: 'running', endedAt: undefined }),
      run({ runId: 'c', status: 'healing', endedAt: undefined }),
      run({ runId: 'd', status: 'queued', endedAt: undefined }),
    ])
    // 4 runs exist; only one has an outcome. Rounding the three unfinished ones
    // into failures (or passes) is the reporting lie this guards against.
    expect(stats).toMatchObject({ total: 4, passed: 1, failed: 0, aborted: 0, active: 3 })
  })

  it('averages only the runs that actually finished', () => {
    const stats = runHistoryStats([
      run({ runId: 'a', startedAt: '2026-07-01T00:00:00.000Z', endedAt: '2026-07-01T00:02:00.000Z' }),
      run({ runId: 'b', startedAt: '2026-07-01T00:00:00.000Z', endedAt: '2026-07-01T00:04:00.000Z' }),
      run({ runId: 'c', status: 'running', endedAt: undefined }),
    ])!
    expect(stats.avgDurationMs).toBe(180_000)
    expect(stats.longestDurationMs).toBe(240_000)
  })

  it('reports no duration at all when nothing has finished', () => {
    const stats = runHistoryStats([run({ status: 'running', endedAt: undefined })])!
    expect(stats.avgDurationMs).toBeNull()
    expect(stats.longestDurationMs).toBeNull()
  })

  it('sums repair cycles across runs, treating an absent count as zero', () => {
    const stats = runHistoryStats([
      run({ runId: 'a', healCycles: 2 }),
      run({ runId: 'b' }),
      run({ runId: 'c', healCycles: 1 }),
    ])!
    expect(stats.healCycles).toBe(3)
    expect(stats.runsWithRepairs).toBe(2)
  })

  it('is empty, not zeroed, for a feature with no runs', () => {
    expect(runHistoryStats([])).toBeNull()
  })
})

describe('bootDurationMs', () => {
  const event = (phase: RunLifecycleEvent['phase'], updatedAt: string): RunLifecycleEvent =>
    ({ phase, headline: phase, updatedAt })

  it('measures from the services starting to the last one reporting ready', () => {
    expect(bootDurationMs([
      event('starting-services', '2026-07-01T00:00:10.000Z'),
      event('starting-services', '2026-07-01T00:00:40.000Z'),
      event('services-ready', '2026-07-01T00:01:22.000Z'),
      event('running-tests', '2026-07-01T00:01:23.000Z'),
    ])).toBe(72_000)
  })

  it('ignores the queue wait before the services were asked to start', () => {
    // A boot behind a busy repo can sit queued for hours. Measuring from the
    // run's own start would report that wait as boot time.
    expect(bootDurationMs([
      event('starting-services', '2026-07-01T02:00:00.000Z'),
      event('services-ready', '2026-07-01T02:00:30.000Z'),
    ])).toBe(30_000)
  })

  it('returns null when either end of the span is missing', () => {
    expect(bootDurationMs([event('starting-services', '2026-07-01T00:00:00.000Z')])).toBeNull()
    expect(bootDurationMs([event('services-ready', '2026-07-01T00:00:00.000Z')])).toBeNull()
    expect(bootDurationMs(undefined)).toBeNull()
  })

  it('returns null rather than a negative span when the events are out of order', () => {
    expect(bootDurationMs([
      event('starting-services', '2026-07-01T00:01:00.000Z'),
      event('services-ready', '2026-07-01T00:00:00.000Z'),
    ])).toBeNull()
  })
})

describe('serviceReadyMs', () => {
  it('derives time-to-ready from the stamped pair', () => {
    expect(serviceReadyMs({
      startingAt: '2026-07-01T00:00:00.000Z',
      readyAt: '2026-07-01T00:00:48.000Z',
    })).toBe(48_000)
  })

  it('returns null for a run recorded before the stamps existed', () => {
    expect(serviceReadyMs({})).toBeNull()
    expect(serviceReadyMs({ startingAt: '2026-07-01T00:00:00.000Z' })).toBeNull()
  })
})

describe('estimateTokens', () => {
  it('approximates four characters per token', () => {
    expect(estimateTokens(12_900)).toBe(3225)
  })

  it('renders thousands compactly and keeps small counts exact', () => {
    expect(estimateTokens(400)).toBe(100)
    expect(estimateTokens(0)).toBe(0)
  })
})

describe('overlayDiffStat', () => {
  const diff = [
    'diff --git a/app/config.yml b/app/config.yml',
    '--- a/app/config.yml',
    '+++ b/app/config.yml',
    '@@ -1,3 +1,4 @@',
    ' port: 8080',
    '-static: true',
    '+static: false',
    '+injected: ${PORT}',
    'diff --git a/svc/build.gradle b/svc/build.gradle',
    '--- a/svc/build.gradle',
    '+++ b/svc/build.gradle',
    '@@ -10,2 +10,3 @@',
    '+canaryPort = System.getenv("PORT")',
  ].join('\n')

  it('counts files and changed lines from the unified diff', () => {
    expect(overlayDiffStat(diff)).toEqual({
      files: 2,
      added: 3,
      removed: 1,
      byFile: [
        { path: 'app/config.yml', added: 2, removed: 1 },
        { path: 'svc/build.gradle', added: 1, removed: 0 },
      ],
    })
  })

  it('does not count the +++/--- headers as changed lines', () => {
    const stat = overlayDiffStat(diff)
    expect(stat!.added).toBe(3)
    expect(stat!.removed).toBe(1)
  })

  it('returns null for an absent or empty diff', () => {
    expect(overlayDiffStat(undefined)).toBeNull()
    expect(overlayDiffStat('')).toBeNull()
  })
})

describe('ledgerEvidence', () => {
  function ledger(over: Partial<CoverageLedger> = {}): CoverageLedger {
    return {
      feature: 'demo',
      requirements: [],
      tests: [],
      totals: { total: 6, covered: 6, pathIncomplete: 0, variantIncomplete: 0, untested: 0, orphanTests: 0, proven: 3 },
      coveragePct: 100,
      mappedPct: 100,
      provenPct: 50,
      orphanRequirementIds: [],
      orphanTestNames: [],
      ...over,
    }
  }

  it('reads proven straight off the ledger totals instead of recomputing it', () => {
    const evidence = ledgerEvidence(ledger())
    expect(evidence).toMatchObject({ proven: 3, total: 6, provenPct: 50, claimedPct: 100 })
  })

  it('reports no proven axis when the feature has no recorded run', () => {
    const evidence = ledgerEvidence(ledger({ totals: {
      total: 6, covered: 6, pathIncomplete: 0, variantIncomplete: 0, untested: 0, orphanTests: 0,
    }, provenPct: undefined }))
    expect(evidence?.proven).toBeNull()
    expect(evidence?.provenPct).toBeNull()
  })

  it('buckets test strength and counts ungraded tests separately', () => {
    const evidence = ledgerEvidence(ledger({
      tests: [
        { name: 't1', requirements: ['R1'], pathTypes: [], strength: 'strong' },
        { name: 't2', requirements: ['R1'], pathTypes: [], strength: 'strong' },
        { name: 't3', requirements: ['R2'], pathTypes: [], strength: 'solid' },
        { name: 't4', requirements: ['R2'], pathTypes: [], strength: 'shallow' },
        // No grade recorded — must not silently land in any strength bucket.
        { name: 't5', requirements: ['R3'], pathTypes: [] },
      ],
    }))
    expect(evidence?.strength).toEqual({ strong: 2, solid: 1, basic: 0, shallow: 1, ungraded: 1 })
    expect(evidence?.testCount).toBe(5)
  })

  it('returns null for a feature with no requirements at all', () => {
    expect(ledgerEvidence(ledger({ totals: {
      total: 0, covered: 0, pathIncomplete: 0, variantIncomplete: 0, untested: 0, orphanTests: 0,
    } }))).toBeNull()
  })

  it('returns null when there is no ledger', () => {
    expect(ledgerEvidence(null)).toBeNull()
    expect(ledgerEvidence(undefined)).toBeNull()
  })
})
