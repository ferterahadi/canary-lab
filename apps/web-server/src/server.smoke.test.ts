import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createServer } from './server'
import type { TestsDraftRouteDeps } from './features/wizard/routes/tests-draft'
import { writeManifest, writeRunsIndex, readManifest, readRunsIndex } from './features/runs/logic/runtime/manifest'
import { runDirFor } from './features/runs/logic/runtime/run-paths'
import type { PtyFactory } from './features/runs/logic/runtime/pty-spawner'
import { HEARTBEAT_STALE_MS } from '../../../shared/run-state'

// Smoke test: exercises createServer() against the real templates/project
// tree, hitting every read-side endpoint via inject(). Lives next to the
// bootstrap so it doubles as the manual boot check evidence — running
// `npx vitest run apps/web-server/server.smoke.test.ts` is the closest we
// can get to a real boot inside the sandbox.

const inertPtyFactory: PtyFactory = () => ({
  pid: 0,
  onData: () => ({ dispose: () => { /* noop */ } }),
  onExit: () => ({ dispose: () => { /* noop */ } }),
  write: () => { /* noop */ },
  resize: () => { /* noop */ },
  kill: () => { /* noop */ },
})

describe('createServer smoke (templates/project)', () => {
  it('binds to a real port and answers a request over HTTP', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, ptyFactory: inertPtyFactory })
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      // Fastify returns "http://127.0.0.1:<port>".
      const res = await fetch(`${address}/api/features`)
      expect(res.status).toBe(200)
      const body = (await res.json()) as Array<{ name: string }>
      // The scaffold ships its own demonstration (R89) — the storefront suite
      // is there from the first boot, not an empty list.
      expect(body.map((f) => f.name)).toEqual(['storefront-journey', 'workflow-workbench'])
    } finally {
      await app.close()
    }
  })

  it('serves all read-side endpoints (features, runs, journal, drafts)', async () => {
    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({
      projectRoot,
      ptyFactory: inertPtyFactory,
    })
    try {
      const features = await app.inject({ method: 'GET', url: '/api/features' })
      expect(features.statusCode).toBe(200)
      const featuresJson = features.json() as Array<{ name: string }>
      expect(featuresJson.map((f) => f.name)).toEqual(['storefront-journey', 'workflow-workbench'])

      const runs = await app.inject({ method: 'GET', url: '/api/runs' })
      expect(runs.statusCode).toBe(200)
      expect(Array.isArray(runs.json())).toBe(true)

      const journal = await app.inject({ method: 'GET', url: '/api/journal' })
      expect(journal.statusCode).toBe(200)
      expect(Array.isArray(journal.json())).toBe(true)

      // Drafts list endpoint.
      const drafts = await app.inject({ method: 'GET', url: '/api/tests/draft' })
      expect(drafts.statusCode).toBe(200)
      expect(Array.isArray(drafts.json())).toBe(true)

      const unknown = await app.inject({ method: 'GET', url: '/api/runs/zzz' })
      expect(unknown.statusCode).toBe(404)

      const unknownFeature = await app.inject({
        method: 'GET',
        url: '/api/features/nope/tests',
      })
      expect(unknownFeature.statusCode).toBe(404)
    } finally {
      await app.close()
    }
  }, 15_000)

})

describe('createServer boot-time active-orphan cleanup', () => {
  let logsDir: string

  beforeEach(() => {
    logsDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-boot-reap-')))
  })

  afterEach(() => {
    fs.rmSync(logsDir, { recursive: true, force: true })
  })

  it('reaps a stale running entry from a previous process at startup', async () => {
    const runId = 'stale-prev-run'
    const dir = runDirFor(logsDir, runId)
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId,
      feature: 'demo_inventory',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
      // Genuinely past the staleness window. This fixture used to be 60s old —
      // which is FRESH against the 10-minute window — so the test's name never
      // matched what it exercised; it passed only because boot cleanup used to
      // abort every active row regardless of heartbeat.
      heartbeatAt: new Date(Date.now() - HEARTBEAT_STALE_MS - 60_000).toISOString(),
    })
    writeRunsIndex(logsDir, [
      { runId, feature: 'demo_inventory', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])

    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    try {
      const manifest = readManifest(path.join(dir, 'manifest.json'))
      expect(manifest?.status).toBe('aborted')
      expect(manifest?.endedAt).toBeDefined()

      const runs = await app.inject({ method: 'GET', url: '/api/runs' })
      const json = runs.json() as Array<{ runId: string; status: string }>
      expect(json.find((r) => r.runId === runId)?.status).toBe('aborted')
    } finally {
      await app.close()
    }
  })

  it('leaves a fresh-heartbeat running entry alone at startup — a live process still owns it', async () => {
    // Contract change. A fresh heartbeat is evidence the owning process is
    // ALIVE, so this row is not a previous process's leftover at all. Boot
    // cleanup used to abort it anyway, and since the real orchestrator lives in
    // that other process's memory, the abort could not stop anything — it only
    // rewrote the record. A live healing run was marked `aborted` 3s into its
    // repair cycle, the UI swapped the streaming agent pane for an empty
    // transcript view, and the repair carried on invisibly for another 51s.
    const runId = 'fresh-prev-run'
    const dir = runDirFor(logsDir, runId)
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId,
      feature: 'demo_inventory',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
      heartbeatAt: new Date().toISOString(),
    })
    writeRunsIndex(logsDir, [
      { runId, feature: 'demo_inventory', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])

    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    try {
      const manifest = readManifest(path.join(dir, 'manifest.json'))
      expect(manifest?.status).toBe('running')
      expect(manifest?.endedAt).toBeUndefined()
      expect(readRunsIndex(logsDir).find((r) => r.runId === runId)?.status).toBe('running')
    } finally {
      await app.close()
    }
  })

  it('aborts a legacy active manifest with no heartbeatAt at startup', async () => {
    const runId = 'legacy-prev-run'
    const dir = runDirFor(logsDir, runId)
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId,
      feature: 'demo_inventory',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
      // no heartbeatAt — pre-feature manifest
    })
    writeRunsIndex(logsDir, [
      { runId, feature: 'demo_inventory', startedAt: '2026-01-01T00:00:00Z', status: 'running' },
    ])

    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    try {
      const manifest = readManifest(path.join(dir, 'manifest.json'))
      expect(manifest?.status).toBe('aborted')
      expect(manifest?.endedAt).toBeDefined()
      expect(readRunsIndex(logsDir).find((r) => r.runId === runId)?.status).toBe('aborted')
    } finally {
      await app.close()
    }
  })

  it('leaves terminal runs unchanged at startup', async () => {
    const runId = 'done-prev-run'
    const dir = runDirFor(logsDir, runId)
    fs.mkdirSync(dir, { recursive: true })
    writeManifest(path.join(dir, 'manifest.json'), {
      runId,
      feature: 'demo_inventory',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:00:05Z',
      status: 'passed',
      healCycles: 0,
      services: [],
      heartbeatAt: new Date().toISOString(),
    })
    writeRunsIndex(logsDir, [
      {
        runId,
        feature: 'demo_inventory',
        startedAt: '2026-01-01T00:00:00Z',
        status: 'passed',
        endedAt: '2026-01-01T00:00:05Z',
      },
    ])

    const projectRoot = path.resolve(__dirname, '..', '..', '..', 'templates', 'project')
    const { app } = await createServer({ projectRoot, logsDir, ptyFactory: inertPtyFactory })
    try {
      const manifest = readManifest(path.join(dir, 'manifest.json'))
      expect(manifest?.status).toBe('passed')
      expect(manifest?.endedAt).toBe('2026-01-01T00:00:05Z')
      const indexed = readRunsIndex(logsDir).find((r) => r.runId === runId)
      expect(indexed?.status).toBe('passed')
      expect(indexed?.endedAt).toBe('2026-01-01T00:00:05Z')
    } finally {
      await app.close()
    }
  })
})
