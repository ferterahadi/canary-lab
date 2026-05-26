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
} from '../lib/external-heal-broker'
import { createRegistry, RunStore } from '../lib/run-store'
import { buildRunPaths, runDirFor } from '../lib/runtime/run-paths'
import { writeManifest, writeRunsIndex, type RunManifest } from '../lib/runtime/manifest'
import type { RunStoreEvent } from '../lib/run-store'
import type { HealSignalKind, RunStatus } from '../../../shared/run-state'

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
      updatedAt: '2026-05-18T10:00:05.000Z',
      message: 'Running tests',
      severity: 'info',
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

function writeSummary(runId: string): void {
  const runDir = runDirFor(logsDir, runId)
  fs.writeFileSync(path.join(runDir, 'e2e-summary.json'), JSON.stringify({
    complete: true,
    total: 3,
    passed: 0,
    knownTests: [
      { name: 'checkout fails' },
      { name: 'setup fails before artifact capture' },
      { name: 'not run yet' },
    ],
    failed: [
      {
        name: 'checkout fails',
        error: { message: 'Expected total to match', snippet: 'expect(total).toBe(12)' },
        location: 'e2e/checkout.spec.ts:12:3',
        retry: 1,
        logFiles: ['failed/checkout-fails/svc-app.log'],
      },
      {
        name: 'setup fails before artifact capture',
      },
    ],
    running: [],
    skipped: 0,
    durationMs: 123,
  }))
  const paths = buildRunPaths(runDir)
  fs.mkdirSync(path.join(paths.playwrightArtifactsDir, 'checkout-fails'), { recursive: true })
  fs.writeFileSync(path.join(paths.playwrightArtifactsDir, 'checkout-fails', 'trace.zip'), 'zip')
  fs.writeFileSync(paths.playwrightEventsPath, JSON.stringify({
    type: 'test-end',
    test: { name: 'checkout fails', title: 'checkout fails' },
    attachments: [
      {
        name: 'trace',
        contentType: 'application/zip',
        path: path.join(paths.playwrightArtifactsDir, 'checkout-fails', 'trace.zip'),
      },
    ],
  }) + '\n')
  fs.writeFileSync(paths.healIndexPath, '# Heal Index\n')
  fs.writeFileSync(paths.diagnosisJournalPath, '# Journal\n')
}

async function build() {
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
  it('claims, rejects competing claims, heartbeats, releases, and reports actions', async () => {
    writeRun('run-1', 'running')
    const { app, broker } = await build()

    const claim = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/claim',
      payload: {
        sessionId: 'sess-A',
        clientKind: 'codex-desktop',
        clientVersion: '1.2.3',
        conversationName: 'fix checkout',
      },
    })
    expect(claim.statusCode).toBe(200)
    expect(claim.json().session).toMatchObject({
      sessionId: 'sess-A',
      clientKind: 'codex-desktop',
      clientVersion: '1.2.3',
      conversationName: 'fix checkout',
      status: 'connected',
    })

    const conflict = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/claim',
      payload: { sessionId: 'sess-B', clientKind: 'claude-cli' },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().reason).toBe('already-claimed')

    const heartbeat = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/heartbeat',
      payload: { sessionId: 'sess-A', status: 'running-tests' },
    })
    expect(heartbeat.statusCode).toBe(204)

    const actions = await app.inject({ method: 'GET', url: '/api/runs/run-1/actions' })
    expect(actions.statusCode).toBe(200)
    expect(actions.json()).toMatchObject({
      status: 'running',
      signal: { rerun: true, restart: true, heal: true },
      evaluationExport: { available: false },
      externalClaim: { sessionId: 'sess-A', status: 'running-tests' },
    })

    const release = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/release',
      payload: { sessionId: 'sess-A' },
    })
    expect(release.statusCode).toBe(204)
    expect(broker.getSession('run-1')).toBeNull()
  })

  it('validates claim, heartbeat, and release requests', async () => {
    writeRun('run-1')
    const { app } = await build()

    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/missing/heal-agent/claim',
      payload: { sessionId: 'sess-A', clientKind: 'codex-cli' },
    })).statusCode).toBe(404)
    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/claim',
      payload: { clientKind: 'codex-cli' },
    })).json()).toEqual({ error: 'sessionId is required' })
    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/claim',
      payload: { sessionId: 'sess-A', clientKind: 'browser' },
    })).statusCode).toBe(400)

    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/heartbeat',
      payload: { status: 'connected' },
    })).json()).toEqual({ error: 'sessionId is required' })
    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/heartbeat',
      payload: { sessionId: 'sess-A', status: 'busy' },
    })).statusCode).toBe(400)
    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/heartbeat',
      payload: { sessionId: 'sess-A', status: 'connected' },
    })).json()).toEqual({ reason: 'no-claim' })

    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/release',
      payload: {},
    })).json()).toEqual({ error: 'sessionId is required' })
    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/heal-agent/release',
      payload: { sessionId: 'sess-A' },
    })).json()).toEqual({ reason: 'no-matching-claim' })
  })

  it('returns compact heal context with failed test artifacts and nullable missing fields', async () => {
    writeRun('run-1')
    writeSummary('run-1')
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/run-1/heal-context' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      runId: 'run-1',
      feature: 'checkout',
      env: 'local',
      status: 'running',
      healCycles: 1,
      counts: {
        totalKnown: 3,
        passed: 0,
        failed: 2,
        skipped: 0,
        notRun: 1,
        statusLine: '0/3 passed, 2 failed, 1 not run',
      },
      healIndex: {
        markdown: '# Heal Index\n',
      },
      journal: {
        markdown: '# Journal\n',
      },
      failedTests: [
        {
          name: 'checkout fails',
          error: { message: 'Expected total to match', snippet: 'expect(total).toBe(12)' },
          location: 'e2e/checkout.spec.ts:12:3',
          retry: 1,
          logFiles: ['failed/checkout-fails/svc-app.log'],
          artifacts: [
            {
              name: 'trace',
              kind: 'trace',
              url: '/api/runs/run-1/artifacts/checkout-fails/trace.zip',
            },
          ],
        },
        {
          name: 'setup fails before artifact capture',
          artifacts: [],
        },
      ],
    })
    expect(res.json()).not.toHaveProperty('summary')
    expect(res.json()).not.toHaveProperty('healIndexMarkdown')
    expect(res.json()).not.toHaveProperty('journalMarkdown')
    expect(res.json().counts).not.toHaveProperty('notRunNames')
    expect(JSON.stringify(res.json())).not.toContain('not run yet')
  })

  it('returns full run snapshot as the verbose debugging fallback', async () => {
    writeRun('run-1')
    writeSummary('run-1')
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/run-1/run-snapshot' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      runId: 'run-1',
      summary: {
        knownTests: [
          { name: 'checkout fails' },
          { name: 'setup fails before artifact capture' },
          { name: 'not run yet' },
        ],
      },
      counts: {
        notRunNames: ['not run yet'],
        statusLine: '0/3 passed, 2 failed, 1 not run',
      },
      healIndexMarkdown: '# Heal Index\n',
      journalMarkdown: '# Journal\n',
      artifactsBase: '/api/runs/run-1/artifacts/',
    })
  })

  it('returns heal context defaults when optional run fields and files are absent', async () => {
    writeRun('run-2', 'failed')
    const manifestPath = path.join(runDirFor(logsDir, 'run-2'), 'manifest.json')
    const manifest = manifestForRun('run-2', 'failed')
    delete manifest.env
    delete manifest.repoBranches
    delete manifest.lifecycle
    writeManifest(manifestPath, manifest)
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/run-2/heal-context' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      env: null,
      repoBranches: [],
      lifecycle: null,
      externalHealSession: null,
      failedTests: [],
      healIndex: null,
      journal: null,
    })
    expect(res.json()).not.toHaveProperty('summary')
  })

  it('validates and writes restart, rerun, and heal signal files', async () => {
    writeRun('run-1')
    const { app, broker, acceptedSignals } = await build()
    broker.claim('run-1', { sessionId: 'sess-A', clientKind: 'codex-cli' })

    const mismatch = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/signal',
      payload: {
        sessionId: 'sess-B',
        kind: 'restart',
        body: { hypothesis: 'restart it', fixDescription: 'fixed it' },
      },
    })
    expect(mismatch.statusCode).toBe(409)
    expect(mismatch.json().reason).toBe('session-mismatch')

    for (const kind of ['restart', 'rerun'] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/runs/run-1/signal',
        payload: {
          sessionId: 'sess-A',
          kind,
          body: { hypothesis: `${kind} it`, fixDescription: `${kind} fixed` },
        },
      })
      expect(res.statusCode).toBe(202)
      expect(res.json()).toMatchObject({ accepted: true, kind })
    }
    const heal = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/signal',
      payload: { sessionId: 'sess-A', kind: 'heal', body: { hypothesis: 'heal it' } },
    })
    expect(heal.statusCode).toBe(202)

    const paths = buildRunPaths(runDirFor(logsDir, 'run-1'))
    expect(fs.readFileSync(paths.restartSignal, 'utf-8')).toBe(JSON.stringify({
      hypothesis: 'restart it',
      fixDescription: 'restart fixed',
    }))
    expect(fs.readFileSync(paths.rerunSignal, 'utf-8')).toBe(JSON.stringify({
      hypothesis: 'rerun it',
      fixDescription: 'rerun fixed',
    }))
    expect(fs.readFileSync(paths.healSignal, 'utf-8')).toBe(JSON.stringify({ hypothesis: 'heal it' }))
    expect(broker.getSession('run-1')?.cycleCount).toBe(3)
    expect(acceptedSignals.map((s) => s.kind)).toEqual(['restart', 'rerun', 'heal'])

    const defaultBody = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/signal',
      payload: { sessionId: 'sess-A', kind: 'rerun' },
    })
    expect(defaultBody.statusCode).toBe(400)
    expect(defaultBody.json()).toEqual({
      error: 'restart/rerun signal body requires hypothesis and fixDescription',
    })
  })

  it('validates signal requests and returns filesystem errors', async () => {
    writeRun('run-1')
    writeRun('done', 'passed')
    const { app } = await build()

    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/missing/signal',
      payload: { kind: 'restart', body: {} },
    })).statusCode).toBe(404)
    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/done/signal',
      payload: { kind: 'restart', body: { hypothesis: 'h', fixDescription: 'f' } },
    })).json()).toEqual({ reason: 'run-not-active' })
    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/signal',
      payload: { kind: 'retry', body: {} },
    })).statusCode).toBe(400)
    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/signal',
      payload: { kind: 'restart', body: 'bad' },
    })).json()).toEqual({ error: 'body must be an object' })
    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/signal',
      payload: { kind: 'restart', body: { hypothesis: 'h' } },
    })).json()).toEqual({ error: 'restart/rerun signal body requires hypothesis and fixDescription' })
    expect((await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/signal',
      payload: { kind: 'rerun', body: { fixDescription: 'f' } },
    })).json()).toEqual({ error: 'restart/rerun signal body requires hypothesis and fixDescription' })

    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const failed = await app.inject({
      method: 'POST',
      url: '/api/runs/run-1/signal',
      payload: { kind: 'restart', body: { hypothesis: 'h', fixDescription: 'f' } },
    })
    expect(failed.statusCode).toBe(500)
    expect(failed.json()).toEqual({ error: 'disk full' })
    expect(writeSpy).toHaveBeenCalled()
  })

  it('reports terminal action availability and 404s missing action/context runs', async () => {
    writeRun('done', 'failed')
    const { app } = await build()

    expect((await app.inject({ method: 'GET', url: '/api/runs/missing/heal-context' })).statusCode).toBe(404)
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
      clientKind: 'codex-cli',
      action: 'claim',
    })

    const body = fs.readFileSync(path.join(runDirFor(logsDir, 'run-1'), 'external-commands.jsonl'), 'utf-8')
    expect(body).toBe(JSON.stringify({
      ts: '2026-05-18T10:00:00.000Z',
      sessionId: 'sess-A',
      clientKind: 'codex-cli',
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
