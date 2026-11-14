import type { RunDetail } from '@shared/run-detail'
import type { RunIndexEntry } from '@shared/run-index'
import { normalizeRunCounts } from '@shared/run-counts'
import { clientKindLabel } from '@shared/run-mode'
import { EXTERNAL_AGENT_GONE_MS } from '@shared/run-state'
import { shortTime } from '@/shared/lib/format'

export interface RunWaitingState {
  kind: 'test-review' | 'agent' | 'queued'
  label: string
  detail: string
}

/** A claimed external agent has the repair: the run is not waiting on a human.
 *  Kept apart from `RunWaitingState`, whose every kind asks someone to act. */
export interface RunAgentTurn {
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
  if (session?.status === 'disconnected') {
    const last = Date.parse(session.lastHeartbeatAt)
    const ends = Number.isFinite(last)
      ? ` (last heartbeat ${shortTime(session.lastHeartbeatAt)}). The heal ends at ${shortTime(new Date(last + EXTERNAL_AGENT_GONE_MS).toISOString())} unless it reconnects`
      : '. The heal ends unless it reconnects'
    return {
      kind: 'agent',
      label: 'Agent disconnected',
      detail: `${testsFinished(detail)}${clientKindLabel(session.clientKind, 'The repair agent')} stopped responding${ends}; Stop heal ends it now.`,
    }
  }
  if (run.healMode === 'external' && !session && phase === 'waiting-for-signal') {
    return {
      ...AGENT_WAITING_STATE,
      detail: `${testsFinished(detail)}No external repair agent has claimed this run yet. Open an agent session to continue, or stop the heal.`,
    }
  }
  return undefined
}

/** The run finished its tests and a connected external agent holds the repair
 *  (it is working, or blocked on the runner for its next task). Says so with
 *  the counts and the agent's liveness, so a parked run never reads as stuck. */
export function runAgentTurn(input: RunDetail | RunIndexEntry | null | undefined): RunAgentTurn | undefined {
  if (!input || !('manifest' in input)) return undefined
  const { manifest } = input
  const session = manifest.externalHealSession
  if (manifest.status !== 'healing' || manifest.lifecycle?.phase !== 'waiting-for-signal') return undefined
  if (!session || session.status === 'disconnected' || (manifest.specEdits?.pending.length ?? 0) > 0) return undefined
  return {
    label: 'Agent repairing',
    detail: `${testsFinished(input)}${clientKindLabel(session.clientKind, 'The repair agent')} has the repair since ${shortTime(manifest.lifecycle.updatedAt)}; last heartbeat ${shortTime(session.lastHeartbeatAt)}.`,
  }
}

function testsFinished(detail: RunDetail | undefined): string {
  return detail?.summary ? `Tests finished: ${normalizeRunCounts(detail.summary).statusLine}. ` : ''
}
