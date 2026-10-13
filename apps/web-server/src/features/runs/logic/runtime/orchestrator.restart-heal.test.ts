import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { RunOrchestrator } from './orchestrator'
import * as sessionLogAgentSessionPaths from '../../../agent-sessions/logic/agent-session-paths'
import * as sessionLogAgentSessionRender from '../../../agent-sessions/logic/agent-session-render'
import { runDirFor, buildRunPaths } from './run-paths'
import { readManifest } from './manifest'
import { makeFakePtyFactory } from '../../../../../../../tools/test-helpers/fake-pty'
import { demoFeature } from '../../../../../../../tools/test-helpers/feature-fixture'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-orc-')
let tmpDir: string

let runDir: string

const RUN_ID = '2026-04-28T1015-aaaa'

beforeEach(() => {
  // Loop teardown (cleanupHealAgentPty, orch.stop) calls the REAL killTree,
  // which signals process GROUPS via process.kill(-pid). Block the real
  // process.kill so the fake pids (100+) can never hit a live process group;
  // killTree falls back to pty.kill, which the fakes record. (Same convention
  // as boot-probe.test.ts.)
  vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('blocked in test') })
  tmpDir = tempDir()
  runDir = runDirFor(path.join(tmpDir, 'logs'), RUN_ID)
  fs.mkdirSync(runDir, { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('RunOrchestrator.restartHealFromFailure', () => {
  it('restores runtime inputs before healing while preserving the recorded suite and review history', async () => {
    const f = makeFakePtyFactory()
    const feature = demoFeature(tmpDir, { repos: [{ name: 'api', localPath: tmpDir }] })
    const envTarget = path.join(feature.featureDir, '.env')
    fs.mkdirSync(path.join(feature.featureDir, 'e2e'), { recursive: true })
    fs.mkdirSync(path.join(feature.featureDir, 'envsets', 'local'), { recursive: true })
    fs.writeFileSync(path.join(feature.featureDir, 'envsets', 'local', 'api'), 'BASE_URL=http://localhost:4100\n')
    fs.writeFileSync(path.join(feature.featureDir, 'envsets', 'envsets.config.json'), JSON.stringify({
      appRoots: {}, slots: { api: { description: 'suite URL', target: envTarget } },
      feature: { slots: ['api'], testCommand: 'true', testCwd: feature.featureDir },
    }))
    const spec = path.join(feature.featureDir, 'e2e', 'contract.spec.ts')
    const recordedSpec = "test('contract', () => expect(true).toBe(true))"
    fs.writeFileSync(spec, recordedSpec)
    fs.writeFileSync(envTarget, 'BASE_URL=http://localhost:4100\n')
    const options = {
      feature, env: 'local', runId: RUN_ID, runDir, ptyFactory: f.factory,
      healSignalPollMs: 1, healAgentTimeoutMs: 2000,
      playwrightSpawner: () => ({ command: 'pw', cwd: buildRunPaths(runDir).suiteSnapshotDir }),
      autoHeal: { agent: 'codex' as const, maxCycles: 1, buildSpawnCommand: () => 'codex heal', buildCyclePrompt: () => 'heal' },
    }
    const first = new RunOrchestrator(options)
    await first.start()
    await first.stop('failed')
    const previous = readManifest(first.paths.manifestPath)!
    previous.specEdits = { checkedAt: 'prior', pending: [], adopted: [{ at: 'prior', by: 'human', files: ['e2e/contract.spec.ts'] }] }
    fs.writeFileSync(first.paths.manifestPath, JSON.stringify(previous))
    expect(fs.existsSync(path.join(first.paths.suiteSnapshotDir, '.env'))).toBe(false)
    // A restart allocates a new port and reapplies the feature target. Only
    // these runtime bytes may enter the retained suite; live test edits may not.
    fs.writeFileSync(envTarget, 'BASE_URL=http://localhost:4200\n')
    fs.writeFileSync(spec, "test('different contract', () => expect(false).toBe(true))")
    fs.writeFileSync(first.paths.summaryPath, JSON.stringify({ total: 1, passed: 0, failed: [{ name: 'test-case-contract' }] }))

    const resumed = new RunOrchestrator(options)
    const promise = resumed.restartHealFromFailure('retry the app fix')
    try {
      await vi.waitFor(() => expect(f.spawned).toHaveLength(1))
      const suiteEnv = path.join(resumed.paths.suiteSnapshotDir, '.env')
      expect(fs.readFileSync(suiteEnv, 'utf8')).toBe('BASE_URL=http://localhost:4200\n')
      const manifest = readManifest(resumed.paths.manifestPath)!
      expect(manifest.startedAt).toBe(previous.startedAt)
      expect(manifest.suiteSnapshot).toEqual(previous.suiteSnapshot)
      expect(manifest.specEdits?.adopted).toEqual(previous.specEdits.adopted)
      expect(manifest.specEdits?.pending[0].file).toBe('e2e/contract.spec.ts')
      expect(fs.readFileSync(path.join(resumed.paths.suiteSnapshotDir, 'e2e', 'contract.spec.ts'), 'utf8')).toBe(recordedSpec)
      fs.writeFileSync(resumed.paths.restartSignal, JSON.stringify({ hypothesis: 'app repaired' }))
      await vi.waitFor(() => expect(f.spawned).toHaveLength(2))
      expect(f.spawned[1].options.cwd).toBe(resumed.paths.suiteSnapshotDir)
      expect(fs.readFileSync(suiteEnv, 'utf8')).toContain('4200')
      fs.writeFileSync(resumed.paths.summaryPath, JSON.stringify({ total: 1, passed: 1, passedNames: ['test-case-contract'], failed: [] }))
      f.spawned[1].emitExit(0)
      expect(await promise).toBe('passed')
    } finally {
      await resumed.cancelHeal()
      for (const process of f.spawned) process.emitExit(1)
      await resumed.stop('failed')
      await promise
    }
    expect(fs.existsSync(path.join(resumed.paths.suiteSnapshotDir, '.env'))).toBe(false)
    expect(fs.existsSync(resumed.paths.suiteRuntimeInputsDir)).toBe(false)
  })

  it('refuses a missing recorded suite before replacing evidence or spawning an agent', async () => {
    const f = makeFakePtyFactory()
    const feature = demoFeature(tmpDir, { repos: undefined })
    fs.mkdirSync(feature.featureDir, { recursive: true })
    const options = {
      feature, runId: RUN_ID, runDir, ptyFactory: f.factory,
      autoHeal: { agent: 'codex' as const, buildSpawnCommand: () => 'codex heal', buildCyclePrompt: () => 'heal' },
    }
    const first = new RunOrchestrator(options)
    await first.start()
    await first.stop('failed')
    fs.rmSync(first.paths.suiteSnapshotDir, { recursive: true })
    const previous = fs.readFileSync(first.paths.manifestPath, 'utf8')
    const resumed = new RunOrchestrator(options)
    try {
      await expect(resumed.restartHealFromFailure('retry')).rejects.toThrow('recorded suite snapshot is missing')
      expect(fs.readFileSync(first.paths.manifestPath, 'utf8')).toBe(previous)
      expect(f.spawned).toHaveLength(0)
    } finally {
      await resumed.stop('failed')
    }
  })

  it('refuses a spent suite attempt before spawning a heal agent', async () => {
    const receipt = path.join(runDir, 'runtime/effect-attempt/attempt.json')
    fs.mkdirSync(path.dirname(receipt), { recursive: true })
    fs.writeFileSync(receipt, '{}')
    const f = makeFakePtyFactory()
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir, { singleAttempt: { receipt: 'runtime/effect-attempt/attempt.json' } }),
      runId: RUN_ID,
      runDir,
      ptyFactory: f.factory,
      autoHeal: { agent: 'codex', buildSpawnCommand: () => 'codex heal', buildCyclePrompt: () => 'heal' },
    })

    await expect(orch.restartHealFromFailure('try again')).rejects.toThrow('fresh run')
    expect(f.spawned).toHaveLength(0)
  })

  it('starts services only after the restarted heal agent requests a rerun', async () => {
    const f = makeFakePtyFactory()
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir, { healOnFailureThreshold: 1 }),
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

    const f = makeFakePtyFactory()
    const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir, { healOnFailureThreshold: 1 }),
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

    const f = makeFakePtyFactory()
    const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir, { healOnFailureThreshold: 1 }),
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

    const f = makeFakePtyFactory()
    const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir, { healOnFailureThreshold: 1 }),
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
    const locateSpy = vi.spyOn(sessionLogAgentSessionPaths, 'locateLatestSessionLogForAgent').mockReturnValue({
      agent: 'claude',
      sessionId: PRIOR_SID,
      logPath: '/tmp/claude-session.jsonl',
    })

    try {
      const f = makeFakePtyFactory()
      const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
      const orch = new RunOrchestrator({
        feature: demoFeature(tmpDir, { healOnFailureThreshold: 1 }),
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
    const renderSpy = vi.spyOn(sessionLogAgentSessionRender, 'renderAgentSessionContext')
      .mockReturnValue('Previous codex session 019e...\nASSISTANT: inspect fallback SMS call')

    try {
      const f = makeFakePtyFactory()
      let receivedContext: string | undefined
      const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
      const orch = new RunOrchestrator({
        feature: demoFeature(tmpDir, { healOnFailureThreshold: 1 }),
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

    const f = makeFakePtyFactory()
    const spawnCalls: Array<{ sessionId?: string; resume?: boolean }> = []
    const orch = new RunOrchestrator({
      feature: demoFeature(tmpDir, { healOnFailureThreshold: 1 }),
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
