// Running Playwright for one run: the spawn and its log tee, the artifact
// policy applied to what it leaves behind, and the rerun/verification plan
// derived from the summary it wrote. Split out of orchestrator.ts; the bodies
// are unchanged.
import { type RunContext } from './run-context'
import fs from 'fs'
import path from 'path'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { copyDirRecursive } from '../../../../../../../shared/lib/copy-dir'
import { type RunLifecycleTargetedRerun, type RunManifest } from './manifest'
import { SummaryShape, VerificationPlan, computeVerificationPlan, decideRunStatus, normalizeRerunSelection, readLatestHealOnFailureThreshold, type PlaywrightRerunSelection } from './run-verdict'
import { testPortEnv } from './run-service-boot'
import { prepareRun, recordLifecycle, setStatus } from './run-manifest-writer'
import { repoPathOverrideEnv } from './repo-path-env'

// ─── Playwright + heal loop ────────────────────────────────────────────────
//
// Spawns Playwright through the same ptyFactory used for services so tests
// inject a fake. Returns the exit code after the pty exits.
export async function runPlaywright(ctx: RunContext, rerun?: readonly string[] | PlaywrightRerunSelection): Promise<number> {
  const rerunSelection = normalizeRerunSelection(rerun)
  const rerunTargets = rerunSelection?.kind === 'targets' ? rerunSelection.targets : undefined
  const rerunGrep = rerunSelection?.kind === 'grep' ? rerunSelection.grep : undefined
  const feature = featureWithLatestHealThreshold(ctx)
  const inv = ctx.playwrightSpawner({
    feature,
    paths: ctx.paths,
    rerunTargets,
    rerunGrep,
    rerunSelection,
  })
  const targetCount = rerunSelection?.selected ?? 0
  const targetedRerun = rerunSelection
    ? {
        selected: rerunSelection.selected,
        total: rerunSelection.total,
        mode: rerunSelection.mode,
        reason: rerunSelection.reason,
      } satisfies RunLifecycleTargetedRerun
    : undefined
  ctx.emit('playwright-started', { command: inv.command })
  recordLifecycle(ctx, targetedRerun ? 'rerunning-tests' : 'running-tests', targetedRerun ? 'Rerunning Playwright tests' : 'Running Playwright tests', {
    detail: targetedRerun
      ? `Running ${targetCount} selected test target${targetCount === 1 ? '' : 's'}.`
      : 'Running the configured Playwright suite.',
    ...(targetedRerun ? { targetedRerun } : {}),
  })
  const pty = ctx.ptyFactory({
    command: inv.command,
    cwd: inv.cwd,
    env: {
      ...ctx.playwrightEnv,
      ...repoPathOverrideEnv(ctx.repoPathOverrides, ctx.playwrightEnv.NODE_OPTIONS ?? process.env.NODE_OPTIONS),
      // Per-run allocated ports, so tests can target the same dynamic port
      // the local service bound (CANARY_PORT_<shell-safe-slot>). Empty when no ports
      // were allocated, preserving the static envset target for remote runs.
      ...testPortEnv(ctx),
      CANARY_LAB_PROJECT_ROOT: ctx.feature.featureDir,
      CANARY_LAB_MANIFEST_PATH: ctx.paths.manifestPath,
      CANARY_LAB_SUMMARY_PATH: ctx.paths.summaryPath,
      ...(rerunSelection ? { CANARY_LAB_TARGETED_RERUN: '1' } : {}),
    },
  })
  ctx.playwrightPty = pty
  fs.mkdirSync(path.dirname(ctx.paths.playwrightStdoutPath), { recursive: true })
  fs.writeFileSync(ctx.paths.playwrightStdoutPath, '')
  pty.onData((chunk) => {
    try { fs.appendFileSync(ctx.paths.playwrightStdoutPath, chunk) } catch { /* ignore */ }
    ctx.emit('playwright-output', { chunk })
  })
  return new Promise<number>((resolve) => {
    pty.onExit(({ exitCode, signal }) => {
      ctx.playwrightPty = null
      persistPlaywrightArtifacts(ctx)
      ctx.emit('playwright-exit', { exitCode })
      recordLifecycle(ctx, exitCode === 0 ? 'completed' : 'failed', `Playwright exited with code ${exitCode}`, {
        detail: signal ? `Process signal: ${signal}` : undefined,
        severity: exitCode === 0 ? 'success' : 'warning',
      })
      const waiter = ctx.playwrightExitWaiter
      ctx.playwrightExitWaiter = null
      if (waiter) waiter({ exitCode, signal })
      resolve(exitCode)
    })
  })
}

export function featureWithLatestHealThreshold(ctx: RunContext): FeatureConfig {
  const latestThreshold = readLatestHealOnFailureThreshold(ctx.feature)
  return latestThreshold === ctx.feature.healOnFailureThreshold
    ? ctx.feature
    : { ...ctx.feature, healOnFailureThreshold: latestThreshold }
}

// Copy each per-test subdir from `playwright-artifacts/` into the keep dir
// so it survives the next Playwright invocation's `--output` wipe. New
// artifacts for the same pw-slug overwrite the previous copy — heal-cycle
// reruns of a single test thus replace that test's previous video/trace
// while leaving the other tests' artifacts intact. Best-effort: failures
// here are logged but do not fail the run.
export function persistPlaywrightArtifacts(ctx: RunContext): void {
  const src = ctx.paths.playwrightArtifactsDir
  const dst = ctx.paths.playwrightArtifactsKeepDir
  if (!fs.existsSync(src)) return
  try { fs.mkdirSync(dst, { recursive: true }) } catch { return }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(src, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const srcPath = path.join(src, entry.name)
    const dstPath = path.join(dst, entry.name)
    try {
      fs.rmSync(dstPath, { recursive: true, force: true })
      // Not fs.cpSync: its native tree walk aborts the process on a directory
      // it cannot read, which would take the run down instead of warning.
      copyDirRecursive(srcPath, dstPath)
    } catch (err) {
      ctx.runnerLog?.warn(`persist playwright artifact ${entry.name} failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export function verificationPlanForSummary(ctx: RunContext, summary: SummaryShape): VerificationPlan {
  const plan = computeVerificationPlan(ctx.feature.featureDir, summary)
  if (plan.kind === 'targeted') {
    ctx.runnerLog?.info(`Targeted re-run: ${plan.failedFirst.length} failed + ${plan.skipped.length} skipped + ${plan.pending.length} pending of ${plan.total} total tests`)
    recordLifecycle(ctx, 'rerunning-tests', 'Targeted rerun selected', {
      detail: plan.selection.reason,
      targetedRerun: {
        selected: plan.selection.selected,
        total: plan.selection.total,
        mode: plan.selection.mode,
        reason: plan.selection.reason,
      },
    })
    return plan
  }
  if (plan.kind === 'full-suite') {
    ctx.runnerLog?.warn(plan.reason)
    recordLifecycle(ctx, 'rerunning-tests', 'Full rerun selected', {
      detail: plan.reason,
      severity: 'warning',
      targetedRerun: {
        selected: plan.total,
        total: plan.total,
        mode: 'full-suite',
        reason: plan.reason,
      },
    })
    ctx.emit('playwright-output', { chunk: `\n[warning] ${plan.reason}\n` })
    return plan
  }
  return plan
}

export function recordFullSuiteTerminalRestartFallback(ctx: RunContext, reason: string, total: number): void {
  ctx.runnerLog?.warn(reason)
  recordLifecycle(ctx, 'rerunning-tests', 'Full restart rerun selected', {
    detail: reason,
    severity: 'warning',
    targetedRerun: {
      selected: total,
      total,
      mode: 'full-suite',
      reason,
    },
  })
  ctx.emit('playwright-output', { chunk: `\n[warning] ${reason}\n` })
}

// Wait for the in-flight Playwright pty to exit. Resolves immediately when
// there is no Playwright running. Used by pauseAndHeal() after issuing
// SIGTERM so we can fall back to SIGKILL on timeout.
export function waitForPlaywrightExit(ctx: RunContext, timeoutMs: number): Promise<{ exitCode: number; signal?: number } | null> {
  if (!ctx.playwrightPty) return Promise.resolve(null)
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      // Unconditional: the only other clearer is the pty-exit handler, which
      // nulls the waiter AND clears this timer via the waiter it just called —
      // so if we are running, the waiter is still ours. Assigning null to an
      // already-null field would be a no-op regardless.
      ctx.playwrightExitWaiter = null
      resolve(null)
    }, timeoutMs)
    ctx.playwrightExitWaiter = (info) => {
      clearTimeout(timer)
      resolve(info)
    }
  })
}

export async function runVerification(ctx: RunContext): Promise<RunManifest['status']> {
  prepareRun(ctx, 'stopped')
  if (ctx.stopped) return ctx.status
  recordLifecycle(ctx, 'running-tests', 'Running verification tests', {
    detail: 'Verify is observational only: Canary Lab will not start services or heal code.',
  })
  const exitCode = await runPlaywright(ctx)
  if (ctx.stopped) return ctx.status
  const finalStatus = decideRunStatus(ctx.feature.featureDir, ctx.paths.summaryPath, exitCode)
  setStatus(ctx, finalStatus)
  return finalStatus
}
