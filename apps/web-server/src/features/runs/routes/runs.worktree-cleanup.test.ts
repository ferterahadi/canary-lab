import { describe, it, expect, beforeEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Fastify from 'fastify'
import { runsRoutes, type ExternalHealAgentRequest } from './runs'
import { compareActiveRuns } from './runs-route-support'
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

function writeFeature(name: string): void {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: ${JSON.stringify(name)}, description: 'd', envs: [], featureDir: __dirname } }`,
  )
}

function writeFeatureWithRepos(name: string, repos: Array<{ name: string; localPath: string }>): void {
  const dir = path.join(featuresDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'feature.config.cjs'),
    `module.exports = { config: { name: ${JSON.stringify(name)}, description: 'd', envs: [], repos: ${JSON.stringify(repos)}, featureDir: __dirname } }`,
  )
}

function gitInit(dir: string): void {
  const opts = { cwd: dir, stdio: 'ignore' as const }
  execFileSync('git', ['init', '-q'], opts)
  execFileSync('git', ['config', 'user.email', 'test@example.com'], opts)
  execFileSync('git', ['config', 'user.name', 'Test'], opts)
  execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'init'], opts)
}

function addGitWorktree(sourceRepo: string, worktreePath: string): void {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true })
  execFileSync('git', ['worktree', 'add', '-q', '--detach', worktreePath], { cwd: sourceRepo, stdio: 'ignore' })
}

// Sets up 3 features exercising every branch of featureRepoRoots(): one with
// a real git repo (root resolves), one with no `repos` field at all (the
// `feature.repos ?? []` fallback), and one whose repo path doesn't exist on
// disk (getGitRoot resolves to null, root stays unadded). Also creates two
// real worktrees under the logs dir: one following the `runs/<id>/worktrees`
// convention (ownerKind 'run') and one that doesn't (ownerKind 'unknown').
function setupWorktreeFixtures(): { sourceRepo: string; runWorktree: string; miscWorktree: string } {
  const sourceRepo = path.join(tmpDir, 'source-repo')
  fs.mkdirSync(sourceRepo, { recursive: true })
  gitInit(sourceRepo)
  writeFeatureWithRepos('foo', [{ name: 'app', localPath: sourceRepo }])
  writeFeature('bare')
  writeFeatureWithRepos('ghostrepo', [{ name: 'x', localPath: path.join(tmpDir, 'does-not-exist') }])
  const runWorktree = path.join(logsDir, 'runs', 'wt-run-1', 'worktrees', 'app')
  addGitWorktree(sourceRepo, runWorktree)
  const miscWorktree = path.join(logsDir, 'misc', 'app2')
  addGitWorktree(sourceRepo, miscWorktree)
  return { sourceRepo, runWorktree, miscWorktree }
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

describe('cleanup/worktrees routes (real git worktrees)', () => {
  it('GET lists worktrees classified by owner, with `active` computed via isWorktreeOwnerActive', async () => {
    const { runWorktree, miscWorktree } = setupWorktreeFixtures()
    const { app } = await build({
      isWorktreeOwnerActive: (kind, id) => kind === 'run' && id === 'wt-run-1',
    })

    const res = await app.inject({ method: 'GET', url: '/api/cleanup/worktrees' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { worktrees: Array<{ path: string; ownerKind: string; ownerId: string | null; active: boolean }> }
    const run = body.worktrees.find((w) => w.path === runWorktree)
    const misc = body.worktrees.find((w) => w.path === miscWorktree)
    expect(run).toMatchObject({ ownerKind: 'run', ownerId: 'wt-run-1', active: true })
    expect(misc).toMatchObject({ ownerKind: 'unknown', ownerId: null, active: false })
  })

  describe('POST /api/cleanup/worktrees/open', () => {
    it('400s when path is missing', async () => {
      const { app } = await build()
      const res = await app.inject({ method: 'POST', url: '/api/cleanup/worktrees/open', payload: {} })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'path is required' })
    })

    it('400s when path is outside the logs directory', async () => {
      const { app } = await build()
      const res = await app.inject({
        method: 'POST',
        url: '/api/cleanup/worktrees/open',
        payload: { path: path.join(tmpDir, 'outside') },
      })
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'path must be inside the logs directory' })
    })

    it('404s when the directory does not exist on disk', async () => {
      const { app } = await build()
      const target = path.join(logsDir, 'runs', 'ghost', 'worktrees', 'app')
      const res = await app.inject({ method: 'POST', url: '/api/cleanup/worktrees/open', payload: { path: target } })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'worktree directory not found' })
    })

    it('200s opened:true and resolves the editor via loadProjectConfig when projectRoot is set', async () => {
      vi.mocked(launchEditorDir).mockReturnValueOnce('cursor')
      const target = path.join(logsDir, 'runs', 'r1', 'worktrees', 'app')
      fs.mkdirSync(target, { recursive: true })
      // tmpDir has no canary-lab.config.json → loadProjectConfig falls back
      // to its own default ('auto'), proving the projectRoot branch ran.
      const { app } = await build({ projectRoot: tmpDir })
      const res = await app.inject({ method: 'POST', url: '/api/cleanup/worktrees/open', payload: { path: target } })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ opened: true, path: target, editor: 'cursor' })
      expect(vi.mocked(launchEditorDir)).toHaveBeenCalledWith('auto', target)
    })

    it('200s opened:false with err.message when launchEditorDir throws a real Error', async () => {
      vi.mocked(launchEditorDir).mockImplementationOnce(() => { throw new Error('editor binary not found') })
      const target = path.join(logsDir, 'runs', 'r2b', 'worktrees', 'app')
      fs.mkdirSync(target, { recursive: true })
      const { app } = await build()
      const res = await app.inject({ method: 'POST', url: '/api/cleanup/worktrees/open', payload: { path: target } })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ opened: false, path: target, error: 'editor binary not found' })
    })

    it('200s opened:false with a stringified error when launchEditorDir throws a non-Error value', async () => {
      vi.mocked(launchEditorDir).mockImplementationOnce(() => { throw 'spawn exploded' })
      const target = path.join(logsDir, 'runs', 'r2', 'worktrees', 'app')
      fs.mkdirSync(target, { recursive: true })
      const { app } = await build()
      const res = await app.inject({ method: 'POST', url: '/api/cleanup/worktrees/open', payload: { path: target } })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ opened: false, path: target, error: 'spawn exploded' })
    })
  })

  describe('DELETE /api/cleanup/worktrees', () => {
    it('400s when path is missing', async () => {
      const { app } = await build()
      const res = await app.inject({ method: 'DELETE', url: '/api/cleanup/worktrees', payload: {} })
      expect(res.statusCode).toBe(400)
    })

    it('400s when path is outside the logs directory', async () => {
      const { app } = await build()
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/cleanup/worktrees',
        payload: { path: path.join(tmpDir, 'outside') },
      })
      expect(res.statusCode).toBe(400)
    })

    it('404s when no worktree entry matches the path', async () => {
      setupWorktreeFixtures()
      const { app } = await build()
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/cleanup/worktrees',
        payload: { path: path.join(logsDir, 'runs', 'nope', 'worktrees', 'app') },
      })
      expect(res.statusCode).toBe(404)
      expect(res.json()).toEqual({ error: 'worktree not found' })
    })

    it('409s and leaves the worktree in place when it belongs to an active run', async () => {
      const { runWorktree } = setupWorktreeFixtures()
      const { app } = await build({ isWorktreeOwnerActive: () => true })
      const res = await app.inject({ method: 'DELETE', url: '/api/cleanup/worktrees', payload: { path: runWorktree } })
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'worktree belongs to an active run — abort it first' })
      expect(fs.existsSync(runWorktree)).toBe(true)
    })

    it('200s, removes the worktree via git, and returns freedBytes', async () => {
      const { runWorktree } = setupWorktreeFixtures()
      fs.writeFileSync(path.join(runWorktree, 'data.bin'), Buffer.alloc(64))
      const { app } = await build({ isWorktreeOwnerActive: () => false })
      const res = await app.inject({ method: 'DELETE', url: '/api/cleanup/worktrees', payload: { path: runWorktree } })
      expect(res.statusCode).toBe(200)
      const body = res.json() as { removed: boolean; freedBytes: number }
      expect(body.removed).toBe(true)
      expect(body.freedBytes).toBeGreaterThan(0)
      expect(fs.existsSync(runWorktree)).toBe(false)
    })

    it('200s removing a worktree with no run/benchmark owner without consulting isWorktreeOwnerActive', async () => {
      // ownerKind 'unknown' short-circuits the `active` ternary to `false`
      // directly — distinct from the ownerKind 'run' cases above, which both
      // route through deps.isWorktreeOwnerActive?.(...).
      const { miscWorktree } = setupWorktreeFixtures()
      const isWorktreeOwnerActive = vi.fn(() => true)
      const { app } = await build({ isWorktreeOwnerActive })
      const res = await app.inject({ method: 'DELETE', url: '/api/cleanup/worktrees', payload: { path: miscWorktree } })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ removed: true })
      expect(isWorktreeOwnerActive).not.toHaveBeenCalled()
      expect(fs.existsSync(miscWorktree)).toBe(false)
    })
  })
})

describe('compareActiveRuns ordering', () => {
  const mk = (startedAt: string, opts: { phase?: string; status?: string } = {}) =>
    ({
      startedAt,
      detail: {
        manifest: {
          ...(opts.phase ? { lifecycle: { phase: opts.phase } } : {}),
          status: opts.status ?? 'healing',
        },
      },
    }) as Parameters<typeof compareActiveRuns>[0]

  it('orders a lower-priority run (waiting-for-signal) ahead of a healing one', () => {
    const waiting = mk('t', { phase: 'waiting-for-signal' })
    const healing = mk('t', { status: 'healing' })
    expect(compareActiveRuns(waiting, healing)).toBeLessThan(0)
    expect(compareActiveRuns(healing, waiting)).toBeGreaterThan(0)
  })

  it('sends a non-active status to the lowest priority bucket', () => {
    const healing = mk('t', { status: 'healing' })
    const other = mk('t', { status: 'passed' })
    expect(compareActiveRuns(healing, other)).toBeLessThan(0)
  })

  it('at equal priority, orders newest startedAt first in both directions and ties to 0', () => {
    const newer = mk('2026-01-02T00:00:00.000Z')
    const older = mk('2026-01-01T00:00:00.000Z')
    expect(compareActiveRuns(older, newer)).toBe(1) // a < b → a sorts after b
    expect(compareActiveRuns(newer, older)).toBe(-1) // a > b → a sorts before b
    expect(compareActiveRuns(newer, mk('2026-01-02T00:00:00.000Z'))).toBe(0) // tie
  })
})

describe('POST /api/runs/:runId/apply-fixes (R80)', () => {
  it('404 when the run is unknown', async () => {
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs/nope/apply-fixes' })
    expect(res.statusCode).toBe(404)
  })

  it('409 when the run captured no fixes', async () => {
    writeManifestForRun('r1', 'foo', 'failed')
    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs/r1/apply-fixes' })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toMatch(/no fixes/i)
  })

  it('applies the captured patch into the real repo and reports per-repo results', async () => {
    // A real repo + a real patch turning x=1 → x=2.
    const repo = path.join(tmpDir, 'prod-repo')
    fs.mkdirSync(repo, { recursive: true })
    fs.writeFileSync(path.join(repo, 'app.js'), 'const x = 1\n')
    const g = (args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
    g(['init', '-q']); g(['config', 'user.email', 't@t']); g(['config', 'user.name', 't'])
    g(['add', '-A']); g(['commit', '-q', '-m', 'init', '--no-verify'])
    const scratch = path.join(tmpDir, 'scratch')
    execFileSync('git', ['clone', '-q', repo, scratch], { stdio: 'ignore' })
    fs.writeFileSync(path.join(scratch, 'app.js'), 'const x = 2\n')
    const patch = execFileSync('git', ['diff'], { cwd: scratch }).toString()

    const runDir = runDirFor(logsDir, 'r1')
    fs.mkdirSync(path.join(runDir, 'fixes'), { recursive: true })
    const patchPath = path.join(runDir, 'fixes', 'prod.patch')
    fs.writeFileSync(patchPath, patch)
    writeManifest(path.join(runDir, 'manifest.json'), {
      runId: 'r1', feature: 'foo', featureDir: path.join(featuresDir, 'foo'),
      startedAt: 'now', status: 'failed', healCycles: 1, services: [],
      fixCapture: { capturedAt: 'now', repos: [{ repoName: 'prod', patchPath, patchFile: 'prod.patch', repoRoot: repo, baseSha: 'deadbeef', files: 1 }] },
    })

    const { app } = await build()
    const res = await app.inject({ method: 'POST', url: '/api/runs/r1/apply-fixes' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ results: [{ repoName: 'prod', ok: true }], allOk: true })
    expect(fs.readFileSync(path.join(repo, 'app.js'), 'utf-8')).toBe('const x = 2\n')
  })
})
