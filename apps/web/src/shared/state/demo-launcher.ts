import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '@/shared/api/client'
import type { GettingStartedSessionState, OnboardingSamples, OnboardingWorkflow } from '@/shared/api/client'
import type { StartFlightBody } from '@/shared/api/flights'
import type { RunIndexEntry } from '@/shared/api/types'
import type { FlightEntryOptions, FlightIndexEntry, FlightStageKey } from '@shared/flights/types'
import { useInvalidationKey } from './invalidation'

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
// instead (see App.handleDemoAction).
export type DemoFlightActionKind = 'export' | 'author' | 'portify'

export const DEMO_FLIGHT_STAGE: Record<DemoFlightActionKind, FlightStageKey> = {
  export: 'evaluation-export',
  author: 'specs-coverage',
  portify: 'portify',
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
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return false
  }
}

export function writeDemoSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // Private-mode / quota — the dot just comes back next load. Not worth failing over.
  }
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
  const [samples, setSamples] = useState<OnboardingSamples | null>(null)
  const [seen, setSeen] = useState<boolean>(() => readDemoSeen())
  const [showDemo, setShowDemoState] = useState<boolean | null>(null)
  // Bumped by workspace events, so external-agent starts and terminal evidence
  // appear while the dialog is open. A gentle poll backs the best-effort push.
  const onboardingKey = useInvalidationKey('onboarding')
  // Bumped by the `project-config-changed` WorkspaceEvent, so a `showDemo` flip
  // made anywhere — this tab's chooser, another browser, an edit to the file —
  // reaches the pill without a reload.
  const configKey = useInvalidationKey('project-config')

  useEffect(() => {
    let alive = true
    api.getOnboardingSamples()
      .then((s) => { if (alive) setSamples(s) })
      .catch(() => { /* an older server has no such route — the launcher stays silent */ })
    return () => { alive = false }
  }, [onboardingKey])

  useEffect(() => {
    // The workspace broadcast is a fast hint, not a guarantee. Poll this tiny
    // file-backed record so an external start is still discovered if its one
    // getting-started-changed frame was dropped.
    const id = window.setInterval(() => {
      api.getOnboardingSamples().then(setSamples).catch(() => {})
    }, 5000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    let alive = true
    api.getProjectConfig()
      .then((c) => { if (alive) setShowDemoState(c.showDemo !== false) })
      .catch(() => { /* no config, no pill */ })
    return () => { alive = false }
  }, [configKey])

  const availability = useMemo(
    () => deriveDemoAvailability({ samples, runs, flights, seen, showDemo }),
    [samples, runs, flights, seen, showDemo],
  )

  const markSeen = useCallback(() => {
    writeDemoSeen()
    setSeen(true)
  }, [])

  const setShowDemo = useCallback((next: boolean) => {
    const previous = showDemo
    setShowDemoState(next)
    void api.putProjectConfig({ showDemo: next }).catch(() => setShowDemoState(previous))
  }, [showDemo])

  return {
    ...availability,
    workflows: samples?.workflows ?? [],
    session: samples?.session ?? { active: null, completed: {} },
    suite: samples?.sampleSuite ?? null,
    markSeen,
    showDemo,
    setShowDemo,
  }
}
