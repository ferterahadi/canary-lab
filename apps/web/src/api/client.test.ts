import { describe, it, expect, vi } from 'vitest'
import {
  ApiError,
  acceptPlan,
  acceptSpec,
  addEnvsetSlot,
  browseDir,
  cancelHealRun,
  checkPathExists,
  cloneRepository,
  createDraft,
  deleteDraft,
  deleteEnvsetSlot,
  deleteJournalEntry,
  deleteRun,
  getDraft,
  getDraftFile,
  getEnvsetSlot,
  getEnvsetsIndex,
  getFeatureConfig,
  getFeatureConfigDoc,
  getFeatureTests,
  getGitRemote,
  getPlaywrightConfig,
  getRunDetail,
  listFeatures,
  listJournal,
  listRuns,
  listSkills,
  listWorkspaceDirs,
  putEnvsetSlot,
  putFeatureConfigDoc,
  putPlaywrightConfig,
  recommendSkills,
  rejectDraft,
  startRun,
  stopRun,
  pauseHealRun,
  createEnvset,
  deleteEnvset,
  getProjectConfig,
  putProjectConfig,
  openAgentApp,
  sendAgentInput,
} from './client'

const ok = (body: unknown, status = 200): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const fail = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

describe('api client', () => {
  it('listFeatures returns parsed array on 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([{ name: 'feat-a', repos: [], envs: [] }]))
    const result = await listFeatures({ baseUrl: 'http://x', fetchImpl })
    expect(result).toEqual([{ name: 'feat-a', repos: [], envs: [] }])
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/features', { method: 'GET' })
  })

  it('listFeatures throws ApiError on 500 with body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(500, { error: 'boom' }))
    await expect(listFeatures({ fetchImpl })).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
      body: { error: 'boom' },
    })
  })

  it('getFeatureTests URL-encodes the feature name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([]))
    await getFeatureTests('a/b c', { baseUrl: 'http://x', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/features/a%2Fb%20c/tests',
      { method: 'GET' },
    )
  })

  it('getFeatureTests throws ApiError on 404 with non-JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('not found', { status: 404 }),
    )
    await expect(getFeatureTests('x', { fetchImpl })).rejects.toMatchObject({
      status: 404,
      body: 'not found',
    })
  })

  it('listRuns sends ?feature= when filter provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([]))
    await listRuns({ feature: 'feat-a' }, { baseUrl: '', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs?feature=feat-a', { method: 'GET' })
  })

  it('listRuns omits query string when no feature filter', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([]))
    await listRuns({}, { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs', { method: 'GET' })
  })

  it('getRunDetail fetches the run by id', async () => {
    const detail = { runId: 'r1', manifest: { runId: 'r1', feature: 'f', startedAt: 'x', status: 'running', healCycles: 0, services: [] } }
    const fetchImpl = vi.fn().mockResolvedValue(ok(detail))
    const out = await getRunDetail('r1', { fetchImpl })
    expect(out).toEqual(detail)
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs/r1', { method: 'GET' })
  })

  it('startRun POSTs JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ runId: 'r2' }, 201))
    const out = await startRun('feat-x', { fetchImpl })
    expect(out).toEqual({ runId: 'r2' })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'feat-x' }),
    })
  })

  it('startRun throws ApiError on 400', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(400, { error: 'feature required' }))
    await expect(startRun('', { fetchImpl })).rejects.toBeInstanceOf(ApiError)
  })

  it('stopRun POSTs to /abort and resolves on 204 (empty body)', async () => {
    // Response disallows status 204 with a body — pass `null` body explicitly.
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await expect(stopRun('r3', { fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs/r3/abort', { method: 'POST' })
  })

  it('stopRun throws ApiError on 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(404, { error: 'run not found' }))
    await expect(stopRun('missing', { fetchImpl })).rejects.toMatchObject({ status: 404 })
  })

  it('pauseHealRun resolves with the success body on 202', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'healing', failureCount: 2 }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const result = await pauseHealRun('r9', { baseUrl: '', fetchImpl })
    expect(result).toEqual({ status: 'healing', failureCount: 2 })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs/r9/pause-heal', { method: 'POST' })
  })

  it('pauseHealRun throws ApiError on 409 with the reason in the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(409, { reason: 'no-failures-yet' }))
    await expect(pauseHealRun('r10', { fetchImpl })).rejects.toMatchObject({
      status: 409,
      body: { reason: 'no-failures-yet' },
    })
  })

  it('pauseHealRun throws ApiError on 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(404, { error: 'run not active' }))
    await expect(pauseHealRun('ghost', { fetchImpl })).rejects.toMatchObject({ status: 404 })
  })

  it('listJournal sends both feature and run query params when set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([]))
    await listJournal({ feature: 'f', run: 'r' }, { fetchImpl })
    const url = (fetchImpl.mock.calls[0] as [string, RequestInit])[0]
    expect(url).toMatch(/^\/api\/journal\?/)
    expect(url).toContain('feature=f')
    expect(url).toContain('run=r')
  })

  it('listJournal omits query string when no filter', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([]))
    await listJournal({}, { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/journal', { method: 'GET' })
  })

  it('deleteJournalEntry DELETEs the iteration and resolves on 204', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await expect(deleteJournalEntry(7, { fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith('/api/journal/7', { method: 'DELETE' })
  })

  it('deleteJournalEntry throws ApiError on 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(404, { error: 'iteration not found' }))
    await expect(deleteJournalEntry(99, { fetchImpl })).rejects.toBeInstanceOf(ApiError)
  })

  it('listSkills GETs /api/skills', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([{ id: 'a', name: 'A', description: 'd', source: 'user', path: '/x' }]))
    const out = await listSkills({ fetchImpl })
    expect(out[0].id).toBe('a')
    expect(fetchImpl).toHaveBeenCalledWith('/api/skills', { method: 'GET' })
  })

  it('recommendSkills POSTs PRD body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([{ skillId: 's', score: 1, matchedTerms: ['x'], reasoning: 'r' }]))
    const out = await recommendSkills({ prdText: 'hello', topN: 5 }, { fetchImpl })
    expect(out[0].skillId).toBe('s')
    expect(fetchImpl).toHaveBeenCalledWith('/api/skills/recommend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prdText: 'hello', topN: 5 }),
    })
  })

  it('recommendSkills throws ApiError on 400', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(400, { error: 'prd required' }))
    await expect(recommendSkills({ prdText: '' }, { fetchImpl })).rejects.toBeInstanceOf(ApiError)
  })

  it('createDraft POSTs payload, returns 201 body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'd1', status: 'planning' }, 201))
    const out = await createDraft(
      { prdText: 'p', repos: [{ name: 'r', localPath: '/r' }], skills: ['s1'] },
      { fetchImpl },
    )
    expect(out).toEqual({ draftId: 'd1', status: 'planning' })
    const call = (fetchImpl.mock.calls[0] as [string, RequestInit])
    expect(call[0]).toBe('/api/tests/draft')
    expect(call[1].method).toBe('POST')
  })

  it('getDraft URL-encodes the id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'a/b', status: 'created' }))
    await getDraft('a/b', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/tests/draft/a%2Fb', { method: 'GET' })
  })

  it('getDraftFile encodes path segments but keeps slashes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      ok({ path: 'tests/x.ts', content: 'hi', mime: 'text/plain' }),
    )
    const r = await getDraftFile('d1', 'tests/login spec.ts', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/tests/draft/d1/files/tests/login%20spec.ts',
      { method: 'GET' },
    )
    expect(r.content).toBe('hi')
  })

  it('acceptPlan posts plan when provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'd', status: 'generating' }, 202))
    await acceptPlan('d', [{ step: 's', actions: ['a'], expectedOutcome: 'e' }], { fetchImpl })
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.plan).toBeDefined()
  })

  it('acceptPlan posts empty body when no plan supplied', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'd', status: 'generating' }, 202))
    await acceptPlan('d', undefined, { fetchImpl })
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body).toEqual({})
  })

  it('acceptSpec posts featureName when given', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'd', status: 'accepted', featureDir: '/x' }))
    await acceptSpec('d', 'my-feat', { fetchImpl })
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body).toEqual({ featureName: 'my-feat' })
  })

  it('acceptSpec posts empty body when no featureName supplied', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'd', status: 'accepted', featureDir: '/x' }))
    await acceptSpec('d', undefined, { fetchImpl })
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body).toEqual({})
  })

  it('rejectDraft POSTs and resolves on 204', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await expect(rejectDraft('d', { fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith('/api/tests/draft/d/reject', { method: 'POST' })
  })

  it('deleteDraft DELETEs and resolves on 204', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await expect(deleteDraft('d', { fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith('/api/tests/draft/d', { method: 'DELETE' })
  })

  it('deleteDraft throws ApiError on 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(404, { error: 'draft not found' }))
    await expect(deleteDraft('missing', { fetchImpl })).rejects.toBeInstanceOf(ApiError)
  })

  it('getFeatureConfig returns the raw config doc', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ path: '/p', content: 'x', format: 'cjs' }))
    const r = await getFeatureConfig('a', { fetchImpl })
    expect(r.format).toBe('cjs')
    expect(fetchImpl).toHaveBeenCalledWith('/api/features/a/config', { method: 'GET' })
  })

  it('getFeatureConfigDoc + putFeatureConfigDoc round-trip', async () => {
    const doc = { path: '/p', content: 'c', format: 'cjs', parsed: { value: { name: 'a' }, complexFields: [] } }
    const fetchImpl = vi.fn().mockImplementation(async () => ok(doc))
    expect(await getFeatureConfigDoc('a', { fetchImpl })).toEqual(doc)
    await putFeatureConfigDoc('a', { name: 'b' }, { fetchImpl })
    const init = fetchImpl.mock.calls[1][1] as RequestInit
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ value: { name: 'b' } })
  })

  it('getPlaywrightConfig + putPlaywrightConfig', async () => {
    const doc = { path: '/p', content: 'c', format: 'ts', parsed: { value: { testDir: './e2e' }, complexFields: [] } }
    const fetchImpl = vi.fn().mockImplementation(async () => ok(doc))
    expect(await getPlaywrightConfig('a', { fetchImpl })).toEqual(doc)
    await putPlaywrightConfig('a', { testDir: './t' }, { fetchImpl })
    const init = fetchImpl.mock.calls[1][1] as RequestInit
    expect(init.method).toBe('PUT')
  })

  it('getEnvsetsIndex / getEnvsetSlot / putEnvsetSlot', async () => {
    const idx = { envs: [], slotDescriptions: {}, slotTargets: {} }
    const slot = { path: '/p', content: '', entries: [], unparsedLines: [] }
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(ok(idx))
      .mockResolvedValueOnce(ok(slot))
      .mockResolvedValueOnce(ok(slot))
    expect(await getEnvsetsIndex('a', { fetchImpl })).toEqual(idx)
    expect(await getEnvsetSlot('a', 'local', 'app.env', { fetchImpl })).toEqual(slot)
    await putEnvsetSlot('a', 'local', 'app.env', [{ key: 'X', value: '1' }], { fetchImpl })
    const init = fetchImpl.mock.calls[2][1] as RequestInit
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ entries: [{ key: 'X', value: '1' }] })
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

  it('cancelHealRun POSTs to the cancel endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ status: 'cancelled' }))
    await cancelHealRun('r1', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs/r1/cancel-heal', { method: 'POST' })
  })

  it('deleteRun DELETEs /api/runs/:runId (terminal-only on the server)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await deleteRun('r1', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs/r1', { method: 'DELETE' })
  })

  it('createEnvset POSTs the env name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ env: 'staging' }))
    const r = await createEnvset('alpha', 'staging', { fetchImpl })
    expect(r).toEqual({ env: 'staging' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/features/alpha/envsets')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ env: 'staging' })
  })

  it('deleteEnvset DELETEs the env folder', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await deleteEnvset('alpha', 'staging', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith('/api/features/alpha/envsets/staging', { method: 'DELETE' })
  })

  it('getProjectConfig GETs /api/project-config', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ healAgent: 'auto' }))
    const r = await getProjectConfig({ fetchImpl })
    expect(r).toEqual({ healAgent: 'auto' })
    expect(fetchImpl).toHaveBeenCalledWith('/api/project-config', { method: 'GET' })
  })

  it('putProjectConfig sends the partial config as JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ healAgent: 'manual' }))
    await putProjectConfig({ healAgent: 'manual' }, { fetchImpl })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/project-config')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ healAgent: 'manual' })
  })

  it('openAgentApp POSTs the agent name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ opened: true }))
    await openAgentApp('claude', { fetchImpl })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/open-agent')
    expect(JSON.parse(init.body as string)).toEqual({ agent: 'claude' })
  })

  it('sendAgentInput POSTs the data string', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ status: 'sent' }))
    await sendAgentInput('r1', 'hello\n', { fetchImpl })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/runs/r1/agent-input')
    expect(JSON.parse(init.body as string)).toEqual({ data: 'hello\n' })
  })

  it('addEnvsetSlot POSTs the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ slot: 'app.env' }, 201))
    const r = await addEnvsetSlot(
      'alpha',
      { sourcePath: '/x/app.env', slotName: 'app.env', target: '/abs', description: 'd' },
      { fetchImpl },
    )
    expect(r).toEqual({ slot: 'app.env' })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/features/alpha/envsets/slots')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toMatchObject({ sourcePath: '/x/app.env' })
  })

  it('deleteEnvsetSlot DELETEs and resolves on 204', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await deleteEnvsetSlot('alpha', 'app.env', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/features/alpha/envsets/slots/app.env',
      { method: 'DELETE' },
    )
  })

  it('browseDir GETs with the dir query param', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ dir: '/x', parent: '/', entries: [] }))
    await browseDir('/x y', { fetchImpl })
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/fs/browse?dir=%2Fx%20y')
  })

  it('browseDir omits ?dir= when path is empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ dir: '/', parent: null, entries: [] }))
    await browseDir('', { fetchImpl })
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/fs/browse')
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

  it('startRun includes env when provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ runId: 'r-env' }, 201))
    await startRun('feat-x', { fetchImpl, env: 'production' })
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({ feature: 'feat-x', env: 'production' })
  })

  it('uses globalThis.fetch by default when no fetchImpl provided', async () => {
    const original = globalThis.fetch
    const stub = vi.fn().mockResolvedValue(ok([]))
    ;(globalThis as { fetch: typeof fetch }).fetch = stub as unknown as typeof fetch
    try {
      await listFeatures()
      expect(stub).toHaveBeenCalled()
    } finally {
      ;(globalThis as { fetch: typeof fetch }).fetch = original
    }
  })
})
