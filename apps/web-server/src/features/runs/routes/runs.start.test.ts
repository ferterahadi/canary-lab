import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { runsRoutes, type ExternalHealAgentRequest } from './runs'
import { createRegistry, RunStore, type OrchestratorLike, type RestartHealResult, type RestartRunResult } from '../logic/run-store'
import { readManifest, readRunsIndex, writeManifest, writeRunsIndex, type RunManifest } from '../logic/runtime/manifest'
import { runDirFor } from '../logic/runtime/run-paths'
import { launchEditorDir } from '../../../shared/editor-launch'
import type { WorkspaceEvent } from '../../../shared/workspace-events'
import type { ExecutionType } from '../../../../../../shared/verification'

vi.mock('../../../shared/editor-launch', () => ({ launchEditorDir: vi.fn(() => 'vscode') }))

// The PR routes are thin plumbing over these two — they're unit-tested in
// depth next door, so here they're stubbed to prove the wiring, the 409 gate,
// and the manifest merge.
const prMocks = vi.hoisted(() => ({ buildPrPreflight: vi.fn(), proposeFixesForRun: vi.fn() }))

vi.mock('../logic/pr/pr-preflight', () => ({ buildPrPreflight: prMocks.buildPrPreflight }))

vi.mock('../logic/pr/propose-fixes', () => ({ proposeFixesForRun: prMocks.proposeFixesForRun }))

let tmpDir: string

let logsDir: string

let featuresDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rroutes-')))
  logsDir = path.join(tmpDir, 'logs')
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featuresDir, { recursive: true })
})

function makeStub(runId: string): OrchestratorLike & { stopped: boolean } {
  let stopped = false
  return {
    runId,
    stop: async () => { stopped = true },
    pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
    cancelHeal: async () => ({ ok: true }),
    get stopped() { return stopped },
  } as OrchestratorLike & { stopped: boolean }
}

function writeFeature(name: string): void {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: ${JSON.stringify(name)}, description: 'd', envs: [], featureDir: __dirname } }`,
  )
}

async function build(opts: {
	  startRun?: Parameters<typeof runsRoutes>[1]['startRun']
	  cancelQueuedRun?: (runId: string) => boolean
	  broker?: Parameters<typeof runsRoutes>[1]['broker']
	  restartHeal?: (runId: string, text: string) => Promise<RestartHealResult>
	  restartRun?: (runId: string) => Promise<RestartRunResult>
  projectRoot?: string
  events?: WorkspaceEvent[]
  isWorktreeOwnerActive?: (kind: 'run' | 'benchmark', id: string) => boolean
} = {}) {
  const registry = createRegistry()
  const store = new RunStore(logsDir, registry)
  const app = Fastify()
  await app.register(runsRoutes, {
    featuresDir,
    projectRoot: opts.projectRoot,
    store,
    broker: opts.broker,
	    startRun: opts.startRun ?? (async () => { throw new Error('not configured') }),
	    cancelQueuedRun: opts.cancelQueuedRun,
	    restartHeal: opts.restartHeal,
    restartRun: opts.restartRun,
    isWorktreeOwnerActive: opts.isWorktreeOwnerActive,
	    workspaceEvents: opts.events ? { publish: (event) => opts.events!.push(event) } : undefined,
	  })
  return { app, registry, store }
}

describe('POST /api/runs', () => {
  it('400s when feature missing from body', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: {} })
    expect(res.statusCode).toBe(400)
  })

  it('404s when feature is unknown', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'ghost' } })
    expect(res.statusCode).toBe(404)
  })

  it('starts a run via the injected factory and registers it', async () => {
    writeFeature('foo')
    const stub = makeStub('run-1')
    const { app, registry } = await build({ startRun: async () => ({ kind: 'started', orch: stub }) })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'foo' } })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ runId: 'run-1' })
    expect(registry.get('run-1')).toBe(stub)
  })

  it('surfaces a branch-mismatch throw as a typed 409 with per-repo rows', async () => {
    writeFeature('foo')
    const branchMismatch = [
      { name: 'app', path: '/repo', expected: 'feature/x', current: 'main', detached: false, isGitRepo: true },
    ]
    const { app } = await build({
      startRun: async () => {
        throw Object.assign(new Error('Repo branch check failed:\napp: expected feature/x, current main'), {
          statusCode: 409,
          branchMismatch,
        })
      },
    })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'foo' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({
      type: 'repo_branch_mismatch',
      feature: 'foo',
      repos: branchMismatch,
    })
    // Human message preserved for REST/MCP callers that don't parse the type.
    expect(res.json().error).toContain('Repo branch check failed')
  })

  it('400s when env is not in feature.envs', async () => {
    const dir = path.join(featuresDir, 'foo')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'foo', description: 'd', envs: ['local','production'], featureDir: __dirname } }`,
    )
    const stub = makeStub('rx')
    const { app } = await build({ startRun: async () => ({ kind: 'started', orch: stub }) })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { feature: 'foo', env: 'staging' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('env must be one of')
  })

  it('accepts a valid env from feature.envs', async () => {
    const dir = path.join(featuresDir, 'foo')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'foo', description: 'd', envs: ['local','production'], featureDir: __dirname } }`,
    )
    const stub = makeStub('ry')
    let receivedEnv = ''
    const { app } = await build({ startRun: async (_feature, env) => { receivedEnv = env ?? ''; return { kind: 'started', orch: stub } } })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { feature: 'foo', env: 'production' },
    })
    expect(res.statusCode).toBe(201)
    expect(receivedEnv).toBe('production')
  })

  it('defaults to the first declared env', async () => {
    const dir = path.join(featuresDir, 'foo')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'foo', description: 'd', envs: ['local','production'], featureDir: __dirname } }`,
    )
    const stub = makeStub('rz')
    let receivedEnv = ''
    const { app } = await build({ startRun: async (_feature, env) => { receivedEnv = env ?? ''; return { kind: 'started', orch: stub } } })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'foo' } })
    expect(res.statusCode).toBe(201)
    expect(receivedEnv).toBe('local')
  })

  it('passes executionType "boot" to the factory when mode:boot is requested', async () => {
    writeFeature('foo')
    const stub = makeStub('rb')
    let receivedExecutionType: string | undefined = 'untouched'
    const { app } = await build({
      startRun: async (_f, _e, _h, _i, executionType) => { receivedExecutionType = executionType; return { kind: 'started', orch: stub } },
    })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'foo', mode: 'boot' } })
    expect(res.statusCode).toBe(201)
    expect(receivedExecutionType).toBe('boot')
  })

  it('defaults executionType to "run" when mode is omitted', async () => {
    writeFeature('foo')
    const stub = makeStub('rr')
    let receivedExecutionType: string | undefined = 'untouched'
    const { app } = await build({
      startRun: async (_f, _e, _h, _i, executionType) => { receivedExecutionType = executionType; return { kind: 'started', orch: stub } },
    })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'foo' } })
    expect(res.statusCode).toBe(201)
    expect(receivedExecutionType).toBe('run')
  })

  it('runs without env when feature declares no envs', async () => {
    const dir = path.join(featuresDir, 'noenv')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'noenv', description: 'd', featureDir: __dirname } }`,
    )
    const stub = makeStub('rno')
    let receivedEnv: string | undefined = 'untouched'
    const { app } = await build({
      startRun: async (_f, env) => { receivedEnv = env; return { kind: 'started', orch: stub } },
    })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'noenv' } })
    expect(res.statusCode).toBe(201)
    expect(receivedEnv).toBeUndefined()
  })

  it('returns 409 repo_collision_requires_choice when the factory reports a collision', async () => {
    writeFeature('foo')
    const { app } = await build({
      startRun: async () => ({ kind: 'collision', conflictingRunId: 'other-1', conflictingFeature: 'foo', repoPaths: ['/repos/foo'] }),
    })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'foo' } })
    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.type).toBe('repo_collision_requires_choice')
    expect(body.conflictingRunId).toBe('other-1')
    expect(body.options).toEqual(['worktree', 'queue'])
  })

  it('returns 202 + queueReason when the factory queues the run, threading isolation', async () => {
    writeFeature('foo')
    let receivedIsolation: string | undefined = 'untouched'
    const { app } = await build({
      startRun: async (_f, _env, _heal, isolation) => { receivedIsolation = isolation; return { kind: 'queued', runId: 'q-1', reason: 'repo-collision' } },
    })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'foo', isolation: 'queue' } })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ runId: 'q-1', status: 'queued', queueReason: 'repo-collision' })
    expect(receivedIsolation).toBe('queue')
  })

  it('aborting a queued run falls back to cancelQueuedRun', async () => {
    writeFeature('foo')
    const cancelled: string[] = []
    const { app } = await build({
      cancelQueuedRun: (runId) => { cancelled.push(runId); return true },
    })
    const res = await app.inject({ method: 'POST', url: '/api/runs/q-9/abort' })
    expect(res.statusCode).toBe(204)
    expect(cancelled).toEqual(['q-9'])
  })

  it('reuses an active external-heal run instead of starting another run', async () => {
    const dir = path.join(featuresDir, 'foo')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'foo', description: 'd', envs: ['local'], featureDir: __dirname } }`,
    )
    const runDir = runDirFor(logsDir, 'active-heal')
    fs.mkdirSync(runDir, { recursive: true })
    writeManifest(path.join(runDir, 'manifest.json'), {
      runId: 'active-heal',
      feature: 'foo',
      featureDir: dir,
      env: 'local',
      startedAt: '2026-05-19T00:00:00.000Z',
      status: 'healing',
      healCycles: 1,
      services: [],
      healMode: 'external',
      lifecycle: {
        phase: 'waiting-for-signal',
        headline: 'Waiting for heal signal',
        updatedAt: '2026-05-19T00:00:01.000Z',
      },
    })
    writeRunsIndex(logsDir, [
      {
        runId: 'active-heal',
        feature: 'foo',
        startedAt: '2026-05-19T00:00:00.000Z',
        status: 'healing',
      },
    ])
    const startRun = vi.fn(async () => ({ kind: 'started' as const, orch: makeStub('new-run') }))
    const claim = vi.fn(() => ({
      accepted: true as const,
      session: {
        sessionId: 'sess-1',
        clientKind: 'claude' as const,
        claimedAt: '2026-05-19T00:00:02.000Z',
        lastHeartbeatAt: '2026-05-19T00:00:02.000Z',
        status: 'connected' as const,
        cycleCount: 0,
      },
    }))
    const { app } = await build({ startRun, broker: { claim } })

    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        feature: 'foo',
        env: 'local',
        healAgent: {
          kind: 'external',
          sessionId: 'sess-1',
          clientKind: 'claude',
          conversationName: 'resume run',
        },
        forceNew: true,
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      runId: 'active-heal',
      reused: true,
      status: 'healing',
      claimed: true,
      ignoredForceNew: true,
    })
    expect(res.json().warning).toContain('signal_run')
    expect(startRun).not.toHaveBeenCalled()
    expect(claim).toHaveBeenCalledWith('active-heal', {
      sessionId: 'sess-1',
      clientKind: 'claude',
      conversationName: 'resume run',
    })
  })

  it('starts a runner PTY healAgent as external-origin with claimable:false (claim suppressed)', async () => {
    writeFeature('foo')
    const stub = makeStub('new-run')
    const startRun = vi.fn(async (
      _feature: string,
      _env?: string,
      _healAgent?: ExternalHealAgentRequest,
      _isolation?: 'worktree' | 'queue',
      _executionType?: ExecutionType,
    ) => ({ kind: 'started' as const, orch: stub }))
    const { app } = await build({ startRun })

    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        feature: 'foo',
        healAgent: {
          kind: 'external',
          sessionId: 'sess-pty',
          clientKind: 'claude-pty',
          conversationName: 'pty should not own heal',
        },
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ runId: 'new-run', claimSuppressed: true })
    expect(typeof res.json().message).toBe('string')
    // The run is still external-origin (so it uses External-client heal, not the
    // project Heal Agent), but the runner PTY session can't own it: claimable:false
    // ⇒ no session/claim, the run waits for an interactive/UI drive.
    expect(startRun).toHaveBeenCalledTimes(1)
    expect(startRun.mock.calls[0][2]).toEqual({
      kind: 'external',
      sessionId: 'sess-pty',
      clientKind: 'claude-pty',
      conversationName: 'pty should not own heal',
      claimable: false,
    })
  })

  it('500s with stringified non-Error rejection', async () => {
    writeFeature('foo')
    const { app } = await build({ startRun: async () => { throw 'plain string' } })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'foo' } })
    expect(res.statusCode).toBe(500)
    expect(res.json().error).toBe('plain string')
  })

  it('500s when factory throws', async () => {
    writeFeature('foo')
    const { app } = await build({ startRun: async () => { throw new Error('boom') } })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'foo' } })
    expect(res.statusCode).toBe(500)
    expect(res.json().error).toContain('boom')
  })

  it('preserves typed startRun failure status codes', async () => {
    writeFeature('foo')
    const err = Object.assign(new Error('Repo branch check failed'), { statusCode: 409 })
    const { app } = await build({ startRun: async () => { throw err } })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'foo' } })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toContain('Repo branch check failed')
  })
})
