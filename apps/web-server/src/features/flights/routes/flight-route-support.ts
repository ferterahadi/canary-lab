import fs from 'fs'
import os from 'os'
import path from 'path'
import { type FlightStore } from '../logic/store'
import { FlightConflictError, startFlight, enqueueFlight, type FlightConductorDeps } from '../logic/conductor'
import { STAGE_DEPENDS_ON, type FlightExternalAgentSession, type FlightManifest, type FlightOptions, type FlightStageKey } from '../logic/types'
import { type PlannedFeature } from '../../../../../../shared/flights/types'
import { isClientKind } from '../../../../../../shared/run-mode'
import { flightStageLabel } from '../../../../../../shared/flights/stage-labels'
import { type PlanAutoLaunchOutcome } from '../logic/plan-features'
import { findBootProof, hasAuthoredSpecs, hasCapturedEnvset, hasPrdSummary } from '../logic/stage-evidence'
import { listRuns } from '../../runs/logic/run-store'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'
import { isGettingStartedFlightStart } from '../../config/routes/onboarding'
import { loadProjectConfig } from '../../runs/logic/runtime/launcher/project-config'
import { normalizeStagePlans, type AgentStagePlans, type ModelAgentKind } from '../../agent-sessions/logic/agent-models'
import { MCP_ORIGIN_HEADER } from './flight-decision-origin'
import { type GettingStartedSessionStore } from '../../config/logic/getting-started-session'

// Flight REST surface — the same store/conductor the MCP flight tools
// drive (dual-surface parity). Start is non-blocking: it validates input,
// creates the running manifest, kicks the conductor off detached, and returns
// 201 with the manifest; progress is read back via GET (UI/CLI poll or ride
// the `flights-changed` WorkspaceEvent).

/** Harness-side prerequisite check for a `fromStage` entry. Each stage that
 *  would be skipped must already have its on-disk artifact — the same evidence
 *  the stage itself would have produced. Returns the FIRST missing
 *  prerequisite as a human-readable reason, or null when the jump is OK. */
/** R81: a standalone passed run is the same artifact the Flight run stage
 *  produces. This one lookup owns both entry validation and the link carried
 *  into Evaluation Export, so the gate cannot approve evidence the conductor
 *  then forgets. */
function standalonePassedRun(logsDir: string | undefined, feature: string) {
  if (!logsDir) return null
  try {
    return listRuns(logsDir, { feature }).find(
      (r) => r.status === 'passed' && r.executionType !== 'boot' && r.executionType !== 'benchmark' && r.executionType !== 'verify',
    ) ?? null
  } catch {
    return null
  }
}

/** Re-claim the Getting Started session for the demo flight when it is set
 *  moving again — resume, redo, or a mode-carrying start. Pausing settles the
 *  claim (a paused flight must not hold the workspace forever), so every
 *  re-entry path has to claim it back; without this the resumed demo runs
 *  untracked and a second demo can start against the same workspace. Owner
 *  comes from the same origin header the decision guard reads. Returns null
 *  when this is not the demo flight, no store is wired, or the flight already
 *  holds the claim; propagates GettingStartedBusyError for the route to map. */
export function reclaimGettingStartedFlight(
  gettingStarted: GettingStartedSessionStore | undefined,
  headers: Record<string, unknown>,
  match: { feature: string; repoPaths?: string[] },
  flightId: string | null,
): string | null {
  if (!gettingStarted || !isGettingStartedFlightStart(match)) return null
  const active = gettingStarted.read().active
  if (flightId && active?.target?.kind === 'flight' && active.target.id === flightId) return null
  const owner = headers[MCP_ORIGIN_HEADER] === 'mcp' ? 'external' : 'internal'
  return gettingStarted.claim('flight', owner).sessionId
}

export function buildStageEntryValidator(featuresDir: string, logsDir?: string) {
  return (args: {
    feature: string
    fromStage: FlightStageKey
    env: string
    existing?: { links?: { runId?: string } } | null
  }): string | null => {
    const { feature, fromStage, env } = args
    const featureDir = path.join(featuresDir, feature)

    if (fromStage === 'heal') {
      return `Auto-repair runs as part of ${flightStageLabel('run')} — start from ${flightStageLabel('run')} instead.`
    }

    /** The on-disk artifact each producing stage leaves behind, with the message
     *  naming what is missing and where to start instead. Keyed by the stage that
     *  PRODUCES the artifact, so the reason always points at a real entry point.
     *
     *  These strings render as GUI row sub-lines at the exact moment the user is
     *  blocked — rail labels and plain outcomes, never raw stage keys, file
     *  paths, CLI flags, or the word "feature" (product copy says "suite"). */
    const PRODUCED: Partial<Record<FlightStageKey, { present: () => boolean; missing: string; startFrom: FlightStageKey }>> = {
      'scaffold': {
        present: () => fs.existsSync(path.join(featureDir, 'feature.config.cjs')),
        missing: `suite "${feature}" hasn't been set up yet`,
        startFrom: 'scout',
      },
      'env-capture': {
        // What this stage actually produces is a PROVEN BOOT; the envset is the
        // input it captures on the way, and an app with no env files leaves
        // none. Requiring the envset alone made a jump past this stage
        // impossible for such a feature even after it had booted many times.
        present: () => hasCapturedEnvset(featureDir, env) || (logsDir !== undefined && findBootProof(logsDir, feature) !== null),
        missing: 'the app has never started for this suite and no settings have been saved yet',
        startFrom: 'env-capture',
      },
      'prd-summary': {
        present: () => hasPrdSummary(featureDir),
        missing: 'no requirements have been written yet',
        startFrom: 'docs',
      },
      'specs-coverage': {
        present: () => hasAuthoredSpecs(featureDir),
        missing: 'no tests have been written yet',
        startFrom: 'specs-coverage',
      },
      'run': {
        present: () => Boolean(args.existing?.links?.runId) || standalonePassedRun(logsDir, feature) !== null,
        missing: 'this suite has no passing run yet',
        startFrom: 'run',
      },
    }

    // Only what this stage READS — see STAGE_DEPENDS_ON. The old rule tested
    // every stage to the LEFT of the entry point, which made an early artifact a
    // hard gate for later stages that never open it (a PRD summary blocking
    // portify, run and the evaluation export).
    for (const producer of STAGE_DEPENDS_ON[fromStage]) {
      const artifact = PRODUCED[producer]
      if (artifact && !artifact.present()) {
        return `Can't start at ${flightStageLabel(fromStage)}: ${artifact.missing} — start from ${flightStageLabel(artifact.startFrom)} instead.`
      }
    }
    return null
  }
}

/** Links external stage evidence into the record that is about to consume it.
 *  Validation decides whether entry is allowed; this resolver makes the same
 *  passed run the Evaluation Export stage's explicit input. */
export function buildStageEntryLinkResolver(logsDir?: string) {
  return (args: {
    feature: string
    fromStage: FlightStageKey
    existing?: FlightManifest | null
  }): FlightManifest['links'] | undefined => {
    if (args.fromStage !== 'evaluation-export' || args.existing?.links?.runId) return undefined
    const run = standalonePassedRun(logsDir, args.feature)
    return run ? { runId: run.runId } : undefined
  }
}

/** Expand a leading `~` the way the entry prefill does — feature configs (and
 *  therefore the dialog's repo picker) may declare repos home-relative. */
/** The plan a new flight (or a redo) runs its internal stage spawns on:
 *  launch-gate override entries laid over the workspace `agentModels` config
 *  for the conducting agent. Callers persist the result on the record, so a
 *  later config edit never changes a flight mid-pipeline. `{}` is a real
 *  answer — every stage on the agent default. */
export function resolveFlightModels(
  projectRoot: string,
  agent: ModelAgentKind,
  override: unknown,
): AgentStagePlans {
  const configured = loadProjectConfig(projectRoot).agentModels[agent]
  return { ...configured, ...normalizeStagePlans(agent, override) }
}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p
}

/** Validate the untrusted REST form of an MCP-owned Flight session. The ID is
 *  optional only for older callers; retaining the detected client kind still
 *  lets the UI identify Claude/Codex without inventing a resume-able ID. */
export function parseFlightExternalAgentSession(
  value: unknown,
): FlightExternalAgentSession | { error: string } | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object') {
    return { error: 'externalAgentSession must be an object' }
  }
  const input = value as Record<string, unknown>
  if (!isClientKind(input.clientKind)) {
    return { error: 'externalAgentSession.clientKind is invalid' }
  }
  for (const key of ['sessionId', 'conversationName', 'sessionUrl'] as const) {
    if (input[key] !== undefined && (typeof input[key] !== 'string' || input[key].trim() === '')) {
      return { error: `externalAgentSession.${key} must be a non-empty string` }
    }
  }
  return {
    clientKind: input.clientKind,
    ...(typeof input.sessionId === 'string' ? { sessionId: input.sessionId.trim() } : {}),
    ...(typeof input.conversationName === 'string' ? { conversationName: input.conversationName.trim() } : {}),
    ...(typeof input.sessionUrl === 'string' ? { sessionUrl: input.sessionUrl.trim() } : {}),
  }
}

export interface PlannedLaunchDeps {
  store: FlightStore
  featuresDir: string
  conductorDeps: FlightConductorDeps
  workspaceEvents?: WorkspaceEventPublisher
}

/** Mint one flight per planned feature — the first running, the rest parked
 *  `queued` for the conductor's sequential drain. Synchronous (startFlight /
 *  enqueueFlight kick their agents off detached), so both callers — the
 *  `/launch` route (user-confirmed proposal) and the plan agent's single-feature
 *  auto-launch — run to completion without an await gap, and the plan-task
 *  status flip that guards against a double launch is atomic. `features` must
 *  already be validated (named + described + unique); name collisions are
 *  settled up front so a partial launch can't happen. */
export function executePlannedLaunch(
  args: {
    repoPaths: string[]
    features: PlannedFeature[]
    env: string
    coverageTarget: number
    yolo: boolean
    /** Absent = autopilot on (R71/W4). */
    autopilot?: boolean
    /** R79: the CLI conducting every launched flight. Absent = claude. */
    agent?: 'claude' | 'codex'
    /** The resolved per-stage model plan every launched flight persists —
     *  callers resolve it (resolveFlightModels) for the SAME agent they pass
     *  above, exactly like the single-flight start route. */
    models: AgentStagePlans
  },
  deps: PlannedLaunchDeps,
): PlanAutoLaunchOutcome {
  const conflicts = args.features
    .map((f) => f.name)
    .filter(
      (name) =>
        deps.store.latestForFeature(name) !== null ||
        fs.existsSync(path.join(deps.featuresDir, name)),
    )
  if (conflicts.length > 0) return { launched: false, conflicts }

  const optsFor = (f: PlannedFeature): FlightOptions => ({
    env: args.env,
    coverageTarget: args.coverageTarget,
    yolo: args.yolo,
    ...(args.autopilot === false ? { autopilot: false } : {}),
    ...(args.agent ? { agent: args.agent } : {}),
    // The proposal step already answered "new feature over this repo?" for
    // every sibling — similarity must not re-ask (or yolo-rerun the first).
    plannedSplit: true,
    models: args.models,
    ...(f.group ? { group: f.group } : {}),
  })
  const flightIds: string[] = []
  for (const [i, f] of args.features.entries()) {
    const launchArgs = { feature: f.name, repoPaths: args.repoPaths, description: f.description, opts: optsFor(f) }
    if (i === 0) {
      try {
        flightIds.push(startFlight(launchArgs, deps.conductorDeps).manifest.flightId)
        continue
      } catch (err) {
        // Repo already busy with an unrelated active flight → park this one
        // queued too; the drain starts it when the repo frees up.
        if (!(err instanceof FlightConflictError)) throw err
      }
    }
    flightIds.push(enqueueFlight(launchArgs, deps.conductorDeps).flightId)
  }
  return { launched: true, flightIds }
}
