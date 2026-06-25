import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { runsRoutes } from './runs'
import { createRegistry, RunStore, type OrchestratorLike, type RestartHealResult, type RestartRunResult } from '../../runs/logic/run-store'
import { readManifest, readRunsIndex, writeManifest, writeRunsIndex } from '../../runs/logic/runtime/manifest'
import { runDirFor } from '../../runs/logic/runtime/run-paths'
import type { WorkspaceEvent } from '../../../shared/workspace-events'

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

function writeManifestForRun(runId: string, feature = 'foo', status: 'running' | 'passed' | 'failed' | 'healing' | 'aborted' = 'passed'): void {
  const dir = runDirFor(logsDir, runId)
  fs.mkdirSync(dir, { recursive: true })
  writeManifest(path.join(dir, 'manifest.json'), {
    runId,
    feature,
    featureDir: path.join(featuresDir, feature),
    startedAt: 'now',
    status,
    healCycles: 0,
    services: [],
  })
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
	    workspaceEvents: opts.events ? { publish: (event) => opts.events!.push(event) } : undefined,
	  })
  return { app, registry, store }
}

describe('GET /api/runs', () => {
  it('lists runs newest first', async () => {
    writeRunsIndex(logsDir, [
      { runId: 'a', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'passed' },
      { runId: 'b', feature: 'foo', startedAt: '2026-02-01T00:00:00Z', status: 'failed' },
    ])
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs' })
    expect(res.json().map((r: { runId: string }) => r.runId)).toEqual(['b', 'a'])
  })

  it('filters by feature', async () => {
    writeRunsIndex(logsDir, [
      { runId: 'a', feature: 'foo', startedAt: '2026-01-01T00:00:00Z', status: 'passed' },
      { runId: 'b', feature: 'bar', startedAt: '2026-02-01T00:00:00Z', status: 'failed' },
    ])
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs?feature=bar' })
    expect(res.json().map((r: { runId: string }) => r.runId)).toEqual(['b'])
  })
})

describe('GET /api/runs/:runId', () => {
  it('returns the manifest', async () => {
    writeManifestForRun('r1')
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1' })
    expect(res.statusCode).toBe(200)
    expect(res.json().runId).toBe('r1')
  })

  it('404s on unknown', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/none' })
    expect(res.statusCode).toBe(404)
  })
})

describe('GET /api/runs/:runId/agent-session', () => {
  it('returns normalized events when agent-session.json + log exist', async () => {
    writeManifestForRun('r1')
    const runDir = runDirFor(logsDir, 'r1')
    // Stand up a fake claude session log on disk.
    const logPath = path.join(tmpDir, 'fake-session.jsonl')
    fs.writeFileSync(logPath, JSON.stringify({
      type: 'user',
      timestamp: 't',
      message: { content: 'hi' },
    }) + '\n')
    fs.writeFileSync(path.join(runDir, 'agent-session.json'), JSON.stringify({
      agent: 'claude',
      sessionId: 'sid',
      logPath,
    }))

    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/agent-session' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { agent: string; events: Array<{ kind: string }> }
    expect(body.agent).toBe('claude')
    expect(body.events).toEqual([
      { kind: 'user-message', timestamp: 't', text: 'hi' },
    ])
  })

  it('404 reason=run-not-found when the run is unknown', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/none/agent-session' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ reason: 'run-not-found' })
  })

  it('404 reason=no-session-ref when the pointer file is missing', async () => {
    writeManifestForRun('r1')
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/agent-session' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ reason: 'no-session-ref' })
  })

  it('404 reason=session-log-missing when the pointed-at JSONL is gone', async () => {
    writeManifestForRun('r1')
    const runDir = runDirFor(logsDir, 'r1')
    fs.writeFileSync(path.join(runDir, 'agent-session.json'), JSON.stringify({
      agent: 'claude',
      sessionId: 'sid',
      logPath: path.join(tmpDir, 'never-existed.jsonl'),
    }))
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/agent-session' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ reason: 'session-log-missing' })
  })
})

describe('GET /api/runs/:runId/artifacts/*', () => {
  it('serves files from the run-local Playwright artifact directory', async () => {
    writeManifestForRun('r1')
    const file = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts', 'case-a', 'test-failed-1.png')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'PNGDATA')
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/case-a/test-failed-1.png' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('image/png')
    expect(res.body).toBe('PNGDATA')
  })

  it('rejects artifact path traversal', async () => {
    writeManifestForRun('r1')
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/..%2Fmanifest.json' })
    expect(res.statusCode).toBe(400)
  })

  it('404s when artifact path is missing or points to a directory', async () => {
    writeManifestForRun('r1')
    const dir = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts', 'case-a')
    fs.mkdirSync(dir, { recursive: true })
    const { app } = await build()

    expect((await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/missing.png' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/case-a' })).statusCode).toBe(404)
  })

  it.each([
    ['case.jpg', 'image/jpeg'],
    ['case.jpeg', 'image/jpeg'],
    ['case.webp', 'image/webp'],
    ['case.webm', 'video/webm'],
    ['case.mp4', 'video/mp4'],
    ['trace.zip', 'application/zip'],
    ['raw.bin', 'application/octet-stream'],
  ])('serves %s with %s', async (name, contentType) => {
    writeManifestForRun('r1')
    const file = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts', name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'data')
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: `/api/runs/r1/artifacts/${name}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain(contentType)
  })

  it('falls back to the keep dir when the file is only in playwright-artifacts-keep', async () => {
    // After a heal-cycle respawn, Playwright wipes `playwright-artifacts/`.
    // Files that the orchestrator copied into `playwright-artifacts-keep/`
    // must still be reachable via the same artifact URL the indexer minted
    // against the live dir.
    writeManifestForRun('r1')
    const keepFile = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts-keep', 'pw-slug-a', 'video.webm')
    fs.mkdirSync(path.dirname(keepFile), { recursive: true })
    fs.writeFileSync(keepFile, 'KEPT-WEBM')
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/pw-slug-a/video.webm' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('video/webm')
    expect(res.body).toBe('KEPT-WEBM')
  })

  it('prefers the live dir when the same path exists in both', async () => {
    writeManifestForRun('r1')
    const live = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts', 'pw-slug-a', 'video.webm')
    const keep = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts-keep', 'pw-slug-a', 'video.webm')
    fs.mkdirSync(path.dirname(live), { recursive: true })
    fs.mkdirSync(path.dirname(keep), { recursive: true })
    fs.writeFileSync(live, 'FRESH-WEBM')
    fs.writeFileSync(keep, 'STALE-WEBM')
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/pw-slug-a/video.webm' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('FRESH-WEBM')
  })

  it('404s when the file is in neither dir', async () => {
    writeManifestForRun('r1')
    // Create both dirs but no matching file.
    fs.mkdirSync(path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts'), { recursive: true })
    fs.mkdirSync(path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts-keep'), { recursive: true })
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/pw-slug-a/video.webm' })
    expect(res.statusCode).toBe(404)
  })
})

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
    const startRun = vi.fn(async () => makeStub('new-run'))
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
    const startRun = vi.fn(async () => ({ kind: 'started' as const, orch: stub }))
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

describe('POST /api/runs/:runId/pause-heal', () => {
  it('404s when run not in registry', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs/ghost/pause-heal' })
    expect(res.statusCode).toBe(404)
  })

  it('202s with failureCount on success', async () => {
    const stub: OrchestratorLike = {
      runId: 'rp1',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: true, failureCount: 3 }),
      cancelHeal: async () => ({ ok: true }),
    }
    const { app, registry } = await build()
    registry.set('rp1', stub)
    const res = await app.inject({ method: 'POST', url: '/api/runs/rp1/pause-heal' })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ status: 'healing', failureCount: 3 })
  })

  it.each([
    ['already-healing'],
    ['no-playwright-running'],
    ['no-failures-yet'],
  ] as const)('409s with reason=%s', async (reason) => {
    const stub: OrchestratorLike = {
      runId: 'rp2',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: false, reason }),
      cancelHeal: async () => ({ ok: true }),
    }
    const { app, registry } = await build()
    registry.set('rp2', stub)
    const res = await app.inject({ method: 'POST', url: '/api/runs/rp2/pause-heal' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ reason })
  })
})

describe('POST /api/runs/:runId/cancel-heal', () => {
  it('404s when run not in registry', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs/ghost/cancel-heal' })
    expect(res.statusCode).toBe(404)
  })

  it('202s with status=cancelled on success', async () => {
    const stub: OrchestratorLike = {
      runId: 'rc1',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: true, failureCount: 1 }),
      cancelHeal: async () => ({ ok: true }),
    }
    const { app, registry } = await build()
    registry.set('rc1', stub)
    const res = await app.inject({ method: 'POST', url: '/api/runs/rc1/cancel-heal' })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ status: 'cancelled' })
  })

  it.each([['not-healing'], ['no-agent-running']] as const)('409s with reason=%s', async (reason) => {
    const stub: OrchestratorLike = {
      runId: 'rc2',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
      cancelHeal: async () => ({ ok: false, reason }),
    }
    const { app, registry } = await build()
    registry.set('rc2', stub)
    const res = await app.inject({ method: 'POST', url: '/api/runs/rc2/cancel-heal' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ reason })
  })
})

describe('POST /api/runs/:runId/agent-input', () => {
  it('409s when run is not active and cannot restart heal', async () => {
    const { app } = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/ghost/agent-input',
      payload: { data: 'hi\n' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ reason: 'no-agent-running' })
  })

  it('400s when data is missing or not a string', async () => {
    const stub: OrchestratorLike = {
      runId: 'ai1',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true }),
    }
    const { app, registry } = await build()
    registry.set('ai1', stub)
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/ai1/agent-input',
      payload: { data: 123 },
    })
    expect(res.statusCode).toBe(400)
  })

  it('409s when no agent is running', async () => {
    const stub: OrchestratorLike = {
      runId: 'ai2',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true }),
      interjectHealAgent: async () => ({ ok: false, reason: 'no-agent-running' }),
    }
    const { app, registry } = await build()
    registry.set('ai2', stub)
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/ai2/agent-input',
      payload: { data: 'hello\n' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ reason: 'no-agent-running' })
  })

  it('restarts heal when an active orchestrator reports no running agent', async () => {
    const stub: OrchestratorLike = {
      runId: 'ai2b',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true }),
      interjectHealAgent: async () => ({ ok: false, reason: 'no-agent-running' }),
    }
    let received = { runId: '', text: '' }
    const { app, registry } = await build({
      restartHeal: async (runId, text) => {
        received = { runId, text }
        return { ok: true }
      },
    })
    registry.set('ai2b', stub)

    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/ai2b/agent-input',
      payload: { data: 'resume work' },
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ status: 'restarted' })
    expect(received).toEqual({ runId: 'ai2b', text: 'resume work' })
  })

  it('202s with status=restarted when a failed stopped run can restart heal', async () => {
    let received = { runId: '', text: '' }
    const { app } = await build({
      restartHeal: async (runId, text) => {
        received = { runId, text }
        return { ok: true }
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/old-failed/agent-input',
      payload: { data: 'try this' },
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ status: 'restarted' })
    expect(received).toEqual({ runId: 'old-failed', text: 'try this' })
  })

  it('500s when a stopped run heal restart fails to spawn', async () => {
    const { app } = await build({
      restartHeal: async () => ({ ok: false, reason: 'spawn-failed' }),
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/spawn-failed/agent-input',
      payload: { data: 'try again' },
    })

    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ reason: 'spawn-failed' })
  })

  // The old `no-session-id` case came from kill+respawn interject. With the
  // bidirectional REPL, active-run interject is just a stdin write, so the only
  // structured active-agent failure left is `no-agent-running`.

  it('409s when interjectHealAgent is undefined (manual mode)', async () => {
    const stub: OrchestratorLike = {
      runId: 'ai3',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true }),
    }
    const { app, registry } = await build()
    registry.set('ai3', stub)
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/ai3/agent-input',
      payload: { data: 'hello\n' },
    })
    expect(res.statusCode).toBe(409)
  })

  it('202s with status=sent on success', async () => {
    let received = ''
    const stub: OrchestratorLike = {
      runId: 'ai4',
      stop: async () => { /* noop */ },
      pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true }),
      interjectHealAgent: async (text: string) => { received = text; return { ok: true } },
    }
    const { app, registry } = await build()
    registry.set('ai4', stub)
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/ai4/agent-input',
      payload: { data: 'hi\n' },
    })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ status: 'sent' })
    expect(received).toBe('hi\n')
  })
})

describe('POST /api/runs/:runId/restart', () => {
  it('restarts a terminal run in remaining-test mode', async () => {
    let received = ''
    const { app } = await build({
      restartRun: async (runId) => {
        received = runId
        return { ok: true, mode: 'remaining' }
      },
    })

    const res = await app.inject({ method: 'POST', url: '/api/runs/old-failed/restart' })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ status: 'restarted', mode: 'remaining' })
    expect(received).toBe('old-failed')
  })

  it.each([
    ['run-not-found', 404],
    ['not-restartable', 409],
    ['already-active', 409],
    ['spawn-failed', 500],
  ] as const)('maps restart failure %s to HTTP %d', async (reason, statusCode) => {
    const { app } = await build({
      restartRun: async () => ({ ok: false, reason }),
    })

    const res = await app.inject({ method: 'POST', url: '/api/runs/r1/restart' })

    expect(res.statusCode).toBe(statusCode)
    expect(res.json()).toEqual({ reason })
  })
})

describe('POST /api/runs/:runId/abort', () => {
  it('stops a registered orchestrator and 204s', async () => {
    const stub = makeStub('r2')
    const { app, registry } = await build()
    registry.set('r2', stub)
    const res = await app.inject({ method: 'POST', url: '/api/runs/r2/abort' })
    expect(res.statusCode).toBe(204)
    expect(stub.stopped).toBe(true)
    expect(registry.get('r2')).toBeUndefined()
  })

  it('preserves the run dir/history when an active orchestrator is aborted', async () => {
    writeManifestForRun('r2b') // baseline manifest exists
    const stub = makeStub('r2b')
    const { app, registry } = await build()
    registry.set('r2b', stub)
    const res = await app.inject({ method: 'POST', url: '/api/runs/r2b/abort' })
    expect(res.statusCode).toBe(204)
    expect(stub.stopped).toBe(true)
    // History is preserved so the user can still audit logs.
    expect(fs.existsSync(runDirFor(logsDir, 'r2b'))).toBe(true)
  })

  it('404s when run is not active', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs/ghost/abort' })
    expect(res.statusCode).toBe(404)
  })

  it('aborts an orphaned persisted active run instead of 404ing', async () => {
    const dir = runDirFor(logsDir, 'orphan')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'orphan',
      feature: 'foo',
      startedAt: 'now',
      status: 'running',
      healCycles: 0,
      services: [{ name: 'api', safeName: 'api', command: 'x', cwd: '/', status: 'ready', logPath: '/x.log' }],
    })
    writeRunsIndex(logsDir, [
      { runId: 'orphan', feature: 'foo', startedAt: 'now', status: 'running' },
    ])
    const { app } = await build()

    const res = await app.inject({ method: 'POST', url: '/api/runs/orphan/abort' })

    expect(res.statusCode).toBe(204)
    expect(readManifest(path.join(dir, 'manifest.json'))?.status).toBe('aborted')
    expect(readManifest(path.join(dir, 'manifest.json'))?.services[0].status).toBe('stopped')
    expect(readRunsIndex(logsDir)[0].status).toBe('aborted')
  })

  it('still 204s if stop() throws (best-effort)', async () => {
    const failing: OrchestratorLike = {
      runId: 'r4',
      stop: async () => { throw new Error('nope') },
      pauseAndHeal: async () => ({ ok: true, failureCount: 0 }),
      cancelHeal: async () => ({ ok: true }),
    }
    const { app, registry } = await build()
    registry.set('r4', failing)
    const res = await app.inject({ method: 'POST', url: '/api/runs/r4/abort' })
    expect(res.statusCode).toBe(204)
    expect(registry.get('r4')).toBeUndefined()
  })
})

describe('DELETE /api/runs/:runId', () => {
  it('removes a terminal run from history (index entry + run dir) and 204s', async () => {
    writeManifestForRun('r3') // status: 'passed'
    writeRunsIndex(logsDir, [
      { runId: 'r3', feature: 'foo', startedAt: 'now', status: 'passed' },
    ])
    const { app } = await build()
    const res = await app.inject({ method: 'DELETE', url: '/api/runs/r3' })
    expect(res.statusCode).toBe(204)
    expect(fs.existsSync(runDirFor(logsDir, 'r3'))).toBe(false)
    const list = await app.inject({ method: 'GET', url: '/api/runs' })
    expect((list.json() as Array<{ runId: string }>).find((r) => r.runId === 'r3')).toBeUndefined()
  })

  it('409s and preserves the run when an orchestrator is still registered', async () => {
    writeManifestForRun('r3b')
    const stub = makeStub('r3b')
    const { app, registry } = await build()
    registry.set('r3b', stub)
    const res = await app.inject({ method: 'DELETE', url: '/api/runs/r3b' })
    expect(res.statusCode).toBe(409)
    expect(stub.stopped).toBe(false)
    expect(fs.existsSync(runDirFor(logsDir, 'r3b'))).toBe(true)
  })

  it('409s when the manifest still claims running but no orch is registered', async () => {
    const dir = runDirFor(logsDir, 'r3c')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'r3c', feature: 'foo', startedAt: 'now', status: 'running', healCycles: 0, services: [],
    })
    const { app } = await build()
    const res = await app.inject({ method: 'DELETE', url: '/api/runs/r3c' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'run is still active; reap or abort first' })
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('404s when run unknown entirely', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'DELETE', url: '/api/runs/ghost' })
    expect(res.statusCode).toBe(404)
  })
})

describe('cleanup routes', () => {
  function seedArtifacts(runId: string, bytes: number): void {
    const dir = runDirFor(logsDir, runId)
    for (const sub of ['playwright-artifacts', 'playwright-artifacts-keep']) {
      fs.mkdirSync(path.join(dir, sub), { recursive: true })
      fs.writeFileSync(path.join(dir, sub, 'video.webm'), Buffer.alloc(bytes))
    }
  }

  it('GET /api/cleanup/runs returns sizes, orphans, and totals', async () => {
    writeManifestForRun('r-done', 'foo', 'passed')
    writeRunsIndex(logsDir, [{ runId: 'r-done', feature: 'foo', startedAt: 'now', status: 'passed' }])
    seedArtifacts('r-done', 1000)
    fs.mkdirSync(path.join(runDirFor(logsDir, 'r-orphan')), { recursive: true })
    fs.writeFileSync(path.join(runDirFor(logsDir, 'r-orphan'), 'x.log'), Buffer.alloc(40))

    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/cleanup/runs' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.runs.find((r: { runId: string }) => r.runId === 'r-done').artifactBytes).toBe(2000)
    expect(body.orphans.map((o: { runId: string }) => o.runId)).toEqual(['r-orphan'])
    expect(body.totals.reclaimableTrimBytes).toBe(2000)
  })

  it('POST /api/runs/:id/trim reclaims artifacts and returns freedBytes', async () => {
    writeManifestForRun('r-trim', 'foo', 'passed')
    writeRunsIndex(logsDir, [{ runId: 'r-trim', feature: 'foo', startedAt: 'now', status: 'passed' }])
    seedArtifacts('r-trim', 500)
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs/r-trim/trim' })
    expect(res.statusCode).toBe(200)
    expect(res.json().freedBytes).toBe(1000)
    expect(fs.existsSync(path.join(runDirFor(logsDir, 'r-trim'), 'playwright-artifacts'))).toBe(false)
    expect(fs.existsSync(path.join(runDirFor(logsDir, 'r-trim'), 'manifest.json'))).toBe(true)
  })

  it('POST trim 404s on unknown run', async () => {
    const { app } = await build()
    expect((await app.inject({ method: 'POST', url: '/api/runs/ghost/trim' })).statusCode).toBe(404)
  })

  it('POST trim 409s on an active (registered) run', async () => {
    writeManifestForRun('r-active', 'foo', 'running')
    writeRunsIndex(logsDir, [{ runId: 'r-active', feature: 'foo', startedAt: 'now', status: 'running' }])
    const { app, registry } = await build()
    registry.set('r-active', makeStub('r-active'))
    const res = await app.inject({ method: 'POST', url: '/api/runs/r-active/trim' })
    expect(res.statusCode).toBe(409)
  })
})
