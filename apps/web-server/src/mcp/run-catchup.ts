import { createHash } from 'crypto'
import type { RunUpdate } from '../../../../shared/run-collaboration'
import type { CanaryLabMcpDeps } from './tool-schemas'

/** Bound context size while always including the explicitly inspected run. */
export function readRunUpdate(feature: string, deps: CanaryLabMcpDeps, runId?: string): RunUpdate {
  const ids = new Set(deps.store.list({ feature }).slice(0, 5).map((r) => r.runId))
  if (runId) ids.add(runId)
  const runs = [...ids].flatMap((id) => {
    const detail = deps.store.get(id)
    return detail?.manifest.feature === feature && detail.collaboration ? [detail.collaboration] : []
  })
  return { feature, revision: createHash('sha256').update(JSON.stringify(runs.map((r) => [r.runId, r.revision]))).digest('hex'), runs }
}
