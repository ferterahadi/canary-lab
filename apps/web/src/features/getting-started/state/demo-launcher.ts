import type { GettingStartedRunWorkflow, GettingStartedSessionState, OnboardingSamples, OnboardingWorkflow } from '@shared/getting-started'
import { useCallback, useMemo, useRef, useState } from 'react'
import * as configApi from '@/shared/api/config'

import type { StartFlightBody } from '@/shared/api/flights'
import type { RunIndexEntry } from '@shared/run-index'
import type { FlightEntryOptions, FlightIndexEntry, FlightStageKey } from '@shared/flights/types'
import { isTerminalRunStatus, isUnsettledRunStatus } from '@shared/run-state'
import { useProjectConfig } from '@/shared/state/use-project-config'
import { useMountedIdentity } from '@/shared/state/use-mounted-identity'
import { useLiveResource } from '@/shared/state/use-live-resource'
import { readStored, writeStored } from '@/shared/state/browser-storage'

// The Getting Started launcher: one guided path plus the specialized workflows
// and exact fixture actions that still exist in this workspace.
//
// The guide remains useful after fixtures are deleted: the server leaves the
// prompt visible and explains why its Internal action is unavailable. `showDemo`
// retains its historical config name but controls the whole launcher.
//
// Two rules shape this:
//
//   • DERIVED, never a flag file. "Has this workspace ever run anything" is a
//     fact about the runs and flights indexes; a `firstRunDone` marker would lie
//     the moment someone cleaned their logs, and would need migrating forever.
//     The only stored state is whether the chooser has ever been opened.
//   • PUSH ONCE, THEN PULL. A workspace that has never run anything opens the
//     chooser itself — nobody has to discover a pill they've never seen. After
//     that it is reached from the status bar, which keeps an attention dot until
//     it has actually been opened.

const SEEN_KEY = 'canary-lab:demo-seen'

// 'coverage' is deliberately NOT here: the specs-coverage stage authors specs
// toward the target, which would close the workbench's intentional R2 gap the
// Coverage demo exists to expose — that demo runs the standalone mapping job
// instead (see useGettingStarted).
export type DemoFlightActionKind = 'export' | 'author' | 'portify'

export const DEMO_FLIGHT_STAGE: Record<DemoFlightActionKind, FlightStageKey> = {
  export: 'evaluation-export',
  author: 'specs-coverage',
  portify: 'portify',
}

/** Resolve a suite to the server-owned Getting Started run workflow that names
 *  it. The run-index reader separately excludes boot, verify, and benchmark
 *  sessions because those are not evidence that the workflow ran. */
function gettingStartedWorkflowForFeature(
  workflows: OnboardingWorkflow[],
  feature: string,
): GettingStartedRunWorkflow | undefined {
  const action = workflows.find((workflow) => {
    const candidate = workflow.internalAction
    return candidate !== null
      && (candidate.kind === 'run' || candidate.kind === 'heal')
      && candidate.feature === feature
  })?.internalAction
  return action?.kind === 'run' || action?.kind === 'heal' ? action.kind : undefined
}

interface CatalogRun {
  run: RunIndexEntry
  workflow: GettingStartedRunWorkflow
}

function catalogRuns(workflows: OnboardingWorkflow[], runs: RunIndexEntry[]): CatalogRun[] {
  return runs.flatMap((run) => {
    // Older run indexes omit executionType; that shape also means a normal run.
    if (run.executionType && run.executionType !== 'run') return []
    const workflow = gettingStartedWorkflowForFeature(workflows, run.feature)
    return workflow ? [{ run, workflow }] : []
  })
}

/** Merge the durable Getting Started record with run-index evidence from the
 *  live runs channel. This makes the run cards update on every run frame and
 *  also recovers browser-started sample runs that predate attribution. */
export function deriveGettingStartedRunSession(
  session: GettingStartedSessionState,
  workflows: OnboardingWorkflow[],
  runs: RunIndexEntry[],
): GettingStartedSessionState {
  const relevant = catalogRuns(workflows, runs)
  const completed = { ...session.completed }
  let active = session.active

  // The run stream can reach the browser before the workspace invalidation.
  // Settle a linked run locally from that stronger evidence instead of leaving
  // the card stale until the onboarding refetch arrives.
  if (active?.target?.kind === 'run') {
    const linked = runs.find((run) => run.runId === active?.target?.id)
    if (linked?.endedAt && isTerminalRunStatus(linked.status)) {
      const previous = completed[active.workflow]
      if (!previous || linked.endedAt.localeCompare(previous.endedAt) > 0) {
        completed[active.workflow] = {
          workflow: active.workflow,
          owner: active.owner,
          target: active.target,
          status: linked.status,
          startedAt: active.startedAt,
          endedAt: linked.endedAt,
        }
      }
      active = null
    }
  }

  // Keep the newest terminal result for each catalogued run workflow. A newer
  // durable record wins, including one created by an external agent.
  for (const { run, workflow } of relevant) {
    if (!run.endedAt || !isTerminalRunStatus(run.status)) continue
    const previous = completed[workflow]
    if (previous && run.endedAt.localeCompare(previous.endedAt) <= 0) continue
    completed[workflow] = {
      workflow,
      owner: 'internal',
      target: { kind: 'run', id: run.runId },
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
    }
  }

  // A server-owned claim remains authoritative. Otherwise the newest live
  // sample run becomes the active card, including queued runs.
  if (!active) {
    const newest = relevant
      .filter(({ run }) => isUnsettledRunStatus(run.status))
      .reduce<CatalogRun | null>((current, candidate) => (
        !current || candidate.run.startedAt.localeCompare(current.run.startedAt) > 0
          ? candidate
          : current
      ), null)
    if (newest) {
      active = {
        sessionId: `run:${newest.run.runId}`,
        workflow: newest.workflow,
        owner: 'internal',
        target: { kind: 'run', id: newest.run.runId },
        startedAt: newest.run.startedAt,
        updatedAt: newest.run.startedAt,
      }
    }
  }

  return { active, completed }
}

/** Build the same server-validated stage-entry request for every specialized
 *  Getting Started workflow. Active flights are opened in place, so they do
 *  not need a second start request. */
export type DemoFlightLaunch =
  | { kind: 'open'; flightId: string }
  | { kind: 'start'; body: StartFlightBody }

export function demoFlightLaunch(
  kind: DemoFlightActionKind,
  feature: string,
  entry: FlightEntryOptions,
): DemoFlightLaunch {
  const stage = DEMO_FLIGHT_STAGE[kind]
  // Every start below is a demo start, so it claims the invoked workflow's
  // Getting Started card — the same key the MCP skill path claims.
  const demo = { gettingStartedSource: 'internal', gettingStartedWorkflow: kind } as const
  if (entry.active && entry.flight) return { kind: 'open', flightId: entry.flight.flightId }
  if (entry.flight) {
    // Paused → resume, never jump: the R78 jump wipe resets the entry stage and
    // everything after it, which on a paused specs-coverage flight silently
    // deleted every spec — the shipped one included. Only a settled record
    // re-enters via jump (where the wipe IS the point: re-demo does real work).
    return {
      kind: 'start',
      body: entry.canContinue
        ? { feature, mode: 'continue', autopilot: true, ...demo }
        : { feature, mode: 'jump', fromStage: stage, autopilot: true, ...demo },
    }
  }
  return {
    kind: 'start',
    body: {
      feature,
      repoPaths: entry.prefill.repoPaths,
      description: entry.prefill.description,
      env: entry.prefill.env,
      coverageTarget: entry.prefill.coverageTarget,
      fromStage: stage,
      autopilot: true,
      ...demo,
    },
  }
}

/** Whether the chooser has ever been opened. One flag, not per-option: opening it
 *  is what retires the prompt, regardless of which demo (if any) was picked. */
export function readDemoSeen(): boolean {
  return readStored(SEEN_KEY) === '1'
}

/** Private-mode / quota drops the write — the dot just comes back next load. */
export function writeDemoSeen(): void {
  writeStored(SEEN_KEY, '1')
}

export interface DemoInput {
  samples: OnboardingSamples | null
  runs: RunIndexEntry[]
  flights: FlightIndexEntry[]
  seen: boolean
  /** The workspace's `showDemo` setting. Null while the config is still loading —
   *  treated as "not yet", so the pill fades in rather than flashing on and off
   *  for a workspace that has turned the demos off. */
  showDemo: boolean | null
}

export interface DemoAvailability {
  /** At least one shipped workflow fixture is still executable. */
  hasSamples: boolean
  /** Render the launcher pill at all. The historical `showDemo` setting is the
   *  user's explicit visibility choice. */
  available: boolean
  /** Attention dot on the pill: the chooser has never been opened. */
  unseen: boolean
  /** Open the guide unprompted only in a workspace with no run or flight yet. */
  autoOpen: boolean
}

export function deriveDemoAvailability(input: DemoInput): DemoAvailability {
  const { samples, runs, flights, seen, showDemo } = input
  const hasSamples = Boolean(samples && (
    samples.workflows?.some((workflow) => workflow.internalAction !== null)
    || samples.sampleSuite
    || samples.sampleFlightRepo
  ))
  const available = showDemo === true
  if (!available) return { hasSamples, available: false, unseen: false, autoOpen: false }

  const fresh = runs.length === 0 && flights.length === 0
  return { hasSamples, available: true, unseen: !seen, autoOpen: !seen && fresh }
}

export interface DemoLauncher extends DemoAvailability {
  /** Server-owned sequence, prompts, and actions for this exact workspace. */
  workflows: OnboardingWorkflow[]
  session: GettingStartedSessionState
  /** The shipped worked suite, or null once it (or its product repo) is gone. */
  suite: string | null
  /** Record that the chooser has been opened — clears the dot and the auto-open. */
  markSeen: () => void
  /** The workspace's current `showDemo` setting (null while loading) — drives the
   *  chooser's own checkbox. */
  showDemo: boolean | null
  /** Persist a new `showDemo` to canary-lab.config.json. Optimistic: the checkbox
   *  reflects the choice immediately and reverts if the write fails, so a
   *  read-only config can't leave the box lying about what is on disk. */
  setShowDemo: (next: boolean) => void
}

/**
 * Reads the workspace's sample catalog and shared demo session. Workspace
 * events refresh it quickly; a small fallback poll closes the best-effort push
 * gap when an external agent starts from another client.
 */
export function useDemoLauncher(runs: RunIndexEntry[], flights: FlightIndexEntry[]): DemoLauncher {
  const { value: samples } = useLiveResource('onboarding', 'workspace',
    () => configApi.getOnboardingSamples(), { reconcileMs: 5000 })
  const [seen, setSeen] = useState<boolean>(() => readDemoSeen())
  const config = useProjectConfig()
  const acceptConfig = config.accept
  const mounted = useMountedIdentity('demo-visibility')
  const [optimistic, setOptimistic] = useState<boolean | null>(null)
  const writes = useRef<{ running: boolean; pending: { value: boolean } | null }>({ running: false, pending: null })
  const showDemo = optimistic ?? (config.value ? config.value.showDemo !== false : null)

  const availability = useMemo(
    () => deriveDemoAvailability({ samples, runs, flights, seen, showDemo }),
    [samples, runs, flights, seen, showDemo],
  )
  const session = useMemo(
    () => deriveGettingStartedRunSession(
      samples?.session ?? { active: null, completed: {} },
      samples?.workflows ?? [],
      runs,
    ),
    [samples, runs],
  )

  const markSeen = useCallback(() => {
    writeDemoSeen()
    setSeen(true)
  }, [])

  const setShowDemo = useCallback((next: boolean) => {
    if (!mounted()) return
    writes.current.pending = { value: next }
    setOptimistic(next)
    if (writes.current.running) return
    const reset = () => { writes.current.running = false }
    const drain = async () => {
      writes.current.running = true
      try {
        while (mounted() && writes.current.pending) {
          const submitted = writes.current.pending
          try {
            const saved = await configApi.putProjectConfig({ showDemo: submitted.value })
            if (!acceptConfig(saved)) return
          } catch {
            // A failed toggle exposes the newest confirmed settings, not an
            // old value captured before intervening reads or clicks.
          }
          if (!mounted()) return
          if (writes.current.pending === submitted) {
            writes.current.pending = null
            setOptimistic(null)
          }
        }
      } finally { reset() }
    }
    void drain().catch(reset)
  }, [mounted, acceptConfig])

  return {
    ...availability,
    workflows: samples?.workflows ?? [],
    session,
    suite: samples?.sampleSuite ?? null,
    markSeen,
    showDemo,
    setShowDemo,
  }
}
