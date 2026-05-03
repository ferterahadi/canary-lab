import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { runsRoutes } from './runs'
import { createRegistry, type OrchestratorLike } from '../lib/run-store'
import { writeManifest, writeRunsIndex } from '../../../shared/e2e-runner/manifest'
import { runDirFor } from '../../../shared/e2e-runner/run-paths'

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

function writeManifestForRun(runId: string, feature = 'foo'): void {
  const dir = runDirFor(logsDir, runId)
  fs.mkdirSync(dir, { recursive: true })
  writeManifest(path.join(dir, 'manifest.json'), {
    runId,
    feature,
    startedAt: 'now',
    status: 'passed',
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

async function build(opts: { startRun?: (f: string) => Promise<OrchestratorLike> } = {}) {
  const registry = createRegistry()
  const app = Fastify()
  await app.register(runsRoutes, {
    logsDir,
    featuresDir,
    registry,
    startRun: opts.startRun ?? (async () => { throw new Error('not configured') }),
  })
  return { app, registry }
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
    const { app, registry } = await build({ startRun: async () => stub })
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
    const { app } = await build({ startRun: async () => stub })
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
    const { app } = await build({ startRun: async () => stub })
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs',
      payload: { feature: 'foo', env: 'production' },
    })
    expect(res.statusCode).toBe(201)
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
      startRun: async (_f, env) => { receivedEnv = env; return stub },
    })
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { feature: 'noenv' } })
    expect(res.statusCode).toBe(201)
    expect(receivedEnv).toBeUndefined()
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
  it('404s when run not in registry', async () => {
    const { app } = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/ghost/agent-input',
      payload: { data: 'hi\n' },
    })
    expect(res.statusCode).toBe(404)
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
      writeToHealAgent: () => false,
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

  it('409s when writeToHealAgent is undefined (manual mode)', async () => {
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
      writeToHealAgent: (d: string) => { received = d; return true },
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

describe('DELETE /api/runs/:runId', () => {
  it('stops a registered orchestrator and 204s', async () => {
    const stub = makeStub('r2')
    const { app, registry } = await build()
    registry.set('r2', stub)
    const res = await app.inject({ method: 'DELETE', url: '/api/runs/r2' })
    expect(res.statusCode).toBe(204)
    expect(stub.stopped).toBe(true)
    expect(registry.get('r2')).toBeUndefined()
  })

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

  it('preserves the run when an active orchestrator is stopped', async () => {
    writeManifestForRun('r3b') // baseline manifest exists
    const stub = makeStub('r3b')
    const { app, registry } = await build()
    registry.set('r3b', stub)
    const res = await app.inject({ method: 'DELETE', url: '/api/runs/r3b' })
    expect(res.statusCode).toBe(204)
    expect(stub.stopped).toBe(true)
    // History is preserved so the user can still audit logs.
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
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('404s when run unknown entirely', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'DELETE', url: '/api/runs/ghost' })
    expect(res.statusCode).toBe(404)
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
    const res = await app.inject({ method: 'DELETE', url: '/api/runs/r4' })
    expect(res.statusCode).toBe(204)
    expect(registry.get('r4')).toBeUndefined()
  })
})
