import { describe, it, expect, vi } from 'vitest'
import {
  listRuns,
  getRunDetail,
  getRunQueue,
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
  getRunTestReview,
  asTestReviewRequired,
  getRunStartRequest,
  cancelRunStartRequest,
  acceptRunTestReview,
  adoptSpecEdits,
  restoreSpecEdits,
  deleteRun,
  listJournal,
} from './runs'
import { ok, fail } from './__fixtures__/response'
import { ApiError } from './internal'

describe('runs api', () => {
  it('recognizes a structured review gate without classifying unrelated conflicts or incomplete payloads', () => {
    const review = { type: 'test_review_required', feature: 'checkout', runId: 'source-run', review_revision: 'rev', changedFileCount: 2, reviewUrl: '/?dialog=tests-review' }
    expect(asTestReviewRequired(new ApiError(409, review))).toEqual(review)
    for (const error of [new Error('test_review_required'), new ApiError(500, review), new ApiError(409, null), new ApiError(409, 'text'), new ApiError(409, { type: 'test_review_required' }), new ApiError(409, { ...review, type: 'repo_collision_requires_choice' })]) {
      expect(asTestReviewRequired(error)).toBeNull()
    }
  })

  it('observes and cancels durable requests by encoded id without issuing a fresh run start', async () => {
    const record = { requestId: 'request 1', status: 'cancelled' }
    const fetchImpl = vi.fn().mockImplementation(async () => ok(record))
    await expect(getRunStartRequest('request 1', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(record)
    await expect(cancelRunStartRequest('request 1', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(record)
    expect(fetchImpl.mock.calls).toEqual([
      ['http://x/api/run-requests/request%201', { method: 'GET' }],
      ['http://x/api/run-requests/request%201/cancel', { method: 'POST' }],
    ])
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

  it('getRunQueue reports why a run is parked, and reports no queue at all as null', async () => {
    const diagnostics = { position: 2, waitingOn: 'run-1', repoPaths: ['/repos/shop'] }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok({ diagnostics }))
      .mockResolvedValueOnce(ok({ diagnostics: null }))
    await expect(getRunQueue('run 9', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual({ diagnostics })
    // A run that is not queued answers with an explicit null — the panel needs
    // to tell "not waiting" apart from "we could not find out".
    await expect(getRunQueue('run-1', { fetchImpl })).resolves.toEqual({ diagnostics: null })
    expect(fetchImpl.mock.calls.map((call) => call[0])).toEqual(['http://x/api/runs/run%209/queue', '/api/runs/run-1/queue'])
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

  it('startRun carries a robustness envelope as the run\'s perturbation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ runId: 'rp' }, 201))
    const perturbation = { format: 'canary-lab/robustness-envelope@1' as const, latency: { ms: 250 } }
    await startRun('feat-x', { fetchImpl, env: 'local', perturbation })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ feature: 'feat-x', env: 'local', perturbation }),
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

  it('getRunTestReview fetches the lightweight authoritative review state', async () => {
    const review = { runId: 'r4', feature: 'alpha', baseline: 'run-start', review_revision: 'a'.repeat(64),
      files: [{ file: 'e2e/fixture.ts', change: 'modified' }], canAdopt: true }
    const fetchImpl = vi.fn().mockResolvedValue(ok(review))
    await expect(getRunTestReview('r 4', { fetchImpl })).resolves.toEqual(review)
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs/r%204/test-review?summary=true', { method: 'GET' })
  })

  it('adoptSpecEdits POSTs to /adopt-spec-edits and returns the 202 body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: 'adopted', adopted: ['e2e/a.spec.ts'], rerun: 'signalled' }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(adoptSpecEdits('r4', { baseUrl: '', fetchImpl })).resolves.toEqual({ status: 'adopted', adopted: ['e2e/a.spec.ts'], rerun: 'signalled' })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs/r4/adopt-spec-edits', { method: 'POST' })
  })

  it('acceptRunTestReview posts the exact revision to the shared acceptance workflow', async () => {
    const receipt = { decision: 'accepted', review_revision: 'a'.repeat(64), files: ['e2e/a.spec.ts'], at: 'now', git: { status: 'committed', commit: 'abc' }, execution: { status: 'rerun-requested', runId: 'r4' } }
    const fetchImpl = vi.fn().mockResolvedValue(ok(receipt, 202))
    await expect(acceptRunTestReview('r4', receipt.review_revision, { baseUrl: '', fetchImpl })).resolves.toEqual(receipt)
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs/r4/accept-test-review', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: receipt.review_revision }),
    })
  })

  it('restoreSpecEdits POSTs to /restore-spec-edits and returns the restored files', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ status: 'restored', restored: ['e2e/a.spec.ts'] }))
    await expect(restoreSpecEdits('r4', { baseUrl: '', fetchImpl })).resolves.toEqual({ status: 'restored', restored: ['e2e/a.spec.ts'] })
    expect(fetchImpl).toHaveBeenCalledWith('/api/runs/r4/restore-spec-edits', { method: 'POST' })
  })

  it('sends the exact reviewed revision when adopting or restoring', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok({ status: 'adopted', adopted: ['e2e/fixture.ts'], rerun: 'signalled' }, 202))
      .mockResolvedValueOnce(ok({ status: 'restored', restored: ['e2e/fixture.ts'] }))
    const options = { fetchImpl, expectedRevision: 'b'.repeat(64) }
    await adoptSpecEdits('r4', options)
    await restoreSpecEdits('r4', options)
    const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedRevision: 'b'.repeat(64) }) }
    expect(fetchImpl).toHaveBeenNthCalledWith(1, '/api/runs/r4/adopt-spec-edits', init)
    expect(fetchImpl).toHaveBeenNthCalledWith(2, '/api/runs/r4/restore-spec-edits', init)
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
