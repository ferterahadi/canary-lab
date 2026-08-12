import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// A pass-through `vi.mock` for `../logic/draft-agent-session` used to sit here,
// with a one-shot override for the route's TOCTOU guard. Both the module and the
// route that used it went with the Add Test wizard, and no case installed the
// override any more — the mock was targeting a path that no longer exists, which
// vitest tolerates silently because nothing imports it.

import { bridgeDraftEvents, createDraft, paths as draftPaths, readDraft, writeDraft, type DraftRecord } from '../logic/draft-store'
import { resetSharedTaskStores } from '../../../../../../shared/lib/file-backed-task-store'
import { testsDraftRoutes, type TestsDraftRouteDeps } from './tests-draft'

// These routes are the READ/TRACK surface for drafts an external MCP client
// authors (start_external_draft & friends). Canary spawns no local authoring
// agent, so there is nothing here that starts a stage or accepts its output.

let logsDir: string
let projectRoot: string

beforeEach(() => {
  // The draft store is memoized per logs dir; each case gets a fresh dir, and
  // dropping the memo keeps a previous case's bridge from listening in.
  resetSharedTaskStores()
  logsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-draft-logs-'))
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tests-draft-proj-'))
})

afterEach(() => {
  fs.rmSync(logsDir, { recursive: true, force: true })
  fs.rmSync(projectRoot, { recursive: true, force: true })
})

function makeDeps(overrides: Partial<TestsDraftRouteDeps> = {}): TestsDraftRouteDeps {
  return { logsDir, projectRoot, ...overrides }
}

async function makeApp(deps: TestsDraftRouteDeps): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify()
  // A draft write announces itself from the STORE now (bridgeDraftEvents,
  // wired once at boot in server.ts), not from these handlers — so the app
  // under test gets the same bridge the server gives it. Without it these
  // routes are silent, which is the point: the emission is not theirs.
  bridgeDraftEvents(deps.logsDir, deps.workspaceEvents)
  await testsDraftRoutes(app, deps)
  return app
}

/** An external-producer draft, as start_external_draft would have written it. */
function seedExternalDraft(id = 'd-1', patch: Partial<DraftRecord> = {}): DraftRecord {
  const record = createDraft(logsDir, {
    draftId: id,
    prdText: 'External client is authoring tests for checkout.',
    prdDocuments: [],
    repos: [{ name: 'app', localPath: '/tmp/app' }],
    featureName: 'checkout',
    producer: 'external',
    externalStage: 'authoring-tests',
    externalClientKind: 'claude',
    externalSessionId: 's-1',
  })
  const next: DraftRecord = { ...record, status: 'generating', ...patch }
  writeDraft(logsDir, next)
  return next
}

describe('GET /api/tests/draft', () => {
  it('lists the drafts on file', async () => {
    seedExternalDraft('d-1')
    seedExternalDraft('d-2')
    const app = await makeApp(makeDeps())
    const res = await app.inject({ method: 'GET', url: '/api/tests/draft' })
    expect(res.statusCode).toBe(200)
    expect((res.json() as DraftRecord[]).map((d) => d.draftId).sort()).toEqual(['d-1', 'd-2'])
  })

  it('returns the stored record as-is, with no agent-log tails', async () => {
    seedExternalDraft('d-1')
    const app = await makeApp(makeDeps())
    const res = await app.inject({ method: 'GET', url: '/api/tests/draft/d-1' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body.draftId).toBe('d-1')
    expect(body.externalStage).toBe('authoring-tests')
    // The tails came from LOCAL stage-agent logs, which no longer exist.
    expect(body).not.toHaveProperty('planAgentLogTail')
    expect(body).not.toHaveProperty('specAgentLogTail')
  })

  it('404s an unknown draft', async () => {
    const app = await makeApp(makeDeps())
    const res = await app.inject({ method: 'GET', url: '/api/tests/draft/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'draft not found' })
  })
})

describe('POST /api/tests/draft/:id/cancel-generation', () => {
  it('settles the record of an in-flight external session', async () => {
    seedExternalDraft('d-1')
    const events: unknown[] = []
    const app = await makeApp(makeDeps({ workspaceEvents: { publish: (e) => events.push(e) } }))
    const res = await app.inject({ method: 'POST', url: '/api/tests/draft/d-1/cancel-generation' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ draftId: 'd-1', status: 'cancelled' })

    const rec = readDraft(logsDir, 'd-1')!
    expect(rec.status).toBe('cancelled')
    expect(rec.activeAgentStage).toBeUndefined()
    expect(rec.errorMessage).toBe('Generation cancelled by user')
    expect(events).toContainEqual(expect.objectContaining({ type: 'draft-updated' }))
  })

  it('409s a draft that is not mid-generation', async () => {
    seedExternalDraft('d-1', { status: 'spec-ready' })
    const app = await makeApp(makeDeps())
    const res = await app.inject({ method: 'POST', url: '/api/tests/draft/d-1/cancel-generation' })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toMatch(/cannot cancel-generation from status spec-ready/)
  })

  it('404s an unknown draft', async () => {
    const app = await makeApp(makeDeps())
    const res = await app.inject({ method: 'POST', url: '/api/tests/draft/nope/cancel-generation' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'draft not found' })
  })
})

describe('DELETE /api/tests/draft/:id', () => {
  it('removes the record and announces it', async () => {
    seedExternalDraft('d-1')
    const events: unknown[] = []
    const app = await makeApp(makeDeps({ workspaceEvents: { publish: (e) => events.push(e) } }))
    const res = await app.inject({ method: 'DELETE', url: '/api/tests/draft/d-1' })
    expect(res.statusCode).toBe(204)
    expect(readDraft(logsDir, 'd-1')).toBeNull()
    expect(events).toContainEqual({ type: 'draft-deleted', draftId: 'd-1' })
  })

  it('404s an unknown draft', async () => {
    const app = await makeApp(makeDeps())
    const res = await app.inject({ method: 'DELETE', url: '/api/tests/draft/nope' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: 'draft not found' })
  })
})
