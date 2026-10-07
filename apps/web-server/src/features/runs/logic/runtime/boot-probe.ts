import fs from 'fs'
import path from 'path'
import type { ServiceSpec } from './run-orchestrator-types'
import type { PtyFactory, PtyHandle } from './pty-spawner'
import { readinessProbe, waitForServiceReadiness } from './service-readiness'
import { readWatchCompilerFailure } from './watch-compiler-result'
import { redactDiagnosticText } from './diagnostic-redaction'
import { compressLogByTemplate } from './log-template'
// Services spawn children (`npx tsx`), so teardown kills the process GROUP or
// grandchildren survive and keep the port bound. The shared helper carries the
// pgid sanity guard (a pid ≤ 1 must never be negated into a broadcast kill).
import { killTree } from './run-spawn'

// Standalone adapter for port verification's two concurrent stacks. Service
// readiness shares the run engine; this adapter owns temporary processes and
// port/dependency diagnostics rather than persisted run lifecycle state.

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
  /** Where the FULL (untruncated) boot log for a service lives, when teed to
   *  disk. The diagnostic `evidence` in a boot failure is a 12-line slice; when
   *  this resolver is provided we append a pointer to the full log so the agent
   *  reading the failure can `Read` the complete output instead of guessing. */
  fullLogPathFor?: (safeName: string) => string | undefined
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
// Strip ANSI/cursor escapes and the `concurrently` `[N]` stream prefix, drop
// blank lines. Shared by the diagnostic snippet and the clean full-log writer.
function cleanBootLines(raw: string): string[] {
  return raw
    .replace(ANSI, '')
    .split('\n')
    .map((l) => l.replace(STREAM_PREFIX, '').trimEnd())
    .filter((l) => l.trim().length > 0)
}

// Write an ANSI-stripped, template-compressed copy of a raw boot log to
// `<name>.clean.log` and return its path. The raw teed log keeps PTY control
// codes (for xterm replay) and spams the same "waiting for X" line hundreds of
// times; the clean copy strips the codes and collapses repeated lines by
// template (`compressLogByTemplate`) — a losslessly cheaper read for the heal
// agent. Returns null if the raw log is missing/empty or the write fails (the
// caller falls back to the raw path).
export function writeCleanBootLog(rawLogPath: string): string | null {
  let raw: string
  try { raw = fs.readFileSync(rawLogPath, 'utf-8') } catch { return null }
  const lines = cleanBootLines(raw)
  if (lines.length === 0) return null
  const cleaned = compressLogByTemplate(lines.join('\n')).text
  const cleanPath = rawLogPath.endsWith('.log')
    ? `${rawLogPath.slice(0, -'.log'.length)}.clean.log`
    : `${rawLogPath}.clean.log`
  try {
    fs.writeFileSync(cleanPath, `${cleaned}\n`)
    return cleanPath
  } catch {
    return null
  }
}

export function diagnoseBootOutput(raw: string): { evidence?: string; kind: BootFailureKind } {
  const lines = cleanBootLines(raw)
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
  const ptys: PtyHandle[] = []
  const subscriptions: Array<{ dispose(): void }> = []
  const buffers = new Map<string, string>()
  let torndown = false
  let failure: BootProbeFail | undefined
  const teardown = (): void => {
    if (torndown) return
    torndown = true
    for (const subscription of subscriptions) subscription.dispose()
    for (const pty of ptys) killTree(pty, 'SIGTERM')
  }
  const fail = (svc: ServiceSpec, message: string): void => {
    if (failure || torndown) return
    const { evidence, kind } = diagnoseBootOutput(buffers.get(svc.safeName) ?? '')
    const rawLog = opts.fullLogPathFor?.(svc.safeName)
    const fullLog = rawLog ? (writeCleanBootLog(rawLog) ?? rawLog) : undefined
    failure = {
      ok: false, failedService: svc.name,
      ...(svc.healthProbe ? { transport: readinessProbe(svc.healthProbe, undefined, svc.name).transport } : {}),
      detail: message + (evidence ? `\nProcess output:\n${evidence}` : '')
        + (fullLog ? `\nFull boot log: ${fullLog}` : ''),
      kind, teardown,
    }
  }

  for (const svc of opts.specs) {
    if (failure) break
    try {
      const pty = opts.ptyFactory({
        command: `LOG_MODE=plain ${svc.command}`,
        cwd: svc.cwd,
        env: { LOG_MODE: 'plain', ...(svc.env ?? {}) },
      })
      ptys.push(pty)
      let compilerTail = ''
      subscriptions.push(pty.onData((chunk) => {
        const next = (buffers.get(svc.safeName) ?? '') + chunk
        buffers.set(svc.safeName, next.slice(-DIAG_BUFFER_CAP))
        if (opts.onOutput) {
          try { opts.onOutput(svc.safeName, chunk) } catch { /* best-effort tee; readiness still observes output */ }
        }
        const compiler = readWatchCompilerFailure(compilerTail, chunk)
        compilerTail = compiler.tail
        if (compiler.failed) fail(svc, `Watch compiler reported a failed build for ${svc.name}.`)
      }))
      subscriptions.push(pty.onExit(({ exitCode, signal }) => {
        fail(svc, `Service process exited during readiness (code ${exitCode}${signal == null ? '' : `, signal ${signal}`}).`)
      }))
    } catch (error) {
      fail(svc, `Canary could not spawn the service process: ${redactDiagnosticText(error instanceof Error ? error.message : String(error))}`)
      teardown()
      return failure!
    }
  }

  try {
    await Promise.all(opts.specs.map(async (svc) => {
      if (!svc.healthProbe) return // Preserve the existing no-probe policy.
      const probe = readinessProbe(svc.healthProbe, undefined, svc.name)
      const result = await waitForServiceReadiness({
        probe: svc.healthProbe,
        serviceName: svc.name,
        healthCheck: opts.healthCheck,
        pollIntervalMs: opts.healthPollIntervalMs,
        deadlineMs: opts.healthDeadlineMs,
        interruption: () => torndown ? { status: 'cancelled' } : failure ? { status: 'service-failed' } : null,
      })
      if (result.status === 'timed-out') {
        fail(svc, `Timed out waiting for ${probe.transport.toUpperCase()} readiness (${probe.target}).`)
      }
    }))
  } catch (error) {
    // Even an unexpected probe error must not strand a partially booted stack.
    teardown()
    throw error
  }
  return failure ?? { ok: true, teardown }
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
