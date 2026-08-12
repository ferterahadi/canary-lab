import type { FlightStore } from './store'
import { FLIGHT_STAGE_KEYS, isActiveFlightStatus, type FlightManifest } from './types'
import { publishWorkspaceEvent } from '../../../shared/workspace-events'
import { drive } from './flight-drive'
import { FlightExistsError } from './flight-errors'
import { defaultFlightId, driveControllers, freshStages, interruptStage } from './flight-stages'
import { agentJobStore } from '../../agent-sessions/logic/agent-jobs/store'
import { FlightConductorDeps, StartFlightArgs, resumeFlight } from './conductor'

/** Create a flight record WITHOUT driving it — parked `paused`/`queued` for
 *  the conductor's queue drain (the plan-features launch parks every feature
 *  after the first this way). The feature must not already have a record. */
export function enqueueFlight(
  args: Omit<StartFlightArgs, 'fromStage' | 'mode'>,
  deps: FlightConductorDeps,
): FlightManifest {
  const { store } = deps
  const now = deps.now ?? (() => new Date().toISOString())
  const existing = store.latestForFeature(args.feature)
  if (existing) {
    throw new FlightExistsError(args.feature, existing.flightId, existing.status as FlightManifest['status'])
  }
  const manifest: FlightManifest = {
    flightId: (deps.newFlightId ?? defaultFlightId)(),
    feature: args.feature,
    repoPaths: args.repoPaths,
    description: args.description,
    opts: args.opts,
    status: 'paused',
    pauseReason: 'queued',
    currentStage: FLIGHT_STAGE_KEYS[0],
    stages: freshStages(undefined, now),
    createdAt: now(),
    updatedAt: now(),
  }
  store.save(manifest)
  return manifest
}

/** Start the next `queued` flight whose repos are free — called whenever a
 *  flight settles (done / stage-failed park / hard fail / abort) and after
 *  boot reconcile. One start per drain: the started flight's own settle
 *  drains the one after it, which is what keeps the batch sequential. A user
 *  pause or a checkpoint park deliberately does NOT drain — the repo lock is
 *  still morally held by the flight the user is working on. */
export function drainQueuedFlights(deps: FlightConductorDeps): void {
  const { store } = deps
  const queued = store
    .list()
    .filter((e) => e.status === 'paused' && e.pauseReason === 'queued')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  for (const entry of queued) {
    if (store.activeForRepos(entry.repoPaths)) continue
    try {
      resumeFlight(entry.flightId, deps)
    } catch {
      continue // raced with a manual start — try the next queued flight
    }
    return
  }
}

/** Delete a NON-ACTIVE flight record (the frozen-repos escape hatch). The
 *  feature and its on-disk artifacts stay — only the flight record goes, so
 *  the pill row returns to "not flown" and a fresh start can pick new
 *  repos/intent. */
export function deleteFlight(flightId: string, deps: FlightConductorDeps): void {
  const { store } = deps
  const current = store.get(flightId)
  if (!current) throw new Error(`flight not found: ${flightId}`)
  if (isActiveFlightStatus(current.status)) {
    throw new Error(`flight ${flightId} is ${current.status} — stop it before deleting`)
  }
  store.remove(flightId)
  // The flight's agent history goes with it: the transcripts those rows point at
  // live in the flight dir the store just removed, so keeping them would leave
  // rows referring to nothing.
  try { agentJobStore(store.logsDir).removeForFlight(flightId) } catch { /* best-effort */ }
}

/** R76: deleting a FEATURE deletes its flight history with it — one deletion
 *  concept, no orphaned journal pointing at a suite that no longer exists.
 *  Refuses while a flight is active (same guard as deleteFlight); removes
 *  every record for the feature (legacy indexes may hold more than one).
 *  `flights-changed` rides the store's own removals (see
 *  shared/store-event-bridge.ts), so a feature that never flew stays silent
 *  without the caller having to test `removed > 0`. */
export function removeFlightRecordsForFeature(
  store: FlightStore,
  feature: string,
): { error?: string; removed: number } {
  const records = store.list().filter((e) => e.feature === feature)
  const active = records.find((e) => isActiveFlightStatus(e.status))
  if (active) {
    return { error: `flight ${active.flightId} is ${active.status} — pause it before deleting the feature`, removed: 0 }
  }
  for (const record of records) store.remove(record.flightId)
  return { removed: records.length }
}

/** Mark a flight aborted, stopping the open stage's work before resolving —
 *  the same awaited teardown as pause, because "stop" means the same thing on a
 *  terminal end as on a resumable one. The drive loop notices after the in-flight
 *  stage settles and stops advancing. */
export async function abortFlight(flightId: string, deps: FlightConductorDeps): Promise<FlightManifest> {
  const store = deps.store
  const now = deps.now ?? (() => new Date().toISOString())
  const current = store.get(flightId)
  if (!current) throw new Error(`flight not found: ${flightId}`)
  const openStage = current.stages.find(
    (s) => s.status === 'running' || s.status === 'waiting-for-approval',
  )
  const manifest: FlightManifest = {
    ...current,
    status: 'aborted',
    pauseReason: undefined,
    currentStage: null,
    updatedAt: now(),
    endedAt: now(),
    // Same open-stage settle as pause: a terminal record must not keep a live
    // checkpoint — the UI would render an answerable ask that can only 409.
    stages: current.stages.map((s) =>
      s.key === openStage?.key ? { ...s, status: 'pending' as const, checkpoint: undefined } : s,
    ),
  }
  store.save(manifest)
  driveControllers.get(flightId)?.abort()
  // Before the drain: a queued sibling waiting on these repos must not boot while
  // this flight's run or workflow is still being torn down.
  if (openStage) await interruptStage(flightId, openStage.key, 'abort', deps)
  // Same re-read as pause: the teardown's log line lands after the snapshot above.
  const settled = store.get(flightId) ?? manifest
  drainQueuedFlights(deps)
  return settled
}
