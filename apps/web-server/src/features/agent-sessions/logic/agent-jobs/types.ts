// A durable record of one spawned agent CLI.
//
// Until this existed, an agent Canary spawned was an invisible child process: no
// record, nothing after a restart but silence, unreachable from any surface but
// the flight view it happened to belong to, and stoppable only by pausing the
// whole flight. The delegated subsystems (runs, portify, exports) all had records;
// the agents did not, which is what made them the weaker half of the pipeline.

/** How a spawned agent ended.
 *
 *  `orphaned` is the honest one. An in-process child cannot be resumed or
 *  re-attached — its handle died with the server — so a record left `running` by a
 *  dead process becomes a tombstone rather than something to recover. It keeps its
 *  `sessionId`, so the transcript of what the agent did before dying stays one
 *  click away; it is information, not clutter. */
export type AgentJobStatus = 'running' | 'done' | 'failed' | 'stopped' | 'orphaned'

export interface AgentJobManifest {
  jobId: string
  /** Which flight the spawn belongs to, when a flight owns it. Absent for spawns
   *  outside a flight (the standalone coverage job passes no descriptor at all,
   *  because its own manifest is already the record). */
  flightId?: string
  feature?: string
  /** Flight stage key, or another owner's label (e.g. `portify`). */
  stage?: string
  agent: 'claude' | 'codex'
  /** Pinned CLI session id — the join to the JSONL transcript AgentSessionView
   *  reads, and the reason an `orphaned` record is still worth keeping. */
  sessionId?: string
  cwd?: string
  /** The stop scope this child was registered under, so a stop route can reach it
   *  without holding the handle. */
  scope?: string
  startedAt: string
  endedAt?: string
  status: AgentJobStatus
  exitCode?: number
  /** Who asked for the stop — set only on `stopped`. */
  stoppedBy?: 'user' | 'flight'
  /** Plain-English ending, for a reader who has only this row. */
  note?: string
}

export interface AgentJobIndexEntry {
  jobId: string
  flightId?: string
  feature?: string
  stage?: string
  status: AgentJobStatus
  startedAt: string
  endedAt?: string
}

/** What a caller hands the shared runner so it can write the record itself. The
 *  runner owns the lifecycle — one implementation, no per-caller copies of
 *  "write running, patch terminal". */
export interface AgentJobRecordRef {
  jobId: string
  flightId?: string
  feature?: string
  stage?: string
  agent: 'claude' | 'codex'
  sessionId?: string
  cwd?: string
}
