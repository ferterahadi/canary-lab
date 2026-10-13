import { randomUUID } from 'crypto'
import type { RunHeartbeatOwner, RunManifest } from '../../../../../../../shared/run-manifest'
import { isStaleHeartbeat } from '../../../../../../../shared/run-state'

/** Who drives a persisted unsettled run that this server has not registered.
 *  - `this-server` — this instance wrote the heartbeat; its scheduler or
 *    registry holds the run (a queued row lives only in the admission queue).
 *  - `other-live-server` — another live process still drives it.
 *  - `gone` — nobody does: the owner exited, or the heartbeat went stale. */
export type RunOwnership = 'this-server' | 'other-live-server' | 'gone'

export function newHeartbeatOwner(): RunHeartbeatOwner {
  return { pid: process.pid, instanceId: randomUUID() }
}

/**
 * Freshness alone cannot answer this. A server restarted inside the ten-minute
 * staleness window found its previous run still beating "recently", took it for
 * a second live server's, and left it healing with no runner, no services and a
 * Stop button that 404'd. The owner stamp is the evidence freshness lacked; a
 * record without one keeps the old freshness rule, which is all it can support.
 */
export function judgeRunOwnership(
  manifest: Pick<RunManifest, 'heartbeatAt' | 'heartbeatOwner'>,
  self: RunHeartbeatOwner,
  nowMs: number,
  isAlive: (pid: number) => boolean,
): RunOwnership {
  const { heartbeatAt, heartbeatOwner: owner } = manifest
  if (!heartbeatAt || isStaleHeartbeat(heartbeatAt, nowMs)) return 'gone'
  if (!owner) return 'other-live-server'
  if (owner.instanceId === self.instanceId) return 'this-server'
  // Our own pid under another instance id is this server's previous life.
  if (owner.pid === self.pid || !isAlive(owner.pid)) return 'gone'
  return 'other-live-server'
}
