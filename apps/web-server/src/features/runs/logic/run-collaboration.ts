import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import type { RunDetail } from '../../../../../../shared/run-detail'
import type { RunCollaborationState } from '../../../../../../shared/run-collaboration'
import type { RunManifest } from '../../../../../../shared/run-manifest'
import { isActiveRunStatus } from '../../../../../../shared/run-state'
import { checkRestartEligibility } from './restart-eligibility'
import { runDirFor, runManifestPath } from './runtime/run-paths'
import { suiteReviewFiles } from './runtime/suite-review'
import { suiteRuntimeInputTargetsForSnapshot } from './runtime/suite-runtime-inputs'
import { readManifest, readRunsIndex } from './runtime/manifest'
import { detectRepoCollision } from './runtime/repo-collision'
import { decideAdmission, estimateRunCost, readSystemResources, resolveAdmissionConfig } from './runtime/admission'

/** Read statuses from manifests; the index is only a directory of run IDs. */
export function activeRunManifests(logsDir: string, except: string): RunManifest[] {
  return readRunsIndex(logsDir).filter((row) => row.runId !== except).flatMap((row) => {
    const manifest = readManifest(runManifestPath(runDirFor(logsDir, row.runId)))
    return manifest && isActiveRunStatus(manifest.status) ? [manifest] : []
  })
}

export function continuationAdmissionBlock(manifest: RunManifest, active: RunManifest[]): 'execution-context-busy' | 'resources-busy' | undefined {
  if (active.some((m) => m.feature === manifest.feature && m.env === manifest.env)
    || detectRepoCollision(manifest.repoPaths, active.map((m) => ({ ...m, repoPaths: m.repoPaths ?? [] })))) return 'execution-context-busy'
  const admission = decideAdmission({ activeCosts: active.map((m) => estimateRunCost(m.services.length)),
    candidateCost: estimateRunCost(manifest.services.length), resources: readSystemResources(), config: resolveAdmissionConfig(process.env) })
  return admission.admit ? undefined : 'resources-busy'
}

export function runCollaboration(detail: RunDetail, logsDir: string): RunCollaborationState {
  const { manifest: m } = detail
  let review: RunCollaborationState['review'] = { state: 'unavailable', changedFiles: 0 }
  if (m.suiteSnapshot?.kind === 'taken' && m.featureDir) {
    try {
      if (fs.existsSync(path.join(m.suiteSnapshot.dir, 'feature.config.cjs')) && !fs.existsSync(path.join(m.featureDir, 'feature.config.cjs'))) throw new Error('Live suite unavailable')
      const current = suiteReviewFiles(m.suiteSnapshot.dir, m.featureDir, suiteRuntimeInputTargetsForSnapshot(m.suiteSnapshot.dir))
      const receipt = [...(m.specEdits?.reviewDecisions ?? [])].reverse().find((d) => d.revision === current.revision)?.receipt
      review = { revision: current.revision, changedFiles: current.files.length,
        state: !current.files.length ? 'settled' : receipt?.decision === 'accepted' ? 'accepted' : 'pending',
        ...(receipt ? { receipt } : {}) }
    } catch { /* Unavailable source is not an empty diff or an approval. */ }
  }
  const eligible = checkRestartEligibility(m, runDirFor(logsDir, m.runId), 'run')
  const reason = !eligible.ok ? eligible.reason : review.state === 'pending' ? 'test-review-required'
    : review.state === 'unavailable' && m.suiteSnapshot?.kind === 'taken' ? 'source-unavailable'
    : continuationAdmissionBlock(m, activeRunManifests(logsDir, m.runId))
  const value = {
    runId: m.runId, status: m.status, execution: m.playwrightExecutions ?? 0,
    ...(m.externalHealSession ? { owner: m.externalHealSession } : {}), review,
    continuation: { available: !reason, ...(reason ? { reason } : {}), requiresNewRun: reason === 'new-run-required' },
  }
  // Heartbeats do not change the semantic revision. Reconnects can compare it
  // against disk even after the server's in-memory event stream was lost.
  const owner = m.externalHealSession
  const revision = createHash('sha256').update(JSON.stringify({ ...value,
    owner: owner ? { sessionId: owner.sessionId, status: owner.status } : undefined,
    summary: detail.summary, continuationOf: m.continuationOf,
  })).digest('hex')
  return { ...value, revision }
}
