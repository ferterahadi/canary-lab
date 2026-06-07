import fs from 'fs'
import path from 'path'
import type { ServiceSpec } from './orchestrator'
import type { PtyFactory, PtyHandle } from './pty-spawner'
import { isHealthy, isTcpListening } from './launcher/startup'

// Standalone "boot these services, wait for health, then tear down" primitive,
// lifted from RunOrchestrator's private spawn/health loop minus the run-state
// sink and event emission. Used by the port-ification verifier to boot a stack
// TWICE concurrently on two disjoint port maps and assert both come up — proof
// that ports are honored per-process and won't clash. The orchestrator keeps
// its own copy for now (this is additive); collapsing the two is a follow-up.

export interface BootProbeOk {
  ok: true
  teardown: () => void
}

export interface BootProbeFail {
  ok: false
  /** Service name that never became healthy (or crashed). */
  failedService: string
  transport?: 'http' | 'tcp'
  detail: string
  teardown: () => void
}

export type BootProbeResult = BootProbeOk | BootProbeFail

export interface BootProbeOptions {
  specs: ServiceSpec[]
  ptyFactory: PtyFactory
  /** HTTP health attempt — defaulted to the real poller; injectable for tests. */
  healthCheck?: (url: string, timeoutMs?: number) => Promise<boolean>
  healthPollIntervalMs?: number
  /** Fallback per-service deadline when a probe declares none. */
  healthDeadlineMs?: number
  /** Tee each service's output somewhere (e.g. a per-instance log file). */
  onOutput?: (safeName: string, chunk: string) => void
}

function killTree(pty: PtyHandle, signal: NodeJS.Signals = 'SIGTERM'): void {
  // Services spawn children (`npx tsx`), so kill the process GROUP or
  // grandchildren survive and keep the port bound. Fall back to the pty handle.
  try {
    process.kill(-pty.pid, signal)
    return
  } catch { /* fall through */ }
  try { pty.kill(signal) } catch { /* already dead */ }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Boot all `specs` and resolve once every service with a readiness probe
 * passes, or reject-shaped (ok:false) on the first that times out. Either way
 * the returned `teardown()` kills every spawned process group. The caller MUST
 * call teardown() in a finally block.
 */
export async function bootAndProbe(opts: BootProbeOptions): Promise<BootProbeResult> {
  const healthCheck = opts.healthCheck ?? isHealthy
  const pollInterval = opts.healthPollIntervalMs ?? 500
  const fallbackDeadline = opts.healthDeadlineMs ?? 60000
  const ptys: PtyHandle[] = []
  let torndown = false

  const teardown = (): void => {
    if (torndown) return
    torndown = true
    for (const pty of ptys) killTree(pty)
  }

  for (const svc of opts.specs) {
    const pty = opts.ptyFactory({
      command: `LOG_MODE=plain ${svc.command}`,
      cwd: svc.cwd,
      env: { LOG_MODE: 'plain', ...(svc.env ?? {}) },
    })
    ptys.push(pty)
    if (opts.onOutput) {
      pty.onData((chunk) => {
        try { opts.onOutput!(svc.safeName, chunk) } catch { /* ignore */ }
      })
    }
  }

  for (const svc of opts.specs) {
    const probe = svc.healthProbe
    if (!probe) continue // no probe → can't verify this one; skip (Playwright would race it too)

    const isHttp = 'http' in probe
    const transport: 'http' | 'tcp' = isHttp ? 'http' : 'tcp'
    const deadlineMs =
      (isHttp ? probe.http.deadlineMs : probe.tcp.deadlineMs) ?? fallbackDeadline
    const attempt = isHttp
      ? () => healthCheck(probe.http.url, probe.http.timeoutMs)
      : () => isTcpListening(probe.tcp.port, probe.tcp.host ?? '127.0.0.1', probe.tcp.timeoutMs)
    const detail = isHttp ? `url=${probe.http.url}` : `port=${probe.tcp.port}`

    const deadline = Date.now() + deadlineMs
    let ready = false
    while (Date.now() < deadline) {
      if (await attempt()) { ready = true; break }
      await delay(pollInterval)
    }
    if (!ready) {
      return {
        ok: false,
        failedService: svc.name,
        transport,
        detail: `Timed out waiting for ${transport.toUpperCase()} readiness (${detail}).`,
        teardown,
      }
    }
  }

  return { ok: true, teardown }
}

/** Convenience for callers that want per-instance log files under a dir. */
export function fileTee(verifyLogDir: string, instanceLabel: string): (safeName: string, chunk: string) => void {
  return (safeName, chunk) => {
    try {
      const file = path.join(verifyLogDir, `${instanceLabel}-${safeName}.log`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.appendFileSync(file, chunk)
    } catch { /* best-effort */ }
  }
}
