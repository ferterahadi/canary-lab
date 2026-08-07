import { describe, it, expect, beforeEach } from 'vitest'
import type { OnboardingSamples } from '@/shared/api/client'
import type { RunIndexEntry } from '@/shared/api/types'
import type { FlightIndexEntry } from '@shared/flights/types'
import { deriveGuideStep, readDismissedSteps, writeDismissedStep, type GuideStep } from './first-run-guide'

const SAMPLES: OnboardingSamples = {
  sampleSuite: 'storefront_journey',
  sampleFlightRepo: '/w/flight-app',
  sampleFlightDescription: 'the lending flow',
}

function run(over: Partial<RunIndexEntry> = {}): RunIndexEntry {
  return {
    runId: 'r1',
    feature: 'storefront_journey',
    startedAt: '2026-08-07T10:00:00Z',
    status: 'passed',
    ...over,
  } as RunIndexEntry
}

function step(over: {
  samples?: OnboardingSamples | null
  runs?: RunIndexEntry[]
  flights?: FlightIndexEntry[]
  dismissed?: GuideStep[]
} = {}): GuideStep | null {
  return deriveGuideStep({
    samples: over.samples === undefined ? SAMPLES : over.samples,
    runs: over.runs ?? [],
    flights: over.flights ?? [],
    dismissed: new Set(over.dismissed ?? []),
  })
}

describe('deriveGuideStep', () => {
  it('says nothing until the samples have been read', () => {
    expect(step({ samples: null })).toBeNull()
  })

  it('opens on the run step for an untouched workspace', () => {
    expect(step()).toBe('run-suite')
  })

  it('retires the run step the moment a run exists, even before it settles', () => {
    expect(step({ runs: [run({ status: 'running' })] })).toBeNull()
  })

  // A boot holds services without running the suite — it is not the thing the
  // card is asking the user to watch.
  it('ignores boot, benchmark and verify runs', () => {
    for (const executionType of ['boot', 'benchmark', 'verify'] as const) {
      expect(step({ runs: [run({ executionType })] })).toBe('run-suite')
    }
  })

  it('ignores runs of some other suite', () => {
    expect(step({ runs: [run({ feature: 'checkout' })] })).toBe('run-suite')
  })

  it('offers the flight step once the sample suite has gone green', () => {
    expect(step({ runs: [run({ status: 'passed' })] })).toBe('start-flight')
  })

  // The flight step's pitch is "now watch one get built from nothing", which
  // only lands after the user has seen a finished one work.
  it('offers nothing while the sample suite is still failing', () => {
    expect(step({ runs: [run({ status: 'failed' })] })).toBeNull()
  })

  it('retires the flight step once any flight exists', () => {
    expect(step({ runs: [run()], flights: [{ flightId: 'fl_1' } as FlightIndexEntry] })).toBeNull()
  })

  it('drops a step whose sample was deleted', () => {
    expect(step({ samples: { ...SAMPLES, sampleSuite: null } })).toBeNull()
    expect(step({ runs: [run()], samples: { ...SAMPLES, sampleFlightRepo: null } })).toBeNull()
  })

  // Per-step, so waving off "press Run" does not also hide the Flight step the
  // user has not seen yet.
  it('dismissal is per step', () => {
    expect(step({ dismissed: ['run-suite'] })).toBeNull()
    expect(step({ runs: [run()], dismissed: ['run-suite'] })).toBe('start-flight')
    expect(step({ runs: [run()], dismissed: ['start-flight'] })).toBeNull()
  })
})

describe('dismissal storage', () => {
  beforeEach(() => { window.localStorage.clear() })

  it('round-trips and accumulates', () => {
    expect(readDismissedSteps().size).toBe(0)
    writeDismissedStep('run-suite')
    expect([...readDismissedSteps()]).toEqual(['run-suite'])
    writeDismissedStep('start-flight')
    expect([...readDismissedSteps()].sort()).toEqual(['run-suite', 'start-flight'])
  })

  it('is idempotent', () => {
    writeDismissedStep('run-suite')
    writeDismissedStep('run-suite')
    expect([...readDismissedSteps()]).toEqual(['run-suite'])
  })

  it('reads corrupt storage as nothing dismissed rather than throwing', () => {
    window.localStorage.setItem('canary-lab:first-run-guide-dismissed', '{oops')
    expect(readDismissedSteps().size).toBe(0)
    window.localStorage.setItem('canary-lab:first-run-guide-dismissed', '"not-an-array"')
    expect(readDismissedSteps().size).toBe(0)
  })

  it('drops non-string entries', () => {
    window.localStorage.setItem('canary-lab:first-run-guide-dismissed', '["run-suite", 7, null]')
    expect([...readDismissedSteps()]).toEqual(['run-suite'])
  })
})
