import { createHash, randomUUID } from 'crypto'
import { sharedTaskStore, type TaskStoreEvent } from '../../../../../../shared/lib/file-backed-task-store'
import type { RunRequestOwner, RunStartRequest, TestReviewRequiredInfo } from '../../../../../../shared/test-review'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'
import type { RunStore } from './run-store'
import { generateRunId } from './runtime/run-id'
import { suiteReviewFiles } from './runtime/suite-review'
import { suiteRuntimeInputTargetsForSnapshot } from './runtime/suite-runtime-inputs'

interface StoredRequest extends RunStartRequest {
  payload: Record<string, unknown>
  fingerprint: string
  allocatedRunId: string
}

export interface StartRequestResponse { statusCode: number; body: Record<string, unknown> }

const pendingStates = new Set<RunStartRequest['status']>(['awaiting-review', 'ready', 'starting'])
const statusAfterReview = (record: StoredRequest, decision: 'restored' | 'adopted' | 'approved-for-new-run') =>
  decision === 'restored' && record.owner.kind === 'external' ? 'cancelled' as const : 'ready' as const

export function runStartRequestStore(logsDir: string) {
  return sharedTaskStore<StoredRequest>({
    logsDir, dirName: 'run-requests', recordFile: 'request.json',
    idOf: (record) => record.requestId,
    indexEntryOf: (record) => ({ id: record.requestId, createdAt: record.createdAt, status: record.status, feature: record.feature }),
    featureOf: (record) => record.feature,
    withFeature: (record, feature) => ({ ...record, feature, payload: { ...record.payload, feature } }),
  })
}

/** The review receipt authorizes bytes. This record preserves the independent
 * execution intent, original owner and launch parameters across reconnects. */
export class RunStartRequests {
  private readonly store
  private readonly inFlight = new Map<string, Promise<StartRequestResponse>>()
  private readonly activeDispatches = new Set<string>()
  private readonly onStoreEvent = (event: TaskStoreEvent) => {
    const record = this.read(event.id)
    if (record) publishWorkspaceEvent(this.events, { type: 'tests-changed', feature: record.feature })
  }

  constructor(private readonly runs: RunStore, private readonly events?: WorkspaceEventPublisher) {
    this.store = runStartRequestStore(runs.logsDir)
    this.store.onEvent(this.onStoreEvent)
  }

  dispose(): void { this.store.offEvent(this.onStoreEvent) }

  private read(id: string): StoredRequest | null {
    return /^[\w-]+$/.test(id) ? this.store.get(id) : null
  }

  private public(record: StoredRequest): RunStartRequest {
    const { payload: _payload, fingerprint: _fingerprint, allocatedRunId: _allocated, ...result } = record
    return result
  }

  private save(record: StoredRequest, patch: Partial<StoredRequest>): StoredRequest {
    const next = { ...record, ...patch, version: record.version + 1, updatedAt: new Date().toISOString() }
    this.store.save(next)
    return next
  }

  list(): RunStartRequest[] {
    return this.store.list().flatMap((entry) => {
      const record = this.read(entry.id)
      return record ? [this.public(record)] : []
    })
  }

  get(id: string): RunStartRequest | null {
    const record = this.read(id)
    return record ? this.public(this.refresh(record)) : null
  }

  remember(review: TestReviewRequiredInfo, payload: Record<string, unknown>): RunStartRequest {
    const external = payload.healAgent as { sessionId: string; clientKind: string; conversationName?: string } | undefined
    const owner: RunRequestOwner = external
      ? { kind: 'external', sessionId: external.sessionId, clientKind: external.clientKind, ...(external.conversationName ? { conversationName: external.conversationName } : {}) }
      : { kind: 'internal' }
    const fingerprint = createHash('sha256').update(JSON.stringify([owner, payload])).digest('hex')
    const existing = this.store.list().map((entry) => this.read(entry.id))
      .find((record) => record?.fingerprint === fingerprint && pendingStates.has(record.status))
    if (existing) return this.public(existing)
    const now = new Date().toISOString()
    const record: StoredRequest = {
      requestId: randomUUID(), feature: review.feature, owner, status: 'awaiting-review',
      version: 0, createdAt: now, updatedAt: now,
      review: { runId: review.runId, revision: review.review_revision },
      payload, fingerprint, allocatedRunId: generateRunId(),
    }
    return this.public(this.save(record, {}))
  }

  private refresh(record: StoredRequest): StoredRequest {
    if (record.status !== 'awaiting-review') return record
    const manifest = this.runs.get(record.review.runId)?.manifest
    const decision = manifest?.specEdits?.reviewDecisions
      ?.find((item) => item.revision === record.review.revision && item.receipt)
    // An intermediate adoption entry or an empty diff is not a completed
    // decision. The full persisted receipt closes the mutation boundary.
    if (decision) return this.save(record, {
      status: statusAfterReview(record, decision.decision),
      error: undefined,
    })
    if (manifest?.suiteSnapshot?.kind === 'taken' && manifest.featureDir) {
      try {
        const current = suiteReviewFiles(manifest.suiteSnapshot.dir, manifest.featureDir, suiteRuntimeInputTargetsForSnapshot(manifest.suiteSnapshot.dir))
        // A newer review may be restored or adopted before this request sees
        // its revision. Require a human receipt after the request, plus the
        // matching recorded boundary; an empty diff alone is not approval.
        const settledBoundary = current.files.length === 0 && [...(manifest.specEdits?.reviewDecisions ?? [])].reverse()
          .find((item) => (item.decision === 'restored' || item.decision === 'adopted') && item.receipt && item.at >= record.createdAt)
        if (settledBoundary) return this.save(record, {
          status: statusAfterReview(record, settledBoundary.decision),
          review: { runId: record.review.runId, revision: settledBoundary.revision }, error: undefined,
        })
        if (current.files.length && current.revision !== record.review.revision) {
          const settled = manifest.specEdits?.reviewDecisions?.find((item) => item.revision === current.revision && item.receipt)
          const status = settled ? statusAfterReview(record, settled.decision) : 'awaiting-review'
          return this.save(record, { review: { runId: record.review.runId, revision: current.revision }, status })
        }
      } catch { /* retain the blocker when its source is temporarily unavailable */ }
    }
    return record
  }

  owns(record: RunStartRequest, sessionId: string | undefined, externalOrigin: boolean): boolean {
    return record.owner.kind === 'external'
      ? externalOrigin && record.owner.sessionId === sessionId
      : !externalOrigin
  }

  cancel(id: string): RunStartRequest | null {
    const record = this.read(id)
    if (!record) return null
    if (record.status === 'starting' || record.status === 'started' || record.status === 'queued') {
      throw Object.assign(new Error('This request has already started. Stop the run from its run controls.'), { statusCode: 409 })
    }
    return this.public(record.status === 'cancelled' ? record : this.save(record, { status: 'cancelled' }))
  }

  /** Only the dispatcher's in-process injection can reuse the reserved run id.
   * A normal HTTP body cannot smuggle an arbitrary id into the run factory. */
  allocatedRunId(id: string | undefined): string | undefined {
    return id && this.activeDispatches.has(id) ? this.read(id)?.allocatedRunId : undefined
  }

  reconcileInterrupted(): void {
    for (const entry of this.store.list()) {
      const record = this.read(entry.id)
      if (record?.status !== 'starting') continue
      const run = this.runs.get(record.allocatedRunId)
      this.save(record, run
        ? { status: run.manifest.status === 'queued' ? 'queued' : 'started', runId: record.allocatedRunId }
        : { status: 'failed', error: 'The server restarted while starting this request. No recorded run was found; inspect before requesting another run.' })
    }
  }

  resume(id: string, dispatch: (payload: Record<string, unknown>) => Promise<StartRequestResponse>): Promise<StartRequestResponse> {
    const existing = this.inFlight.get(id)
    if (existing) return existing
    const work = this.performResume(id, dispatch)
    this.inFlight.set(id, work)
    void work.finally(() => this.inFlight.delete(id)).catch(() => { /* the caller receives the original dispatch failure */ })
    return work
  }

  private async performResume(id: string, dispatch: (payload: Record<string, unknown>) => Promise<StartRequestResponse>): Promise<StartRequestResponse> {
    const found = this.read(id)
    if (!found) return { statusCode: 404, body: { error: 'Run request not found' } }
    let record = this.refresh(found)
    if (record.status === 'started' || record.status === 'queued') return {
      statusCode: record.status === 'queued' ? 202 : 200,
      body: { runId: record.runId, status: record.status, reused: true, request: this.public(record) },
    }
    if (record.status !== 'ready') return { statusCode: 409, body: { error: record.error ?? 'This run request is not ready to continue.', request: this.public(record) } }
    record = this.save(record, { status: 'starting' })
    this.activeDispatches.add(id)
    try {
      const result = await dispatch({ ...record.payload, resumeRequestId: id })
      if (result.statusCode < 300 && typeof result.body.runId === 'string') {
        record = this.save(record, { status: result.statusCode === 202 ? 'queued' : 'started', runId: result.body.runId, error: undefined })
      } else if (result.body.type === 'test_review_required') {
        const review = result.body as unknown as TestReviewRequiredInfo
        record = this.save(record, { status: 'awaiting-review', review: { runId: review.runId, revision: review.review_revision }, error: undefined })
      } else {
        record = this.save(record, { status: 'failed', error: String(result.body.error ?? 'The run could not start. Review the latest run-start conditions.') })
      }
      return { ...result, body: { ...result.body, request: this.public(record) } }
    } catch (error) {
      record = this.save(record, { status: 'failed', error: error instanceof Error ? error.message : 'The run could not start.' })
      return { statusCode: 500, body: { error: record.error, request: this.public(record) } }
    } finally {
      this.activeDispatches.delete(id)
    }
  }
}
