import type { StageModelChoice } from './agent-models'
import type { RecordIndexFrame } from './record-index-frame'
import type { LocalHealAgent } from './run-manifest'
import type { ExternalSessionMeta, RunProducer } from './run-mode'

export type PortifyStatus =
  | 'planning'
  | 'editing'
  | 'verifying'
  | 'ready-to-save'
  | 'saved'
  | 'failed'
  | 'aborted'

// Port-ification workflow record. The server persists it and sends it whole to
// the web client (REST + `/ws/portify`), so this file is its one home.

export interface PortifyBootInstance {
  /** Slot name → port this boot was assigned. */
  ports: Record<string, number>
  ok: boolean
  /** When !ok, which service failed and why. */
  failedService?: string
  detail?: string
}

export interface PortifyVerification {
  ok: boolean
  instances: PortifyBootInstance[]
  /** Aggregated failure context fed back to the agent on retry. */
  failureDetail?: string
  /** True when the boot failed only because a downstream dependency was
   *  unreachable (e.g. the DB is down) — an ENVIRONMENT problem the port
   *  rewrite cannot fix. Signals the orchestrator to stop retrying. */
  notPortFixable?: boolean
  /** Differential triage on a failed double-boot: one extra SOLO boot decides
   *  whether the failure is concurrency at all. `baseline-boot-failed` = the
   *  solo boot fails too — not a port/concurrency defect (fix the boot
   *  blocker, don't iterate on ports). `concurrency-failure` = solo passes —
   *  the defect only appears when two instances share the worktree/machine.
   *  Absent when verification passed, or when the triage boot was skipped
   *  (dependency-down failures are already classified by notPortFixable). */
  failureClass?: 'baseline-boot-failed' | 'concurrency-failure'
}

export interface PortifyRepoState {
  name: string
  /** Canonical localPath of the product repo. */
  path: string
  /** Toplevel of this repo's isolated scratch worktree (set once setup runs). */
  worktreePath?: string
  /** HEAD the scratch worktree was cut from. */
  baseSha?: string
}

export interface PortifyManifest {
  workflowId: string
  feature: string
  featureDir: string
  /** Every product repo the workflow edits — one isolated scratch worktree each. */
  repos: PortifyRepoState[]
  env?: string
  agent: LocalHealAgent
  /** Model+effort the spawned agent runs with, resolved at start (launch
   *  override → workspace `agentModels.portify` → agent default) and locked to
   *  this workflow. Absent on pre-2.2.0 records and external-producer
   *  workflows (the client's own model setup applies there). */
  models?: StageModelChoice
  /** Defaults to `internal` (legacy manifests have no field). `external` means the
   *  agent runs in the user's own client and edits the worktree in place. */
  producer?: RunProducer
  /** Set only for `producer: 'external'` — the claiming client's identity. */
  external?: ExternalSessionMeta
  /** Ephemeral scratch-branch name created in the scratch worktree(s) and
   *  discarded on save/cancel — it never lands in the product repo. */
  branch: string
  status: PortifyStatus
  attempt: number
  maxAttempts: number
  /** User-driven revise passes after the first `ready-to-save`. Separate from
   *  `attempt` (the auto-retry budget) — feedback rounds are unbounded. Optional:
   *  manifests persisted before this field existed deserialize without it. */
  feedbackRounds?: number
  startedAt: string
  endedAt?: string
  /** Unified diff of the agent's edits (config + source), for the review screen.
   *  On `save` this diff is captured as the feature's ephemeral overlay. */
  diff?: string
  verification?: PortifyVerification
  error?: string
}

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

/** `/ws/portify` frames. */
export type PortifyStreamFrame = RecordIndexFrame<PortifyIndexEntry, PortifyManifest, 'workflows', 'workflowId'>
