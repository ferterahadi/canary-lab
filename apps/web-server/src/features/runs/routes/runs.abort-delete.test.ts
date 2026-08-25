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
    expect(res.json()).toEqual({ error: 'run is still active; abort it first' })
  })

  it('POST trim defaults freedBytes to 0 when the store result omits it', async () => {
    // TrimResult.freedBytes is typed optional ("present when ok") — this
    // exercises the route's own `?? 0` fallback for that documented-but-
    // never-actually-omitted-by-the-real-store case.
    writeManifestForRun('r-trim-nofreed', 'foo', 'passed')
    writeRunsIndex(logsDir, [{ runId: 'r-trim-nofreed', feature: 'foo', startedAt: 'now', status: 'passed' }])
    const { app, store } = await build()
    vi.spyOn(store, 'trimArtifacts').mockReturnValue({ ok: true })
    const res = await app.inject({ method: 'POST', url: '/api/runs/r-trim-nofreed/trim' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ freedBytes: 0 })
  })

  it('POST trim 409s with the stale-active message when the manifest is active but no orchestrator is registered', async () => {
    // Same "orphaned active manifest" situation exercised for DELETE — no
    // registry entry, but the persisted status is still active.
    writeManifestForRun('r-stale', 'foo', 'running')
    writeRunsIndex(logsDir, [{ runId: 'r-stale', feature: 'foo', startedAt: 'now', status: 'running' }])
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs/r-stale/trim' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'run is still active; reap or abort first' })
  })
})

describe('GET /api/runs/:runId/verification-report', () => {
  it('404s when the run is unknown', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/ghost/verification-report' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'run not found' })
  })

  it('409s when the run is not a verification execution (defaults executionType to "run")', async () => {
    // No executionType field at all on the manifest — exercises the `??
    // 'run'` default explicitly, distinct from a manifest that sets it.
    writeManifestForRun('r1')
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/verification-report' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'run is not a verification execution' })
  })

  it('200s with verification:null when a verify execution has no verification field yet', async () => {
    // Exercises the `?? null` fallback distinct from the "populated" case
    // below — a verify execution whose manifest hasn't had `verification`
    // attached yet (e.g. very early in the run).
    const dir = runDirFor(logsDir, 'r-verify-empty')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'r-verify-empty',
      feature: 'foo',
      startedAt: 'now',
      status: 'running',
      healCycles: 0,
      services: [],
      executionType: 'verify',
    })
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r-verify-empty/verification-report' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      runId: 'r-verify-empty',
      executionType: 'verify',
      status: 'running',
      verification: null,
    })
  })

  it('200s with the verification payload for a verify execution', async () => {
    const dir = runDirFor(logsDir, 'r-verify')
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'r-verify',
      feature: 'foo',
      startedAt: 'now',
      status: 'passed',
      healCycles: 0,
      services: [],
      executionType: 'verify',
      verification: {
        playwrightEnvsetId: 'envset-1',
        targetUrls: { web: 'https://example.test' },
        targets: [],
      },
    })
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r-verify/verification-report' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      runId: 'r-verify',
      executionType: 'verify',
      status: 'passed',
      verification: {
        playwrightEnvsetId: 'envset-1',
        targetUrls: { web: 'https://example.test' },
        targets: [],
      },
    })
  })
})
