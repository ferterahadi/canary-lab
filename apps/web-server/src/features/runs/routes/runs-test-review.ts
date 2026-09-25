import fs from 'fs'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import type { RunsRouteDeps } from './runs-route-deps'
import { buildSuiteReview, suiteReviewFiles, suiteReviewRevision } from '../logic/runtime/suite-review'
import { runDirFor } from '../logic/runtime/run-paths'
import { suiteRuntimeInputTargetsForSnapshot } from '../logic/runtime/suite-runtime-inputs'
import { isTerminalRunStatus } from '../../../../../../shared/run-state'
import type { TestReviewDecision } from '../../../../../../shared/test-review'

function reviewCapabilities(active: boolean, terminal: boolean, decision: TestReviewDecision | undefined, hasFiles: boolean) {
  if (decision) return {
    reviewState: 'settled' as const,
    allowedActions: [],
    nextAction: decision.decision === 'approved-for-new-run' ? 'start-new-run' as const : 'none' as const,
    ...(decision.receipt ? { receipt: decision.receipt } : {}),
  }
  if (!hasFiles) return { reviewState: 'settled' as const, allowedActions: [], nextAction: 'none' as const }
  if (active) return {
    reviewState: 'pending-active' as const,
    allowedActions: ['adopt-and-rerun', 'restore', 'leave-pending'] as const,
    nextAction: 'rerun-current' as const,
  }
  if (terminal) return {
    reviewState: 'pending-terminal' as const,
    allowedActions: ['approve-new-run', 'restore', 'leave-pending'] as const,
    nextAction: 'restore-or-leave' as const,
  }
  return { reviewState: 'locked' as const, allowedActions: [], nextAction: 'none' as const }
}

export async function registerRunTestReviewRoutes(app: FastifyInstance, deps: RunsRouteDeps): Promise<void> {
  app.get<{ Params: { runId: string }; Querystring: { summary?: string } }>('/api/runs/:runId/test-review', async (req, reply) => {
    if (!/^[\w.-]+$/.test(req.params.runId) || ['.', '..'].includes(req.params.runId)) {
      return reply.code(400).send({ error: 'Invalid run' })
    }
    const detail = deps.store.get(req.params.runId)
    if (!detail) return reply.code(404).send({ error: 'Run not found' })
    const { manifest } = detail
    const snapshot = manifest.suiteSnapshot
    if (snapshot?.kind !== 'taken' || !manifest.featureDir || !fs.existsSync(snapshot.dir)) {
      return reply.code(409).send({ error: 'Run snapshot unavailable; no review baseline can be substituted.' })
    }
    if (!fs.existsSync(manifest.featureDir) || (fs.existsSync(path.join(snapshot.dir, 'feature.config.cjs')) && !fs.existsSync(path.join(manifest.featureDir, 'feature.config.cjs')))) {
      return reply.code(409).send({ error: 'The live suite is unavailable. This run’s saved snapshot remains available in the run details.' })
    }
    const runtimeInputs = suiteRuntimeInputTargetsForSnapshot(snapshot.dir)
    const active = !!deps.store.registry.get(manifest.runId)?.adoptSpecEdits
    const terminal = isTerminalRunStatus(manifest.status)
    if (req.query.summary === 'true') {
      const review = suiteReviewFiles(snapshot.dir, manifest.featureDir, runtimeInputs)
      const decision = [...(manifest.specEdits?.reviewDecisions ?? [])].reverse().find((item) => item.revision === review.revision)
      return {
        runId: manifest.runId, feature: manifest.feature, baseline: 'run-start',
        review_revision: review.revision, files: review.files,
        canAdopt: active,
        ...reviewCapabilities(active, terminal, decision, review.files.length > 0),
      }
    }
    const review = await buildSuiteReview(snapshot.dir, manifest.featureDir, runtimeInputs)
    if (suiteReviewRevision(snapshot.dir, manifest.featureDir, runtimeInputs) !== review.revision) {
      return reply.code(409).send({ error: 'Suite changed while preparing review; fetch a fresh review.' })
    }
    const dir = path.join(runDirFor(deps.store.logsDir, manifest.runId), 'test-reviews')
    fs.mkdirSync(dir, { recursive: true })
    const patchPath = path.join(dir, `${review.revision}.patch`)
    fs.writeFileSync(patchPath, review.patch)
    const decision = [...(manifest.specEdits?.reviewDecisions ?? [])].reverse().find((item) => item.revision === review.revision)
    return {
      runId: manifest.runId, feature: manifest.feature, baseline: 'run-start',
      review_revision: review.revision, files: review.files, patchPath,
      ...(Buffer.byteLength(review.patch) <= 8000 ? { patch: review.patch } : {}),
      canAdopt: active,
      ...reviewCapabilities(active, terminal, decision, review.files.length > 0),
    }
  })
}
