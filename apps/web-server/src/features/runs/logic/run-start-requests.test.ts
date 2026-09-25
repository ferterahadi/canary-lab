import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunStartRequests, runStartRequestStore } from './run-start-requests'
import { RunStore, createRegistry } from './run-store'
import { suiteReviewRevision } from './runtime/suite-review'
import type { TestReviewReceipt, TestReviewRequiredInfo } from '../../../../../../shared/test-review'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-request-store-'))
  roots.push(root)
  const runs = new RunStore(root, createRegistry())
  runs.bootstrap({ runId: 'source', feature: 'checkout', status: 'aborted', startedAt: 'now', services: [], healCycles: 0 })
  const publish = vi.fn()
  const requests = new RunStartRequests(runs, { publish })
  const review: TestReviewRequiredInfo = { type: 'test_review_required', feature: 'checkout', runId: 'source', review_revision: 'a'.repeat(64), changedFileCount: 1, error: 'Review needed', reviewUrl: '/?dialog=tests-review' }
  const pending = requests.remember(review, { feature: 'checkout', env: 'dev' })
  const receipt: TestReviewReceipt = { decision: 'accepted', review_revision: review.review_revision, files: ['e2e/a.spec.ts'], at: 'now', git: { status: 'committed', commit: 'test' }, execution: { status: 'new-run-required', runId: 'source' } }
  const decide = (complete: boolean) => runs.patchManifest('source', { specEdits: { checkedAt: 'now', pending: [], adopted: [], reviewDecisions: [{ at: 'now', revision: review.review_revision, decision: 'approved-for-new-run', ...(complete ? { receipt } : {}) }] } })
  return { root, runs, requests, pending, decide, publish }
}

describe('durable run request recovery', () => {
  it('keeps requests aligned with suite renames and tolerates missing records', async () => {
    const { root, requests, pending, publish } = fixture()
    const store = runStartRequestStore(root)
    expect(store.renameFeature('checkout', 'renamed')).toBe(1)
    expect(requests.get(pending.requestId)?.feature).toBe('renamed')
    expect(store.get(pending.requestId)?.payload.feature).toBe('renamed')
    fs.unlinkSync(path.join(root, 'run-requests', pending.requestId, 'request.json'))
    expect(requests.list()).toEqual([])
    expect(requests.get('../invalid')).toBeNull()
    expect(requests.get(pending.requestId)).toBeNull()
    expect(requests.cancel('missing')).toBeNull()
    expect(await requests.resume('missing', vi.fn())).toMatchObject({ statusCode: 404 })
    publish.mockClear()
    store.remove(pending.requestId)
    expect(publish).not.toHaveBeenCalled()
  })

  it('keeps cancellation idempotent and refuses continuation without a human receipt', async () => {
    const { requests, pending } = fixture()
    expect(await requests.resume(pending.requestId, vi.fn())).toMatchObject({ statusCode: 409, body: { request: { status: 'awaiting-review' } } })
    expect(requests.cancel(pending.requestId)?.status).toBe('cancelled')
    const version = requests.cancel(pending.requestId)?.version
    expect(requests.cancel(pending.requestId)?.version).toBe(version)
  })

  it('records queued dispatches once, preserves their identity on replay, and refuses late cancellation', async () => {
    const { requests, pending, decide } = fixture()
    decide(true)
    const dispatch = vi.fn(async () => ({ statusCode: 202, body: { runId: 'queued-run' } }))
    expect(await requests.resume(pending.requestId, dispatch)).toMatchObject({ body: { request: { status: 'queued' } } })
    expect(await requests.resume(pending.requestId, dispatch)).toMatchObject({ statusCode: 202, body: { runId: 'queued-run', reused: true } })
    expect(dispatch).toHaveBeenCalledOnce()
    expect(() => requests.cancel(pending.requestId)).toThrow('already started')
  })

  it('rebinds a resumed request if the suite changes again before execution', async () => {
    const { requests, pending, decide } = fixture()
    decide(true)
    expect(await requests.resume(pending.requestId, async () => ({ statusCode: 409, body: { type: 'test_review_required', runId: 'new-source', review_revision: 'b'.repeat(64) } })))
      .toMatchObject({ body: { request: { status: 'awaiting-review', review: { runId: 'new-source', revision: 'b'.repeat(64) } } } })
  })

  it.each([new Error('dispatch disconnected'), 'non-error rejection'])('records dispatch failure without replacing the approved request (%s)', async (error) => {
    const { requests, pending, decide } = fixture()
    decide(true)
    expect(await requests.resume(pending.requestId, async () => { throw error }))
      .toMatchObject({ statusCode: 500, body: { request: { status: 'failed', error: error instanceof Error ? error.message : 'The run could not start.' } } })
    expect(requests.allocatedRunId(pending.requestId)).toBeUndefined()
  })

  it('surfaces a dispatch rejection without an error string and a persistence failure without unhandled rejections', async () => {
    const { requests, pending, decide, root } = fixture()
    decide(true)
    expect(await requests.resume(pending.requestId, async () => ({ statusCode: 409, body: {} })))
      .toMatchObject({ body: { request: { error: 'The run could not start. Review the latest run-start conditions.' } } })
    const record = runStartRequestStore(root).get(pending.requestId)!
    runStartRequestStore(root).save({ ...record, status: 'ready' })
    const save = vi.spyOn(runStartRequestStore(root), 'save').mockImplementation(() => { throw new Error('disk full') })
    await expect(requests.resume(pending.requestId, vi.fn())).rejects.toThrow('disk full')
    await Promise.resolve()
    save.mockRestore()
  })
  it.each([
    { decision: 'restored', external: false, status: 'ready' },
    { decision: 'adopted', external: false, status: 'ready' },
    { decision: 'restored', external: true, status: 'cancelled' },
    { decision: 'adopted', external: true, status: 'ready' },
  ] as const)('recovers a newer $decision boundary for external=$external, but never from an empty diff alone', ({ decision, external, status }) => {
    const { root, runs, requests, pending: internal } = fixture()
    const pending = external ? requests.remember({ type: 'test_review_required', feature: 'checkout', runId: 'source',
      review_revision: 'a'.repeat(64), changedFileCount: 1, error: 'Review needed', reviewUrl: '/?dialog=tests-review' },
    { feature: 'checkout', healAgent: { sessionId: 'owner', clientKind: 'codex' } }) : internal
    const featureDir = path.join(root, 'live')
    const snapshot = path.join(root, 'snapshot')
    fs.mkdirSync(featureDir)
    fs.mkdirSync(snapshot)
    fs.writeFileSync(path.join(featureDir, 'helper.ts'), 'recorded')
    fs.writeFileSync(path.join(snapshot, 'helper.ts'), 'recorded')
    runs.patchManifest('source', { featureDir, suiteSnapshot: { kind: 'taken', dir: snapshot, takenAt: 'now', digest: 'recorded' } })
    expect(requests.get(pending.requestId)?.status).toBe('awaiting-review')
    const at = new Date().toISOString()
    const revision = 'b'.repeat(64)
    runs.patchManifest('source', { specEdits: { checkedAt: at, pending: [], adopted: [], reviewDecisions: [{
      at, revision, decision, receipt: { decision: decision === 'adopted' ? 'accepted' : 'restored', review_revision: revision,
        files: ['helper.ts'], at, git: { status: 'not-requested' }, execution: { status: 'none' } },
    }] } })
    expect(requests.get(pending.requestId)).toMatchObject({ status, review: { revision } })
  })
  it.each(['restored', 'approved-for-new-run'] as const)('settles an external request after a %s receipt', async (decision) => {
    const { runs, requests } = fixture()
    const review: TestReviewRequiredInfo = { type: 'test_review_required', feature: 'checkout', runId: 'source',
      review_revision: 'b'.repeat(64), changedFileCount: 1, error: 'Review needed', reviewUrl: '/?dialog=tests-review' }
    const pending = requests.remember(review, { feature: 'checkout', healAgent: { sessionId: 'owner', clientKind: 'claude' } })
    runs.patchManifest('source', { specEdits: { checkedAt: 'now', pending: [], adopted: [], reviewDecisions: [{
      at: 'now', revision: review.review_revision, decision,
      receipt: { decision: decision === 'restored' ? 'restored' : 'accepted', review_revision: review.review_revision,
        files: ['e2e/a.spec.ts'], at: 'now', git: { status: 'not-requested' },
        execution: decision === 'restored' ? { status: 'none' } : { status: 'new-run-required', runId: 'source' } },
    }] } })
    expect(requests.get(pending.requestId)?.status).toBe(decision === 'restored' ? 'cancelled' : 'ready')
    const dispatch = vi.fn()
    if (decision === 'restored') {
      expect(await requests.resume(pending.requestId, dispatch)).toMatchObject({ statusCode: 409, body: { request: { status: 'cancelled' } } })
      expect(dispatch).not.toHaveBeenCalled()
    }
  })
  it('finds a completed receipt for a newer still-different candidate without first observing that edit', () => {
    const { root, runs, requests, pending } = fixture()
    const featureDir = path.join(root, 'live')
    const snapshot = path.join(root, 'snapshot')
    fs.mkdirSync(featureDir)
    fs.mkdirSync(snapshot)
    fs.writeFileSync(path.join(featureDir, 'helper.ts'), 'candidate')
    fs.writeFileSync(path.join(snapshot, 'helper.ts'), 'recorded')
    const revision = suiteReviewRevision(snapshot, featureDir)
    const at = new Date().toISOString()
    runs.patchManifest('source', { featureDir, suiteSnapshot: { kind: 'taken', dir: snapshot, takenAt: at, digest: 'recorded' }, specEdits: {
      checkedAt: at, pending: [], adopted: [], reviewDecisions: [{ at, revision, decision: 'approved-for-new-run', receipt: {
        decision: 'accepted', review_revision: revision, files: ['helper.ts'], at, git: { status: 'not-requested' }, execution: { status: 'new-run-required', runId: 'source' },
      } }],
    } })
    expect(requests.get(pending.requestId)).toMatchObject({ status: 'ready', review: { revision } })
  })
  it('recovers complete receipt state after reload or a missed event, but never consumes an intermediate decision', () => {
    const { root, requests, pending, decide } = fixture()
    decide(false)
    expect(requests.get(pending.requestId)?.status).toBe('awaiting-review')
    requests.dispose()
    decide(true)
    const reconnected = new RunStartRequests(new RunStore(root, createRegistry()))
    expect(reconnected.get(pending.requestId)).toMatchObject({ status: 'ready', owner: { kind: 'internal' }, review: pending.review })
    expect(reconnected.get(pending.requestId)).not.toHaveProperty('payload')
    reconnected.dispose()
  })

  it.each(['running', 'queued'] as const)('reconciles an interrupted %s dispatch against its reserved run instead of starting twice', (status) => {
    const { root, runs, requests, pending } = fixture()
    const file = path.join(root, 'run-requests', pending.requestId, 'request.json')
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...record, status: 'starting' }))
    runs.bootstrap({ runId: record.allocatedRunId, feature: 'checkout', status, startedAt: 'later', services: [], healCycles: 0 })
    requests.reconcileInterrupted()
    expect(requests.get(pending.requestId)).toMatchObject({ status: status === 'queued' ? 'queued' : 'started', runId: record.allocatedRunId })
    requests.reconcileInterrupted()
  })

  it('marks ambiguous interrupted dispatches failed and never silently replays them', async () => {
    const { root, requests, pending } = fixture()
    const file = path.join(root, 'run-requests', pending.requestId, 'request.json')
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.writeFileSync(file, JSON.stringify({ ...record, status: 'starting' }))
    requests.reconcileInterrupted()
    const dispatch = vi.fn()
    expect(await requests.resume(pending.requestId, dispatch)).toMatchObject({ statusCode: 409, body: { request: { status: 'failed' } } })
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('retains original owner and reports a failed continuation separately from accepted review', async () => {
    const { requests, pending, decide } = fixture()
    decide(true)
    expect(await requests.resume(pending.requestId, async () => ({ statusCode: 409, body: { error: 'Repository is busy' } }))).toMatchObject({ statusCode: 409, body: { request: { status: 'failed', error: 'Repository is busy', owner: { kind: 'internal' } } } })
  })
})
