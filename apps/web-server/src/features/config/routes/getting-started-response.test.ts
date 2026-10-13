import Fastify from 'fastify'
import { expect, it } from 'vitest'
import { GettingStartedBusyError } from '../logic/getting-started-session'
import { gettingStartedBusyReply } from './getting-started-response'

it('returns the exact HTTP conflict without copying the active session', async () => {
  const active = {
    sessionId: 'busy', workflow: 'run' as const, owner: 'external' as const,
    target: { kind: 'run' as const, id: 'existing' }, startedAt: 'start', updatedAt: 'update',
  }
  const error = new GettingStartedBusyError(active)
  const app = Fastify()
  app.get('/', (_request, reply) => {
    const payload = gettingStartedBusyReply(reply, error)
    expect(payload.active).toBe(active)
    return payload
  })
  try {
    const response = await app.inject('/')
    expect(response.statusCode).toBe(409)
    expect(response.json()).toEqual({
      type: 'getting_started_busy',
      error: 'Getting Started is already running run from external.',
      active,
    })
  } finally { await app.close() }
})
