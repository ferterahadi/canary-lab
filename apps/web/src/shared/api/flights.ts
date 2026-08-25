// Flight pipeline: entry options, lifecycle, checkpoints, remedies, planning.
// Split out of client.ts; see that barrel for the shared surface.

import type {
  FlightCheckpointResponse as FlightCheckpointResponseT,
  FlightEntryOptions as FlightEntryOptionsT,
  FlightIndexEntry as FlightIndexEntryT,
  FlightManifest as FlightManifestT,
  FlightStageKey as FlightStageKeyT,
  PlannedFeature as PlannedFeatureT,
  PlanFeaturesTask as PlanFeaturesTaskT,
} from '@shared/flights/types'
import { ApiError, defaultOpts, request, type ClientOptions } from './internal'
import { agentSessionAbsence, type AgentSessionAbsence, type AgentSessionResponse } from './agent-sessions'

/** Stage-entry menu for one feature: latest flight record, per-stage
 *  allowed/blocked verdicts (server-computed), and the start-form prefill. */
export function getFlightEntryOptions(
  feature: string,
  env?: string,
  opts?: ClientOptions,
): Promise<FlightEntryOptionsT> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  const params = new URLSearchParams({ feature })
  if (env) params.set('env', env)
  return request<FlightEntryOptionsT>(
    `${baseUrl}/api/flights/entry?${params.toString()}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export interface StartFlightBody {
  feature: string
  /** Omit on continue/redo/jump — repos are frozen; the server reuses the
   *  stored set and 409s (`flight_frozen`) on a differing one. */
  repoPaths?: string[]
  /** Omit on continue/redo/jump — intent is frozen like the repos. */
  description?: string
  env?: string
  coverageTarget?: number
  /** Required when the feature already has a flight record. */
  mode?: 'continue' | 'redo' | 'jump'
  /** Stage to start at (mode "jump", or fresh stage entry). */
  fromStage?: FlightStageKeyT
  /** Absent = autopilot on; explicit false asks at every checkpoint (R71/W4). */
  autopilot?: boolean
  /** R79: which CLI conducts the flight's stage agents. Sticky per record —
   *  jump/continue reuse the stored one. Absent = claude. */
  agent?: 'claude' | 'codex'
  /** Marks a Getting Started demo start; ordinary flights omit it. */
  gettingStartedSource?: 'internal' | 'external'
  /** Which Getting Started card a demo flight belongs to: the author/portify/
   *  export demos run AS a flight but claim their own workflow key so their
   *  card lights. Absent → 'flight'. Only read with gettingStartedSource. */
  gettingStartedWorkflow?: 'flight' | 'author' | 'portify' | 'export'
}

/** Start / continue / redo / jump a flight (POST /api/flights, non-blocking —
 *  the 201 manifest is the just-kicked conductor's snapshot). */
export function startFlight(body: StartFlightBody, opts?: ClientOptions): Promise<FlightManifestT> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<FlightManifestT>(
    `${baseUrl}/api/flights`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    fetchImpl,
  )
}

export function listFlights(opts?: ClientOptions): Promise<FlightIndexEntryT[]> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ flights: FlightIndexEntryT[] }>(`${baseUrl}/api/flights`, { method: 'GET' }, fetchImpl)
    .then((r) => r.flights)
}

export function getFlight(flightId: string, opts?: ClientOptions): Promise<FlightManifestT> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<FlightManifestT>(
    `${baseUrl}/api/flights/${encodeURIComponent(flightId)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

export function respondFlightCheckpoint(
  flightId: string,
  response: FlightCheckpointResponseT,
  opts?: ClientOptions,
): Promise<FlightManifestT> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<FlightManifestT>(
    `${baseUrl}/api/flights/${encodeURIComponent(flightId)}/respond`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response }) },
    fetchImpl,
  )
}

/** Ask the external agent driving the current work hand-off to release this
 *  step. This persists the request; it does not start Canary's local agent. */
export function requestFlightTakeover(
  flightId: string,
  opts?: ClientOptions,
): Promise<FlightManifestT> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<FlightManifestT>(
    `${baseUrl}/api/flights/${encodeURIComponent(flightId)}/takeover/request`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    fetchImpl,
  )
}

/** Start the current external work hand-off internally without waiting for its
 *  client to release. The UI confirms the concurrent-file-write risk first. */
export function forceFlightTakeover(
  flightId: string,
  opts?: ClientOptions,
): Promise<FlightManifestT> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<FlightManifestT>(
    `${baseUrl}/api/flights/${encodeURIComponent(flightId)}/takeover/force`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) },
    fetchImpl,
  )
}

/** Read-time remedy for a failed stage: null = nothing actionable; repos [] =
 *  the error is stale and every repo is clean again (just Continue). */
export function getFlightRemedy(
  flightId: string,
  opts?: ClientOptions,
): Promise<{ remedy: import('@shared/flights/types').FlightStageRemedy | null }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request(
    `${baseUrl}/api/flights/${encodeURIComponent(flightId)}/remedy`,
    { method: 'GET' },
    fetchImpl,
  )
}

/** Execute the remedy (stash or commit every dirty repo), then resume the
 *  flight — server-side twin of fixing the repos by hand + header Continue. */
export function applyFlightRemedy(
  flightId: string,
  action: 'stash' | 'commit',
  opts?: ClientOptions,
): Promise<FlightManifestT> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<FlightManifestT>(
    `${baseUrl}/api/flights/${encodeURIComponent(flightId)}/remedy`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) },
    fetchImpl,
  )
}

export function resumeFlight(flightId: string, opts?: ClientOptions): Promise<FlightManifestT> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<FlightManifestT>(
    `${baseUrl}/api/flights/${encodeURIComponent(flightId)}/resume`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    fetchImpl,
  )
}

/** R78: flip autopilot on an existing flight, in any status. Takes effect at
 *  the next checkpoint; one the flight is already parked on stays parked. */
export function setFlightAutopilot(
  flightId: string,
  autopilot: boolean,
  opts?: ClientOptions,
): Promise<FlightManifestT> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<FlightManifestT>(
    `${baseUrl}/api/flights/${encodeURIComponent(flightId)}/autopilot`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ autopilot }) },
    fetchImpl,
  )
}

export function abortFlight(flightId: string, opts?: ClientOptions): Promise<FlightManifestT> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<FlightManifestT>(
    `${baseUrl}/api/flights/${encodeURIComponent(flightId)}/abort`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    fetchImpl,
  )
}

/** User-initiated pause: parks the flight resumable (pauseReason "user") and
 *  cancels the in-flight stage work server-side. */
export function pauseFlight(flightId: string, opts?: ClientOptions): Promise<FlightManifestT> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<FlightManifestT>(
    `${baseUrl}/api/flights/${encodeURIComponent(flightId)}/pause`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
    fetchImpl,
  )
}

/** Re-fly the record with its own stored args. No body → from stage 1 ("start
 *  over"); `fromStage` → Continue → "from a step…", with the optional "what
 *  went wrong" note scoped to that stage's agent prompt (R74). */
export function redoFlight(
  flightId: string,
  body?: { fromStage?: string; feedback?: string },
  opts?: ClientOptions,
): Promise<FlightManifestT> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<FlightManifestT>(
    `${baseUrl}/api/flights/${encodeURIComponent(flightId)}/redo`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) },
    fetchImpl,
  )
}

/** Delete a NON-ACTIVE flight record (repos + intent are frozen — deletion is
 *  the escape hatch). 409 while the flight is active; the feature stays. */
export function deleteFlight(flightId: string, opts?: ClientOptions): Promise<{ deleted: boolean }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ deleted: boolean }>(
    `${baseUrl}/api/flights/${encodeURIComponent(flightId)}`,
    { method: 'DELETE' },
    fetchImpl,
  )
}

/** Link a LOCAL doc path into a feature's docs/ (symlink, copy fallback). */
export function linkFeatureDocPath(
  feature: string,
  targetPath: string,
  opts?: ClientOptions,
): Promise<{ written: boolean; relativePath: string; linked: boolean }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ written: boolean; relativePath: string; linked: boolean }>(
    `${baseUrl}/api/features/${encodeURIComponent(feature)}/docs/link`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: targetPath }) },
    fetchImpl,
  )
}

/** Snapshot of a flight stage's agent session (stage = sidecar dir name:
 *  scout, prd-summary, specs-1, coverage-1). 404 → an `AgentSessionAbsence`
 *  (`no-session`: no agent ever ran for the stage — refs are pinned at spawn,
 *  so a missing sidecar is definitive, not a not-yet-flushed log). */
export async function getFlightAgentSession(
  flightId: string,
  stage: string,
  opts?: ClientOptions,
): Promise<AgentSessionResponse | AgentSessionAbsence> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  try {
    return await request<AgentSessionResponse>(
      `${baseUrl}/api/flights/${encodeURIComponent(flightId)}/agent-session?stage=${encodeURIComponent(stage)}`,
      { method: 'GET' },
      fetchImpl,
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return agentSessionAbsence(err)
    throw err
  }
}

// ─── Plan features (pre-flight intent breakdown, R54) ─────────────────────

/** Kick the breakdown agent: judges whether the intent is one feature or
 *  several. 202 with the task record; attach-or-start server-side (same repo
 *  set + description reattaches to the running task). */
export function planFeatures(
  body: { repoPaths: string[]; description: string; autopilot?: boolean; agent?: 'claude' | 'codex' },
  opts?: ClientOptions,
): Promise<PlanFeaturesTaskT> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<PlanFeaturesTaskT>(
    `${baseUrl}/api/flights/plan-features`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    fetchImpl,
  )
}

export function getPlanFeaturesTask(taskId: string, opts?: ClientOptions): Promise<PlanFeaturesTaskT> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<PlanFeaturesTaskT>(
    `${baseUrl}/api/flights/plan-features/${encodeURIComponent(taskId)}`,
    { method: 'GET' },
    fetchImpl,
  )
}

/** Pre-flight tasks still needing continuation (running) or the user's
 *  confirmation (done) — the Flights pill's pre-flight rows. Refetched on the
 *  `pre-flight-changed` WorkspaceEvent. */
export function listPlanFeatures(opts?: ClientOptions): Promise<{ tasks: PlanFeaturesTaskT[] }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ tasks: PlanFeaturesTaskT[] }>(
    `${baseUrl}/api/flights/plan-features`,
    { method: 'GET' },
    fetchImpl,
  )
}

/** Launch the confirmed proposal: one flight per feature — the first starts
 *  now, the rest park `queued` and drain sequentially. 409 type
 *  `feature_name_conflicts` lists names already in use (nothing created). */
export function launchPlannedFeatures(
  taskId: string,
  body: { features: PlannedFeatureT[]; env?: string; coverageTarget?: number; yolo?: boolean; autopilot?: boolean; agent?: 'claude' | 'codex' },
  opts?: ClientOptions,
): Promise<{ flightIds: string[] }> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  return request<{ flightIds: string[] }>(
    `${baseUrl}/api/flights/plan-features/${encodeURIComponent(taskId)}/launch`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    fetchImpl,
  )
}

/** Snapshot of the breakdown agent's session. 404 → an `AgentSessionAbsence`
 *  (`no-session`: not spawned yet). */
export async function getFlightPlanAgentSession(
  taskId: string,
  opts?: ClientOptions,
): Promise<AgentSessionResponse | AgentSessionAbsence> {
  const { baseUrl, fetchImpl } = defaultOpts(opts)
  try {
    return await request<AgentSessionResponse>(
      `${baseUrl}/api/flights/plan-features/${encodeURIComponent(taskId)}/agent-session`,
      { method: 'GET' },
      fetchImpl,
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return agentSessionAbsence(err)
    throw err
  }
}
