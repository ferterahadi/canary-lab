import { describe, it, expect } from 'vitest'
import Fastify from 'fastify'
import { benchmarkRoutes } from './benchmarks'
import type { BenchmarkStore } from '../lib/runtime/benchmark/store'
import type { SabotageSkill } from '../lib/runtime/benchmark/skills'
import type { BenchmarkManifest, StartBenchmarkInput } from '../lib/runtime/benchmark/types'

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
  startBenchmark?: (input: StartBenchmarkInput) => Promise<{ benchmarkId: string }>
  listSkills?: (feature: string) => SabotageSkill[]
  abortBenchmark?: (id: string) => void
  readSabotageLog?: (id: string) => string
  loadAgentSession?: (id: string) => { agent: string; sessionId: string; events: unknown[] } | null
}) {
  const app = Fastify()
  await app.register(benchmarkRoutes, {
    store: deps.store ?? fakeStore(),
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
})
