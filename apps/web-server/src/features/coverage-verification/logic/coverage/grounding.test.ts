import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { writeRunsIndex } from '../../../orchestration/logic/runtime/manifest'
import { buildRunPaths, runDirFor } from '../../../orchestration/logic/runtime/run-paths'
import { buildLastPassingRunIndex } from './grounding'

let logsDir: string

beforeEach(() => {
  logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-grounding-')))
})

afterEach(() => {
  fs.rmSync(logsDir, { recursive: true, force: true })
})

interface RunFixture {
  runId: string
  feature: string
  env?: string
  startedAt: string
  endedAt?: string
  status?: string
  passedNames?: string[]
}

function writeRun(fx: RunFixture) {
  const runDir = runDirFor(logsDir, fx.runId)
  fs.mkdirSync(runDir, { recursive: true })
  const paths = buildRunPaths(runDir)
  fs.writeFileSync(
    paths.manifestPath,
    JSON.stringify({
      runId: fx.runId,
      feature: fx.feature,
      env: fx.env,
      startedAt: fx.startedAt,
      endedAt: fx.endedAt,
      status: fx.status ?? 'passed',
      services: [],
    }),
  )
  if (fx.passedNames) {
    fs.writeFileSync(
      paths.summaryPath,
      JSON.stringify({
        complete: true,
        total: fx.passedNames.length,
        passed: fx.passedNames.length,
        passedNames: fx.passedNames,
        failed: [],
      }),
    )
  }
}

function buildIndex(runs: RunFixture[], feature = 'checkout') {
  writeRunsIndex(
    logsDir,
    runs.map((r) => ({
      runId: r.runId,
      feature: r.feature,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      status: (r.status ?? 'passed') as never,
    })),
  )
  for (const r of runs) writeRun(r)
  return buildLastPassingRunIndex(logsDir, feature)
}

describe('buildLastPassingRunIndex', () => {
  it('records the most-recent passing run per test name', () => {
    const index = buildIndex([
      { runId: 'r-old', feature: 'checkout', env: 'local', startedAt: '2026-01-01T00:00:00Z', passedNames: ['adds to cart'] },
      { runId: 'r-new', feature: 'checkout', env: 'staging', startedAt: '2026-02-01T00:00:00Z', passedNames: ['adds to cart'] },
    ])
    const entry = index.byTestName.get('adds to cart')
    expect(entry?.runId).toBe('r-new') // newest-first wins
    expect(entry?.env).toBe('staging')
  })

  it('omits tests that never passed', () => {
    const index = buildIndex([
      { runId: 'r1', feature: 'checkout', startedAt: '2026-01-01T00:00:00Z', passedNames: ['adds to cart'] },
    ])
    expect(index.byTestName.has('adds to cart')).toBe(true)
    expect(index.byTestName.has('removes from cart')).toBe(false)
  })

  it('counts a test that passed in a run even if the run overall later regressed', () => {
    // once-passed-then-failing: an OLD run passed it; a NEWER run did not list it
    // as passed (it failed). passedNames is per-test ground truth, so the old
    // pass still counts — and remains the most-recent PASS.
    const index = buildIndex([
      { runId: 'r-new-fail', feature: 'checkout', startedAt: '2026-03-01T00:00:00Z', status: 'failed', passedNames: ['other test'] },
      { runId: 'r-old-pass', feature: 'checkout', startedAt: '2026-02-01T00:00:00Z', passedNames: ['flaky test'] },
    ])
    expect(index.byTestName.get('flaky test')?.runId).toBe('r-old-pass')
  })

  it('ignores runs belonging to other features', () => {
    writeRunsIndex(logsDir, [
      { runId: 'a', feature: 'checkout', startedAt: '2026-01-01T00:00:00Z', status: 'passed' as never },
      { runId: 'b', feature: 'search', startedAt: '2026-02-01T00:00:00Z', status: 'passed' as never },
    ])
    writeRun({ runId: 'a', feature: 'checkout', startedAt: '2026-01-01T00:00:00Z', passedNames: ['cart'] })
    writeRun({ runId: 'b', feature: 'search', startedAt: '2026-02-01T00:00:00Z', passedNames: ['cart'] })
    const index = buildLastPassingRunIndex(logsDir, 'checkout')
    expect(index.byTestName.get('cart')?.runId).toBe('a')
  })

  it('skips runs with no e2e-summary (no evidence)', () => {
    const index = buildIndex([
      { runId: 'r1', feature: 'checkout', startedAt: '2026-01-01T00:00:00Z' /* no passedNames */ },
    ])
    expect(index.byTestName.size).toBe(0)
  })

  it('env cache hit: skips manifest read when the same runId is seen a second time (line 56 FALSE branch)', () => {
    // Write one run with a manifest so the first visit populates envByRunId.
    // Then inject a custom listRuns that returns the same runId twice;
    // on the second iteration envByRunId.has(runId) is true → the if on line 56 is false.
    const runId = 'r-dup'
    const runDir = runDirFor(logsDir, runId)
    fs.mkdirSync(runDir, { recursive: true })
    const paths = buildRunPaths(runDir)
    fs.writeFileSync(paths.manifestPath, JSON.stringify({ runId, feature: 'checkout', env: 'staging', startedAt: '2026-01-01T00:00:00Z', status: 'passed', services: [] }))
    fs.writeFileSync(paths.summaryPath, JSON.stringify({ complete: true, total: 1, passed: 1, passedNames: ['buy now'], failed: [] }))

    let manifestReadCount = 0
    const index = buildLastPassingRunIndex(logsDir, 'checkout', {
      listRuns: () => [
        { runId, feature: 'checkout', startedAt: '2026-01-01T00:00:00Z', status: 'passed' as never },
        { runId, feature: 'checkout', startedAt: '2026-01-01T00:00:00Z', status: 'passed' as never },
      ],
      readRunSummary: (dir) => {
        const p = buildRunPaths(dir)
        try { return JSON.parse(fs.readFileSync(p.summaryPath, 'utf-8')) } catch { return undefined }
      },
      readManifest: (p) => {
        manifestReadCount++
        try { return JSON.parse(fs.readFileSync(p, 'utf-8')) } catch { return undefined }
      },
    })
    // The test name is seen on first iteration; second iteration hits byTestName.has(name) → continue.
    // The manifest is read on first iteration; second hits the cache (manifestReadCount stays 1).
    expect(manifestReadCount).toBe(1)
    expect(index.byTestName.get('buy now')?.runId).toBe(runId)
  })
})
