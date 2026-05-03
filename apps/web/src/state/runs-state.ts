import { ApiError } from '../api/client'
import type { RunDetail, RunIndexEntry, TransientAction } from '../api/types'

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

export type ConnectionState =
  | 'connecting'      // initial, before the first WS open
  | 'live'            // WS open, push frames flowing
  | 'reconnecting'    // WS dropped after being live; backoff in progress
  | 'disconnected'    // gave up — surfaced to the user as a banner

export interface RunsState {
  runs: RunIndexEntry[]
  details: Record<string, RunDetail>
  transients: Record<string, TransientAction>
  connection: ConnectionState
  errors: Record<string, string>
}

export const initialRunsState: RunsState = {
  runs: [],
  details: {},
  transients: {},
  connection: 'connecting',
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
      return { ...state, runs: action.runs, details: action.details }
    case 'update': {
      // Update both list and details. The list entry is derived from the
      // manifest so the badge stays in sync without a separate poll.
      const m = action.detail.manifest
      const entry: RunIndexEntry = {
        runId: m.runId,
        feature: m.feature,
        startedAt: m.startedAt,
        status: m.status,
        endedAt: m.endedAt,
      }
      const others = state.runs.filter((r) => r.runId !== action.runId)
      return {
        ...state,
        runs: [entry, ...others].sort(byStartedDesc),
        details: { ...state.details, [action.runId]: action.detail },
      }
    }
    case 'removed': {
      const { [action.runId]: _droppedDetail, ...details } = state.details
      const { [action.runId]: _droppedTransient, ...transients } = state.transients
      const { [action.runId]: _droppedError, ...errors } = state.errors
      return {
        ...state,
        runs: state.runs.filter((r) => r.runId !== action.runId),
        details,
        transients,
        errors,
      }
    }
    case 'list-changed':
      return { ...state, runs: action.runs }
    case 'connection':
      return { ...state, connection: action.status }
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
      return { ...state, runs: action.runs }
    case 'http-detail':
      return { ...state, details: { ...state.details, [action.runId]: action.detail } }
  }
}

function byStartedDesc(a: RunIndexEntry, b: RunIndexEntry): number {
  return a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0
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
