import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { RunOrchestrator } from './orchestrator'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runDirFor } from './run-paths'
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

describe('RunOrchestrator.runPlaywright', () => {
  it('emits started + output + exit and tees to playwright.log', async () => {
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      playwrightSpawner: () => ({ command: 'fake-pw', cwd: tmpDir }),
    })
    const events: string[] = []
    orch.on('playwright-started', (e) => events.push(`start:${e.command}`))
    orch.on('playwright-output', (e) => events.push(`out:${e.chunk.trim()}`))
    orch.on('playwright-exit', (e) => events.push(`exit:${e.exitCode}`))

    await orch.start()
    const exitPromise = orch.runPlaywright()
    // The most recently spawned pty is Playwright (after the service).
    const pwPty = spawned[spawned.length - 1]
    pwPty.emitData('1 passed\n')
    pwPty.emitExit(0)
    const code = await exitPromise

    expect(code).toBe(0)
    expect(events[0]).toBe('start:fake-pw')
    expect(events).toContain('out:1 passed')
    expect(events.at(-1)).toBe('exit:0')
    expect(pwPty.options.env).toMatchObject({
      CANARY_LAB_MANIFEST_PATH: orch.paths.manifestPath,
      CANARY_LAB_SUMMARY_PATH: orch.paths.summaryPath,
    })
    expect(pwPty.options.env?.CANARY_LAB_TARGETED_RERUN).toBeUndefined()
    const log = fs.readFileSync(orch.paths.playwrightStdoutPath, 'utf-8')
    expect(log).toContain('1 passed')
    await orch.stop('passed')
  })

  it('exposes per-run allocated ports to Playwright as CANARY_PORT_<slot>', async () => {
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature({ repos: [] }),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      delay: async () => undefined,
      playwrightSpawner: () => ({ command: 'fake-pw', cwd: tmpDir }),
      portMap: new Map([['api', 51999], ['admin', 51998]]),
    })
    await orch.start()
    const exitPromise = orch.runPlaywright()
    const pwPty = spawned[spawned.length - 1]
    pwPty.emitExit(0)
    await exitPromise
    expect(pwPty.options.env).toMatchObject({
      CANARY_PORT_api: '51999',
      CANARY_PORT_admin: '51998',
    })
    await orch.stop('passed')
  })

  it('marks targeted reruns so the summary reporter can merge previous statuses', async () => {
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      playwrightSpawner: ({ rerunTargets }) => ({
        command: `fake-pw ${rerunTargets?.join(' ') ?? ''}`.trim(),
        cwd: tmpDir,
      }),
    })

    await orch.start()
    const exitPromise = orch.runPlaywright(['e2e/a.spec.ts:10'])
    const pwPty = spawned[spawned.length - 1]
    pwPty.emitExit(0)
    await exitPromise

    expect(pwPty.options.env).toMatchObject({
      CANARY_LAB_TARGETED_RERUN: '1',
      CANARY_LAB_MANIFEST_PATH: orch.paths.manifestPath,
      CANARY_LAB_SUMMARY_PATH: orch.paths.summaryPath,
    })
    expect(readManifest(orch.paths.manifestPath)?.lifecycle?.targetedRerun).toMatchObject({
      selected: 1,
      mode: 'failed-and-pending',
    })
    await orch.stop('passed')
  })

  it('refreshes the stop-and-heal threshold from disk before each Playwright spawn', async () => {
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), [
      'exports.config = {',
      '  name: "demo",',
      '  description: "demo",',
      '  envs: ["local"],',
      '  featureDir: __dirname,',
      '  repos: [],',
      '  healOnFailureThreshold: 4,',
      '}',
      '',
    ].join('\n'))
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature({ featureDir, repos: [], healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
    })

    const firstRun = orch.runPlaywright()
    spawned.at(-1)!.emitExit(1)
    await firstRun
    expect(spawned.at(-1)!.options.command).toContain('--max-failures=4')

    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), [
      'exports.config = {',
      '  name: "demo",',
      '  description: "demo",',
      '  envs: ["local"],',
      '  featureDir: __dirname,',
      '  repos: [],',
      '}',
      '',
    ].join('\n'))

    const secondRun = orch.runPlaywright()
    spawned.at(-1)!.emitExit(1)
    await secondRun
    // The rewritten config omits healOnFailureThreshold, so the disk reload
    // picks up the default (2) rather than the prior 4 — proving the refresh
    // and the every-feature default both apply per spawn.
    expect(spawned.at(-1)!.options.command).toContain('--max-failures=2')
  })

  it('mirrors per-test artifact dirs into playwright-artifacts-keep on Playwright exit', async () => {
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      playwrightSpawner: () => ({ command: 'fake-pw', cwd: tmpDir }),
    })

    await orch.start()
    const exitPromise = orch.runPlaywright()
    const pwPty = spawned[spawned.length - 1]
    // Simulate Playwright writing per-test artifacts into the live dir
    // before the process exits.
    const liveCase = path.join(orch.paths.playwrightArtifactsDir, 'pw-slug-a')
    fs.mkdirSync(liveCase, { recursive: true })
    fs.writeFileSync(path.join(liveCase, 'video.webm'), 'fresh-webm')
    fs.writeFileSync(path.join(liveCase, 'trace.zip'), 'fresh-trace')
    pwPty.emitExit(0)
    await exitPromise

    const keepCase = path.join(orch.paths.playwrightArtifactsKeepDir, 'pw-slug-a')
    expect(fs.readFileSync(path.join(keepCase, 'video.webm'), 'utf-8')).toBe('fresh-webm')
    expect(fs.readFileSync(path.join(keepCase, 'trace.zip'), 'utf-8')).toBe('fresh-trace')
    await orch.stop('passed')
  })

  it('overwrites the keep copy for the same pw-slug and preserves untouched tests', async () => {
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      playwrightSpawner: () => ({ command: 'fake-pw', cwd: tmpDir }),
    })

    // Pre-seed the keep dir as if a prior cycle had run two tests: A and B.
    const keepA = path.join(orch.paths.playwrightArtifactsKeepDir, 'pw-a')
    const keepB = path.join(orch.paths.playwrightArtifactsKeepDir, 'pw-b')
    fs.mkdirSync(keepA, { recursive: true })
    fs.mkdirSync(keepB, { recursive: true })
    fs.writeFileSync(path.join(keepA, 'video.webm'), 'a-stale')
    fs.writeFileSync(path.join(keepB, 'video.webm'), 'b-stale')

    await orch.start()
    const exitPromise = orch.runPlaywright()
    const pwPty = spawned[spawned.length - 1]
    // The "rerun" only writes test A's pw-slug into the live dir.
    const liveA = path.join(orch.paths.playwrightArtifactsDir, 'pw-a')
    fs.mkdirSync(liveA, { recursive: true })
    fs.writeFileSync(path.join(liveA, 'video.webm'), 'a-fresh')
    pwPty.emitExit(0)
    await exitPromise

    // A is overwritten with the latest attempt's bytes.
    expect(fs.readFileSync(path.join(keepA, 'video.webm'), 'utf-8')).toBe('a-fresh')
    // B is untouched — it wasn't in this rerun's live dir.
    expect(fs.readFileSync(path.join(keepB, 'video.webm'), 'utf-8')).toBe('b-stale')
    await orch.stop('passed')
  })

  it('leaves the keep dir untouched when the live artifacts path is unreadable (readdirSync throws)', async () => {
    const { factory, spawned } = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      playwrightSpawner: () => ({ command: 'fake-pw', cwd: tmpDir }),
    })
    await orch.start()
    const exitPromise = orch.runPlaywright()
    const pwPty = spawned[spawned.length - 1]
    // The live artifacts "dir" is actually a plain file — readdirSync throws
    // ENOTDIR and persistPlaywrightArtifacts swallows it (best-effort; must
    // never fail the run over artifact bookkeeping).
    fs.mkdirSync(path.dirname(orch.paths.playwrightArtifactsDir), { recursive: true })
    fs.writeFileSync(orch.paths.playwrightArtifactsDir, 'not a directory')
    pwPty.emitExit(0)
    await exitPromise
    expect(fs.existsSync(orch.paths.playwrightArtifactsKeepDir)).toBe(true)
    expect(fs.readdirSync(orch.paths.playwrightArtifactsKeepDir)).toEqual([])
    await orch.stop('passed')
  })

  it('warns via runnerLog and continues persisting other tests when one artifact dir cannot be copied', async () => {
    const { factory, spawned } = makeFakeFactory()
    const runnerLog = new RunnerLog(path.join(tmpDir, 'runner.log'))
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      playwrightSpawner: () => ({ command: 'fake-pw', cwd: tmpDir }),
      runnerLog,
    })
    await orch.start()
    const exitPromise = orch.runPlaywright()
    const pwPty = spawned[spawned.length - 1]
    const blockedLive = path.join(orch.paths.playwrightArtifactsDir, 'pw-blocked')
    fs.mkdirSync(blockedLive, { recursive: true })
    fs.writeFileSync(path.join(blockedLive, 'video.webm'), 'x')
    const okLive = path.join(orch.paths.playwrightArtifactsDir, 'pw-ok')
    fs.mkdirSync(okLive, { recursive: true })
    fs.writeFileSync(path.join(okLive, 'video.webm'), 'ok-bytes')
    fs.chmodSync(blockedLive, 0o000)
    try {
      pwPty.emitExit(0)
      await exitPromise
    } finally {
      fs.chmodSync(blockedLive, 0o755)
    }
    const log = fs.readFileSync(path.join(tmpDir, 'runner.log'), 'utf-8')
    expect(log).toContain('persist playwright artifact pw-blocked failed')
    // The failure on pw-blocked didn't abort the loop — pw-ok still got copied.
    expect(fs.readFileSync(path.join(orch.paths.playwrightArtifactsKeepDir, 'pw-ok', 'video.webm'), 'utf-8')).toBe('ok-bytes')
    await orch.stop('passed')
  })
})
