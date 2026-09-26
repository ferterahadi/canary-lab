import fs from 'fs'
import path from 'path'
import { loadFeatures } from '../../../shared/feature-loader'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'
import { isWithin } from './path-containment'

interface SuiteDeletionDeps {
  featuresDir: string
  workspaceEvents?: WorkspaceEventPublisher
  /** Omitted for scaffold reset, which removes its directory but keeps its Flight. */
  removeFlightRecordsFor?: (feature: string) => { error?: string; removed: number }
}

type SuiteDeletionResult =
  | { ok: true; featureDir: string; flightRecordsRemoved: number }
  | { ok: false; statusCode: 400 | 404 | 409; error: string; featureDir?: string }

/** Validate the directory before the Flight hook: it removes records as well as
 * checking active work. A refused target must not have lost its history already.
 * Writes retain their existing order; this is not a filesystem transaction. */
export function deleteSuite(deps: SuiteDeletionDeps, input: { feature: string; confirmName?: string }): SuiteDeletionResult {
  const feature = loadFeatures(deps.featuresDir).find((entry) => entry.name === input.feature)
  if (!feature?.featureDir) return { ok: false, statusCode: 404, error: 'feature not found' }
  if (input.confirmName !== feature.name) return { ok: false, statusCode: 400, error: 'confirmName must match the feature name' }
  const featuresRoot = path.resolve(deps.featuresDir)
  const featureDir = path.resolve(feature.featureDir)
  if (featureDir === featuresRoot || !isWithin(featuresRoot, featureDir)) {
    return { ok: false, statusCode: 400, error: 'feature directory is outside the features root', featureDir }
  }
  const flights = deps.removeFlightRecordsFor?.(feature.name)
  if (flights?.error) return { ok: false, statusCode: 409, error: flights.error }
  fs.rmSync(featureDir, { recursive: true, force: true })
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'feature-deleted', feature: feature.name })
  return { ok: true, featureDir, flightRecordsRemoved: flights?.removed ?? 0 }
}
