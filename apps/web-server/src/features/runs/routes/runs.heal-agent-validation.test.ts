import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { runsRoutes, type ExternalHealAgentRequest } from './runs'
import { createRegistry, RunStore, type OrchestratorLike, type RestartHealResult, type RestartRunResult } from '../logic/run-store'
import type { ClaimInput } from '../logic/heal/external-heal-broker'
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

describe('healAgent request-body validation', () => {
  it('400s when healAgent is not an object', async () => {
    writeFeature('foo')
    const { app } = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { feature: 'foo', healAgent: 'not-an-object' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'healAgent must be an object' })
  })

  it('starts normally when healAgent is an object with no "kind" field', async () => {
    writeFeature('foo')
    const stub = makeStub('run-nokind')
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
      payload: { feature: 'foo', healAgent: { sessionId: 'no-kind-here' } },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ runId: 'run-nokind' })
    // healAgent parsed to null → passed through as undefined to the factory.
    expect(startRun.mock.calls[0][2]).toBeUndefined()
  })

  it('400s when healAgent.kind is set but not "external"', async () => {
    writeFeature('foo')
    const { app } = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { feature: 'foo', healAgent: { kind: 'internal' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'healAgent.kind must be "external" when overriding from the request body' })
  })

  it('400s when kind="external" but sessionId is missing', async () => {
    writeFeature('foo')
    const { app } = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { feature: 'foo', healAgent: { kind: 'external', clientKind: 'claude' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'healAgent.sessionId is required when kind="external"' })
  })

  it('400s when kind="external" but clientKind is invalid', async () => {
    writeFeature('foo')
    const { app } = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { feature: 'foo', healAgent: { kind: 'external', sessionId: 's1', clientKind: 'not-a-real-client' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toContain('healAgent.clientKind must be one of')
  })

  it('threads healAgent.clientVersion through to broker.claim on the reuse path', async () => {
    const dir = path.join(featuresDir, 'foo')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'foo', description: 'd', envs: ['local'], featureDir: __dirname } }`,
    )
    const runDir = runDirFor(logsDir, 'active-cv')
    fs.mkdirSync(runDir, { recursive: true })
    writeManifest(path.join(runDir, 'manifest.json'), {
      runId: 'active-cv',
      feature: 'foo',
      featureDir: dir,
      env: 'local',
      startedAt: '2026-05-19T00:00:00.000Z',
      status: 'healing',
      healCycles: 1,
      services: [],
    })
    writeRunsIndex(logsDir, [
      { runId: 'active-cv', feature: 'foo', startedAt: '2026-05-19T00:00:00.000Z', status: 'healing' },
    ])
    // A runner-PTY client (claim suppressed) so this test also covers the
    // claimSuppressed:true branch of the *reused-run* response, distinct
    // from the already-tested claimSuppressed branch of the fresh-start
    // response.
    const claim = vi.fn((_runId: string, input: ClaimInput) => ({
      accepted: false as const,
      reason: 'client-kind-not-allowed' as const,
      clientKind: input.clientKind,
    }))
    const { app } = await build({ broker: { claim } })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        feature: 'foo',
        env: 'local',
        healAgent: { kind: 'external', sessionId: 'sess-cv', clientKind: 'claude-pty', clientVersion: '9.9.9' },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ runId: 'active-cv', reused: true, claimSuppressed: true, claimed: false })
    expect(claim).toHaveBeenCalledWith('active-cv', { sessionId: 'sess-cv', clientKind: 'claude-pty', clientVersion: '9.9.9' })
  })
})

describe('POST /api/runs — active-run priority selection', () => {
  it('prefers waiting-for-signal, then healing, then a stale manifest — skipping env-mismatched and dangling index entries', async () => {
    const dir = path.join(featuresDir, 'foo')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'foo', description: 'd', envs: ['local','other'], featureDir: __dirname } }`,
    )

    function manifestFor(runId: string, over: Partial<RunManifest>): void {
      const rd = runDirFor(logsDir, runId)
      fs.mkdirSync(rd, { recursive: true })
      writeManifest(path.join(rd, 'manifest.json'), {
        runId,
        feature: 'foo',
        featureDir: dir,
        env: 'local',
        startedAt: '2026-06-01T00:00:00.000Z',
        status: 'healing',
        healCycles: 1,
        services: [],
        ...over,
      })
    }

    // Priority 0: parked waiting for an external signal.
    manifestFor('r-waiting', {
      lifecycle: { phase: 'waiting-for-signal', headline: 'w', updatedAt: '2026-06-01T00:00:01.000Z' },
    })
    // Priority 1 (two of these — forces the startedAt tie-break comparator
    // both ways as the sort orders them relative to each other).
    manifestFor('r-mid-a', { startedAt: '2026-06-01T00:00:05.000Z' })
    manifestFor('r-mid-b', { startedAt: '2026-06-01T00:00:03.000Z' })
    // Priority 2: the index still says "healing", but the manifest itself
    // has drifted to a non-active status with no waiting-for-signal
    // lifecycle — the lowest priority tier.
    manifestFor('r-stale', { status: 'running' })
    // Wrong env — filtered out before priority is ever considered.
    manifestFor('r-wrong-env', { env: 'other' })

    writeRunsIndex(logsDir, [
      { runId: 'r-waiting', feature: 'foo', startedAt: '2026-06-01T00:00:01.000Z', status: 'healing' },
      { runId: 'r-mid-a', feature: 'foo', startedAt: '2026-06-01T00:00:05.000Z', status: 'healing' },
      { runId: 'r-mid-b', feature: 'foo', startedAt: '2026-06-01T00:00:03.000Z', status: 'healing' },
      { runId: 'r-stale', feature: 'foo', startedAt: '2026-06-01T00:00:02.000Z', status: 'healing' },
      { runId: 'r-wrong-env', feature: 'foo', startedAt: '2026-06-01T00:00:09.000Z', status: 'healing' },
      // Dangling: indexed as healing but no manifest.json on disk at all.
      { runId: 'r-ghost', feature: 'foo', startedAt: '2026-06-01T00:00:08.000Z', status: 'healing' },
    ])

    // No broker configured — exercises the `deps.broker?.claim` short-circuit
    // (claim stays null) on the reuse path.
    const { app } = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        feature: 'foo',
        env: 'local',
        healAgent: { kind: 'external', sessionId: 'sess-p', clientKind: 'claude' },
      },
    })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ runId: 'r-waiting', reused: true, claimed: false })
    expect(res.json().claimSuppressed).toBeUndefined()
    expect(res.json().ignoredForceNew).toBeUndefined()
  })
})

describe('POST /api/runs — active-run priority selection, exact startedAt tie', () => {
  it('resolves a same-priority, identical-startedAt tie deterministically (comparator returns 0)', async () => {
    // Distinct from the r-mid-a/r-mid-b case above, which has different
    // startedAt values and so only exercises the `<` / `>` arms of the
    // nested ternary. Here startedAt is byte-identical on both candidates,
    // forcing the `=== ` (return 0) arm.
    const dir = path.join(featuresDir, 'foo')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'feature.config.cjs'),
      `module.exports = { config: { name: 'foo', description: 'd', envs: ['local'], featureDir: __dirname } }`,
    )
    function manifestFor(runId: string): void {
      const rd = runDirFor(logsDir, runId)
      fs.mkdirSync(rd, { recursive: true })
      writeManifest(path.join(rd, 'manifest.json'), {
        runId,
        feature: 'foo',
        featureDir: dir,
        env: 'local',
        startedAt: '2026-06-01T00:00:00.000Z',
        status: 'healing',
        healCycles: 1,
        services: [],
      })
    }
    manifestFor('r-tie-a')
    manifestFor('r-tie-b')
    writeRunsIndex(logsDir, [
      { runId: 'r-tie-a', feature: 'foo', startedAt: '2026-06-01T00:00:00.000Z', status: 'healing' },
      { runId: 'r-tie-b', feature: 'foo', startedAt: '2026-06-01T00:00:00.000Z', status: 'healing' },
    ])
    const { app } = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: {
        feature: 'foo',
        env: 'local',
        healAgent: { kind: 'external', sessionId: 'sess-tie', clientKind: 'claude' },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ reused: true })
    expect(['r-tie-a', 'r-tie-b']).toContain(res.json().runId)
  })
})

describe('POST /api/runs/:runId/restart — default reason', () => {
  it('409s with reason=not-restartable when restartRun is not configured at all', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs/r1/restart' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ reason: 'not-restartable' })
  })
})

describe('POST /api/runs/:runId/agent-input — unexpected interject failure reason', () => {
  it('409s directly (without attempting restartHeal) when interjectHealAgent fails for a reason other than no-agent-running', async () => {
    // OrchestratorInterjectResult's type only declares 'no-agent-running' as
    // a failure reason; this exercises the route's defensive fallback for an
    // orchestrator implementation that returns something else.
    const stub: OrchestratorLike = {
      runId: 'ai5',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true }),
      interjectHealAgent: async () => ({ ok: false, reason: 'unexpected-reason' }) as unknown as { ok: false, reason: 'no-agent-running' },
    }
    let restartHealCalled = false
    const { app, registry } = await build({
      restartHeal: async () => { restartHealCalled = true; return { ok: true } },
    })
    registry.set('ai5', stub)
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/ai5/agent-input',
      payload: { data: 'hi' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ reason: 'unexpected-reason' })
    expect(restartHealCalled).toBe(false)
  })
})
