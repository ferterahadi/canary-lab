import type { FlightIndexEntry } from '@shared/flights/types'
import { isTerminalFlightStatus } from '@shared/flights/types'
import type { Feature } from '@/shared/api/types'

/**
 * A First-Flight batch launch (`Start N flights`) mints N flight records
 * up-front, but each feature's `feature.config.cjs` is only written when that
 * flight reaches its scaffold stage. Until then the Features ledger would sit
 * empty even though the flights are already queued — the user couldn't see the
 * batch they just started, or continue from it, without a refresh.
 *
 * This derives placeholder ("pending") `Feature` rows straight from the flights
 * list so the batch — and its group — shows in the ledger immediately, off the
 * same `flights-changed` event the launch already emits. Each stub is replaced
 * by the real feature (dedup by name) the moment scaffold writes the config and
 * the `feature-created` event refetches the feature list.
 *
 * A stub is shown for every NON-TERMINAL flight whose feature isn't on disk yet
 * (running, waiting-for-approval, or queued/paused). Terminal flights are never
 * stubbed: a `done` flight's feature is already real (so the real row wins), and
 * a `failed`/`aborted` flight never produced a feature.
 */
export function derivePendingFeatures(
  flights: FlightIndexEntry[],
  features: Feature[],
): Feature[] {
  const realNames = new Set(features.map((f) => f.name))
  const seen = new Set<string>()
  const stubs: Feature[] = []
  for (const f of flights) {
    if (isTerminalFlightStatus(f.status)) continue
    if (realNames.has(f.feature) || seen.has(f.feature)) continue
    seen.add(f.feature)
    stubs.push({
      name: f.feature,
      ...(f.group ? { group: f.group } : {}),
      repos: [],
      envs: [],
      pending: {
        flightId: f.flightId,
        status: f.status,
        currentStage: f.currentStage,
        ...(f.pauseReason ? { pauseReason: f.pauseReason } : {}),
        ...(f.checkpointKind ? { checkpointKind: f.checkpointKind } : {}),
        // Carried for the same reason as checkpointKind: the column sorts on
        // "does this need a click", and a flight the user's agent drives never
        // does — whatever it is parked on.
        ...(f.stageProducer ? { stageProducer: f.stageProducer } : {}),
      },
    })
  }
  return stubs
}
