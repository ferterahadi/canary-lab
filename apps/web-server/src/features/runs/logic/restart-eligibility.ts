import type { RunManifest } from '../../../../../../shared/run-manifest'
import { isActiveRunStatus, isRestartableRunStatus } from '../../../../../../shared/run-state'
import { claimedSingleAttempt, policyForRunManifest } from '../../../shared/single-attempt'
import { hasRetiredPerturbation } from './runtime/manifest'

type RestartEligibility<K extends 'run' | 'heal'> =
  | { ok: true }
  | { ok: false; reason: 'not-restartable' | 'new-run-required' | (K extends 'run' ? 'already-active' : never) }

export function checkRestartEligibility(manifest: RunManifest, runDir: string, kind: 'heal'): RestartEligibility<'heal'>
export function checkRestartEligibility(manifest: RunManifest, runDir: string, kind: 'run'): RestartEligibility<'run'>
export function checkRestartEligibility(manifest: RunManifest, runDir: string, kind: 'run' | 'heal'): RestartEligibility<'run'> {
  if (hasRetiredPerturbation(manifest) || (manifest.executionType ?? 'run') === 'verify') {
    return { ok: false, reason: 'not-restartable' }
  }
  if (kind === 'run' && isActiveRunStatus(manifest.status)) return { ok: false, reason: 'already-active' }
  if (!isRestartableRunStatus(manifest.status)) return { ok: false, reason: 'not-restartable' }
  if (claimedSingleAttempt(runDir, policyForRunManifest(manifest))) return { ok: false, reason: 'new-run-required' }
  return { ok: true }
}
