import type { FastifyInstance } from 'fastify'
import {
  FeatureNotFoundError,
  computeFeatureCoverage,
  listFeatureDocs,
  regeneratePrdSummary,
} from '../lib/coverage/service'
import type { SummarizeAdapter } from '../lib/coverage/prd-summary'
import { writeFeatureDoc } from '../lib/feature-authoring'

export interface CoverageRouteDeps {
  featuresDir: string
  logsDir: string
  projectRoot: string
}

// The Verified Coverage Ledger REST surface — the single computation layer the
// UI and the MCP tools both consume (dual-surface parity). Pure reads except the
// regenerate action, which re-summarizes the source docs (preserving ids).

export async function coverageRoutes(app: FastifyInstance, deps: CoverageRouteDeps): Promise<void> {
  app.get<{ Params: { name: string } }>('/api/features/:name/coverage', async (req, reply) => {
    try {
      return computeFeatureCoverage({
        featuresDir: deps.featuresDir,
        logsDir: deps.logsDir,
        feature: req.params.name,
      })
    } catch (err) {
      if (err instanceof FeatureNotFoundError) {
        reply.code(404)
        return { error: err.message }
      }
      throw err
    }
  })

  app.get<{ Params: { name: string } }>('/api/features/:name/docs', async (req, reply) => {
    try {
      return listFeatureDocs(deps.featuresDir, req.params.name)
    } catch (err) {
      if (err instanceof FeatureNotFoundError) {
        reply.code(404)
        return { error: err.message }
      }
      throw err
    }
  })

  // Add/replace a source doc — the UI Docs-tab "add doc" action. The MCP
  // equivalent is `write_feature_doc` (same lib), so both surfaces can add docs.
  app.post<{ Params: { name: string }; Body: { relPath?: string; content?: string } | undefined }>(
    '/api/features/:name/docs',
    async (req, reply) => {
      const relPath = req.body?.relPath
      const content = req.body?.content
      if (typeof relPath !== 'string' || typeof content !== 'string') {
        reply.code(400)
        return { error: 'relPath and content are required' }
      }
      const result = writeFeatureDoc(
        { projectRoot: deps.projectRoot, featuresDir: deps.featuresDir },
        { feature: req.params.name, relPath, content },
      )
      if (!result.ok) {
        reply.code(result.error.includes('not found') ? 404 : 400)
        return { error: result.error }
      }
      return { written: true, relativePath: result.relativePath }
    },
  )

  app.post<{ Params: { name: string }; Body: { adapter?: SummarizeAdapter } | undefined }>(
    '/api/features/:name/prd-summary/regenerate',
    async (req, reply) => {
      try {
        const result = await regeneratePrdSummary({
          featuresDir: deps.featuresDir,
          feature: req.params.name,
          adapter: req.body?.adapter,
        })
        return result
      } catch (err) {
        if (err instanceof FeatureNotFoundError) {
          reply.code(404)
          return { error: err.message }
        }
        throw err
      }
    },
  )
}
