import type { FastifyInstance } from 'fastify'
import {
  readJournal,
  filterSections,
  newestFirst,
  deleteIterationSection,
} from '../lib/journal-store'

export interface JournalRouteDeps {
  journalPath: string
}

export async function journalRoutes(app: FastifyInstance, deps: JournalRouteDeps): Promise<void> {
  app.get<{ Querystring: { feature?: string; run?: string } }>(
    '/api/journal',
    async (req) => {
      const { sections } = readJournal(deps.journalPath)
      const filtered = filterSections(sections, {
        feature: req.query.feature,
        run: req.query.run,
      })
      return newestFirst(filtered)
    },
  )

  app.delete<{ Params: { iteration: string } }>(
    '/api/journal/:iteration',
    async (req, reply) => {
      const iter = parseInt(req.params.iteration, 10)
      if (!Number.isFinite(iter)) {
        reply.code(400)
        return { error: 'iteration must be an integer' }
      }
      const removed = deleteIterationSection(deps.journalPath, iter)
      if (!removed) {
        reply.code(404)
        return { error: 'iteration not found' }
      }
      reply.code(204)
      return ''
    },
  )
}
