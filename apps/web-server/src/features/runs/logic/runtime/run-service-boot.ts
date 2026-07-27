import { recordLifecycle } from './run-manifest-writer'
import type { ServiceSpec } from './orchestrator'
// Bringing a run's services up: one pty per service spec, the log tee, and the
// health poll that decides whether the suite can run at all. A failed probe
// records a boot failure on the context rather than throwing, because the run
// loop routes that into heal instead of aborting. Split out of orchestrator.ts;
// the bodies are unchanged.
import { type RunContext } from './run-context'
import fs from 'fs'
import path from 'path'
import type { HttpProbe, TcpProbe } from '../../../../../../../shared/launcher/types'
import { coerceTcpPort, isHealthy, isTcpListening } from '../../../../shared/launcher-startup'
import { type RunBootFailure } from './manifest'

export async function ensureServicesRunning(ctx: RunContext): Promise<string[]> {
  // Fresh boot attempt — drop any health failure recorded by a prior cycle so
  // a service that comes up cleanly this time clears the failed state.
  ctx.bootFailure = undefined
  const toStart = ctx.services.filter((svc) => !ctx.servicePtys.has(svc.name))
  for (const svc of toStart) {
    ctx.stateSink.setServiceStatus(ctx.runId, svc.safeName, 'starting')
    spawnService(ctx, svc)
  }
  if (ctx.services.length > 0) await waitForHealth(ctx)
  return toStart.map((svc) => svc.safeName)
}

// Per-run allocated ports exposed to the Playwright process as
// CANARY_PORT_<slot> so tests can resolve the dynamic target. Empty when the
// feature declares no port slots (remote runs keep their static envset URL).
export function testPortEnv(ctx: RunContext): Record<string, string> {
  const out: Record<string, string> = {}
  if (ctx.portMap) {
    for (const [slot, port] of ctx.portMap) out[`CANARY_PORT_${slot}`] = String(port)
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
  const pty = ctx.ptyFactory({
    command: `LOG_MODE=plain ${svc.command}`,
    cwd: svc.cwd,
    env: { LOG_MODE: 'plain', ...(svc.env ?? {}) },
  })
  ctx.servicePtys.set(svc.name, pty)
  ctx.emit('service-started', { service: svc, pid: pty.pid })

  pty.onData((chunk) => {
    try { fs.appendFileSync(logPath, chunk) } catch { /* ignore */ }
    ctx.emit('service-output', { service: svc, chunk })
  })
  pty.onExit(({ exitCode, signal }) => {
    if (ctx.servicePtys.get(svc.name) !== pty) return
    ctx.servicePtys.delete(svc.name)
    ctx.emit('service-exit', { service: svc, exitCode, signal })
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
    const ready = await attempt()
    if (ctx.stopped) return
    if (ready) {
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
    if (!ctx.servicePtys.has(svc.name)) {
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
  ctx.bootFailure ??= {
    service: svc.name,
    safeName: svc.safeName,
    reason: failureReason,
    detail,
    logPath: ctx.paths.serviceLog(svc.safeName),
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
