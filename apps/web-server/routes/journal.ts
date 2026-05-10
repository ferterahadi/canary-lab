import type { FastifyInstance } from 'fastify'
import { buildRunPaths, runDirFor } from '../lib/runtime/run-paths'
import {
  readJournal,
  filterSections,
  newestFirst,
  deleteIterationSection,
} from '../lib/journal-store'

export interface JournalRouteDeps {
  logsDir: string
  /** Legacy root journal fallback for callers that do not select a run. */
  journalPath?: string
}

export async function journalRoutes(app: FastifyInstance, deps: JournalRouteDeps): Promise<void> {
  const resolveJournalPath = (runId?: string): string | null => {
    if (runId) {
      if (runId.includes('/') || runId.includes('\\') || runId.includes('..')) return null
      return buildRunPaths(runDirFor(deps.logsDir, runId)).diagnosisJournalPath
    }
    return deps.journalPath ?? null
  }

  app.get<{ Querystring: { feature?: string; run?: string } }>(
    '/api/journal',
    async (req) => {
      const journalPath = resolveJournalPath(req.query.run)
      if (!journalPath) return []
      const { sections } = readJournal(journalPath)
      let filtered = filterSections(sections, {
        feature: req.query.feature,
        run: req.query.run,
      })
      if (filtered.length === 0 && req.query.run && deps.journalPath) {
        const legacy = readJournal(deps.journalPath)
        filtered = filterSections(legacy.sections, {
          feature: req.query.feature,
          run: req.query.run,
        })
      }
      return newestFirst(filtered)
    },
  )

  app.delete<{ Params: { iteration: string }; Querystring: { run?: string } }>(
    '/api/journal/:iteration',
    async (req, reply) => {
      const iter = parseInt(req.params.iteration, 10)
      if (!Number.isFinite(iter)) {
        reply.code(400)
        return { error: 'iteration must be an integer' }
      }
      const journalPath = resolveJournalPath(req.query.run)
      if (!journalPath) {
        reply.code(400)
        return { error: 'run is required' }
      }
      let removed = deleteIterationSection(journalPath, iter)
      if (!removed && req.query.run && deps.journalPath) {
        const legacy = readJournal(deps.journalPath)
        const matchingLegacyEntry = filterSections(legacy.sections, { run: req.query.run })
          .some((section) => section.iteration === iter)
        if (matchingLegacyEntry) {
          removed = deleteIterationSection(deps.journalPath, iter)
        }
      }
      if (!removed) {
        reply.code(404)
        return { error: 'iteration not found' }
      }
      reply.code(204)
      return ''
    },
  )
}
