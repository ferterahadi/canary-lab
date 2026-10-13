import type { FastifyReply } from 'fastify'
import type { DeleteResult } from '../logic/run-cleanup'
import { notFound } from '../../../shared/http-error'

export function runCleanupFailure(reply: FastifyReply, result: Pick<DeleteResult, 'reason'>): { error: string } {
  if (result.reason === 'not-found') return notFound(reply, 'run')
  reply.code(409)
  return {
    error: result.reason === 'active'
      ? 'run is still active; abort it first'
      : 'run is still active; reap or abort first',
  }
}
