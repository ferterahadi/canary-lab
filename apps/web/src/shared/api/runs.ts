// Test runs and the heal loop: start, pause, heal, fixes, PRs, journal.
// Split out of client.ts; see that barrel for the shared surface.

import type { AuditList, RunIndexEntry, RunDetail, JournalEntry, RunProposedPr } from './types'
import { ApiError, defaultOpts, request, type ClientOptions } from './internal'

export function listRuns(
  query: { feature?: string } = {},
  opts?: ClientOptions,
): Promise<RunIndexEntry[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const qs = query.feature ? `?feature=${encodeURIComponent(query.feature)}` : ''
  return request<RunIndexEntry[]>(`${baseUrl}/api/runs${qs}`, { method: 'GET' }, fetchImpl)
}

export function getRunDetail(runId: string, opts?: ClientOptions): Promise<RunDetail> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<RunDetail>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function getRunAudit(runId: string, opts?: ClientOptions): Promise<AuditList> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<AuditList>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/audit`,
    { method: 'GET' },
    fetchImpl,
  )
}

// Body of the 409 the server returns when a start request hits a same-repo
// collision and the caller hasn't chosen how to handle it.
export interface RepoCollisionChoice {
  type: 'repo_collision_requires_choice'
  conflictingRunId: string
  conflictingFeature: string
  repoPaths: string[]
  options: Array<'worktree' | 'queue'>
  message: string
}

/** Returns the collision payload when `err` is the 409 collision-choice
 *  ApiError, else null. */
export function asRepoCollision(err: unknown): RepoCollisionChoice | null {
  if (err instanceof ApiError && err.status === 409 && err.body && typeof err.body === 'object'
    && (err.body as { type?: string }).type === 'repo_collision_requires_choice') {
    return err.body as RepoCollisionChoice
  }
  return null
}

// One drifted repo from a start-time branch check: pinned `expected` vs the
// `current` checkout (null when not a git repo; `detached` = detached HEAD).
export interface RepoBranchMismatchRow {
  name: string
  path: string
  expected: string
  current: string | null
  detached: boolean
  isGitRepo: boolean
}

export interface RepoBranchMismatch {
  type: 'repo_branch_mismatch'
  feature: string
  repos: RepoBranchMismatchRow[]
  error: string
}

/** Returns the branch-mismatch payload when `err` is the 409 raised because the
 *  feature's repos aren't on their configured branch, else null. */
export function asBranchMismatch(err: unknown): RepoBranchMismatch | null {
  if (err instanceof ApiError && err.status === 409 && err.body && typeof err.body === 'object'
    && (err.body as { type?: string }).type === 'repo_branch_mismatch') {
    return err.body as RepoBranchMismatch
  }
  return null
}

// Re-pin every repo's configured branch to whatever it's currently checked out
// on (the inverse of checkoutRepoBranch). Future runs then test those branches.
export function pinFeatureBranchesToCurrent(
  feature: string,
  opts?: ClientOptions,
): Promise<{ name: string; pins: Array<{ name: string; branch: string }> }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/pin-current-branches`,
    { method: 'POST' },
    fetchImpl,
  )
}

export function startRun(
  feature: string,
  opts?: ClientOptions & { env?: string; isolation?: 'worktree' | 'queue'; mode?: 'test' | 'boot' },
): Promise<{ runId: string }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const body: Record<string, unknown> = { feature }
  if (opts?.env) body.env = opts.env
  if (opts?.isolation) body.isolation = opts.isolation
  if (opts?.mode === 'boot') body.mode = 'boot'
  return request<{ runId: string }>(
    `${baseUrl}/api/runs`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    fetchImpl,
  )
}

// Mid-Run Heal: ask the server to interrupt a running test and start the heal
// agent immediately. Resolves with `{ status, failureCount }` on a 202;
// throws ApiError on 409 (the body's `reason` describes which precondition
// failed) or 404 (run not active).
export interface PauseHealSuccess {
  status: 'healing'
  failureCount: number
}

export function pauseHealRun(runId: string, opts?: ClientOptions): Promise<PauseHealSuccess> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<PauseHealSuccess>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/pause-heal`,
    { method: 'POST' },
    fetchImpl,
  )
}

// Cancel an in-flight heal cycle. Server SIGTERMs the agent, breaks the
// heal loop, and appends a journal entry. Resolves on 202; ApiError on 409
// (no agent running / not currently healing) or 404 (run not active).
export function cancelHealRun(runId: string, opts?: ClientOptions): Promise<{ status: 'cancelled' }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ status: 'cancelled' }>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/cancel-heal`,
    { method: 'POST' },
    fetchImpl,
  )
}

export function sendAgentInput(
  runId: string,
  data: string,
  opts?: ClientOptions,
): Promise<{ status: 'sent' | 'restarted' }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ status: 'sent' | 'restarted' }>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/agent-input`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data }),
    },
    fetchImpl,
  )
}

export function restartRun(
  runId: string,
  opts?: ClientOptions,
): Promise<{ status: 'restarted'; mode: 'remaining' }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ status: 'restarted'; mode: 'remaining' }>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/restart`,
    { method: 'POST' },
    fetchImpl,
  )
}

// Apply a run's captured heal fixes (R80) into the real product repos. Returns
// a per-repo result; a 3-way conflict comes back as `ok:false` with a reason,
// not an error. 409 (no captured fixes) rejects.
export interface ApplyFixResult { repoName: string; ok: boolean; reason?: string }
export function applyRunFixes(
  runId: string,
  opts?: ClientOptions,
): Promise<{ results: ApplyFixResult[]; allOk: boolean }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ results: ApplyFixResult[]; allOk: boolean }>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/apply-fixes`,
    { method: 'POST' },
    fetchImpl,
  )
}

// The captured patch as text, for the Changes tab's inline diff. 404 when the
// run has no patch for that repo; 410 once the run dir has been trimmed away.
export interface RunFixPatch { repoName: string; patchPath: string; files: number; diff: string }
export function getRunFixPatch(runId: string, repoName: string, opts?: ClientOptions): Promise<RunFixPatch> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<RunFixPatch>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/fixes/${encodeURIComponent(repoName)}/patch`,
    { method: 'GET' },
    fetchImpl,
  )
}

// gh (GitHub CLI) connection status — detect-and-instruct only.
export interface GhStatus { installed: boolean; authenticated: boolean; account?: string; host?: string }
export function getGhStatus(opts?: ClientOptions): Promise<GhStatus> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<GhStatus>(`${baseUrl}/api/gh/status`, { method: 'GET' }, fetchImpl)
}

export type PrBlockedReason = 'no-origin' | 'not-github' | 'gh-missing' | 'not-authed' | 'wrong-account'
export interface PrRepoPreflight {
  repoName: string
  repoRoot: string
  origin: { owner: string; name: string; host: string } | null
  base: string | null
  pushable: boolean
  blocked?: { reason: PrBlockedReason; detail?: string }
}
export interface PrPreflight { gh: GhStatus; repos: PrRepoPreflight[]; anyPushable: boolean }

// Side-effect-free "can we open a PR from this run's fix?" check, per repo.
export function getRunPrPreflight(runId: string, opts?: ClientOptions): Promise<PrPreflight> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<PrPreflight>(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/pr-preflight`, { method: 'GET' }, fetchImpl)
}

export interface ProposePrResult { repoName: string; ok: boolean; pr?: RunProposedPr; reason?: string }
// Open a PR from the captured fix, per pushable repo (on demand). Idempotent.
export function proposeRunPr(runId: string, opts?: ClientOptions): Promise<{ results: ProposePrResult[] }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ results: ProposePrResult[] }>(`${baseUrl}/api/runs/${encodeURIComponent(runId)}/propose-pr`, { method: 'POST' }, fetchImpl)
}

// Abort an active run. POSTs to the abort endpoint which kills Playwright,
// the heal agent, and any service ptys, then marks the manifest 'aborted'.
// History is preserved — use `deleteRun` afterwards to hard-remove the logs.
export async function stopRun(runId: string, opts?: ClientOptions): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  await request<unknown>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}/abort`,
    { method: 'POST' },
    fetchImpl,
  )
}

// Hard-remove a terminal run from history: drops the index entry and
// recursively deletes the run directory. Server returns 409 if the run is
// still active — callers must abort first.
export async function deleteRun(runId: string, opts?: ClientOptions): Promise<void> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  await request<unknown>(
    `${baseUrl}/api/runs/${encodeURIComponent(runId)}`,
    { method: 'DELETE' },
    fetchImpl,
  )
}

export function listJournal(
  query: { feature?: string; run?: string } = {},
  opts?: ClientOptions,
): Promise<JournalEntry[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const params = new URLSearchParams()
  if (query.feature) params.set('feature', query.feature)
  if (query.run) params.set('run', query.run)
  const qs = params.toString() ? `?${params.toString()}` : ''
  return request<JournalEntry[]>(`${baseUrl}/api/journal${qs}`, { method: 'GET' }, fetchImpl)
}

// ─── Flight (`canary-lab flight` pipeline) ────────────────────────────────
// Manifest shapes live in the repo-shared model — the server conductor and this
// client read the same JSON.

export type {
  FlightManifest,
  FlightIndexEntry,
  FlightStage,
  FlightStageErrorDetail,
  FlightStageKey,
  FlightStageStatus,
  FlightStatus,
  FlightPauseReason,
  FlightCheckpoint,
  FlightCheckpointResponse,
  FlightEntryOptions,
  FlightStageEntryOption,
  SpecsCoveragePass,
  SpecsCoverageProgress,
  PlannedFeature,
  PlanFeaturesTask,
  PlanFeaturesTaskStatus,
  PrdSourceAttempt,
  PrdSourceCheckpointData,
  FlightStageRemedy,
} from '@shared/flights/types'
export { deriveFeatureSlug } from '@shared/flights/types'
