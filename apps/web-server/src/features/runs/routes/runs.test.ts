import { describe, it, expect, beforeEach, vi } from 'vitest'

import fs from 'fs'

import os from 'os'

import path from 'path'

import Fastify from 'fastify'

import { runsRoutes, type ExternalHealAgentRequest } from './runs'

import { createRegistry, RunStore, type OrchestratorLike, type RestartHealResult, type RestartRunResult } from '../logic/run-store'

import { readManifest, readRunsIndex, writeManifest, writeRunsIndex, type RunManifest } from '../logic/runtime/manifest'

import { runDirFor } from '../logic/runtime/run-paths'

import { launchEditorDir } from '../../../shared/editor-launch'

import type { WorkspaceEvent } from '../../../shared/workspace-events'

vi.mock('../../../shared/editor-launch', () => ({ launchEditorDir: vi.fn(() => 'vscode') }))

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
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cl-rroutes-')))
  logsDir = path.join(tmpDir, 'logs')
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featuresDir, { recursive: true })
})

function writeManifestForRun(runId: string, feature = 'foo', status: 'running' | 'passed' | 'failed' | 'healing' | 'aborted' = 'passed'): void {
  const dir = runDirFor(logsDir, runId)
  fs.mkdirSync(dir, { recursive: true })
  writeManifest(path.join(dir, 'manifest.json'), {
    runId,
    feature,
    featureDir: path.join(featuresDir, feature),
    startedAt: 'now',
    status,
    healCycles: 0,
    services: [],
  })
}

async function build(opts: {
	  startRun?: Parameters<typeof runsRoutes>[1]['startRun']
	  cancelQueuedRun?: (runId: string) => boolean
	  broker?: Parameters<typeof runsRoutes>[1]['broker']
	  restartHeal?: (runId: string, text: string) => Promise<RestartHealResult>
	  restartRun?: (runId: string) => Promise<RestartRunResult>
  projectRoot?: string
  events?: WorkspaceEvent[]
  isWorktreeOwnerActive?: (kind: 'run' | 'benchmark', id: string) => boolean
} = {}) {
  const registry = createRegistry()
  const store = new RunStore(logsDir, registry)
  const app = Fastify()
  await app.register(runsRoutes, {
    featuresDir,
    projectRoot: opts.projectRoot,
    store,
    broker: opts.broker,
	    startRun: opts.startRun ?? (async () => { throw new Error('not configured') }),
	    cancelQueuedRun: opts.cancelQueuedRun,
	    restartHeal: opts.restartHeal,
    restartRun: opts.restartRun,
    isWorktreeOwnerActive: opts.isWorktreeOwnerActive,
	    workspaceEvents: opts.events ? { publish: (event) => opts.events!.push(event) } : undefined,
	  })
  return { app, registry, store }
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

describe('GET /api/runs/:runId/agent-session', () => {
  it('returns normalized events when agent-session.json + log exist', async () => {
    writeManifestForRun('r1')
    const runDir = runDirFor(logsDir, 'r1')
    // Stand up a fake claude session log on disk.
    const logPath = path.join(tmpDir, 'fake-session.jsonl')
    fs.writeFileSync(logPath, JSON.stringify({
      type: 'user',
      timestamp: 't',
      message: { content: 'hi' },
    }) + '\n')
    fs.writeFileSync(path.join(runDir, 'agent-session.json'), JSON.stringify({
      agent: 'claude',
      sessionId: 'sid',
      logPath,
    }))

    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/agent-session' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { agent: string; events: Array<{ kind: string }> }
    expect(body.agent).toBe('claude')
    expect(body.events).toEqual([
      { kind: 'user-message', timestamp: 't', text: 'hi' },
    ])
  })

  it('404 reason=run-not-found when the run is unknown', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/none/agent-session' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ reason: 'run-not-found' })
  })

  it('404 reason=no-session-ref when the pointer file is missing', async () => {
    writeManifestForRun('r1')
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/agent-session' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ reason: 'no-session-ref' })
  })

  it('404 reason=session-log-missing when the pointed-at JSONL is gone', async () => {
    writeManifestForRun('r1')
    const runDir = runDirFor(logsDir, 'r1')
    fs.writeFileSync(path.join(runDir, 'agent-session.json'), JSON.stringify({
      agent: 'claude',
      sessionId: 'sid',
      logPath: path.join(tmpDir, 'never-existed.jsonl'),
    }))
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/agent-session' })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ reason: 'session-log-missing' })
  })
})

describe('GET /api/runs/:runId/artifacts/*', () => {
  it('serves files from the run-local Playwright artifact directory', async () => {
    writeManifestForRun('r1')
    const file = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts', 'case-a', 'test-failed-1.png')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'PNGDATA')
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/case-a/test-failed-1.png' })

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('image/png')
    expect(res.body).toBe('PNGDATA')
  })

  it('rejects artifact path traversal', async () => {
    writeManifestForRun('r1')
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/..%2Fmanifest.json' })
    expect(res.statusCode).toBe(400)
  })

  it('404s when artifact path is missing or points to a directory', async () => {
    writeManifestForRun('r1')
    const dir = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts', 'case-a')
    fs.mkdirSync(dir, { recursive: true })
    const { app } = await build()

    expect((await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/missing.png' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/case-a' })).statusCode).toBe(404)
  })

  it.each([
    ['case.jpg', 'image/jpeg'],
    ['case.jpeg', 'image/jpeg'],
    ['case.webp', 'image/webp'],
    ['case.webm', 'video/webm'],
    ['case.mp4', 'video/mp4'],
    ['trace.zip', 'application/zip'],
    ['raw.bin', 'application/octet-stream'],
  ])('serves %s with %s', async (name, contentType) => {
    writeManifestForRun('r1')
    const file = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts', name)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, 'data')
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: `/api/runs/r1/artifacts/${name}` })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain(contentType)
  })

  it('falls back to the keep dir when the file is only in playwright-artifacts-keep', async () => {
    // After a heal-cycle respawn, Playwright wipes `playwright-artifacts/`.
    // Files that the orchestrator copied into `playwright-artifacts-keep/`
    // must still be reachable via the same artifact URL the indexer minted
    // against the live dir.
    writeManifestForRun('r1')
    const keepFile = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts-keep', 'pw-slug-a', 'video.webm')
    fs.mkdirSync(path.dirname(keepFile), { recursive: true })
    fs.writeFileSync(keepFile, 'KEPT-WEBM')
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/pw-slug-a/video.webm' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('video/webm')
    expect(res.body).toBe('KEPT-WEBM')
  })

  it('prefers the live dir when the same path exists in both', async () => {
    writeManifestForRun('r1')
    const live = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts', 'pw-slug-a', 'video.webm')
    const keep = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts-keep', 'pw-slug-a', 'video.webm')
    fs.mkdirSync(path.dirname(live), { recursive: true })
    fs.mkdirSync(path.dirname(keep), { recursive: true })
    fs.writeFileSync(live, 'FRESH-WEBM')
    fs.writeFileSync(keep, 'STALE-WEBM')
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/pw-slug-a/video.webm' })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('FRESH-WEBM')
  })

  it('404s when the file is in neither dir', async () => {
    writeManifestForRun('r1')
    // Create both dirs but no matching file.
    fs.mkdirSync(path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts'), { recursive: true })
    fs.mkdirSync(path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts-keep'), { recursive: true })
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/artifacts/pw-slug-a/video.webm' })
    expect(res.statusCode).toBe(404)
  })
})
