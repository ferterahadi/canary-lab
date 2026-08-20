// The heal loop itself: the auto-heal cycle (spawn the agent, wait for its
// signal, restart or rerun, judge the new summary, decide whether to go again),
// the manual/external variant that waits for a human or an outside client, and
// the pause / cancel / restart controls the UI drives into it. Split out of
// orchestrator.ts; the bodies are unchanged.
import { type RunContext } from './run-context'
import { runPlaywright, verificationPlanForSummary } from './run-playwright'
import { captureHealAgentCause, cleanupHealAgentPty, emitAgentSystemMessage, persistAgentSessionRef, recordHealEnd, runHealAgent, waitForHealSignal } from './run-heal-agent'
import { type HealEnd } from '../../../../../../../shared/run-state'
import { type RunManifest } from './manifest'
import { HealCycleState, AUTO_HEAL_MAX_CYCLES } from './heal-cycle'
import { ESCALATION_THRESHOLD } from './heal-escalation'
import {
  diffContentForFeatureRepos,
  diffFeatureRepos,
  snapshotFeatureRepos,
} from './feature-repo-diff'
import { planRestart } from './restart-planner'
import { computeVerificationPlan, decideRunStatus, extractFailedSlugs, nonPassedSignatureFromPlan, readSummary, selectionForPlan, summarizeFailures, summaryHasPassingEvidence } from './run-verdict'
import { healAgentCauseSuffix } from './heal-agent-text'
import { ensureServicesRunning } from './run-service-boot'
import { appendJournalIteration, markStoppedEarly, noteHealCycle, recordLifecycle, setStatus } from './run-manifest-writer'
import type { RunOrchestrator } from './orchestrator'

export { cancelHeal, continueAfterTestRun, pauseAndHeal, restartHealFromFailure } from './run-heal-controls'

/** The two class methods the loop still drives — they are the orchestrator's
 *  public surface, so they stay on it and arrive here as a handle. */
export interface RunLoopHost {
  restart: RunOrchestrator['restart']
  rerun: RunOrchestrator['rerun']
  recordBootFailureHealWait: RunOrchestrator['recordBootFailureHealWait']
}

export async function runManualExternalHealLoop(ctx: RunContext, host: RunLoopHost, initialStatus: RunManifest['status']): Promise<RunManifest['status']> {
  const MANUAL_TIMEOUT_MS = 24 * 60 * 60 * 1000
  const modeLabel = ctx.externalHeal ? 'External' : 'Manual'
  const modeCommand = ctx.externalHeal ? '<external>' : '<manual>'
  const modeDetail = ctx.externalHeal
    ? 'Waiting for an external AI client (Claude/Codex via MCP) to write a per-run signal file.'
    : 'Waiting for a manual agent or user to write a per-run signal file.'
  let finalStatus = initialStatus
  while (true) {
    setStatus(ctx, 'healing')
    noteHealCycle(ctx)
    ctx.emit('agent-started', { cycle: ctx.healCycles, command: modeCommand })
    recordLifecycle(ctx, 'agent-healing', `${modeLabel} heal cycle ${ctx.healCycles} started`, {
      detail: modeDetail,
      activeCycle: ctx.healCycles,
    })
    // Same snapshot/diff pattern as auto-heal: capture working-tree state
    // before the user starts editing, then diff after the signal arrives
    // so the journal records only what the user changed during this turn.
    const snapshots = await snapshotFeatureRepos(ctx.feature, ctx.repoPathOverrides)
    // Manual heal: no live REPL emits output, so the idle timeout would
    // otherwise fire after 3 min. Set the idle window equal to the hard
    // ceiling so it can't dominate the manual flow.
    const { signal } = await waitForHealSignal(ctx, MANUAL_TIMEOUT_MS, MANUAL_TIMEOUT_MS, false)
    ctx.emit('agent-exit', { exitCode: 0 })
    if (ctx.healCancelled || ctx.stopped) {
      finalStatus = 'failed'
      setStatus(ctx, finalStatus)
      break
    }
    if (!signal) {
      finalStatus = 'failed'
      setStatus(ctx, finalStatus)
      break
    }
    const filesChanged = await diffFeatureRepos(snapshots)
    const diffContent = await diffContentForFeatureRepos(snapshots)
    try {
      if (signal.kind === 'restart' || signal.kind === 'rerun') {
        appendJournalIteration(ctx, {
          signal: signal.kind === 'restart' ? '.restart' : '.rerun',
          hypothesis: typeof signal.body.hypothesis === 'string' ? signal.body.hypothesis : undefined,
          filesChanged,
          fixDescription: typeof signal.body.fixDescription === 'string' ? signal.body.fixDescription : undefined,
          diffContent,
          runId: ctx.runId,
          manifestPath: ctx.paths.manifestPath,
          summaryPath: ctx.paths.summaryPath,
          journalPath: ctx.paths.diagnosisJournalPath,
        })
      }
    } catch { /* journal is best-effort */ }
    const verificationPlan = verificationPlanForSummary(ctx, readSummary(ctx.paths.summaryPath))
    setStatus(ctx, 'running')
    if (signal.kind === 'restart') {
      await host.restart(filesChanged)
    } else {
      await host.rerun()
    }
    if (ctx.stopped) return ctx.status
    const startedBecauseMissing = await ensureServicesRunning(ctx)
    if (startedBecauseMissing.length > 0) {
      recordLifecycle(ctx, 'restarting-services', 'Started missing services', {
        detail: `Started ${startedBecauseMissing.join(', ')} before rerun.`,
        restartPlan: { restarted: [], kept: [], startedBecauseMissing },
      })
    }
    if (ctx.bootFailure) {
      host.recordBootFailureHealWait()
      continue
    }
    const exitCode = await runPlaywright(ctx, selectionForPlan(verificationPlan))
    // Manual-heal mirror of the auto-heal abort guard: the top of the
    // loop already checks `stopped`, but the killed Playwright pty's
    // exit code arrives after the abort flips the flag — don't
    // compute a finalStatus from it.
    if (ctx.stopped) return ctx.status
    finalStatus = decideRunStatus(ctx.feature.featureDir, ctx.paths.summaryPath, exitCode)
    setStatus(ctx, finalStatus)
    if (finalStatus === 'passed') break
  }
  return finalStatus
}

/**
 * Persist why the loop wound down after another process claimed the record.
 *
 * Reports what was OBSERVED — which status appeared and during which cycle —
 * and explicitly declines to claim anything about the fix. The agent may have
 * edited files that never reached a rerun, so this is not a repair verdict and
 * must not read like one.
 */
function recordForeignAbortEnd(ctx: RunContext, cycle: number): void {
  const claimed = ctx.foreignTerminalStatus
  recordHealEnd(ctx, {
    reason: 'foreign-abort',
    cycle,
    message: `Auto-repair stopped: another process marked this run "${claimed}" while cycle ${cycle} was still working, so the repair was wound down instead of finishing.`,
    at: new Date().toISOString(),
  })
  try {
    appendJournalIteration(ctx, {
      signal: 'none',
      hypothesis: `Another process marked this run "${claimed}" mid-cycle. The repair was wound down; any edits the agent had already made are still in the worktree.`,
      fixDescription: 'No fix verified — the cycle never reached a rerun.',
      runId: ctx.runId,
      manifestPath: ctx.paths.manifestPath,
      summaryPath: ctx.paths.summaryPath,
      journalPath: ctx.paths.diagnosisJournalPath,
    })
  } catch { /* journal write is best-effort */ }
}

export async function runAutoHealLoop(ctx: RunContext, host: RunLoopHost, initialUserGuidance?: string): Promise<RunManifest['status']> {
  if (!ctx.autoHeal) return 'failed'
  // Clear any give-up reason from a prior heal session — a restart-heal
  // re-enters this loop and may now pass, so a stale `healEnd` must not
  // linger on the manifest.
  ctx.stateSink.patchManifest(ctx.runId, { healEnd: undefined })
  let finalStatus: RunManifest['status'] = 'failed'
  const heal = new HealCycleState({
    maxCycles: ctx.autoHeal.maxCycles ?? AUTO_HEAL_MAX_CYCLES,
  })

  const threshold = ctx.feature.healOnFailureThreshold
  if (typeof threshold === 'number' && threshold > 0 && !ctx.stoppedEarlyReason) {
    const { failed: failed0, total: total0 } = summarizeFailures(ctx.paths.summaryPath)
    if (failed0.length >= threshold) {
      markStoppedEarly(ctx, 'max-failures', failed0.length, total0)
    }
  }

  let userGuidance = initialUserGuidance
  try {
    while (true) {
      if (ctx.stopped) return ctx.status
      // Cancel observed at the loop top means the user clicked Stop Heal
      // between cycles (or just before the next cycle starts). Bail out
      // before incrementing the cycle counter.
      if (ctx.healCancelled) {
        finalStatus = 'failed'
        setStatus(ctx, finalStatus)
        break
      }
      // Same reasoning as the cancel above: a foreign terminal write observed
      // between cycles must not start another one.
      if (ctx.foreignTerminalStatus) {
        recordForeignAbortEnd(ctx, ctx.healCycles)
        finalStatus = 'failed'
        setStatus(ctx, finalStatus)
        break
      }
      const summary = readSummary(ctx.paths.summaryPath)
      const failedSlugs = extractFailedSlugs(summary)
      if (failedSlugs.length === 0) {
        const pendingPlan = verificationPlanForSummary(ctx, summary)
        if (pendingPlan.kind === 'all-passed') {
          if (summaryHasPassingEvidence(summary)) {
            finalStatus = 'passed'
            setStatus(ctx, finalStatus)
          }
          break
        }
        // This rerun spawns NO heal agent — it just re-executes the
        // not-yet-passed tests. That can only make progress on genuinely
        // not-run (pending) tests; a deterministically skipped test
        // (`test.skip(cond)`) re-runs to the same skipped result every time.
        // Capture the not-passed set before the rerun so a no-progress cycle
        // terminates the run instead of re-running the identical summary
        // forever (the skipped-test infinite-rerun bug).
        const beforeSignature = nonPassedSignatureFromPlan(pendingPlan)
        setStatus(ctx, 'running')
        const exitCode = await runPlaywright(ctx, selectionForPlan(pendingPlan))
        if (ctx.stopped) return ctx.status
        if (ctx.healCancelled) {
          finalStatus = 'failed'
          setStatus(ctx, finalStatus)
          break
        }
        finalStatus = decideRunStatus(ctx.feature.featureDir, ctx.paths.summaryPath, exitCode)
        setStatus(ctx, finalStatus)
        if (finalStatus === 'passed') break
        const afterSummary = readSummary(ctx.paths.summaryPath)
        if (
          extractFailedSlugs(afterSummary).length === 0 &&
          nonPassedSignatureFromPlan(computeVerificationPlan(ctx.feature.featureDir, afterSummary)) === beforeSignature
        ) {
          const skippedCount = pendingPlan.kind === 'targeted' ? pendingPlan.skipped.length : 0
          recordLifecycle(ctx, 'rerunning-tests', 'Stopped: not-yet-passed tests stayed unchanged after rerun', {
            detail: skippedCount > 0
              ? `${skippedCount} test${skippedCount === 1 ? '' : 's'} remained skipped; a rerun without a code fix cannot turn skipped tests green. Stopping instead of re-running indefinitely.`
              : 'A rerun made no progress on the not-yet-passed tests; stopping instead of re-running indefinitely.',
            severity: 'warning',
          })
          recordHealEnd(ctx, {
            reason: 'no-progress',
            cycle: heal.snapshot().cycle,
            message:
              skippedCount > 0
                ? `Auto-repair stopped: ${skippedCount} test${skippedCount === 1 ? '' : 's'} stayed skipped and a rerun without a code fix can't turn them green.`
                : 'Auto-repair stopped: a rerun made no progress on the not-yet-passed tests.',
            at: new Date().toISOString(),
          })
          break
        }
        continue
      }
      const signature = failedSlugs.slice().sort().join('|')
      // `observeFailures` now takes the raw slug array so it can remember it
      // on `snapshot().lastFailingSlugs` — that's what the heal-index uses
      // to compute the "delta vs previous cycle" section. The signature
      // string stays as the human-readable lifecycle-event detail.
      const decision = heal.observeFailures(failedSlugs)
      if (!decision.shouldHeal) {
        // Record WHY the loop stops so the Test Run surface can state it
        // plainly. Every refusal carries a reason — see `HealDecision`.
        const reason = decision.reason
        const cyclesDone = heal.snapshot().cycle
        recordHealEnd(ctx, {
          reason,
          cycle: cyclesDone,
          message:
            reason === 'max-cycles'
              ? `Auto-repair stopped after the ${cyclesDone}-cycle limit without turning the suite green.`
              : `Auto-repair stopped: the same tests kept failing across ${cyclesDone} cycles with no progress.`,
          at: new Date().toISOString(),
        })
        break
      }

      // Capture the failure streaks AFTER `observeFailures` has updated
      // them for this cycle. The escalation block in the cycle prompt keys
      // off the flake-tolerant per-test streaks (`stuckSlugs`) — a test that
      // failed ESCALATION_THRESHOLD observations in a row is stuck even when
      // a flaky sibling churned the exact-set signature.
      const healSnapshot = heal.snapshot()
      const consecutiveSameFailures = healSnapshot.consecutiveSameFailures
      const maxSlugStreak = healSnapshot.maxSlugStreak
      const stuckSlugs = heal.stuckSlugs(ESCALATION_THRESHOLD)

      const cycleNum = heal.beginCycle() + 1
      ctx.emit('heal-cycle-started', { cycle: cycleNum, failureSignature: signature })
      setStatus(ctx, 'healing')
      noteHealCycle(ctx)
      recordLifecycle(ctx, 'agent-healing', `Heal cycle ${cycleNum} started`, {
        // Non-empty by construction: `observeFailures` only returns
        // `shouldHeal` for a non-empty signature, which is this same string.
        detail: `Failures: ${signature}`,
        activeCycle: cycleNum,
      })

      // Snapshot every git-tracked feature repo just before the agent runs.
      // After the signal arrives, the diff against this snapshot is the
      // ground-truth list of files the agent edited during its turn —
      // pre-existing dirty state in the workspace doesn't leak in.
      const snapshots = await snapshotFeatureRepos(ctx.feature, ctx.repoPathOverrides)

      const { signal, reason } = await runHealAgent(ctx, { cycle: cycleNum, failedSlugs, userGuidance, consecutiveSameFailures, stuckSlugs, maxSlugStreak })
      userGuidance = undefined

      // Pin the agent's CLI-native session-log pointer as soon as this cycle's
      // wait ends — codex has no `--session-id` flag, so its rollout log is
      // discovered by cwd + start time, and that discovery must happen while
      // the log still exists. Waiting until cleanup lost the ref when a
      // silent cycle-1 agent gave up (the agent-session-null gap).
      persistAgentSessionRef(ctx)

      if (ctx.stopped) return ctx.status

      if (ctx.healCancelled) {
        finalStatus = 'failed'
        setStatus(ctx, finalStatus)
        break
      }

      // Another process declared this run over mid-cycle. Do NOT fall through
      // to the no-signal path below: that infers a rerun from whatever the
      // agent happened to have edited, and re-running a suite for a run the
      // rest of the system has already reported on would publish a verdict
      // against a record nobody is reading any more.
      if (ctx.foreignTerminalStatus) {
        recordForeignAbortEnd(ctx, cycleNum)
        finalStatus = 'failed'
        setStatus(ctx, finalStatus)
        break
      }

      const filesChanged = await diffFeatureRepos(snapshots)
      const diffContent = await diffContentForFeatureRepos(snapshots)

      // No signal: agent exited / went idle / hit the hard ceiling. The
      // `reason` distinguishes which so the transcript can say what
      // actually happened (was it our timeout, or did the agent give up?).
      // Either way, if it edited any feature-repo file, treat as an
      // implicit `.rerun` so we don't discard the work; otherwise log the
      // no-op and end the loop. Journal is always written.
      let effectiveSignal = signal
      if (!effectiveSignal) {
        const idleSec = Math.round(ctx.healAgentIdleTimeoutMs / 1000)
        const hardMin = Math.round(ctx.healAgentTimeoutMs / 60_000)
        const reasonMessage =
          reason === 'idle-timeout' ? `Heal agent went silent for ${idleSec}s without writing a signal.`
            : reason === 'hard-timeout' ? `Heal cycle hit the ${hardMin}-minute ceiling without a signal.`
              : reason === 'pty-died' ? 'Heal agent exited without writing a signal.'
                : `Heal cycle ended without a signal (reason: ${reason}).`
        emitAgentSystemMessage(ctx, reasonMessage)

        if (filesChanged.length === 0) {
          try {
            appendJournalIteration(ctx, {
              signal: 'none',
              hypothesis: `${reasonMessage} No code changes detected.`,
              fixDescription: 'No fix applied.',
              runId: ctx.runId,
              manifestPath: ctx.paths.manifestPath,
              summaryPath: ctx.paths.summaryPath,
              journalPath: ctx.paths.diagnosisJournalPath,
            })
          } catch { /* journal write is best-effort */ }
          emitAgentSystemMessage(ctx, 'No code changes detected — ending the heal loop.')
          // The agent produced no signal and changed nothing. Its own output
          // tail is the only evidence of why — capture + classify it so the
          // Test Run surface can say "usage limit" vs "tried and couldn't".
          // (No `spawn-failed` arm: a spawn failure throws out of the loop
          // rather than arriving here as a reason — see `runHealAgent`.)
          const agentCause = captureHealAgentCause(ctx)
          recordHealEnd(ctx, {
            reason: 'no-signal',
            agentWait: reason as HealEnd['agentWait'],
            agentCause,
            cycle: cycleNum,
            message: `${reasonMessage}${healAgentCauseSuffix(agentCause)} No code changes were made, so auto-repair stopped after cycle ${cycleNum}.`,
            at: new Date().toISOString(),
          })
          finalStatus = 'failed'
          setStatus(ctx, finalStatus)
          break
        }
        // Restart vs rerun by who owns the changed files, not by a fixed
        // choice. An app-code fix cannot survive a bare rerun: the service
        // process is still serving the pre-fix code, so the rerun re-tests the
        // old binary and the run reports a repair that in fact worked as a
        // failure — a false FAIL, the one direction that must never happen.
        // Spec-only edits own no service and need no restart. `planRestart` is
        // the same matcher the restart itself runs on, so the inference can
        // never disagree with the plan it produces.
        const inferred = planRestart(filesChanged, ctx.services).toRestart.length > 0
          ? 'restart' as const
          : 'rerun' as const
        emitAgentSystemMessage(ctx, `Code changes detected — inferring a ${inferred} from git diff.`)
        effectiveSignal = {
          kind: inferred,
          body: {
            hypothesis: `${reasonMessage} Runner inferred a ${inferred} from git diff.`,
            fixDescription: 'Inferred from git diff — agent did not write a signal body.',
          },
        }
      }

      // A present-but-non-string field means the agent wrote a malformed
      // body (e.g. `{"hypothesis": 123}`); it would otherwise be dropped
      // without a trace. Warn so the transcript explains the journal gap.
      for (const field of ['hypothesis', 'fixDescription'] as const) {
        const value = effectiveSignal.body[field]
        if (value !== undefined && typeof value !== 'string') {
          emitAgentSystemMessage(ctx, 
            `Signal body field \`${field}\` was not a string — dropping it from the journal entry.`,
          )
        }
      }
      try {
        if (effectiveSignal.kind === 'restart' || effectiveSignal.kind === 'rerun') {
          appendJournalIteration(ctx, {
            signal: effectiveSignal.kind === 'restart' ? '.restart' : '.rerun',
            hypothesis: typeof effectiveSignal.body.hypothesis === 'string' ? effectiveSignal.body.hypothesis : undefined,
            filesChanged,
            fixDescription: typeof effectiveSignal.body.fixDescription === 'string' ? effectiveSignal.body.fixDescription : undefined,
            diffContent,
            runId: ctx.runId,
            manifestPath: ctx.paths.manifestPath,
            summaryPath: ctx.paths.summaryPath,
            journalPath: ctx.paths.diagnosisJournalPath,
          })
        }
      } catch { /* journal write is best-effort */ }

      const verificationPlan = verificationPlanForSummary(ctx, summary)
      setStatus(ctx, 'running')

      const action = heal.actionForSignal(effectiveSignal.kind === 'heal' ? 'rerun' : effectiveSignal.kind)
      if (action.kind === 'restart-and-rerun') {
        const { restarted, kept, startedBecauseMissing } = await host.restart(filesChanged)
        if (ctx.stopped) return ctx.status
        ctx.healCycleHistory.push({ cycle: cycleNum, restarted, kept })
        ctx.stateSink.patchManifest(ctx.runId, {
          healCycleHistory: ctx.healCycleHistory,
        })
        if (startedBecauseMissing.length > 0) {
          recordLifecycle(ctx, 'restarting-services', 'Starting missing kept services', {
            detail: `Starting ${startedBecauseMissing.join(', ')} because this heal restart is running in a fresh orchestrator process.`,
            restartPlan: { restarted, kept, startedBecauseMissing },
          })
        }
      } else {
        await host.rerun()
      }
      if (ctx.stopped) return ctx.status
      const startedBecauseMissing = await ensureServicesRunning(ctx)
      if (startedBecauseMissing.length > 0) {
        recordLifecycle(ctx, 'restarting-services', 'Started missing services', {
          detail: `Started ${startedBecauseMissing.join(', ')} before rerun.`,
          restartPlan: { restarted: [], kept: [], startedBecauseMissing },
        })
      }

      if (ctx.bootFailure) {
        host.recordBootFailureHealWait()
        continue
      }
      const exitCode = await runPlaywright(ctx, selectionForPlan(verificationPlan))
      if (ctx.stopped) return ctx.status
      // User cancelled mid-Playwright (cancelHeal SIGTERM'd the pw pty).
      // Don't read into the killed pty's exit code — finalize as failed.
      if (ctx.healCancelled) {
        finalStatus = 'failed'
        setStatus(ctx, finalStatus)
        break
      }
      finalStatus = decideRunStatus(ctx.feature.featureDir, ctx.paths.summaryPath, exitCode)
      setStatus(ctx, finalStatus)
      if (finalStatus === 'passed') break
    }

    return finalStatus
  } finally {
    // Drop the persistent REPL however the loop terminated — clean break,
    // failure, cancel, threshold, or thrown error. `stop()` also nukes the
    // pty during a full abort, so the second cleanup here is a no-op.
    cleanupHealAgentPty(ctx)
  }
}
