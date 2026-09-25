import { recordLifecycle } from './run-manifest-writer'
import type { ServiceSpec } from './run-orchestrator-types'
// Bringing a run's services up: one pty per service spec, the log tee, and the
// health poll that decides whether the suite can run at all. A failed probe
// records a boot failure on the context rather than throwing, because the run
// loop routes that into heal instead of aborting.
import { type RunContext } from './run-context'
import fs from 'fs'
import path from 'path'
import type { HttpProbe, TcpProbe } from '../../../../../../../shared/launcher/types'
import { coerceTcpPort, isHealthy, isTcpListening } from '../../../../shared/launcher-startup'
import { type RunBootFailure } from './manifest'
import { COMPILER_FAILURE_NEXT_ACTION, type RunBootEvidence } from '../../../../../../../shared/run-state'
import { classifyBootEvidence, diagnosticExcerpt, redactDiagnosticText } from './diagnostic-redaction'
import type { PtyHandle } from './pty-spawner'
import os from 'os'
import { randomUUID } from 'crypto'
import { prepareWorktreeDependencies } from './dependency-provenance'
import { dependencyIncompatibilityReason } from '../../../../../../../shared/dependency-provenance'
import { loadFeatures } from '../../../../shared/feature-loader'
import { killTree, scheduleSigkillFallback } from './run-spawn'
import { readWatchCompilerFailure } from './watch-compiler-result'

// node-pty reports the raw signal number; spawnSync reports the name. The
// manifest stores names only, so one record can never read "signal 15" where
// another reads "signal SIGTERM".
function signalName(signal: number | undefined): string | null {
  if (signal == null) return null
  const match = Object.entries(os.constants.signals).find(([, value]) => value === signal)
  return match ? match[0] : String(signal)
}

// The redacted, byte-bounded log evidence every boot failure carries. Kept in
// one place so a new evidence field doesn't mean editing three object literals.
function bootEvidence(logPath: string): Pick<RunBootFailure, 'logPath' | 'excerpt' | 'excerptTruncated'> {
  const { excerpt, truncated } = diagnosticExcerpt(logPath)
  return { logPath, ...(excerpt ? { excerpt } : {}), excerptTruncated: truncated }
}

// Record the FIRST boot failure of an attempt and publish it, so every open
// view and the heal packet see the same record. Later services failing in the
// same attempt don't overwrite the original cause.
function recordBootFailure(ctx: RunContext, failure: RunBootFailure, lifecycleLabel: string): void {
  ctx.bootFailure ??= failure
  ctx.stateSink.setServiceStatus(ctx.runId, failure.safeName, failure.reason === 'compiler-failed' ? 'failed' : 'timeout')
  ctx.stateSink.patchManifest(ctx.runId, { bootFailure: ctx.bootFailure })
  recordLifecycle(ctx, 'starting-services', lifecycleLabel, {
    detail: [ctx.bootFailure.detail, ctx.bootFailure.nextAction].filter(Boolean).join(' '),
    severity: 'error',
  })
}

function recordRuntimeServiceFailure(
  ctx: RunContext,
  svc: ServiceSpec,
  kind: 'compiler' | 'process-exited',
  detail: string,
  exit?: { exitCode: number; signal: string | null },
): void {
  if (ctx.stopped || ctx.serviceFailure || ctx.status === 'passed' || ctx.status === 'aborted') return
  const logPath = ctx.paths.serviceLog(svc.safeName)
  ctx.serviceFailure = {
    service: svc.name,
    safeName: svc.safeName,
    kind,
    detail,
    ...bootEvidence(logPath),
    command: redactDiagnosticText(svc.command),
    cwd: svc.cwd,
    ...(exit ? { exitCode: exit.exitCode, signal: exit.signal } : {}),
    at: new Date().toISOString(),
  }
  ctx.stateSink.setServiceStatus(ctx.runId, svc.safeName, 'failed')
  ctx.stateSink.patchManifest(ctx.runId, { serviceFailure: ctx.serviceFailure })
  recordLifecycle(ctx, ctx.status === 'healing' ? 'agent-healing' : ctx.playwrightPty ? 'running-tests' : 'services-ready', `Service failed after readiness: ${svc.name}`, {
    detail: ctx.status === 'healing'
      ? `${detail} The service will restart before test verification.`
      : `${detail} The run will enter healing after the current Playwright process stops.`,
    severity: 'error',
  })
  if (ctx.playwrightPty) {
    killTree(ctx.playwrightPty, 'SIGTERM')
    scheduleSigkillFallback(ctx.playwrightPty)
  }
}

// What the evidence added decides the action; the reason only breaks the tie
// when the evidence added nothing. A nested-ternary ladder here had a trailing
// arm that would silently absorb every future classification value.
const UNPRESERVED_CAUSE_ACTION = 'Canary did not observe the underlying cause: the outer startup wrapper did not preserve the original rejection or child-process failure, so do not guess a root cause. Update that product-repo wrapper to log and rethrow the original error, then restart so Canary can capture it.'
const EMPTY_OUTPUT_ACTION = 'The process exited without captured output. Verify the command and wrapper forwarding, then restart to collect the original error.'
const HEALTH_TIMEOUT_ACTION = 'The process remained alive but readiness never passed. Inspect the full service log and verify the readiness target, listen address, and startup progress, then restart.'

function readinessNextAction(reason: 'health-timeout' | 'process-exited', evidence: RunBootEvidence | null): string {
  if (evidence === 'underlying-cause-not-preserved') return UNPRESERVED_CAUSE_ACTION
  if (evidence === 'compiler-failure') return COMPILER_FAILURE_NEXT_ACTION
  if (reason === 'health-timeout') return HEALTH_TIMEOUT_ACTION
  if (evidence === 'empty-output') return EMPTY_OUTPUT_ACTION
  return 'Fix the failure shown in the preserved process evidence, then restart the run.'
}

/** Drop a prior attempt's boot failure from the context AND the manifest, so a
 *  service that comes up cleanly this time clears the failed state everywhere
 *  it was published — not just in memory. */
export function clearBootFailure(ctx: RunContext): void {
  ctx.bootFailure = undefined
  ctx.stateSink.patchManifest(ctx.runId, { bootFailure: undefined })
}

/** Every service-spawning path shares this gate. Persist the newly measured
 *  evidence before a process can start so UI and reconnected agents never
 *  act on the previous attempt's verdict. Unknown remains the legacy allow. */
export async function preflightServiceBoot(ctx: RunContext): Promise<boolean> {
  if (ctx.worktreeHandles.length > 0) {
    const provenance = []
    const evidenceDir = path.join(ctx.runDir, 'dependency-preflight', randomUUID())
    // Only preparation is live configuration. Service paths, commands and the
    // recorded test suite remain pinned to this run's original topology.
    let latest: RunContext['feature'] | undefined
    try {
      if (ctx.dependencyConfigPath && fs.existsSync(ctx.dependencyConfigPath)) {
        latest = loadFeatures(path.dirname(ctx.feature.featureDir)).find((feature) => feature.name === ctx.feature.name)
      }
    } catch {
      // An unreadable configuration becomes a durable blocker below, never a
      // fallback to stale preparation commands or an unstructured run abort.
    }
    for (const handle of ctx.worktreeHandles) {
      const repo = (ctx.dependencyConfigPath ? latest : ctx.feature)?.repos?.find((candidate) => candidate.name === handle.repoName)
      const configurationError = ctx.dependencyConfigPath && !repo
        ? `Restore a valid ${ctx.dependencyConfigPath} with repository "${handle.repoName}" and its dependencyPreparation, then request runner verification.`
        : undefined
      const item = await prepareWorktreeDependencies({
        handle,
        config: repo?.dependencyPreparation,
        requiredConfig: ctx.feature.repos?.find((candidate) => candidate.name === handle.repoName)?.dependencyPreparation,
        configurationError,
        runDir: evidenceDir,
      })
      provenance.push({ ...item, checkedAt: new Date().toISOString() })
    }
    if (ctx.stopped) return false
    ctx.dependencyProvenance = provenance
    ctx.stateSink.patchManifest(ctx.runId, { dependencyProvenance: provenance })
  }
  clearBootFailure(ctx)
  const incompatibleRepos = ctx.dependencyProvenance.filter((item) => item.verdict === 'incompatible')
  for (const incompatible of incompatibleRepos) {
    const validation = incompatible.validation
    const services = ctx.services.filter((candidate) => candidate.repoName === incompatible.repoName)
    const service = services[0]
    recordBootFailure(ctx, {
      service: service?.name ?? incompatible.repoName,
      safeName: service?.safeName ?? incompatible.repoName,
      reason: 'dependency-incompatible',
      detail: dependencyIncompatibilityReason(incompatible),
      ...bootEvidence(validation?.logPath ?? ctx.paths.runnerLogPath),
      command: validation?.command,
      cwd: validation?.cwd ?? incompatible.worktreePath,
      exitCode: validation?.exitCode,
      signal: validation?.signal,
      nextAction: incompatible.remediation ?? 'Prepare coherent dependencies for this source revision, then restart the run.',
    }, `Dependency preflight failed: ${incompatible.repoName}`)
    for (const affected of services.slice(1)) ctx.stateSink.setServiceStatus(ctx.runId, affected.safeName, 'timeout')
  }
  return !ctx.stopped && incompatibleRepos.length === 0
}

export async function ensureServicesRunning(ctx: RunContext, afterPreflight?: () => Promise<void>): Promise<string[]> {
  const allowed = await preflightServiceBoot(ctx)
  // Initial fix capture includes target-owned preparation, but precedes every
  // service/agent edit. Recovery attempts retain that original baseline.
  if (!ctx.stopped) await afterPreflight?.()
  if (!allowed || ctx.stopped) return []
  const toStart = ctx.services.filter((svc) => !ctx.servicePtys.has(svc.name))
  for (const svc of toStart) {
    ctx.stateSink.setServiceStatus(ctx.runId, svc.safeName, 'starting')
    spawnService(ctx, svc)
    if (ctx.bootFailure) break
  }
  if (ctx.bootFailure) return []
  if (ctx.services.length > 0) await waitForHealth(ctx)
  return toStart.map((svc) => svc.safeName)
}

/** The shell-safe environment key Playwright receives for a declared port
 *  slot. Config tokens keep the slot verbatim (`${port.checkout-service}`),
 *  while the process environment replaces punctuation with underscores
 *  because interactive shells drop names such as
 *  `CANARY_PORT_checkout-service`. */
export function testPortEnvKey(slot: string): string {
  return `CANARY_PORT_${slot.replace(/[^a-z0-9_]/gi, '_')}`
}

// Per-run allocated ports exposed to the Playwright process under the
// shell-safe key above so tests can resolve the dynamic target. Empty when the
// feature declares no port slots (remote runs keep their static envset URL).
export function testPortEnv(ctx: RunContext): Record<string, string> {
  const out: Record<string, string> = {}
  const owners = new Map<string, string>()
  const ports = ctx.portMap
  if (ports) {
    for (const [slot, port] of ports) {
      const key = testPortEnvKey(slot)
      const owner = owners.get(key)
      if (owner && owner !== slot) {
        throw new Error(`Port slots "${owner}" and "${slot}" both normalize to Playwright env key "${key}"; rename one slot`)
      }
      owners.set(key, slot)
      out[key] = String(port)
    }
  }
  return out
}

export function ensureLogFile(ctx: RunContext, target: string): void {
  if (ctx.logFiles.has(target)) return
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (!fs.existsSync(target)) fs.writeFileSync(target, '')
  ctx.logFiles.add(target)
}

export function spawnService(ctx: RunContext, svc: ServiceSpec): void {
  const logPath = ctx.paths.serviceLog(svc.safeName)
  ensureLogFile(ctx, logPath)
  ctx.serviceReady.delete(svc.name)
  ctx.serviceCompilerOutput.delete(svc.name)
  if (ctx.serviceFailure?.service === svc.name) {
    ctx.serviceFailure = undefined
    ctx.stateSink.patchManifest(ctx.runId, { serviceFailure: undefined })
  }
  let pty: PtyHandle
  try {
    pty = ctx.ptyFactory({
      command: `LOG_MODE=plain ${svc.command}`,
      cwd: svc.cwd,
      env: { LOG_MODE: 'plain', ...(svc.env ?? {}) },
    })
  } catch (err) {
    const message = redactDiagnosticText(err instanceof Error ? err.message : String(err))
    try { fs.appendFileSync(logPath, `${message}\n`) } catch { /* best-effort; manifest still carries the spawn error */ }
    recordBootFailure(ctx, {
      service: svc.name,
      safeName: svc.safeName,
      reason: 'spawn-failed',
      detail: `Canary could not spawn the service process: ${message}`,
      ...bootEvidence(logPath),
      command: redactDiagnosticText(svc.command),
      cwd: svc.cwd,
      exitCode: null,
      signal: null,
      nextAction: 'Fix the service command, working directory, shell, or executable permissions, then restart the run.',
    }, `Service process could not spawn: ${svc.name}`)
    return
  }
  ctx.servicePtys.set(svc.name, pty)
  ctx.serviceExitEvidence.delete(svc.name)
  ctx.emit('service-started', { service: svc, pid: pty.pid })
  let stoppedForCompilerFailure = false

  pty.onData((chunk) => {
    try { fs.appendFileSync(logPath, chunk) } catch { /* ignore */ }
    ctx.emit('service-output', { service: svc, chunk })
    if (ctx.stopped || ctx.status === 'passed' || ctx.status === 'aborted' || ctx.servicePtys.get(svc.name) !== pty) return
    const result = readWatchCompilerFailure(ctx.serviceCompilerOutput.get(svc.name) ?? '', chunk)
    ctx.serviceCompilerOutput.set(svc.name, result.tail)
    if (!result.failed) return
    const detail = `Watch compiler reported a failed build for ${svc.name}.`
    if (ctx.serviceReady.has(svc.name)) {
      recordRuntimeServiceFailure(ctx, svc, 'compiler', detail)
    } else {
      recordBootFailure(ctx, {
        service: svc.name,
        safeName: svc.safeName,
        reason: 'compiler-failed',
        classification: 'compiler-failure',
        detail,
        ...bootEvidence(logPath),
        command: redactDiagnosticText(svc.command),
        cwd: svc.cwd,
        nextAction: COMPILER_FAILURE_NEXT_ACTION,
      }, `Compiler failed before readiness: ${svc.name}`)
    }
    if (ctx.executionType !== 'boot') {
      stoppedForCompilerFailure = true
      ctx.servicePtys.delete(svc.name)
      killTree(pty, 'SIGTERM')
      scheduleSigkillFallback(pty)
    }
  })
  pty.onExit(({ exitCode, signal }) => {
    const current = ctx.servicePtys.get(svc.name)
    // A failed watcher is removed immediately so healing can restart it. Its
    // later exit still closes the visible terminal unless a replacement owns it.
    if (current !== pty && !(stoppedForCompilerFailure && !current)) return
    const wasReady = ctx.serviceReady.has(svc.name)
    if (current === pty) ctx.servicePtys.delete(svc.name)
    ctx.serviceExitEvidence.set(svc.name, { exitCode, signal: signalName(signal) })
    ctx.emit('service-exit', { service: svc, exitCode, signal })
    if (wasReady) recordRuntimeServiceFailure(ctx, svc, 'process-exited',
      `Required service ${svc.name} exited after readiness (code ${exitCode}).`,
      { exitCode, signal: signalName(signal) })
  })
}

// Readiness probe — block until every spawned service is ready. Each
// service has *one* probe with one transport (`http` or `tcp`); we
// dispatch by transport. Services with no probe emit a loud warning and
// are skipped (Playwright still races the boot, but the user knows why).
export async function waitForHealth(ctx: RunContext): Promise<void> {
  if (ctx.services.length === 0) return
  await Promise.all(ctx.services.map((svc) => waitForServiceReady(ctx, svc)))
}

export async function waitForServiceReady(ctx: RunContext, svc: ServiceSpec): Promise<void> {
  const probe = svc.healthProbe
  if (!probe) {
    const envHint = ctx.env ? ` for env "${ctx.env}"` : ''
    const msg = `Service "${svc.name}" has no readiness probe${envHint}; Playwright may race the boot. Add healthCheck.http or healthCheck.tcp.`
    ctx.runnerLog?.warn(msg)
    ctx.emit('agent-output', { chunk: `\n[warning] ${msg}\n` })
    ctx.stateSink.setServiceStatus(ctx.runId, svc.safeName, 'ready')
    ctx.serviceReady.add(svc.name)
    ctx.emit('health-check', { service: svc, healthy: true })
    return
  }

  if ('http' in probe) {
    await pollUntilReady(ctx, svc, 'http', () => attemptHttp(ctx, probe.http))
    return
  }
  if ('tcp' in probe) {
    await pollUntilReady(ctx, svc, 'tcp', () => isTcpListening(
      coerceTcpPort(probe.tcp.port),
      probe.tcp.host ?? '127.0.0.1',
      probe.tcp.timeoutMs,
    ))
    return
  }
  // Exhaustiveness: TS proves this is unreachable; the validator already
  // rejects malformed shapes at config-load time.
  throw new Error(`Unknown probe shape for ${svc.name}: ${JSON.stringify(probe)}`)
}

/** One HTTP attempt — wraps the existing `isHealthy` so tests can stub it. */
export async function attemptHttp(ctx: RunContext, p: HttpProbe): Promise<boolean> {
  return ctx.healthCheck(p.url, p.timeoutMs)
}

/**
 * Poll a single async attempter until it returns true, or until the
 * probe-specific deadline elapses. The transport label is folded into
 * every emitted event and the timeout error so logs stay specific.
 */
export async function pollUntilReady(ctx: RunContext, 
  svc: ServiceSpec,
  transport: 'http' | 'tcp',
  attempt: () => Promise<boolean>,
): Promise<void> {
  const probe = svc.healthProbe!
  const deadlineMs = (transport === 'http'
    ? (probe as { http: HttpProbe }).http.deadlineMs
    : (probe as { tcp: TcpProbe }).tcp.deadlineMs) ?? ctx.healthDeadlineMs
  const deadline = Date.now() + deadlineMs

  // `health-timeout` unless we observe the process die first (below), in
  // which case there's no point polling a dead port until the deadline.
  let failureReason: RunBootFailure['reason'] = 'health-timeout'
  while (Date.now() < deadline) {
    if (ctx.stopped) return
    if (ctx.bootFailure || ctx.serviceFailure) return
    const ready = await attempt()
    if (ctx.stopped) return
    if (ctx.bootFailure || ctx.serviceFailure) return
    // The process may exit while an in-flight probe is returning green.
    // Its exit evidence belongs to this attempt (spawn clears older evidence).
    if (ready && !ctx.serviceExitEvidence.has(svc.name)) {
      ctx.serviceReady.add(svc.name)
      ctx.stateSink.setServiceStatus(ctx.runId, svc.safeName, 'ready')
      ctx.emit('health-check', { service: svc, healthy: true, transport })
      recordLifecycle(ctx, ctx.status === 'healing' ? 'agent-healing' : 'starting-services', `Health passed: ${svc.name}`, {
        detail: `${transport.toUpperCase()} readiness probe passed.`,
        severity: 'success',
      })
      return
    }
    // Fast-fail: the service process exited before it became healthy (e.g. a
    // crash or compile error). spawnService's onExit removed it from the pty
    // map, so a missing entry means the process is gone — fail now instead of
    // polling a dead port for the rest of the deadline.
    if (!ctx.servicePtys.has(svc.name) || ctx.serviceExitEvidence.has(svc.name)) {
      failureReason = 'process-exited'
      break
    }
    await ctx.delay(ctx.healthPollIntervalMs)
  }
  ctx.stateSink.setServiceStatus(ctx.runId, svc.safeName, 'timeout')
  ctx.emit('health-check', { service: svc, healthy: false, transport })
  const probeTarget = transport === 'http'
    ? `url=${(probe as { http: HttpProbe }).http.url}`
    : `port=${(probe as { tcp: TcpProbe }).tcp.port}`
  const detail = failureReason === 'process-exited'
    ? `Service process exited before ${transport.toUpperCase()} readiness (${probeTarget}).`
    : `Timed out waiting for ${transport.toUpperCase()} readiness (${probeTarget}).`
  // The failure record (reason + service log path) is written for EVERY
  // execution type — readers like the flight's boot-verify need the real
  // cause (crashed vs never-healthy) and the log to surface, not just a
  // `timeout` status. What differs below is only whether the run dies.
  const evidence = bootEvidence(ctx.paths.serviceLog(svc.safeName))
  const exit = ctx.serviceExitEvidence.get(svc.name)
  const classification = classifyBootEvidence({
    reason: failureReason,
    excerpt: evidence.excerpt,
    exitCode: exit?.exitCode,
    signal: exit?.signal,
  })
  ctx.bootFailure ??= {
    service: svc.name,
    safeName: svc.safeName,
    reason: failureReason,
    ...(classification ? { classification } : {}),
    detail,
    ...evidence,
    command: redactDiagnosticText(svc.command),
    cwd: svc.cwd,
    exitCode: exit?.exitCode ?? null,
    signal: exit?.signal ?? null,
    nextAction: readinessNextAction(failureReason, classification),
  }
  ctx.stateSink.patchManifest(ctx.runId, { bootFailure: ctx.bootFailure })
  // Boot-only sessions hold whatever came up. A service that fails its
  // readiness probe is marked `timeout` (red) and surfaced as a non-fatal
  // warning, but the session is NOT aborted — the user keeps the healthy
  // services up to exercise while they debug the failed one, and only
  // abort_run / Stop tears the session down.
  if (ctx.executionType === 'boot') {
    recordLifecycle(ctx, 'starting-services', `Health failed: ${svc.name} — kept up`, {
      detail: `${detail} Marked failed; boot session held — other services stay up. Stop with abort_run to tear down.`,
      severity: 'warning',
    })
    return
  }
  // Normal run: a missing service makes the Playwright suite meaningless, but
  // a broken service IS app code the heal agent can fix. The recorded failure
  // (first one wins) makes runFullCycle / the heal loops declare the run
  // `failed` and route it into heal with this service's log as context,
  // instead of throwing and aborting with no chance to repair.
  recordLifecycle(ctx, 'starting-services', `Service failed to start: ${svc.name}`, {
    detail: `${detail} The run will be marked failed; the heal agent should read the service log to fix why it won't serve.`,
    severity: 'error',
  })
}
