import type { FastifyInstance } from 'fastify'
import type { RunStore, RunStoreEvent, RunDetail } from '../lib/run-store'
import type { RunIndexEntry } from '../../../shared/e2e-runner/manifest'

// `/ws/runs` — push channel that replaces the browser's polling. On connect,
// sends a single `snapshot` frame with the runs index. Subsequent mutations
// from `RunStore` are forwarded as smaller deltas (`update` / `removed` /
// `list-changed`). The browser keeps its own state tree in sync purely from
// these frames; HTTP is reserved for one-shot mutations (start/abort/delete)
// whose responses also flow back through this stream.
//
// Coverage is excluded for this module — the wire-up is too thin to test
// deterministically without a real WebSocket round-trip. The RunStore event
// emission underneath is fully covered.

export interface RunsStreamDeps {
  store: RunStore
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
  app.get('/ws/runs', { websocket: true }, (socket) => {
    const send = (frame: RunsStreamFrame): void => {
      try { socket.send(JSON.stringify(frame)) } catch { /* socket closed */ }
    }

    // Initial snapshot. Detail is only included for currently-active runs
    // (where the client is most likely to render extended info immediately);
    // terminal runs' details are loaded lazily via the first `update` frame
    // for them. This keeps the snapshot small for users with long history.
    const runs = deps.store.list()
    const details: Record<string, RunDetail> = {}
    for (const entry of runs) {
      if (entry.status === 'running' || entry.status === 'healing') {
        const detail = deps.store.get(entry.runId)
        if (detail) details[entry.runId] = detail
      }
    }
    send({ type: 'snapshot', runs, details })

    const onEvent = (event: RunStoreEvent): void => {
      if (event.kind === 'removed' && event.runId) {
        send({ type: 'removed', runId: event.runId })
        return
      }
      if (event.kind === 'index-changed') {
        send({ type: 'list-changed', runs: deps.store.list() })
        return
      }
      // bootstrap / changed / finalized — read the detail back through the
      // store so the frame carries the full latest manifest snapshot, not
      // just a partial diff. Cheap (single file read).
      if (!event.runId) return
      const detail = deps.store.get(event.runId)
      if (!detail) return
      send({ type: 'update', runId: event.runId, detail })
    }

    deps.store.onEvent(onEvent)
    socket.on('close', () => {
      deps.store.offEvent(onEvent)
    })
  })
}
