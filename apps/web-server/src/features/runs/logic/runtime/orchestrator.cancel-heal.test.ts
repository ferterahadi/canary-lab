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

describe('RunOrchestrator.cancelHeal', () => {
  it('returns not-healing when status is not healing', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      delay: async () => undefined,
    })
    expect(await orch.cancelHeal()).toEqual({ ok: false, reason: 'not-healing' })
  })

  it('succeeds even when healing-but-no-pty (REPL exited unexpectedly)', async () => {
    // Regression: when claude's REPL crashes / exits via `/exit` mid-cycle,
    // the orchestrator nulls `healAgentPty` but stays in `'healing'` until
    // `waitForHealSignal` notices. The user's only way out is cancel — and
    // it MUST succeed (set the cancel flag, return ok) even when there's
    // no live pty to SIGTERM, so the loop bails on its next tick.
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      delay: async () => undefined,
    })
    orch.setStatus('healing')
    expect(await orch.cancelHeal()).toEqual({ ok: true })
  })

  it('SIGTERMs the heal-agent pty, breaks the loop, and stops the run as failed', async () => {
    fs.mkdirSync(runDir, { recursive: true })
    const f = makeFakeFactory()
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 200,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 5, buildSpawnCommand: () => `heal-${healIdx++}` },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 3, passed: 0 }),
    )
    const promise = orch.runFullCycle()
    // Drive the lifecycle: services + Playwright spawn → fail → heal agent
    // spawns → user cancels mid-cycle.
    await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(1) // Playwright fails
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    const agentPty = f.spawned[2]
    const result = await orch.cancelHeal()
    expect(result).toEqual({ ok: true })
    expect(agentPty.killed).toBe('SIGTERM')
    agentPty.emitExit(143)
    const finalStatus = await promise
    expect(finalStatus).toBe('failed')
    const m = readManifest(orch.paths.manifestPath)!
    expect(m.stoppedEarly?.reason).toBe('user-cancel-heal')
    await orch.stop('failed')
  })

  it('also accepts cancel during the post-heal Playwright rerun (status=running, healCycles>0)', async () => {
    // Regression: between cycles the orchestrator flips status to `running`
    // for the Playwright rerun. Stop Heal clicked during that window used
    // to silently 409 (`not-healing`). Now `cancelHeal` accepts it,
    // SIGTERMs the playwright pty, and the loop's post-Playwright
    // `healCancelled` check finalizes the run as `failed`.
    fs.mkdirSync(runDir, { recursive: true })
    const f = makeFakeFactory()
    let pwIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 200,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: {
        agent: 'claude',
        maxCycles: 5,
        buildSpawnCommand: () => 'cat',
        buildCyclePrompt: () => 'prompt',
      },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a', location: 'e2e/a.spec.ts:1' }] }),
    )
    const statuses: string[] = []
    orch.on('run-status', (e) => statuses.push(e.status))

    const promise = orch.runFullCycle()
    // Drive: services boot + Playwright fails → heal agent (status=healing).
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    // Agent writes a .rerun signal to advance the loop into the
    // post-heal Playwright phase (status flips to `running`).
    fs.writeFileSync(orch.paths.rerunSignal, JSON.stringify({ hypothesis: 'try again' }))
    while (!statuses.includes('running')) await new Promise((r) => setTimeout(r, 5))
    while (f.spawned.length < 4) await new Promise((r) => setTimeout(r, 5))
    const pwPty = f.spawned[3]

    // User clicks Stop Heal mid-Playwright.
    const result = await orch.cancelHeal()
    expect(result).toEqual({ ok: true })
    expect(pwPty.killed).toBe('SIGTERM')
    pwPty.emitExit(143)

    const finalStatus = await promise
    expect(finalStatus).toBe('failed')
    const m = readManifest(orch.paths.manifestPath)!
    expect(m.stoppedEarly?.reason).toBe('user-cancel-heal')
    await orch.stop('failed')
  }, 10000)

  it('killTree sends SIGTERM to the process group (negative pid) before falling back', async () => {
    fs.mkdirSync(runDir, { recursive: true })
    const f = makeFakeFactory()
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 200,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 5, buildSpawnCommand: () => `heal-${healIdx++}` },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 3, passed: 0 }),
    )
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    })
    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    const agentPty = f.spawned[2]
    await orch.cancelHeal()
    // Negative pid → process-group kill of the agent's pty.
    expect(killSpy).toHaveBeenCalledWith(-agentPty.pid, 'SIGTERM')
    // Fallback path also fired (fake pty's kill recorded the signal).
    expect(agentPty.killed).toBe('SIGTERM')
    killSpy.mockRestore()
    agentPty.emitExit(143)
    await promise
    await orch.stop('failed')
  })
})

describe('RunOrchestrator.interjectHealAgent', () => {
  it('returns no-agent-running when no heal pty is in flight', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature(),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      delay: async () => undefined,
    })
    const result = await orch.interjectHealAgent('nudge')
    expect(result).toEqual({ ok: false, reason: 'no-agent-running' })
  })

  it('writes Esc + text + Enter to the live REPL stdin without respawning', async () => {
    fs.mkdirSync(runDir, { recursive: true })
    const f = makeFakeFactory()
    let pwIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 200,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: {
        agent: 'claude',
        maxCycles: 1,
        buildSpawnCommand: () => 'claude --dangerously-skip-permissions',
        buildCyclePrompt: ({ cycle }) => `cycle-${cycle}-prompt`,
      },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 3, passed: 0 }),
    )
    const agentChunks: string[] = []
    orch.on('agent-output', ({ chunk }) => agentChunks.push(chunk))
    const statusEvents: string[] = []
    orch.on('run-status', ({ status }) => statusEvents.push(status))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(1)
    // Wait for the REPL to spawn (idx 2 = agent, after services + playwright).
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    const agent = f.spawned[2]
    // Drain the cycle-1 prompt write from pty.write so we can assert the
    // interject writes cleanly afterward.
    const writeMock = (agent as unknown as { options: PtySpawnOptions }).options
    void writeMock
    // The interject lands as Esc + text + Enter. No new pty is spawned —
    // the existing REPL keeps running.
    const beforeSpawnCount = f.spawned.length
    const result = await orch.interjectHealAgent('nudge fix')
    expect(result).toEqual({ ok: true })
    expect(f.spawned.length).toBe(beforeSpawnCount)
    // Agent-output stream echoes the user's redirect block to live xterm.
    const echoed = agentChunks.join('')
    expect(echoed).toContain('user interject')
    expect(echoed).toContain('  │ nudge fix')
    // Status stays in healing — interject does not flip the run state.
    expect(readManifest(orch.paths.manifestPath)?.status).toBe('healing')
    expect(statusEvents).not.toContain('running')
    // The fake pty's write was called with the Esc preamble + text + \r.
    // (FakeProcess uses `write: vi.fn()` so it captures every call.)
    const ptyWrite = (orch as unknown as { ctx: { healAgentPty: { write: ReturnType<typeof vi.fn> } | null } }).ctx.healAgentPty?.write
    expect(ptyWrite).toBeDefined()
    const writeCalls = (ptyWrite as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]).join('')
    expect(writeCalls).toContain('nudge fix')
    expect(writeCalls).toContain('')

    // Let the loop time out (no signal landed) and exit cleanly.
    await promise
    await orch.stop('failed')
  })

  it('preserves multi-line user interject text in the pane and transcript', async () => {
    fs.mkdirSync(runDir, { recursive: true })
    const f = makeFakeFactory()
    let pwIdx = 0
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 5,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 200,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: {
        agent: 'claude',
        maxCycles: 1,
        buildSpawnCommand: () => 'claude',
        buildCyclePrompt: () => 'cycle-prompt',
      },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 3, passed: 0 }),
    )
    const agentChunks: string[] = []
    orch.on('agent-output', ({ chunk }) => agentChunks.push(chunk))
    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    const beforeSpawnCount = f.spawned.length

    expect(await orch.interjectHealAgent('first line\nsecond line\nthird line')).toEqual({ ok: true })
    expect(f.spawned.length).toBe(beforeSpawnCount) // no respawn
    const echoed = agentChunks.join('')
    expect(echoed).toContain('  │ first line\n  │ second line\n  │ third line')

    await promise
    await orch.stop('failed')
  })
})

describe('RunOrchestrator.restartHealFromFailure', () => {
  it('starts the heal agent without a fresh Playwright run and passes user guidance into the command builder', async () => {
    const f = makeFakeFactory()
    let receivedGuidance: string | undefined
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 20,
      playwrightSpawner: () => ({ command: 'pw-should-not-run', cwd: tmpDir }),
      autoHeal: {
        agent: 'codex',
        maxCycles: 1,
        buildSpawnCommand: () => 'codex heal restart',
        buildCyclePrompt: ({ userGuidance }) => {
          receivedGuidance = userGuidance
          return `restart-prompt`
        },
      },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
    )
    const agentChunks: string[] = []
    orch.on('agent-output', ({ chunk }) => agentChunks.push(chunk))
    const serviceStarts: string[] = []
    orch.on('service-started', ({ service }) => serviceStarts.push(service.name))

    const promise = orch.restartHealFromFailure('look at fallback country mapping')
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    expect(f.spawned[0].options.command).toBe('codex heal restart')
    expect(receivedGuidance).toBe('look at fallback country mapping')
    expect(readManifest(orch.paths.manifestPath)?.status).toBe('healing')
    expect(serviceStarts).toEqual([])
    const echoed = agentChunks.join('')
    expect(echoed).toContain('user interject')
    expect(echoed).toContain('  │ look at fallback country mapping')
    f.spawned[0].emitExit(0)

    expect(await promise).toBe('failed')
    await orch.stop('failed')
  })
})
