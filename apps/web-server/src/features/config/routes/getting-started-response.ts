import type { FastifyReply } from 'fastify'
import type { GettingStartedBusyError } from '../logic/getting-started-session'

export function gettingStartedBusyReply(reply: Pick<FastifyReply, 'code'>, error: GettingStartedBusyError) {
  reply.code(409)
  return { type: error.type, error: error.message, active: error.active }
}
