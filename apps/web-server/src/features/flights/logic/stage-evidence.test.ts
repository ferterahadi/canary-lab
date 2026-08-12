import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  deriveFeatureEvidence,
  findBootProof,
  hasAuthoredSpecs,
  hasCapturedEnvset,
  hasPrdSummary,
} from './stage-evidence'
import { runDirFor, runsIndexPath } from '../../runs/logic/runtime/run-paths'
import type { RunManifest } from '../../runs/logic/runtime/manifest'

let featureDir: string
let logsDir: string

beforeEach(() => {
  featureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-evidence-'))
  logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-evidence-logs-'))
})

/** Write one run into the index plus its manifest, the way the run store does. */
function seedRun(run: {
  runId: string
  feature: string
  startedAt: string
  status: RunManifest['status']
  services: Array<{ name: string; readyAt?: string }>
}): void {
  const index = (() => {
    try {
      return JSON.parse(fs.readFileSync(runsIndexPath(logsDir), 'utf-8')) as unknown[]
    } catch {
      return []
    }
  })()
  index.push({ runId: run.runId, feature: run.feature, startedAt: run.startedAt, status: run.status })
  fs.mkdirSync(path.dirname(runsIndexPath(logsDir)), { recursive: true })
  fs.writeFileSync(runsIndexPath(logsDir), JSON.stringify(index))
  const runDir = runDirFor(logsDir, run.runId)
  fs.mkdirSync(runDir, { recursive: true })
  const manifest: Partial<RunManifest> = {
    runId: run.runId,
    feature: run.feature,
    startedAt: run.startedAt,
    status: run.status,
    healCycles: 0,
    services: run.services.map((s) => ({
      name: s.name,
      safeName: s.name,
      command: 'npm run dev',
      cwd: '/tmp',
      logPath: '/tmp/x.log',
      status: 'stopped' as const,
      ...(s.readyAt ? { readyAt: s.readyAt } : {}),
    })),
  }
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest))
}

describe('hasCapturedEnvset', () => {
  it('is false with no envsets dir at all', () => {
    expect(hasCapturedEnvset(featureDir)).toBe(false)
    expect(hasCapturedEnvset(featureDir, 'local')).toBe(false)
  })

  it('is false when the envset dir exists but is empty', () => {
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    expect(hasCapturedEnvset(featureDir)).toBe(false)
    expect(hasCapturedEnvset(featureDir, 'local')).toBe(false)
  })

  it('any-env probe accepts any non-empty envset; specific-env probe stays strict', () => {
    fs.mkdirSync(path.join(featureDir, 'envsets', 'staging'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'envsets', 'staging', 'app.env'), 'A=1\n')
    expect(hasCapturedEnvset(featureDir)).toBe(true)
    expect(hasCapturedEnvset(featureDir, 'staging')).toBe(true)
    expect(hasCapturedEnvset(featureDir, 'local')).toBe(false)
  })

  it('ignores stray files at the envsets/ top level (envsets.config.json is not a capture)', () => {
    fs.mkdirSync(path.join(featureDir, 'envsets'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'envsets', 'envsets.config.json'), '{}')
    expect(hasCapturedEnvset(featureDir)).toBe(false)
  })
})

describe('hasPrdSummary', () => {
  it('flips on docs/_prd-summary.json', () => {
    expect(hasPrdSummary(featureDir)).toBe(false)
    fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'docs', '_prd-summary.json'), '{}')
    expect(hasPrdSummary(featureDir)).toBe(true)
  })
})

describe('hasAuthoredSpecs', () => {
  it('is false with no e2e dir or with non-spec files only', () => {
    expect(hasAuthoredSpecs(featureDir)).toBe(false)
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'e2e', 'helpers.ts'), '')
    expect(hasAuthoredSpecs(featureDir)).toBe(false)
  })

  it('accepts the spec-file shapes the validator historically accepted', () => {
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'e2e', 'flow.spec.mts'), '')
    expect(hasAuthoredSpecs(featureDir)).toBe(true)
  })
})

describe('findBootProof', () => {
  it('is null with no run history at all', () => {
    expect(findBootProof(logsDir, 'shop')).toBeNull()
  })

  it('reports the services of a run whose every service reached ready', () => {
    seedRun({
      runId: 'r1',
      feature: 'shop',
      startedAt: '2026-08-07T10:00:00Z',
      status: 'passed',
      services: [{ name: 'api', readyAt: '2026-08-07T10:00:05Z' }, { name: 'web', readyAt: '2026-08-07T10:00:06Z' }],
    })
    expect(findBootProof(logsDir, 'shop')).toEqual({
      runId: 'r1',
      services: [{ name: 'api', status: 'ready' }, { name: 'web', status: 'ready' }],
    })
  })

  // The regression this predicate exists for: teardown rewrites every service's
  // status to `stopped`, so only the first-arrival `readyAt` stamp survives.
  it('reads readyAt, not the torn-down status', () => {
    seedRun({
      runId: 'r1',
      feature: 'shop',
      startedAt: '2026-08-07T10:00:00Z',
      status: 'failed',
      services: [{ name: 'api', readyAt: '2026-08-07T10:00:05Z' }],
    })
    expect(findBootProof(logsDir, 'shop')?.runId).toBe('r1')
  })

  it('refuses a run where a service never came up', () => {
    seedRun({
      runId: 'r1',
      feature: 'shop',
      startedAt: '2026-08-07T10:00:00Z',
      status: 'failed',
      services: [{ name: 'api', readyAt: '2026-08-07T10:00:05Z' }, { name: 'web' }],
    })
    expect(findBootProof(logsDir, 'shop')).toBeNull()
  })

  it('falls back through a boot failure to an older healthy run', () => {
    seedRun({
      runId: 'old',
      feature: 'shop',
      startedAt: '2026-08-07T09:00:00Z',
      status: 'passed',
      services: [{ name: 'api', readyAt: '2026-08-07T09:00:05Z' }],
    })
    seedRun({
      runId: 'new',
      feature: 'shop',
      startedAt: '2026-08-07T10:00:00Z',
      status: 'failed',
      services: [{ name: 'api' }],
    })
    expect(findBootProof(logsDir, 'shop')?.runId).toBe('old')
  })

  it('ignores another feature’s runs', () => {
    seedRun({
      runId: 'r1',
      feature: 'other',
      startedAt: '2026-08-07T10:00:00Z',
      status: 'passed',
      services: [{ name: 'api', readyAt: '2026-08-07T10:00:05Z' }],
    })
    expect(findBootProof(logsDir, 'shop')).toBeNull()
  })

  it('counts a settled run with nothing to boot (remote-URL feature)', () => {
    seedRun({ runId: 'r1', feature: 'shop', startedAt: '2026-08-07T10:00:00Z', status: 'passed', services: [] })
    expect(findBootProof(logsDir, 'shop')).toEqual({ runId: 'r1', services: [] })
  })

  it('does not count an unsettled run with nothing to boot', () => {
    seedRun({ runId: 'r1', feature: 'shop', startedAt: '2026-08-07T10:00:00Z', status: 'aborted', services: [] })
    expect(findBootProof(logsDir, 'shop')).toBeNull()
  })

  // Both cases below are about reading state written by an OLDER build or left
  // corrupt by a crash. This function decides whether a suite counts as set up,
  // so throwing here would take out the whole flight picker rather than degrade
  // one row.
  it('reports no proof rather than throwing on a corrupt runs index', () => {
    fs.mkdirSync(path.dirname(runsIndexPath(logsDir)), { recursive: true })
    // A row that survives the feature filter but carries no `runId`: `listRuns`
    // then resolves a run directory from it and throws
    // `ERR_INVALID_ARG_TYPE`. A truncated write leaves exactly this. Rows that
    // fail the filter are dropped before that point, so a row of the WRONG
    // feature would not reach it — the shape matters.
    fs.writeFileSync(
      runsIndexPath(logsDir),
      JSON.stringify([{ feature: 'shop', startedAt: '2026-08-07T10:00:00Z' }]),
    )
    expect(findBootProof(logsDir, 'shop')).toBeNull()
  })

  it('treats a manifest with no services key as nothing to boot', () => {
    seedRun({ runId: 'r1', feature: 'shop', startedAt: '2026-08-07T10:00:00Z', status: 'passed', services: [] })
    // Pre-services manifests exist on disk in workspaces upgraded from older
    // builds; the key is absent rather than empty.
    const manifestPath = path.join(runDirFor(logsDir, 'r1'), 'manifest.json')
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>
    delete raw.services
    fs.writeFileSync(manifestPath, JSON.stringify(raw))
    expect(findBootProof(logsDir, 'shop')).toEqual({ runId: 'r1', services: [] })
  })

  it('skips a run whose manifest is gone', () => {
    seedRun({
      runId: 'r1',
      feature: 'shop',
      startedAt: '2026-08-07T10:00:00Z',
      status: 'passed',
      services: [{ name: 'api', readyAt: '2026-08-07T10:00:05Z' }],
    })
    fs.rmSync(path.join(runDirFor(logsDir, 'r1'), 'manifest.json'))
    expect(findBootProof(logsDir, 'shop')).toBeNull()
  })

  it('survives an unreadable logs dir', () => {
    expect(findBootProof(path.join(logsDir, 'nope'), 'shop')).toBeNull()
  })
})

describe('deriveFeatureEvidence', () => {
  it('aggregates the probes', () => {
    fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'envsets', 'local', 'app.env'), 'A=1\n')
    fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'e2e', 'a.spec.ts'), '')
    expect(deriveFeatureEvidence(featureDir)).toEqual({
      envCapture: true,
      booted: false,
      prdSummary: false,
      specs: true,
      portInjectability: 'none',
    })
  })

  // The shipped healing suite's shape: no env files anywhere to capture, but a
  // run has proven its three services boot.
  it('reports booted for an env-less feature that has run', () => {
    seedRun({
      runId: 'r1',
      feature: 'shop',
      startedAt: '2026-08-07T10:00:00Z',
      status: 'failed',
      services: [{ name: 'api', readyAt: '2026-08-07T10:00:05Z' }],
    })
    expect(deriveFeatureEvidence(featureDir, logsDir, 'shop')).toEqual({
      envCapture: false,
      booted: true,
      prdSummary: false,
      specs: false,
      portInjectability: 'none',
    })
  })
})
