import type { RunDetail, RunIndexEntry } from '@/shared/api/types'

export interface RunWaitingState {
  kind: 'test-review' | 'agent' | 'queued'
  label: string
  detail: string
}

export const AGENT_WAITING_STATE: RunWaitingState = {
  kind: 'agent',
  label: 'Awaiting Agent',
  detail: 'The external repair session is waiting or disconnected. Resume the agent to continue, or stop the heal.',
}

/** Healing is the resumable run phase, not proof that an agent is working.
 *  Keep the lifecycle/actions intact and qualify its presentation with the
 *  pending edits and external session that the run stream already carries. */
export function runWaitingState(input: RunDetail | RunIndexEntry | null | undefined): RunWaitingState | undefined {
  if (!input) return undefined
  const detail = 'manifest' in input ? input : undefined
  const run = detail ? detail.manifest : input as RunIndexEntry
  if (run.status === 'queued') return {
    kind: 'queued', label: 'Queued',
    detail: 'Services and tests have not started. Open the run to see why it is waiting.',
  }
  if (run.status !== 'healing') return undefined
  const pending = detail ? detail.manifest.specEdits?.pending.length ?? 0 : (input as RunIndexEntry).pendingSpecEdits ?? 0
  const session = detail?.manifest.externalHealSession
  const phase = detail?.manifest.lifecycle?.phase
  // Pending edits are not a reason to relabel actively executing repair work.
  const waiting = !detail || phase === 'waiting-for-signal' || session?.status === 'waiting' || session?.status === 'disconnected'
  if (!waiting || session?.status === 'healing') return undefined
  if (pending > 0) return {
    kind: 'test-review',
    label: 'Awaiting test review',
    detail: 'Review the unexecuted test edits under Tests changed, then adopt or restore them. Saved results describe the previous execution.',
  }
  if (session?.status === 'waiting' || session?.status === 'disconnected') return AGENT_WAITING_STATE
  if (run.healMode === 'external' && !session && phase === 'waiting-for-signal') return {
    ...AGENT_WAITING_STATE,
    detail: 'No external repair agent has claimed this run yet. Open an agent session to continue, or stop the heal.',
  }
  return undefined
}
