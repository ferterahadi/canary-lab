import { describe, it, expect, beforeEach, vi } from 'vitest'

import fs from 'fs'

import path from 'path'

import type { ExternalHealAgentRequest } from './runs-route-support'

import type { OrchestratorLike } from '../logic/run-registry'

import { readManifest, readRunsIndex, writeManifest, writeRunsIndex } from '../logic/runtime/manifest'
import type { RunManifest } from '../../../../../../shared/run-manifest'

import { buildRunPaths, runDirFor } from '../logic/runtime/run-paths'

import { launchEditorDir } from '../../../shared/editor-launch'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'
import { buildRunsApp, type RunsAppOptions } from './__fixtures__/runs-app'

const tempDir = trackTempDirs('cl-rroutes-')



vi.mock('../../../shared/editor-launch', async () => (await import('../../../shared/__fixtures__/editor-launch')).editorLaunchMock())

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
  tmpDir = tempDir()
  logsDir = path.join(tmpDir, 'logs')
  featuresDir = path.join(tmpDir, 'features')
  fs.mkdirSync(logsDir, { recursive: true })
  fs.mkdirSync(featuresDir, { recursive: true })
})

function writeManifestForRun(runId: string, feature = 'foo', status: 'running' | 'passed' | 'failed' | 'healing' | 'aborted' | 'queued' = 'passed'): void {
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

const build = (opts: RunsAppOptions = {}) => buildRunsApp({ logsDir, featuresDir }, opts)

describe('GET /api/runs', () => {
  it('marks a claimed legacy run for a fresh attempt in list and detail reads', async () => {
    const featureDir = path.join(featuresDir, 'foo')
    fs.mkdirSync(featureDir, { recursive: true })
    fs.writeFileSync(path.join(featureDir, 'feature.config.cjs'),
      "module.exports = { config: { name: 'foo', singleAttempt: { receipt: 'runtime/attempt.json' } } }\n")
    writeManifestForRun('spent', 'foo', 'failed')
    writeRunsIndex(logsDir, [{ runId: 'spent', feature: 'foo', startedAt: 'now', status: 'failed' }])
    const receipt = path.join(runDirFor(logsDir, 'spent'), 'runtime/attempt.json')
    fs.mkdirSync(path.dirname(receipt), { recursive: true })
    fs.writeFileSync(receipt, '{}')
    const { app } = await build()

    const list = await app.inject({ method: 'GET', url: '/api/runs?feature=foo' })
    const detail = await app.inject({ method: 'GET', url: '/api/runs/spent' })

    expect(list.json()[0].newRunRequired).toBe(true)
    expect(detail.json().newRunRequired).toBe(true)
  })

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


describe('GET /api/runs/:runId/execution-artifacts/:execution/*', () => {
  it('serves one execution\'s retained copy, not a later execution\'s file of the same name', async () => {
    writeManifestForRun('r1')
    const history = path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts-history')
    for (const [n, body] of [[1, 'BEFORE'], [2, 'AFTER']] as const) {
      fs.mkdirSync(path.join(history, `execution-${n}`, 'case-a'), { recursive: true })
      fs.writeFileSync(path.join(history, `execution-${n}`, 'case-a', 'test-failed-1.png'), body)
    }
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/execution-artifacts/1/case-a/test-failed-1.png' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('image/png')
    expect(res.body).toBe('BEFORE')
  })

  it('rejects a malformed execution or a path that leaves its execution dir', async () => {
    writeManifestForRun('r1')
    fs.mkdirSync(path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts-history', 'execution-2', 'case-a'), { recursive: true })
    fs.writeFileSync(path.join(runDirFor(logsDir, 'r1'), 'playwright-artifacts-history', 'execution-2', 'case-a', 'x.png'), 'X')
    const { app } = await build()
    expect((await app.inject({ method: 'GET', url: '/api/runs/r1/execution-artifacts/one/case-a/x.png' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/runs/r1/execution-artifacts/1/..%2Fexecution-2%2Fcase-a%2Fx.png' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/runs/r1/execution-artifacts/2/case-a/missing.png' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/runs/r1/execution-artifacts/2/case-a' })).statusCode).toBe(404)
  })
})

describe('GET /api/runs/:runId/cycle-patches/:iteration', () => {
  it('serves one cycle\'s persisted diff and 404s a cycle that has none', async () => {
    writeManifestForRun('r1')
    const diffs = path.join(runDirFor(logsDir, 'r1'), 'diffs')
    fs.mkdirSync(diffs, { recursive: true })
    fs.writeFileSync(path.join(diffs, 'iteration-2.patch'), '--- a/x\n+++ b/x\n')
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/cycle-patches/2' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ iteration: 2, patchPath: path.join(diffs, 'iteration-2.patch'), diff: '--- a/x\n+++ b/x\n' })
    expect((await app.inject({ method: 'GET', url: '/api/runs/r1/cycle-patches/1' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/runs/r1/cycle-patches/..%2F..' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/runs/nope/cycle-patches/1' })).statusCode).toBe(404)
  })
})

describe('service log excerpts and windows', () => {
  function writeRunWithService(): string {
    const dir = runDirFor(logsDir, 'svc')
    fs.mkdirSync(dir, { recursive: true })
    const logPath = buildRunPaths(dir).serviceLog('api')
    writeManifest(path.join(dir, 'manifest.json'), {
      runId: 'svc', feature: 'foo', featureDir: path.join(featuresDir, 'foo'), startedAt: 'now', status: 'passed', healCycles: 0,
      playwrightExecutions: 1, services: [{ name: 'api', safeName: 'api', command: 'x', cwd: dir, logPath }],
    })
    fs.writeFileSync(logPath, 'boot\n<test-case-pay>\ntotal=95\n</test-case-pay>\n')
    return dir
  }

  it('serves one attempt’s span per service, bounded, and rejects malformed queries', async () => {
    writeRunWithService()
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/svc/service-excerpts?execution=1&name=test-case-pay' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ execution: 1, excerpts: [{ service: 'api', source: 'live', span: { startLine: 3, endLine: 3 }, window: { lines: ['total=95'] } }] })
    expect((await app.inject({ method: 'GET', url: '/api/runs/svc/service-excerpts?execution=x&name=t' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/runs/svc/service-excerpts?execution=1' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/runs/svc/service-excerpts?execution=1&name=t&occurrence=-1' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/runs/nope/service-excerpts?execution=1&name=t' })).statusCode).toBe(404)
    await app.close()
  })

  it('serves a window of a known service’s retained log, and 404s anything else', async () => {
    writeRunWithService()
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/runs/svc/service-logs/api/lines?execution=1&from=2&count=2' })
    expect(res.json()).toEqual({ service: 'api', execution: 1, source: 'live', totalLines: 4, firstLine: 2, lines: ['<test-case-pay>', 'total=95'], truncated: true })
    expect((await app.inject({ method: 'GET', url: '/api/runs/svc/service-logs/api/lines?execution=1' })).json().lines).toHaveLength(4)
    expect((await app.inject({ method: 'GET', url: '/api/runs/svc/service-logs/api/lines?execution=1&from=a' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/runs/svc/service-logs/api/lines' })).statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: '/api/runs/svc/service-logs/..%2Fmanifest/lines?execution=1' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/runs/svc/service-logs/api/lines?execution=7' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/runs/nope/service-logs/api/lines?execution=1' })).statusCode).toBe(404)
    await app.close()
  })
})

describe('GET /api/runs/:runId/queue', () => {
  it('reads the live queue only for a queued run, without mutating its manifest', async () => {
    writeManifestForRun('q', 'foo', 'queued')
    writeManifestForRun('done')
    const queueDiagnostics = vi.fn(() => null)
    const { app } = await build({ queueDiagnostics })
    expect((await app.inject('/api/runs/q/queue')).json()).toEqual({ diagnostics: null })
    expect(queueDiagnostics).toHaveBeenCalledExactlyOnceWith('q')
    expect((await app.inject('/api/runs/done/queue')).json()).toEqual({ diagnostics: null })
    expect((await app.inject('/api/runs/missing/queue')).statusCode).toBe(404)
    expect(queueDiagnostics).toHaveBeenCalledTimes(1)
    expect((await app.inject('/api/runs/q')).json().manifest.status).toBe('queued')
    await app.close()
  })
})
