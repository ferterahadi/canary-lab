import { createRunContext, type RunContext } from './run-context'
import { cancelHeal, continueAfterTestRun, pauseAndHeal, restartHealFromFailure } from './run-heal-loop'
import { recordFullSuiteTerminalRestartFallback, runPlaywright, runVerification, verificationPlanForSummary } from './run-playwright'
import { interjectHealAgent, runHealAgent, waitForHealSignal } from './run-heal-agent'
import type { StoppedEarlyReason } from './manifest'
import { applyPortifyOverlay, captureFixBaseline, captureFixes, hydrateWorktreeEnvsets, reversePortifyOverlay } from './run-fix-capture'
import fs from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import type { FeatureConfig } from '../../../../../../../shared/launcher/types'
import { type RunPaths } from './run-paths'
import { type RunManifest } from './manifest'
import type { RunnerLog } from './runner-log'
import { planRestart } from './restart-planner'
import { releasePorts } from './port-allocator'
import { removeWorktree } from './repo-worktree'
// Headless event-emitting orchestrator for a single feature run. Wraps the
// existing health-check / signal-file semantics behind a clean API the future
// Fastify server can drive without inheriting any readline / iTerm cruft.

import { decideRunStatus, finalLifecyclePhase, readSummary, restartPlanDetail, selectionForPlan, summaryHasPassingEvidence } from './run-verdict'
import { killTree, scheduleSigkillFallback } from './run-spawn'
import type { PlaywrightSpawner } from './run-spawn'
import { ensureServicesRunning, spawnService, waitForHealth } from './run-service-boot'
import { captureDirtySpecBaseline, markStoppedEarly, noteHealCycle, prepareRun, recordLifecycle, setStatus, stopHeartbeat } from './run-manifest-writer'
import type { InterjectResult, OrchestratorEventMap, OrchestratorOptions, ServiceSpec } from './run-orchestrator-types'

export type { AutoHealAgent, AutoHealConfig, BuildServiceSpecsOptions, CancelHealResult, DirtySpecHooks, InterjectResult, LifecycleRecordOptions, OrchestratorEventMap, OrchestratorOptions, PauseResult, ServiceSpec } from './run-orchestrator-types'
export { buildQueuedServiceEntries, buildServiceSpecs, collectPortSlots } from './service-specs'

export type { PlaywrightInvocation, PlaywrightSpawner } from './run-spawn'

export class RunOrchestrator extends EventEmitter {
  /** Every field this class used to declare. Shared by reference with the
   *  run-domain modules in ./run-* so each concern lives in its own file
   *  without widening the class's surface — see run-context.ts. */
  private readonly ctx: RunContext

  get runId(): string { return this.ctx.runId }
  get runDir(): string { return this.ctx.runDir }
  get feature(): FeatureConfig { return this.ctx.feature }
  get env(): string | undefined { return this.ctx.env }
  get paths(): RunPaths { return this.ctx.paths }
  get services(): ServiceSpec[] { return this.ctx.services }

  constructor(opts: OrchestratorOptions) {
    super()
    this.ctx = createRunContext(opts, (event, payload) => this.emit(event, payload))
    if (this.ctx.runnerLog) this.attachRunnerLog(this.ctx.runnerLog)
  }

  // Subscribe the runner-log to every lifecycle event it cares about. Done
  // once at construction so neither caller (CLI shim, web-server) has to wire
  // listeners themselves.
  private attachRunnerLog(log: RunnerLog): void {
    const events: (keyof OrchestratorEventMap)[] = [
      'service-started',
      'service-exit',
      'health-check',
      'playwright-started',
      'playwright-exit',
      'agent-started',
      'agent-exit',
      'heal-cycle-started',
      'signal-detected',
      'signal-accepted',
      'signal-ignored',
      'run-status',
      'run-complete',
    ]
    for (const ev of events) {
      this.on(ev, (payload) => log.recordEvent(ev, payload as never))
    }
  }

  // ── delegations ──────────────────────────────────────────────────────────
  // These moved into the run-* modules beside this file; they stay on the class
  // because they are its public surface — routes, the MCP tools and the tests
  // drive the orchestrator, not the modules.

  markStoppedEarly(reason: StoppedEarlyReason, failuresAtStop: number, suiteTotal: number): void {
    markStoppedEarly(this.ctx, reason, failuresAtStop, suiteTotal)
  }

  setStatus(status: RunManifest['status']): void {
    setStatus(this.ctx, status)
  }

  noteHealCycle(): void {
    noteHealCycle(this.ctx)
  }

  async pauseAndHeal(): ReturnType<typeof pauseAndHeal> {
    return pauseAndHeal(this.ctx, this)
  }

  async cancelHeal(): ReturnType<typeof cancelHeal> {
    return cancelHeal(this.ctx, this)
  }

  async restartHealFromFailure(guidance = ''): ReturnType<typeof restartHealFromFailure> {
    return restartHealFromFailure(this.ctx, this, guidance)
  }

  async runPlaywright(args?: Parameters<typeof runPlaywright>[1]): ReturnType<typeof runPlaywright> {
    return runPlaywright(this.ctx, args)
  }

  async runVerification(): ReturnType<typeof runVerification> {
    return runVerification(this.ctx)
  }

  async interjectHealAgent(text: string): Promise<InterjectResult> {
    return interjectHealAgent(this.ctx, text)
  }

  async waitForHealSignal(
    hardTimeoutMs?: number,
    idleTimeoutMs?: number,
    requiresAgent?: boolean,
  ): ReturnType<typeof waitForHealSignal> {
    return waitForHealSignal(this.ctx, hardTimeoutMs, idleTimeoutMs, requiresAgent)
  }

  async runHealAgent(args: Parameters<typeof runHealAgent>[1]): ReturnType<typeof runHealAgent> {
    return runHealAgent(this.ctx, args)
  }

  emit<K extends keyof OrchestratorEventMap>(
    event: K,
    payload: OrchestratorEventMap[K],
  ): boolean {
    return super.emit(event, payload)
  }

  on<K extends keyof OrchestratorEventMap>(
    event: K,
    listener: (payload: OrchestratorEventMap[K]) => void,
  ): this {
    return super.on(event, listener)
  }

  // Top-level entry point. Spawns services + waits for health + streams
  // signals to the consumer. Does NOT block on Playwright by itself — the
  // caller drives Playwright via runPlaywright(), which lets the future
  // server show "services up" before tests start.
  async start(): Promise<void> {
    prepareRun(this.ctx, 'starting')
    // Capture the pre-heal spec baseline before any service (and therefore any
    // heal agent) can touch a test file. This is the run-start fallback baseline
    // and the reference the green promotion compares against. Best-effort —
    // integrity tracking must never block a run from booting.
    await captureDirtySpecBaseline(this.ctx)
    // Apply the ephemeral port overlay BEFORE any service spawns. A failure
    // here throws out of start() so the caller's `.catch` runs stop('aborted')
    // — we must never boot a portified feature un-portified (the second
    // concurrent boot would EADDRINUSE on the un-injected port).
    await applyPortifyOverlay(this.ctx)
    // Then the envset: worktrees are cut from committed HEAD, so the real-path
    // envset apply (uncommitted) never reaches them — a worktree-isolated
    // service would boot the CHECKED-IN config (e.g. a docker `db` datasource
    // host) and die where the same feature boots green at its real path.
    // Overlay-first mirrors real-run semantics: the envset overwrites the
    // checked-in file either way. Throws like the overlay — booting
    // un-hydrated just fails later with a far less actionable error.
    hydrateWorktreeEnvsets(this.ctx)
    // Snapshot each worktree NOW — after overlay + envset + WIP hydration, before
    // any service (and therefore any heal agent) can touch it. The diff against
    // this baseline at teardown is exactly the heal agent's fix (R80).
    await captureFixBaseline(this.ctx)
    await ensureServicesRunning(this.ctx)
  }

  // Manually fire a restart. When `filesChanged` is supplied and non-empty,
  // restart only the services whose `cwd` covers at least one changed file.
  // Empty / undefined → legacy "restart all" semantics. If no service matches
  // a non-empty `filesChanged` we emit `restart-planned` with `noMatch: true`
  // and skip the restart entirely (rather than restarting everything) — the
  // heal-agent's claim is wrong but losing warm services to that mistake is
  // costlier than the rerun seeing the same failure.
  async restart(filesChanged?: readonly string[]): Promise<{ restarted: string[]; kept: string[]; startedBecauseMissing: string[] }> {
    const plan = planRestart(filesChanged ?? [], this.ctx.services)
    const startedBecauseMissing = plan.toKeep.filter((safeName) => {
      const svc = this.ctx.services.find((candidate) => candidate.safeName === safeName)
      return Boolean(svc && !this.ctx.servicePtys.has(svc.name))
    })
    this.emit('restart-planned', {
      toRestart: plan.toRestart,
      toKeep: plan.toKeep,
      noMatch: plan.noMatch,
    })
    recordLifecycle(this.ctx, 'restarting-services', 'Restart plan ready', {
      detail: restartPlanDetail(plan.toRestart, plan.toKeep, startedBecauseMissing),
      restartPlan: {
        restarted: plan.toRestart,
        kept: plan.toKeep,
        startedBecauseMissing,
        noMatch: plan.noMatch,
      },
    })

    if (plan.noMatch) {
      // Non-empty filesChanged but nothing matched: keep all services warm.
      for (const svc of this.ctx.services) {
        this.emit('service-restart-skipped', { service: svc, reason: 'no-files-changed-here' })
      }
      return { restarted: [], kept: plan.toKeep, startedBecauseMissing }
    }

    const filesProvided = (filesChanged ?? []).length > 0
    const restartSet = new Set(plan.toRestart)
    const targets: ServiceSpec[] = []
    for (const svc of this.ctx.services) {
      if (!filesProvided || restartSet.has(svc.safeName)) {
        targets.push(svc)
      } else {
        this.emit('service-restart-skipped', { service: svc, reason: 'no-files-changed-here' })
      }
    }

    for (const svc of targets) {
      const pty = this.ctx.servicePtys.get(svc.name)
      if (pty) {
        try { pty.kill('SIGTERM') } catch { /* already dead */ }
        this.ctx.servicePtys.delete(svc.name)
      }
      this.ctx.logFiles.delete(this.ctx.paths.serviceLog(svc.safeName))
      const p = this.ctx.paths.serviceLog(svc.safeName)
      try { fs.writeFileSync(p, '') } catch { /* may not exist yet */ }
    }
    for (const svc of targets) {
      this.ctx.stateSink.setServiceStatus(this.ctx.runId, svc.safeName, 'starting')
      spawnService(this.ctx, svc)
    }
    if (targets.length > 0) await waitForHealth(this.ctx)
    return { restarted: plan.toRestart, kept: plan.toKeep, startedBecauseMissing }
  }

  // Re-run is a no-op at the orchestrator level beyond truncating logs — the
  // consumer reruns Playwright on top.
  async rerun(): Promise<void> {
    for (const svc of this.ctx.services) {
      const p = this.ctx.paths.serviceLog(svc.safeName)
      try { fs.writeFileSync(p, '') } catch { /* may not exist yet */ }
    }
  }

  /**
   * Raw write to the heal-agent pty's stdin. Used by the bidirectional pane
   * (every keystroke from xterm.js becomes a chunk) so users can type
   * directly into the live claude/codex REPL — slash commands, Esc to
   * interrupt, etc. — without going through the higher-level interject path.
   *
   * No-op when no agent pty is in flight (between cycles, manual mode, or
   * after cancel).
   */
  writeToHealAgent(chunk: string): void {
    if (!chunk) return
    const pty = this.ctx.healAgentPty
    if (!pty) return
    try { pty.write(chunk) } catch { /* pty closed mid-frame */ }
  }

  /**
   * Push the user's xterm dimensions into the heal-agent pty so the agent TUI
   * redraws at the correct width. Without this, the pty stays at its spawn-time
   * defaults (120×30) and wraps box-drawing / status bars to whatever it thinks
   * the terminal is, not what the pane is.
   *
   * Invalid dimensions are ignored. Valid dimensions are remembered even when
   * no agent pty is in flight, because the pane can report its size before the
   * REPL spawns.
   */
  resizeHealAgent(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    if (cols < 1 || rows < 1) return
    // Cap at sane upper bounds — node-pty accepts huge values but agent
    // renderers can chew CPU on absurd sizes (e.g., 100k cols).
    const c = Math.min(Math.floor(cols), 1000)
    const r = Math.min(Math.floor(rows), 1000)
    this.ctx.healAgentTerminalSize = { cols: c, rows: r }
    const pty = this.ctx.healAgentPty
    if (!pty) return
    try { pty.resize(c, r) } catch { /* pty closed mid-frame */ }
  }

  /** Absolute path to the heal-prompt file written by `buildCyclePrompt`.
   *  Stable across cycles — each cycle overwrites it with that cycle's
   *  prompt body, then references it via claude's `@<path>` syntax. */

  // Top-level "do the whole thing" entry. Boots services, runs Playwright,
  // and—if autoHeal is enabled—loops through heal cycles until one of:
  // tests pass, the cap is hit, the agent gives up without signaling, or the
  // failure set stops changing. Updates manifest status throughout.
  async runFullCycle(): Promise<RunManifest['status']> {
    await this.start()
    if (this.ctx.stopped) return this.ctx.status
    // A service never came up — the Playwright suite would be meaningless.
    // Declare the run failed and route it into heal (the agent fixes the
    // service) instead of running tests against a dead service.
    if (this.ctx.bootFailure) return await this.failRunForBootFailure()
    let exitCode = await runPlaywright(this.ctx)
    // If the user clicked Abort while Playwright was running, bail out
    // immediately — don't compute a finalStatus from the killed pty's
    // exit code, and don't fall through into the heal loop where a fresh
    // heal agent would otherwise be spawned. `stop()` has already written
    // 'aborted' to the manifest; honor it.
    if (this.ctx.stopped) return this.ctx.status
    // Status comes from decideRunStatus, not Playwright's exit byte alone.
    // The summary file is the authoritative record: PASSED requires every
    // AST-visible test to be in `passedNames`, so failed/skipped/pending all
    // block. This catches:
    //   - The pty.onExit→runPlaywright continuation firing BEFORE the user's
    //     pause-heal HTTP request reaches the server (otherwise a graceful
    //     exit-0 would mark "passed, healCycles: 0").
    //   - Playwright catching SIGTERM/SIGINT, partial-flushing, and exiting 0.
    //   - Targeted re-runs that complete cleanly while earlier failures or
    //     pending tests are still recorded in the summary.
    let finalStatus: RunManifest['status'] = decideRunStatus(
      this.ctx.feature.featureDir,
      this.ctx.paths.summaryPath,
      exitCode,
    )
    // If the user clicked Pause & Heal, Playwright was killed on purpose —
    // even a clean summary mustn't mark the run "passed". The
    // `markStoppedEarly('user-pause')` call inside `pauseAndHeal` is what
    // we key off here. Override so the heal-loop entry condition below fires.
    if (this.ctx.stoppedEarlyReason === 'user-pause') {
      finalStatus = 'failed'
    }
    setStatus(this.ctx, finalStatus)

    return await continueAfterTestRun(this.ctx, this, finalStatus)
  }

  // Boot-only entry. The envset was applied before construction (by the server's
  // startRun factory). This boots the services + waits for health, then HOLDS
  // them — no Playwright, no heal loop. The run stays active (status 'running',
  // phase 'services-ready') until the user/agent stops it; `stop()` then tears
  // the services down and the server's run-complete handler reverts the envset.
  //
  // Unlike `runFullCycle`, the caller must NOT chain `.then(stop)` on this
  // promise: resolving here means "services are up and held", not "run done".
  // A health-check timeout still `throw`s out of `start()` so the caller's
  // `.catch` can stop()+revert; an abort mid-boot sets `this.ctx.stopped`.
  async bootOnly(): Promise<void> {
    await this.start()
    if (this.ctx.stopped) return
    recordLifecycle(this.ctx, 'services-ready', 'Services ready — boot-only session (tests skipped)', {
      detail: 'Services are up and held. Stop the run to tear them down and revert the envset.',
      severity: 'success',
    })
  }

  async restartTerminalRun(userGuidance?: string): Promise<RunManifest['status']> {
    await this.start()
    if (this.ctx.stopped) return this.ctx.status
    if (this.ctx.bootFailure) return await this.failRunForBootFailure()
    if (userGuidance) {
      this.ctx.runnerLog?.info(`Terminal run restart guidance: ${userGuidance}`)
    }
    const summary = readSummary(this.ctx.paths.summaryPath)
    const verificationPlan = verificationPlanForSummary(this.ctx, summary)
    let selection = selectionForPlan(verificationPlan)
    if (verificationPlan.kind === 'all-passed') {
      if (summaryHasPassingEvidence(summary)) {
        setStatus(this.ctx, 'passed')
        return 'passed'
      }
      recordFullSuiteTerminalRestartFallback(this.ctx, 
        'Terminal restart could not find prior passing evidence or a safe remaining-test selector; running the full Playwright suite.',
        verificationPlan.total,
      )
      selection = undefined
    }
    setStatus(this.ctx, 'running')
    const exitCode = await runPlaywright(this.ctx, selection)
    if (this.ctx.stopped) return this.ctx.status
    const finalStatus = decideRunStatus(this.ctx.feature.featureDir, this.ctx.paths.summaryPath, exitCode)
    setStatus(this.ctx, finalStatus)
    return await continueAfterTestRun(this.ctx, this, finalStatus)
  }

  // A service failed to come up, so the suite can't run. Declare the run
  // `failed` and route it into heal exactly like a test failure:
  // heal-configured runs move to 'healing' (the agent reads the failed
  // service's log via the manifest's `bootFailure`); a run with no heal mode
  // ends terminal 'failed' — not 'aborted', because the app is broken, the user
  // didn't stop it.
  private async failRunForBootFailure(): Promise<RunManifest['status']> {
    setStatus(this.ctx, 'failed')
    return await continueAfterTestRun(this.ctx, this, 'failed')
  }

  // A heal rerun restarted the services but one still failed to come up.
  // Running Playwright against a dead service would only reproduce the same
  // failure, so the heal loops skip the rerun and re-wait for the next fix —
  // this records why, pointing the agent back at the service log.
  /** Part of the RunLoopHost contract the heal loop is handed. */
  recordBootFailureHealWait(): void {
    const bf = this.ctx.bootFailure
    if (!bf) return
    recordLifecycle(this.ctx, 'agent-healing', `Service still down: ${bf.service}`, {
      detail: `${bf.detail} Skipped the test run — fix the service (log: ${bf.logPath}) and signal again.`,
      severity: 'error',
      activeCycle: this.ctx.healCycles,
    })
  }

  async stop(finalStatus: RunManifest['status'] = 'aborted'): Promise<void> {
    if (this.ctx.stopped) return
    this.ctx.stopped = true
    if (this.ctx.signalWatcher) {
      clearInterval(this.ctx.signalWatcher)
      this.ctx.signalWatcher = null
    }
    stopHeartbeat(this.ctx)
    // Kill any in-flight Playwright + heal-agent ptys before services so the
    // user's abort actually stops the visible processes — not just the
    // services they happen to depend on. `killTree` targets the process group
    // (negative pid) so children of the shell pipeline (claude, formatter)
    // also receive the signal; bare `pty.kill` only signals the shell.
    if (this.ctx.playwrightPty) {
      killTree(this.ctx.playwrightPty, 'SIGTERM')
      scheduleSigkillFallback(this.ctx.playwrightPty)
      this.ctx.playwrightPty = null
    }
    if (this.ctx.healAgentPty) {
      killTree(this.ctx.healAgentPty, 'SIGTERM')
      scheduleSigkillFallback(this.ctx.healAgentPty)
      this.ctx.healAgentPty = null
    }
    for (const [name, pty] of this.ctx.servicePtys) {
      killTree(pty, 'SIGTERM')
      this.ctx.servicePtys.delete(name)
    }
    this.ctx.logFiles.clear()
    // Capture the heal agent's fix diff from each worktree BEFORE the overlay is
    // reversed or the worktree is removed — the baseline was taken after overlay
    // + envset + WIP, so this diff is exactly the repair (R80). Best-effort:
    // never blocks finalization.
    await captureFixes(this.ctx).catch((err) => {
      this.ctx.runnerLog?.warn(`Fix capture failed: ${(err as Error).message}`)
    })
    // Release per-run isolation resources. Ports go back to the pool. For a
    // PORTIFIED run we reverse the overlay but KEEP the worktree — it holds the
    // heal agent's repair edits, and it follows the normal run-worktree
    // lifecycle (the Cleanup page lists/opens/removes it). For a non-portified
    // worktree run, tear the worktree down so the source repo doesn't
    // accumulate stale checkouts. Failures here must not block finalization.
    if (this.ctx.portMap) releasePorts(this.ctx.portMap.values())
    if (this.ctx.portified) {
      await reversePortifyOverlay(this.ctx).catch(() => {})
    } else {
      for (const handle of this.ctx.worktreeHandles) {
        await removeWorktree(handle).catch(() => {})
      }
    }
    const endedAt = new Date().toISOString()
    this.ctx.status = finalStatus
    // Single terminal write — services flipped to 'stopped', status +
    // endedAt + healCycles persisted, runs-index mirrored. The sink is the
    // only writer at this point; no other path can race because
    // `this.ctx.stopped = true` already gates `setStatus`.
    this.ctx.stateSink.finalize(this.ctx.runId, finalStatus, endedAt, this.ctx.healCycles)
    // A boot-only session ending is a normal teardown, not a failure: give it a
    // calm "services stopped" headline (info, no abortReason) instead of the
    // warning-tinted "Run aborted" a test run gets.
    const isBoot = this.ctx.executionType === 'boot'
    const finalPhase = finalLifecyclePhase(finalStatus)
    const finalHeadline = finalStatus === 'aborted'
      ? (isBoot ? 'Services stopped — envset reverted' : 'Run aborted')
      : finalStatus === 'passed' ? 'Run passed' : 'Run failed'
    if (this.ctx.lastLifecycleEvent?.phase !== finalPhase || this.ctx.lastLifecycleEvent.headline !== finalHeadline) {
      recordLifecycle(this.ctx, finalPhase, finalHeadline, {
        severity: finalStatus === 'passed' ? 'success' : finalStatus === 'aborted' ? (isBoot ? 'info' : 'warning') : 'error',
        ...(finalStatus === 'aborted' && !isBoot ? { abortReason: this.ctx.pendingAbortReason ?? { reason: 'run-stopped' } } : {}),
      })
    }
    this.emit('run-complete', { status: finalStatus })
  }
}
