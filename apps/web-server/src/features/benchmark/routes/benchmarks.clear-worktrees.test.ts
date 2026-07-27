import path from 'path'
import { afterEach, describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { benchmarkRoutes } from './benchmarks'
import { launchEditorDir } from '../../../shared/editor-launch'
import { addWorktree, removeWorktree } from '../../runs/logic/runtime/repo-worktree'
import { listWorktrees } from '../../runs/logic/runtime/worktree-inventory'
import { loadProjectConfig } from '../../runs/logic/runtime/launcher/project-config'
import { loadFeatures } from '../../../shared/feature-loader'
import { getGitRoot } from '../../../shared/git-repo'
import type { BenchmarkStore } from '../logic/runtime/store'
import type { SabotageSkill } from '../logic/runtime/skills'
import type { BenchmarkManifest, StartBenchmarkInput } from '../logic/runtime/types'

vi.mock('../../../shared/editor-launch', () => ({ launchEditorDir: vi.fn(() => 'vscode') }))

vi.mock('../../runs/logic/runtime/repo-worktree', () => ({ addWorktree: vi.fn(), removeWorktree: vi.fn(async () => {}) }))

vi.mock('../../runs/logic/runtime/worktree-inventory', () => ({ listWorktrees: vi.fn(async () => []) }))

vi.mock('../../../shared/feature-loader', () => ({ loadFeatures: vi.fn(() => []) }))

vi.mock('../../../shared/git-repo', async (orig) => ({
  ...(await orig<typeof import('../../../shared/git-repo')>()),
  getGitRoot: vi.fn().mockResolvedValue(null),
}))

vi.mock('../../runs/logic/runtime/launcher/project-config', () => ({ loadProjectConfig: vi.fn(() => ({ editor: 'cursor' })) }))

function manifest(over: Partial<BenchmarkManifest> = {}): BenchmarkManifest {
  return {
    benchmarkId: 'b1',
    feature: 'example_todo_api',
    skill: 'broken-delete-contract',
    level: 'med',
    iterations: 2,
    agent: 'claude',
    status: 'running',
    startedAt: '2026-06-03T00:00:00.000Z',
    currentIteration: 1,
    arms: [],
    results: [],
    ...over,
  }
}

function fakeStore(over: Partial<BenchmarkStore> = {}): BenchmarkStore {
  return {
    list: () => [],
    get: () => null,
    save: () => {},
    onEvent: () => {},
    offEvent: () => {},
    ...over,
  }
}

async function buildApp(deps: {
  store?: BenchmarkStore
  logsDir?: string
  featuresDir?: string
  projectRoot?: string
  startBenchmark?: (input: StartBenchmarkInput) => Promise<{ benchmarkId: string }>
  listSkills?: (feature: string) => SabotageSkill[]
  abortBenchmark?: (id: string) => void
  loadAgentSession?: (id: string) => { agent: string; sessionId: string; events: unknown[] } | null
}) {
  const app = Fastify()
  await app.register(benchmarkRoutes, {
    store: deps.store ?? fakeStore(),
    logsDir: deps.logsDir ?? '/logs',
    featuresDir: deps.featuresDir ?? '/features',
    projectRoot: deps.projectRoot,
    startBenchmark: deps.startBenchmark ?? (async () => ({ benchmarkId: 'b1' })),
    listSkills: deps.listSkills ?? (() => []),
    abortBenchmark: deps.abortBenchmark ?? (() => {}),
    loadAgentSession: deps.loadAgentSession ?? (() => null),
  })
  return app
}

describe('benchmarkRoutes', () => {
  describe('POST /api/benchmarks/:id/clear-worktrees', () => {
    afterEach(() => vi.clearAllMocks())

    const clear = (body?: { confirm?: boolean }) =>
      ({ method: 'POST' as const, url: '/api/benchmarks/b1/clear-worktrees', payload: body ?? {} })

    it('404s when the benchmark is unknown', async () => {
      const app = await buildApp({ store: fakeStore({ get: () => null }) })
      const res = await app.inject(clear())
      expect(res.statusCode).toBe(404)
      await app.close()
    })

    it('409s while the benchmark is still running', async () => {
      const app = await buildApp({ store: fakeStore({ get: () => manifest({ status: 'running' }) }) })
      const res = await app.inject(clear({ confirm: true }))
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'cannot clear worktrees while the benchmark is still running' })
      await app.close()
    })

    it('dry run (no confirm) reports the disk it would free without removing or saving', async () => {
      const saved: BenchmarkManifest[] = []
      vi.mocked(listWorktrees).mockResolvedValue([
        { path: '/wt/a', sourceRoot: '/src', ref: 'sha', ownerKind: 'benchmark', ownerId: 'b1', slot: 'arm-A', bytes: 200, ageMs: 0, exists: true },
        { path: '/wt/s', sourceRoot: '/src', ref: 'sha', ownerKind: 'benchmark', ownerId: 'b1', slot: 'staging', bytes: 112, ageMs: 0, exists: true },
        { path: '/wt/other', sourceRoot: '/src', ref: 'sha', ownerKind: 'benchmark', ownerId: 'other', slot: 'arm-A', bytes: 999, ageMs: 0, exists: true },
      ])
      const app = await buildApp({
        store: fakeStore({ get: () => manifest({ status: 'done' }), save: (m) => { saved.push(m) } }),
      })
      const res = await app.inject(clear())
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ confirmed: false, willClear: 2, cleared: 0, freedBytes: 312 })
      expect(vi.mocked(removeWorktree)).not.toHaveBeenCalled()
      expect(saved).toHaveLength(0)
      await app.close()
    })

    it('confirm removes the benchmark-owned worktrees and persists the cleared flag', async () => {
      const saved: BenchmarkManifest[] = []
      // A feature with a repo so featureRepoRoots() iterates (resolving git roots).
      vi.mocked(loadFeatures).mockReturnValueOnce([
        { name: 'f', description: 'd', envs: ['local'], featureDir: '/f',
          repos: [{ name: 'r', localPath: '/tmp/portify-nonexistent-repo' }] },
      ])
      vi.mocked(listWorktrees).mockResolvedValue([
        { path: '/wt/a', sourceRoot: '/src', ref: 'sha', ownerKind: 'benchmark', ownerId: 'b1', slot: 'arm-A', bytes: 200, ageMs: 0, exists: true },
        { path: '/wt/s', sourceRoot: '/src', ref: 'sha', ownerKind: 'benchmark', ownerId: 'b1', slot: 'staging', bytes: 112, ageMs: 0, exists: true },
      ])
      const app = await buildApp({
        store: fakeStore({ get: () => manifest({ status: 'done' }), save: (m) => { saved.push(m) } }),
      })
      const res = await app.inject(clear({ confirm: true }))
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ confirmed: true, willClear: 2, cleared: 2, freedBytes: 312 })
      expect(vi.mocked(removeWorktree)).toHaveBeenCalledTimes(2)
      expect(vi.mocked(removeWorktree)).toHaveBeenCalledWith({ sourceRoot: '/src', worktreeRoot: '/wt/a' })
      expect(saved).toHaveLength(1)
      expect(saved[0]).toMatchObject({ worktreesCleared: true, worktreesClearedBytes: 312 })
      await app.close()
    })

    it('resolves feature repo roots, skipping unresolvable/throwing repos', async () => {
      // Exercise featureRepoRoots: one repo resolves to a git root, one returns
      // null (skipped), one throws (caught + skipped).
      vi.mocked(loadFeatures).mockReturnValueOnce([
        { name: 'f', description: 'd', envs: ['local'], featureDir: '/f',
          repos: [{ name: 'a', localPath: '/a' }, { name: 'b', localPath: '/b' }, { name: 'c', localPath: '/c' }] },
        // A feature with no repos at all → exercises the `repos ?? []` fallback.
        { name: 'g', description: 'd', envs: ['local'], featureDir: '/g' },
      ])
      vi.mocked(getGitRoot)
        .mockResolvedValueOnce('/git/root-a')
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('not resolvable'))
      vi.mocked(listWorktrees).mockResolvedValue([])
      const app = await buildApp({ store: fakeStore({ get: () => manifest({ status: 'done' }), save: () => {} }) })
      const res = await app.inject(clear({ confirm: true }))
      expect(res.statusCode).toBe(200)
      await app.close()
    })

    it('reports freedBytes 0 when an already-cleared benchmark has no recorded bytes', async () => {
      const app = await buildApp({
        store: fakeStore({ get: () => manifest({ status: 'done', worktreesCleared: true }) }),
      })
      const res = await app.inject(clear({ confirm: true }))
      expect(res.json()).toEqual({ confirmed: false, willClear: 0, cleared: 0, freedBytes: 0, alreadyCleared: true })
      await app.close()
    })

    it('swallows a worktree removal failure and still records the cleared flag', async () => {
      const saved: BenchmarkManifest[] = []
      vi.mocked(listWorktrees).mockResolvedValue([
        { path: '/wt/a', sourceRoot: '/src', ref: 'sha', ownerKind: 'benchmark', ownerId: 'b1', slot: 'arm-A', bytes: 10, ageMs: 0, exists: true },
      ])
      vi.mocked(removeWorktree).mockRejectedValueOnce(new Error('rm failed'))
      const app = await buildApp({
        store: fakeStore({ get: () => manifest({ status: 'done' }), save: (m) => { saved.push(m) } }),
      })
      const res = await app.inject(clear({ confirm: true }))
      expect(res.statusCode).toBe(200)
      expect(saved).toHaveLength(1)
      await app.close()
    })

    it('is idempotent once cleared (no second removal)', async () => {
      const app = await buildApp({
        store: fakeStore({ get: () => manifest({ status: 'done', worktreesCleared: true, worktreesClearedBytes: 312 }) }),
      })
      const res = await app.inject(clear({ confirm: true }))
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ confirmed: false, willClear: 0, cleared: 0, freedBytes: 312, alreadyCleared: true })
      expect(vi.mocked(removeWorktree)).not.toHaveBeenCalled()
      await app.close()
    })
  })
})
