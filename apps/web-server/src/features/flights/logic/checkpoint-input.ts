import { createHmac, randomBytes, timingSafeEqual } from 'crypto'
import type { FlightManifest } from './types'

const key = randomBytes(32)
const TTL_MS = 30 * 60 * 1000

function signature(manifest: FlightManifest, expires: string): string {
  const stage = manifest.stages.find((s) => s.status === 'waiting-for-approval')
  return createHmac('sha256', key).update(JSON.stringify([manifest.flightId, manifest.updatedAt, stage?.key, stage?.checkpoint, expires])).digest('hex')
}

/** A URL-mode invitation grants one human checkpoint response, never a
 * takeover, pause, or agent-work submission. Restart or a changed checkpoint
 * invalidates it. Secrets entered on that page never traverse MCP. */
export function issueCheckpointInput(manifest: FlightManifest): string {
  const expires = String(Date.now() + TTL_MS)
  return `${expires}.${signature(manifest, expires)}`
}

export function allowsCheckpointInput(token: unknown, manifest: FlightManifest | null): boolean {
  if (typeof token !== 'string' || !manifest || manifest.status !== 'waiting-for-approval') return false
  const cp = manifest.stages.find((s) => s.status === 'waiting-for-approval')?.checkpoint
  if (!cp || cp.kind === 'external-work') return false
  const [expires, mac, extra] = token.split('.')
  if (!expires || !mac || extra !== undefined || !/^\d+$/.test(expires) || !/^[a-f0-9]{64}$/.test(mac) || Number(expires) <= Date.now()) return false
  return timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(signature(manifest, expires), 'hex'))
}
