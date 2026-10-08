import { runIndexEntry, type RunIndexEntry } from '@shared/run-index'
import { ApiError } from '@/shared/api/internal'
import type { RunDetail } from '@shared/run-detail'
import { isTerminalRunStatus, type TransientAction } from '@shared/run-state'
import type { ConnectionState } from '@/shared/state/record-stream'
import { createRecordIndex, byStartedDesc } from '@/shared/state/record-index-store'

// Pure module: the reducer + frame-applier that drives RunsContext. Lives
// outside the .tsx file so it can be unit-tested in the existing
// `node`-environment vitest config (no jsdom required).

// ─── Wire frames mirror apps/web-server/ws/runs-stream.ts ────────────────

export type RunsStreamFrame =
  | { type: 'snapshot'; runs: RunIndexEntry[]; details: Record<string, RunDetail> }
  | { type: 'update'; runId: string; detail: RunDetail }
  | { type: 'removed'; runId: string }
  | { type: 'list-changed'; runs: RunIndexEntry[] }

// ─── State + actions ─────────────────────────────────────────────────────

export interface RunsState {
  runs: RunIndexEntry[]
  indexLoaded: boolean
  details: Record<string, RunDetail>
  transients: Record<string, TransientAction>
  connection: ConnectionState
  errors: Record<string, string>
}

const runsIndex = createRecordIndex<RunIndexEntry, RunDetail, 'runs', 'runId'>({
  keys: { list: 'runs', id: 'runId' },
  entryOf: (detail) => {
    const entry = runIndexEntry(detail.manifest)
    // The server may enrich historical single-attempt records on read.
    if (detail.newRunRequired) entry.newRunRequired = true
    return entry
  },
  compareEntries: byStartedDesc,
})

export const initialRunsState: RunsState = {
  ...runsIndex.initialState,
  indexLoaded: false,
  transients: {},
  errors: {},
}

export type RunsAction =
  | { type: 'snapshot'; runs: RunIndexEntry[]; details: Record<string, RunDetail> }
  | { type: 'update'; runId: string; detail: RunDetail }
  | { type: 'removed'; runId: string }
  | { type: 'list-changed'; runs: RunIndexEntry[] }
  | { type: 'connection'; status: ConnectionState }
  | { type: 'transient-set'; runId: string; action: TransientAction }
  | { type: 'transient-clear'; runId: string }
  | { type: 'error-set'; runId: string; message: string }
  | { type: 'error-clear'; runId: string }
  | { type: 'http-list'; runs: RunIndexEntry[] }
  | { type: 'http-detail'; runId: string; detail: RunDetail }

export function runsReducer(state: RunsState, action: RunsAction): RunsState {
  switch (action.type) {
    case 'snapshot':
      return { ...state, ...runsIndex.reducer(state, action), indexLoaded: true }
    case 'http-detail':
    case 'update': {
      const transients = isTerminalRunStatus(action.detail.manifest.status)
        ? omitRun(state.transients, action.runId)
        : state.transients
      return {
        ...state,
        ...runsIndex.reducer(state, { type: 'update', runId: action.runId, manifest: action.detail }),
        transients,
      }
    }
    case 'removed': {
      return {
        ...state,
        ...runsIndex.reducer(state, action),
        transients: omitRun(state.transients, action.runId),
        errors: omitRun(state.errors, action.runId),
      }
    }
    case 'list-changed':
      return { ...state, runs: action.runs, indexLoaded: true, transients: pruneTerminalTransients(state.transients, action.runs) }
    case 'connection':
      return { ...state, ...runsIndex.reducer(state, action) }
    case 'transient-set':
      return { ...state, transients: { ...state.transients, [action.runId]: action.action } }
    case 'transient-clear': {
      const { [action.runId]: _dropped, ...rest } = state.transients
      return { ...state, transients: rest }
    }
    case 'error-set':
      return { ...state, errors: { ...state.errors, [action.runId]: action.message } }
    case 'error-clear': {
      const { [action.runId]: _dropped, ...rest } = state.errors
      return { ...state, errors: rest }
    }
    case 'http-list':
      return { ...state, runs: action.runs, indexLoaded: true }
  }
}

function omitRun<T>(values: Record<string, T>, runId: string): Record<string, T> {
  const { [runId]: _dropped, ...rest } = values
  return rest
}

function pruneTerminalTransients(
  transients: Record<string, TransientAction>,
  runs: RunIndexEntry[],
): Record<string, TransientAction> {
  let next = transients
  for (const run of runs) {
    if (!isTerminalRunStatus(run.status) || next[run.runId] == null) continue
    next = omitRun(next, run.runId)
  }
  return next
}

/** Translate an incoming WS frame into a reducer action. Centralised so
 *  unknown frame types (forwards-compat additions) are silently ignored
 *  in one place. */
export function frameToAction(frame: RunsStreamFrame): RunsAction | null {
  switch (frame.type) {
    case 'snapshot':
      return { type: 'snapshot', runs: frame.runs, details: frame.details }
    case 'update':
      return { type: 'update', runId: frame.runId, detail: frame.detail }
    case 'removed':
      return { type: 'removed', runId: frame.runId }
    case 'list-changed':
      return { type: 'list-changed', runs: frame.runs }
  }
}

/** Produce a user-facing error string from the various shapes our action
 *  layer can throw: ApiError (server returned non-2xx), TypeError (fetch
 *  failure / connection drop), generic Error, anything else. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body
    if (body && typeof body === 'object' && 'reason' in body) {
      return String((body as { reason: unknown }).reason)
    }
    if (body && typeof body === 'object' && 'error' in body) {
      return String((body as { error: unknown }).error)
    }
    return err.message
  }
  if (isNetworkError(err)) {
    return 'Lost connection to server. Check that the server is running.'
  }
  return err instanceof Error ? err.message : String(err)
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false
  const msg = err.message.toLowerCase()
  return msg.includes('fetch') || msg.includes('network') || msg.includes('load failed')
}
