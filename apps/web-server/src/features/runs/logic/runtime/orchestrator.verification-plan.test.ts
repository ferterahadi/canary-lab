import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { RunOrchestrator } from './orchestrator'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runDirFor, buildRunPaths } from './run-paths'
import { readManifest } from './manifest'
import { RunnerLog } from './runner-log'

interface FakeProcess {
  pid: number
  options: PtySpawnOptions
  data: EventEmitter
  exit: EventEmitter
  killed: string | null
  writes: string[]
  resizes: Array<{ cols: number; rows: number }>
  emitData(chunk: string): void
  emitExit(code: number, signal?: number): void
}

function makeFakeFactory(): { factory: PtyFactory; spawned: FakeProcess[] } {
  const spawned: FakeProcess[] = []
  let nextPid = 100
  const factory: PtyFactory = (options): PtyHandle => {
    const data = new EventEmitter()
    const exit = new EventEmitter()
    const proc: FakeProcess = {
      pid: nextPid++,
      options,
      data,
      exit,
      killed: null,
      writes: [],
      resizes: [],
      emitData(chunk) { data.emit('data', chunk) },
      emitExit(code, signal) { exit.emit('exit', { exitCode: code, signal }) },
    }
    spawned.push(proc)
    return {
      get pid() { return proc.pid },
      onData: (cb) => {
        data.on('data', cb)
        return { dispose: () => data.off('data', cb) }
      },
      onExit: (cb) => {
        exit.on('exit', cb)
        return { dispose: () => exit.off('exit', cb) }
      },
      write: vi.fn((data: string) => { proc.writes.push(data) }),
      resize: vi.fn((cols: number, rows: number) => {
        proc.resizes.push({ cols, rows })
      }),
      kill: (signal) => { proc.killed = signal ?? 'SIGTERM' },
    }
  }
  return { factory, spawned }
}

let tmpDir: string

let runDir: string

const RUN_ID = '2026-04-28T1015-aaaa'

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-orc-')))
  runDir = runDirFor(path.join(tmpDir, 'logs'), RUN_ID)
  fs.mkdirSync(runDir, { recursive: true })
})

afterEach(() => {
  vi.useRealTimers()
})

function makeFeature(over: Partial<FeatureConfig> = {}): FeatureConfig {
  return {
    name: 'demo',
    description: 'demo',
    envs: ['local'],
    featureDir: path.join(tmpDir, 'features', 'demo'),
    repos: [
      {
        name: 'api',
        localPath: tmpDir,
        startCommands: [{ command: 'echo hi', name: 'api', healthCheck: { url: 'http://x' } }],
      },
    ],
    ...over,
  }
}

describe('computeVerificationPlan', () => {
  it('uses knownTests to target factory-generated failed and pending tests by title', async () => {
    const { computeVerificationPlan } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'demo-known')
    fs.mkdirSync(featureDir, { recursive: true })

    const result = computeVerificationPlan(featureDir, {
      passed: 1,
      passedNames: ['test-case-already-passed'],
      total: 3,
      knownTests: [
        { name: 'test-case-already-passed', title: 'already passed', location: `${featureDir}/e2e/helpers/spec-factory.ts:54` },
        { name: 'test-case-factory-failed', title: 'en_SG: checkout — address + payment pages', location: `${featureDir}/e2e/helpers/spec-factory.ts:58` },
        { name: 'test-case-factory-pending', title: 'en_SG: payment — authorize branch end-to-end', location: `${featureDir}/e2e/helpers/spec-factory.ts:63` },
      ],
      failed: [
        { name: 'test-case-factory-failed', location: `${featureDir}/e2e/helpers/spec-factory.ts:58` },
      ],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.selection.kind).toBe('grep')
    if (result.selection.kind !== 'grep') return
	    expect(result.failedFirst.map((test) => test.name)).toEqual(['test-case-factory-failed'])
	    expect(result.skipped.map((test) => test.name)).toEqual([])
	    expect(result.pending.map((test) => test.name)).toEqual(['test-case-factory-pending'])
    expect(result.selection.grep).toContain('en_SG: checkout')
    expect(result.selection.grep).toContain('en_SG: payment')
	  })

  it('orders remaining known tests as failed, skipped, then pending', async () => {
    const { computeVerificationPlan } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'demo-known-order')
    fs.mkdirSync(featureDir, { recursive: true })

    const result = computeVerificationPlan(featureDir, {
      passed: 1,
      passedNames: ['test-case-a'],
      skippedNames: ['test-case-c'],
      total: 4,
      knownTests: [
        { name: 'test-case-a', title: 'A passed', location: `${featureDir}/e2e/spec.ts:10` },
        { name: 'test-case-b', title: 'B failed', location: `${featureDir}/e2e/spec.ts:20` },
        { name: 'test-case-c', title: 'C skipped', location: `${featureDir}/e2e/spec.ts:30` },
        { name: 'test-case-d', title: 'D pending', location: `${featureDir}/e2e/spec.ts:40` },
      ],
      failed: [
        { name: 'test-case-b', location: `${featureDir}/e2e/spec.ts:20` },
      ],
    })

    expect(result.kind).toBe('targeted')
    if (result.kind !== 'targeted') return
    expect(result.failedFirst.map((test) => test.name)).toEqual(['test-case-b'])
    expect(result.skipped.map((test) => test.name)).toEqual(['test-case-c'])
    expect(result.pending.map((test) => test.name)).toEqual(['test-case-d'])
    expect(result.selection.reason).toContain('1 failed first, then 1 skipped, then 1 pending/not-run')
  })

  it('falls back to full-suite when failed tests cannot be safely selected', async () => {
    const { computeVerificationPlan } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'demo-unsafe')
    fs.mkdirSync(featureDir, { recursive: true })

    const result = computeVerificationPlan(featureDir, {
      total: 3,
      passedNames: ['test-case-a'],
      failed: [
        { name: 'test-case-helper-fail', location: `${featureDir}/e2e/helpers/spec-factory.ts:58` },
      ],
    })

    expect(result.kind).toBe('full-suite')
    if (result.kind !== 'full-suite') return
    expect(result.reason).toContain('full Playwright suite')
  })
})

describe('decideRunStatus', () => {
  function writeSpec(featureDir: string, name: string, body: string): string {
    const dir = path.join(featureDir, 'e2e')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, name)
    fs.writeFileSync(file, body)
    return file
  }

  function writeSummary(summaryPath: string, summary: object): void {
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true })
    fs.writeFileSync(summaryPath, JSON.stringify(summary))
  }

  it('returns failed on any non-zero exit code regardless of summary', async () => {
    const { decideRunStatus } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('a', async () => {})\n",
    )
    const summaryPath = path.join(tmpDir, 'summary.json')
    writeSummary(summaryPath, { passedNames: ['test-case-a'] })
    expect(decideRunStatus(featureDir, summaryPath, 1)).toBe('failed')
  })

  it('returns passed when exit 0 and every AST test is in passedNames', async () => {
    const { decideRunStatus } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('first', async () => {})\n" +
      "test('second', async () => {})\n",
    )
    const summaryPath = path.join(tmpDir, 'summary.json')
    writeSummary(summaryPath, { passedNames: ['test-case-first', 'test-case-second'] })
    expect(decideRunStatus(featureDir, summaryPath, 0)).toBe('passed')
  })

  it('returns failed on exit 0 when summary still has a failed entry', async () => {
    const { decideRunStatus } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    const spec = writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('first', async () => {})\n" +
      "test('second', async () => {})\n",
    )
    const summaryPath = path.join(tmpDir, 'summary.json')
    writeSummary(summaryPath, {
      passedNames: ['test-case-first'],
      failed: [{ name: 'test-case-second', location: `${spec}:3` }],
    })
    expect(decideRunStatus(featureDir, summaryPath, 0)).toBe('failed')
  })

  it('returns failed on exit 0 when an AST test is pending (missing from summary)', async () => {
    const { decideRunStatus } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('first', async () => {})\n" +
      "test('second', async () => {})\n",
    )
    const summaryPath = path.join(tmpDir, 'summary.json')
    // Only `first` ran; `second` never made it into the summary at all.
    writeSummary(summaryPath, { passedNames: ['test-case-first'] })
    expect(decideRunStatus(featureDir, summaryPath, 0)).toBe('failed')
  })

  it('returns failed on exit 0 when an AST test is in skippedNames', async () => {
    const { decideRunStatus } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    writeSpec(featureDir, 'a.spec.ts',
      "import { test } from '@playwright/test'\n" +
      "test('first', async () => {})\n" +
      "test('second', async () => {})\n",
    )
    const summaryPath = path.join(tmpDir, 'summary.json')
    writeSummary(summaryPath, {
      passedNames: ['test-case-first'],
      skipped: 1,
      skippedNames: ['test-case-second'],
    })
    expect(decideRunStatus(featureDir, summaryPath, 0)).toBe('failed')
  })

  it('falls back to summarizeFailures when AST extraction fails (no parseable specs)', async () => {
    const { decideRunStatus } = await import('./run-verdict')
    const featureDir = path.join(tmpDir, 'features', 'no-specs')
    fs.mkdirSync(featureDir, { recursive: true })
    const summaryPath = path.join(tmpDir, 'summary.json')

    // Empty failed[] + exit 0 + no parseable specs => passed (legacy behavior).
    writeSummary(summaryPath, { passedNames: [] })
    expect(decideRunStatus(featureDir, summaryPath, 0)).toBe('passed')

    // Failed entry + exit 0 + no parseable specs => failed.
    writeSummary(summaryPath, { failed: [{ name: 'test-case-x' }] })
    expect(decideRunStatus(featureDir, summaryPath, 0)).toBe('failed')
  })
})

describe('RunOrchestrator + RunnerLog integration', () => {
  it('writes lifecycle events to runner.log when one is supplied', async () => {
    const { factory, spawned } = makeFakeFactory()
    const paths = buildRunPaths(runDir)
    const runnerLog = new RunnerLog(paths.runnerLogPath)
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      runnerLog,
      playwrightSpawner: () => ({ command: 'fake-pw', cwd: tmpDir }),
    })

    await orch.start()
    const exitPromise = orch.runPlaywright()
    spawned[spawned.length - 1].emitExit(0)
    await exitPromise
    await orch.stop('passed')

    const body = fs.readFileSync(paths.runnerLogPath, 'utf-8')
    expect(body).toContain('Service started: api')
    expect(body).toContain('Health check passed (http): api')
    expect(body).toContain('Running Playwright tests: fake-pw')
    expect(body).toContain('Playwright exited: code=0')
    expect(body).toContain('Run complete: status=passed')
    // ANSI-free + timestamped format.
    for (const line of body.trim().split('\n')) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (INFO|WARN|ERROR) /)
    }
  })
})

describe('RunOrchestrator.markStoppedEarly + stoppedEarly serialization', () => {
  it('persists stoppedEarly on the manifest', async () => {
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })
    await orch.start()
    orch.markStoppedEarly('user-pause', 2, 11)
    const m = readManifest(orch.paths.manifestPath)!
    expect(m.stoppedEarly).toEqual({
      reason: 'user-pause',
      failuresAtStop: 2,
      suiteTotal: 11,
    })
    await orch.stop('aborted')
  })
})
