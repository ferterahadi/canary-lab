import { describe, it, expect } from 'vitest'
import {
  buildDerivedManifest,
  deriveFeatureStages,
  derivedEntryStage,
  derivedFlightFeature,
  derivedFlightToken,
  latestTerminalRunByFeature,
} from './derived-stages'
import { FLIGHT_STAGE_KEYS } from '@shared/flights/types'
import type { RunIndexEntry } from '@/shared/api/types'

function run(over: Partial<RunIndexEntry>): RunIndexEntry {
  return {
    runId: 'r1',
    feature: 'f',
    startedAt: '2026-01-01T00:00:00Z',
    status: 'passed',
    ...over,
  }
}

const statusOf = (stages: NonNullable<ReturnType<typeof deriveFeatureStages>>, key: string) =>
  stages.find((s) => s.key === key)?.status

describe('deriveFeatureStages', () => {
  it('returns null without an evidence payload (older server) — callers fall back to "not flown"', () => {
    expect(deriveFeatureStages({})).toBeNull()
  })

  it('a bare scaffold lights only the existence stages (similarity/scout)', () => {
    const stages = deriveFeatureStages({ evidence: { envCapture: false, prdSummary: false, specs: false } })!
    expect(statusOf(stages, 'similarity')).toBe('done')
    expect(statusOf(stages, 'scout')).toBe('done')
    for (const key of ['scaffold', 'env-capture', 'docs', 'prd-summary', 'specs-coverage', 'portify', 'run', 'heal', 'evaluation-export']) {
      expect(statusOf(stages, key)).toBe('pending')
    }
  })

  it('pair cells light on the pair outcome: envCapture lights BOTH suite-setup halves, prdSummary both requirements halves', () => {
    const stages = deriveFeatureStages({ evidence: { envCapture: true, prdSummary: true, specs: false } })!
    expect(statusOf(stages, 'scaffold')).toBe('done')
    expect(statusOf(stages, 'env-capture')).toBe('done')
    expect(statusOf(stages, 'docs')).toBe('done')
    expect(statusOf(stages, 'prd-summary')).toBe('done')
    expect(statusOf(stages, 'specs-coverage')).toBe('pending')
  })

  // The shipped healing suite has no env files to capture, so an envset-only
  // predicate left Suite setup dark however many times it booted.
  it('a proven boot lights suite setup with no envset at all', () => {
    const stages = deriveFeatureStages({ evidence: { envCapture: false, booted: true, prdSummary: false, specs: false } })!
    expect(statusOf(stages, 'scaffold')).toBe('done')
    expect(statusOf(stages, 'env-capture')).toBe('done')
  })

  // Parallel readiness is a property of the config. A feature whose every start
  // command declares a slot boots concurrently already; telling the user to run
  // Portify would be telling them to redo what the config does.
  it('a fully slotted config lights parallel readiness with no overlay', () => {
    const stages = deriveFeatureStages({
      evidence: { envCapture: false, booted: true, prdSummary: false, specs: false, portInjectability: 'declared' },
      portified: false,
    })!
    expect(statusOf(stages, 'portify')).toBe('done')
  })

  it('a partly slotted config leaves parallel readiness open', () => {
    for (const portInjectability of ['partial', 'none'] as const) {
      const stages = deriveFeatureStages({
        evidence: { envCapture: false, booted: true, prdSummary: false, specs: false, portInjectability },
        portified: false,
      })!
      expect(statusOf(stages, 'portify')).toBe('pending')
    }
  })

  it('suite setup stays dark for a feature that has neither captured nor booted', () => {
    const stages = deriveFeatureStages({ evidence: { envCapture: false, booted: false, prdSummary: false, specs: false } })!
    expect(statusOf(stages, 'scaffold')).toBe('pending')
    expect(statusOf(stages, 'env-capture')).toBe('pending')
  })

  it('latest run drives the run/heal cells: passed → done, failed → failed, none → pending', () => {
    const ev = { evidence: { envCapture: true, prdSummary: false, specs: true } }
    const passed = deriveFeatureStages(ev, run({ runId: 'latest-pass', status: 'passed' }))!
    expect(statusOf(passed, 'run')).toBe('done')
    expect(statusOf(passed, 'heal')).toBe('done')
    expect(passed.find((stage) => stage.key === 'run')?.evidence).toEqual({
      runId: 'latest-pass',
      status: 'passed',
    })
    const failed = deriveFeatureStages(ev, run({ status: 'failed' }))!
    expect(statusOf(failed, 'run')).toBe('failed')
    const none = deriveFeatureStages(ev)!
    expect(statusOf(none, 'run')).toBe('pending')
  })

  it('portify and export evidence light their cells', () => {
    const stages = deriveFeatureStages(
      { evidence: { envCapture: false, prdSummary: false, specs: false }, portified: true },
      undefined,
      true,
    )!
    expect(statusOf(stages, 'portify')).toBe('done')
    expect(statusOf(stages, 'evaluation-export')).toBe('done')
  })

  it('uses the external Portify stream as immediate derived-stage evidence', () => {
    const externalPortify = {
      kind: 'portifying' as const,
      stage: 'portify' as const,
      resourceId: 'wf-live',
      status: 'done' as const,
      startedAt: '2026-08-25T00:00:00Z',
      updatedAt: '2026-08-25T00:05:00Z',
    }
    const stages = deriveFeatureStages(
      { evidence: { envCapture: false, prdSummary: false, specs: false }, portified: false },
      undefined,
      false,
      {
        portify: {
          traces: [externalPortify],
          current: externalPortify,
        },
      },
    )!
    const portify = stages.find((stage) => stage.key === 'portify')
    expect(portify?.status).toBe('done')
    expect(portify?.evidence).toEqual({ workflowId: 'wf-live' })
  })
})

describe('latestTerminalRunByFeature', () => {
  it('keeps the newest settled test run per feature, skipping active/boot/benchmark/verify runs', () => {
    const map = latestTerminalRunByFeature([
      run({ runId: 'old-pass', startedAt: '2026-01-01T00:00:00Z', status: 'passed' }),
      run({ runId: 'new-fail', startedAt: '2026-01-02T00:00:00Z', status: 'failed' }),
      run({ runId: 'active', startedAt: '2026-01-03T00:00:00Z', status: 'running' }),
      run({ runId: 'boot', startedAt: '2026-01-04T00:00:00Z', executionType: 'boot' }),
      run({ runId: 'verify', startedAt: '2026-01-05T00:00:00Z', executionType: 'verify' }),
      run({ runId: 'other', feature: 'g', startedAt: '2026-01-01T00:00:00Z', status: 'passed' }),
    ])
    expect(map.get('f')?.runId).toBe('new-fail')
    expect(map.get('g')?.runId).toBe('other')
  })

  // The list arrives newest-first from `/api/runs`, so the SECOND settled run a
  // feature contributes is normally the older one and must not displace the
  // first. The case above only ever walks older→newer, which exercises the
  // replacing side of the comparison and never the keeping side.
  it('keeps the run it already has when an older one for the same feature follows', () => {
    const map = latestTerminalRunByFeature([
      run({ runId: 'newest', startedAt: '2026-02-02T00:00:00Z', status: 'passed' }),
      run({ runId: 'older', startedAt: '2026-02-01T00:00:00Z', status: 'failed' }),
    ])
    expect(map.get('f')?.runId).toBe('newest')
  })
})

// R81 — the derived-flight id space and the pseudo-manifest FlightPage renders.
describe('derived flight tokens (R81)', () => {
  it('round-trips a feature name and never claims a real flight id', () => {
    expect(derivedFlightToken('go-smoke')).toBe('feature:go-smoke')
    expect(derivedFlightFeature('feature:go-smoke')).toBe('go-smoke')
    // A real flightId is `fl_<hex>` — the two id spaces cannot collide.
    expect(derivedFlightFeature('fl_d0a98e795add')).toBeNull()
    expect(derivedFlightFeature('feature:')).toBeNull()
  })

  it('builds a manifest that reports done only when the whole pipeline is done', () => {
    const done = FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const }))
    expect(buildDerivedManifest('go-smoke', done).status).toBe('done')
    const partial = done.map((s, i) => (i === done.length - 1 ? { ...s, status: 'pending' as const } : s))
    expect(buildDerivedManifest('go-smoke', partial).status).toBe('paused')
    // The pseudo-manifest carries the feature and its token id, nothing invented.
    const m = buildDerivedManifest('go-smoke', done, { repoPaths: ['/repo/a'], env: 'staging' })
    expect(m).toMatchObject({ flightId: 'feature:go-smoke', feature: 'go-smoke', description: '', repoPaths: ['/repo/a'] })
    expect(m.opts.env).toBe('staging')
  })

  // The summary strip's RUN item reads `runVerdict` — a conducted-flight field a
  // derived record never had — so the strip stayed blank beside a green run one
  // click below. The probed run evidence carries the same verdict; it is lifted.
  it('lifts a probed run verdict onto the pseudo-manifest, and only a real verdict', () => {
    const done = FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const }))
    for (const status of ['passed', 'failed', 'aborted'] as const) {
      expect(buildDerivedManifest('go-smoke', done, { evidence: { run: { status } } }).runVerdict).toBe(status)
    }
    // 'running' is not a verdict, and junk from a hand-edited record is not one
    // either — the strip must stay blank rather than invent an outcome.
    expect(buildDerivedManifest('go-smoke', done, { evidence: { run: { status: 'running' } } }).runVerdict).toBeUndefined()
    expect(buildDerivedManifest('go-smoke', done, { evidence: { run: { status: 7 } } }).runVerdict).toBeUndefined()
    expect(buildDerivedManifest('go-smoke', done, { evidence: {} }).runVerdict).toBeUndefined()
    expect(buildDerivedManifest('go-smoke', done).runVerdict).toBeUndefined()
  })

  // The entry prefill falls through to the feature config's own description, so
  // the Repo scan panel's "Intent · what to test" reads the suite's purpose
  // instead of rendering its heading over an empty line.
  it('carries the prefilled intent onto the pseudo-manifest', () => {
    const done = FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const }))
    const m = buildDerivedManifest('go-smoke', done, { description: 'Prove the services agree on one order.' })
    expect(m.description).toBe('Prove the services agree on one order.')
  })

  it('attaches workspace-probed evidence whatever the stage status, flagging the source', () => {
    const stages = FLIGHT_STAGE_KEYS.map((key) => ({
      key,
      status: (key === 'specs-coverage' ? 'pending' : 'done') as 'done' | 'pending',
    }))
    const m = buildDerivedManifest('go-smoke', stages, {
      evidence: {
        'run': { counts: { passed: 3, total: 3, failed: 0 } },
        // A PENDING stage still gets its block: the probe returning one is proof
        // the artifact is on disk, and this step is part-done (specs authored,
        // nothing to map them onto). Withholding it would report real work as
        // untouched.
        'specs-coverage': { coveragePct: 0, total: 0 },
      },
    })
    const run = m.stages.find((s) => s.key === 'run')
    expect(run?.evidence).toEqual({ counts: { passed: 3, total: 3, failed: 0 } })
    expect(run?.evidenceSource).toBe('workspace')
    const specs = m.stages.find((s) => s.key === 'specs-coverage')
    expect(specs?.status).toBe('pending')
    expect(specs?.evidence).toEqual({ coveragePct: 0, total: 0 })
    expect(specs?.evidenceSource).toBe('workspace')
    // A stage with no probed block stays status-only — nothing is invented.
    expect(m.stages.find((s) => s.key === 'scout')?.evidence).toBeUndefined()
    expect(m.stages.find((s) => s.key === 'scout')?.evidenceSource).toBeUndefined()
  })

  it('keeps the newest run-store identity when the entry probe still names an older run', () => {
    const stages = deriveFeatureStages(
      { evidence: { envCapture: true, prdSummary: true, specs: true } },
      run({ runId: 'run-new', status: 'failed' }),
    )!
    const m = buildDerivedManifest('go-smoke', stages, {
      evidence: {
        run: { runId: 'run-old', status: 'passed', counts: { passed: 3, total: 3, failed: 0 } },
      },
    })
    expect(m.runVerdict).toBe('failed')
    expect(m.stages.find((stage) => stage.key === 'run')?.evidence).toEqual({
      runId: 'run-new',
      status: 'failed',
    })

    const matching = buildDerivedManifest('go-smoke', stages, {
      evidence: {
        run: { runId: 'run-new', status: 'failed', counts: { passed: 1, total: 3, failed: 2 } },
      },
    })
    expect(matching.stages.find((stage) => stage.key === 'run')?.evidence).toMatchObject({
      runId: 'run-new',
      counts: { passed: 1, total: 3, failed: 2 },
    })
  })

  it('leaves the coverage step OPEN when there is no PRD to map specs onto', () => {
    const specsOnly = deriveFeatureStages(
      { evidence: { envCapture: true, prdSummary: false, specs: true }, portified: false },
    )
    expect(specsOnly?.find((s) => s.key === 'specs-coverage')?.status).toBe('pending')
    // With requirements distilled, the step can actually complete.
    const withPrd = deriveFeatureStages(
      { evidence: { envCapture: true, prdSummary: true, specs: true }, portified: false },
    )
    expect(withPrd?.find((s) => s.key === 'specs-coverage')?.status).toBe('done')
  })

  it('distinguishes authored tests from durable coverage mapping', () => {
    const evidence = { envCapture: true, prdSummary: true, specs: true } as const
    const absent = deriveFeatureStages({ evidence: { ...evidence, coverageMapping: 'absent' } })
    const fresh = deriveFeatureStages({ evidence: { ...evidence, coverageMapping: 'fresh' } })
    const stale = deriveFeatureStages({ evidence: { ...evidence, coverageMapping: 'stale' } })
    expect(statusOf(absent!, 'specs-coverage')).toBe('pending')
    expect(statusOf(fresh!, 'specs-coverage')).toBe('done')
    expect(statusOf(stale!, 'specs-coverage')).toBe('pending')
  })

  it('entry stage is the first step with nothing to show for it', () => {
    const stages = FLIGHT_STAGE_KEYS.map((key) => ({
      key,
      status: (['similarity', 'scout', 'scaffold'].includes(key) ? 'done' : 'pending') as 'done' | 'pending',
    }))
    expect(derivedEntryStage(stages)).toBe('env-capture')
    // Nothing open → nothing to continue; the offer becomes a fresh flight.
    expect(derivedEntryStage(FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' as const })))).toBeNull()
  })
})
