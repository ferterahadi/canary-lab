import type { ExternalHealSession } from '../../../../../../../shared/run-manifest'

type SessionMetadata = Pick<ExternalHealSession, 'sessionId' | 'clientKind' | 'clientVersion' | 'conversationName'>

export function createExternalHealSession(
  input: SessionMetadata,
  at: string,
  metadataPolicy: 'nonempty' | 'defined',
): ExternalHealSession {
  const include = (value: string | undefined) => metadataPolicy === 'defined' ? value !== undefined : Boolean(value)
  return {
    sessionId: input.sessionId,
    clientKind: input.clientKind,
    ...(include(input.clientVersion) ? { clientVersion: input.clientVersion } : {}),
    ...(include(input.conversationName) ? { conversationName: input.conversationName } : {}),
    claimedAt: at,
    lastHeartbeatAt: at,
    status: 'connected',
    cycleCount: 0,
  }
}
