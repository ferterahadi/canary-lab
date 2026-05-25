import type { FastifyInstance } from 'fastify'
import fs from 'fs'
import { buildRunPaths, runDirFor } from '../lib/runtime/run-paths'
import {
  readJournal,
  filterSections,
  newestFirst,
  deleteIterationSection,
  type JournalSection,
} from '../lib/journal-store'

export interface JournalRouteDeps {
  logsDir: string
  /** Legacy root journal fallback for callers that do not select a run. */
  journalPath?: string
}

export async function journalRoutes(app: FastifyInstance, deps: JournalRouteDeps): Promise<void> {
  const runPathsFor = (runId: string) => buildRunPaths(runDirFor(deps.logsDir, runId))

  const resolveJournalPath = (runId?: string): string | null => {
    if (runId) {
      if (runId.includes('/') || runId.includes('\\') || runId.includes('..')) return null
      return runPathsFor(runId).diagnosisJournalPath
    }
    return deps.journalPath ?? null
  }

  const inferFeatureFromRunManifest = (runId: string): string | null => {
    try {
      const raw = JSON.parse(fs.readFileSync(runPathsFor(runId).manifestPath, 'utf-8')) as {
        feature?: unknown
        featureName?: unknown
      }
      if (typeof raw.feature === 'string') return raw.feature
      if (typeof raw.featureName === 'string') return raw.featureName
    } catch {
      /* no manifest or unreadable manifest */
    }
    return null
  }

  const inferRunLocalFields = (sections: JournalSection[], runId?: string): JournalSection[] => {
    if (!runId) return sections
    const feature = inferFeatureFromRunManifest(runId)
    return sections.map((section) => ({
      ...section,
      run: section.run ?? runId,
      feature: section.feature ?? feature,
    }))
  }

  app.get<{ Querystring: { feature?: string; run?: string } }>(
    '/api/journal',
    async (req) => {
      const journalPath = resolveJournalPath(req.query.run)
      if (!journalPath) return []
      const sections = inferRunLocalFields(readJournal(journalPath).sections, req.query.run)
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
