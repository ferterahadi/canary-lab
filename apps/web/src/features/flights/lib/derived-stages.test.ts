import { describe, it, expect } from 'vitest'
import {
  buildDerivedManifest,
  deriveFeatureStages,
  derivedEntryStage,
  derivedFlightFeature,
  derivedFlightToken,
  latestTerminalRunByFeature,
} from './derived-stages'
import { FLIGHT_STAGE_KEYS } from '../../../../../../shared/flights/types'
import type { RunIndexEntry } from '../../../shared/api/types'

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

  it('latest run drives the run/heal cells: passed → done, failed → failed, none → pending', () => {
    const ev = { evidence: { envCapture: true, prdSummary: false, specs: true } }
    const passed = deriveFeatureStages(ev, run({ status: 'passed' }))!
    expect(statusOf(passed, 'run')).toBe('done')
    expect(statusOf(passed, 'heal')).toBe('done')
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
