import type { RunDetail, RunStoreEvent } from '../features/runs/logic/run-store'
import type { ClientKind } from '../../../../shared/run-mode'
import { buildExternalHealContext, normalizeRunCounts, slimRepeatHealContext, type ExternalHealContext, type NormalizedRunCounts } from '../features/runs/logic/heal/external-heal-surface'
import { isActiveRunStatus, isTerminalRunStatus } from '../../../../shared/run-state'
import type { CanaryLabMcpDeps } from './tool-schemas'
import { ensureExternalClaimForMcpCall } from './tool-support'

// `timeout_ms` is the per-call block budget — how long ONE wait_for_heal_task
// request may hold open. It is NOT the overall heal budget: when the window
// elapses with the run still active, the call returns `still_waiting` and the
// agent immediately re-calls. This keeps every request well under any client
// JSON-RPC request timeout (the cause of the -32001 the long-poll used to hit),
// while the logical wait stays unbounded across re-calls.
export const WAIT_FOR_HEAL_TASK_DEFAULT_TIMEOUT_MS = 90 * 1000

export const WAIT_FOR_HEAL_TASK_MAX_TIMEOUT_MS = 60 * 60 * 1000

// Hard cap on a single block regardless of the requested timeout_ms. Large
// requested values are clamped to this (not rejected) so older clients keep
// working — they just get a `still_waiting` to loop on sooner.
export const WAIT_FOR_HEAL_TASK_WINDOW_MS = 120 * 1000

// ─── result helpers ─────────────────────────────────────────────────────

// Emitted in start_run / signal_run results so result-driven external clients
// (which may not carry the Canary Lab skill) block on wait_for_heal_task
// instead of inventing a get_run_snapshot poll loop. Mirrors the create_feature
// nextSteps convention. Machine-readable nextSteps only — the prose "how" lives
// once in REPAIR_INSTRUCTIONS (session init) and the wait_for_heal_task tool
// description, so re-emitting it on every start_run/signal_run was dead weight.
export function healWaitNext(): { nextSteps: string[] } {
  return { nextSteps: ['wait_for_heal_task'] }
}

export const BOOT_SESSION_MESSAGE =
  'Boot-only session: services are up and held. No tests run and there is no heal task. A service that fails its readiness probe is marked failed (status "timeout") but the session stays held — boot does not self-abort on a health-check failure. Stop with abort_run (confirm:true) when done.'

// A boot run (started via boot_services) holds its services up with no Playwright
// tests and no heal loop. Following or waiting on one must not claim heal or block
// on wait_for_heal_task — surface a boot_session result so skill-less clients stop
// here too instead of dead-waiting until timeout.
export function isActiveBootRun(detail: RunDetail | null | undefined): boolean {
  return (
    !!detail &&
    (detail.manifest.executionType ?? 'run') === 'boot' &&
    isActiveRunStatus(detail.manifest.status)
  )
}

// Emitted when a single wait_for_heal_task block elapses while the run is still
// active. NOT terminal — the agent must re-call wait_for_heal_task (same runId +
// session_id) to keep waiting. The cursor is informational (phase:cycles:status);
// re-calling is stateless and safe because classifyWaitForHealTask reads durable
// run state, so any transition during the gap is caught on the next immediate check.
export function stillWaitingValue(
  runId: string,
  detail: RunDetail | null,
): Extract<WaitForHealTaskValue, { type: 'still_waiting' }> {
  const status = detail?.manifest.status ?? null
  const phase = detail?.manifest.lifecycle?.phase ?? 'unknown'
  const cycles = detail?.manifest.healCycles ?? 0
  return {
    type: 'still_waiting',
    runId,
    status,
    lifecycle: detail?.manifest.lifecycle ?? null,
    cursor: `${phase}:${cycles}:${status ?? 'unknown'}`,
    // nextSteps is the machine-readable contract; the "not terminal, re-call"
    // prose lives in the wait_for_heal_task tool description, so we don't repay
    // it on every elapsed window (a long run loops still_waiting many times).
    nextSteps: ['wait_for_heal_task'],
  }
}

export function bootSessionValue(detail: RunDetail): Extract<WaitForHealTaskValue, { type: 'boot_session' }> {
  return {
    type: 'boot_session',
    runId: detail.manifest.runId,
    executionType: 'boot',
    status: detail.manifest.status,
    claimed: false,
    lifecycle: detail.manifest.lifecycle ?? null,
    message: BOOT_SESSION_MESSAGE,
    nextSteps: ['boot session — services are up and held; a service that failed its readiness probe shows status "timeout" but the session stays held (boot does not self-abort on health failure); exercise the live ones, then abort_run (confirm:true) when done'],
  }
}

// Test-file integrity warning, present only when a spec changed since the last
// green/run-start and wasn't approved/committed. The agent relays `message`
// verbatim; Canary never blocks or gates on it (awareness, not enforcement).
export interface DirtyTestsWarning {
  dirty: true
  specs: string[]
  message: string
}

// What became of the repair once the run went green. Rides the `passed` result
// because a skill-less agent follows tool results, not the session prose — and
// without this it has no way to know a pull request already exists and would
// reasonably try to push one of its own.
export interface HealFixOutcome {
  repos: Array<{ repoName: string; files: number; pr?: string; noPrReason?: string }>
  note: string
}

/** Build the `passed` result's fix block, or nothing when the run changed no
 *  code at all (it passed first try, or ran in place without a capture). */
export function healFixOutcome(detail: RunDetail): HealFixOutcome | undefined {
  const captured = detail.manifest.fixCapture?.repos ?? []
  if (captured.length === 0) return undefined
  const prByRepo = new Map((detail.manifest.proposedPrs ?? []).map((p) => [p.repoName, p.url]))
  const reasonByRepo = new Map(
    (detail.manifest.prAttempt?.results ?? []).filter((r) => !r.ok && r.reason).map((r) => [r.repoName, r.reason!]),
  )
  return {
    repos: captured.map((r) => ({
      repoName: r.repoName,
      files: r.files,
      ...(prByRepo.has(r.repoName) ? { pr: prByRepo.get(r.repoName)! } : {}),
      ...(reasonByRepo.has(r.repoName) ? { noPrReason: reasonByRepo.get(r.repoName)! } : {}),
    })),
    note: 'Canary Lab already saved this diff and handled the pull request. Do NOT open or push one yourself — report the pr url, or noPrReason where there is none.',
  }
}

export type WaitForHealTaskValue =
  | { type: 'needs_heal'; runId: string; cycle: number; context: ExternalHealContext; dirtyTests?: DirtyTestsWarning }
  | { type: 'passed'; runId: string; summary: RunDetail['summary'] | null; counts: NormalizedRunCounts; dirtyTests?: DirtyTestsWarning; fix?: HealFixOutcome }
  | { type: 'failed'; runId: string; status: string; summary: RunDetail['summary'] | null; counts: NormalizedRunCounts; dirtyTests?: DirtyTestsWarning }
  | {
      type: 'still_waiting'
      runId: string
      status: string | null
      lifecycle: RunDetail['manifest']['lifecycle'] | null
      cursor: string
      nextSteps: string[]
    }
  | {
      type: 'boot_session'
      runId: string
      executionType: 'boot'
      status: string
      claimed: false
      lifecycle: RunDetail['manifest']['lifecycle'] | null
      message: string
      nextSteps: string[]
    }

export type WaitForHealTaskResult =
  | { ok: true; value: WaitForHealTaskValue }
  | { ok: false; error: string }

// Read the feature's current dirty status from the integrity store. Returns a
// relay-ready warning (omitted when clean / store absent) so the agent surfaces
// "⚠️ Tests have been modified, please review." on a passing or failing run.
export function dirtyTestsWarning(deps: CanaryLabMcpDeps, feature: string): DirtyTestsWarning | undefined {
  const rec = deps.dirtySpecStore?.get(feature)
  if (!rec || rec.status !== 'dirty') return undefined
  return { dirty: true, specs: rec.dirtySpecs.map((s) => s.file), message: rec.message }
}

export function classifyWaitForHealTask(
  deps: CanaryLabMcpDeps,
  runId: string,
  sessionId: string,
): WaitForHealTaskResult | null {
  const detail = deps.store.get(runId)
  if (!detail) return { ok: false, error: `run not found: ${runId}` }

  if (isActiveBootRun(detail)) return { ok: true, value: bootSessionValue(detail) }

  const status = detail.manifest.status
  const dirtyTests = dirtyTestsWarning(deps, detail.manifest.feature)
  if (status === 'passed') {
    const fix = healFixOutcome(detail)
    return {
      ok: true,
      value: {
        type: 'passed',
        runId,
        summary: detail.summary ?? null,
        counts: normalizeRunCounts(detail.summary ?? null),
        ...(dirtyTests ? { dirtyTests } : {}),
        ...(fix ? { fix } : {}),
      },
    }
  }
  if (isTerminalRunStatus(status)) {
    return {
      ok: true,
      value: {
        type: 'failed',
        runId,
        status,
        summary: detail.summary ?? null,
        counts: normalizeRunCounts(detail.summary ?? null),
        ...(dirtyTests ? { dirtyTests } : {}),
      },
    }
  }

  const ownership = deps.broker.assertOwnership(runId, sessionId)
  if (!ownership.ok) {
    return {
      ok: false,
      error: ownership.reason === 'session-mismatch'
        ? `session-mismatch: run is held by ${ownership.currentSession?.sessionId}`
        : `no external heal claim for run: ${runId}`,
    }
  }

  if (
    isActiveRunStatus(status) &&
    detail.manifest.healMode === 'external' &&
    detail.manifest.lifecycle?.phase === 'waiting-for-signal'
  ) {
    const latest = deps.store.get(runId)
    if (!latest) return { ok: false, error: `run not found: ${runId}` }
    const full = buildExternalHealContext({
      detail: latest,
      logsDir: deps.store.logsDir,
      projectRoot: deps.projectRoot,
    })
    // The procedure (nextSteps) and resource map (healPrompt) are static across
    // cycles — ship them on cycle 1 only; later cycles get the slim variant
    // (failure packet + breadcrumb). get_heal_context re-fetches the full map.
    const cycle = detail.manifest.lifecycle.activeCycle ?? detail.manifest.healCycles
    const context = cycle >= 2 ? slimRepeatHealContext(full) : full
    return {
      ok: true,
      value: {
        type: 'needs_heal',
        runId,
        cycle,
        context,
        ...(dirtyTests ? { dirtyTests } : {}),
      },
    }
  }

  return null
}

export async function waitForHealTask(
  deps: CanaryLabMcpDeps,
  runId: string,
  sessionId: string,
  clientKind: ClientKind,
  timeoutMs: number,
): Promise<WaitForHealTaskResult> {
  // A boot-only session never produces a heal task — return immediately instead
  // of claiming heal and blocking until timeout.
  const bootDetail = deps.store.get(runId)
  if (bootDetail && isActiveBootRun(bootDetail)) return { ok: true, value: bootSessionValue(bootDetail) }
  ensureExternalClaimForMcpCall(deps, runId, sessionId, clientKind)
  const immediate = classifyWaitForHealTask(deps, runId, sessionId)
  if (immediate) return immediate

  return await new Promise<WaitForHealTaskResult>((resolve) => {
    let settled = false
    const finish = (result: WaitForHealTaskResult): void => {
      if (settled) return
      settled = true
      deps.store.offEvent(onEvent)
      clearTimeout(timeout)
      clearInterval(heartbeat)
      resolve(result)
    }
    const check = (): void => {
      const result = classifyWaitForHealTask(deps, runId, sessionId)
      if (result) finish(result)
    }
    const onEvent = (event: RunStoreEvent): void => {
      if (event.runId && event.runId !== runId) return
      check()
    }
    const beat = (): void => {
      const detail = deps.store.get(runId)
      if (!detail || isTerminalRunStatus(detail.manifest.status)) return
      ensureExternalClaimForMcpCall(deps, runId, sessionId, clientKind)
      deps.broker.heartbeat(runId, sessionId, 'waiting')
    }
    deps.store.onEvent(onEvent)
    // Clamp the actual block to the window cap regardless of the requested
    // timeout_ms — bounds the request lifetime so it can't outlive a client's
    // JSON-RPC request timeout. On elapse we return `still_waiting`, not a
    // terminal `timeout`: the run is still going, the agent just re-calls.
    const windowMs = Math.min(Math.max(timeoutMs, 1), WAIT_FOR_HEAL_TASK_WINDOW_MS)
    const timeout = setTimeout(() => {
      const detail = deps.store.get(runId)
      finish({ ok: true, value: stillWaitingValue(runId, detail ?? null) })
    }, windowMs)
    const heartbeat = setInterval(beat, 5_000)
    // Unconditional: both are `NodeJS.Timeout`, which always carries `unref`, so
    // a `typeof` guard here was an arm no test could reach. If a future runtime
    // returns a bare handle instead, this is a compile error rather than a timer
    // that silently holds the process open.
    timeout.unref()
    heartbeat.unref()
    beat()
    check()
  })
}
