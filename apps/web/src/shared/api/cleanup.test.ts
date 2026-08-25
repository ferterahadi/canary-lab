import { describe, it, expect, vi } from 'vitest'
import {
  cleanupRuns,
  cleanupWorktrees,
  cleanupPortify,
  openPortifyProject,
  openWorktreePath,
  removeWorktree,
  trimRun,
} from './cleanup'
import { ok } from './__fixtures__/response'

describe('cleanup api', () => {
  it('cleanupRuns GETs /api/cleanup/runs', async () => {
    const listing = { runs: [], orphans: [], totals: { totalBytes: 0, reclaimableTrimBytes: 0, reclaimableDeleteBytes: 0 } }
    const fetchImpl = vi.fn().mockResolvedValue(ok(listing))
    const r = await cleanupRuns({ fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/cleanup/runs', { method: 'GET' })
    expect(r).toEqual(listing)
  })

  it('cleanupWorktrees GETs /api/cleanup/worktrees', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ worktrees: [] }))
    const r = await cleanupWorktrees({ fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/cleanup/worktrees', { method: 'GET' })
    expect(r).toEqual({ worktrees: [] })
  })

  it('openWorktreePath POSTs the path to the open endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ opened: true, path: '/wt', editor: 'vscode' }))
    const r = await openWorktreePath('/wt', { fetchImpl })
    expect(r).toEqual({ opened: true, path: '/wt', editor: 'vscode' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/cleanup/worktrees/open')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ path: '/wt' })
  })

  it('openPortifyProject POSTs to the workflow open endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ opened: true, paths: ['/wt'], editor: 'vscode' }))
    const r = await openPortifyProject('w 1', { baseUrl: 'http://x', fetchImpl })
    expect(r).toEqual({ opened: true, paths: ['/wt'], editor: 'vscode' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('http://x/api/portify/w%201/open')
    expect(init.method).toBe('POST')
  })

  it('removeWorktree DELETEs /api/cleanup/worktrees with the path body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ removed: true, freedBytes: 42 }))
    const r = await removeWorktree('/wt', { fetchImpl })
    expect(r).toEqual({ removed: true, freedBytes: 42 })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/cleanup/worktrees')
    expect(init.method).toBe('DELETE')
    expect(JSON.parse(init.body as string)).toEqual({ path: '/wt' })
  })

  it('trimRun POSTs /api/runs/:runId/trim and returns freedBytes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ freedBytes: 1234 }))
    const r = await trimRun('r1', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs/r1/trim', { method: 'POST' })
    expect(r).toEqual({ freedBytes: 1234 })
  })

  it('cleanupPortify GETs the portify cleanup listing', async () => {
    const listing = { workflows: [] }
    const fetchImpl = vi.fn().mockResolvedValue(ok(listing))
    const result = await cleanupPortify({ baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(listing)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/cleanup/portify', { method: 'GET' })
  })
})
