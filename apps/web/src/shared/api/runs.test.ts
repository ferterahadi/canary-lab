import { describe, it, expect, vi } from 'vitest'
import {
  listRuns,
  getRunDetail,
  getRunAudit,
  pinFeatureBranchesToCurrent,
  startRun,
  pauseHealRun,
  cancelHealRun,
  sendAgentInput,
  restartRun,
  applyRunFixes,
  getGhStatus,
  getRunPrPreflight,
  getRunFixPatch,
  getRunApplyPreflight,
  openRunRepo,
  proposeRunPr,
  stopRun,
  deleteRun,
  listJournal,
} from './runs'
import { ok, fail } from './__fixtures__/response'

describe('runs api', () => {
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

  it('startRun forwards boot mode in the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ runId: 'rb' }, 201))
    await startRun('feat-x', { fetchImpl, env: 'local', mode: 'boot' })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'feat-x', env: 'local', mode: 'boot' }),
    })
  })

  it('startRun rides the launch-gate model plan in the body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ runId: 'rm' }, 201))
    const models = { heal: { model: 'opus', effort: 'high' } }
    await startRun('feat-x', { fetchImpl, models })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'feat-x', models }),
    })
  })

  it('startRun forwards the Getting Started source so the server can claim it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ runId: 'rd' }, 201))
    await startRun('feat-x', { fetchImpl, gettingStartedSource: 'internal' })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'feat-x', gettingStartedSource: 'internal' }),
    })
  })

  it('startRun identifies which normal-run demo card owns the claim', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ runId: 'rh' }, 201))
    await startRun('workflow-workbench', {
      fetchImpl,
      gettingStartedSource: 'internal',
      gettingStartedWorkflow: 'heal',
    })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        feature: 'workflow-workbench',
        gettingStartedSource: 'internal',
        gettingStartedWorkflow: 'heal',
      }),
    })
  })

  it('startRun omits mode for a normal test run', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ runId: 'rt' }, 201))
    await startRun('feat-x', { fetchImpl, mode: 'test' })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'feat-x' }),
    })
  })

  it('stopRun POSTs to /abort and resolves on 204 (empty body)', async () => {
    // Response disallows status 204 with a body — pass `null` body explicitly.
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await expect(stopRun('r3', { fetchImpl })).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs/r3/abort', { method: 'POST' })
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

  it('pinFeatureBranchesToCurrent POSTs to the pin-current-branches endpoint', async () => {
    const result = { name: 'feat-a', pins: [{ name: 'repo/b', branch: 'main' }] }
    const fetchImpl = vi.fn().mockResolvedValue(ok(result))
    expect(await pinFeatureBranchesToCurrent('feat/a', { baseUrl: 'http://x', fetchImpl })).toEqual(result)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/features/feat%2Fa/pin-current-branches',
      { method: 'POST' },
    )
  })

  it('applyRunFixes POSTs every captured repo when no repo is named', async () => {
    const body = { results: [{ repoName: 'fnb', ok: true }], allOk: true }
    const fetchImpl = vi.fn().mockResolvedValue(ok(body))
    await expect(applyRunFixes('run 9', undefined, { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(body)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/runs/run%209/apply-fixes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
  })

  it('applyRunFixes narrows the body to one repo when named', async () => {
    const body = { results: [{ repoName: 'fnb', ok: true }], allOk: true }
    const fetchImpl = vi.fn().mockResolvedValue(ok(body))
    await expect(applyRunFixes('r1', 'fnb', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(body)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/runs/r1/apply-fixes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"repoName":"fnb"}',
    })
  })

  it('applyRunFixes surfaces the 409 when a run captured no fixes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(409, { error: 'this run captured no fixes to apply' }))
    await expect(applyRunFixes('r1', undefined, { baseUrl: 'http://x', fetchImpl })).rejects.toMatchObject({ name: 'ApiError', status: 409 })
  })

  it('getRunFixPatch GETs one repo\'s captured patch text', async () => {
    const body = { repoName: 'mighty cns', patchPath: '/p.patch', files: 3, diff: '@@ -1 +1 @@\n+x\n' }
    const fetchImpl = vi.fn().mockResolvedValue(ok(body))
    await expect(getRunFixPatch('run 9', 'mighty cns', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(body)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/runs/run%209/fixes/mighty%20cns/patch', { method: 'GET' })
  })

  it('getRunFixPatch surfaces the 410 once the patch has been cleaned away', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(fail(410, { error: 'the patch file is no longer on disk' }))
    await expect(getRunFixPatch('r1', 'prod', { baseUrl: 'http://x', fetchImpl })).rejects.toMatchObject({ name: 'ApiError', status: 410 })
  })

  it('getRunApplyPreflight GETs what applying would land on, per repo', async () => {
    const body = { targets: [{ repoName: 'fnb', repoRoot: '/r', ready: true, foreignDirty: [], branch: 'main' }] }
    const fetchImpl = vi.fn().mockResolvedValue(ok(body))
    await expect(getRunApplyPreflight('run 9', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(body)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/runs/run%209/apply-preflight', { method: 'GET' })
  })

  it('openRunRepo POSTs the repo name and returns what the editor did', async () => {
    const body = { opened: true, path: '/r/fnb', editor: 'code' }
    const fetchImpl = vi.fn().mockResolvedValue(ok(body))
    await expect(openRunRepo('r1', 'mighty cns', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(body)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/runs/r1/open-repo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"repoName":"mighty cns"}',
    })
  })

  it('getGhStatus GETs the app-level gh status', async () => {
    const status = { installed: true, authenticated: true, account: 'me', host: 'github.com' }
    const fetchImpl = vi.fn().mockResolvedValue(ok(status))
    await expect(getGhStatus({ baseUrl: 'http://x', fetchImpl })).resolves.toEqual(status)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/gh/status', { method: 'GET' })
  })

  it('getRunPrPreflight GETs the per-repo preflight', async () => {
    const preflight = { gh: { installed: true, authenticated: true }, repos: [], anyPushable: false }
    const fetchImpl = vi.fn().mockResolvedValue(ok(preflight))
    await expect(getRunPrPreflight('run 9', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(preflight)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/runs/run%209/pr-preflight', { method: 'GET' })
  })

  it('proposeRunPr POSTs and returns the per-repo PR results', async () => {
    const body = { results: [{ repoName: 'fnb', ok: true, pr: { repoName: 'fnb', url: 'https://github.com/o/r/pull/1', branch: 'b', base: 'main', createdAt: 'T' } }] }
    const fetchImpl = vi.fn().mockResolvedValue(ok(body))
    await expect(proposeRunPr('run 9', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(body)
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/runs/run%209/propose-pr', { method: 'POST' })
  })
})
