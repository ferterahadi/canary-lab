import { afterEach, describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { portifyRoutes, type PortifyRouteDeps } from './portify'
import type { PortifyStore } from '../lib/runtime/portify/store'
import type { PortifyManifest } from '../lib/runtime/portify/types'

function manifest(over: Partial<PortifyManifest> = {}): PortifyManifest {
  return {
    workflowId: 'portify-1',
    feature: 'cns',
    featureDir: '/f/cns',
    repos: [{ name: 'mighty-cns', path: '~/mighty-cns' }],
    agent: 'claude',
    branch: 'canary/dynamic-ports-cns',
    status: 'ready-to-commit',
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
    commitPortify: deps.commitPortify ?? (async () => manifest({ status: 'committed' })),
    cancelPortify: deps.cancelPortify ?? (async () => manifest({ status: 'aborted' })),
    loadAgentSession: deps.loadAgentSession ?? (() => null),
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
    expect(ok.json()).toMatchObject({ workflowId: 'portify-1', status: 'ready-to-commit' })

    const missing = await build({ store: fakeStore({ get: () => null }) })
    const res = await missing.inject({ method: 'GET', url: '/api/portify/nope' })
    expect(res.statusCode).toBe(404)
  })

  it('GET /api/portify lists workflows', async () => {
    const app = await build({ store: fakeStore({ list: () => [{ workflowId: 'portify-1', feature: 'cns', status: 'committed', startedAt: 'x' }] }) })
    const res = await app.inject({ method: 'GET', url: '/api/portify' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(1)
  })

  it('POST /api/portify/:id/commit delegates to the runner', async () => {
    let committed: string | undefined
    const app = await build({ commitPortify: async (id) => { committed = id; return manifest({ status: 'committed' }) } })
    const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/commit' })
    expect(res.statusCode).toBe(200)
    expect(committed).toBe('portify-1')
    expect(res.json()).toMatchObject({ status: 'committed' })
  })

  it('POST /api/portify/:id/commit surfaces a 409 when not ready', async () => {
    const app = await build({
      commitPortify: async () => { throw Object.assign(new Error('cannot commit a workflow in status "editing"'), { statusCode: 409 }) },
    })
    const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/commit' })
    expect(res.statusCode).toBe(409)
  })

  it('POST /api/portify/:id/cancel delegates to the runner', async () => {
    let cancelled: string | undefined
    const app = await build({ cancelPortify: async (id) => { cancelled = id; return manifest({ status: 'aborted' }) } })
    const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/cancel' })
    expect(res.statusCode).toBe(200)
    expect(cancelled).toBe('portify-1')
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

  it('POST /api/portify/:id/commit defaults to 500 for a non-statusCode error', async () => {
    const app = await build({ commitPortify: async () => { throw new Error('git exploded') } })
    const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/commit' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toMatchObject({ error: 'git exploded' })
  })

  it('POST /api/portify/:id/cancel surfaces runner errors', async () => {
    const app = await build({
      cancelPortify: async () => { throw Object.assign(new Error('nope'), { statusCode: 404 }) },
    })
    const res = await app.inject({ method: 'POST', url: '/api/portify/portify-1/cancel' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'nope' })
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
})
