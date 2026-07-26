import { describe, it, expect, vi } from 'vitest'
import {
  listBenchmarks,
  getBenchmark,
  listSabotageSkills,
  benchmarkPreflight,
  startBenchmark,
  abortBenchmark,
  openBenchmarkWorktree,
  clearBenchmarkWorktrees,
  getBenchmarkAgentSession,
} from './benchmark'
import { ok, fail } from './__fixtures__/response'

describe('benchmark api', () => {
  it('listBenchmarks GETs the index', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([{ benchmarkId: 'b1' }]))
    await expect(listBenchmarks({ baseUrl: 'http://x', fetchImpl })).resolves.toEqual([{ benchmarkId: 'b1' }])
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/benchmarks', { method: 'GET' })
  })

  it('getBenchmark GETs a single manifest, encoding the id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ benchmarkId: 'b/1' }))
    await expect(getBenchmark('b/1', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual({ benchmarkId: 'b/1' })
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/benchmarks/b%2F1', { method: 'GET' })
  })

  it('listSabotageSkills GETs the skills for a feature', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([{ name: 'off-by-one' }]))
    await expect(listSabotageSkills('a/b', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual([{ name: 'off-by-one' }])
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/benchmark-skills?feature=a%2Fb', { method: 'GET' })
  })

  it('startBenchmark POSTs the input as JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ benchmarkId: 'bench-1' }))
    const input = { feature: 'f', skill: 's', level: 'med' as const, iterations: 2, agent: 'claude' as const }
    await expect(startBenchmark(input, { baseUrl: 'http://x', fetchImpl })).resolves.toEqual({ benchmarkId: 'bench-1' })
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/benchmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  })

  it('abortBenchmark POSTs to the abort endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ ok: true }))
    await expect(abortBenchmark('b1', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual({ ok: true })
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/benchmarks/b1/abort', { method: 'POST' })
  })

  it('getBenchmarkAgentSession returns the session on 200', async () => {
    const session = { agent: 'claude', sessionId: 's1', events: [] }
    const fetchImpl = vi.fn().mockResolvedValue(ok(session))
    await expect(getBenchmarkAgentSession('b1', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(session)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/benchmarks/b1/agent-session', { method: 'GET' })
  })

  it('getBenchmarkAgentSession returns null on 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(404, { reason: 'no-session' }))
    await expect(getBenchmarkAgentSession('b1', { baseUrl: 'http://x', fetchImpl })).resolves.toBeNull()
  })

  it('openBenchmarkWorktree POSTs the target to the open-worktree endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ opened: true, path: '/wt', editor: 'cursor' }))
    const r = await openBenchmarkWorktree('b1', 'frozen', { baseUrl: 'http://x', fetchImpl })
    expect(r).toEqual({ opened: true, path: '/wt', editor: 'cursor' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://x/api/benchmarks/b1/open-worktree')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ target: 'frozen' })
  })

  it('getBenchmarkAgentSession rethrows non-404 errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(500, { error: 'boom' }))
    await expect(getBenchmarkAgentSession('b1', { baseUrl: 'http://x', fetchImpl })).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
    })
  })

  it('benchmarkPreflight queries the feature (and env when given)', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => ok({ portsConfigured: false, repos: [] }))
    const r = await benchmarkPreflight('cns', undefined, { baseUrl: 'http://x', fetchImpl })
    expect(r).toEqual({ portsConfigured: false, repos: [] })
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/benchmarks/preflight?feature=cns', { method: 'GET' })
    await benchmarkPreflight('cns', 'prod', { baseUrl: 'http://x', fetchImpl })
    expect(fetchImpl).toHaveBeenLastCalledWith('http://x/api/benchmarks/preflight?feature=cns&env=prod', { method: 'GET' })
  })

  it('clearBenchmarkWorktrees POSTs the confirm flag', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => ok({ confirmed: true, willClear: 2, cleared: 2, freedBytes: 9 }))
    const r = await clearBenchmarkWorktrees('b1', true, { baseUrl: 'http://x', fetchImpl })
    expect(r).toEqual({ confirmed: true, willClear: 2, cleared: 2, freedBytes: 9 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://x/api/benchmarks/b1/clear-worktrees')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ confirm: true })
  })
})
