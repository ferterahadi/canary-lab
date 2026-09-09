import type { ClientKind } from './run-mode'

export type DiscoveryRepairOwner =
  | { kind: 'internal'; agent: 'claude' | 'codex' }
  | { kind: 'external'; sessionId: string; clientKind: ClientKind; conversationName?: string; sessionUrl?: string }

export interface DiscoveryRepair {
  id: string
  feature: string
  featureDir: string
  status: 'repairing' | 'verifying' | 'succeeded' | 'failed'
  owner: DiscoveryRepairOwner
  createdAt: string
  updatedAt: string
  endedAt?: string
  heartbeatAt: string
  message: string
  diagnostic: string
  log: string[]
  promptPath: string
  sessionRef?: { agent: 'claude' | 'codex'; sessionId: string }
  discoveredCount?: number
}

export function discoveryRepairActive(repair: Pick<DiscoveryRepair, 'status'>): boolean {
  return repair.status === 'repairing' || repair.status === 'verifying'
}
