export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'healing' | 'aborted'
export type ServiceStatus = 'queued' | 'starting' | 'ready' | 'timeout' | 'stopped'

export type RunLifecyclePhase =
  | 'starting-services'
  | 'services-ready'
  | 'running-tests'
  | 'pausing-for-heal'
  | 'agent-healing'
  | 'waiting-for-signal'
  | 'applying-signal'
  | 'restarting-services'
  | 'rerunning-tests'
  | 'completed'
  | 'aborted'
  | 'failed'
  | 'passed'

export type RunLifecycleSeverity = 'info' | 'success' | 'warning' | 'error'
export type RunLifecycleSignalStatus = 'accepted' | 'ignored'
export type HealSignalKind = 'restart' | 'rerun' | 'heal'
export type HealSignalIgnoredReason = 'not-waiting-for-signal' | 'signal-already-pending'

export interface RunLifecycleSignal {
  kind: HealSignalKind
  status: RunLifecycleSignalStatus
  reason?: string
}

export interface RunLifecycleRestartPlan {
  restarted: string[]
  kept: string[]
  startedBecauseMissing?: string[]
  noMatch?: boolean
}

export interface RunLifecycleTargetedRerun {
  selected: number
  total: number
  mode: 'failed-and-pending' | 'failed-only' | 'full-suite' | 'none'
  reason: string
}

export interface RunLifecycleAbortReason {
  reason: string
  service?: string
}

/** Set on the manifest when a service failed to come up on a NORMAL run (not a
 *  boot-only session). The Playwright suite can't run without its services, so
 *  the run is declared `failed` and — if a heal mode is configured — routed into
 *  the heal loop with the service log as the failure context, instead of being
 *  silently aborted. Cleared on a successful (re)boot. */
export interface RunBootFailure {
  /** Service display name (matches ServiceSpec.name). */
  service: string
  /** On-disk safe name (matches ServiceManifestEntry.safeName). */
  safeName: string
  /** `health-timeout` = never answered its readiness probe within the deadline;
   *  `process-exited` = the service process died before it became healthy. */
  reason: 'health-timeout' | 'process-exited'
  /** Human-readable one-liner (transport + probe target / exit info). */
  detail: string
  /** Path to the service's log file — the heal agent reads this to diagnose
   *  why the service won't serve. */
  logPath: string
}

/**
 * Why the auto-heal loop stopped without the run passing. Typed and persisted
 * on the manifest so the Test Run surface can state the reason plainly instead
 * of leaving it buried in the diagnosis journal (or, for a silent agent, lost
 * entirely). Written at every give-up site in the auto-heal loop.
 *
 * - `no-signal`   — the heal agent produced no signal and changed no files;
 *                   `agentWait` says which watchdog fired and `agentCause`
 *                   (classified from the agent's own output tail) says why the
 *                   agent went quiet (usage limit, auth, crash, …).
 * - `max-cycles`  — hit the hard cycle cap (AUTO_HEAL_MAX_CYCLES).
 * - `no-progress` — the same failing set survived the no-progress limit of
 *                   consecutive fix attempts, or a fixless rerun made no gain.
 * - `spawn-failed`— the heal agent process failed to spawn.
 * - `cancelled`   — the user stopped heal (or the run was aborted) mid-loop.
 */
export interface HealEnd {
  reason: 'no-signal' | 'max-cycles' | 'no-progress' | 'spawn-failed' | 'cancelled'
  /** Which watchdog ended the wait. Set only when `reason === 'no-signal'`. */
  agentWait?: 'idle-timeout' | 'hard-timeout' | 'pty-died'
  /** Best-effort classification of why the agent went quiet, from its output
   *  tail. Set only when `reason === 'no-signal'`. `unknown` = tail captured
   *  but no known fingerprint matched. */
  agentCause?: 'usage-limit' | 'auth' | 'rate-limit' | 'crash' | 'unknown'
  /** 1-based heal cycle in flight when the loop gave up (0 if it never began). */
  cycle: number
  /** Plain-language sentence for the UI + transcript. */
  message: string
  /** ISO timestamp. */
  at: string
}

/**
 * The fix diff captured from a run's per-run worktree at teardown — the heal
 * agent's edits, isolated from the overlay/envset/uncommitted state that was
 * hydrated into the worktree before boot (those form the capture baseline).
 * The product repos are NEVER mutated; this patch is the ONLY record of what
 * the repair did, and the user applies it (or opens a PR) on demand.
 * Absent on green runs (nothing to fix), in-place (non-worktree) runs, and
 * runs whose agent changed nothing.
 */
export interface RunFixCaptureRepo {
  /** feature.config repos[].name. */
  repoName: string
  /** Absolute path to the saved unified-diff patch (<runDir>/fixes/<repo>.patch). */
  patchPath: string
  /** The patch's basename, for display and PR body references. */
  patchFile: string
  /** The SOURCE repo working-tree root the patch applies against. */
  repoRoot: string
  /** The repo HEAD sha the worktree — and thus the patch — is based on. */
  baseSha: string
  /** Number of files the fix touched. */
  files: number
}

export interface RunFixCapture {
  repos: RunFixCaptureRepo[]
  /** ISO timestamp of the capture (run teardown). */
  capturedAt: string
}

/** A pull request opened from a run's captured fix, per repo. Persisted so the
 *  Fixes-captured panel can show "PR opened →" instead of re-offering the
 *  button, and so a repeat request is idempotent (returns the existing URL). */
export interface RunProposedPr {
  repoName: string
  url: string
  /** The pushed head branch (deterministic per run+repo). */
  branch: string
  /** The base branch the PR targets. */
  base: string
  createdAt: string
}

export interface RunLifecycleSnapshot {
  phase: RunLifecyclePhase
  headline: string
  detail?: string
  updatedAt: string
  activeCycle?: number
  lastSignal?: RunLifecycleSignal
  restartPlan?: RunLifecycleRestartPlan
  targetedRerun?: RunLifecycleTargetedRerun
  abortReason?: RunLifecycleAbortReason
}

export interface RunLifecycleEvent extends RunLifecycleSnapshot {
  id?: string
  severity?: RunLifecycleSeverity
}

export type TransientAction = 'aborting' | 'deleting' | 'cancelling-heal' | 'pausing'
export type DisplayStatus = RunStatus | TransientAction

export interface RunActionAvailability {
  enabled: boolean
  reason?: string
}

export interface RunActionAvailabilitySet {
  pauseHeal: RunActionAvailability
  stop: RunActionAvailability
  cancelHeal: RunActionAvailability
  delete: RunActionAvailability
  restartHeal: RunActionAvailability
}

export const TERMINAL_RUN_STATUSES = ['passed', 'failed', 'aborted'] as const
export const ACTIVE_RUN_STATUSES = ['running', 'healing'] as const

export type TerminalRunStatus = typeof TERMINAL_RUN_STATUSES[number]
export type ActiveRunStatus = typeof ACTIVE_RUN_STATUSES[number]

export const HEARTBEAT_STALE_MS = 10 * 60 * 1000

export function isTerminalRunStatus(status: string | null | undefined): status is TerminalRunStatus {
  return status === 'passed' || status === 'failed' || status === 'aborted'
}

export function isActiveRunStatus(status: string | null | undefined): status is ActiveRunStatus {
  return status === 'running' || status === 'healing'
}

export function isRestartableRunStatus(status: string | null | undefined): status is 'failed' | 'aborted' {
  return status === 'failed' || status === 'aborted'
}

/** A run admitted to the queue but not yet started — holds no processes or
 *  ports. Distinct from active (running/healing) and terminal statuses. */
export function isQueuedRunStatus(status: string | null | undefined): status is 'queued' {
  return status === 'queued'
}

/** Why a run is parked in the queue. `resources` = the admission budget is
 *  full; `repo-collision` = it declined worktree isolation against an active
 *  run on the same repo and is waiting for that repo to free up. */
export type QueueReason = 'resources' | 'repo-collision'

export function isStaleHeartbeat(
  heartbeatAt: string | null | undefined,
  nowMs: number = Date.now(),
  staleMs: number = HEARTBEAT_STALE_MS,
): boolean {
  if (!heartbeatAt) return false
  const heartbeatMs = new Date(heartbeatAt).getTime()
  return Number.isFinite(heartbeatMs) && nowMs - heartbeatMs > staleMs
}

export function deriveDisplayStatus(
  status: RunStatus,
  transient: TransientAction | null,
): DisplayStatus {
  return transient ?? status
}

export function deriveRunActionAvailability(
  status: RunStatus,
  transient: TransientAction | null = null,
): RunActionAvailabilitySet {
  return {
    pauseHeal: availability(status === 'running' && !transient, disabledReason('pauseHeal', status, transient)),
    stop: availability((status === 'running' || status === 'queued') && !transient, disabledReason('stop', status, transient)),
    cancelHeal: availability(status === 'healing' && !transient, disabledReason('cancelHeal', status, transient)),
    delete: availability(isTerminalRunStatus(status) && !transient, disabledReason('delete', status, transient)),
    restartHeal: availability(isRestartableRunStatus(status) && !transient, disabledReason('restartHeal', status, transient)),
  }
}

export function reduceRunLifecycleSnapshot(
  previous: RunLifecycleSnapshot | undefined,
  event: RunLifecycleEvent,
): RunLifecycleSnapshot {
  const { id: _id, severity: _severity, ...snapshot } = event
  if (snapshot.targetedRerun || !previous?.targetedRerun) return snapshot
  return { ...snapshot, targetedRerun: previous.targetedRerun }
}

type RunLifecycleEventOptions =
  Partial<Omit<RunLifecycleEvent, 'phase' | 'headline' | 'updatedAt'>>
  & { updatedAt?: string }

export function createRunLifecycleEvent(
  phase: RunLifecyclePhase,
  headline: string,
  opts: RunLifecycleEventOptions = {},
): RunLifecycleEvent {
  return {
    phase,
    headline,
    updatedAt: opts.updatedAt ?? new Date().toISOString(),
    ...(opts.detail ? { detail: opts.detail } : {}),
    ...(opts.activeCycle !== undefined ? { activeCycle: opts.activeCycle } : {}),
    ...(opts.lastSignal ? { lastSignal: opts.lastSignal } : {}),
    ...(opts.restartPlan ? { restartPlan: opts.restartPlan } : {}),
    ...(opts.targetedRerun ? { targetedRerun: opts.targetedRerun } : {}),
    ...(opts.abortReason ? { abortReason: opts.abortReason } : {}),
    ...(opts.id ? { id: opts.id } : {}),
    ...(opts.severity ? { severity: opts.severity } : {}),
  }
}

export interface HealSignal {
  kind: HealSignalKind
  body: Record<string, unknown>
}

export type HealSignalGateResult =
  | { accepted: true; signal: HealSignal }
  | { accepted: false; kind: HealSignalKind; reason: HealSignalIgnoredReason; pendingKind?: HealSignalKind }

export class HealSignalGate {
  private waiting = false
  private pending: HealSignal | null = null

  beginWaiting(): void {
    this.waiting = true
  }

  endWaiting(): void {
    this.waiting = false
  }

  observe(kind: HealSignalKind, body: Record<string, unknown>): HealSignalGateResult {
    if (!this.waiting) {
      return { accepted: false, kind, reason: 'not-waiting-for-signal' }
    }
    if (this.pending) {
      return {
        accepted: false,
        kind,
        reason: 'signal-already-pending',
        pendingKind: this.pending.kind,
      }
    }
    const signal = { kind, body }
    this.pending = signal
    return { accepted: true, signal }
  }

  consume(): HealSignal | null {
    const signal = this.pending
    this.pending = null
    return signal
  }
}

function availability(enabled: boolean, reason?: string): RunActionAvailability {
  return enabled ? { enabled: true } : { enabled: false, reason }
}

function disabledReason(
  action: keyof RunActionAvailabilitySet,
  status: RunStatus,
  transient: TransientAction | null,
): string | undefined {
  if (transient) return `Action unavailable while ${transient.replace(/-/g, ' ')} is in progress.`
  if (action === 'pauseHeal') return status === 'running' ? undefined : 'Pause & Heal is available only while tests are running.'
  if (action === 'stop') return (status === 'running' || status === 'queued') ? undefined : 'Stop is available only while a run is queued or its tests are running.'
  if (action === 'cancelHeal') return status === 'healing' ? undefined : 'Cancel Heal is available only while an agent is healing.'
  if (action === 'delete') return isTerminalRunStatus(status) ? undefined : 'Delete is available after the run finishes.'
  // `restartHeal` is the last remaining member of RunActionAvailabilitySet, so
  // it is the unconditional tail rather than one more guarded case — there is
  // no unreachable default left behind for the coverage gate to carry.
  return isRestartableRunStatus(status) ? undefined : 'Restart Heal is available after a failed or aborted run.'
}
