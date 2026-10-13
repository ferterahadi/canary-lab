import { expect, it } from 'vitest'
import { createExternalHealSession, projectExternalHealMetadata } from './external-heal-session'

it.each(['defined', 'nonempty'] as const)('constructs a fresh session using caller time (%s)', (policy) => {
  const input = { sessionId: 'session', clientKind: 'codex' as const, clientVersion: '1', conversationName: 'repair' }
  expect(createExternalHealSession(input, 'time', policy)).toEqual({ ...input, claimedAt: 'time', lastHeartbeatAt: 'time', status: 'connected', cycleCount: 0 })
  expect(input).toEqual({ sessionId: 'session', clientKind: 'codex', clientVersion: '1', conversationName: 'repair' })
})
it.each(['defined', 'nonempty'] as const)('omits absent metadata (%s)', (policy) => {
  expect(createExternalHealSession({ sessionId: 'session', clientKind: 'claude' }, 'time', policy)).toEqual({ sessionId: 'session', clientKind: 'claude', claimedAt: 'time', lastHeartbeatAt: 'time', status: 'connected', cycleCount: 0 })
})
it('retains defined empty metadata for broker claims, while startup and restart omit it', () => {
  const input = { sessionId: 'session', clientKind: 'claude' as const, clientVersion: '', conversationName: '' }
  const broker = createExternalHealSession(input, 'time', 'defined')
  const launch = createExternalHealSession(input, 'time', 'nonempty')
  expect(broker).toMatchObject({ clientVersion: '', conversationName: '' })
  expect(launch).not.toHaveProperty('clientVersion')
  expect(launch).not.toHaveProperty('conversationName')
  expect(createExternalHealSession({ ...input, conversationName: ' ' }, 'time', 'nonempty')).toHaveProperty('conversationName', ' ')
})


it.each(['defined', 'nonempty'] as const)('projects only claim metadata without mutating the input (%s)', (policy) => {
  for (const value of [undefined, '', ' ', 'value']) {
    const input = Object.freeze({ sessionId: 'session', clientKind: 'codex' as const, clientVersion: value, conversationName: value, claimable: false, status: 'disconnected' })
    const result = projectExternalHealMetadata(input, policy)
    const include = policy === 'defined' ? value !== undefined : Boolean(value)
    expect(result).toEqual({ sessionId: 'session', clientKind: 'codex', ...(include ? { clientVersion: value, conversationName: value } : {}) })
    expect(result).not.toBe(input)
    expect(input).toEqual({ sessionId: 'session', clientKind: 'codex', clientVersion: value, conversationName: value, claimable: false, status: 'disconnected' })
  }
})
