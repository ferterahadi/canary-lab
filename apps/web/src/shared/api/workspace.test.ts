import { describe, it, expect, vi } from 'vitest'
import {
  getVersionStatus,
  startVersionUpdate,
  openAgentApp,
  openEditor,
  openWorkspace,
  listWorkspaceDirs,
  getGitRemote,
  checkPathExists,
  getWorkspaceGitStatus,
  checkoutWorkspaceBranch,
  cloneRepository,
  getRepoGitStatus,
  checkoutRepoBranch,
} from './workspace'
import { ok } from './__fixtures__/response'

describe('workspace api', () => {
  it('getVersionStatus GETs /api/version', async () => {
    const status = {
      current: '1.4.1',
      latest: '1.4.2',
      updateAvailable: true,
      packageName: 'canary-lab',
      update: null,
    }
    const fetchImpl = vi.fn().mockResolvedValue(ok(status))
    const result = await getVersionStatus({ baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(status)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/version', { method: 'GET' })
  })

  it('startVersionUpdate POSTs /api/version/update', async () => {
    const manifest = { jobId: 'current', status: 'running', targetVersion: '1.4.2', startedAt: 't0', log: '' }
    const fetchImpl = vi.fn().mockResolvedValue(ok(manifest, 202))
    const result = await startVersionUpdate({ baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual(manifest)
    // No body and no content-type: declaring application/json with an empty
    // body makes Fastify reject the request before the handler runs.
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/version/update', {
      method: 'POST',
    })
  })

  it('getRepoGitStatus and checkoutRepoBranch use feature repo endpoints', async () => {
    const status = {
      path: '/repo',
      expectedBranch: 'main',
      isGitRepo: true,
      currentBranch: 'main',
      detached: false,
      dirty: false,
      dirtyFiles: [],
      localBranches: ['main'],
      remoteBranches: [],
    }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok(status))
      .mockResolvedValueOnce(ok(status))
    expect(await getRepoGitStatus('feat/a', 'repo/b', { fetchImpl })).toEqual(status)
    await checkoutRepoBranch('feat/a', 'repo/b', 'main', { fetchImpl })
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/features/feat%2Fa/repos/repo%2Fb/git')
    const [url, init] = fetchImpl.mock.calls[1]
    expect(url).toBe('/api/features/feat%2Fa/repos/repo%2Fb/checkout')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ branch: 'main' })
  })

  it('getWorkspaceGitStatus and checkoutWorkspaceBranch use path-based workspace endpoints', async () => {
    const status = {
      path: '/repo',
      expectedBranch: null,
      isGitRepo: true,
      currentBranch: 'main',
      detached: false,
      dirty: false,
      dirtyFiles: [],
      localBranches: ['main'],
      remoteBranches: [],
    }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok(status))
      .mockResolvedValueOnce(ok(status))
    expect(await getWorkspaceGitStatus('/repo path', { fetchImpl })).toEqual(status)
    await checkoutWorkspaceBranch('/repo path', 'main', { fetchImpl })
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/workspace/git-status?path=%2Frepo%20path')
    const [url, init] = fetchImpl.mock.calls[1]
    expect(url).toBe('/api/workspace/checkout')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ path: '/repo path', branch: 'main' })
  })

  it('listWorkspaceDirs encodes the at param', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ root: '/r', at: 'sub', dirs: ['a'] }))
    const r = await listWorkspaceDirs('sub dir', { fetchImpl })
    expect(r.dirs).toEqual(['a'])
    expect(fetchImpl.mock.calls[0][0]).toContain('at=')
  })

  it('listWorkspaceDirs without `at` omits the query param', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ root: '/r', at: '', dirs: [] }))
    await listWorkspaceDirs(undefined, { fetchImpl })
    expect(fetchImpl.mock.calls[0][0]).not.toContain('at=')
  })

  it('openAgentApp POSTs the agent name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ opened: true }))
    await openAgentApp('claude', { fetchImpl })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/open-agent')
    expect(JSON.parse(init.body as string)).toEqual({ agent: 'claude' })
  })

  it('openEditor POSTs the editor target', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ opened: true, editor: 'cursor' }))
    await openEditor({ file: '/tmp/a.spec.ts', line: 12, column: 3, editor: 'cursor' }, { fetchImpl })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/open-editor')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      file: '/tmp/a.spec.ts',
      line: 12,
      column: 3,
      editor: 'cursor',
    })
  })

  it('openWorkspace POSTs to /api/open-workspace with no body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ opened: true, path: '/repo' }))
    const result = await openWorkspace({ baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual({ opened: true, path: '/repo' })
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/open-workspace', { method: 'POST' })
  })

  it('openWorkspace resolves opened:false with an error on a best-effort launch failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ opened: false, path: '/repo', error: 'no editor configured' }))
    const result = await openWorkspace({ fetchImpl })
    expect(result).toEqual({ opened: false, path: '/repo', error: 'no editor configured' })
  })

  it('getGitRemote sends the path query param', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ cloneUrl: 'git@x:o/r.git' }))
    const r = await getGitRemote('/abs/path', { fetchImpl })
    expect(r.cloneUrl).toBe('git@x:o/r.git')
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/workspace/git-remote?path=%2Fabs%2Fpath')
  })

  it('checkPathExists sends the path query param', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ exists: true }))
    const r = await checkPathExists('/abs/path', { fetchImpl })
    expect(r.exists).toBe(true)
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/workspace/path-exists?path=%2Fabs%2Fpath')
  })

  it('cloneRepository POSTs body and returns localPath', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ localPath: '/x/repo' }))
    const r = await cloneRepository(
      { cloneUrl: 'git@x:o/r.git', parentDir: '/x', repoName: 'repo' },
      { fetchImpl },
    )
    expect(r).toEqual({ localPath: '/x/repo' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/workspace/clone')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({
      cloneUrl: 'git@x:o/r.git',
      parentDir: '/x',
      repoName: 'repo',
    })
  })
})
