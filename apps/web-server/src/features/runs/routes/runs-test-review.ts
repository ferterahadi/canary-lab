import fs from 'fs'
import path from 'path'
import type { FastifyInstance } from 'fastify'
import type { RunsRouteDeps } from './runs-route-deps'
import { buildSuiteReview, suiteReviewFiles, suiteReviewRevision } from '../logic/runtime/suite-review'
import { runDirFor } from '../logic/runtime/run-paths'

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
    if (req.query.summary === 'true') {
      const review = suiteReviewFiles(snapshot.dir, manifest.featureDir)
      return {
        runId: manifest.runId, feature: manifest.feature, baseline: 'run-start',
        review_revision: review.revision, files: review.files,
        canAdopt: !!deps.store.registry.get(manifest.runId)?.adoptSpecEdits,
      }
    }
    const review = await buildSuiteReview(snapshot.dir, manifest.featureDir)
    if (suiteReviewRevision(snapshot.dir, manifest.featureDir) !== review.revision) {
      return reply.code(409).send({ error: 'Suite changed while preparing review; fetch a fresh review.' })
    }
    const dir = path.join(runDirFor(deps.store.logsDir, manifest.runId), 'test-reviews')
    fs.mkdirSync(dir, { recursive: true })
    const patchPath = path.join(dir, `${review.revision}.patch`)
    fs.writeFileSync(patchPath, review.patch)
    return {
      runId: manifest.runId, feature: manifest.feature, baseline: 'run-start',
      review_revision: review.revision, files: review.files, patchPath,
      ...(Buffer.byteLength(review.patch) <= 8000 ? { patch: review.patch } : {}),
      canAdopt: !!deps.store.registry.get(manifest.runId)?.adoptSpecEdits,
    }
  })
}
