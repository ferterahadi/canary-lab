import { describe, it, expect, beforeEach } from 'vitest'
import type { OnboardingSamples } from '@/shared/api/client'
import type { RunIndexEntry } from '@/shared/api/types'
import type { FlightIndexEntry } from '@shared/flights/types'
import { deriveDemoAvailability, readDemoSeen, writeDemoSeen, type DemoInput } from './demo-launcher'

const SAMPLES: OnboardingSamples = {
  sampleSuite: 'storefront-journey',
  sampleFlightRepo: '/w/flight-app',
  sampleFlightDescription: 'the ordering flow',
}

const run = (over: Partial<RunIndexEntry> = {}): RunIndexEntry => ({
  runId: 'r1',
  feature: 'storefront-journey',
  status: 'failed',
  startedAt: '2026-08-11T00:00:00.000Z',
  ...over,
} as RunIndexEntry)

const flight = (): FlightIndexEntry => ({ flightId: 'fl_1', feature: 'x' } as FlightIndexEntry)

const input = (over: Partial<DemoInput> = {}): DemoInput => ({
  samples: SAMPLES,
  runs: [],
  flights: [],
  seen: false,
  showDemo: true,
  ...over,
})

describe('deriveDemoAvailability', () => {
  it('offers and auto-opens on an untouched workspace', () => {
    expect(deriveDemoAvailability(input())).toEqual({ hasSamples: true, available: true, unseen: true, autoOpen: true })
  })

  it('stays silent until the samples have loaded', () => {
    // Null samples is "still fetching", not "deleted" — flashing a pill on and
    // then off would be worse than arriving a beat late.
    expect(deriveDemoAvailability(input({ samples: null }))).toEqual({ hasSamples: false, available: false, unseen: false, autoOpen: false })
  })

  it('stays silent while the config is still loading', () => {
    expect(deriveDemoAvailability(input({ showDemo: null })).available).toBe(false)
  })

  it('hides everything when the workspace turned demos off', () => {
    expect(deriveDemoAvailability(input({ showDemo: false }))).toEqual({ hasSamples: true, available: false, unseen: false, autoOpen: false })
  })

  it('hides the pill once both samples are deleted — never a dead button', () => {
    const gone = { sampleSuite: null, sampleFlightRepo: null, sampleFlightDescription: null }
    expect(deriveDemoAvailability(input({ samples: gone })).available).toBe(false)
  })

  it('reports hasSamples independently of showDemo, so the open dialog survives an untick', () => {
    // The chooser's own checkbox writes `showDemo`. If the dialog were gated on
    // it, unticking the box would make the dialog vanish mid-click.
    expect(deriveDemoAvailability(input({ showDemo: false })).hasSamples).toBe(true)
    const gone = { sampleSuite: null, sampleFlightRepo: null, sampleFlightDescription: null }
    expect(deriveDemoAvailability(input({ samples: gone })).hasSamples).toBe(false)
  })

  it('still offers the pill when only one sample survives', () => {
    const suiteOnly = { ...SAMPLES, sampleFlightRepo: null }
    expect(deriveDemoAvailability(input({ samples: suiteOnly })).available).toBe(true)
  })

  it('keeps the pill but drops the dot and the auto-open once opened', () => {
    expect(deriveDemoAvailability(input({ seen: true }))).toEqual({ hasSamples: true, available: true, unseen: false, autoOpen: false })
  })

  it('does not auto-open a workspace that has already run the sample', () => {
    const d = deriveDemoAvailability(input({ runs: [run({ status: 'passed' })] }))
    expect(d).toEqual({ hasSamples: true, available: true, unseen: true, autoOpen: false })
  })

  it('counts a failed sample run as "already seen it work" for auto-open', () => {
    // The point of the gate is "has anyone used this workspace", not "did it
    // pass" — a failed run still means somebody is here and working.
    expect(deriveDemoAvailability(input({ runs: [run({ status: 'failed' })] })).autoOpen).toBe(false)
  })

  it('ignores boot, benchmark and verify runs — none of them is the demo', () => {
    const noise = [
      run({ runId: 'b', executionType: 'boot' }),
      run({ runId: 'm', executionType: 'benchmark' }),
      run({ runId: 'v', executionType: 'verify' }),
    ]
    expect(deriveDemoAvailability(input({ runs: noise })).autoOpen).toBe(true)
  })

  it('ignores runs belonging to another suite', () => {
    expect(deriveDemoAvailability(input({ runs: [run({ feature: 'other' })] })).autoOpen).toBe(true)
  })

  it('does not auto-open a workspace that already has a flight', () => {
    expect(deriveDemoAvailability(input({ flights: [flight()] })).autoOpen).toBe(false)
  })

  it('treats a deleted suite as no run history to check', () => {
    const flightOnly = { ...SAMPLES, sampleSuite: null }
    // No suite means `sampleRunsOf` has nothing to match — the workspace is
    // still fresh as far as the flight half is concerned.
    expect(deriveDemoAvailability(input({ samples: flightOnly, runs: [run()] })).autoOpen).toBe(true)
  })
})

describe('demo-seen storage', () => {
  beforeEach(() => { window.localStorage.clear() })

  it('round-trips the seen flag', () => {
    expect(readDemoSeen()).toBe(false)
    writeDemoSeen()
    expect(readDemoSeen()).toBe(true)
  })

  it('reads false when storage throws', () => {
    const original = window.localStorage.getItem
    window.localStorage.getItem = () => { throw new Error('denied') }
    try {
      expect(readDemoSeen()).toBe(false)
    } finally {
      window.localStorage.getItem = original
    }
  })

  it('swallows a failed write rather than breaking the dialog', () => {
    const original = window.localStorage.setItem
    window.localStorage.setItem = () => { throw new Error('quota') }
    try {
      expect(() => writeDemoSeen()).not.toThrow()
    } finally {
      window.localStorage.setItem = original
    }
  })
})
