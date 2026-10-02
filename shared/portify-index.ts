import type { RunProducer } from './run-mode'

export type PortifyStatus =
  | 'planning'
  | 'editing'
  | 'verifying'
  | 'ready-to-save'
  | 'saved'
  | 'failed'
  | 'aborted'

export interface PortifyIndexEntry {
  workflowId: string
  feature: string
  status: PortifyStatus
  /** Ephemeral scratch-branch name — surfaced in the history list. Optional:
   *  index entries persisted before this field existed deserialize without it. */
  branch?: string
  startedAt: string
  endedAt?: string
  /** Mirrored from the manifest so the activity map can tell an external
   *  (MCP-client-driven) workflow from a spawned one off the index alone.
   *  Absent on entries written before the mirror existed — those all predate
   *  external portify, so absent = internal. */
  producer?: RunProducer
}

/** Structural input lets both manifest types share the projection, including
 * legacy records that predate optional index metadata. */
export function portifyIndexEntry(manifest: PortifyIndexEntry): PortifyIndexEntry {
  return {
    workflowId: manifest.workflowId,
    feature: manifest.feature,
    status: manifest.status,
    branch: manifest.branch,
    startedAt: manifest.startedAt,
    ...(manifest.endedAt ? { endedAt: manifest.endedAt } : {}),
    ...(manifest.producer ? { producer: manifest.producer } : {}),
  }
}

export function isExecutingPortifyStatus(status: string | undefined): boolean {
  return status === 'planning' || status === 'editing' || status === 'verifying'
}

/** Actionable includes a verified workflow still awaiting the user's save. */
export function isActionablePortifyStatus(status: string | undefined): boolean {
  return isExecutingPortifyStatus(status) || status === 'ready-to-save'
}

export function isTerminalPortifyStatus(status: string | undefined): boolean {
  return status === 'saved' || status === 'failed' || status === 'aborted'
}

// Existing consumers use “active” for this actionable lifecycle set.
export { isActionablePortifyStatus as isActivePortifyStatus }
