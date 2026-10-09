import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import type { ApprovalStore } from './approval-store'

export function registerApprovalRoutes(app: FastifyInstance, store: ApprovalStore): void {
  app.get('/api/approvals', async () => store.list())
  app.post<{ Params: { id: string } }>('/api/approvals/:id/answer', async (request, reply) => {
    // JSON + same-origin checks reject cross-site browser submissions. This is
    // the local human surface, never an MCP tool for agents to approve work.
    let sameOrigin = false
    try {
      sameOrigin = new URL(request.headers.origin ?? '').origin === new URL(`${request.protocol}://${request.headers.host}`).origin
    } catch { /* malformed origins cannot authorize a browser decision */ }
    if (!sameOrigin || request.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: 'Answer approvals from the Canary browser page.' })
    }
    const parsed = z.object({ answer: z.record(z.string(), z.unknown()) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid approval answer' })
    return store.answer(request.params.id, parsed.data.answer)
  })
}
