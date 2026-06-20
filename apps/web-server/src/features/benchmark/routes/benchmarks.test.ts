import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { benchmarkRoutes } from '../../benchmark/routes/benchmarks'
import { launchEditorDir } from '../../../shared/editor-launch'
import { addWorktree, removeWorktree } from '../../runs/logic/runtime/repo-worktree'
import { listWorktrees } from '../../runs/logic/runtime/worktree-inventory'
import { loadProjectConfig } from '../../runs/logic/runtime/launcher/project-config'
import { loadFeatures } from '../../config/logic/feature-loader'
import { getGitRoot } from '../../../shared/git-repo'
import type { BenchmarkStore } from '../../benchmark/logic/runtime/store'
import type { SabotageSkill } from '../../benchmark/logic/runtime/skills'
import type { BenchmarkManifest, StartBenchmarkInput } from '../../benchmark/logic/runtime/types'

vi.mock('../../../shared/editor-launch', () => ({ launchEditorDir: vi.fn(() => 'vscode') }))
vi.mock('../../runs/logic/runtime/repo-worktree', () => ({ addWorktree: vi.fn(), removeWorktree: vi.fn(async () => {}) }))
vi.mock('../../runs/logic/runtime/worktree-inventory', () => ({ listWorktrees: vi.fn(async () => []) }))
vi.mock('../../config/logic/feature-loader', () => ({ loadFeatures: vi.fn(() => []) }))
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
  readSabotageLog?: (id: string) => string
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
    readSabotageLog: deps.readSabotageLog ?? (() => ''),
    loadAgentSession: deps.loadAgentSession ?? (() => null),
  })
  return app
}

describe('benchmarkRoutes', () => {
  it('POST /api/benchmarks starts a benchmark and returns its id', async () => {
    let received: StartBenchmarkInput | undefined
    const app = await buildApp({
      startBenchmark: async (input) => {
        received = input
        return { benchmarkId: 'bench-xyz' }
      },
    })
    const res = await app.inject({
      method: 'POST',
      url: '/api/benchmarks',
      payload: { feature: 'example_todo_api', skill: 'broken-delete-contract', level: 'med', iterations: 2 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ benchmarkId: 'bench-xyz' })
    expect(received).toMatchObject({ feature: 'example_todo_api', level: 'med', iterations: 2 })
    await app.close()
  })

  it('POST /api/benchmarks 400s when feature is missing', async () => {
    const app = await buildApp({})
    const res = await app.inject({ method: 'POST', url: '/api/benchmarks', payload: { skill: 's', level: 'med', iterations: 2 } })
    expect(res.statusCode).toBe(400)
    await app.close()
  })

  it('POST /api/benchmarks 400s when the body is absent entirely', async () => {
    const app = await buildApp({})
    const res = await app.inject({ method: 'POST', url: '/api/benchmarks' })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'feature is required' })
    await app.close()
  })

  it('GET /api/benchmarks/preflight reports unconfigured + configured + env', async () => {
    const app = await buildApp({})
    vi.mocked(loadFeatures).mockReturnValue([
      { name: 'cns', description: 'd', envs: ['local'], featureDir: '/f',
        repos: [{ name: 'app', localPath: '~/app', startCommands: ['yarn start'] }] },
    ])
    const unconfigured = await app.inject({ method: 'GET', url: '/api/benchmarks/preflight?feature=cns' })
    expect(unconfigured.statusCode).toBe(200)
    expect(unconfigured.json()).toMatchObject({ portsConfigured: false })

    vi.mocked(loadFeatures).mockReturnValue([
      { name: 'cns', description: 'd', envs: ['local'], featureDir: '/f',
        repos: [{ name: 'app', localPath: '~/app', startCommands: [{ command: 'x', ports: [{ name: 'api', env: 'PORT' }] }] }] },
    ])
    const configured = await app.inject({ method: 'GET', url: '/api/benchmarks/preflight?feature=cns&env=local' })
    expect(configured.json()).toMatchObject({ portsConfigured: true })
    await app.close()
  })

  it('GET /api/benchmarks/preflight 400s without a feature, 404s for an unknown one', async () => {
    const app = await buildApp({})
    vi.mocked(loadFeatures).mockReturnValue([])
    const missing = await app.inject({ method: 'GET', url: '/api/benchmarks/preflight' })
    expect(missing.statusCode).toBe(400)
    const unknown = await app.inject({ method: 'GET', url: '/api/benchmarks/preflight?feature=nope' })
    expect(unknown.statusCode).toBe(404)
    await app.close()
  })

  it('POST /api/benchmarks normalizes the agent (codex/claude/unset)', async () => {
    const received: Array<string | undefined> = []
    const app = await buildApp({
      startBenchmark: async (input) => {
        received.push(input.agent)
        return { benchmarkId: 'b' }
      },
    })
    for (const [agent, expected] of [['codex', 'codex'], ['claude', 'claude'], ['weird', undefined], [undefined, undefined]] as const) {
      await app.inject({ method: 'POST', url: '/api/benchmarks', payload: { feature: 'f', agent } })
    }
    expect(received).toEqual(['codex', 'claude', undefined, undefined])
    await app.close()
  })

  it('GET /api/benchmark-skills defaults to an empty feature when none is given', async () => {
    let askedFor: string | undefined
    const app = await buildApp({ listSkills: (feature) => { askedFor = feature; return [] } })
    const res = await app.inject({ method: 'GET', url: '/api/benchmark-skills' })
    expect(res.statusCode).toBe(200)
    expect(askedFor).toBe('')
    await app.close()
  })

  it('GET /api/benchmarks returns the index', async () => {
    const app = await buildApp({
      store: fakeStore({
        list: () => [
          { benchmarkId: 'b1', feature: 'f', level: 'med', status: 'done', startedAt: 't' },
        ],
      }),
    })
    const res = await app.inject({ method: 'GET', url: '/api/benchmarks' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toHaveLength(1)
    expect(res.json()[0].benchmarkId).toBe('b1')
    await app.close()
  })

  it('POST /api/benchmarks/:id/abort calls abortBenchmark', async () => {
    let aborted = ''
    const app = await buildApp({ abortBenchmark: (id) => { aborted = id } })
    const res = await app.inject({ method: 'POST', url: '/api/benchmarks/b1/abort' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect(aborted).toBe('b1')
    await app.close()
  })

  it('GET /api/benchmark-skills returns skill summaries (recipe/dir stripped)', async () => {
    const app = await buildApp({
      listSkills: () => [
        {
          name: 'off-by-one',
          title: 'Off-by-one nudge',
          level: 'min',
          summary: 'one subtle bug',
          description: 'desc',
          recipe: 'secret recipe',
          appliesTo: ['example_todo_api'],
          dir: '/abs',
        },
      ],
    })
    const res = await app.inject({ method: 'GET', url: '/api/benchmark-skills?feature=example_todo_api' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual([
      { name: 'off-by-one', title: 'Off-by-one nudge', level: 'min', summary: 'one subtle bug', description: 'desc', recipe: 'secret recipe' },
    ])
    await app.close()
  })

  it('POST /api/benchmarks surfaces the thrown statusCode + message', async () => {
    const app = await buildApp({
      startBenchmark: async () => {
        throw Object.assign(new Error('A benchmark is already running'), { statusCode: 409 })
      },
    })
    const res = await app.inject({ method: 'POST', url: '/api/benchmarks', payload: { feature: 'f' } })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toEqual({ error: 'A benchmark is already running' })
    await app.close()
  })

  it('POST /api/benchmarks defaults to 500 + stringifies a non-Error throw', async () => {
    const app = await buildApp({
      startBenchmark: async () => { throw 'boom' },
    })
    const res = await app.inject({ method: 'POST', url: '/api/benchmarks', payload: { feature: 'f' } })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'boom' })
    await app.close()
  })

  it('GET /api/benchmarks/:id/sabotage-log returns the captured log', async () => {
    const app = await buildApp({ readSabotageLog: (id) => `log for ${id}` })
    const res = await app.inject({ method: 'GET', url: '/api/benchmarks/b1/sabotage-log' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ log: 'log for b1' })
    await app.close()
  })

  it('GET /api/benchmarks/:id/agent-session returns the session, 404 when none', async () => {
    const app = await buildApp({
      loadAgentSession: (id) =>
        id === 'b1' ? { agent: 'claude', sessionId: 's1', events: [{ t: 'x' }] } : null,
    })
    const hit = await app.inject({ method: 'GET', url: '/api/benchmarks/b1/agent-session' })
    expect(hit.statusCode).toBe(200)
    expect(hit.json()).toEqual({ agent: 'claude', sessionId: 's1', events: [{ t: 'x' }] })

    const miss = await app.inject({ method: 'GET', url: '/api/benchmarks/nope/agent-session' })
    expect(miss.statusCode).toBe(404)
    expect(miss.json()).toEqual({ reason: 'no-session' })
    await app.close()
  })

  it('GET /api/benchmarks/:id returns the manifest, 404 when missing', async () => {
    const app = await buildApp({
      store: fakeStore({ get: (id) => (id === 'b1' ? manifest() : null) }),
    })
    const hit = await app.inject({ method: 'GET', url: '/api/benchmarks/b1' })
    expect(hit.statusCode).toBe(200)
    expect(hit.json().benchmarkId).toBe('b1')

    const miss = await app.inject({ method: 'GET', url: '/api/benchmarks/nope' })
    expect(miss.statusCode).toBe(404)
    await app.close()
  })

  describe('POST /api/benchmarks/:id/open-worktree', () => {
    afterEach(() => vi.clearAllMocks())

    const openBody = (target?: string) => ({ method: 'POST' as const, url: '/api/benchmarks/b1/open-worktree', payload: { target } })

    it('404s when the benchmark is unknown', async () => {
      const app = await buildApp({ store: fakeStore({ get: () => null }) })
      const res = await app.inject(openBody('frozen'))
      expect(res.statusCode).toBe(404)
      await app.close()
    })

    it('400s on an invalid target', async () => {
      const app = await buildApp({ store: fakeStore({ get: () => manifest() }) })
      const res = await app.inject(openBody('bogus'))
      expect(res.statusCode).toBe(400)
      expect(res.json()).toEqual({ error: 'target must be "frozen", "A", or "B"' })
      await app.close()
    })

    it('frozen 409s when the bug is not frozen yet (no sabotageSha)', async () => {
      const app = await buildApp({ store: fakeStore({ get: () => manifest({ sabotageSha: undefined }) }) })
      const res = await app.inject(openBody('frozen'))
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'the bug is not frozen yet' })
      await app.close()
    })

    it('frozen 409s when the benchmark has no repo to inspect', async () => {
      const app = await buildApp({ store: fakeStore({ get: () => manifest({ sabotageSha: 'sha', featureDir: undefined, repoPath: undefined }) }) })
      const res = await app.inject(openBody('frozen'))
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'benchmark has no repo to inspect' })
      await app.close()
    })

    it('frozen worktrees the sabotaged repo (repoPath), not the external featureDir', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-route-'))
      vi.mocked(addWorktree).mockResolvedValue({ repoName: 'cns', worktreeRoot: '/inspect/wt', sourceRoot: '/repo', localPath: '/inspect/wt' })
      const app = await buildApp({
        logsDir: tmp,
        // featureDir is an EXTERNAL dir; the sabotage commit lives in repoPath.
        store: fakeStore({ get: () => manifest({ sabotageSha: 'sha', featureDir: '/workspace/features/cns', repoPath: '/repos/mighty-cns' }) }),
      })
      const res = await app.inject(openBody('frozen'))
      expect(res.statusCode).toBe(200)
      expect(vi.mocked(addWorktree)).toHaveBeenCalledWith(
        expect.objectContaining({ branch: 'sha', localPath: '/repos/mighty-cns' }),
      )
      fs.rmSync(tmp, { recursive: true, force: true })
      await app.close()
    })

    it('frozen creates the inspect worktree and opens it', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-route-'))
      vi.mocked(addWorktree).mockResolvedValue({ repoName: 'example_todo_api', worktreeRoot: '/inspect/wt', sourceRoot: '/src', localPath: '/inspect/wt' })
      const app = await buildApp({
        logsDir: tmp,
        store: fakeStore({ get: () => manifest({ sabotageSha: 'sha', featureDir: '/feat' }) }),
      })
      const res = await app.inject(openBody('frozen'))
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ opened: true, path: '/inspect/wt', editor: 'vscode' })
      expect(vi.mocked(addWorktree)).toHaveBeenCalledWith(
        expect.objectContaining({ branch: 'sha', localPath: '/feat' }),
      )
      // No projectRoot → editor falls back to 'auto'.
      expect(vi.mocked(launchEditorDir)).toHaveBeenCalledWith('auto', '/inspect/wt')
      fs.rmSync(tmp, { recursive: true, force: true })
      await app.close()
    })

    it('frozen reuses an existing inspect checkout without calling addWorktree', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-route-'))
      const inspectParent = path.join(tmp, 'benchmarks', 'b1', 'worktrees', 'inspect')
      const existing = path.join(inspectParent, 'app')
      fs.mkdirSync(existing, { recursive: true })
      const app = await buildApp({
        logsDir: tmp,
        store: fakeStore({ get: () => manifest({ sabotageSha: 'sha', featureDir: '/feat' }) }),
      })
      const res = await app.inject(openBody('frozen'))
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ opened: true, path: existing, editor: 'vscode' })
      expect(vi.mocked(addWorktree)).not.toHaveBeenCalled()
      fs.rmSync(tmp, { recursive: true, force: true })
      await app.close()
    })

    it('frozen 500s when worktree creation throws', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-route-'))
      vi.mocked(addWorktree).mockRejectedValue(new Error('git exploded'))
      const app = await buildApp({
        logsDir: tmp,
        store: fakeStore({ get: () => manifest({ sabotageSha: 'sha', featureDir: '/feat' }) }),
      })
      const res = await app.inject(openBody('frozen'))
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: 'git exploded' })
      fs.rmSync(tmp, { recursive: true, force: true })
      await app.close()
    })

    it('frozen 500s with a stringified non-Error throw', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-route-'))
      vi.mocked(addWorktree).mockRejectedValue('plain string boom')
      const app = await buildApp({
        logsDir: tmp,
        store: fakeStore({ get: () => manifest({ sabotageSha: 'sha', featureDir: '/feat' }) }),
      })
      const res = await app.inject(openBody('frozen'))
      expect(res.statusCode).toBe(500)
      expect(res.json()).toEqual({ error: 'plain string boom' })
      fs.rmSync(tmp, { recursive: true, force: true })
      await app.close()
    })

    it('frozen creates a worktree when the inspect dir exists but holds no checkout', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-route-'))
      const inspectParent = path.join(tmp, 'benchmarks', 'b1', 'worktrees', 'inspect')
      fs.mkdirSync(inspectParent, { recursive: true })
      fs.writeFileSync(path.join(inspectParent, 'stray.txt'), 'not a dir') // file, not a checkout
      vi.mocked(addWorktree).mockResolvedValue({ repoName: 'example_todo_api', worktreeRoot: '/inspect/wt', sourceRoot: '/src', localPath: '/inspect/wt' })
      const app = await buildApp({
        logsDir: tmp,
        store: fakeStore({ get: () => manifest({ sabotageSha: 'sha', featureDir: '/feat' }) }),
      })
      const res = await app.inject(openBody('frozen'))
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ opened: true, path: '/inspect/wt', editor: 'vscode' })
      expect(vi.mocked(addWorktree)).toHaveBeenCalledTimes(1)
      fs.rmSync(tmp, { recursive: true, force: true })
      await app.close()
    })

    it('arm 409s when the arm worktree is gone', async () => {
      const app = await buildApp({
        store: fakeStore({ get: () => manifest({ arms: [{ arm: 'A', mode: 'harness', runIds: [], worktreePath: '/does/not/exist' }] }) }),
      })
      const res = await app.inject(openBody('A'))
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'arm worktree is not available (it may have been cleared)' })
      await app.close()
    })

    it('arm opens the live worktree, using the configured editor', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-arm-'))
      const app = await buildApp({
        projectRoot: '/proj',
        store: fakeStore({ get: () => manifest({ arms: [{ arm: 'B', mode: 'baseline', runIds: [], worktreePath: tmp }] }) }),
      })
      const res = await app.inject(openBody('B'))
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ opened: true, path: tmp, editor: 'vscode' })
      expect(vi.mocked(loadProjectConfig)).toHaveBeenCalledWith('/proj')
      expect(vi.mocked(launchEditorDir)).toHaveBeenCalledWith('cursor', tmp)
      fs.rmSync(tmp, { recursive: true, force: true })
      await app.close()
    })

    it('reports opened:false (200) when the editor launch throws', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-arm-'))
      vi.mocked(launchEditorDir).mockImplementation(() => { throw new Error('no editor') })
      const app = await buildApp({
        store: fakeStore({ get: () => manifest({ arms: [{ arm: 'A', mode: 'harness', runIds: [], worktreePath: tmp }] }) }),
      })
      const res = await app.inject(openBody('A'))
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ opened: false, path: tmp, error: 'no editor' })
      fs.rmSync(tmp, { recursive: true, force: true })
      await app.close()
    })

    it('stringifies a non-Error editor-launch throw in the opened:false body', async () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-arm-'))
      vi.mocked(launchEditorDir).mockImplementation(() => { throw 'spawn string boom' })
      const app = await buildApp({
        store: fakeStore({ get: () => manifest({ arms: [{ arm: 'A', mode: 'harness', runIds: [], worktreePath: tmp }] }) }),
      })
      const res = await app.inject(openBody('A'))
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ opened: false, path: tmp, error: 'spawn string boom' })
      fs.rmSync(tmp, { recursive: true, force: true })
      await app.close()
    })

    it('409s for any target once worktrees are cleared', async () => {
      const app = await buildApp({
        store: fakeStore({ get: () => manifest({ status: 'done', sabotageSha: 'sha', featureDir: '/feat', worktreesCleared: true }) }),
      })
      for (const target of ['frozen', 'A', 'B']) {
        const res = await app.inject(openBody(target))
        expect(res.statusCode).toBe(409)
        expect(res.json()).toEqual({ error: 'worktrees have been cleared for this benchmark' })
      }
      await app.close()
    })
  })

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
