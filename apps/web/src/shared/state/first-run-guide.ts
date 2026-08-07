import { useEffect, useMemo, useState } from 'react'
import * as api from '@/shared/api/client'
import type { OnboardingSamples } from '@/shared/api/client'
import type { RunIndexEntry } from '@/shared/api/types'
import type { FlightIndexEntry } from '@shared/flights/types'

// The first-run guide: what a brand-new workspace should do next.
//
// `init` lands a demonstration of both halves of the product — a worked suite to
// run and repair, and a bare repo for a Flight to onboard — and until now the UI
// said nothing about either. A new user landed on a suite list and had to guess.
//
// Two rules shape this:
//
//   • DERIVED, never a flag file. "Has this workspace ever run anything" is a
//     fact about the runs index; a `firstRunDone` marker would lie the moment
//     someone cleaned their logs, and would need migrating forever. The only
//     stored state is which steps the user waved off.
//   • ONE owner. The two steps render in two different columns — beside the Run
//     button, and under the suite list — because that is where their targets
//     are. Both read this single derivation, so they can never disagree about
//     which step the workspace is on.

export type GuideStep = 'run-suite' | 'start-flight'

const DISMISSED_KEY = 'canary-lab:first-run-guide-dismissed'

/** Step ids the user has waved off. Per-step, not one global switch: dismissing
 *  "press Run" must not also rob them of the Flight step they never saw. */
export function readDismissedSteps(): Set<GuideStep> {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return new Set(Array.isArray(parsed) ? (parsed.filter((v) => typeof v === 'string') as GuideStep[]) : [])
  } catch {
    return new Set()
  }
}

export function writeDismissedStep(step: GuideStep): Set<GuideStep> {
  const next = readDismissedSteps()
  next.add(step)
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...next]))
  } catch {
    // Private-mode / quota — the step just reappears next load. Not worth failing over.
  }
  return next
}

export interface GuideInput {
  samples: OnboardingSamples | null
  runs: RunIndexEntry[]
  flights: FlightIndexEntry[]
  dismissed: Set<GuideStep>
}

/** A run of the sample suite that actually reached a verdict — boots and
 *  benchmarks are not the thing the guide is asking the user to watch. */
function sampleRunsOf(runs: RunIndexEntry[], suite: string): RunIndexEntry[] {
  return runs.filter(
    (r) =>
      r.feature === suite &&
      r.executionType !== 'boot' &&
      r.executionType !== 'benchmark' &&
      r.executionType !== 'verify',
  )
}

/**
 * Which step this workspace is on, or null when the guide has nothing to say.
 *
 * Step 1 retires as soon as a run exists — including one still in flight, so the
 * card does not sit there telling the user to press a button they just pressed.
 * Step 2 only appears once the repair loop has actually gone green: its pitch is
 * "now watch Canary build one of these from nothing", which only lands after the
 * user has seen a finished one work.
 */
export function deriveGuideStep(input: GuideInput): GuideStep | null {
  const { samples, runs, flights, dismissed } = input
  if (!samples) return null

  if (samples.sampleSuite && !dismissed.has('run-suite')) {
    if (sampleRunsOf(runs, samples.sampleSuite).length === 0) return 'run-suite'
  }
  if (samples.sampleFlightRepo && !dismissed.has('start-flight') && flights.length === 0) {
    const passed = samples.sampleSuite
      ? sampleRunsOf(runs, samples.sampleSuite).some((r) => r.status === 'passed')
      : false
    if (passed) return 'start-flight'
  }
  return null
}

export interface FirstRunGuide {
  step: GuideStep | null
  /** Everything step 2's launcher needs to open a new flight already filled in,
   *  so the tour is one click rather than "now find the repo". Null when the
   *  sample repo has been deleted. */
  flightPrefill: { repoPaths: string[]; description: string } | null
  /** The suite step 1 points at. Null when it has been deleted. */
  suite: string | null
  dismiss: (step: GuideStep) => void
}

/**
 * Reads the workspace's sample state once per mount. The samples are files on
 * disk that only `init` writes and only a human deletes, so there is nothing to
 * subscribe to — while the run/flight halves of the derivation come from live
 * context data the caller already holds, which is what makes the card retire the
 * moment a run starts.
 */
export function useFirstRunGuide(runs: RunIndexEntry[], flights: FlightIndexEntry[]): FirstRunGuide {
  const [samples, setSamples] = useState<OnboardingSamples | null>(null)
  const [dismissed, setDismissed] = useState<Set<GuideStep>>(() => readDismissedSteps())

  useEffect(() => {
    let alive = true
    api.getOnboardingSamples()
      .then((s) => { if (alive) setSamples(s) })
      .catch(() => { /* an older server has no such route — the guide stays silent */ })
    return () => { alive = false }
  }, [])

  const step = useMemo(
    () => deriveGuideStep({ samples, runs, flights, dismissed }),
    [samples, runs, flights, dismissed],
  )

  return {
    step,
    flightPrefill: samples?.sampleFlightRepo
      ? { repoPaths: [samples.sampleFlightRepo], description: samples.sampleFlightDescription ?? '' }
      : null,
    suite: samples?.sampleSuite ?? null,
    dismiss: (s) => setDismissed(writeDismissedStep(s)),
  }
}
