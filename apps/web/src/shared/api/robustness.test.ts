import { describe, expect, it, vi } from 'vitest'
import { getRobustnessJob, listAllRobustnessJobs, listRobustnessJobs } from './robustness'
import { ok } from './__fixtures__/response'

describe('robustness api', () => {
  it('listAllRobustnessJobs reads the workspace-wide index', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([{ jobId: 'rj-1' }]))
    const out = await listAllRobustnessJobs({ baseUrl: '', fetchImpl })
    expect(out).toEqual([{ jobId: 'rj-1' }])
    expect(fetchImpl).toHaveBeenCalledWith('/api/robustness', { method: 'GET' })
  })

  it('listRobustnessJobs scopes to the suite and encodes its name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([]))
    await listRobustnessJobs('shop/a', { baseUrl: '', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/features/shop%2Fa/robustness', { method: 'GET' })
  })

  it('getRobustnessJob reads one record by id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ jobId: 'rj 1', findings: [] }))
    const out = await getRobustnessJob('rj 1', { baseUrl: '', fetchImpl })
    expect(out).toEqual({ jobId: 'rj 1', findings: [] })
    expect(fetchImpl).toHaveBeenCalledWith('/api/robustness/rj%201', { method: 'GET' })
  })
})
