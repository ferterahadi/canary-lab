import type { ExternalSessionMeta } from '../../../../../../shared/run-mode'
import type { FlightManifest } from './types'

/** Resolve the identity passed into standalone external workflows. New
 *  MCP-driven Flights carry the real conversation metadata. Old records fall
 *  back to their Flight id so ownership stays stable without pretending that
 *  the synthetic id can resume a client. */
export function externalAgentSessionForFlight(manifest: FlightManifest): ExternalSessionMeta {
  const session = manifest.externalAgentSession
  return {
    clientKind: session?.clientKind ?? 'other',
    sessionId: session?.sessionId ?? `flight:${manifest.flightId}`,
    ...(session?.conversationName ? { conversationName: session.conversationName } : {}),
    ...(session?.sessionUrl ? { sessionUrl: session.sessionUrl } : {}),
  }
}
