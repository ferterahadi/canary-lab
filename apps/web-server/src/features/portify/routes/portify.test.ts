import { afterEach, describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { portifyRoutes, type PortifyRouteDeps } from '../../portify/routes/portify'
import type { PortifyStore } from '../../portify/logic/runtime/store'
import type { PortifyManifest } from '../../portify/logic/runtime/types'
import { launchEditorDir } from '../../../shared/editor-launch'

vi.mock('../../../shared/editor-launch', () => ({ launchEditorDir: vi.fn(() => 'vscode') }))

function manifest(over: Partial<PortifyManifest> = {}): PortifyManifest {
  return {
    workflowId: 'portify-1',
    feature: 'cns',
    featureDir: '/f/cns',
    repos: [{ name: 'my-backend', path: '~/my-backend' }],
    agent: 'claude',
    branch: 'canary/dynamic-ports-cns',
    status: 'ready-to-save',
    attempt: 1,
    maxAttempts: 3,
    startedAt: '2026-06-07T00:00:00.000Z',
    ...over,
  }
}

function fakeStore(over: Partial<PortifyStore> = {}): PortifyStore {
  return {
    list: () => [],
    get: () => null,
    save: () => {},
    remove: () => {},
    onEvent: () => {},
    offEvent: () => {},
    ...over,
  }
}

async function buildApp(deps: Partial<PortifyRouteDeps>) {
  const app = Fastify()
  await app.register(portifyRoutes, {
    store: deps.store ?? fakeStore(),
    startPortify: deps.startPortify ?? (async () => ({ workflowId: 'portify-1' })),
    savePortify: deps.savePortify ?? (async () => manifest({ status: 'saved' })),
    cancelPortify: deps.cancelPortify ?? (async () => manifest({ status: 'aborted' })),
    revisePortify: deps.revisePortify ?? (async () => manifest({ status: 'editing', feedbackRounds: 1 })),
    removePortify: deps.removePortify ?? (async (workflowId) => ({ workflowId, removed: true as const })),
    loadAgentSession: deps.loadAgentSession ?? (() => null),
    ...(deps.projectRoot !== undefined ? { projectRoot: deps.projectRoot } : {}),
  })
  return app
}

let apps: Array<{ close: () => Promise<void> }> = []
afterEach(async () => { await Promise.all(apps.map((a) => a.close())); apps = [] })
async function build(deps: Partial<PortifyRouteDeps>) { const a = await buildApp(deps); apps.push(a); return a }

describe('portifyRoutes', () => {
  it('POST /api/portify starts a workflow and returns its id', async () => {
    let received: unknown
    const app = await build({ startPortify: async (input) => { received = input; return { workflowId: 'portify-abc' } } })
    const res = await app.inject({ method: 'POST', url: '/api/portify', payload: { feature: 'cns', agent: 'claude' } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ workflowId: 'portify-abc' })
    expect(received).toMatchObject({ feature: 'cns', agent: 'claude' })
  })

  it('POST /api/portify 400s when feature is missing', async () => {
    const app = await build({})
    const res = await app.inject({ method: 'POST', url: '/api/portify', payload: { agent: 'claude' } })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/portify normalizes agent + maxAttempts (codex / omitted / numeric)', async () => {
    const seen: unknown[] = []
    const app = await build({ startPortify: async (input) => { seen.push(input); return { workflowId: 'w' } } })
    await app.inject({ method: 'POST', url: '/api/portify', payload: { feature: 'cns', agent: 'codex', maxAttempts: 5 } })
    await app.inject({ method: 'POST', url: '/api/portify', payload: { feature: 'cns', agent: 'weird' } })
    await app.inject({ method: 'POST', url: '/api/portify', payload: { feature: 'cns' } })
    expect(seen).toEqual([
      { feature: 'cns', agent: 'codex', maxAttempts: 5 },
      { feature: 'cns', agent: undefined, maxAttempts: undefined },
      { feature: 'cns', agent: undefined, maxAttempts: undefined },
    ])
  })

  it('POST /api/portify surfaces the runner statusCode (e.g. 409 already running)', async () => {
    const app = await build({
      startPortify: async () => { throw Object.assign(new Error('already running'), { statusCode: 409 }) },
    })
    const res = await app.inject({ method: 'POST', url: '/api/portify', payload: { feature: 'cns' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ error: 'already running' })
  })

  it('GET /api/portify/:id returns the manifest, 404 when missing', async () => {
    const found = await build({ store: fakeStore({ get: () => manifest() }) })
    const ok = await found.inject({ method: 'GET', url: '/api/portify/portify-1' })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toMatchObject({ workflowId: 'portify-1', status: 'ready-to-save' })

    const missing = await build({ store: fakeStore({ get: () => null }) })
    const res = await missing.inject({ method: 'GET', url: '/api/portify/nope' })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/portify lists workflows', async () => {
    const app = await build({ store: fakeStore({ list: () => [{ workflowId: 'portify-1', feature: 'cns', status: 'saved', startedAt: 'x' }] }) })
    const res = await app.inject({ method: 'GET', url: '/api/portify' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(1)
  })

  it('POST /api/portify/:id/save delegates to the runner', async () => {
    let saved: string | undefined
    const app = await build({ savePortify: async (id) => { saved = id; return manifest({ status: 'saved' }) } })
    const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/save' })
    expect(res.statusCode).toBe(200)
    expect(saved).toBe('portify-1')
    expect(res.json()).toMatchObject({ status: 'saved' })
  })

  it('POST /api/portify/:id/save surfaces a 409 when not ready', async () => {
    const app = await build({
      savePortify: async () => { throw Object.assign(new Error('cannot save a workflow in status "editing"'), { statusCode: 409 }) },
    })
    const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/save' })
    expect(res.statusCode).toBe(409)
  })

  it('POST /api/portify/:id/cancel delegates to the runner', async () => {
    let cancelled: string | undefined
    const app = await build({ cancelPortify: async (id) => { cancelled = id; return manifest({ status: 'aborted' }) } })
    const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/cancel' })
    expect(res.statusCode).toBe(200)
    expect(cancelled).toBe('portify-1')
  })

  it('POST /api/portify/:id/revise delegates feedback to the runner', async () => {
    let seen: { id?: string; feedback?: string } = {}
    const app = await build({
      revisePortify: async (id, feedback) => { seen = { id, feedback }; return manifest({ status: 'editing', feedbackRounds: 1 }) },
    })
    const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/revise', payload: { feedback: '  use PORT  ' } })
    expect(res.statusCode).toBe(200)
    expect(seen).toEqual({ id: 'portify-1', feedback: 'use PORT' }) // trimmed
    expect(res.json()).toMatchObject({ status: 'editing', feedbackRounds: 1 })
  })

  it('POST /api/portify/:id/revise 400s on empty/whitespace feedback', async () => {
    const app = await build({})
    expect((await app.inject({ method: 'POST', url: '/api/portify/portify-1/revise', payload: {} })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/portify/portify-1/revise', payload: { feedback: '   ' } })).statusCode).toBe(400)
  })

  it('POST /api/portify/:id/revise surfaces the runner statusCode (409 wrong status)', async () => {
    const app = await build({
      revisePortify: async () => { throw Object.assign(new Error('cannot revise a workflow in status "editing"'), { statusCode: 409 }) },
    })
    const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/revise', payload: { feedback: 'x' } })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toContain('cannot revise')
  })

  it('DELETE /api/portify/:id removes a finished workflow', async () => {
    let removed: string | undefined
    const app = await build({ removePortify: async (id) => { removed = id; return { workflowId: id, removed: true } } })
    const res = await app.inject({ method: 'DELETE', url: '/api/portify/portify-1' })
    expect(res.statusCode).toBe(200)
    expect(removed).toBe('portify-1')
    expect(res.json()).toMatchObject({ workflowId: 'portify-1', removed: true })
  })

  it('DELETE /api/portify/:id surfaces a 409 for a non-terminal workflow', async () => {
    const app = await build({
      removePortify: async () => { throw Object.assign(new Error('cannot remove a workflow in status "editing" — commit or cancel it first'), { statusCode: 409 }) },
    })
    const res = await app.inject({ method: 'DELETE', url: '/api/portify/portify-1' })
    expect(res.statusCode).toBe(409)
    expect((res.json() as { error: string }).error).toContain('cannot remove')
  })

  it('POST /api/portify defaults to 500 for an error without a statusCode', async () => {
    const app = await build({ startPortify: async () => { throw new Error('disk full') } })
    const res = await app.inject({ method: 'POST', url: '/api/portify', payload: { feature: 'cns' } })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toMatchObject({ error: 'disk full' })
  })

  it('POST /api/portify 400s with no body at all', async () => {
    const app = await build({})
    const res = await app.inject({ method: 'POST', url: '/api/portify' })
    expect(res.statusCode).toBe(400)
  })

  it('POST /api/portify/:id/save defaults to 500 for a non-statusCode error', async () => {
    const app = await build({ savePortify: async () => { throw new Error('disk exploded') } })
    const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/save' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toMatchObject({ error: 'disk exploded' })
  })

  it('POST /api/portify/:id/cancel surfaces runner errors', async () => {
    const app = await build({
      cancelPortify: async () => { throw Object.assign(new Error('nope'), { statusCode: 404 }) },
    })
    const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/cancel' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'nope' })
  })

  it('POST /api/portify/:id/cancel defaults to 500 for a non-statusCode error', async () => {
    const app = await build({ cancelPortify: async () => { throw new Error('teardown blew up') } })
    const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/cancel' })
    expect(res.statusCode).toBe(500)
  })

  it('stringifies a non-Error throw across start/save/cancel', async () => {
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    const startApp = await build({ startPortify: async () => { throw 'raw start failure' } })
    const s = await startApp.inject({ method: 'POST', url: '/api/portify', payload: { feature: 'cns' } })
    expect(s.statusCode).toBe(500)
    expect(s.json()).toMatchObject({ error: 'raw start failure' })

    // eslint-disable-next-line @typescript-eslint/only-throw-error
    const saveApp = await build({ savePortify: async () => { throw 'raw save failure' } })
    expect((await saveApp.inject({ method: 'POST', url: '/api/portify/w/save' })).json()).toMatchObject({ error: 'raw save failure' })

    // eslint-disable-next-line @typescript-eslint/only-throw-error
    const cancelApp = await build({ cancelPortify: async () => { throw 'raw cancel failure' } })
    expect((await cancelApp.inject({ method: 'POST', url: '/api/portify/w/cancel' })).json()).toMatchObject({ error: 'raw cancel failure' })
  })

  it('DELETE /api/portify/:id defaults to 500 and stringifies a non-Error throw', async () => {
    const app500 = await build({ removePortify: async () => { throw new Error('history corrupt') } })
    const r500 = await app500.inject({ method: 'DELETE', url: '/api/portify/w' })
    expect(r500.statusCode).toBe(500)
    expect(r500.json()).toMatchObject({ error: 'history corrupt' })

    // eslint-disable-next-line @typescript-eslint/only-throw-error
    const appRaw = await build({ removePortify: async () => { throw 'raw remove failure' } })
    const rRaw = await appRaw.inject({ method: 'DELETE', url: '/api/portify/w' })
    expect(rRaw.statusCode).toBe(500)
    expect(rRaw.json()).toMatchObject({ error: 'raw remove failure' })
  })

  it('POST /api/portify/:id/revise defaults to 500 and stringifies a non-Error throw', async () => {
    const app500 = await build({ revisePortify: async () => { throw new Error('worktree gone') } })
    const r500 = await app500.inject({ method: 'POST', url: '/api/portify/w/revise', payload: { feedback: 'x' } })
    expect(r500.statusCode).toBe(500)
    expect(r500.json()).toMatchObject({ error: 'worktree gone' })

    // eslint-disable-next-line @typescript-eslint/only-throw-error
    const appRaw = await build({ revisePortify: async () => { throw 'raw revise failure' } })
    const rRaw = await appRaw.inject({ method: 'POST', url: '/api/portify/w/revise', payload: { feedback: 'x' } })
    expect(rRaw.statusCode).toBe(500)
    expect(rRaw.json()).toMatchObject({ error: 'raw revise failure' })
  })

  it('GET /api/portify/:id/agent-session returns the session when present', async () => {
    const app = await build({ loadAgentSession: () => ({ agent: 'claude', sessionId: 's', events: [] }) })
    const res = await app.inject({ method: 'GET', url: '/api/portify/portify-1/agent-session' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ agent: 'claude', sessionId: 's' })
  })

  it('GET /api/portify/:id/agent-session 404s when no session', async () => {
    const app = await build({ loadAgentSession: () => null })
    const res = await app.inject({ method: 'GET', url: '/api/portify/portify-1/agent-session' })
    expect(res.statusCode).toBe(404)
  })

  describe('POST /api/portify/:id/open', () => {
    afterEach(() => vi.mocked(launchEditorDir).mockClear())

    it('404s when the workflow is unknown', async () => {
      const app = await build({ store: fakeStore({ get: () => null }) })
      const res = await app.inject({ method: 'POST', url: '/api/portify/nope/open' })
      expect(res.statusCode).toBe(404)
    })

    it('opens the scratch worktree while it exists', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-open-'))
      const wt = path.join(tmp, 'wt'); fs.mkdirSync(wt)
      const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo)
      const m = manifest({ repos: [{ name: 'app', path: repo, worktreePath: wt }] })
      const app = await build({ store: fakeStore({ get: () => m }) })
      const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/open' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ opened: true, paths: [wt], editor: 'vscode' })
      expect(vi.mocked(launchEditorDir)).toHaveBeenCalledWith('auto', wt)
      fs.rmSync(tmp, { recursive: true, force: true })
    })

    it('falls back to the product repo once the worktree is gone (saved)', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-open-'))
      const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo)
      // worktreePath points at a now-deleted dir (post-save) → falls back to path.
      const m = manifest({ status: 'saved', repos: [{ name: 'app', path: repo, worktreePath: path.join(tmp, 'gone') }] })
      const app = await build({ store: fakeStore({ get: () => m }) })
      const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/open' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ opened: true, paths: [repo] })
      expect(vi.mocked(launchEditorDir)).toHaveBeenCalledWith('auto', repo)
      fs.rmSync(tmp, { recursive: true, force: true })
    })

    it('409s when no directory is available to open', async () => {
      const m = manifest({ repos: [{ name: 'app', path: '/no/such/repo' }] })
      const app = await build({ store: fakeStore({ get: () => m }) })
      const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/open' })
      expect(res.statusCode).toBe(409)
    })

    it('reports opened:false with the path when the launch throws', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-open-'))
      const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo)
      vi.mocked(launchEditorDir).mockImplementationOnce(() => { throw new Error('no editor') })
      const m = manifest({ repos: [{ name: 'app', path: repo }] })
      const app = await build({ store: fakeStore({ get: () => m }) })
      const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/open' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ opened: false, paths: [repo], error: 'no editor' })
      fs.rmSync(tmp, { recursive: true, force: true })
    })

    it('uses loadProjectConfig when projectRoot is set (line 86 true branch)', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-open-root-'))
      const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo)
      const m = manifest({ repos: [{ name: 'app', path: repo }] })
      const app = await build({ store: fakeStore({ get: () => m }), projectRoot: tmp })
      const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/open' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ opened: true, paths: [repo] })
      fs.rmSync(tmp, { recursive: true, force: true })
    })

    it('uses String(err) when the throw is not an Error instance (line 93 false branch)', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'portify-open-nonerr-'))
      const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo)
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      vi.mocked(launchEditorDir).mockImplementationOnce(() => { throw 'editor not found' })
      const m = manifest({ repos: [{ name: 'app', path: repo }] })
      const app = await build({ store: fakeStore({ get: () => m }) })
      const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/open' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ opened: false, paths: [repo], error: 'editor not found' })
      fs.rmSync(tmp, { recursive: true, force: true })
    })
  })
})
