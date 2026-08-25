import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { EventEmitter } from 'events'
import { RunOrchestrator } from './orchestrator'
import type { PtyFactory, PtyHandle, PtySpawnOptions } from './pty-spawner'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { runDirFor } from './run-paths'
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

  it('captures the agent output tail and classifies the cause on a no-signal give-up', async () => {
    // Agent prints a usage-limit banner, then goes silent. The idle timeout
    // fires; the classifier reads the captured tail and records agentCause,
    // and the tail is persisted for the UI's "why" line.
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
      healAgentTimeoutMs: 60_000,
      healAgentIdleTimeoutMs: 100,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: { agent: 'codex', maxCycles: 1, buildSpawnCommand: () => 'heal' },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }] }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1) // pw fails → heal loop
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    // Agent emits a usage-limit banner, then stays silent so idle fires.
    f.spawned[2].emitData("\n You've reached your usage limit. Upgrade your plan.\n")

    const status = await promise
    expect(status).toBe('failed')
    const healEnd = readManifest(orch.paths.manifestPath)?.healEnd
    expect(healEnd).toMatchObject({ reason: 'no-signal', agentCause: 'usage-limit' })
    expect(fs.existsSync(orch.paths.healAgentTailPath)).toBe(true)
    expect(fs.readFileSync(orch.paths.healAgentTailPath, 'utf-8')).toContain('usage limit')
    await orch.stop('failed')
  }, 10000)

  it('records a max-cycles healEnd when the loop exhausts its cycle cap', async () => {
    // maxCycles:1 — cycle 1 signals a rerun, the rerun re-fails the same set,
    // and the next observeFailures trips the cap → healEnd reason 'max-cycles'.
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
      healAgentTimeoutMs: 60_000,
      healAgentIdleTimeoutMs: 60_000,
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildSpawnCommand: () => 'heal' },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }] }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1) // pw fails → heal loop, cycle 1 agent = spawned[2]
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    fs.writeFileSync(orch.paths.rerunSignal, '') // agent signals a rerun
    f.spawned[2].emitExit(0)
    while (f.spawned.length < 4) await new Promise((r) => setTimeout(r, 5))
    f.spawned[3].emitExit(1) // rerun re-fails the same set → cap trips next loop

    const status = await promise
    expect(status).toBe('failed')
    const healEnd = readManifest(orch.paths.manifestPath)?.healEnd
    expect(healEnd).toMatchObject({ reason: 'max-cycles', cycle: 1 })
    await orch.stop('failed')
  }, 10000)

  it('ends the heal loop with a hard-timeout journal entry when the cycle hits the absolute ceiling', async () => {
    // Agent pty is alive AND producing output continuously (never goes
    // idle), but the hard ceiling kicks in. Should write a hard-timeout
    // journal entry — not idle, not exited.
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
      healAgentTimeoutMs: 200, // hard ceiling we'll deliberately hit
      healAgentIdleTimeoutMs: 60_000, // idle window much larger than ceiling
      playwrightSpawner: () => ({ command: `pw-${pwIdx++}`, cwd: tmpDir }),
      autoHeal: { agent: 'claude', maxCycles: 1, buildSpawnCommand: () => 'heal' },
    })
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(orch.paths.summaryPath, JSON.stringify({ failed: [{ name: 'a' }] }))

    const promise = orch.runFullCycle()
    await new Promise((r) => setTimeout(r, 10))
    f.spawned[1].emitExit(1)
    while (f.spawned.length < 3) await new Promise((r) => setTimeout(r, 5))
    // Keep emitting data so the idle clock stays fresh until the hard
    // ceiling fires.
    const pump = setInterval(() => {
      if (f.spawned[2]) f.spawned[2].emitData('thinking...\n')
    }, 20)
    try {
      const status = await promise
      expect(status).toBe('failed')
      const journal = fs.readFileSync(orch.paths.diagnosisJournalPath, 'utf-8')
      expect(journal).toContain('Heal cycle hit the')
      expect(journal).toContain('minute ceiling')
      expect(journal).toContain('- signal: none')
    } finally {
      clearInterval(pump)
      await orch.stop('failed')
    }
  }, 10000)

  it('writes agent-session.json pointing at the claude session JSONL after the heal flow ends', async () => {
    // Stand up a fake `~/.claude/projects/<encoded-runDir>/<uuid>.jsonl` so
    // the locator finds something at the predicted path. We point HOME at a
    // temp dir for the duration of the test so the orchestrator's
    // os.homedir() lookup resolves there.
    const originalHome = process.env.HOME
    const homeDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-orc-home-')))
    process.env.HOME = homeDir
    try {
      const f = makeFakeFactory()
      // Capture the orchestrator's view of the run dir (realpathSync'd
      // tmpDir) so the encoded project path matches.
      const orch = bootForFullCycle({ spawned: f, pwExitCodes: [1], autoHeal: true })
      // The orchestrator generates a UUID for claude session id internally;
      // we can't predict it. Instead, create the fake JSONL eagerly after the
      // agent pty is spawned, when the orchestrator has written the id to
      // agentSessionIdPath.
      fs.mkdirSync(runDir, { recursive: true })
      fs.writeFileSync(
        orch.paths.summaryPath,
        JSON.stringify({ failed: [{ name: 'a' }] }),
      )

      const promise = orch.runFullCycle()
      await new Promise((r) => setTimeout(r, 10))
      f.spawned[1].emitExit(1) // pw fails → heal loop entered
      // Wait for the agent pty spawn AND for the session id sidecar.
      while (f.spawned.length < 3 || !fs.existsSync(orch.paths.agentSessionIdPath)) {
        await new Promise((r) => setTimeout(r, 5))
      }
      const sessionId = fs.readFileSync(orch.paths.agentSessionIdPath, 'utf-8').trim()
      expect(sessionId).toMatch(/^[0-9a-f-]+$/i)
      // Drop the fake JSONL where locateClaudeSessionLog looks. The encoder
      // just replaces `/` with `-`, so the leading slash already becomes the
      // leading dash — no extra prefix.
      const encoded = runDir.replace(/\//g, '-')
      const projectDir = path.join(homeDir, '.claude', 'projects', encoded)
      fs.mkdirSync(projectDir, { recursive: true })
      const logPath = path.join(projectDir, `${sessionId}.jsonl`)
      fs.writeFileSync(logPath, '')

      // End the heal cycle: agent exits without signal so the loop bails fast.
      f.spawned[2].emitExit(0)
      await promise
      await orch.stop('failed')

      const ref = JSON.parse(fs.readFileSync(orch.paths.agentSessionRefPath, 'utf-8'))
      expect(ref).toEqual({
        activeAgent: 'claude',
        sessions: {
          claude: { agent: 'claude', sessionId, logPath },
        },
      })
    } finally {
      if (originalHome === undefined) delete process.env.HOME
      else process.env.HOME = originalHome
      try { fs.rmSync(homeDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
  }, 15000)
})
