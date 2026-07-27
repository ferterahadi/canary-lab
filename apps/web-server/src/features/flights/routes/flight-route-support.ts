import fs from 'fs'
import os from 'os'
import path from 'path'
import { type FlightStore } from '../logic/store'
import { FlightConflictError, startFlight, enqueueFlight, type FlightConductorDeps } from '../logic/conductor'
import { STAGE_DEPENDS_ON, type FlightOptions, type FlightStageKey } from '../logic/types'
import { type PlannedFeature } from '../../../../../../shared/flights/types'
import { type PlanAutoLaunchOutcome } from '../logic/plan-features'
import { hasAuthoredSpecs, hasCapturedEnvset, hasPrdSummary } from '../logic/stage-evidence'
import { listRuns } from '../../runs/logic/run-store'
import { publishWorkspaceEvent, type WorkspaceEventPublisher } from '../../../shared/workspace-events'

// Flight REST surface — the same store/conductor the MCP flight tools
// drive (dual-surface parity). Start is non-blocking: it validates input,
// creates the running manifest, kicks the conductor off detached, and returns
// 201 with the manifest; progress is read back via GET (UI/CLI poll or ride
// the `flights-changed` WorkspaceEvent).

/** Harness-side prerequisite check for a `fromStage` entry. Each stage that
 *  would be skipped must already have its on-disk artifact — the same evidence
 *  the stage itself would have produced. Returns the FIRST missing
 *  prerequisite as a human-readable reason, or null when the jump is OK. */
export function buildStageEntryValidator(featuresDir: string, logsDir?: string) {
  /** R81: "has this feature produced a run?" without a flight record. A
   *  standalone passed run is the same evidence the flight's own run stage
   *  would have left behind, so it satisfies the evaluation-export
   *  prerequisite. Only consulted when the record can't answer. */
  const hasStandalonePassedRun = (feature: string): boolean => {
    if (!logsDir) return false
    try {
      return listRuns(logsDir, { feature }).some(
        (r) => r.status === 'passed' && r.executionType !== 'boot' && r.executionType !== 'benchmark' && r.executionType !== 'verify',
      )
    } catch {
      return false
    }
  }
  return (args: {
    feature: string
    fromStage: FlightStageKey
    env: string
    existing?: { links?: { runId?: string } } | null
  }): string | null => {
    const { feature, fromStage, env } = args
    const featureDir = path.join(featuresDir, feature)

    if (fromStage === 'heal') {
      return 'cannot start at "heal" — heal is driven by the run stage; use --from-stage run'
    }

    /** The on-disk artifact each producing stage leaves behind, with the message
     *  naming what is missing and where to start instead. Keyed by the stage that
     *  PRODUCES the artifact, so the reason always points at a real entry point. */
    const PRODUCED: Partial<Record<FlightStageKey, { present: () => boolean; missing: string; startFrom: string }>> = {
      'scaffold': {
        present: () => fs.existsSync(path.join(featureDir, 'feature.config.cjs')),
        missing: `feature "${feature}" has no feature.config.cjs (scaffold prerequisite)`,
        startFrom: 'scout/scaffold',
      },
      'env-capture': {
        present: () => hasCapturedEnvset(featureDir, env),
        missing: `no captured envset at envsets/${env}/ (env-capture prerequisite)`,
        startFrom: 'env-capture',
      },
      'prd-summary': {
        present: () => hasPrdSummary(featureDir),
        missing: 'no PRD summary at docs/_prd-summary.json (prd-summary prerequisite)',
        startFrom: 'docs',
      },
      'specs-coverage': {
        present: () => hasAuthoredSpecs(featureDir),
        missing: 'no specs under e2e/ (specs-coverage prerequisite)',
        startFrom: 'specs-coverage',
      },
      'run': {
        present: () => Boolean(args.existing?.links?.runId) || hasStandalonePassedRun(feature),
        missing: 'no passed run for this feature yet (run prerequisite)',
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
        return `cannot start at "${fromStage}": ${artifact.missing} — start from ${artifact.startFrom} instead`
      }
    }
    return null
  }
}

/** Expand a leading `~` the way the entry prefill does — feature configs (and
 *  therefore the dialog's repo picker) may declare repos home-relative. */
export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p
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
  publishWorkspaceEvent(deps.workspaceEvents, { type: 'flights-changed' })
  return { launched: true, flightIds }
}
