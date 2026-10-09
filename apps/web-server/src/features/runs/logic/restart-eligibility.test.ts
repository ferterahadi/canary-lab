import fs from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import type { RunManifest } from '../../../../../../shared/run-manifest'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { checkRestartEligibility } from './restart-eligibility'

const tmp = trackTempDirs('restart-eligibility-')
function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return { runId: 'run', feature: 'suite', startedAt: '2026-01-01T00:00:00Z', status: 'failed', healCycles: 0, services: [], ...overrides }
}

describe.each(['run', 'heal'] as const)('%s restart eligibility', (kind) => {
  const check = (entry: RunManifest, dir: string) => kind === 'run'
    ? checkRestartEligibility(entry, dir, 'run')
    : checkRestartEligibility(entry, dir, 'heal')

  it.each(['failed', 'aborted'] as const)('allows an unclaimed %s run', (status) => {
    expect(check(manifest({ status }), tmp())).toEqual({ ok: true })
  })

  it.each(['queued', 'running', 'healing', 'passed'] as const)('rejects a %s run with the existing reason', (status) => {
    expect(check(manifest({ status }), tmp())).toEqual({ ok: false, reason: kind === 'run' && (status === 'running' || status === 'healing') ? 'already-active' : 'not-restartable' })
  })

  it('rejects a verification run before reporting its active status', () => {
    expect(check(manifest({ status: 'running', executionType: 'verify' }), tmp())).toEqual({ ok: false, reason: 'not-restartable' })
  })

  it('rejects retired runs before reporting their active status', () => {
    const entry = { ...manifest({ status: 'running' }), perturbation: {} }
    expect(check(entry, tmp())).toEqual({ ok: false, reason: 'not-restartable' })
  })

  it('requires a new run only after its one external-effect attempt was claimed', () => {
    const dir = tmp()
    const entry = manifest({ singleAttempt: { receipt: 'attempt.json' } })
    expect(check(entry, dir)).toEqual({ ok: true })
    fs.writeFileSync(path.join(dir, 'attempt.json'), '{}')
    expect(check(entry, dir)).toEqual({ ok: false, reason: 'new-run-required' })
    expect(check({ ...entry, status: 'passed' }, dir)).toEqual({ ok: false, reason: 'not-restartable' })
  })
})
