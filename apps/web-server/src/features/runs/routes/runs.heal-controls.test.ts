import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import type { ExternalHealAgentRequest } from './runs-route-support'
import type { OrchestratorLike } from '../logic/run-registry'
import { launchEditorDir } from '../../../shared/editor-launch'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { buildRunsApp, type RunsAppOptions } from './__fixtures__/runs-app'
import { SERVER_EXITED_MESSAGE } from '../logic/run-store'
import { writeManifest, writeRunsIndex } from '../logic/runtime/manifest'
import { runDirFor } from '../logic/runtime/run-paths'
import { HEARTBEAT_STALE_MS } from '../../../../../../shared/run-state'

const tempDir = trackTempDirs('cl-rroutes-')


vi.mock('../../../shared/editor-launch', async () => (await import('../../../shared/__fixtures__/editor-launch')).editorLaunchMock())

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
  tmpDir = tempDir()
  logsDir = path.join(tmpDir, 'logs')
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featuresDir, { recursive: true })
})

const build = (opts: RunsAppOptions = {}) => buildRunsApp({ logsDir, featuresDir }, opts)

/** A healing run whose server stopped long enough ago that its heartbeat is stale:
 *  persisted, unregistered, and driven by nothing. */
function seedOrphanedHealingRun(runId: string): void {
  const dir = runDirFor(logsDir, runId)
  fs.mkdirSync(dir, { recursive: true })
  const startedAt = '2026-10-09T05:59:00.000Z'
  writeManifest(path.join(dir, 'manifest.json'), {
    runId, feature: 'storefront-journey', startedAt, status: 'healing', healCycles: 1, services: [],
    heartbeatAt: new Date(Date.now() - HEARTBEAT_STALE_MS - 1_000).toISOString(),
  })
  writeRunsIndex(logsDir, [{ runId, feature: 'storefront-journey', startedAt, status: 'healing' }])
}

describe('POST /api/runs/:runId/pause-heal', () => {
  it('404s when run not in registry', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs/ghost/pause-heal' })
    expect(res.statusCode).toBe(404)
  })

  it('settles a run whose server exited and refuses to pause it, saying why', async () => {
    seedOrphanedHealingRun('orphan')
    const { app, store } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs/orphan/pause-heal' })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ reason: 'server-exited', status: 'aborted', error: SERVER_EXITED_MESSAGE })
    expect(store.get('orphan')?.manifest.status).toBe('aborted')
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

  it('Stop Heal on a run whose server exited settles it aborted instead of 404ing', async () => {
    // The live report: Stop Heal answered `run not active` while the run stayed healing.
    seedOrphanedHealingRun('orphan')
    const { app, store } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs/orphan/cancel-heal' })
    expect(res.statusCode).toBe(202)
    expect(res.json()).toEqual({ status: 'aborted', reason: 'server-exited' })
    expect(store.get('orphan')?.manifest).toMatchObject({ status: 'aborted', lifecycle: { abortReason: { reason: 'server-exited' } } })
    expect(store.list()[0].status).toBe('aborted')
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
