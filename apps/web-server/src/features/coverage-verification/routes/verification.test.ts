import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { verificationRoutes } from './verification'
import { createRegistry, RunStore, type OrchestratorLike } from '../../orchestration/logic/run-store'

let tmpDir: string
let featuresDir: string
let logsDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-vroutes-')))
  featuresDir = path.join(tmpDir, 'features')
  logsDir = path.join(tmpDir, 'logs')
  fs.mkdirSync(featuresDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeFeature(): void {
  const dir = path.join(featuresDir, 'checkout')
  fs.mkdirSync(path.join(dir, 'envsets', 'production'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'envsets', 'production', 'checkout.env'), 'GATEWAY_URL=https://api.example.com\n')
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: {
      name: 'checkout',
      description: 'checkout',
      envs: ['local', 'production'],
      repos: [{
        name: 'api',
        localPath: __dirname,
        startCommands: [{
          name: 'api-server',
          command: 'npm run dev',
          envs: ['local'],
          healthCheck: {
            production: { http: { url: 'https://api.example.com/healthz' } }
          }
        }]
      }],
      featureDir: __dirname,
    } }`,
  )
}

function fakeOrchestrator(runId = 'verify-1'): OrchestratorLike {
  return {
    runId,
    stop: async () => {},
    pauseAndHeal: async () => ({ ok: false, reason: 'no-playwright-running' }),
    cancelHeal: async () => ({ ok: false, reason: 'not-healing' }),
  }
}

describe('verification routes', () => {
  it('lists targets and persists saved configs', async () => {
    writeFeature()
    const store = new RunStore(logsDir, createRegistry())
    const app = Fastify()
    await app.register(verificationRoutes, {
      featuresDir,
      store,
      startVerification: async () => fakeOrchestrator(),
    })

    const targets = await app.inject({
      method: 'GET',
      url: '/api/features/checkout/verification-targets?envset=production',
    })
    expect(targets.statusCode).toBe(200)
    expect(targets.json()).toMatchObject({
      targets: [{ id: 'api-server', name: 'api', envVar: 'GATEWAY_URL' }],
      targetUrls: { 'api-server': 'https://api.example.com' },
    })

    const created = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/verification-configs',
      payload: {
        name: 'Production',
        playwrightEnvsetId: 'production',
        targetUrls: { 'api-server': 'https://api.example.com' },
      },
    })
    expect(created.statusCode).toBe(201)
    const createdBody = created.json() as { id: string }

    const updated = await app.inject({
      method: 'PUT',
      url: `/api/features/checkout/verification-configs/${createdBody.id}`,
      payload: {
        name: 'Beta',
        playwrightEnvsetId: 'production',
        targetUrls: { 'api-server': 'https://beta.example.com' },
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json()).toMatchObject({
      id: createdBody.id,
      name: 'Beta',
      targetUrls: { 'api-server': 'https://beta.example.com' },
    })

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/features/checkout/verification-configs/${createdBody.id}`,
    })
    expect(fetched.statusCode).toBe(200)
    expect(fetched.json()).toMatchObject({ id: createdBody.id, name: 'Beta' })

    const listed = await app.inject({
      method: 'GET',
      url: '/api/features/checkout/verification-configs',
    })
    expect(listed.json()).toHaveLength(1)
  })

  it('executes verification through a dedicated route and registers the orchestrator', async () => {
    writeFeature()
    const registry = createRegistry()
    const store = new RunStore(logsDir, registry)
    const startVerification = vi.fn(async () => fakeOrchestrator('verify-42'))
    const app = Fastify()
    await app.register(verificationRoutes, {
      featuresDir,
      store,
      startVerification,
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/verifications',
      payload: {
        playwrightEnvsetId: 'production',
        targetUrls: { 'api-server': 'https://api.example.com' },
      },
    })

    expect(res.statusCode).toBe(201)
    expect(res.json()).toEqual({ runId: 'verify-42', executionType: 'verify' })
    expect(startVerification).toHaveBeenCalledWith('checkout', {
      playwrightEnvsetId: 'production',
      targetUrls: { 'api-server': 'https://api.example.com' },
    })
    expect(registry.get('verify-42')?.runId).toBe('verify-42')
  })

  it('returns not-found and validation errors for verification config routes', async () => {
    writeFeature()
    const store = new RunStore(logsDir, createRegistry())
    const app = Fastify()
    await app.register(verificationRoutes, {
      featuresDir,
      store,
      startVerification: async () => fakeOrchestrator(),
    })

    for (const [method, url] of [
      ['GET', '/api/features/missing/verification-targets'],
      ['GET', '/api/features/missing/verification-configs'],
      ['GET', '/api/features/missing/verification-configs/config-1'],
      ['POST', '/api/features/missing/verification-configs'],
      ['PUT', '/api/features/missing/verification-configs/config-1'],
      ['POST', '/api/features/missing/verifications'],
    ] as const) {
      const res = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'feature not found' })
    }

    const missingConfig = await app.inject({
      method: 'GET',
      url: '/api/features/checkout/verification-configs/missing',
    })
    expect(missingConfig.statusCode).toBe(404)
    expect(missingConfig.json()).toEqual({ error: 'verification config not found' })

    const invalidBodies = [
      { payload: undefined, error: 'request body is required' },
      { payload: { playwrightEnvsetId: 'production', targetUrls: {} }, error: 'name is required' },
      { payload: { name: 'Production', targetUrls: {} }, error: 'playwrightEnvsetId is required' },
      { payload: { name: 'Production', playwrightEnvsetId: 'production', targetUrls: [] }, error: 'targetUrls must be a string map' },
      { payload: { name: 'Production', playwrightEnvsetId: 'production', targetUrls: { api: 42 } }, error: 'targetUrls must be a string map' },
    ]
    for (const body of invalidBodies) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/features/checkout/verification-configs',
        payload: body.payload,
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: body.error })
    }

    const blankName = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/verification-configs',
      payload: { name: '  ', playwrightEnvsetId: 'production', targetUrls: {} },
    })
    expect(blankName.statusCode).toBe(400)
    expect(blankName.json()).toEqual({ error: 'verification config name is required' })

    const missingUpdate = await app.inject({
      method: 'PUT',
      url: '/api/features/checkout/verification-configs/missing',
      payload: { name: 'Production', playwrightEnvsetId: 'production', targetUrls: {} },
    })
    expect(missingUpdate.statusCode).toBe(404)
    expect(missingUpdate.json()).toEqual({ error: 'verification config not found' })

    const invalidUpdate = await app.inject({
      method: 'PUT',
      url: '/api/features/checkout/verification-configs/missing',
      payload: { name: 'Production', playwrightEnvsetId: 'production', targetUrls: [] },
    })
    expect(invalidUpdate.statusCode).toBe(400)
    expect(invalidUpdate.json()).toEqual({ error: 'targetUrls must be a string map' })

    const createdForUpdate = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/verification-configs',
      payload: { name: 'Production', playwrightEnvsetId: 'production', targetUrls: {} },
    })
    const blankUpdateName = await app.inject({
      method: 'PUT',
      url: `/api/features/checkout/verification-configs/${createdForUpdate.json().id}`,
      payload: { name: '  ', playwrightEnvsetId: 'production', targetUrls: {} },
    })
    expect(blankUpdateName.statusCode).toBe(400)
    expect(blankUpdateName.json()).toEqual({ error: 'verification config name is required' })
  })

  it('validates verification execution bodies, rejects active runs, and surfaces start errors', async () => {
    writeFeature()
    const registry = createRegistry()
    registry.set('active-run', fakeOrchestrator('active-run'))
    const activeStore = new RunStore(logsDir, registry)
    const activeApp = Fastify()
    await activeApp.register(verificationRoutes, {
      featuresDir,
      store: activeStore,
      startVerification: async () => fakeOrchestrator('blocked'),
    })

    activeStore.bootstrap({
      runId: 'active-run',
      feature: 'checkout',
      startedAt: '2026-05-24T00:00:00.000Z',
      status: 'running',
      healCycles: 0,
      services: [],
    })

    const active = await activeApp.inject({
      method: 'POST',
      url: '/api/features/checkout/verifications',
      payload: { playwrightEnvsetId: 'production' },
    })
    expect(active.statusCode).toBe(409)
    expect(active.json()).toEqual({ error: 'Another execution is running (checkout). Stop it first.' })

    const store = new RunStore(path.join(tmpDir, 'logs-2'), createRegistry())
    const app = Fastify()
    const startVerification = vi.fn()
    await app.register(verificationRoutes, {
      featuresDir,
      store,
      startVerification,
    })

    for (const [payload, error] of [
      [{ configId: 1 }, 'configId must be a string'],
      [{ playwrightEnvsetId: 1 }, 'playwrightEnvsetId must be a string'],
      [{ targetUrls: [] }, 'targetUrls must be a string map'],
      [{ targetUrls: { api: 1 } }, 'targetUrls must be a string map'],
    ] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/features/checkout/verifications',
        payload,
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error })
    }

    startVerification.mockResolvedValueOnce(fakeOrchestrator('verify-config'))
    const configOnly = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/verifications',
      payload: { configId: 'config-1' },
    })
    expect(configOnly.statusCode).toBe(201)
    expect(configOnly.json()).toEqual({ runId: 'verify-config', executionType: 'verify' })
    expect(startVerification).toHaveBeenCalledWith('checkout', { configId: 'config-1' })

    startVerification.mockRejectedValueOnce(new Error('spawn error'))
    const errorBody = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/verifications',
      payload: { playwrightEnvsetId: 'production' },
    })
    expect(errorBody.statusCode).toBe(500)
    expect(errorBody.json()).toEqual({ error: 'spawn error' })

    startVerification.mockRejectedValueOnce('spawn failed')
    const emptyBody = await app.inject({
      method: 'POST',
      url: '/api/features/checkout/verifications',
    })
    expect(emptyBody.statusCode).toBe(500)
    expect(emptyBody.json()).toEqual({ error: 'spawn failed' })
    expect(startVerification).toHaveBeenCalledWith('checkout', {})
  })
})
