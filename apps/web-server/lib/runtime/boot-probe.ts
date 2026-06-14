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

// Why a boot never became ready, inferred from the process's own output:
//  - 'dependency'    — the app crashed reaching a downstream (DB/queue/host
//                      unreachable). NOT fixable by editing port code; the
//                      stack simply can't boot in this environment right now.
//  - 'port-conflict' — a listener hit EADDRINUSE. Genuinely port-related.
//  - 'unknown'       — timed out with no recognizable crash (e.g. slow start).
export type BootFailureKind = 'dependency' | 'port-conflict' | 'unknown'

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
  /** Classification of the failure, inferred from the service's output. */
  kind: BootFailureKind
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

// Most recent bytes of a service's output to keep for crash diagnosis — bounded
// so a chatty stack can't grow this without limit.
const DIAG_BUFFER_CAP = 16_384
const DIAG_EVIDENCE_LINES = 12

// ANSI colour/cursor escapes, and the `concurrently` `[3]` stream prefix —
// stripped so identical lines from interleaved processes dedupe cleanly.
const ANSI = /\[[0-9;?]*[A-Za-z]/g
const STREAM_PREFIX = /^\s*\[\d+\]\s?/

// A downstream/dependency failure (DB, queue, host) is an ENVIRONMENT problem,
// not a port problem — editing port code won't fix it.
const DEPENDENCY_MARKERS = [
  /Init-Failed/i,
  /can'?t reach .*(database|server)/i,
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /getaddrinfo/i,
  /connection refused/i,
  /database server/i,
  /MongoNetworkError/i,
]
const PORT_CONFLICT_MARKERS = [/EADDRINUSE/i, /address already in use/i]

/**
 * Inspect a service's captured stdout/stderr and pull out WHY it never became
 * ready: a human- and agent-readable evidence snippet plus a classification.
 * Returns `{ kind: 'unknown' }` (no evidence) for empty output.
 */
export function diagnoseBootOutput(raw: string): { evidence?: string; kind: BootFailureKind } {
  const lines = raw
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.replace(STREAM_PREFIX, '').trimEnd())
    .filter((l) => l.trim().length > 0)
  if (lines.length === 0) return { kind: 'unknown' }

  const pick = (markers: RegExp[]): string[] => {
    const hits: string[] = []
    for (const l of lines) {
      if (markers.some((m) => m.test(l)) && !hits.includes(l)) hits.push(l)
    }
    return hits
  }

  const portHits = pick(PORT_CONFLICT_MARKERS)
  if (portHits.length > 0) return { evidence: portHits.slice(0, DIAG_EVIDENCE_LINES).join('\n'), kind: 'port-conflict' }

  const depHits = pick(DEPENDENCY_MARKERS)
  if (depHits.length > 0) return { evidence: depHits.slice(0, DIAG_EVIDENCE_LINES).join('\n'), kind: 'dependency' }

  // No recognized crash — show the tail so the user still has something to act on.
  return { evidence: lines.slice(-DIAG_EVIDENCE_LINES).join('\n'), kind: 'unknown' }
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
  // Tail of each service's output, kept so a timeout can report WHY it failed
  // (e.g. a crash on an unreachable dependency) rather than just "timed out".
  const buffers = new Map<string, string>()

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
    // Always capture for diagnostics; tee to the caller's sink too if provided.
    pty.onData((chunk) => {
      const next = (buffers.get(svc.safeName) ?? '') + chunk
      buffers.set(svc.safeName, next.length > DIAG_BUFFER_CAP ? next.slice(-DIAG_BUFFER_CAP) : next)
      if (opts.onOutput) {
        try { opts.onOutput(svc.safeName, chunk) } catch { /* ignore */ }
      }
    })
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
      const { evidence, kind } = diagnoseBootOutput(buffers.get(svc.safeName) ?? '')
      return {
        ok: false,
        failedService: svc.name,
        transport,
        detail:
          `Timed out waiting for ${transport.toUpperCase()} readiness (${detail}).` +
          (evidence ? `\nProcess output:\n${evidence}` : ''),
        kind,
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
