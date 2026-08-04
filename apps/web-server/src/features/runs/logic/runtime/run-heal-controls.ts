// The heal loop itself: the auto-heal cycle (spawn the agent, wait for its
// signal, restart or rerun, judge the new summary, decide whether to go again),
// the manual/external variant that waits for a human or an outside client, and
// the pause / cancel / restart controls the UI drives into it. Split out of
// orchestrator.ts; the bodies are unchanged.
import { type RunContext } from './run-context'
import type { CancelHealResult, PauseResult } from './orchestrator'
import { waitForPlaywrightExit } from './run-playwright'
import { recordHealEnd } from './run-heal-agent'
import { type RunManifest } from './manifest'
import { summarizeFailures } from './run-verdict'
import { killTree, scheduleSigkillFallback } from './run-spawn'
import { appendJournalIteration, markStoppedEarly, prepareRun, recordLifecycle } from './run-manifest-writer'
import { RunLoopHost, runAutoHealLoop, runManualExternalHealLoop } from './run-heal-loop'

// Manual interruption: check the failure summary FIRST, and only kill the
// in-flight Playwright pty when we're actually committing to a heal cycle.
// This avoids the previous footgun where pressing Pause before any test had
// failed would still SIGTERM Playwright, let it exit cleanly with code 0,
// and then `runFullCycle` would mark the whole run "passed".
//
// Returns a discriminated result the route handler maps to 202 (committed)
// or 409 (no-op — try again later). On success, the kill is graceful first
// (SIGTERM, 5 s wait) then forced (SIGKILL).
export async function pauseAndHeal(ctx: RunContext, host: RunLoopHost): Promise<PauseResult> {
  if (ctx.status === 'healing') {
    return { ok: false, reason: 'already-healing' }
  }
  if (!ctx.playwrightPty) {
    return { ok: false, reason: 'no-playwright-running' }
  }

  // Check failures BEFORE killing — no failures yet → no-op, Playwright
  // keeps running and the user can retry later when something has failed.
  const { failed, total } = summarizeFailures(ctx.paths.summaryPath)
  if (failed.length === 0) {
    return { ok: false, reason: 'no-failures-yet' }
  }

  // Commit: stamp the reason BEFORE killing so `runFullCycle` can treat
  // the impending Playwright exit as a heal trigger regardless of whether
  // Playwright exits cleanly (code 0) or via signal.
  markStoppedEarly(ctx, 'user-pause', failed.length, total)
  recordLifecycle(ctx, 'pausing-for-heal', 'Pause accepted', {
    detail: `Stopping Playwright after ${failed.length} failure${failed.length === 1 ? '' : 's'} so healing can start.`,
    severity: 'warning',
  })
  ctx.emit('paused-by-user', { failureCount: failed.length })

  const pty = ctx.playwrightPty
  try { pty.kill('SIGTERM') } catch { /* already dead */ }
  const exited = await waitForPlaywrightExit(ctx, 5000)
  if (!exited && ctx.playwrightPty) {
    try { ctx.playwrightPty.kill('SIGKILL') } catch { /* already dead */ }
    await waitForPlaywrightExit(ctx, 1000)
  }

  return { ok: true, failureCount: failed.length }
}

/**
 * Manually abort an in-flight heal session. Sets a cancellation flag so
 * `runAutoHealLoop` bails out (instead of spawning another Playwright
 * rerun or feeding another prompt to the REPL), appends a journal entry,
 * and SIGTERMs whichever pty is currently active (heal agent OR the
 * post-heal Playwright rerun).
 *
 * Accepted in two states:
 *   - `status === 'healing'`: the heal agent is processing.
 *   - `status === 'running' && healCycles > 0`: a post-heal Playwright
 *     rerun is in flight between cycles. Without this branch the user's
 *     click is silently 409'd until the cycle wraps back to 'healing'.
 *
 * Cancel succeeds even when no pty is attached — claude's REPL can exit
 * on its own (user typed `/exit`, crash) and leave the orchestrator
 * polling for a signal file that will never come. In that case the
 * cancel flag is what unwedges the loop.
 *
 * Returns `409 not-healing` only when the run isn't inside the heal loop
 * at all (initial Playwright phase, terminal status). Use Abort there.
 */
export async function cancelHeal(ctx: RunContext, host: RunLoopHost): Promise<CancelHealResult> {
  const inHealLoop = ctx.status === 'healing'
    || (ctx.status === 'running' && ctx.healCycles > 0)
  if (!inHealLoop) return { ok: false, reason: 'not-healing' }

  ctx.healCancelled = true
  markStoppedEarly(ctx, 'user-cancel-heal', 0, 0)
  // Record the give-up reason at its source — every healCancelled break in
  // the loop funnels through this one flag, so the manifest carries a typed
  // "stopped by user" instead of a bare failed status.
  recordHealEnd(ctx, {
    reason: 'cancelled',
    cycle: ctx.healCycles,
    message: 'Auto-repair was stopped by you before the suite passed.',
    at: new Date().toISOString(),
  })

  // Best-effort journal note BEFORE we tear down the pty so the entry
  // lands even if the user-cancel races a fast agent exit.
  try {
    appendJournalIteration(ctx, {
      // Logged as a `.rerun`-shaped entry for journal-parser compatibility,
      // even though no rerun actually happens. Hypothesis text makes the
      // intent explicit for downstream readers (heal-index, future agent
      // contexts).
      signal: '.rerun',
      hypothesis: 'User cancelled the heal cycle mid-run. No fix applied.',
      fixDescription: 'Cancelled by user — no changes were made.',
      runId: ctx.runId,
      manifestPath: ctx.paths.manifestPath,
      summaryPath: ctx.paths.summaryPath,
      journalPath: ctx.paths.diagnosisJournalPath,
    })
  } catch { /* journal append is best-effort */ }

  // Kill whichever pty is currently in flight. The loop is awaiting either
  // `waitForHealSignal` (REPL alive, healCancelled check unwedges) or
  // `runPlaywright` (kills the pw pty so the await resolves, then the
  // post-Playwright healCancelled check breaks the loop).
  if (ctx.healAgentPty) {
    killTree(ctx.healAgentPty, 'SIGTERM')
    scheduleSigkillFallback(ctx.healAgentPty)
  }
  if (ctx.playwrightPty) {
    killTree(ctx.playwrightPty, 'SIGTERM')
    scheduleSigkillFallback(ctx.playwrightPty)
  }
  return { ok: true }
}

export async function continueAfterTestRun(ctx: RunContext, host: RunLoopHost, finalStatus: RunManifest['status']): Promise<RunManifest['status']> {
  if (finalStatus === 'passed') return finalStatus

  // Manual / external heal mode: no agent CLI configured but the user
  // explicitly asked for hand- or external-driven mode. Transition to
  // 'healing' and wait for either the user (manual) or the external client
  // (external, via POST /api/runs/:runId/signal) to write the signal file.
  // Loops until tests pass, the user cancels, or the signal-poll timeout
  // (24h) is hit. Signal watcher (already running) feeds `signalGate` for
  // `waitForHealSignal` to consume.
  if (!ctx.autoHeal && (ctx.manualHeal || ctx.externalHeal)) {
    return await runManualExternalHealLoop(ctx, host, finalStatus)
  }

  if (!ctx.autoHeal) return finalStatus

  // Same abort guard as above: if the user aborted between Playwright
  // exiting and the heal-loop entry, never spawn a heal agent. Without
  // this, auto-heal would race past stop() and start a fresh heal pty
  // the user has no way to interrupt (the row is already 'aborted').
  if (ctx.stopped) return ctx.status

  return await runAutoHealLoop(ctx, host)
}

export async function restartHealFromFailure(ctx: RunContext, host: RunLoopHost, userGuidance: string): Promise<RunManifest['status']> {
  if (!ctx.autoHeal) return 'failed'
  prepareRun(ctx, 'stopped')
  if (ctx.stopped) return ctx.status
  // The pane broker's in-memory ring buffer is cleared separately (see
  // `restartHeal` in server.ts) so reconnecting subscribers don't see the
  // previous session's bytes. There's no on-disk transcript to truncate.
  return await runAutoHealLoop(ctx, host, userGuidance)
}
