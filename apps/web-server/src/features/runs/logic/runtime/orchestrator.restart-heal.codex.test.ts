import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { RunOrchestrator } from './orchestrator'
import * as sessionLog from '../../../agent-sessions/logic/agent-session-log'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runDirFor, buildRunPaths } from './run-paths'
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

describe('RunOrchestrator.restartHealFromFailure', () => {
  it('codex restart: can reuse a prior session id from agent-session.json', async () => {
    const PRIOR_SID = 'b2160db2-89b8-49ff-a2ba-c0c97a52d63f'
    const paths = buildRunPaths(runDir)
    fs.writeFileSync(paths.agentSessionRefPath, JSON.stringify({
      agent: 'codex',
      sessionId: PRIOR_SID,
      logPath: '/tmp/codex-session.jsonl',
    }))

    const f = makeFakeFactory()
    const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
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
        buildSpawnCommand: ({ sessionId, resume }) => {
          spawnCalls.push({ sessionId, resume })
          return 'codex heal restart'
        },
        buildCyclePrompt: () => 'restart-prompt',
      },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
    )

    const promise = orch.restartHealFromFailure('look again')
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    expect(spawnCalls).toEqual([{ sessionId: PRIOR_SID, resume: true }])
    expect(fs.readFileSync(paths.agentSessionIdPath, 'utf-8').trim()).toBe(PRIOR_SID)
    f.spawned[0].emitExit(0)
    expect(await promise).toBe('failed')
    await orch.stop('failed')
  })

  it('codex restart: injects previous Claude session context into the heal prompt', async () => {
    const paths = buildRunPaths(runDir)
    fs.writeFileSync(paths.agentSessionRefPath, JSON.stringify({
      agent: 'claude',
      sessionId: 'd5f3e235-2470-4a1c-bb31-2030880a1670',
      logPath: '/tmp/claude-session.jsonl',
    }))
    fs.writeFileSync(paths.agentSessionIdPath, 'd5f3e235-2470-4a1c-bb31-2030880a1670')
    const renderSpy = vi.spyOn(sessionLog, 'renderAgentSessionContext')
      .mockReturnValue('Previous claude session d5f3...\nASSISTANT: use FAKE_CNS_v1_BASE_URL')

    try {
      const f = makeFakeFactory()
      let receivedContext: string | undefined
      const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
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
          buildSpawnCommand: ({ sessionId, resume }) => {
            spawnCalls.push({ sessionId, resume })
            return 'codex heal restart'
          },
          buildCyclePrompt: ({ priorAgentSessionContext }) => {
            receivedContext = priorAgentSessionContext
            return 'restart-prompt'
          },
        },
      })
      fs.writeFileSync(
        orch.paths.summaryPath,
        JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
      )

      const promise = orch.restartHealFromFailure('look again')
      while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
      expect(renderSpy).toHaveBeenCalledWith({
        agent: 'claude',
        sessionId: 'd5f3e235-2470-4a1c-bb31-2030880a1670',
        logPath: '/tmp/claude-session.jsonl',
      })
      expect(receivedContext).toContain('Previous claude session')
      expect(receivedContext).toContain('FAKE_CNS_v1_BASE_URL')
      expect(spawnCalls).toEqual([{ sessionId: undefined, resume: false }])
      f.spawned[0].emitExit(0)
      expect(await promise).toBe('failed')
      await orch.stop('failed')
    } finally {
      renderSpy.mockRestore()
    }
  })

  it('codex restart: recovers a missing pointer from the native Codex session log', async () => {
    const PRIOR_SID = 'b2160db2-89b8-49ff-a2ba-c0c97a52d63f'
    const paths = buildRunPaths(runDir)
    fs.writeFileSync(paths.agentSessionRefPath, JSON.stringify({
      activeAgent: 'claude',
      sessions: {
        claude: {
          agent: 'claude',
          sessionId: 'd5f3e235-2470-4a1c-bb31-2030880a1670',
          logPath: '/tmp/claude-session.jsonl',
        },
      },
    }))
    const locateSpy = vi.spyOn(sessionLog, 'locateLatestSessionLogForAgent').mockReturnValue({
      agent: 'codex',
      sessionId: PRIOR_SID,
      logPath: '/tmp/codex-session.jsonl',
    })

    try {
      const f = makeFakeFactory()
      const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
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
          buildSpawnCommand: ({ sessionId, resume }) => {
            spawnCalls.push({ sessionId, resume })
            return 'codex heal restart'
          },
          buildCyclePrompt: () => 'restart-prompt',
        },
      })
      fs.writeFileSync(
        orch.paths.summaryPath,
        JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
      )

      const promise = orch.restartHealFromFailure('look again')
      while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
      expect(locateSpy).toHaveBeenCalledWith('codex', runDir)
      expect(spawnCalls).toEqual([{ sessionId: PRIOR_SID, resume: true }])
      expect(fs.readFileSync(paths.agentSessionIdPath, 'utf-8').trim()).toBe(PRIOR_SID)
      expect(JSON.parse(fs.readFileSync(paths.agentSessionRefPath, 'utf-8'))).toEqual({
        activeAgent: 'codex',
        sessions: {
          claude: {
            agent: 'claude',
            sessionId: 'd5f3e235-2470-4a1c-bb31-2030880a1670',
            logPath: '/tmp/claude-session.jsonl',
          },
          codex: {
            agent: 'codex',
            sessionId: PRIOR_SID,
            logPath: '/tmp/codex-session.jsonl',
          },
        },
      })
      f.spawned[0].emitExit(0)
      expect(await promise).toBe('failed')
      await orch.stop('failed')
    } finally {
      locateSpy.mockRestore()
    }
  })
})

describe('RunOrchestrator runFullCycle stoppedEarly', () => {
  it('marks stoppedEarly=max-failures when threshold is hit before heal cycle', async () => {
    const f = makeFakeFactory()
    const feature = makeFeature({ healOnFailureThreshold: 1 })
    let pwIdx = 0
    let healIdx = 0
    const orch = new RunOrchestrator({
      feature,
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
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 11, passed: 0 }),
    )
    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    f.spawned[2].emitExit(0) // agent gives up — we just need the stoppedEarly stamp
    await promise
    const m = readManifest(orch.paths.manifestPath)!
    expect(m.stoppedEarly?.reason).toBe('max-failures')
    expect(m.stoppedEarly?.failuresAtStop).toBe(1)
    expect(m.stoppedEarly?.suiteTotal).toBe(11)
    await orch.stop('failed')
  })

  it('treats Playwright exit code 0 as failed when user-pause was stamped', async () => {
    // Regression for the "Pause & Heal flips run to PASSED" bug. When the
    // user pauses, Playwright is SIGTERM'd and may exit cleanly (code 0).
    // runFullCycle must NOT mark the run "passed" in that case — the stamp
    // is the source of truth for "the user wanted to heal."
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
      healAgentTimeoutMs: 500,
      playwrightSpawner: () => ({ command: 'pw', cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildSpawnCommand: () => 'heal' },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 5, passed: 0 }),
    )
    const statuses: string[] = []
    orch.on('run-status', (e) => statuses.push(e.status))
    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    // Stamp BEFORE Playwright exits cleanly — simulating the pause flow.
    orch.markStoppedEarly('user-pause', 1, 5)
    f.spawned[1].emitExit(0) // Playwright exits cleanly post-SIGTERM
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    f.spawned[2].emitExit(0) // agent gives up — heal loop terminates
    const result = await promise
    // Final status is 'failed', NOT 'passed', because user-pause overrides.
    expect(result).toBe('failed')
    // We should also have entered healing at some point.
    expect(statuses).toContain('healing')
    await orch.stop('failed')
  })

  it('does not overwrite a prior user-pause stoppedEarly stamp', async () => {
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
      healAgentTimeoutMs: 500,
      playwrightSpawner: () => ({ command: 'pw', cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildSpawnCommand: () => 'heal' },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 7, passed: 0 }),
    )
    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 5))
    // Pre-stamp user-pause before pw exits non-zero.
    orch.markStoppedEarly('user-pause', 1, 7)
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    f.spawned[2].emitExit(0)
    await promise
    const m = readManifest(orch.paths.manifestPath)!
    expect(m.stoppedEarly?.reason).toBe('user-pause')
    await orch.stop('failed')
  })
})

describe('defaultPlaywrightSpawner --max-failures', () => {
  it('appends --max-failures with feature threshold', async () => {
    const { defaultPlaywrightSpawner } = await import('./run-spawn')
    const f = makeFeature({ healOnFailureThreshold: 3 })
    const inv = defaultPlaywrightSpawner({ feature: f, paths: buildRunPaths(runDir) })
    expect(inv.command).toContain('--max-failures=3')
  })

  it('omits --max-failures when threshold is unset', async () => {
    const { defaultPlaywrightSpawner } = await import('./run-spawn')
    const f = makeFeature()
    const inv = defaultPlaywrightSpawner({ feature: f, paths: buildRunPaths(runDir) })
    expect(inv.command).not.toContain('--max-failures=')
  })

  it('keeps --max-failures on reruns when threshold is set', async () => {
    const { defaultPlaywrightSpawner } = await import('./run-spawn')
    const f = makeFeature({ healOnFailureThreshold: 5 })
    const inv = defaultPlaywrightSpawner({
      feature: f,
      paths: buildRunPaths(runDir),
      rerunTargets: ['e2e/a.spec.ts:10'],
    })
    expect(inv.command).toContain('--max-failures=5')
    expect(inv.command).toContain(JSON.stringify('e2e/a.spec.ts:10'))
  })

  it('supports grep-based rerun selectors for factory-generated tests', async () => {
    const { defaultPlaywrightSpawner } = await import('./run-spawn')
    const f = makeFeature({ healOnFailureThreshold: 2 })
    const inv = defaultPlaywrightSpawner({
      feature: f,
      paths: buildRunPaths(runDir),
      rerunGrep: 'en_SG: checkout',
    })
    expect(inv.command).toContain(`--grep=${JSON.stringify('en_SG: checkout')}`)
    expect(inv.command).toContain('--max-failures=2')
  })
})

describe('stoppedEarlyReasonOf / countPassed', () => {
  it('returns undefined for a missing manifest', async () => {
    const { stoppedEarlyReasonOf, countPassed } = await import('./run-verdict')
    expect(stoppedEarlyReasonOf(path.join(tmpDir, 'nope.json'))).toBeUndefined()
    expect(countPassed({})).toBe(0)
    expect(countPassed({ passed: 4 })).toBe(4)
    expect(countPassed({ passed: 'oops' as unknown as number })).toBe(0)
  })

  it('returns the persisted reason', async () => {
    const file = path.join(tmpDir, 'm.json')
    fs.writeFileSync(file, JSON.stringify({ stoppedEarly: { reason: 'user-pause' } }))
    const { stoppedEarlyReasonOf } = await import('./run-verdict')
    expect(stoppedEarlyReasonOf(file)).toBe('user-pause')
  })
})
