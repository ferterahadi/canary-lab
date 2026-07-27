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

describe('RunOrchestrator heal-agent spawn failures', () => {
  it('surfaces + propagates a build-spawn-command error and never leaves a heal pty', async () => {
    const f = makeFakeFactory()
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
      playwrightSpawner: () => ({ command: 'pw', cwd: tmpDir }),
      autoHeal: {
        agent: 'claude',
        maxCycles: 1,
        buildSpawnCommand: () => { throw new Error('cannot build command') },
      },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }))
    const chunks: string[] = []
    orch.on('agent-output', (e) => chunks.push(e.chunk))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    await expect(promise).rejects.toThrow('cannot build command')
    expect(chunks.join('')).toContain('Failed to build heal-agent spawn command: cannot build command')
    await orch.stop('failed')
  })

  it('surfaces + propagates a pty-factory spawn error for the heal agent', async () => {
    const base = makeFakeFactory()
    const factory: PtyFactory = (opts) => {
      if (opts.command === 'HEAL_SPAWN') throw new Error('spawn refused')
      return base.factory(opts)
    }
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 1000,
      playwrightSpawner: () => ({ command: 'pw', cwd: tmpDir }),
      autoHeal: {
        agent: 'claude',
        maxCycles: 1,
        buildSpawnCommand: () => 'HEAL_SPAWN',
      },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }))
    const chunks: string[] = []
    orch.on('agent-output', (e) => chunks.push(e.chunk))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    base.spawned[1].emitExit(1)
    await expect(promise).rejects.toThrow('spawn refused')
    expect(chunks.join('')).toContain('Failed to spawn heal agent: spawn refused')
    await orch.stop('failed')
  })
})

describe('RunOrchestrator.restartTerminalRun terminal branches', () => {
  it('returns passed immediately when every known test already passed', async () => {
    const f = makeFakeFactory()
    const featureDir = path.join(tmpDir, 'features', 'demo')
    fs.mkdirSync(featureDir, { recursive: true })
    const runnerLog = new RunnerLog(path.join(tmpDir, 'runner.log'))
    const orch = new RunOrchestrator({
      feature: makeFeature({ featureDir, repos: [] }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      runnerLog,
      playwrightSpawner: () => { throw new Error('playwright must not run when all tests already passed') },
    })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({
      total: 2,
      passed: 2,
      passedNames: ['test-a', 'test-b'],
      knownTests: [
        { name: 'test-a', title: 'A', location: `${featureDir}/e2e/spec.ts:10` },
        { name: 'test-b', title: 'B', location: `${featureDir}/e2e/spec.ts:20` },
      ],
    }))

    const status = await orch.restartTerminalRun('please re-verify')
    expect(status).toBe('passed')
    expect(f.spawned).toHaveLength(0)
    expect(fs.readFileSync(path.join(tmpDir, 'runner.log'), 'utf-8')).toContain('Terminal run restart guidance: please re-verify')
    expect(readManifest(orch.paths.manifestPath)?.status).toBe('passed')
    await orch.stop('passed')
  })

  it('runs the full suite when the plan is all-passed but there is no passing evidence', async () => {
    const f = makeFakeFactory()
    const featureDir = path.join(tmpDir, 'features', 'demo-empty-evidence')
    fs.mkdirSync(featureDir, { recursive: true })
    const orch = new RunOrchestrator({
      feature: makeFeature({ featureDir, repos: [] }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      playwrightSpawner: () => ({ command: 'pw-full', cwd: tmpDir }),
    })
    // Empty summary → all-passed plan (nothing to target) with NO passing evidence.
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({}))
    const chunks: string[] = []
    orch.on('playwright-output', (e) => chunks.push(e.chunk))

    const promise = orch.restartTerminalRun()
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    // The full suite runs with no targeting.
    expect(f.spawned[0].options.command).toBe('pw-full')
    expect(f.spawned[0].options.env?.CANARY_LAB_TARGETED_RERUN).toBeUndefined()
    f.spawned[0].emitExit(0)
    const status = await promise
    expect(status).toBe('passed')
    expect(chunks.join('')).toContain('running the full Playwright suite')
    const events = fs.readFileSync(orch.paths.lifecycleEventsPath, 'utf-8')
    expect(events).toContain('Full restart rerun selected')
    await orch.stop('passed')
  })

  it('routes a boot failure into a failed terminal run without launching Playwright', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => false,
      delay: async () => undefined,
      healthDeadlineMs: 5,
      healthPollIntervalMs: 1,
      playwrightSpawner: () => { throw new Error('playwright must not run on boot failure') },
    })
    const status = await orch.restartTerminalRun()
    expect(status).toBe('failed')
    // Only the service pty — Playwright never spawned.
    expect(f.spawned).toHaveLength(1)
    expect(readManifest(orch.paths.manifestPath)?.bootFailure).toMatchObject({ service: 'api' })
    await orch.stop('failed')
  })
})

describe('RunOrchestrator.runVerification', () => {
  it('runs Playwright observationally and reports passed', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature({ repos: [] }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      delay: async () => undefined,
      playwrightSpawner: () => ({ command: 'pw-verify', cwd: tmpDir }),
      executionType: 'run',
    })
    const promise = orch.runVerification()
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    // No service ever booted — verification does not start services.
    expect(f.spawned).toHaveLength(1)
    expect(f.spawned[0].options.command).toBe('pw-verify')
    f.spawned[0].emitExit(0)
    const status = await promise
    expect(status).toBe('passed')
    const events = fs.readFileSync(orch.paths.lifecycleEventsPath, 'utf-8')
    expect(events).toContain('Verify is observational only')
    await orch.stop('passed')
  })

  it('keeps status aborted when the run is stopped while Playwright is in flight', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature({ repos: [] }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      delay: async () => undefined,
      playwrightSpawner: () => ({ command: 'pw-verify', cwd: tmpDir }),
    })
    const promise = orch.runVerification()
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    await orch.stop('aborted')
    f.spawned[0].emitExit(0)
    const status = await promise
    expect(status).toBe('aborted')
  })
})

describe('RunOrchestrator.bootOnly', () => {
  it('boots services, holds them, and records the services-ready phase', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 1,
      executionType: 'boot',
    })
    await orch.bootOnly()
    expect(f.spawned).toHaveLength(1)
    expect(readManifest(orch.paths.manifestPath)?.lifecycle).toMatchObject({
      phase: 'services-ready',
    })
    await orch.stop('aborted')
  })

  it('returns early without recording services-ready when aborted mid-boot', async () => {
    const f = makeFakeFactory()
    let resolveHealth!: (ok: boolean) => void
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => new Promise<boolean>((resolve) => { resolveHealth = resolve }),
      delay: async () => undefined,
      healthPollIntervalMs: 1,
      executionType: 'boot',
    })
    const promise = orch.bootOnly()
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    await orch.stop('aborted')
    resolveHealth(true)
    await promise
    // stop() wrote the terminal phase; services-ready was skipped by the abort guard.
    expect(readManifest(orch.paths.manifestPath)?.lifecycle?.phase).not.toBe('services-ready')
  })
})

describe('RunOrchestrator boot failure during a heal restart', () => {
  it('auto-heal: a service that fails health on restart records a heal-wait and loops', async () => {
    const f = makeFakeFactory()
    let pwIdx = 0
    let servicesHealthy = true
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => servicesHealthy,
      delay: async () => undefined,
      healthPollIntervalMs: 1,
      healthDeadlineMs: 15,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 60_000,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: {
        agent: 'claude',
        maxCycles: 5,
        buildSpawnCommand: () => 'live-agent',
        buildCyclePrompt: () => 'prompt',
      },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1) // pw fails → heal loop, agent spawns at idx 2
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))

    // The service will fail health after the restart the signal triggers.
    servicesHealthy = false
    fs.writeFileSync(orch.paths.restartSignal, JSON.stringify({ hypothesis: 'restart it' }))

    // Wait for the heal-wait lifecycle event proving the boot-failure branch ran.
    const start = Date.now()
    while (!fs.readFileSync(orch.paths.lifecycleEventsPath, 'utf-8').includes('Service still down')) {
      if (Date.now() - start > 6000) throw new Error('never recorded boot-failure heal wait')
      await new Promise((r) => setTimeout(r, 10))
    }
    const events = fs.readFileSync(orch.paths.lifecycleEventsPath, 'utf-8')
    expect(events).toContain('Service still down: api')

    await orch.stop('failed')
    await promise
  }, 15000)

  it('manual-heal: a service that fails health on restart records a heal-wait and loops', async () => {
    const f = makeFakeFactory()
    let pwIdx = 0
    let servicesHealthy = true
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => servicesHealthy,
      delay: async () => undefined,
      healthPollIntervalMs: 1,
      healthDeadlineMs: 15,
      healSignalPollMs: 1,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      manualHeal: true,
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a', location: 'e2e/a.spec.ts:2' }], total: 1, passed: 0 }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1) // pw fails → manual heal loop waits for a signal

    while (readManifest(orch.paths.manifestPath)?.lifecycle?.phase !== 'waiting-for-signal') {
      await new Promise((r) => setTimeout(r, 5))
    }
    servicesHealthy = false
    fs.writeFileSync(orch.paths.restartSignal, JSON.stringify({ hypothesis: 'user restart' }))

    const start = Date.now()
    while (!fs.readFileSync(orch.paths.lifecycleEventsPath, 'utf-8').includes('Service still down')) {
      if (Date.now() - start > 6000) throw new Error('never recorded boot-failure heal wait')
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(fs.readFileSync(orch.paths.lifecycleEventsPath, 'utf-8')).toContain('Service still down: api')

    await orch.stop('aborted')
    await promise
  }, 15000)
})
