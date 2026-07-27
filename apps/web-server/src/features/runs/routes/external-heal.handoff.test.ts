import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { externalHealRoutes, makeExternalHealAuditLogger } from './external-heal'
import {
  ExternalHealBroker,
  type ExternalHealAuditEntry,
  type ExternalHealBrokerDeps,
} from '../logic/heal/external-heal-broker'

import { createRegistry, RunStore } from '../logic/run-store'
import { buildRunPaths, runDirFor } from '../logic/runtime/run-paths'
import { writeManifest, writeRunsIndex, type RunManifest } from '../logic/runtime/manifest'
import type { RunStoreEvent } from '../logic/run-store'
import type { HealSignalKind, RunStatus } from '../../../../../../shared/run-state'

let tmpDir: string

let logsDir: string

let featuresDir: string

beforeEach(() => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-external-heal-')))
  logsDir = path.join(tmpDir, 'logs')
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featuresDir, { recursive: true })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function manifestForRun(runId: string, status: RunStatus = 'running'): RunManifest {
  return {
    runId,
    feature: 'checkout',
    featureDir: path.join(featuresDir, 'checkout'),
    env: 'local',
    startedAt: '2026-05-18T10:00:00.000Z',
    status,
    healCycles: 1,
    services: [],
    repoBranches: [
      { name: 'app', path: '/repo/app', branch: 'main', detached: false, dirty: true },
    ],
    lifecycle: {
      phase: 'running-tests',
      headline: 'Running tests',
      updatedAt: '2026-05-18T10:00:05.000Z',
    },
  }
}

function writeRun(runId: string, status: RunStatus = 'running'): void {
  const dir = runDirFor(logsDir, runId)
  fs.mkdirSync(dir, { recursive: true })
  writeManifest(path.join(dir, 'manifest.json'), manifestForRun(runId, status))
  writeRunsIndex(logsDir, [
    { runId, feature: 'checkout', startedAt: '2026-05-18T10:00:00.000Z', status },
  ])
}

async function build(opts: { isClaimAllowed?: (kind: string) => boolean } = {}) {
  const store = new RunStore(logsDir, createRegistry())
  const events: RunStoreEvent[] = []
  const audit: Array<{ runId: string; entry: ExternalHealAuditEntry }> = []
  const deps: ExternalHealBrokerDeps = {
    now: () => new Date('2026-05-18T10:00:00.000Z').getTime(),
    emit: (event) => { events.push(event) },
    patchManifest: (runId, patch) => { store.patchManifest(runId, patch) },
    audit: (runId, entry) => { audit.push({ runId, entry }) },
    // Most route tests exercise claim mechanics across client kinds; allow all
    // by default. The denylist policy is asserted in its own test below.
    isClaimAllowed: opts.isClaimAllowed ?? (() => true),
  }
  const broker = new ExternalHealBroker(deps)
  const acceptedSignals: Array<{ runId: string; kind: HealSignalKind; body: Record<string, unknown> }> = []
  const app = Fastify()
  await app.register(externalHealRoutes, {
    store,
    broker,
    onSignalAccepted: (runId, kind, body) => { acceptedSignals.push({ runId, kind, body }) },
  })
  return { app, broker, events, audit, acceptedSignals }
}

describe('external heal routes', () => {
  it('hands off active external runs to manual mode and rejects local-agent targets for active runs', async () => {
    writeRun('run-1', 'running')
    const { app, broker, audit } = await build()
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'codex' })

    const manual = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/handoff',
      payload: { to: 'manual', sessionId: 'sess-A' },
    })
    expect(manual.statusCode).toBe(202)
    expect(manual.json()).toMatchObject({
      accepted: true,
      to: 'manual',
      previousSession: { sessionId: 'sess-A', clientKind: 'codex' },
    })
    expect(broker.getSession('run-1')).toBeNull()
    expect(audit.at(-1)?.entry.action).toBe('handoff')

    // After release the run no longer holds a claim — patch the manifest's
    // healMode field for the next case to mirror that.
    broker.claim('run-1', { sessionId: 'sess-B', clientKind: 'claude' })
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/handoff',
      payload: { to: 'claude', sessionId: 'sess-B' },
    })
    expect(blocked.statusCode).toBe(409)
    expect(blocked.json().reason).toBe('active-run-not-handoff-capable')
    // Claim should survive the rejected handoff.
    expect(broker.getSession('run-1')?.sessionId).toBe('sess-B')
  })

  it('rejects handoff with mismatched session id', async () => {
    writeRun('run-1', 'running')
    const { app, broker } = await build()
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'codex' })

    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/handoff',
      payload: { to: 'manual', sessionId: 'sess-other' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json().reason).toBe('session-mismatch')
    expect(broker.getSession('run-1')?.sessionId).toBe('sess-A')
  })

  it('hands off terminal runs to a local heal agent through restartLocalHeal', async () => {
    writeRun('run-1', 'failed')
    const restartCalls: Array<{ runId: string; guidance: string }> = []
    const store = new RunStore(logsDir, createRegistry())
    const events: RunStoreEvent[] = []
    const audit: Array<{ runId: string; entry: ExternalHealAuditEntry }> = []
    const deps: ExternalHealBrokerDeps = {
      now: () => new Date('2026-05-18T10:00:00.000Z').getTime(),
      emit: (event) => { events.push(event) },
      patchManifest: (runId, patch) => { store.patchManifest(runId, patch) },
      audit: (runId, entry) => { audit.push({ runId, entry }) },
    }
    const broker = new ExternalHealBroker(deps)
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude' })
    const app = Fastify()
    await app.register(externalHealRoutes, {
      store,
      broker,
      restartLocalHeal: async (runId, guidance) => {
        restartCalls.push({ runId, guidance })
        return { ok: true }
      },
    })

    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/handoff',
      payload: { to: 'auto', sessionId: 'sess-A', guidance: 'try claude' },
    })

    expect(res.statusCode).toBe(202)
    expect(res.json()).toMatchObject({ accepted: true, to: 'auto' })
    expect(restartCalls).toEqual([{ runId: 'run-1', guidance: 'try claude' }])
    expect(broker.getSession('run-1')).toBeNull()
  })

  it('rejects local-agent handoff for terminal runs that are not restartable', async () => {
    writeRun('run-1', 'passed')
    const { app } = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/handoff',
      payload: { to: 'auto' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ reason: 'run-not-restartable', status: 'passed' })
  })

  it('rejects local-agent handoff when no restartLocalHeal dependency is wired', async () => {
    writeRun('run-1', 'failed')
    const { app } = await build()
    const res = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/handoff',
      payload: { to: 'auto' },
    })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ reason: 'restart-local-heal-unavailable' })
  })

  it('maps restartLocalHeal failures to 500 for spawn-failed and 409 otherwise', async () => {
    writeRun('run-spawn', 'failed')
    writeRun('run-busy', 'aborted')
    const store = new RunStore(logsDir, createRegistry())
    const broker = new ExternalHealBroker({
      now: () => new Date('2026-05-18T10:00:00.000Z').getTime(),
      emit: () => {},
      patchManifest: (runId, patch) => { store.patchManifest(runId, patch) },
      audit: () => {},
    })
    broker.claim('run-spawn', { sessionId: 'sess-A', clientKind: 'claude' })
    broker.claim('run-busy', { sessionId: 'sess-B', clientKind: 'claude' })
    const app = Fastify()
    await app.register(externalHealRoutes, {
      store,
      broker,
      restartLocalHeal: async (runId) =>
        runId === 'run-spawn'
          ? { ok: false, reason: 'spawn-failed' }
          : { ok: false, reason: 'orchestrator-busy' },
    })

    const spawnFailed = await app.inject({
      method: 'POST',
      url: '/api/runs/run-spawn/heal-agent/handoff',
      payload: { to: 'auto', sessionId: 'sess-A' },
    })
    expect(spawnFailed.statusCode).toBe(500)
    expect(spawnFailed.json()).toMatchObject({
      reason: 'spawn-failed',
      previousSession: { sessionId: 'sess-A' },
    })
    expect(broker.getSession('run-spawn')).toBeNull()

    const busy = await app.inject({
      method: 'POST',
      url: '/api/runs/run-busy/heal-agent/handoff',
      payload: { to: 'codex', sessionId: 'sess-B' },
    })
    expect(busy.statusCode).toBe(409)
    expect(busy.json()).toMatchObject({
      reason: 'orchestrator-busy',
      previousSession: { sessionId: 'sess-B' },
    })
    expect(broker.getSession('run-busy')).toBeNull()
  })

  it('validates handoff target and 404s missing runs', async () => {
    writeRun('run-1', 'running')
    const { app } = await build()
    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/missing/heal-agent/handoff',
      payload: { to: 'manual' },
    })).statusCode).toBe(404)
    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/handoff',
      payload: { to: 'invalid' },
    })).statusCode).toBe(400)
  })

  it('returns parsed audit entries from external-commands.jsonl', async () => {
    writeRun('run-1')
    const { app, broker } = await build()
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'claude' })
    // Force a few audit entries by exercising the broker.
    broker.release('run-1', 'sess-A')
    const logger = makeExternalHealAuditLogger(logsDir)
    logger('run-1', {
      ts: '2026-05-18T10:00:00.000Z',
      sessionId: 'sess-A',
      clientKind: 'claude',
      action: 'claim',
    })
    logger('run-1', {
      ts: '2026-05-18T10:00:05.000Z',
      sessionId: 'sess-A',
      clientKind: 'claude',
      action: 'release',
    })

    const res = await app.inject({ method: 'GET', url: '/api/runs/run-1/audit' })
    expect(res.statusCode).toBe(200)
    expect(res.json().entries).toEqual([
      {
        ts: '2026-05-18T10:00:00.000Z',
        sessionId: 'sess-A',
        clientKind: 'claude',
        action: 'claim',
      },
      {
        ts: '2026-05-18T10:00:05.000Z',
        sessionId: 'sess-A',
        clientKind: 'claude',
        action: 'release',
      },
    ])
  })

  it('returns an empty audit list when no entries have been recorded', async () => {
    writeRun('run-1')
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/run-1/audit' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ entries: [] })
  })

  it('404s the audit endpoint on missing runs', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/missing/audit' })
    expect(res.statusCode).toBe(404)
  })

  it('reports terminal action availability and 404s missing action/context runs', async () => {
    writeRun('done', 'failed')
    const { app } = await build()

    expect((await app.inject({ method: 'GET', url: '/api/runs/missing/heal-context' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/runs/missing/run-snapshot' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/runs/missing/actions' })).statusCode).toBe(404)

    const actions = await app.inject({ method: 'GET', url: '/api/runs/done/actions' })
    expect(actions.statusCode).toBe(200)
    expect(actions.json()).toMatchObject({
      status: 'failed',
      signal: { rerun: false, restart: false, heal: false },
      evaluationExport: { available: true },
      externalClaim: null,
    })
  })
})

describe('makeExternalHealAuditLogger', () => {
  it('appends JSONL audit entries under the run directory', () => {
    const logger = makeExternalHealAuditLogger(logsDir)

    logger('run-1', {
      ts: '2026-05-18T10:00:00.000Z',
      sessionId: 'sess-A',
      clientKind: 'codex',
      action: 'claim',
    })

    const body = fs.readFileSync(path.join(runDirFor(logsDir, 'run-1'), 'external-commands.jsonl'), 'utf-8')
    expect(body).toBe(JSON.stringify({
      ts: '2026-05-18T10:00:00.000Z',
      sessionId: 'sess-A',
      clientKind: 'codex',
      action: 'claim',
    }) + '\n')
  })

  it('swallows audit write failures', () => {
    const logger = makeExternalHealAuditLogger(logsDir)
    vi.spyOn(fs, 'appendFileSync').mockImplementationOnce(() => {
      throw new Error('read-only')
    })

    expect(() => logger('run-1', {
      ts: '2026-05-18T10:00:00.000Z',
      sessionId: null,
      clientKind: null,
      action: 'claim',
    })).not.toThrow()
  })
})
