import type { HealthProbe } from '../../../../../../../shared/launcher/types'
import { coerceTcpPort, isHealthy, isTcpListening } from '../../../../shared/launcher-startup'

export const DEFAULT_HEALTH_POLL_MS = 1000
export const DEFAULT_HEALTH_DEADLINE_MS = 60_000

export type ReadinessInterruption = { status: 'cancelled' } | { status: 'service-failed' }
export type ReadinessResult = { status: 'ready' } | { status: 'timed-out' } | ReadinessInterruption

export function readinessProbe(probe: HealthProbe, healthCheck = isHealthy) {
  return 'http' in probe
    ? { transport: 'http' as const, target: `url=${probe.http.url}`, deadlineMs: probe.http.deadlineMs,
      attempt: () => healthCheck(probe.http.url, probe.http.timeoutMs) }
    : { transport: 'tcp' as const, target: `port=${probe.tcp.port}`, deadlineMs: probe.tcp.deadlineMs,
      attempt: () => isTcpListening(coerceTcpPort(probe.tcp.port), probe.tcp.host ?? '127.0.0.1', probe.tcp.timeoutMs) }
}

interface ReadinessOptions {
  probe: HealthProbe
  healthCheck?: typeof isHealthy
  /** Allows the run adapter's existing injectable attempt contract. */
  attempt?: () => Promise<boolean>
  pollIntervalMs?: number
  deadlineMs?: number
  interruption: () => ReadinessInterruption | null
  now?: () => number
  delay?: (ms: number) => Promise<void>
}

/** Readiness is only valid while the owning process is healthy. Rechecking
 * after an awaited probe prevents a late green response from hiding an exit. */
export async function waitForServiceReadiness(options: ReadinessOptions): Promise<ReadinessResult> {
  const probe = readinessProbe(options.probe, options.healthCheck)
  const attempt = options.attempt ?? probe.attempt
  const now = options.now ?? Date.now
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + (probe.deadlineMs ?? options.deadlineMs ?? DEFAULT_HEALTH_DEADLINE_MS)
  const cap = Math.max(1, options.pollIntervalMs ?? DEFAULT_HEALTH_POLL_MS)
  let interval = Math.min(100, cap)
  while (now() < deadline) {
    const before = options.interruption()
    if (before) return before
    const ready = await attempt()
    const after = options.interruption()
    if (after) return after
    if (ready) return { status: 'ready' }
    const remaining = deadline - now()
    if (remaining <= 0) break
    await delay(Math.min(interval, remaining))
    interval = Math.min(interval * 2, cap)
  }
  return options.interruption() ?? { status: 'timed-out' }
}
