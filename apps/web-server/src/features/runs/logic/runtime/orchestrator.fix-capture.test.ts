import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { RunOrchestrator } from './orchestrator'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runDirFor, buildRunPaths } from './run-paths'
import { readManifest, type RunLifecycleEvent } from './manifest'

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

describe('RunOrchestrator.runFullCycle', () => {
  function bootForFullCycle(opts: {
    spawned: { factory: PtyFactory; spawned: ReturnType<typeof makeFakeFactory>['spawned'] }
    pwExitCodes: number[]
    autoHeal?: boolean
    manualHeal?: boolean
    externalHeal?: boolean
  }) {
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: opts.spawned.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 1000,
      playwrightSpawner: ({ rerunTargets }) => ({
        command: `pw-${pwIdx++}${rerunTargets?.length ? ` ${rerunTargets.join(' ')}` : ''}`,
        cwd: tmpDir,
      }),
      autoHeal: opts.autoHeal
        ? {
            agent: 'claude',
            maxCycles: 2,
            buildSpawnCommand: () => `heal-${healIdx++}`,
          }
        : undefined,
      manualHeal: opts.manualHeal,
      externalHeal: opts.externalHeal,
    })
    return orch
  }

  function readLifecycleEvents(orch: RunOrchestrator): RunLifecycleEvent[] {
    return fs.readFileSync(orch.paths.lifecycleEventsPath, 'utf-8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunLifecycleEvent)
  }

  it('omits fix.file in non-git workspaces and falls back to restart-all', async () => {
    // No git init on tmpDir → snapshotFeatureRepos sees no working tree, the
    // diff is empty, the journal omits fix.file, and restart() with an empty
    // filesChanged respawns every service (the previous "restart all" path).
    const f = makeFakeFactory()
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 1000,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildSpawnCommand: () => `heal-${healIdx++}` },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }] }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    fs.writeFileSync(orch.paths.restartSignal, JSON.stringify({
      hypothesis: 'fix',
      fixDescription: 'd',
    }))
    f.spawned[2].emitExit(0)
    while (f.spawned.length < 5) await new Promise((r) => setTimeout(r, 5))
    f.spawned[4].emitExit(1)
    await promise

    const journal = fs.readFileSync(orch.paths.diagnosisJournalPath, 'utf-8')
    expect(journal).toContain('- hypothesis: fix')
    expect(journal).not.toContain('- fix.file:')
    // The api service was respawned despite the empty diff (restart-all path).
    expect(f.spawned.length).toBeGreaterThanOrEqual(5)
    await orch.stop('failed')
  }, 15000)

  it('excludes a nested service-repo subtree from the feature-dir diff', async () => {
    // featureDir IS the workspace repo root here; the "api" service repo
    // lives nested inside it as its OWN git repo. snapshotFeatureRepos must
    // recognize the nesting (isPathInside) and exclude that subtree from the
    // feature-dir-level diff pathspec so an edit inside it isn't reported
    // twice (once via its own snapshot, once via the feature-dir scan).
    const featureDir = tmpDir
    execFileSync('git', ['init', '-q'], { cwd: featureDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: featureDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: featureDir })
    fs.writeFileSync(path.join(featureDir, 'e2e-helper.ts'), '// initial helper\n')
    execFileSync('git', ['add', 'e2e-helper.ts'], { cwd: featureDir })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: featureDir })

    const serviceRepo = path.join(featureDir, 'services', 'api')
    fs.mkdirSync(serviceRepo, { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: serviceRepo })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: serviceRepo })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: serviceRepo })
    fs.writeFileSync(path.join(serviceRepo, 'main.ts'), '// initial\n')
    execFileSync('git', ['add', 'main.ts'], { cwd: serviceRepo })
    execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: serviceRepo })

    const f = makeFakeFactory()
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature({
        featureDir,
        repos: [
          {
            name: 'api',
            localPath: serviceRepo,
            startCommands: [{ command: 'echo hi', name: 'api', healthCheck: { url: 'http://x' } }],
          },
        ],
      }),
      runId: RUN_ID,
      runDir,
      env: 'local',
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 1000,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: featureDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildSpawnCommand: () => `heal-${healIdx++}` },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }] }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    // Agent edits ONLY the nested service repo.
    fs.writeFileSync(path.join(serviceRepo, 'main.ts'), '// edited\n')
    fs.writeFileSync(orch.paths.restartSignal, JSON.stringify({ hypothesis: 'fix', fixDescription: 'd' }))
    f.spawned[2].emitExit(0)
    while (f.spawned.length < 5) await new Promise((r) => setTimeout(r, 5))
    f.spawned[4].emitExit(1)
    await promise

    const journal = fs.readFileSync(orch.paths.diagnosisJournalPath, 'utf-8')
    const fixFileLine = journal.split('\n').find((l) => l.startsWith('- fix.file:'))!
    // Reported exactly once — the feature-dir-level diff excluded the nested
    // service-repo subtree instead of double-counting it.
    expect(fixFileLine.match(/main\.ts/g)?.length).toBe(1)
    expect(fixFileLine).toContain(path.join(serviceRepo, 'main.ts'))
    await orch.stop('failed')
  }, 15000)

  it('honors .rerun signal (rerun-only path)', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1, 0], autoHeal: true })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a', location: 'e2e/a.spec.ts:9' }] }),
    )
    const statuses: string[] = []
    orch.on('run-status', (e) => statuses.push(e.status))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    fs.writeFileSync(orch.paths.rerunSignal, '')
    f.spawned[2].emitExit(0)

    while (f.spawned.length < 4) await new Promise((r) => setTimeout(r, 5))
    expect(readManifest(orch.paths.manifestPath)?.status).toBe('running')
    expect(statuses.at(-1)).toBe('running')
    expect(f.spawned[3].options.command).toContain('e2e/a.spec.ts:9')
    // Mimic the SummaryReporter clearing the failed entry on a successful rerun.
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({
      passedNames: ['a'],
      failed: [],
    }))
    f.spawned[3].emitExit(0)
    const status = await promise
    expect(status).toBe('passed')
    await orch.stop('passed')
  })

  it('falls back to full-suite post-heal rerun when failed entries have no location', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1, 0], autoHeal: true })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }] }),
    )
    const chunks: string[] = []
    orch.on('playwright-output', (e) => chunks.push(e.chunk))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    fs.writeFileSync(orch.paths.rerunSignal, '')
    f.spawned[2].emitExit(0)

    while (f.spawned.length < 4) await new Promise((r) => setTimeout(r, 5))
    expect(f.spawned[3].options.command).toBe('pw-1')
    expect(chunks.join('')).toContain('running the full Playwright suite')
    // Mimic the SummaryReporter clearing the failed entry on a successful rerun.
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({
      passedNames: ['a'],
      failed: [],
    }))
    f.spawned[3].emitExit(0)
    expect(await promise).toBe('passed')
    await orch.stop('passed')
  })

  it('treats .heal signal as rerun-only in auto-heal mode', async () => {
    const f = makeFakeFactory()
    const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1, 0], autoHeal: true })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }] }),
    )

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    fs.writeFileSync(orch.paths.healSignal, JSON.stringify({ hypothesis: 'try again' }))
    f.spawned[2].emitExit(0)

    while (f.spawned.length < 4) await new Promise((r) => setTimeout(r, 5))
    // Mimic the SummaryReporter clearing the failed entry on a successful rerun.
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({
      passedNames: ['a'],
      failed: [],
    }))
    f.spawned[3].emitExit(0)
    expect(await promise).toBe('passed')
    await orch.stop('passed')
	  })
})

describe('RunOrchestrator.restartTerminalRun', () => {
  it('starts by retesting failed, skipped, and pending tests without a full-suite first pass', async () => {
    const f = makeFakeFactory()
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    const paths = buildRunPaths(runDir)
    fs.writeFileSync(paths.summaryPath, JSON.stringify({
      complete: true,
      total: 4,
      passed: 1,
      passedNames: ['test-case-a'],
      skipped: 1,
      skippedNames: ['test-case-c'],
      knownTests: [
        { name: 'test-case-a', title: 'A passed', location: `${featureDir}/e2e/spec.ts:10` },
        { name: 'test-case-b', title: 'B failed', location: `${featureDir}/e2e/spec.ts:20` },
        { name: 'test-case-c', title: 'C skipped', location: `${featureDir}/e2e/spec.ts:30` },
        { name: 'test-case-d', title: 'D pending', location: `${featureDir}/e2e/spec.ts:40` },
      ],
      failed: [{ name: 'test-case-b', location: `${featureDir}/e2e/spec.ts:20` }],
    }))
    const selections: unknown[] = []
    const orch = new RunOrchestrator({
      feature: makeFeature({ featureDir, repos: undefined }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      playwrightSpawner: ({ rerunSelection }) => {
        selections.push(rerunSelection)
        return { command: 'pw', cwd: tmpDir }
      },
    })

    const promise = orch.restartTerminalRun()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(f.spawned).toHaveLength(1)
    f.spawned[0].emitExit(1)
    await promise

    expect(selections[0]).toMatchObject({
      kind: 'grep',
      selected: 3,
      total: 4,
      mode: 'failed-and-pending',
    })
    expect((selections[0] as { reason: string }).reason).toContain('1 failed first, then 1 skipped, then 1 pending/not-run')
    expect(f.spawned[0].options.env?.CANARY_LAB_TARGETED_RERUN).toBe('1')
  })
})

describe('RunOrchestrator.waitForHealSignal', () => {
  it('accepts one signal while waiting and ignores duplicate pending signals', async () => {
    vi.useFakeTimers()
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 10,
      healSignalPollMs: 10,
    })
    await orch.start()
    const ignored: string[] = []
    orch.on('signal-ignored', (e) => ignored.push(e.reason))
    const waiting = orch.waitForHealSignal(5_000, 5_000, false)
    fs.writeFileSync(orch.paths.restartSignal, '{"hypothesis":"h"}')
    fs.writeFileSync(orch.paths.rerunSignal, '{}')

    vi.advanceTimersByTime(20)
    await Promise.resolve()
    const { signal, reason } = await waiting
    vi.useRealTimers()

    expect(signal?.kind).toBe('restart')
    expect(reason).toBe('signal')
    expect(ignored).toContain('signal-already-pending')
    expect(readManifest(orch.paths.manifestPath)?.lifecycle?.lastSignal?.status).toBe('ignored')
    await orch.stop('aborted')
  })

  it('returns pty-died when no agent pty is alive (post-exit grace then bail)', async () => {
    // With no live heal-agent pty, the `pty-died` grace path is what gets
    // exercised — the hard/idle timeouts only apply while the REPL is up.
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healSignalPollMs: 0,
    })
    const { signal, reason } = await orch.waitForHealSignal(5_000, 5_000)
    expect(signal).toBeNull()
    expect(reason).toBe('pty-died')
  })

  it('returns stopped when the orchestrator has been aborted', async () => {
    const { factory } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healSignalPollMs: 0,
    })
    await orch.stop('aborted')
    const { signal, reason } = await orch.waitForHealSignal(50, 50)
    expect(signal).toBeNull()
    expect(reason).toBe('stopped')
  })
})
