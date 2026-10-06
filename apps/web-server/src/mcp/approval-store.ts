import type { CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server'
import type { Approval } from '../../../../shared/approval'
import { FileBackedTaskStore } from '../../../../shared/lib/file-backed-task-store'
import type { WorkspaceEventPublisher } from '../shared/workspace-events'
import { waitForRunCondition } from './wait-for-run-condition'
import type { RunStoreEvent } from '../features/runs/logic/run-store'
import type { TaskStoreEvent } from '../../../../shared/lib/file-backed-task-store'

type Result = CallToolResult | InputRequiredResult
interface ApprovalRecord extends Approval { result?: Result }
export class ApprovalStore {
  private readonly records: FileBackedTaskStore<ApprovalRecord>
  private readonly continuations = new Map<string, (answer: Record<string, unknown>) => Promise<Result>>()
  constructor(logsDir: string, events?: WorkspaceEventPublisher) {
    this.records = new FileBackedTaskStore<ApprovalRecord>({ logsDir, dirName: 'approvals', recordFile: 'approval.json',
      idOf: (r) => r.id, indexEntryOf: (r) => ({ ...this.public(r), createdAt: r.startedAt }), sortNewestFirst: true,
      reconcile: { isInterrupted: (r) => r.status === 'pending' || r.status === 'answering',
        mark: (r) => ({ ...r, status: 'expired', error: 'Server restarted. Ask the requesting chat to resume; no approval is carried across a restart.' }) },
    })
    this.records.reconcileInterrupted(() => new Date().toISOString())
    this.records.onEvent(() => events?.publish({ type: 'approvals-changed' }))
  }
  private public(record: ApprovalRecord): Approval { const { result: _result, ...visible } = record; return visible }
  list(): Approval[] { this.expire(); return this.records.list().map(({ createdAt: _createdAt, ...r }) => r as unknown as Approval) }
  get(id: string): ApprovalRecord | null { return /^[a-f0-9-]{36}$/.test(id) ? this.records.get(id) : null }
  open(record: Approval, resume: (answer: Record<string, unknown>) => Promise<Result>): void {
    this.continuations.set(record.id, resume)
    this.records.save(record)
  }
  update(id: string, patch: Partial<ApprovalRecord>): void {
    const r = this.get(id)
    if (r) this.records.save({ ...r, ...patch })
    if (patch.status && patch.status !== 'pending' && patch.status !== 'answering') this.continuations.delete(id)
  }
  expire(): void {
    for (const row of this.records.list()) {
      if (row.status !== 'pending' || Date.parse(String(row.expiresAt)) > Date.now()) continue
      this.update(row.id, { status: 'expired', error: 'This approval expired. Ask the requesting chat to resume.' })
      this.continuations.delete(row.id)
    }
  }
  async answer(id: string, answer: Record<string, unknown>): Promise<Approval> {
    this.expire()
    const record = this.get(id)
    const resume = this.continuations.get(id)
    if (!record) throw Object.assign(new Error('Approval not found'), { statusCode: 404 })
    if (record.status === 'answered') return this.public(record)
    if (record.status !== 'pending' || !resume) throw Object.assign(new Error(record.error ?? 'This approval is no longer pending'), { statusCode: 409 })
    // The original command rechecks the current revision and owns the mutation.
    // Its elicitation helper settles both browser and chat answers exactly once.
    await resume(answer)
    return this.public(this.get(id)!)
  }
  async wait(id: string, timeoutMs: number): Promise<Result> {
    const listeners = new Map<(event: RunStoreEvent) => void, (event: TaskStoreEvent) => void>()
    const read = (): Result | null => {
      this.expire()
      const record = this.get(id)
      if (!record) return { isError: true, content: [{ type: 'text', text: 'Approval not found' }] }
      if (record.result && !('content' in record.result)) {
        const nextId = record.result.requestState
        const next = typeof nextId === 'string' ? this.get(nextId) : null
        if (next) return { content: [{ type: 'text', text: JSON.stringify({ status: 'needs-input', approvalId: next.id,
          reviewUrl: next.reviewUrl, next: 'The original command needs another human decision. Open the linked approval, then wait_for_approval with its approvalId.' }) }] }
        // A later URL-mode checkpoint is owned by its domain, not this inbox.
        // Preserve its request for the agent, but never echo its handle into
        // this read-only wait command as if it could apply that decision.
        return { content: [{ type: 'text', text: JSON.stringify({ status: 'needs-input', command: record.command,
          inputRequests: record.result.inputRequests, next: 'Complete the requested browser action, then resume the original command in the requesting chat.' }) }] }
      }
      return record.result ?? (record.status === 'expired' || record.status === 'failed'
        ? { content: [{ type: 'text', text: JSON.stringify(this.public(record)) }] } : null)
    }
    return waitForRunCondition({ runId: id, timeoutMs, maxWaitMs: 30_000, read,
      onTimeout: () => read() ?? { content: [{ type: 'text', text: JSON.stringify({ status: 'still_waiting', approvalId: id, next: 'Call wait_for_approval again. Only the human may answer in the chat form or browser.' }) }] },
      store: {
        onEvent: (listener) => { const mapped = (event: TaskStoreEvent) => listener({ kind: 'changed', runId: event.id }); listeners.set(listener, mapped); this.records.onEvent(mapped) },
        offEvent: (listener) => { this.records.offEvent(listeners.get(listener)!); listeners.delete(listener) },
      },
    })
  }
}
