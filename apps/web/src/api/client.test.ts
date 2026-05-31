import { describe, it, expect, vi } from 'vitest'
import {
  ApiError,
  asRepoCollision,
  acceptPlan,
  acceptSpec,
  addEnvsetSlot,
  browseDir,
  cancelHealRun,
  checkPathExists,
  checkoutRepoBranch,
  checkoutWorkspaceBranch,
  cloneRepository,
  createDraft,
  cancelDraftGeneration,
  cancelEvaluationExportTask,
  deleteDraft,
  deleteFeature,
  deleteEnvsetSlot,
  deleteJournalEntry,
  deleteRun,
  getDraft,
  getDraftAgentLog,
  getDraftFile,
  getEnvsetSlot,
  getEnvsetsIndex,
  getEvaluationExportTask,
  getFeatureConfig,
  getFeatureConfigDoc,
  getFeatureTests,
  getMcpHealth,
  getGitRemote,
  getRepoGitStatus,
  getWorkspaceGitStatus,
  getPlaywrightConfig,
  getAgentSession,
  getRunDetail,
  getRunAudit,
  getVerificationTargets,
  listFeatures,
  listDrafts,
  listEvaluationExportTasks,
  listJournal,
  listVerificationConfigs,
  listRuns,
  listWorkspaceDirs,
  putEnvsetSlot,
  putFeatureConfigDoc,
  putPlaywrightConfig,
  readDotenvFile,
  rejectDraft,
  startEvaluationExport,
  createVerificationConfig,
  updateVerificationConfig,
  executeVerification,
  startRun,
  stopRun,
  pauseHealRun,
  createEnvset,
  deleteEnvset,
  getProjectConfig,
  putProjectConfig,
  openAgentApp,
	  openEditor,
	  sendAgentInput,
	  restartRun,
	  extractPrdDocuments,
  downloadEvaluationExportTask,
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

  it('getMcpHealth checks the MCP health endpoint with the selected profile', async () => {
    const health = {
      ok: true,
      server: { name: 'canary-lab' },
      profile: 'full',
      clientKind: 'other',
      toolCount: 42,
      tools: ['start_run', 'wait_for_heal_task'],
      activeSessions: 0,
      projectRoot: '/workspace',
    }
    const fetchImpl = vi.fn().mockResolvedValue(ok(health))

    await expect(getMcpHealth('full', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(health)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/mcp/health?profile=full', { method: 'GET' })
  })

  it('cancelEvaluationExportTask deletes the task endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await cancelEvaluationExportTask('task/1', { baseUrl: 'http://x', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/evaluation-exports/task%2F1',
      { method: 'DELETE' },
    )
  })

  it('starts and fetches evaluation export tasks', async () => {
    const task = {
      taskId: 'task/1',
      runId: 'run/1',
      feature: 'checkout',
      mode: 'localized',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      downloadReady: false,
    }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok(task, 202))
      .mockResolvedValueOnce(ok({ ...task, status: 'completed', downloadReady: true }))

    await expect(startEvaluationExport('run/1', 'localized', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(task)
    await expect(getEvaluationExportTask('task/1', { baseUrl: 'http://x', fetchImpl })).resolves.toMatchObject({
      status: 'completed',
      downloadReady: true,
    })

    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'http://x/api/runs/run%2F1/evaluation-export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'localized' }),
    })
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'http://x/api/evaluation-exports/task%2F1', { method: 'GET' })
  })

  it('lists evaluation export tasks with optional run filtering', async () => {
    const tasks = [{ taskId: 'task-1', runId: 'run/1' }]
    const fetchImpl = vi.fn().mockResolvedValue(ok(tasks))

    await expect(listEvaluationExportTasks({ runId: 'run/1' }, { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(tasks)

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/evaluation-exports?runId=run%2F1',
      { method: 'GET' },
    )
  })

  it('lists evaluation export tasks without query when no runId', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([]))
    await expect(listEvaluationExportTasks({}, { baseUrl: 'http://x', fetchImpl })).resolves.toEqual([])
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/evaluation-exports', { method: 'GET' })
  })

  it('downloads using the ambient document and URL when no overrides are provided', async () => {
    const link = {
      href: '',
      download: '',
      style: { display: '' },
      click: vi.fn(),
      remove: vi.fn(),
    } as unknown as HTMLAnchorElement
    const ambientDoc = {
      body: { appendChild: vi.fn() },
      createElement: vi.fn().mockReturnValue(link),
    }
    const ambientURL = {
      createObjectURL: vi.fn().mockReturnValue('blob:ambient'),
      revokeObjectURL: vi.fn(),
    }
    vi.stubGlobal('document', ambientDoc)
    vi.stubGlobal('URL', ambientURL)
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new Blob(['zip']), { status: 200 }))
    try {
      await downloadEvaluationExportTask(
        {
          taskId: 'task-amb',
          runId: 'run-amb',
          feature: 'ambient',
          mode: 'raw',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          downloadReady: true,
        },
        { fetchImpl },
      )
    } finally {
      vi.unstubAllGlobals()
    }
    expect(link.click).toHaveBeenCalled()
    expect(ambientURL.createObjectURL).toHaveBeenCalled()
  })

  it('throws ApiError with null body when evaluation export download response is empty', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 500 }))
    await expect(downloadEvaluationExportTask(
      {
        taskId: 'gone',
        runId: 'run-gone',
        feature: 'gone',
        mode: 'raw',
        status: 'failed',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        downloadReady: false,
      },
      { fetchImpl, documentRef: {} as Document },
    )).rejects.toMatchObject({ status: 500, body: null })
  })

  it('downloads evaluation export zip files with safe filenames', async () => {
    const link = {
      href: '',
      download: '',
      style: { display: '' },
      click: vi.fn(),
      remove: vi.fn(),
    } as unknown as HTMLAnchorElement
    const documentRef = {
      body: { appendChild: vi.fn() },
      createElement: vi.fn().mockReturnValue(link),
    } as unknown as Document
    const urlApi = {
      createObjectURL: vi.fn().mockReturnValue('blob:export'),
      revokeObjectURL: vi.fn(),
    }
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new Blob(['zip']), { status: 200 }))

    await downloadEvaluationExportTask(
      {
        taskId: 'task/1',
        runId: '///',
        feature: 'checkout flow',
        mode: 'raw',
        status: 'completed',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        downloadReady: true,
      },
      { baseUrl: 'http://x', fetchImpl, documentRef, urlApi },
    )

    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/evaluation-exports/task%2F1/download', { method: 'GET' })
    expect(link.href).toBe('blob:export')
    expect(link.download).toBe('canary-lab-evaluation-checkout-flow-run.zip')
    expect(link.click).toHaveBeenCalled()
    expect(link.remove).toHaveBeenCalled()
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:export')
  })

  it('throws ApiError when evaluation export download fails with text body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('missing archive', { status: 404 }))
    await expect(downloadEvaluationExportTask(
      {
        taskId: 'missing',
        runId: 'run-1',
        feature: 'checkout',
        mode: 'raw',
        status: 'failed',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        downloadReady: false,
      },
      { fetchImpl, documentRef: {} as Document },
    )).rejects.toMatchObject({
      status: 404,
      body: 'missing archive',
    })
  })

  it('getDraftAgentLog fetches the full draft agent log by stage', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ content: 'full log' }))
    const out = await getDraftAgentLog('d/1', 'generating', { baseUrl: 'http://x', fetchImpl })
    expect(out).toEqual({ content: 'full log' })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/tests/draft/d%2F1/agent-log?stage=generating',
      { method: 'GET' },
    )
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

  it('getRunAudit fetches the run audit trail by id', async () => {
    const audit = { entries: [{ ts: 't', sessionId: null, clientKind: null, action: 'handoff' }] }
    const fetchImpl = vi.fn().mockResolvedValue(ok(audit))
    const out = await getRunAudit('r 1', { fetchImpl })
    expect(out).toEqual(audit)
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs/r%201/audit', { method: 'GET' })
  })

  it('uses verification target and config endpoints with encoded feature names', async () => {
    const targetIndex = {
      targets: [{ id: 'api', name: 'API', envVar: 'GATEWAY_URL' }],
      targetUrls: { api: 'https://api.example.com' },
    }
    const config = {
      id: 'config/1',
      featureId: 'checkout',
      name: 'Production',
      targetUrls: { api: 'https://api.example.com' },
      playwrightEnvsetId: 'production',
      createdAt: '2026-05-24T00:00:00.000Z',
      updatedAt: '2026-05-24T00:00:00.000Z',
    }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok(targetIndex))
      .mockResolvedValueOnce(ok(targetIndex))
      .mockResolvedValueOnce(ok([config]))
      .mockResolvedValueOnce(ok(config, 201))
      .mockResolvedValueOnce(ok({ ...config, name: 'Beta' }))

    await expect(getVerificationTargets('feat/a', 'production', { fetchImpl })).resolves.toEqual(targetIndex)
    await expect(getVerificationTargets('feat/a', undefined, { fetchImpl })).resolves.toEqual(targetIndex)
    await expect(listVerificationConfigs('feat/a', { fetchImpl })).resolves.toEqual([config])
    await expect(createVerificationConfig('feat/a', {
      name: 'Production',
      targetUrls: { api: 'https://api.example.com' },
      playwrightEnvsetId: 'production',
    }, { fetchImpl })).resolves.toEqual(config)
    await expect(updateVerificationConfig('feat/a', 'config/1', {
      name: 'Beta',
      targetUrls: { api: 'https://beta.example.com' },
      playwrightEnvsetId: 'production',
    }, { fetchImpl })).resolves.toMatchObject({ name: 'Beta' })

    expect(fetchImpl.mock.calls[0]).toEqual([
      '/api/features/feat%2Fa/verification-targets?envset=production',
      { method: 'GET' },
    ])
    expect(fetchImpl.mock.calls[1]).toEqual([
      '/api/features/feat%2Fa/verification-targets',
      { method: 'GET' },
    ])
    expect(fetchImpl.mock.calls[2]).toEqual([
      '/api/features/feat%2Fa/verification-configs',
      { method: 'GET' },
    ])
    expect(fetchImpl.mock.calls[3][0]).toBe('/api/features/feat%2Fa/verification-configs')
    expect(fetchImpl.mock.calls[3][1]).toMatchObject({ method: 'POST', headers: { 'content-type': 'application/json' } })
    expect(JSON.parse((fetchImpl.mock.calls[3][1] as RequestInit).body as string)).toEqual({
      name: 'Production',
      targetUrls: { api: 'https://api.example.com' },
      playwrightEnvsetId: 'production',
    })
    expect(fetchImpl.mock.calls[4][0]).toBe('/api/features/feat%2Fa/verification-configs/config%2F1')
    expect(fetchImpl.mock.calls[4][1]).toMatchObject({ method: 'PUT', headers: { 'content-type': 'application/json' } })
  })

  it('executes deployment verification with optional config and target overrides', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ runId: 'verify-1', executionType: 'verify' }, 201))

    await expect(executeVerification('feat/a', {
      configId: 'config/1',
      playwrightEnvsetId: 'production',
      targetUrls: { api: 'https://api.example.com' },
    }, { fetchImpl })).resolves.toEqual({ runId: 'verify-1', executionType: 'verify' })

    expect(fetchImpl).toHaveBeenCalledWith('/api/features/feat%2Fa/verifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        configId: 'config/1',
        playwrightEnvsetId: 'production',
        targetUrls: { api: 'https://api.example.com' },
      }),
    })
  })

  it('getAgentSession returns normalized events and maps 404 to null', async () => {
    const session = {
      agent: 'claude',
      sessionId: 'sid-1',
      events: [{ kind: 'assistant-message', timestamp: 't', text: 'done' }],
    }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok(session))
      .mockResolvedValueOnce(fail(404, { error: 'agent session not found' }))

    await expect(getAgentSession('run/1', { fetchImpl })).resolves.toEqual(session)
    await expect(getAgentSession('missing', { fetchImpl })).resolves.toBeNull()
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/runs/run%2F1/agent-session')
  })

  it('getAgentSession rethrows non-404 API errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(500, { error: 'boom' }))
    await expect(getAgentSession('run-1', { fetchImpl })).rejects.toMatchObject({ status: 500 })
  })

  it('getDraftAgentSession encodes the draft id and stage; 404 → null; non-404 throws', async () => {
    const { getDraftAgentSession } = await import('./client')
    const session = { agent: 'claude' as const, sessionId: 'sid', events: [] }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok(session))
      .mockResolvedValueOnce(fail(404, { reason: 'no-session-ref' }))
      .mockResolvedValueOnce(fail(500, { error: 'boom' }))
    await expect(getDraftAgentSession('d/1', 'planning', { fetchImpl })).resolves.toEqual(session)
    await expect(getDraftAgentSession('d/1', 'planning', { fetchImpl })).resolves.toBeNull()
    await expect(getDraftAgentSession('d/1', 'planning', { fetchImpl })).rejects.toMatchObject({ status: 500 })
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/tests/draft/d%2F1/agent-session?stage=planning')
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
    await expect(deleteJournalEntry(7, { run: 'r1' }, { fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith('/api/journal/7?run=r1', { method: 'DELETE' })
  })

  it('deleteJournalEntry omits the query string when no run filter is provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await expect(deleteJournalEntry(7, {}, { fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith('/api/journal/7', { method: 'DELETE' })
  })

  it('deleteJournalEntry throws ApiError on 404', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(404, { error: 'iteration not found' }))
    await expect(deleteJournalEntry(99, { run: 'r1' }, { fetchImpl })).rejects.toBeInstanceOf(ApiError)
  })

  it('createDraft POSTs payload, returns 201 body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'd1', status: 'planning' }, 201))
    const out = await createDraft(
      { prdText: 'p', repos: [{ name: 'r', localPath: '/r' }] },
      { fetchImpl },
    )
    expect(out).toEqual({ draftId: 'd1', status: 'planning' })
    const call = (fetchImpl.mock.calls[0] as [string, RequestInit])
    expect(call[0]).toBe('/api/tests/draft')
    expect(call[1].method).toBe('POST')
  })

  it('listDrafts fetches all wizard drafts', async () => {
    const drafts = [{ draftId: 'd1', prdText: 'p', prdDocuments: [], repos: [], status: 'planning', createdAt: 'c', updatedAt: 'u' }]
    const fetchImpl = vi.fn().mockResolvedValue(ok(drafts))
    await expect(listDrafts({ fetchImpl })).resolves.toEqual(drafts)
    expect(fetchImpl).toHaveBeenCalledWith('/api/tests/draft', { method: 'GET' })
  })

  it('extractPrdDocuments builds multipart form data with optional text and files', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ prdText: 'combined', documents: [] }))
    const file = new File(['hello'], 'prd.md', { type: 'text/markdown' })

    await extractPrdDocuments({ prdText: 'notes', files: [file] }, { fetchImpl })

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/tests/prd-documents')
    expect(init.method).toBe('POST')
    expect(init.body).toBeInstanceOf(FormData)
    const form = init.body as FormData
    expect(form.get('prdText')).toBe('notes')
    expect(form.getAll('files')).toEqual([file])
  })

  it('extractPrdDocuments omits empty optional PRD text', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ prdText: '', documents: [] }))

    await extractPrdDocuments({ files: [] }, { fetchImpl })

    const form = (fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as FormData
    expect(form.has('prdText')).toBe(false)
    expect(form.getAll('files')).toEqual([])
  })

  it('cancelDraftGeneration POSTs to cancel endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'd', status: 'cancelled' }))
    const out = await cancelDraftGeneration('d', { fetchImpl })
    expect(out.status).toBe('cancelled')
    expect(fetchImpl).toHaveBeenCalledWith('/api/tests/draft/d/cancel-generation', { method: 'POST' })
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
    await acceptPlan('d', [{ step: 's', actions: ['a'], expectedOutcome: 'e' }], undefined, { fetchImpl })
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body.plan).toBeDefined()
  })

  it('acceptPlan posts empty body when no plan supplied', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'd', status: 'generating' }, 202))
    await acceptPlan('d', undefined, undefined, { fetchImpl })
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body).toEqual({})
  })

  it('acceptPlan posts intentSummary when provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ draftId: 'd', status: 'generating' }, 202))
    await acceptPlan('d', undefined, 'Edited intent', { fetchImpl })
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)
    expect(body).toEqual({ intentSummary: 'Edited intent' })
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

  it('deleteFeature DELETEs with the typed confirmation name', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await expect(deleteFeature('a/b', 'a/b', { fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith('/api/features/a%2Fb', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmName: 'a/b' }),
    })
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
    const fetchImpl = vi.fn().mockResolvedValue(ok({ healAgent: 'auto', editor: 'auto', personalWikiPath: null }))
    const r = await getProjectConfig({ fetchImpl })
    expect(r).toEqual({ healAgent: 'auto', editor: 'auto', personalWikiPath: null })
    expect(fetchImpl).toHaveBeenCalledWith('/api/project-config', { method: 'GET' })
  })

  it('putProjectConfig sends the partial config as JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ healAgent: 'manual', editor: 'cursor', personalWikiPath: '/tmp/wiki' }))
    await putProjectConfig({ healAgent: 'manual', editor: 'cursor', personalWikiPath: '/tmp/wiki' }, { fetchImpl })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/project-config')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ healAgent: 'manual', editor: 'cursor', personalWikiPath: '/tmp/wiki' })
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

  it('sendAgentInput POSTs the data string', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ status: 'sent' }))
    await sendAgentInput('r1', 'hello\n', { fetchImpl })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/runs/r1/agent-input')
    expect(JSON.parse(init.body as string)).toEqual({ data: 'hello\n' })
  })

  it('restartRun POSTs to the restart route', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ status: 'restarted', mode: 'remaining' }, 202))
    await restartRun('r1', { fetchImpl })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/runs/r1/restart')
    expect(init.method).toBe('POST')
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

  it('readDotenvFile GETs the encoded dotenv path', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ path: '/repo/.env.local', entries: [], unparsedLines: [] }))
    await readDotenvFile('/repo/.env local', { fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/fs/read-dotenv?path=%2Frepo%2F.env%20local',
      { method: 'GET' },
    )
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

  it('startRun includes isolation when provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ runId: 'r-iso' }, 202))
    await startRun('feat-x', { fetchImpl, env: 'local', isolation: 'worktree' })
    const init = fetchImpl.mock.calls[0][1] as RequestInit
    expect(JSON.parse(init.body as string)).toEqual({ feature: 'feat-x', env: 'local', isolation: 'worktree' })
  })

  it('asRepoCollision returns the payload for a 409 collision ApiError, else null', () => {
    const collisionBody = {
      type: 'repo_collision_requires_choice',
      conflictingRunId: 'r1',
      conflictingFeature: 'foo',
      repoPaths: ['/a'],
      options: ['worktree', 'queue'],
      message: 'm',
    }
    expect(asRepoCollision(new ApiError(409, collisionBody))).toEqual(collisionBody)
    // Non-ApiError, wrong status, null body, non-object body, wrong type → null.
    expect(asRepoCollision(new Error('nope'))).toBeNull()
    expect(asRepoCollision(new ApiError(500, collisionBody))).toBeNull()
    expect(asRepoCollision(new ApiError(409, null))).toBeNull()
    expect(asRepoCollision(new ApiError(409, 'string body'))).toBeNull()
    expect(asRepoCollision(new ApiError(409, { type: 'something_else' }))).toBeNull()
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
