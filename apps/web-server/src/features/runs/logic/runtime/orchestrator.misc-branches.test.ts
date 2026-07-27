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

describe('RunOrchestrator misc branches', () => {
  it('records the Playwright process signal in the exit lifecycle detail', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      playwrightSpawner: () => ({ command: 'pw', cwd: tmpDir }),
    })
    await orch.start()
    const exitPromise = orch.runPlaywright()
    const pwPty = f.spawned[f.spawned.length - 1]
    pwPty.emitExit(143, 15)
    await exitPromise
    const events = fs.readFileSync(orch.paths.lifecycleEventsPath, 'utf-8')
    expect(events).toContain('Process signal: 15')
    await orch.stop('failed')
  })

  it('runPlaywright with an empty rerun target array is treated as a full run', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      playwrightSpawner: () => ({ command: 'pw', cwd: tmpDir }),
    })
    await orch.start()
    const exitPromise = orch.runPlaywright([])
    const pwPty = f.spawned[f.spawned.length - 1]
    // Empty targets normalize to undefined selection → no targeted-rerun marker.
    expect(pwPty.options.env?.CANARY_LAB_TARGETED_RERUN).toBeUndefined()
    pwPty.emitExit(0)
    await exitPromise
    await orch.stop('passed')
  })

  it('auto-heal finishes passed from the pending branch when the summary already shows all tests passed', async () => {
    const f = makeFakeFactory()
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    const orch = new RunOrchestrator({
      feature: makeFeature({ featureDir, repos: [] }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 1000,
      playwrightSpawner: () => ({ command: 'pw', cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildSpawnCommand: () => 'live-agent', buildCyclePrompt: () => 'p' },
    })
    // No failed slugs but a non-zero exit forces the heal loop; the pending
    // branch then sees an all-passed plan WITH passing evidence and finalizes
    // the run as passed without spawning a heal agent.
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({
      knownTests: [{ name: 'test-t', title: 'T' }],
      passedNames: ['test-t'],
      passed: 1,
      total: 1,
      failed: [],
    }))

    const promise = orch.runFullCycle()
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    f.spawned[0].emitExit(1) // Playwright exits non-zero → heal loop entered
    const status = await promise
    expect(status).toBe('passed')
    // No heal agent (idx 1) was ever spawned — the pending branch short-circuited.
    expect(f.spawned).toHaveLength(1)
    await orch.stop('passed')
  })

  it('auto-heal warns when the signal body carries non-string hypothesis/fixDescription fields', async () => {
    const f = makeFakeFactory()
    let pwIdx = 0
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
      autoHeal: { agent: 'claude', maxCycles: 1, buildSpawnCommand: () => 'live-agent', buildCyclePrompt: () => 'p' },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }))
    const chunks: string[] = []
    orch.on('agent-output', (e) => chunks.push(e.chunk))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    // Malformed body: both fields are numbers, not strings.
    fs.writeFileSync(orch.paths.rerunSignal, JSON.stringify({ hypothesis: 123, fixDescription: 456 }))
    f.spawned[2].emitExit(0)
    while (f.spawned.length < 4) await new Promise((r) => setTimeout(r, 5))
    f.spawned[3].emitExit(1) // rerun still fails; maxCycles=1 → loop ends
    const status = await promise
    expect(status).toBe('failed')
    const emitted = chunks.join('')
    expect(emitted).toContain('Signal body field `hypothesis` was not a string')
    expect(emitted).toContain('Signal body field `fixDescription` was not a string')
    await orch.stop('failed')
  }, 15000)

  it('honours a relocated signals dir and writes the external heal session into the manifest', async () => {
    const f = makeFakeFactory()
    const signalsDir = path.join(tmpDir, 'custom-signals')
    const externalHealSession = {
      clientKind: 'claude' as const,
      sessionId: 'sess-123',
      conversationName: 'Fix checkout',
      claimedAt: '2026-01-01T00:00:00.000Z',
      lastHeartbeatAt: '2026-01-01T00:00:05.000Z',
      status: 'waiting' as const,
      cycleCount: 0,
    }
    const orch = new RunOrchestrator({
      feature: makeFeature({ repos: [] }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      signalsDir,
      externalHeal: true,
      externalHealSession,
    })
    expect(orch.paths.signalsDir).toBe(signalsDir)
    await orch.start()
    const manifest = readManifest(orch.paths.manifestPath)!
    expect(manifest.healMode).toBe('external')
    expect(manifest.externalHealSession).toEqual(externalHealSession)
    await orch.stop('aborted')
  })
})
