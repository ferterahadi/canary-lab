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

const PREFLIGHT_PUSHABLE = {
  gh: { installed: true, authenticated: true, account: 'me', host: 'github.com' },
  anyPushable: true,
  repos: [{ repoName: 'prod', repoRoot: '/repos/prod', origin: { owner: 'org', name: 'prod', host: 'github.com' }, base: 'main', pushable: true }],
}

/** A failed run whose manifest carries a fix capture — the precondition both
 *  PR routes gate on. */
function writeManifestWithCapture(
  runId: string,
  repos: RunManifest['fixCapture'] extends { repos: infer R } | undefined ? R | undefined : never = undefined,
  extra: Partial<RunManifest> = {},
): void {
  const dir = runDirFor(logsDir, runId)
  fs.mkdirSync(dir, { recursive: true })
  writeManifest(path.join(dir, 'manifest.json'), {
    runId,
    feature: 'foo',
    featureDir: path.join(featuresDir, 'foo'),
    startedAt: 'now',
    status: 'failed',
    healCycles: 1,
    services: [],
    fixCapture: {
      capturedAt: 'now',
      repos: repos ?? [{ repoName: 'prod', patchPath: '/p.patch', patchFile: 'p.patch', repoRoot: '/repos/prod', baseSha: 'abc', files: 1 }],
    },
    ...extra,
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

describe('GitHub / PR routes (R80)', () => {
  it('GET /api/gh/status returns a status shape', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'GET', url: '/api/gh/status' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveProperty('installed')
    expect(res.json()).toHaveProperty('authenticated')
  })

  it('pr-preflight + propose-pr 404 for an unknown run, 409 with no captured fixes', async () => {
    writeManifestForRun('r1', 'foo', 'failed')
    const { app } = await build()
    expect((await app.inject({ method: 'GET', url: '/api/runs/nope/pr-preflight' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'POST', url: '/api/runs/nope/propose-pr' })).statusCode).toBe(404)
    expect((await app.inject({ method: 'GET', url: '/api/runs/r1/pr-preflight' })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/api/runs/r1/propose-pr' })).statusCode).toBe(409)
  })

  it('409s both routes when the capture exists but lists no repos', async () => {
    writeManifestWithCapture('r1', [])
    const { app } = await build()
    expect((await app.inject({ method: 'GET', url: '/api/runs/r1/pr-preflight' })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/api/runs/r1/propose-pr' })).statusCode).toBe(409)
  })

  it('GET pr-preflight returns the preflight for the run capture', async () => {
    writeManifestWithCapture('r1')
    prMocks.buildPrPreflight.mockResolvedValueOnce(PREFLIGHT_PUSHABLE)
    const { app } = await build()

    const res = await app.inject({ method: 'GET', url: '/api/runs/r1/pr-preflight' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(PREFLIGHT_PUSHABLE)
    expect(prMocks.buildPrPreflight).toHaveBeenCalledWith(
      expect.objectContaining({ repos: [expect.objectContaining({ repoName: 'prod' })] }),
    )
  })

  it('POST propose-pr 409s (with the preflight) when no repo is pushable', async () => {
    writeManifestWithCapture('r1')
    prMocks.buildPrPreflight.mockResolvedValueOnce({ ...PREFLIGHT_PUSHABLE, anyPushable: false })
    const { app } = await build()

    const res = await app.inject({ method: 'POST', url: '/api/runs/r1/propose-pr' })

    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/no repo is pushable/i)
    // The dialog renders the blocked reasons from this payload, so it must ride along.
    expect(res.json().preflight.anyPushable).toBe(false)
    expect(prMocks.proposeFixesForRun).not.toHaveBeenCalled()
  })

  it('POST propose-pr persists opened PRs into the manifest', async () => {
    writeManifestWithCapture('r1')
    prMocks.buildPrPreflight.mockResolvedValueOnce(PREFLIGHT_PUSHABLE)
    prMocks.proposeFixesForRun.mockResolvedValueOnce([
      { repoName: 'prod', ok: true, pr: { repoName: 'prod', url: 'https://github.com/org/prod/pull/1', branch: 'b', base: 'main', createdAt: 'T' } },
      { repoName: 'other', ok: false, reason: 'patch conflict' },
    ])
    const { app } = await build()

    const res = await app.inject({ method: 'POST', url: '/api/runs/r1/propose-pr' })

    expect(res.statusCode).toBe(200)
    expect(res.json().results).toHaveLength(2)
    expect(prMocks.proposeFixesForRun).toHaveBeenCalledWith(expect.objectContaining({ runId: 'r1', feature: 'foo' }))
    const saved = readManifest(path.join(runDirFor(logsDir, 'r1'), 'manifest.json'))!
    expect(saved.proposedPrs).toEqual([
      { repoName: 'prod', url: 'https://github.com/org/prod/pull/1', branch: 'b', base: 'main', createdAt: 'T' },
    ])
  })

  it('POST propose-pr upserts by repo name over previously proposed PRs', async () => {
    // A retry re-opens the same repo's PR; the row is replaced, not duplicated,
    // and an unrelated earlier PR survives.
    writeManifestWithCapture('r1', undefined, {
      proposedPrs: [
        { repoName: 'prod', url: 'https://github.com/org/prod/pull/OLD', branch: 'b', base: 'main', createdAt: 'T0' },
        { repoName: 'keep', url: 'https://github.com/org/keep/pull/9', branch: 'k', base: 'main', createdAt: 'T0' },
      ],
    })
    prMocks.buildPrPreflight.mockResolvedValueOnce(PREFLIGHT_PUSHABLE)
    prMocks.proposeFixesForRun.mockResolvedValueOnce([
      { repoName: 'prod', ok: true, pr: { repoName: 'prod', url: 'https://github.com/org/prod/pull/NEW', branch: 'b', base: 'main', createdAt: 'T1' } },
    ])
    const { app } = await build()

    await app.inject({ method: 'POST', url: '/api/runs/r1/propose-pr' })

    const saved = readManifest(path.join(runDirFor(logsDir, 'r1'), 'manifest.json'))!
    expect(saved.proposedPrs?.map((p) => [p.repoName, p.url])).toEqual([
      ['prod', 'https://github.com/org/prod/pull/NEW'],
      ['keep', 'https://github.com/org/keep/pull/9'],
    ])
  })

  it('POST propose-pr leaves the manifest alone when nothing opened', async () => {
    writeManifestWithCapture('r1')
    prMocks.buildPrPreflight.mockResolvedValueOnce(PREFLIGHT_PUSHABLE)
    prMocks.proposeFixesForRun.mockResolvedValueOnce([{ repoName: 'prod', ok: false, reason: 'push rejected' }])
    const { app } = await build()

    const res = await app.inject({ method: 'POST', url: '/api/runs/r1/propose-pr' })

    expect(res.statusCode).toBe(200)
    expect(readManifest(path.join(runDirFor(logsDir, 'r1'), 'manifest.json'))!.proposedPrs).toBeUndefined()
  })
})
