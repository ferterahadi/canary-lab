import net from 'net'
import type { PortSlot } from '../../../../../../../shared/launcher/types'

export type { PortSlot }

/**
 * Per-run port allocation. Concurrent runs of the same app would otherwise
 * fight over a hardcoded port (e.g. both binding :4100). The allocator hands
 * each run a distinct free TCP port per declared port-slot, injects it as the
 * service's PORT env + a `${port.<slot>}` token, and releases it when the run
 * ends.
 *
 * Strategy: ask the OS for an ephemeral port (`listen(0)`), then immediately
 * close the probe socket and hand the port to the caller. There is an
 * unavoidable TOCTOU window between releasing the probe and the service
 * binding, so we also keep a process-local `reserved` set: two runs allocating
 * near-simultaneously never receive the same port, and the port stays reserved
 * until the run releases it.
 */

const reserved = new Set<number>()

/** Reserve and return a free TCP port on `host`. Throws if none is found. */
export async function findFreePort(host = '127.0.0.1'): Promise<number> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const port = await probeEphemeralPort(host)
    if (port == null) continue
    if (reserved.has(port)) continue
    reserved.add(port)
    return port
  }
  throw new Error('port-allocator: could not find a free TCP port after 100 attempts')
}

function probeEphemeralPort(host: string): Promise<number | null> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.unref()
    srv.once('error', () => {
      try { srv.close() } catch { /* ignore */ }
      resolve(null)
    })
    srv.listen(0, host, () => {
      const addr = srv.address()
      const port = addr && typeof addr === 'object' ? addr.port : null
      srv.close(() => resolve(port))
    })
  })
}

/** Release a previously-reserved port back to the pool. Idempotent. */
export function releasePort(port: number): void {
  reserved.delete(port)
}

/**
 * Allocate one distinct free port per slot. Duplicate slot names collapse to a
 * single port (a service can reference the same `${port.api}` in several
 * places). Returns a `name → port` map.
 */
export async function allocatePorts(
  slots: PortSlot[],
  host = '127.0.0.1',
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  for (const slot of slots) {
    if (out.has(slot.name)) continue
    out.set(slot.name, await findFreePort(host))
  }
  return out
}

/** Release every port in the iterable. Used on run teardown. */
export function releasePorts(ports: Iterable<number>): void {
  for (const port of ports) releasePort(port)
}
