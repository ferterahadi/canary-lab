// Manifest-writing arms the orchestrator tests don't reach: a service carrying
// allocated ports, the heartbeat tick firing after the run stopped, and the
// fire-and-forget dirty-spec recompute rejecting.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import { appendJournalIteration, captureDirtySpecBaseline, detectForeignTerminalWrite, setStatus, startHeartbeat, stopHeartbeat, startSignalWatcher, writeInitialManifest } from './run-manifest-writer'
import { makeHealLoopContext } from './__fixtures__/heal-loop-context'
import type { RunContext } from './run-context'
import type { RunManifest } from '../../../../../../../shared/run-manifest'
import type { ServiceSpec } from './run-orchestrator-types'
import { detectRepoCollision } from './repo-collision'
import { trackTempDirs } from '../../../../../../../tools/test-helpers/temp-dir'

const tempDir = trackTempDirs('cl-manifest-w-')
let tmpDir: string

beforeEach(() => {
  tmpDir = tempDir()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function ctxFor(state: Partial<RunContext> = {}, opts: Record<string, unknown> = {}) {
  const made = makeHealLoopContext({ root: tmpDir, opts, state })
  fs.mkdirSync(made.ctx.runDir, { recursive: true })
  return made
}

describe('writeInitialManifest', () => {
  it('persists the launch diagnosis policy and resolved model plan', () => {
    const models = { heal: { model: 'fixture-heal', effort: null }, commit: { model: null, effort: null } }
    const { ctx, sink } = ctxFor({ autoHeal: { agent: 'codex', diagnosisPolicy: 'parent-only' }, models })
    writeInitialManifest(ctx, 'starting')
    expect(sink.bootstrap).toHaveBeenCalledWith(expect.objectContaining({ diagnosisPolicy: 'parent-only', models }))
  })
  it('retains the diagnosis policy through the owning state sink when resuming a run', () => {
    const { ctx, sink } = ctxFor({ autoHeal: { agent: 'codex', diagnosisPolicy: 'parent-only' } })
    writeInitialManifest(ctx, 'starting', { diagnosisPolicy: 'adaptive' } as RunManifest)
    const written = (sink.bootstrap as unknown as { mock: { calls: [RunManifest][] } }).mock.calls[0][0]
    expect(written.diagnosisPolicy).toBe('adaptive')
  })

  it('records the auto-heal diagnosis policy on a fresh run', () => {
    const { ctx, sink } = ctxFor({ autoHeal: { agent: 'codex', diagnosisPolicy: 'parent-only' } })
    writeInitialManifest(ctx)
    const written = (sink.bootstrap as unknown as { mock: { calls: [RunManifest][] } }).mock.calls[0][0]
    expect(written.diagnosisPolicy).toBe('parent-only')
  })

  it('delivers a signal at the signal interval and preserves acceptance evidence', async () => {
    vi.useFakeTimers()
    const { ctx } = ctxFor({ healthPollIntervalMs: 1000, healSignalPollMs: 100 })
    fs.mkdirSync(path.dirname(ctx.paths.restartSignal), { recursive: true })
    ctx.signalGate.beginWaiting()
    startSignalWatcher(ctx)
    const body = { hypothesis: 'fix', fixDescription: 'corrected app' }
    fs.writeFileSync(ctx.paths.restartSignal, JSON.stringify(body))
    const woke = vi.fn()
    const waiting = ctx.signalGate.waitForSignal(1000).then(woke)
    try {
      await vi.advanceTimersByTimeAsync(99)
      expect(woke).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      await waiting
      expect(woke).toHaveBeenCalledOnce()
      expect(ctx.signalGate.consume()).toEqual({ kind: 'restart', body })
      expect(fs.existsSync(ctx.paths.restartSignal)).toBe(false)
    } finally {
      clearInterval(ctx.signalWatcher!)
    }
  })

  it('pins the prior attempt policy across a restart even if the suite changed', () => {
    const { ctx, sink } = ctxFor()
    ctx.feature.singleAttempt = { receipt: 'current.json' }
    const previous = { singleAttempt: { receipt: 'original.json' } } as RunManifest

    writeInitialManifest(ctx, 'starting', previous)

    const written = (sink.bootstrap as unknown as { mock: { calls: [RunManifest][] } }).mock.calls[0][0]
    expect(written.singleAttempt).toEqual({ receipt: 'original.json' })
  })

  it('keeps the run\'s execution count across a restart so evidence numbers stay unique', () => {
    const { ctx, sink } = ctxFor()
    writeInitialManifest(ctx, 'starting', { playwrightExecutions: 3 } as RunManifest)
    const written = (sink.bootstrap as unknown as { mock: { calls: [RunManifest][] } }).mock.calls[0][0]
    expect(written.playwrightExecutions).toBe(3)
  })

  it('records a new suite attempt policy when there is no earlier manifest', () => {
    const { ctx, sink } = ctxFor()
    ctx.feature.singleAttempt = { receipt: 'attempt.json' }

    writeInitialManifest(ctx)

    const written = (sink.bootstrap as unknown as { mock: { calls: [RunManifest][] } }).mock.calls[0][0]
    expect(written.singleAttempt).toEqual({ receipt: 'attempt.json' })
  })

  it('carries a service\'s allocated ports into the manifest', () => {
    const { ctx, sink } = ctxFor()
    const services: ServiceSpec[] = [
      { name: 'api', safeName: 'api', command: 'noop', cwd: tmpDir, allocatedPorts: { API: 4310 } },
      // An empty map is omitted rather than written as `{}` — readers treat a
      // present-but-empty `allocatedPorts` as "this run allocated nothing".
      { name: 'web', safeName: 'web', command: 'noop', cwd: tmpDir, allocatedPorts: {} },
      { name: 'db', safeName: 'db', command: 'noop', cwd: tmpDir },
    ] as unknown as ServiceSpec[]
    ;(ctx as { services: ServiceSpec[] }).services = services

    writeInitialManifest(ctx)

    const written = (sink.bootstrap as unknown as { mock: { calls: [{ services: unknown[] }][] } }).mock.calls[0][0]
    expect(written.services).toEqual([
      expect.objectContaining({ safeName: 'api', allocatedPorts: { API: 4310 } }),
      expect.not.objectContaining({ allocatedPorts: expect.anything() }),
      expect.not.objectContaining({ allocatedPorts: expect.anything() }),
    ])
  })

  it('keeps only repo paths that exist on disk', () => {
    const real = path.join(tmpDir, 'repo-here')
    fs.mkdirSync(real)
    const { ctx, sink } = ctxFor()
    ctx.feature.repos = [
      { name: 'here', localPath: real },
      { name: 'gone', localPath: path.join(tmpDir, 'no-such-repo') },
    ] as never

    writeInitialManifest(ctx)

    const written = (sink.bootstrap as unknown as { mock: { calls: [{ repoPaths: string[] }][] } }).mock.calls[0][0]
    expect(written.repoPaths).toEqual([real])
  })

  it('persists dependency provenance and an exact test-review approval when the run carries them', () => {
    const approval = { sourceRunId: 'source-run', revision: 'a'.repeat(64), approvedAt: 'now' }
    const provenance = [{ repoName: 'app', verdict: 'unknown', mode: 'shared' }]
    const { ctx, sink } = ctxFor({ dependencyProvenance: provenance as never, testReviewApproval: approval })

    writeInitialManifest(ctx)

    const written = (sink.bootstrap as unknown as { mock: { calls: [RunManifest][] } }).mock.calls[0][0]
    expect(written.dependencyProvenance).toEqual(provenance)
    expect(written.testReviewApproval).toEqual(approval)
  })
})

describe('captureDirtySpecBaseline', () => {
  it('hashes the run-start suite copy, not the live feature dir', async () => {
    // The baseline must describe what the run will execute. Hashing the live
    // dir instead would let an edit landing between snapshot and capture
    // become the "run-start" content and never read as a mid-run change.
    const captureRunStart = vi.fn(async () => ({}))
    const { ctx } = ctxFor({}, { dirtySpecHooks: { captureRunStart, finalizeRun: vi.fn() } })
    ctx.suiteDir = path.join(ctx.runDir, 'suite')

    await captureDirtySpecBaseline(ctx)

    expect(captureRunStart).toHaveBeenCalledWith('demo', ctx.suiteDir)
  })
})

describe('startHeartbeat', () => {
  it('stops writing heartbeats once the run has stopped', () => {
    vi.useFakeTimers()
    const { ctx } = ctxFor()
    const recordHeartbeat = vi.fn()
    ;(ctx.stateSink as unknown as { recordHeartbeat: unknown }).recordHeartbeat = recordHeartbeat

    startHeartbeat(ctx)
    vi.advanceTimersByTime(5_000)
    expect(recordHeartbeat).toHaveBeenCalledTimes(1)

    // A stopped run's timer may still fire once before stopHeartbeat lands —
    // the tick has to no-op rather than resurrect the run in the index.
    ctx.stopped = true
    vi.advanceTimersByTime(15_000)
    expect(recordHeartbeat).toHaveBeenCalledTimes(1)

    stopHeartbeat(ctx)
    expect(ctx.heartbeatTimer).toBeNull()
  })
})

describe('detectForeignTerminalWrite', () => {
  // `heartbeatAt` is irrelevant here — the manifest is written straight to disk
  // because the whole point is to observe a write this process did not make.
  function writeDiskStatus(ctx: RunContext, status: RunManifest['status']): void {
    fs.writeFileSync(ctx.paths.manifestPath, JSON.stringify({
      runId: ctx.runId, feature: 'demo', startedAt: '2026-01-01T00:00:00Z', status, healCycles: 1, services: [],
    }))
  }

  it('flags a terminal status written by another process while the run is still healing', () => {
    const { ctx, sink } = ctxFor({ status: 'healing', healCycles: 1 })
    const warn = vi.fn()
    ;(ctx as { runnerLog?: unknown }).runnerLog = { warn, info: vi.fn(), error: vi.fn() }
    writeDiskStatus(ctx, 'aborted')

    detectForeignTerminalWrite(ctx)

    expect(ctx.foreignTerminalStatus).toBe('aborted')
    // Run Logs reads the runner log, so this line is the only place the user
    // ever sees the interference named.
    expect(warn.mock.calls[0][0]).toContain('aborted')
    expect(sink.recordLifecycleEvent).toHaveBeenCalled()
  })

  it('says nothing while the manifest on disk still agrees the run is active', () => {
    const { ctx } = ctxFor({ status: 'healing' })
    writeDiskStatus(ctx, 'healing')

    detectForeignTerminalWrite(ctx)

    expect(ctx.foreignTerminalStatus).toBeNull()
  })

  it('ignores our OWN terminal write', () => {
    // `stop()` writes the terminal status and this context knows about it.
    // Without this arm every normal run would end by accusing itself.
    const { ctx } = ctxFor({ status: 'failed' })
    writeDiskStatus(ctx, 'failed')

    detectForeignTerminalWrite(ctx)

    expect(ctx.foreignTerminalStatus).toBeNull()
  })

  it('treats an unreadable manifest as no information', () => {
    // A partial read must never trip this: a false give-up kills a healthy
    // repair, which is the exact harm the whole detector exists to prevent.
    const { ctx } = ctxFor({ status: 'healing' })
    fs.writeFileSync(ctx.paths.manifestPath, '{ not json')

    detectForeignTerminalWrite(ctx)

    expect(ctx.foreignTerminalStatus).toBeNull()
  })

  it('files the event under the phase the run was actually in', () => {
    // A foreign write can land during the post-cycle Playwright rerun, not just
    // while the agent is thinking — the event has to say which.
    const { ctx, sink } = ctxFor({ status: 'running' })
    writeDiskStatus(ctx, 'aborted')

    detectForeignTerminalWrite(ctx)

    expect(sink.recordLifecycleEvent).toHaveBeenCalledWith(
      ctx.runId,
      expect.objectContaining({ phase: 'running-tests' }),
    )
  })

  it('records the interference once, not on every heartbeat', () => {
    const { ctx, sink } = ctxFor({ status: 'healing' })
    writeDiskStatus(ctx, 'aborted')

    detectForeignTerminalWrite(ctx)
    detectForeignTerminalWrite(ctx)

    expect(sink.recordLifecycleEvent).toHaveBeenCalledTimes(1)
  })
})

describe('setStatus', () => {
  it('swallows a rejected dirty-spec recompute rather than failing the status write', async () => {
    const finalizeRun = vi.fn(async () => { throw new Error('hook exploded') })
    const { ctx } = ctxFor({}, { dirtySpecHooks: { finalizeRun } })

    expect(() => setStatus(ctx, 'passed')).not.toThrow()
    expect(finalizeRun).toHaveBeenCalledWith(ctx.feature.name, ctx.feature.featureDir, true)
    // Let the rejected promise settle — an unhandled rejection here would fail
    // the suite, which is exactly what the `.catch` is preventing.
    await new Promise((r) => setImmediate(r))
    expect(ctx.status).toBe('passed')
  })

  it('does not touch the spec baseline for a failed run', () => {
    const finalizeRun = vi.fn(async () => {})
    const { ctx } = ctxFor({}, { dirtySpecHooks: { finalizeRun } })

    setStatus(ctx, 'failed')

    expect(finalizeRun).not.toHaveBeenCalled()
  })
})


it('records the occupied worktree path without claiming its source checkout', () => {
  const source = path.join(tmpDir, 'source')
  const worktree = path.join(tmpDir, 'worktree')
  const alias = path.join(tmpDir, 'worktree-alias')
  fs.mkdirSync(source); fs.mkdirSync(worktree); fs.symlinkSync(worktree, alias, 'dir')
  const { ctx, sink } = ctxFor({}, { worktrees: [{ repoName: 'app', localPath: alias, sourceRoot: source, worktreeRoot: worktree }] })
  ctx.feature.repos = [{ name: 'app', localPath: source }]
  writeInitialManifest(ctx)
  const written = vi.mocked(sink.bootstrap).mock.calls[0][0]
  expect(written.repoPaths).toEqual([alias])
  const active = [{ runId: written.runId, feature: written.feature, repoPaths: written.repoPaths! }]
  expect(detectRepoCollision([source], active)).toBeNull()
  expect(detectRepoCollision([worktree], active)?.conflictingRunId).toBe(written.runId)
})

describe('appendJournalIteration', () => {
  it('stamps the entry with the run-wide cycle and the execution the repair started from', () => {
    const { ctx, sink } = ctxFor({ healCycles: 2, currentExecution: { index: 3, afterCycle: 1 } })
    appendJournalIteration(ctx, { signal: '.rerun', hypothesis: 'h' })
    const body = fs.readFileSync(ctx.paths.diagnosisJournalPath, 'utf-8')
    expect(body).toContain('- cycle: 2\n')
    expect(body).toContain('- inputExecution: 3\n')
    expect(sink.recordJournalChange).toHaveBeenCalledWith(ctx.runId)
  })

  it('takes the input execution from the manifest after a restart-heal, and omits it on a legacy run', () => {
    const restarted = ctxFor({ healCycles: 3 })
    fs.writeFileSync(restarted.ctx.paths.manifestPath, JSON.stringify({ playwrightExecutions: 4 }))
    appendJournalIteration(restarted.ctx, { signal: '.rerun', hypothesis: 'h' })
    expect(fs.readFileSync(restarted.ctx.paths.diagnosisJournalPath, 'utf-8')).toContain('- inputExecution: 4\n')

    fs.writeFileSync(restarted.ctx.paths.manifestPath, '{}')
    fs.rmSync(restarted.ctx.paths.diagnosisJournalPath)
    appendJournalIteration(restarted.ctx, { signal: '.rerun', hypothesis: 'h' })
    expect(fs.readFileSync(restarted.ctx.paths.diagnosisJournalPath, 'utf-8')).not.toContain('inputExecution')
  })
})
