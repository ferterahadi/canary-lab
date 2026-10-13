import type { DiscoveryRepair } from '@shared/discovery-repair'
import { requestJson, defaultOpts, request } from './internal'
import type { AgentSessionResponse, AgentSessionAbsence } from './agent-sessions'

export type DiscoveryRepairView = DiscoveryRepair & { promptReady: boolean }

export function listDiscoveryRepairs(feature: string): Promise<DiscoveryRepairView[]> {
  return request(`/api/features/${encodeURIComponent(feature)}/discovery-repairs`, { method: 'GET' }, defaultOpts().fetchImpl)
}

export function startDiscoveryRepair(feature: string): Promise<DiscoveryRepairView> {
  return requestJson(`/api/features/${encodeURIComponent(feature)}/discovery-repairs`, 'POST', { kind: 'internal' })
}

export function getDiscoveryRepairAgentSession(id: string): Promise<AgentSessionResponse | AgentSessionAbsence> {
  return request(`/api/discovery-repairs/${encodeURIComponent(id)}/agent-session`, { method: 'GET' }, defaultOpts().fetchImpl)
}
