import { describe, it, expect, vi } from 'vitest'
import { fetchAgentJobs, stopAgentJob } from './agent-jobs'
import { ok } from './__fixtures__/response'

describe('agent-jobs api', () => {
  it('fetches every record when no flight is named', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ jobs: [{ jobId: 'a', status: 'running', startedAt: 'now' }] }))
    const rows = await fetchAgentJobs(undefined, { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/agent-jobs', { method: 'GET' })
    expect(rows).toEqual([{ jobId: 'a', status: 'running', startedAt: 'now' }])
  })

  it('scopes to one flight when asked', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ jobs: [] }))
    await fetchAgentJobs('fl_1', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/agent-jobs?flight=fl_1', { method: 'GET' })
  })

  it('defaults a response with no jobs key to an empty list', async () => {
    // An older server, or a body that lost the key — the caller renders a list and
    // must not have to guard for undefined.
    const fetchImpl = vi.fn().mockResolvedValue(ok({}))
    expect(await fetchAgentJobs('fl_1', { fetchImpl })).toEqual([])
  })

  it('stops one agent by id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ stopped: true }))
    const res = await stopAgentJob('fl_1:scout', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/agent-jobs/fl_1%3Ascout/stop', { method: 'POST' })
    expect(res).toEqual({ stopped: true })
  })

  it('passes through a no-op stop with the status that made it one', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ stopped: false, status: 'done' }))
    expect(await stopAgentJob('fl_1:scout', { fetchImpl })).toEqual({ stopped: false, status: 'done' })
  })
})
