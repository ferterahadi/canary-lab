import type { FastifyInstance } from 'fastify'
import type { RunStore, RunStoreEvent } from '../logic/run-store'
import type { RunDetail } from '../../../../../../shared/run-detail'
import type { RunIndexEntry } from '../../../../../../shared/run-index'
import { isActiveRunStatus } from '../../../../../../shared/run-state'
import { withSingleAttemptDetailState, withSingleAttemptIndexState } from '../logic/single-attempt-view'
import { activeDetails, registerRecordStream } from '../../../shared/ws/record-stream'

// `/ws/runs` — the browser's primary live-update channel. On connect, it sends
// a single `snapshot` frame with the runs index. Subsequent mutations from
// `RunStore` are forwarded as smaller deltas (`update` / `removed` /
// `list-changed`). Active run detail also keeps a low-rate HTTP refresh as a
// recovery path for best-effort filesystem and WebSocket delivery.
//
// The socket lifecycle is `registerRecordStream`'s (shared/ws/record-stream.ts,
// tested there); this module only maps store events to frames.

export interface RunsStreamDeps {
  store: RunStore
  featuresDir: string
}

// Wire-format frames. Stable: the web client treats unknown `type` values as
// no-ops, so adding fields is non-breaking; renaming a frame type IS
// breaking. Keep additive.
export type RunsStreamFrame =
  /** Sent once when the connection opens. Carries everything the client
   *  needs to render its initial UI without making any HTTP calls. */
  | { type: 'snapshot'; runs: RunIndexEntry[]; details: Record<string, RunDetail> }
  /** A single run changed (created, status flipped, finalized). The client
   *  patches `state.details[runId]` with `detail` and inserts/updates the
   *  matching `state.runs` entry. */
  | { type: 'update'; runId: string; detail: RunDetail }
  /** A run was removed from history (DELETE on a terminal run). The client
   *  drops it from both `state.runs` and `state.details`. */
  | { type: 'removed'; runId: string }
  /** A list-level change with no specific runId (today: the boot-time
   *  reaper). The client refreshes its `state.runs` snapshot from the
   *  attached payload and reconciles details for any newly-active rows
   *  via the next `update` frame. */
  | { type: 'list-changed'; runs: RunIndexEntry[] }

export async function runsStreamRoutes(
  app: FastifyInstance,
  deps: RunsStreamDeps,
): Promise<void> {
  const detailOf = (runId: string): RunDetail | null => {
    const detail = deps.store.get(runId)
    return detail ? withSingleAttemptDetailState(detail, deps.store.logsDir) : null
  }
  const index = (): RunIndexEntry[] => withSingleAttemptIndexState(deps.store.list(), deps.store.logsDir, deps.featuresDir)

  registerRecordStream<RunsStreamFrame, RunStoreEvent>(app, {
    path: '/ws/runs',
    store: deps.store,
    // Detail is only included for currently-active runs (where the client is
    // most likely to render extended info immediately); terminal runs' details
    // are loaded lazily via the first `update` frame for them. This keeps the
    // snapshot small for users with long history.
    snapshot: () => {
      const runs = index()
      return { type: 'snapshot', runs, details: activeDetails(runs, (entry) => isActiveRunStatus(entry.status), (entry) => entry.runId, detailOf) }
    },
    frameFor: (event) => {
      if (event.kind === 'removed' && event.runId) return { type: 'removed', runId: event.runId }
      if (event.kind === 'index-changed') return { type: 'list-changed', runs: index() }
      if (event.kind === 'journal-changed') return undefined
      // bootstrap / changed / finalized — read the detail back through the
      // store so the frame carries the full latest manifest snapshot, not
      // just a partial diff. Cheap (single file read).
      if (!event.runId) return undefined
      const detail = detailOf(event.runId)
      return detail ? { type: 'update', runId: event.runId, detail } : undefined
    },
  })
}
