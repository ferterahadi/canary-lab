import { compareActiveRuns } from '../logic/active-run-order'
import path from 'path'
import type { RunDetail } from '../../../../../../shared/run-detail'
import type { RunStore } from '../logic/run-store'
import type { ClientKind } from '../../../../../../shared/run-mode'

export interface ExternalHealAgentRequest {
  kind: 'external'
  sessionId: string
  clientKind: ClientKind
  clientVersion?: string
  conversationName?: string
  /** Whether this external client may *own* the heal loop (Desktop-only per
   *  heal-claim-policy). Defaults to true. When false, the run still uses
   *  External-client heal mode (external origin), but gets no externalHealSession
   *  and no broker claim — it waits for a Desktop/UI drive instead. */
  claimable?: boolean
}

export function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.webm') return 'video/webm'
  if (ext === '.mp4') return 'video/mp4'
  if (ext === '.zip') return 'application/zip'
  return 'application/octet-stream'
}

export const EXTERNAL_CLIENT_KINDS: ExternalHealAgentRequest['clientKind'][] = [
  'claude',
  'codex',
  'claude-pty',
  'codex-pty',
  'other',
]

export function parseExternalHealAgent(
  value: unknown,
): ExternalHealAgentRequest | { error: string } | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') return { error: 'healAgent must be an object' }
  const v = value as Record<string, unknown>
  if (v.kind === undefined) return null
  // v1 only wires up the external kind via this body field; the existing
  // project-config healAgent setting remains the source of truth for
  // 'auto' / 'claude' / 'codex' / 'manual'. The body override is *only* the
  // hook for external MCP clients to register themselves at run start.
  if (v.kind !== 'external') {
    return { error: 'healAgent.kind must be "external" when overriding from the request body' }
  }
  if (typeof v.sessionId !== 'string' || !v.sessionId) {
    return { error: 'healAgent.sessionId is required when kind="external"' }
  }
  if (typeof v.clientKind !== 'string' || !(EXTERNAL_CLIENT_KINDS as string[]).includes(v.clientKind)) {
    return { error: `healAgent.clientKind must be one of: ${EXTERNAL_CLIENT_KINDS.join(', ')}` }
  }
  return {
    kind: 'external',
    sessionId: v.sessionId,
    clientKind: v.clientKind as ExternalHealAgentRequest['clientKind'],
    ...(typeof v.clientVersion === 'string' ? { clientVersion: v.clientVersion } : {}),
    ...(typeof v.conversationName === 'string' ? { conversationName: v.conversationName } : {}),
    // Only an explicit false is honored, and only ever to DOWNGRADE: a caller
    // can decline the claim it would have been allowed (the flight's run stage
    // starts external-heal runs unclaimed so the REAL client's claim_heal is
    // not blocked by a synthetic holder), but can never claim past the policy.
    ...(v.claimable === false ? { claimable: false } : {}),
  }
}

export function findActiveRunForFeature(
  store: RunStore,
  feature: string,
  env: string | undefined,
): RunDetail | null {
  const candidates: Array<{ detail: RunDetail; startedAt: string }> = []
  for (const entry of store.list({ feature })) {
    if (entry.status !== 'healing') continue
    const detail = store.get(entry.runId)
    if (!detail) continue
    if (env && detail.manifest.env !== env) continue
    candidates.push({ detail, startedAt: entry.startedAt })
  }
  candidates.sort(compareActiveRuns)
  return candidates[0]?.detail ?? null
}
