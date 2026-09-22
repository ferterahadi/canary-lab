import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runsRoutes } from './runs'
import { createRegistry, RunStore, type OrchestratorLike } from '../logic/run-store'
import { assertNoPendingRunReview } from '../logic/runtime/run-review-gate'
import type { RunsRouteDeps } from './runs-route-deps'
import type { RunStartRequest, TestReviewRequiredInfo } from '../../../../../../shared/test-review'
import type { WorkspaceEvent } from '../../../shared/workspace-events'
import { RunStartRequests } from '../logic/run-start-requests'

const apps: FastifyInstance[] = []
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const app of apps.splice(0)) await app.close()
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-run-request-'))
  roots.push(root)
  const featuresDir = path.join(root, 'features')
  const featureDir = path.join(featuresDir, 'checkout')
  const logsDir = path.join(root, 'logs')
  const snapshot = path.join(logsDir, 'runs', 'source', 'suite')
  fs.mkdirSync(path.join(featureDir, 'e2e'), { recursive: true })
  fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'), "module.exports={config:{name:'checkout',description:'test',featureDir:__dirname,envs:['dev']}}")
  fs.writeFileSync(path.join(featureDir, 'e2e/a.spec.ts'), 'recorded\n')
  fs.cpSync(featureDir, snapshot, { recursive: true })
  const git = (...args: string[]) => execFileSync('git', args, { cwd: featureDir, stdio: 'pipe' })
  git('init', '-q')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Canary Test')
  git('add', '.')
  git('commit', '-qm', 'initial')
  fs.writeFileSync(path.join(featureDir, 'e2e/a.spec.ts'), 'candidate\n')
  const store = new RunStore(logsDir, createRegistry())
  store.bootstrap({ runId: 'source', feature: 'checkout', featureDir, env: 'dev', startedAt: '2026-01-01',
    status: 'aborted', services: [], healCycles: 0,
    suiteSnapshot: { kind: 'taken', dir: snapshot, takenAt: '2026-01-01', digest: 'initial' },
    specEdits: { checkedAt: 'now', pending: [{ file: 'e2e/a.spec.ts', change: 'modified', affectedTests: [] }], adopted: [] },
  })
  const starts: Parameters<RunsRouteDeps['startRun']>[] = []
  const startRun: RunsRouteDeps['startRun'] = async (...args) => {
    assertNoPendingRunReview(store, 'checkout', featureDir)
    starts.push(args)
    const runId = args[8]?.runId ?? `started-${starts.length}`
    store.bootstrap({ runId, feature: 'checkout', featureDir, env: args[1], startedAt: new Date().toISOString(), status: 'running', services: [], healCycles: 0 })
    return { kind: 'started', orch: { runId, stop: async () => {} } as OrchestratorLike }
  }
  const events: WorkspaceEvent[] = []
  const app = Fastify()
  apps.push(app)
  await app.register(runsRoutes, { featuresDir, store, startRun, workspaceEvents: { publish: (event) => events.push(event) } })
  const begin = async (payload: Record<string, unknown> = {}) => {
    const result = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'checkout', env: 'dev', ...payload } })
    expect(result.statusCode).toBe(409)
    return result.json<TestReviewRequiredInfo & { request: RunStartRequest }>()
  }
  const read = async (id: string) => (await app.inject(`/api/run-requests/${id}`)).json<RunStartRequest>()
  const decide = (revision: string, action = 'accept-test-review') => app.inject({ method: 'POST', url: `/api/runs/source/${action}`, payload: { expectedRevision: revision } })
  return { app, store, root, logsDir, featureDir, snapshot, starts, events, begin, read, decide }
}

describe('blocked run request ownership', () => {
  it('does not create a second request while resuming an already reserved run id', async () => {
    const { app } = await fixture()
    vi.spyOn(RunStartRequests.prototype, 'allocatedRunId').mockReturnValue('reserved-run')

    const response = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'checkout', env: 'dev', resumeRequestId: 'request-1' } })

    expect(response.statusCode).toBe(409)
    expect(response.json()).toMatchObject({ type: 'test_review_required' })
    expect(response.json()).not.toHaveProperty('request')
  })

  it('reports missing request reads and actions without creating a run', async () => {
    const { app, starts } = await fixture()
    expect((await app.inject('/api/run-requests/missing')).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/run-requests/missing/resume' })).statusCode).toBe(404)
    expect(starts).toHaveLength(0)
  })

  it('does not reconcile after server shutdown, including an already scheduled startup recovery', async () => {
    vi.useFakeTimers()
    const { app, starts } = await fixture()
    await app.ready()
    await app.close()
    await vi.runAllTimersAsync()
    expect(starts).toHaveLength(0)
  })

  it('reports unexpected dispatcher persistence failures without an unhandled background rejection', async () => {
    const { app, begin, decide } = await fixture()
    const blocked = await begin()
    const error = vi.spyOn(app.log, 'error')
    vi.spyOn(RunStartRequests.prototype, 'resume').mockRejectedValue(new Error('request store unavailable'))
    await decide(blocked.review_revision)
    await vi.waitFor(() => expect(error).toHaveBeenCalled())
  })
  it('persists an internal request and automatically starts its original options once after browser approval', async () => {
    const { begin, read, decide, starts, events } = await fixture()
    const models = { heal: { model: 'test-model' } }
    const blocked = await begin({ isolation: 'worktree', models, updateRepos: false })
    expect(blocked).toMatchObject({ type: 'test_review_required', changedFileCount: 1, reviewUrl: expect.stringContaining('reviewBase=run'), request: { owner: { kind: 'internal' }, status: 'awaiting-review' } })
    expect(starts).toHaveLength(0)
    expect((await decide(blocked.review_revision)).statusCode).toBe(202)
    await vi.waitFor(async () => expect(await read(blocked.request.requestId)).toMatchObject({ status: 'started', runId: expect.any(String) }))
    expect(starts).toHaveLength(1)
    expect(starts[0]).toMatchObject(['checkout', 'dev', undefined, 'worktree', 'run', models, undefined, undefined, { updateRepos: false, runId: expect.any(String) }])
    expect(events.some((event) => event.type === 'tests-changed')).toBe(true)
  })

  it('keeps external requests ready until the same external session resumes, and deduplicates concurrent resumes', async () => {
    const { app, begin, read, decide, starts } = await fixture()
    const healAgent = { kind: 'external', sessionId: 'external-session', clientKind: 'codex', claimable: true, conversationName: 'Checkout repair' }
    const blocked = await begin({ healAgent, isolation: 'queue', updateRepos: false })
    expect((await begin({ healAgent, isolation: 'queue', updateRepos: false })).request.requestId).toBe(blocked.request.requestId)
    await decide(blocked.review_revision)
    expect(await read(blocked.request.requestId)).toMatchObject({ status: 'ready', owner: { kind: 'external', sessionId: 'external-session' } })
    expect(starts).toHaveLength(0)
    const url = `/api/run-requests/${blocked.request.requestId}/resume`
    expect((await app.inject({ method: 'POST', url })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url, headers: { 'x-canary-origin': 'mcp' }, payload: { sessionId: 'another-session' } })).statusCode).toBe(409)
    const invoke = () => app.inject({ method: 'POST' as const, url, headers: { 'x-canary-origin': 'mcp' }, payload: { sessionId: 'external-session' } })
    const [first, second] = await Promise.all([invoke(), invoke()])
    expect(first.json().runId).toBe(second.json().runId)
    expect((await invoke()).json().runId).toBe(first.json().runId)
    expect(starts).toHaveLength(1)
    expect(starts[0][2]).toEqual(healAgent)
    expect(starts[0][3]).toBe('queue')
  })

  it('cancels execution intent without cancelling the shared review', async () => {
    const { app, begin, read, decide, starts, store } = await fixture()
    const blocked = await begin()
    const cancel = await app.inject({ method: 'POST', url: `/api/run-requests/${blocked.request.requestId}/cancel` })
    expect(cancel.json()).toMatchObject({ status: 'cancelled' })
    await decide(blocked.review_revision)
    expect(await read(blocked.request.requestId)).toMatchObject({ status: 'cancelled' })
    expect(store.get('source')?.manifest.specEdits?.reviewDecisions).toHaveLength(1)
    expect(starts).toHaveLength(0)
  })

  it('resumes a new-run request after restoration while leaving historical execution unchanged', async () => {
    const { begin, read, decide, starts, store, featureDir } = await fixture()
    const blocked = await begin()
    expect((await decide(blocked.review_revision, 'restore-spec-edits')).statusCode).toBe(200)
    await vi.waitFor(async () => expect(await read(blocked.request.requestId)).toMatchObject({ status: 'started' }))
    expect(fs.readFileSync(path.join(featureDir, 'e2e/a.spec.ts'), 'utf8')).toBe('recorded\n')
    expect(store.get('source')?.manifest.status).toBe('aborted')
    expect(starts).toHaveLength(1)
  })

  it('follows a superseding review revision and cannot resume from the stale question', async () => {
    const { begin, read, decide, starts, featureDir } = await fixture()
    const blocked = await begin()
    fs.appendFileSync(path.join(featureDir, 'e2e/a.spec.ts'), 'new change\n')
    const current = await read(blocked.request.requestId)
    expect(current.review.revision).not.toBe(blocked.review_revision)
    expect((await decide(blocked.review_revision)).statusCode).toBe(409)
    expect(starts).toHaveLength(0)
    expect((await decide(current.review.revision)).statusCode).toBe(202)
    await vi.waitFor(async () => expect(await read(blocked.request.requestId)).toMatchObject({ status: 'started' }))
  })

  it('recovers when a newer revision is restored before the pending request observes it', async () => {
    const { app, begin, read, decide, starts, featureDir } = await fixture()
    const blocked = await begin()
    fs.appendFileSync(path.join(featureDir, 'e2e/a.spec.ts'), 'new change\n')
    const current = (await app.inject('/api/runs/source/test-review')).json()
    expect(current.review_revision).not.toBe(blocked.review_revision)
    expect((await decide(current.review_revision, 'restore-spec-edits')).statusCode).toBe(200)
    await vi.waitFor(async () => expect(await read(blocked.request.requestId)).toMatchObject({ status: 'started', review: { revision: current.review_revision } }))
    expect(starts).toHaveLength(1)
  })

  it('serializes competing accept and restore operations into one decision', async () => {
    const { begin, decide, store, featureDir } = await fixture()
    const blocked = await begin({ healAgent: { kind: 'external', sessionId: 'external-session', clientKind: 'codex' } })
    const [accepted, restored] = await Promise.all([decide(blocked.review_revision), decide(blocked.review_revision, 'restore-spec-edits')])
    expect(accepted.statusCode).toBe(202)
    expect(restored.statusCode).toBe(409)
    expect(store.get('source')?.manifest.specEdits?.reviewDecisions).toHaveLength(1)
    expect(fs.readFileSync(path.join(featureDir, 'e2e/a.spec.ts'), 'utf8')).toBe('candidate\n')
    expect((await decide(blocked.review_revision)).json()).toEqual(accepted.json())
  })
})
