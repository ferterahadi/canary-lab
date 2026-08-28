import type { FastifyInstance } from 'fastify'
import {
  FeatureNotFoundError,
  clearPrdSummary,
  computeFeatureCoverage,
  featureExists,
  listFeatureDocs,
  regeneratePrdSummary,
} from '../logic/coverage/service'
import type { SummarizeAdapter } from '../logic/coverage/prd-summary'
import { coverageJobStore, type CoverageJobStore } from '../logic/coverage/jobs/store'
import { startCoverageJob, CoverageJobConflictError } from '../logic/coverage/jobs/runner'
import type { CoverageJobKind } from '../logic/coverage/jobs/types'
import { readPrdSummary } from '../logic/coverage/prd-summary'
import { deriveCoverageStateView } from '../logic/coverage/state'
import { readCoverageRunState } from '../logic/coverage/run-state'
import { readDocsCollection } from '../logic/coverage/docs-collection'
import { writeFeatureDoc, deleteFeatureDoc, linkFeatureDoc, type FeatureAuthoringContext } from '../../config/logic/feature-authoring'
import { reopenStages } from '../../flights/logic/conductor'
import type { FlightStore } from '../../flights/logic/store'
import { extractPrdDocument } from '../logic/prd-document-extractor'
import { loadFeatures } from '../../../shared/feature-loader'
import {
  findClaudeLogBySessionId,
  buildAgentSessionResponse,
  locateCodexSessionLog,
  type AgentSessionRef,
} from '../../agent-sessions/logic/agent-session-log'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'
import { GettingStartedBusyError, type GettingStartedOwner, type GettingStartedSessionStore } from '../../config/logic/getting-started-session'

export interface CoverageRouteDeps {
  featuresDir: string
  logsDir: string
  projectRoot: string
  /** Shared job store (so the WS layer + restart-reconcile see the same instance).
   *  Omitted in tests → a fresh file-backed store over logsDir. */
  coverageJobStore?: CoverageJobStore
  /** Shared flight store — clearing a feature's PRD summary reopens the
   *  matching flight's docs/prd-summary/specs-coverage stages so the flight
   *  rail reflects the redo live (no-op when absent or the flight is active). */
  flightStore?: FlightStore
  workspaceEvents?: WorkspaceEventPublisher
  /** Getting Started demo tracking — a job start carrying gettingStartedSource
   *  claims the 'coverage' card. Absent in tests → no tracking. */
  gettingStarted?: GettingStartedSessionStore
}

// The Requirement Coverage Ledger REST surface — the single computation layer the
// UI and the MCP tools both consume (dual-surface parity). Pure reads except the
// regenerate action, which re-summarizes the source docs (preserving ids).

/** The docs writers announce their own writes, so they need the bus in their
 *  context (see FeatureAuthoringContext) — built here once so no handler can
 *  assemble a bus-less context and write a doc no client hears about. */
function docsCtx(deps: CoverageRouteDeps): FeatureAuthoringContext {
  return {
    projectRoot: deps.projectRoot,
    featuresDir: deps.featuresDir,
    workspaceEvents: deps.workspaceEvents,
  }
}

export async function coverageRoutes(app: FastifyInstance, deps: CoverageRouteDeps): Promise<void> {
  const jobStore = deps.coverageJobStore ?? coverageJobStore(deps.logsDir)

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
        docsCtx(deps),
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
        docsCtx(deps),
        { feature: req.params.name, relPath: `${base}.md`, content: text },
      )
      if (!result.ok) {
        reply.code(result.error.includes('not found') ? 404 : 400)
        return { error: result.error }
      }
      return { written: true, relativePath: result.relativePath }
    },
  )

  // Link a LOCAL doc path into docs/ as a symlink (copy fallback) — the
  // Requirements stage's "add local path" input and MCP write_feature_doc's
  // link_path both land here (same lib), so the user's original stays the
  // live source.
  app.post<{ Params: { name: string }; Body: { path?: string; relPath?: string } | undefined }>(
    '/api/features/:name/docs/link',
    async (req, reply) => {
      const targetPath = req.body?.path
      if (typeof targetPath !== 'string' || targetPath.trim() === '') {
        reply.code(400)
        return { error: 'path is required' }
      }
      const result = linkFeatureDoc(
        docsCtx(deps),
        {
          feature: req.params.name,
          targetPath: targetPath.trim(),
          ...(typeof req.body?.relPath === 'string' ? { relPath: req.body.relPath } : {}),
        },
      )
      if (!result.ok) {
        reply.code(result.error.includes('not found') ? 404 : 400)
        return { error: result.error }
      }
      return { written: true, relativePath: result.relativePath, linked: result.linked }
    },
  )

  app.delete<{ Params: { name: string; relPath: string } }>(
    '/api/features/:name/docs/:relPath',
    async (req, reply) => {
      const result = deleteFeatureDoc(
        docsCtx(deps),
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
      const result = clearPrdSummary({ featuresDir: deps.featuresDir, feature: req.params.name })
      // Coverage badge + spec tags both change; refresh the ledger view and the
      // tests panel (specs were un-tagged) on every client without a reload.
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'coverage-changed', feature: req.params.name })
      publishWorkspaceEvent(deps.workspaceEvents, { type: 'tests-changed', feature: req.params.name })
      // Coverage-redo backflow: the feature's flight (if any, and not active)
      // reopens its requirements/authoring stages so the flight rail reflects
      // the redo live instead of holding stale done evidence.
      if (deps.flightStore) {
        const record = deps.flightStore.latestForFeature(req.params.name)
        if (record) {
          reopenStages(record.flightId, ['docs', 'prd-summary', 'specs-coverage'], {
            store: deps.flightStore,
            adapters: {},
            workspaceEvents: deps.workspaceEvents,
          })
        }
      }
      return result
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
  // state-aware icon (R8). This is deliberately a manifest scan: summaries,
  // coverage-run markers, source-doc hashes and the job index. It never opens a
  // spec or invokes the TypeScript parser; the selected ledger route owns that.
  app.get('/api/coverage/states', async () => {
    const out: Array<{ feature: string; headline: string | null; summary: string | null; coverage: string | null; coveragePct: number | null }> = []
    const activeJobs = new Map<string, CoverageJobKind>()
    for (const job of jobStore.list()) {
      if (job.status !== 'running') continue
      // Same precedence as computeFeatureCoverage: a summary job owns the state
      // while both kinds are present in an old/corrupt index.
      if (job.kind === 'summary' || !activeJobs.has(job.feature)) activeJobs.set(job.feature, job.kind)
    }
    for (const f of loadFeatures(deps.featuresDir)) {
      try {
        if (!f.featureDir) throw new FeatureNotFoundError(f.name)
        const summary = readPrdSummary(f.featureDir)
        const runState = summary ? readCoverageRunState(f.featureDir) : null
        const summaryDrifted = summary
          ? readDocsCollection(f.featureDir).docsHash !== summary.docsHash
          : false
        const coveragePct = typeof runState?.coveragePct === 'number' && Number.isFinite(runState.coveragePct)
          ? runState.coveragePct
          : null
        const state = deriveCoverageStateView({
          hasSummary: Boolean(summary),
          summaryDrifted,
          changedDocs: [],
          // A completed mapper manifest is the durable proof used by this
          // lightweight route. Manual/source-only claims are resolved on the
          // selected ledger, where exact AST extraction belongs.
          hasAnnotatedTests: false,
          hasCoverageRun: Boolean(runState),
          coverageStale: Boolean(
            runState
            && summary?.requirementsHash
            && runState.requirementsHash !== summary.requirementsHash,
          ),
          coveragePct: coveragePct ?? 0,
          activeJob: activeJobs.get(f.name) ?? null,
        })
        const headline = state.coverage === 'fresh' && coveragePct === null
          ? 'Covered'
          : state.headline
        out.push({
          feature: f.name,
          headline,
          summary: state.summary,
          coverage: state.coverage,
          coveragePct: summary ? coveragePct : 0,
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

  // Structured agent-session snapshot for a coverage/summary job (R17) — the
  // initial render the Generating screen's AgentSessionView fetches before the
  // live WS takes over. Returns null when the job has no agent session (a
  // deterministic-fallback run, or the log not on disk yet).
  app.get<{ Params: { jobId: string } }>('/api/coverage/jobs/:jobId/agent-session', async (req, reply) => {
    const manifest = jobStore.get(req.params.jobId)
    if (!manifest) {
      reply.code(404)
      return { error: 'job not found' }
    }
    const ref = manifest.sessionRef
    if (!ref) return null
    let located: AgentSessionRef | null = null
    if (ref.agent === 'claude') {
      const logPath = ref.sessionId ? findClaudeLogBySessionId(ref.sessionId) : null
      if (logPath) located = { agent: 'claude', sessionId: ref.sessionId, logPath }
    } else {
      // Codex has no pinned id — locate by the job's cwd (project root) + start.
      located = locateCodexSessionLog(deps.projectRoot, manifest.startedAt)
    }
    if (!located) return null
    return buildAgentSessionResponse(located)
  })

  app.post<{ Params: { name: string }; Body: { kind?: CoverageJobKind; adapter?: SummarizeAdapter; gettingStartedSource?: GettingStartedOwner } | undefined }>(
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
      // The internal coverage demo runs summary + mapping as two jobs; each
      // start re-claims, so the card briefly settles between them (by design).
      let gettingStartedSession: string | null = null
      if (req.body?.gettingStartedSource && deps.gettingStarted) {
        try {
          gettingStartedSession = deps.gettingStarted.claim('coverage', req.body.gettingStartedSource).sessionId
        } catch (err) {
          if (!(err instanceof GettingStartedBusyError)) throw err
          reply.code(409)
          return { type: err.type, error: err.message, active: err.active }
        }
      }
      try {
        const { manifest } = startCoverageJob(
          {
            featuresDir: deps.featuresDir,
            logsDir: deps.logsDir,
            feature: req.params.name,
            kind,
            adapter: req.body?.adapter as never,
            // Run the agent in the project root so its session log + cwd-based
            // codex session location resolve (R17).
            cwd: deps.projectRoot,
          },
          { store: jobStore, workspaceEvents: deps.workspaceEvents },
        )
        if (gettingStartedSession) {
          deps.gettingStarted?.attach(gettingStartedSession, { kind: 'coverage-job', id: manifest.jobId, feature: req.params.name })
        }
        reply.code(202)
        return manifest
      } catch (err) {
        if (gettingStartedSession) deps.gettingStarted?.abandon(gettingStartedSession)
        if (err instanceof CoverageJobConflictError) {
          reply.code(409)
          return { error: err.message, existingJobId: err.existingJobId }
        }
        throw err
      }
    },
  )
}
