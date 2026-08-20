// What a run records about itself while it happens: the initial manifest, every
// lifecycle event, the status transitions the UI and the stores read, the
// heartbeat, and the signal-file watcher. Split out of orchestrator.ts; the
// bodies are unchanged.
import { type RunContext } from './run-context'
import { emitAgentSystemMessage } from './run-heal-agent'
import type { LifecycleRecordOptions } from './run-orchestrator-types'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { createRunLifecycleEvent, isTerminalRunStatus, type HealSignalKind } from '../../../../../../../shared/run-state'
import { resolvePath } from '../../../../shared/launcher-startup'
import { readManifest, type RunLifecyclePhase, type RunManifest, type ServiceManifestEntry, type StoppedEarlyReason } from './manifest'
import { appendJournalIteration as appendJournalIterationToFile, type JournalAppendInput } from './log-enrichment'
import { readPlaywrightArtifactPolicy } from './playwright-artifact-policy'
import { signalLabel, startingServicesDetail } from './run-verdict'

export function prepareRun(ctx: RunContext, serviceStatus: ServiceManifestEntry['status']): void {
  ctx.startedAt = new Date().toISOString()
  fs.mkdirSync(ctx.runDir, { recursive: true })
  fs.mkdirSync(ctx.paths.signalsDir, { recursive: true })

  writeInitialManifest(ctx, serviceStatus)
  recordLifecycle(ctx, 'starting-services', 'Starting services', {
    detail: startingServicesDetail(ctx.services.length),
  })
  startSignalWatcher(ctx)
  startHeartbeat(ctx)
}

export function recordLifecycle(ctx: RunContext, 
  phase: RunLifecyclePhase,
  headline: string,
  opts: LifecycleRecordOptions = {},
): void {
  ctx.stateSink.recordLifecycleEvent(ctx.runId, createRunLifecycleEvent(phase, headline, {
    id: randomUUID(),
    ...opts,
  }))
  ctx.lastLifecycleEvent = { phase, headline }
}

export function appendJournalIteration(ctx: RunContext, input: JournalAppendInput): void {
  appendJournalIterationToFile(input)
  ctx.stateSink.recordJournalChange(ctx.runId)
}

export function writeInitialManifest(ctx: RunContext, serviceStatus: ServiceManifestEntry['status'] = 'starting'): void {
  const services: ServiceManifestEntry[] = ctx.services.map((s) => ({
    repoName: s.repoName,
    name: s.name,
    safeName: s.safeName,
    command: s.command,
    cwd: s.cwd,
    logPath: ctx.paths.serviceLog(s.safeName),
    // Manifest carries the http URL only when the probe is http. tcp
    // probes don't have a URL; left undefined so older manifest readers
    // still work for the http case.
    healthUrl: s.healthProbe && 'http' in s.healthProbe ? s.healthProbe.http.url : undefined,
    status: serviceStatus,
    ...(s.allocatedPorts && Object.keys(s.allocatedPorts).length > 0 ? { allocatedPorts: s.allocatedPorts } : {}),
  }))
  const worktreeMap: Record<string, string> = {}
  for (const handle of ctx.worktreeHandles) worktreeMap[handle.repoName] = handle.worktreeRoot
  const manifest: RunManifest = {
    runId: ctx.runId,
    executionType: ctx.executionType,
    feature: ctx.feature.name,
    featureDir: ctx.feature.featureDir,
    env: ctx.env,
    startedAt: ctx.startedAt,
    status: ctx.status,
    healCycles: ctx.healCycles,
    services,
    // Reflect the actual paths this run occupies: worktree-isolated repos
    // point at their worktree so a later run can take the freed source in
    // place without a false collision.
    // `resolvePath` always hands back a string and `existsSync` reports a bad
    // path as `false` rather than throwing, so this needs no error handling.
    repoPaths: (ctx.feature.repos ?? [])
      .map((r) => ctx.repoPathOverrides[r.name] ?? resolvePath(r.localPath))
      .filter((p) => fs.existsSync(p)),
    ...(Object.keys(worktreeMap).length > 0 ? { worktrees: worktreeMap } : {}),
    repoBranches: ctx.repoBranchSnapshots,
    playwrightArtifacts: readPlaywrightArtifactPolicy(ctx.feature.featureDir),
    signalPaths: {
      rerun: ctx.paths.rerunSignal,
      restart: ctx.paths.restartSignal,
    },
    healMode: ctx.externalHeal
      ? 'external'
      : ctx.autoHeal
        ? 'auto'
        : ctx.manualHeal
          ? 'manual'
          : undefined,
    ...(ctx.autoHeal ? { healAgent: ctx.autoHeal.agent } : {}),
    ...(ctx.externalHealSession ? { externalHealSession: ctx.externalHealSession } : {}),
    lifecycle: {
      phase: 'starting-services',
      headline: 'Starting services',
      detail: startingServicesDetail(services.length),
      updatedAt: new Date().toISOString(),
    },
    heartbeatAt: new Date().toISOString(),
    ...(ctx.verification ? { verification: ctx.verification } : {}),
  }
  ctx.stateSink.bootstrap(manifest)
}

// Polls the per-run signals dir. The future server (and externally-spawned
// heal agents) write here; the orchestrator translates them into events the
// consumer can react to (re-run Playwright, restart services, etc.).
export function startSignalWatcher(ctx: RunContext): void {
  if (ctx.signalWatcher) return
  ctx.signalWatcher = setInterval(() => {
    const tries: Array<{ kind: HealSignalKind; file: string }> = [
      { kind: 'restart', file: ctx.paths.restartSignal },
      { kind: 'rerun', file: ctx.paths.rerunSignal },
      { kind: 'heal', file: ctx.paths.healSignal },
    ]
    for (const t of tries) {
      if (!fs.existsSync(t.file)) continue
      let body: Record<string, unknown> = {}
      try {
        const raw = fs.readFileSync(t.file, 'utf-8').trim()
        if (raw) body = JSON.parse(raw) as Record<string, unknown>
      } catch {
        // Tolerate empty/non-JSON — the signal still applies — but say so:
        // a silent parse failure means hypothesis/fixDescription silently
        // vanish from the audit journal.
        emitAgentSystemMessage(ctx, 
          `.${t.kind} signal body was not valid JSON — hypothesis/fixDescription will be missing from the journal.`,
        )
      }
      try { fs.unlinkSync(t.file) } catch { /* race with caller is fine */ }
      const result = ctx.signalGate.observe(t.kind, body)
      if (!result.accepted) {
        recordLifecycle(ctx, 'applying-signal', `${signalLabel(t.kind)} signal ignored`, {
          detail: result.reason === 'signal-already-pending' && result.pendingKind
            ? `A .${result.pendingKind} signal is already pending.`
            : 'The runner was not waiting for a heal signal.',
          severity: 'warning',
          lastSignal: { kind: t.kind, status: 'ignored', reason: result.reason },
        })
        ctx.emit('signal-ignored', { kind: t.kind, reason: result.reason })
        continue
      }
      recordLifecycle(ctx, 'applying-signal', `${signalLabel(t.kind)} signal accepted`, {
        detail: `The runner accepted .${t.kind} and will apply it before verification.`,
        lastSignal: { kind: t.kind, status: 'accepted' },
      })
      ctx.emit('signal-detected', result.signal)
      ctx.emit('signal-accepted', result.signal)
    }
  }, ctx.healthPollIntervalMs)
}

// Persist a `stoppedEarly` reason on the manifest. Surfaced to the heal-index
// so the agent knows it's looking at a partial suite.
export function markStoppedEarly(ctx: RunContext, reason: StoppedEarlyReason, failuresAtStop: number, suiteTotal: number): void {
  ctx.stoppedEarlyReason = reason
  ctx.stateSink.patchManifest(ctx.runId, {
    stoppedEarly: { reason, failuresAtStop, suiteTotal },
  })
}

/** Write a heartbeat timestamp to the manifest every 5 seconds so consumers
 *  can detect orphaned runs whose orchestrator crashed without cleaning up.
 *  The same tick is where a foreign terminal write gets noticed — see
 *  `detectForeignTerminalWrite`. */
export function startHeartbeat(ctx: RunContext): void {
  const tick = (): void => {
    if (ctx.stopped) return
    ctx.stateSink.recordHeartbeat(ctx.runId)
    detectForeignTerminalWrite(ctx)
  }
  ctx.heartbeatTimer = setInterval(tick, 5_000)
  // Don't keep the process alive just for heartbeats.
  ctx.heartbeatTimer.unref()
}

/**
 * Notice when someone outside this process has declared our run over.
 *
 * `stop()` is the only in-process authority for a terminal manifest write, and
 * it sets `ctx.stopped` first — so an active context reading a terminal status
 * off disk means another writer got there. That writer cannot have stopped our
 * heal loop (the orchestrator lives in this process's memory), so the run keeps
 * repairing while the UI, the MCP tools and the Getting Started guard all read
 * a finished run. Recording it here converts a silent divergence into a stated
 * reason the loop can act on.
 *
 * Deliberately reads the manifest rather than trusting the sink's cache: the
 * whole point is to see a write we did not make. A failed or partial read
 * returns null and is treated as no information — a false give-up would kill a
 * healthy repair, which is the exact harm this whole change exists to prevent.
 */
export function detectForeignTerminalWrite(ctx: RunContext): void {
  if (ctx.foreignTerminalStatus) return
  const onDisk = readManifest(ctx.paths.manifestPath)?.status
  if (!onDisk || !isTerminalRunStatus(onDisk)) return
  if (isTerminalRunStatus(ctx.status)) return
  ctx.foreignTerminalStatus = onDisk
  const detail = `Another process wrote status "${onDisk}" to this run's manifest while cycle ${ctx.healCycles} was still repairing. This runner did not end the run, and cannot be stopped from outside — the repair is being wound down here instead.`
  ctx.runnerLog?.warn(detail)
  recordLifecycle(ctx, ctx.status === 'healing' ? 'agent-healing' : 'running-tests', 'Run record marked finished by another process', {
    detail,
    severity: 'warning',
  })
  emitAgentSystemMessage(ctx, detail)
}

export function stopHeartbeat(ctx: RunContext): void {
  if (ctx.heartbeatTimer) {
    clearInterval(ctx.heartbeatTimer)
    ctx.heartbeatTimer = null
  }
}

export function setStatus(ctx: RunContext, status: RunManifest['status']): void {
  // Once the run has been stopped (e.g. user clicked Abort), drop any
  // further status writes coming from the in-flight runFullCycle /
  // heal-loop. Without this guard the killed Playwright pty's exit code
  // would race the abort and overwrite `aborted` with `passed`/`failed`.
  // `stop()` is the single authority for the terminal manifest write.
  if (ctx.stopped) return
  ctx.status = status
  ctx.emit('run-status', { status })
  ctx.stateSink.setStatus(ctx.runId, status, ctx.healCycles)
  if (status === 'passed' || status === 'failed') {
    recordLifecycle(ctx, status, status === 'passed' ? 'Run passed' : 'Run failed', {
      severity: status === 'passed' ? 'success' : 'error',
    })
  }
  // On a pass, promote the run-start baseline to "last green" for specs that
  // weren't modified during the run — binding the green verdict to the
  // pre-heal test bytes. Specs the agent touched are left dirty (the live cue
  // is already set by the spec watcher at edit time). Best-effort, fire-and-
  // forget: a recompute must never gate the status write. Failed/aborted runs
  // intentionally don't touch the baseline.
  if (status === 'passed' && ctx.feature.featureDir) {
    void ctx.dirtySpecHooks
      ?.finalizeRun(ctx.feature.name, ctx.feature.featureDir, true)
      .catch(() => {})
  }
}

// Record the pre-heal spec hashes for this run. Guards a missing featureDir and
// swallows errors so integrity capture never blocks boot.
export async function captureDirtySpecBaseline(ctx: RunContext): Promise<void> {
  if (!ctx.dirtySpecHooks || !ctx.feature.featureDir) return
  try {
    await ctx.dirtySpecHooks.captureRunStart(ctx.feature.name, ctx.feature.featureDir)
  } catch {
    /* integrity capture is best-effort */
  }
}

export function noteHealCycle(ctx: RunContext): void {
  ctx.healCycles += 1
  ctx.stateSink.patchManifest(ctx.runId, { healCycles: ctx.healCycles })
}
