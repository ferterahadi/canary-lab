import path from 'path'
import { isRestartableRunStatus } from '../../../../../../shared/run-state'
import { claimedSingleAttempt, policyForRunManifest } from '../../../shared/single-attempt'
import type { RunIndexEntry } from './runtime/manifest'
import { readManifest } from './runtime/manifest'
import type { RunDetail } from './run-detail'
import { runDirFor } from './runtime/run-paths'

/** Read-side action state for receipts claimed by older runs whose index and
 *  manifest predate the single-attempt policy. REST and the run stream must
 *  agree before a row can offer Retest. */
export function withSingleAttemptIndexState(
  entries: RunIndexEntry[],
  logsDir: string,
  featuresDir: string,
): RunIndexEntry[] {
  const policies = new Map<string, ReturnType<typeof policyForRunManifest>>()
  return entries.map((entry) => {
    if (entry.newRunRequired || !isRestartableRunStatus(entry.status)) return entry
    const runDir = runDirFor(logsDir, entry.runId)
    const manifest = readManifest(path.join(runDir, 'manifest.json'))
    let policy = manifest?.singleAttempt
    if (!policy) {
      if (!policies.has(entry.feature)) {
        policies.set(entry.feature, policyForRunManifest({
          feature: entry.feature,
          featureDir: path.join(featuresDir, entry.feature),
        }))
      }
      policy = policies.get(entry.feature)
    }
    return claimedSingleAttempt(runDir, policy)
      ? { ...entry, newRunRequired: true }
      : entry
  })
}

export function withSingleAttemptDetailState(detail: RunDetail, logsDir: string): RunDetail {
  return isRestartableRunStatus(detail.manifest.status)
    && claimedSingleAttempt(runDirFor(logsDir, detail.runId), policyForRunManifest(detail.manifest))
    ? { ...detail, newRunRequired: true }
    : detail
}
