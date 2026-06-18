import type { FastifyInstance } from 'fastify'
import {
  FeatureNotFoundError,
  clearPrdSummary,
  computeFeatureCoverage,
  featureExists,
  listFeatureDocs,
  regeneratePrdSummary,
} from '../lib/coverage/service'
import type { SummarizeAdapter } from '../lib/coverage/prd-summary'
import { CoverageJobRunStore, type CoverageJobStore } from '../lib/coverage/jobs/store'
import { startCoverageJob, CoverageJobConflictError } from '../lib/coverage/jobs/runner'
import type { CoverageJobKind } from '../lib/coverage/jobs/types'
import { writeFeatureDoc, deleteFeatureDoc } from '../lib/feature-authoring'
import { extractPrdDocument } from '../lib/prd-document-extractor'
import { loadFeatures } from '../lib/feature-loader'

export interface CoverageRouteDeps {
  featuresDir: string
  logsDir: string
  projectRoot: string
  /** Shared job store (so the WS layer + restart-reconcile see the same instance).
   *  Omitted in tests → a fresh file-backed store over logsDir. */
  coverageJobStore?: CoverageJobStore
}

// The Verified Coverage Ledger REST surface — the single computation layer the
// UI and the MCP tools both consume (dual-surface parity). Pure reads except the
// regenerate action, which re-summarizes the source docs (preserving ids).

export async function coverageRoutes(app: FastifyInstance, deps: CoverageRouteDeps): Promise<void> {
  const jobStore = deps.coverageJobStore ?? new CoverageJobRunStore(deps.logsDir)

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

  // Import a source doc from an uploaded file (.md/.txt/.pdf/.docx). The server
  // extracts text (reusing the PRD document extractor) and stores it as a `.md`
  // source doc — so the docs pipeline stays md-only while the picker accepts more.
  app.post<{ Params: { name: string }; Body: { filename?: string; contentType?: string; base64?: string } | undefined }>(
    '/api/features/:name/docs/import',
    async (req, reply) => {
      const { filename, contentType, base64 } = req.body ?? {}
      if (typeof filename !== 'string' || typeof base64 !== 'string') {
        reply.code(400)
        return { error: 'filename and base64 are required' }
      }
      let text: string
      try {
        const buffer = Buffer.from(base64, 'base64')
        const extracted = await extractPrdDocument({ filename, contentType, buffer })
        text = extracted.text
      } catch (err) {
        reply.code(400)
        return { error: err instanceof Error ? err.message : String(err) }
      }
      // Store under a sanitized .md slug (the pipeline is markdown-only).
      const base = filename.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'doc'
      const result = writeFeatureDoc(
        { projectRoot: deps.projectRoot, featuresDir: deps.featuresDir },
        { feature: req.params.name, relPath: `${base}.md`, content: text },
      )
      if (!result.ok) {
        reply.code(result.error.includes('not found') ? 404 : 400)
        return { error: result.error }
      }
      return { written: true, relativePath: result.relativePath }
    },
  )

  app.delete<{ Params: { name: string; relPath: string } }>(
    '/api/features/:name/docs/:relPath',
    async (req, reply) => {
      const result = deleteFeatureDoc(
        { projectRoot: deps.projectRoot, featuresDir: deps.featuresDir },
        { feature: req.params.name, relPath: decodeURIComponent(req.params.relPath) },
      )
      if (!result.ok) {
        reply.code(result.error.includes('not found') ? 404 : 400)
        return { error: result.error }
      }
      return { deleted: true, relativePath: result.relativePath }
    },
  )

  // Clear the generated PRD summary (+ coverage sidecars). Source docs untouched;
  // the feature returns to the ABSENT summary state.
  app.delete<{ Params: { name: string } }>('/api/features/:name/prd-summary', async (req, reply) => {
    try {
      return clearPrdSummary({ featuresDir: deps.featuresDir, feature: req.params.name })
    } catch (err) {
      if (err instanceof FeatureNotFoundError) {
        reply.code(404)
        return { error: err.message }
      }
      throw err
    }
  })

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

  // --- Async background jobs (R4): non-blocking summary/coverage generation
  // with a server-side single-flight guard. The dialog polls the job endpoints. ---

  app.get<{ Params: { name: string } }>('/api/features/:name/coverage/jobs', async (req) => {
    return jobStore.list().filter((j) => j.feature === req.params.name)
  })

  // All coverage jobs across features (newest-first) — feeds the status-bar pill's
  // generating-only visibility + active/recent task menu (R7).
  app.get('/api/coverage/jobs', async () => {
    return [...jobStore.list()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
  })

  // Per-feature coverage headline + axes — feeds the feature-column action's
  // state-aware icon (R8). Computed per feature; failures degrade to null.
  app.get('/api/coverage/states', async () => {
    const out: Array<{ feature: string; headline: string | null; summary: string | null; coverage: string | null; coveragePct: number | null }> = []
    for (const f of loadFeatures(deps.featuresDir)) {
      try {
        const ledger = computeFeatureCoverage({ featuresDir: deps.featuresDir, logsDir: deps.logsDir, feature: f.name })
        out.push({
          feature: f.name,
          headline: ledger.state?.headline ?? null,
          summary: ledger.state?.summary ?? null,
          coverage: ledger.state?.coverage ?? null,
          coveragePct: ledger.coveragePct,
        })
      } catch {
        out.push({ feature: f.name, headline: null, summary: null, coverage: null, coveragePct: null })
      }
    }
    return out
  })

  app.get<{ Params: { jobId: string } }>('/api/coverage/jobs/:jobId', async (req, reply) => {
    const manifest = jobStore.get(req.params.jobId)
    if (!manifest) {
      reply.code(404)
      return { error: 'job not found' }
    }
    return manifest
  })

  app.post<{ Params: { name: string }; Body: { kind?: CoverageJobKind; adapter?: SummarizeAdapter } | undefined }>(
    '/api/features/:name/coverage/jobs',
    async (req, reply) => {
      const kind = req.body?.kind
      if (kind !== 'summary' && kind !== 'coverage') {
        reply.code(400)
        return { error: "kind must be 'summary' or 'coverage'" }
      }
      if (!featureExists(deps.featuresDir, req.params.name)) {
        reply.code(404)
        return { error: `feature not found: ${req.params.name}` }
      }
      try {
        const { manifest } = startCoverageJob(
          {
            featuresDir: deps.featuresDir,
            logsDir: deps.logsDir,
            feature: req.params.name,
            kind,
            adapter: req.body?.adapter as never,
          },
          { store: jobStore },
        )
        reply.code(202)
        return manifest
      } catch (err) {
        if (err instanceof CoverageJobConflictError) {
          reply.code(409)
          return { error: err.message, existingJobId: err.existingJobId }
        }
        throw err
      }
    },
  )
}
