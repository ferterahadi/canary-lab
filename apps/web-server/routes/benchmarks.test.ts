import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, it, expect, vi } from 'vitest'
import Fastify from 'fastify'
import { benchmarkRoutes } from './benchmarks'
import { launchEditorDir } from '../lib/editor-launch'
import { addWorktree } from '../lib/runtime/repo-worktree'
import { loadProjectConfig } from '../lib/runtime/launcher/project-config'
import type { BenchmarkStore } from '../lib/runtime/benchmark/store'
import type { SabotageSkill } from '../lib/runtime/benchmark/skills'
import type { BenchmarkManifest, StartBenchmarkInput } from '../lib/runtime/benchmark/types'

vi.mock('../lib/editor-launch', () => ({ launchEditorDir: vi.fn(() => 'vscode') }))
vi.mock('../lib/runtime/repo-worktree', () => ({ addWorktree: vi.fn() }))
vi.mock('../lib/runtime/launcher/project-config', () => ({ loadProjectConfig: vi.fn(() => ({ editor: 'cursor' })) }))

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
    onEvent: () => {},
    offEvent: () => {},
    ...over,
  }
}

async function buildApp(deps: {
  store?: BenchmarkStore
  logsDir?: string
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

    it('frozen 409s when the benchmark has no feature directory', async () => {
      const app = await buildApp({ store: fakeStore({ get: () => manifest({ sabotageSha: 'sha', featureDir: undefined }) }) })
      const res = await app.inject(openBody('frozen'))
      expect(res.statusCode).toBe(409)
      expect(res.json()).toEqual({ error: 'benchmark has no feature directory to inspect' })
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
      expect(res.json()).toEqual({ error: 'arm worktree is no longer available — it is removed when the benchmark finishes' })
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
  })
})
