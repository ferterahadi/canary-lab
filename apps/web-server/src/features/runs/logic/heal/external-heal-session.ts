import type { ExternalHealSession } from '../../../../../../../shared/run-manifest'

export type ExternalHealMetadata = Pick<ExternalHealSession, 'sessionId' | 'clientKind' | 'clientVersion' | 'conversationName'>

export function projectExternalHealMetadata(
  input: ExternalHealMetadata,
  policy: 'nonempty' | 'defined',
): ExternalHealMetadata {
  const include = (value: string | undefined) => policy === 'defined' ? value !== undefined : Boolean(value)
  return {
    sessionId: input.sessionId,
    clientKind: input.clientKind,
    ...(include(input.clientVersion) ? { clientVersion: input.clientVersion } : {}),
    ...(include(input.conversationName) ? { conversationName: input.conversationName } : {}),
  }
}

export function createExternalHealSession(
  input: ExternalHealMetadata,
  at: string,
  metadataPolicy: 'nonempty' | 'defined',
): ExternalHealSession {
  return {
    ...projectExternalHealMetadata(input, metadataPolicy),
    claimedAt: at,
    lastHeartbeatAt: at,
    status: 'connected',
    cycleCount: 0,
  }
}
