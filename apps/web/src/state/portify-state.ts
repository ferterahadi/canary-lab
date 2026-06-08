import type { PortifyManifest, PortifyIndexEntry } from '../api/client'

// Pure reducer driving PortifyContext. Mirrors benchmark-state.ts so it
// unit-tests in the node vitest config (no jsdom). The server pushes the full
// manifest on every change (status, attempt, diff, verification), so a single
// `update` frame covers every transition without bespoke frame types.

export type PortifyStreamFrame =
  | {
      type: 'snapshot'
      workflows: PortifyIndexEntry[]
      details: Record<string, PortifyManifest>
    }
  | { type: 'update'; workflowId: string; manifest: PortifyManifest }
  | { type: 'removed'; workflowId: string }

export type ConnectionState = 'connecting' | 'live' | 'reconnecting' | 'disconnected'

export interface PortifyState {
  workflows: PortifyIndexEntry[]
  details: Record<string, PortifyManifest>
  connection: ConnectionState
}

export const initialPortifyState: PortifyState = {
  workflows: [],
  details: {},
  connection: 'connecting',
}

export type PortifyAction =
  | {
      type: 'snapshot'
      workflows: PortifyIndexEntry[]
      details: Record<string, PortifyManifest>
    }
  | { type: 'update'; workflowId: string; manifest: PortifyManifest }
  | { type: 'removed'; workflowId: string }
  | { type: 'connection'; status: ConnectionState }

function indexEntryFromManifest(m: PortifyManifest): PortifyIndexEntry {
  return {
    workflowId: m.workflowId,
    feature: m.feature,
    status: m.status,
    startedAt: m.startedAt,
    ...(m.endedAt ? { endedAt: m.endedAt } : {}),
  }
}

function byStartedDesc(a: PortifyIndexEntry, b: PortifyIndexEntry): number {
  return a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0
}

export function portifyReducer(state: PortifyState, action: PortifyAction): PortifyState {
  switch (action.type) {
    case 'snapshot':
      return { ...state, workflows: action.workflows, details: action.details }
    case 'update': {
      const entry = indexEntryFromManifest(action.manifest)
      const others = state.workflows.filter((w) => w.workflowId !== action.workflowId)
      return {
        ...state,
        workflows: [entry, ...others].sort(byStartedDesc),
        details: { ...state.details, [action.workflowId]: action.manifest },
      }
    }
    case 'removed': {
      const { [action.workflowId]: _dropped, ...details } = state.details
      return {
        ...state,
        workflows: state.workflows.filter((w) => w.workflowId !== action.workflowId),
        details,
      }
    }
    case 'connection':
      return { ...state, connection: action.status }
  }
}

/** Translate a WS frame into a reducer action; unknown frame types → null. */
export function frameToAction(frame: PortifyStreamFrame): PortifyAction | null {
  switch (frame.type) {
    case 'snapshot':
      return { type: 'snapshot', workflows: frame.workflows, details: frame.details }
    case 'update':
      return { type: 'update', workflowId: frame.workflowId, manifest: frame.manifest }
    case 'removed':
      return { type: 'removed', workflowId: frame.workflowId }
    default:
      return null
  }
}

/** Active = a workflow the user can still act on (not committed/failed/aborted). */
export function isActivePortify(status: PortifyIndexEntry['status']): boolean {
  return status === 'planning' || status === 'editing' || status === 'verifying' || status === 'ready-to-commit'
}
