import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeRunsIndex, type RunIndexEntry } from '../../runs/logic/runtime/manifest'

// `listRuns` is only faked for the one test that proves the validator survives
// a broken run index; everything else drives the real reader over real files.
const runMocks = vi.hoisted(() => ({ listRuns: vi.fn() }))
vi.mock('../../runs/logic/run-store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../runs/logic/run-store')>()
  return { ...real, listRuns: (...args: unknown[]) => runMocks.listRuns(...args) }
})

const { buildStageEntryValidator } = await import('./flights')

// `evaluation-export` is the only stage whose prerequisite is a *run*, so it's
// the entry point that consults the standalone-run fallback. Every earlier
// prerequisite has to be satisfied on disk to reach it.
let tmpDir: string
let featuresDir: string
let logsDir: string
const FEATURE = 'checkout'

function seedCompleteFeature(): void {
  const featureDir = path.join(featuresDir, FEATURE)
  fs.mkdirSync(path.join(featureDir, 'envsets', 'local'), { recursive: true })
  fs.mkdirSync(path.join(featureDir, 'docs'), { recursive: true })
  fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), 'module.exports = {}')
  fs.writeFileSync(path.join(featureDir, 'envsets', 'local', '.env'), 'PORT=3000\n')
  fs.writeFileSync(path.join(featureDir, 'docs', '_prd-summary.json'), '{}')
  fs.writeFileSync(path.join(featureDir, 'e2e', 'checkout.spec.ts'), 'test("x", () => {})')
}

function runRow(over: Partial<RunIndexEntry>): RunIndexEntry {
  return {
    runId: 'r1',
    feature: FEATURE,
    status: 'passed',
    startedAt: '2026-07-01T00:00:00.000Z',
    ...over,
  } as RunIndexEntry
}

/** Real `listRuns` over a real index file, which is what production does. */
function useRealIndex(rows: RunIndexEntry[]): void {
  writeRunsIndex(logsDir, rows)
  runMocks.listRuns.mockImplementation(async () => [])
  runMocks.listRuns.mockImplementation((dir: string, opts?: { feature?: string }) => {
    const all = JSON.parse(fs.readFileSync(path.join(dir, 'runs', 'index.json'), 'utf-8')) as RunIndexEntry[]
    return opts?.feature ? all.filter((r) => r.feature === opts.feature) : all
  })
}

const ASK_FOR_RUN = /no passed run for this feature yet/

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-stage-entry-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  seedCompleteFeature()
  runMocks.listRuns.mockReset()
})
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('buildStageEntryValidator — env-capture accepts a proven boot', () => {
  // `portify` is the cheapest entry point that depends on env-capture and
  // nothing later (STAGE_DEPENDS_ON: scaffold + env-capture).
  const entry = (validator: ReturnType<typeof buildStageEntryValidator>) =>
    validator({ feature: FEATURE, fromStage: 'portify', env: 'local' })

  /** A run whose services all reached ready, on disk where findBootProof reads. */
  function seedBootedRun(runId: string): void {
    useRealIndex([runRow({ runId, status: 'failed' })])
    const runDir = path.join(logsDir, 'runs', runId)
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      path.join(runDir, 'manifest.json'),
      JSON.stringify({
        runId,
        feature: FEATURE,
        startedAt: '2026-07-01T00:00:00.000Z',
        status: 'failed',
        healCycles: 0,
        services: [{ name: 'api', safeName: 'api', command: 'npm run dev', cwd: '/tmp', logPath: '/tmp/x.log', status: 'stopped', readyAt: '2026-07-01T00:00:05.000Z' }],
      }),
    )
  }

  it('accepts the jump when the envset is present, as it always did', () => {
    useRealIndex([])
    expect(entry(buildStageEntryValidator(featuresDir, logsDir))).toBeNull()
  })

  // An app with no env files captures nothing, so requiring the envset made the
  // jump impossible however many times the suite had booted.
  it('accepts the jump for an env-less feature that has booted', () => {
    fs.rmSync(path.join(featuresDir, FEATURE, 'envsets'), { recursive: true, force: true })
    seedBootedRun('r_boot')
    expect(entry(buildStageEntryValidator(featuresDir, logsDir))).toBeNull()
  })

  it('refuses when the feature has neither captured nor booted', () => {
    fs.rmSync(path.join(featuresDir, FEATURE, 'envsets'), { recursive: true, force: true })
    useRealIndex([])
    expect(entry(buildStageEntryValidator(featuresDir, logsDir))).toMatch(/has never booted and has no captured envset/)
  })
})

describe('buildStageEntryValidator — the standalone-run fallback', () => {
  const entry = (validator: ReturnType<typeof buildStageEntryValidator>) =>
    validator({ feature: FEATURE, fromStage: 'evaluation-export', env: 'local' })

  it('accepts a plain passed run as the run-stage evidence', () => {
    useRealIndex([runRow({ status: 'passed' })])
    expect(entry(buildStageEntryValidator(featuresDir, logsDir))).toBeNull()
  })

  it('accepts a passed run whose executionType is explicitly `run`', () => {
    useRealIndex([runRow({ status: 'passed', executionType: 'run' })])
    expect(entry(buildStageEntryValidator(featuresDir, logsDir))).toBeNull()
  })

  it('rejects when no run has passed', () => {
    useRealIndex([runRow({ status: 'failed' })])
    expect(entry(buildStageEntryValidator(featuresDir, logsDir))).toMatch(ASK_FOR_RUN)
  })

  // boot/benchmark/verify runs are not a verdict on the feature's specs, so
  // none of them may stand in for the run stage.
  for (const executionType of ['boot', 'benchmark', 'verify'] as const) {
    it(`rejects a passed \`${executionType}\` execution as run evidence`, () => {
      useRealIndex([runRow({ status: 'passed', executionType })])
      expect(entry(buildStageEntryValidator(featuresDir, logsDir))).toMatch(ASK_FOR_RUN)
    })
  }

  it('rejects when the validator was built without a logs dir (nothing to consult)', () => {
    expect(entry(buildStageEntryValidator(featuresDir))).toMatch(ASK_FOR_RUN)
    expect(runMocks.listRuns).not.toHaveBeenCalled()
  })

  it('rejects rather than throwing when the run index cannot be read', () => {
    runMocks.listRuns.mockImplementation(() => { throw new Error('index.json is corrupt') })
    expect(entry(buildStageEntryValidator(featuresDir, logsDir))).toMatch(ASK_FOR_RUN)
  })

  it('prefers the flight record\'s own run link over the standalone lookup', () => {
    useRealIndex([])
    const validator = buildStageEntryValidator(featuresDir, logsDir)
    expect(validator({ feature: FEATURE, fromStage: 'evaluation-export', env: 'local', existing: { links: { runId: 'r9' } } })).toBeNull()
    expect(runMocks.listRuns).not.toHaveBeenCalled()
  })
})
