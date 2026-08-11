import { useCallback, useEffect, useMemo, useState } from 'react'
import * as api from '@/shared/api/client'
import type { OnboardingSamples } from '@/shared/api/client'
import type { RunIndexEntry } from '@/shared/api/types'
import type { FlightIndexEntry } from '@shared/flights/types'
import { useInvalidationKey } from './invalidation'

// The demo launcher: what a brand-new workspace should try first.
//
// `init` lands a demonstration of both halves of the product — a worked suite to
// run and repair, and a bare repo for a Flight to onboard. Both are offered at
// once by the demo chooser (`DemoDialog`), because sequencing them hid the Flight
// half behind a repair the user had to sit through first.
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
  /** At least one shipped sample is still on disk. Guards the DIALOG — a deep
   *  link to `?dialog=demo` on a workspace whose samples are gone would
   *  otherwise open a chooser with nothing to choose.
   *
   *  Deliberately independent of `showDemo`: the chooser's own checkbox writes
   *  that setting, so gating the dialog on it would make the dialog vanish out
   *  from under the user the moment they untick the box. */
  hasSamples: boolean
  /** Render the launcher pill at all. False once both samples are deleted (there
   *  is nothing left to demo) or once the workspace has switched the demos off. */
  available: boolean
  /** Attention dot on the pill: the chooser has never been opened. */
  unseen: boolean
  /** Open the chooser unprompted. Only on a workspace that still has a sample
   *  AND has never produced a run verdict or a flight — otherwise this is
   *  somebody's working workspace and a dialog in their face is an interruption. */
  autoOpen: boolean
}

/** A run of the sample suite that actually reached a verdict — boots and
 *  benchmarks are not evidence that anyone has seen the product work. */
function sampleRunsOf(runs: RunIndexEntry[], suite: string): RunIndexEntry[] {
  return runs.filter(
    (r) =>
      r.feature === suite &&
      r.executionType !== 'boot' &&
      r.executionType !== 'benchmark' &&
      r.executionType !== 'verify',
  )
}

export function deriveDemoAvailability(input: DemoInput): DemoAvailability {
  const { samples, runs, flights, seen, showDemo } = input
  const hasSamples = Boolean(samples && (samples.sampleSuite || samples.sampleFlightRepo))
  const available = hasSamples && showDemo === true
  if (!available) return { hasSamples, available: false, unseen: false, autoOpen: false }

  const suite = samples?.sampleSuite ?? null
  const hasRun = suite ? sampleRunsOf(runs, suite).length > 0 : false
  const fresh = !hasRun && flights.length === 0
  return { hasSamples, available: true, unseen: !seen, autoOpen: !seen && fresh }
}

export interface DemoLauncher extends DemoAvailability {
  /** The shipped worked suite, or null once it (or its product repo) is gone. */
  suite: string | null
  /** Everything the flight demo's launcher needs already filled in, so the tour
   *  is one click rather than "now find the repo". Null when the sample repo has
   *  been deleted. */
  flightPrefill: { repoPaths: string[]; description: string } | null
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
 * Reads the workspace's sample state once per mount. The samples are files on
 * disk that only `init` writes and only a human deletes, so there is nothing to
 * subscribe to — while the run/flight halves of the derivation come from live
 * context data the caller already holds.
 */
export function useDemoLauncher(runs: RunIndexEntry[], flights: FlightIndexEntry[]): DemoLauncher {
  const [samples, setSamples] = useState<OnboardingSamples | null>(null)
  const [seen, setSeen] = useState<boolean>(() => readDemoSeen())
  const [showDemo, setShowDemoState] = useState<boolean | null>(null)
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
    suite: samples?.sampleSuite ?? null,
    flightPrefill: samples?.sampleFlightRepo
      ? { repoPaths: [samples.sampleFlightRepo], description: samples.sampleFlightDescription ?? '' }
      : null,
    markSeen,
    showDemo,
    setShowDemo,
  }
}
