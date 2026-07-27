import path from 'path'
import type { RunDetail } from '../logic/run-store'
import type { RunStore } from '../logic/run-store'
import { loadFeatures } from '../../../shared/feature-loader'
import type { ClientKind } from '../../../../../../shared/run-mode'
import { getGitRoot, resolveRepoPath } from '../../../shared/git-repo'

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

// Distinct git toplevels for every repo declared by a feature — the source
// repos whose `git worktree list` we scan for canary-lab worktrees.
export async function featureRepoRoots(featuresDir: string): Promise<string[]> {
  const roots = new Set<string>()
  for (const feature of loadFeatures(featuresDir)) {
    for (const repo of feature.repos ?? []) {
      try {
        const root = await getGitRoot(resolveRepoPath(repo.localPath))
        if (root) roots.add(root)
      } catch { /* skip repos that aren't resolvable */ }
    }
  }
  return [...roots]
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

/** Orders active-run candidates: lower `activeRunPriority` first, then newest
 *  `startedAt` first. Exported for direct unit testing — in the route the input
 *  always arrives pre-sorted newest-first, so the `startedAt > 0` arm is only
 *  reachable by feeding an unsorted list here. */
export function compareActiveRuns(
  a: { detail: RunDetail; startedAt: string },
  b: { detail: RunDetail; startedAt: string },
): number {
  const priorityDiff = activeRunPriority(a.detail) - activeRunPriority(b.detail)
  if (priorityDiff !== 0) return priorityDiff
  return a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0
}

export function activeRunPriority(detail: RunDetail): number {
  if (detail.manifest.lifecycle?.phase === 'waiting-for-signal') return 0
  if (detail.manifest.status === 'healing') return 1
  return 2
}
