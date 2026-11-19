import type { RunStore } from './run-store'
import { withRunLifecycleLock } from './run-lifecycle-lock'
import { checkRestartEligibility } from './restart-eligibility'
import { buildRunPaths, runDirFor } from './runtime/run-paths'
import { appendJournalIteration } from './runtime/heal-journal'
import { isActiveRunStatus } from '../../../../../../shared/run-state'
import { activeRunManifests, continuationAdmissionBlock } from './run-collaboration'
import type { RunManifest } from '../../../../../../shared/run-manifest'
import { hasRetiredPerturbation } from './runtime/manifest'
import { NEW_RUN_REQUIRED_MESSAGE } from '../../../shared/single-attempt'

type ContinuationRefusal = 'run-not-found' | 'not-restartable' | 'already-active' | 'new-run-required'

export function recordRunDecision(store: RunStore, runId: string, description: string, decision: 'accepted-awaiting-execution' | 'continuation-requested'): void {
  const paths = buildRunPaths(runDirFor(store.logsDir, runId))
  const manifest = store.get(runId)?.manifest
  appendJournalIteration({ signal: 'none', decision, hypothesis: description, fixDescription: description,
    runId, inputExecution: manifest?.playwrightExecutions,
    manifestPath: paths.manifestPath, summaryPath: paths.summaryPath, journalPath: paths.diagnosisJournalPath })
  store.recordJournalChange(runId)
}

/** Every continuation path performs this admission before envsets or ports.
 * Duplicate requests attach to the orchestrator registered by the first one. */
export async function continueRun<T>(store: RunStore, runId: string, launch: () => Promise<T>, alreadyRunning: () => T, refused?: (reason: ContinuationRefusal) => T, owner?: { sessionId: string; current: () => RunManifest['externalHealSession'] | null }): Promise<T> {
  const initial = store.get(runId)
  if (!initial) {
    if (refused) return refused('run-not-found')
    throw Object.assign(new Error('run-not-found'), { statusCode: 404 })
  }
  return withRunLifecycleLock(store.logsDir, initial.manifest.feature, async () => {
    const detail = store.get(runId)
    if (!detail) throw Object.assign(new Error('run-not-found'), { statusCode: 404 })
    const claim = owner?.current()
    if (claim && claim.sessionId !== owner!.sessionId) {
      throw Object.assign(new Error('already-claimed: this run belongs to another agent session; use the existing handoff flow.'), { statusCode: 409 })
    }
    if (store.registry.get(runId)) return alreadyRunning()
    if ((detail.manifest.playwrightExecutions ?? 0) !== (initial.manifest.playwrightExecutions ?? 0)) {
      throw Object.assign(new Error('This run already continued. Read the current execution before requesting another attempt.'), { statusCode: 409 })
    }
    const eligibility = checkRestartEligibility(detail.manifest, runDirFor(store.logsDir, runId), 'run')
    if (!eligibility.ok) {
      if (refused) return refused(eligibility.reason)
      const message = hasRetiredPerturbation(detail.manifest) ? 'This run used a retired perturbation and cannot be restarted; start a new run.'
        : eligibility.reason === 'new-run-required' ? NEW_RUN_REQUIRED_MESSAGE : 'not-restartable'
      throw Object.assign(new Error(message), { statusCode: 409 })
    }
    const review = detail.collaboration?.review
    if (review?.state === 'pending' || (review?.state === 'unavailable' && detail.manifest.suiteSnapshot?.kind === 'taken')) {
      throw Object.assign(new Error(review.state === 'pending' ? 'test-review-required' : 'source-unavailable'), { statusCode: 409 })
    }
    const admissionBlock = continuationAdmissionBlock(detail.manifest, activeRunManifests(store.logsDir, runId))
    if (admissionBlock === 'execution-context-busy') {
      throw Object.assign(new Error('Another run owns this execution context. Continue that run or wait for it to finish.'), { statusCode: 409 })
    }
    if (admissionBlock) throw Object.assign(new Error('Run resources are busy. Retry continuation when a slot is available.'), { statusCode: 409 })
    recordRunDecision(store, runId, `Continuation requested for execution ${(detail.manifest.playwrightExecutions ?? 0) + 1}; it verifies this repair in the same run.`, 'continuation-requested')
    return launch()
  })
}

export function validateContinuation(store: RunStore, predecessor: string | undefined, feature: string, env: string | undefined, runId?: string): RunManifest | undefined {
  if (predecessor === undefined) return
  if (typeof predecessor !== 'string' || !/^[\w.-]+$/.test(predecessor) || predecessor === '.' || predecessor === '..') throw Object.assign(new Error('Invalid continuation run ID'), { statusCode: 400 })
  const seen = new Set(runId ? [runId] : [])
  let id: string | undefined = predecessor
  let source: RunManifest | undefined
  while (id) {
    if (seen.has(id)) throw Object.assign(new Error('Continuation cycle is not allowed'), { statusCode: 409 })
    seen.add(id)
    const manifest: RunManifest | undefined = store.get(id)?.manifest
    if (!manifest || manifest.feature !== feature || manifest.env !== env) throw Object.assign(new Error('Continuation must reference a recorded run in the same suite and environment'), { statusCode: 409 })
    if (isActiveRunStatus(manifest.status)) throw Object.assign(new Error('Continue the active run instead of creating a successor'), { statusCode: 409 })
    source ??= manifest
    id = manifest.continuationOf
  }
  return source
}
