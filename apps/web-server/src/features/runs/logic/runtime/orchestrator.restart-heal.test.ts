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
  it('starts services only after the restarted heal agent requests a rerun', async () => {
    const f = makeFakeFactory()
    const orch = new RunOrchestrator({
      feature: makeFeature({ healOnFailureThreshold: 1 }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      healthCheck: async () => true,
      delay: async () => undefined,
      healthPollIntervalMs: 1,
      healSignalPollMs: 1,
      healAgentTimeoutMs: 200,
      playwrightSpawner: () => ({ command: 'pw-after-heal', cwd: tmpDir }),
      autoHeal: {
        agent: 'codex',
        maxCycles: 1,
        buildSpawnCommand: () => 'codex heal restart',
        buildCyclePrompt: () => 'restart-prompt',
      },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
    )
    const eventLog: string[] = []
    orch.on('agent-started', () => eventLog.push('agent-started'))
    orch.on('agent-exit', () => eventLog.push('agent-exit'))
    orch.on('signal-accepted', (e) => eventLog.push(`signal:${e.kind}`))
    orch.on('service-started', () => eventLog.push('service-started'))
    orch.on('playwright-started', () => eventLog.push('playwright-started'))

    const promise = orch.restartHealFromFailure('rerun after this')
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    expect(f.spawned[0].options.command).toBe('codex heal restart')
    expect(eventLog).toEqual(['agent-started'])

    fs.writeFileSync(orch.paths.rerunSignal, JSON.stringify({ hypothesis: 'try again' }))
    while (!eventLog.includes('signal:rerun')) await new Promise((r) => setTimeout(r, 5))
    // REPL stays alive across cycles in REPL mode — no per-cycle exit.
    // Wait for services + playwright to spawn (agent is idx 0).
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    expect(eventLog).toEqual([
      'agent-started',
      'signal:rerun',
      'service-started',
      'playwright-started',
    ])

    // Playwright passes — loop ends, cleanupHealAgentPty fires agent-exit.
    // Mimic the SummaryReporter clearing the failed entry so decideRunStatus
    // sees the rerun as a real success.
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({
      passedNames: ['a'],
      failed: [],
      total: 1,
      passed: 1,
    }))
    f.spawned[2].emitExit(0)
    expect(await promise).toBe('passed')
    expect(eventLog).toContain('agent-exit')
    await orch.stop('passed')
  })

  it('claude restart: reuses the prior session id from disk and passes resume=true to the spawn-command builder', async () => {
    // On Restart Heal the run dir already carries the previous heal session's
    // UUID at `agent-session-id.txt`. We reuse it so the spawn command can
    // emit `--resume <uuid>` and claude continues the prior conversation
    // instead of orphaning all the investigation history.
    const PRIOR_SID = 'b2160db2-89b8-49ff-a2ba-c0c97a52d63f'
    const paths = buildRunPaths(runDir)
    fs.writeFileSync(paths.agentSessionIdPath, PRIOR_SID)

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
        agent: 'claude',
        maxCycles: 1,
        buildSpawnCommand: ({ sessionId, resume }) => {
          spawnCalls.push({ sessionId, resume })
          return 'claude heal restart'
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
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]).toEqual({ sessionId: PRIOR_SID, resume: true })
    // File is preserved unchanged — same UUID across the restart so the UI
    // shows a stable session and `locateClaudeSessionLog` finds the same
    // ~/.claude/projects/.../<uuid>.jsonl after resume.
    expect(fs.readFileSync(paths.agentSessionIdPath, 'utf-8').trim()).toBe(PRIOR_SID)
    f.spawned[0].emitExit(0)
    expect(await promise).toBe('failed')
    await orch.stop('failed')
  })

  it('claude restart: when no prior session id file exists, generates a fresh UUID with resume=false', async () => {
    // First-ever heal cycle (or a corrupt/missing sid file) falls back to
    // the original behavior: mint a new UUID, spawn with --session-id.
    const paths = buildRunPaths(runDir)
    expect(fs.existsSync(paths.agentSessionIdPath)).toBe(false)

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
        agent: 'claude',
        maxCycles: 1,
        buildSpawnCommand: ({ sessionId, resume }) => {
          spawnCalls.push({ sessionId, resume })
          return 'claude heal fresh'
        },
        buildCyclePrompt: () => 'fresh-prompt',
      },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
    )

    const promise = orch.restartHealFromFailure('look again')
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0].resume).toBe(false)
    expect(spawnCalls[0].sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    // File was written so a SUBSEQUENT restart could resume this same session.
    expect(fs.readFileSync(paths.agentSessionIdPath, 'utf-8').trim()).toBe(spawnCalls[0].sessionId)
    f.spawned[0].emitExit(0)
    expect(await promise).toBe('failed')
    await orch.stop('failed')
  })

  it('claude restart: corrupt prior-session-id file is ignored — generates a fresh UUID with resume=false', async () => {
    const paths = buildRunPaths(runDir)
    fs.writeFileSync(paths.agentSessionIdPath, 'not-a-uuid')

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
        agent: 'claude',
        maxCycles: 1,
        buildSpawnCommand: ({ sessionId, resume }) => {
          spawnCalls.push({ sessionId, resume })
          return 'claude heal recover'
        },
        buildCyclePrompt: () => 'recover-prompt',
      },
    })
    fs.writeFileSync(
      orch.paths.summaryPath,
      JSON.stringify({ failed: [{ name: 'a' }], total: 1, passed: 0 }),
    )

    const promise = orch.restartHealFromFailure('look again')
    while (f.spawned.length < 1) await new Promise((r) => setTimeout(r, 5))
    expect(spawnCalls[0].resume).toBe(false)
    expect(spawnCalls[0].sessionId).not.toBe('not-a-uuid')
    expect(spawnCalls[0].sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
    // The corrupt file was overwritten with the freshly minted UUID.
    expect(fs.readFileSync(paths.agentSessionIdPath, 'utf-8').trim()).toBe(spawnCalls[0].sessionId)
    f.spawned[0].emitExit(0)
    expect(await promise).toBe('failed')
    await orch.stop('failed')
  })

  it('claude restart: recovers a missing pointer from the native Claude session log', async () => {
    const PRIOR_SID = 'b2160db2-89b8-49ff-a2ba-c0c97a52d63f'
    const paths = buildRunPaths(runDir)
    const locateSpy = vi.spyOn(sessionLog, 'locateLatestSessionLogForAgent').mockReturnValue({
      agent: 'claude',
      sessionId: PRIOR_SID,
      logPath: '/tmp/claude-session.jsonl',
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
          agent: 'claude',
          maxCycles: 1,
          buildSpawnCommand: ({ sessionId, resume }) => {
            spawnCalls.push({ sessionId, resume })
            return 'claude heal restart'
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
      expect(locateSpy).toHaveBeenCalledWith('claude', runDir)
      expect(spawnCalls).toEqual([{ sessionId: PRIOR_SID, resume: true }])
      expect(fs.readFileSync(paths.agentSessionIdPath, 'utf-8').trim()).toBe(PRIOR_SID)
      expect(JSON.parse(fs.readFileSync(paths.agentSessionRefPath, 'utf-8'))).toEqual({
        activeAgent: 'claude',
        sessions: {
          claude: {
            agent: 'claude',
            sessionId: PRIOR_SID,
            logPath: '/tmp/claude-session.jsonl',
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

  it('claude restart: injects previous Codex session context into the heal prompt', async () => {
    const paths = buildRunPaths(runDir)
    fs.writeFileSync(paths.agentSessionRefPath, JSON.stringify({
      agent: 'codex',
      sessionId: '019e1779-6b55-73b1-8ab7-e8e345bd889a',
      logPath: '/tmp/codex-session.jsonl',
    }))
    fs.writeFileSync(paths.agentSessionIdPath, '019e1779-6b55-73b1-8ab7-e8e345bd889a')
    const renderSpy = vi.spyOn(sessionLog, 'renderAgentSessionContext')
      .mockReturnValue('Previous codex session 019e...\nASSISTANT: inspect fallback SMS call')

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
          agent: 'claude',
          maxCycles: 1,
          buildSpawnCommand: ({ sessionId, resume }) => {
            spawnCalls.push({ sessionId, resume })
            return 'claude heal restart'
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
        agent: 'codex',
        sessionId: '019e1779-6b55-73b1-8ab7-e8e345bd889a',
        logPath: '/tmp/codex-session.jsonl',
      })
      expect(receivedContext).toContain('Previous codex session')
      expect(receivedContext).toContain('fallback SMS call')
      expect(spawnCalls).toHaveLength(1)
      expect(spawnCalls[0].resume).toBe(false)
      expect(spawnCalls[0].sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      )
      f.spawned[0].emitExit(0)
      expect(await promise).toBe('failed')
      await orch.stop('failed')
    } finally {
      renderSpy.mockRestore()
    }
  })

  it('codex restart: reuses the prior session id from disk and passes resume=true', async () => {
    const PRIOR_SID = 'b2160db2-89b8-49ff-a2ba-c0c97a52d63f'
    const paths = buildRunPaths(runDir)
    fs.writeFileSync(paths.agentSessionIdPath, PRIOR_SID)

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
    f.spawned[0].emitExit(0)
    expect(await promise).toBe('failed')
    await orch.stop('failed')
  })
})
