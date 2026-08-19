import { describe, it, expect, beforeEach } from 'vitest'
import type { FlightEntryOptions, OnboardingSamples } from '@/shared/api/client'
import type { RunIndexEntry } from '@/shared/api/types'
import type { FlightIndexEntry } from '@shared/flights/types'
import {
  DEMO_FLIGHT_STAGE,
  demoFlightLaunch,
  deriveDemoAvailability,
  readDemoSeen,
  writeDemoSeen,
  type DemoInput,
} from './demo-launcher'

const SAMPLES: OnboardingSamples = {
  sampleSuite: 'storefront-journey',
  sampleFlightRepo: '/w/flight-app',
  sampleFlightDescription: 'the ordering flow',
  workflows: [],
  session: { active: null, completed: {} },
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

const flightEntry = (over: Partial<FlightEntryOptions> = {}): FlightEntryOptions => ({
  feature: 'workflow-workbench',
  flight: null,
  active: false,
  canContinue: false,
  prefill: {
    repoPaths: ['/workspace/workflow-app'],
    description: 'Prepared workflow app',
    env: 'local',
    coverageTarget: 85,
  },
  stages: [],
  ...over,
})

describe('Getting Started Flight destinations', () => {
  it('maps each specialized workflow to its Flight tab', () => {
    expect(DEMO_FLIGHT_STAGE).toEqual({
      coverage: 'specs-coverage',
      export: 'evaluation-export',
      author: 'specs-coverage',
      portify: 'portify',
    })
  })

  it('starts a fresh Flight directly at the requested stage', () => {
    expect(demoFlightLaunch('workflow-workbench', 'portify', flightEntry())).toEqual({
      kind: 'start',
      body: {
        feature: 'workflow-workbench',
        repoPaths: ['/workspace/workflow-app'],
        description: 'Prepared workflow app',
        env: 'local',
        coverageTarget: 85,
        fromStage: 'portify',
        autopilot: false,
      },
    })
  })

  it('jumps an existing paused Flight to the requested stage', () => {
    const entry = flightEntry({
      flight: { flightId: 'fl_1', status: 'paused', stages: [] },
    })
    expect(demoFlightLaunch('workflow-workbench', 'evaluation-export', entry)).toEqual({
      kind: 'start',
      body: {
        feature: 'workflow-workbench',
        mode: 'jump',
        fromStage: 'evaluation-export',
        autopilot: false,
      },
    })
  })

  it('opens an active Flight without starting another conductor', () => {
    const entry = flightEntry({
      active: true,
      flight: { flightId: 'fl_1', status: 'running', stages: [] },
    })
    expect(demoFlightLaunch('workflow-workbench', 'specs-coverage', entry)).toEqual({
      kind: 'open',
      flightId: 'fl_1',
    })
  })
})

describe('deriveDemoAvailability', () => {
  it('offers and auto-opens on an untouched workspace', () => {
    expect(deriveDemoAvailability(input())).toEqual({ hasSamples: true, available: true, unseen: true, autoOpen: true })
  })

  it('offers the workflow guide while sample availability is loading', () => {
    expect(deriveDemoAvailability(input({ samples: null }))).toEqual({ hasSamples: false, available: true, unseen: true, autoOpen: true })
  })

  it('stays silent while the config is still loading', () => {
    expect(deriveDemoAvailability(input({ showDemo: null })).available).toBe(false)
  })

  it('hides Getting Started when the workspace turned it off', () => {
    expect(deriveDemoAvailability(input({ showDemo: false }))).toEqual({ hasSamples: true, available: false, unseen: false, autoOpen: false })
  })

  it('keeps the workflow guide after both samples are deleted', () => {
    const gone: OnboardingSamples = { sampleSuite: null, sampleFlightRepo: null, sampleFlightDescription: null, workflows: [], session: { active: null, completed: {} } }
    expect(deriveDemoAvailability(input({ samples: gone }))).toEqual({ hasSamples: false, available: true, unseen: true, autoOpen: true })
  })

  it('reports hasSamples independently of showDemo, so sample actions stay accurate', () => {
    // The guide's own checkbox writes `showDemo`. If the dialog were gated on
    // it, unticking the box would make the dialog vanish mid-click.
    expect(deriveDemoAvailability(input({ showDemo: false })).hasSamples).toBe(true)
    const gone: OnboardingSamples = { sampleSuite: null, sampleFlightRepo: null, sampleFlightDescription: null, workflows: [], session: { active: null, completed: {} } }
    expect(deriveDemoAvailability(input({ samples: gone })).hasSamples).toBe(false)
  })

  it('still reports a sample when only one survives', () => {
    const suiteOnly = { ...SAMPLES, sampleFlightRepo: null }
    expect(deriveDemoAvailability(input({ samples: suiteOnly })).available).toBe(true)
  })

  it('keeps the pill but drops the dot and the auto-open once opened', () => {
    expect(deriveDemoAvailability(input({ seen: true }))).toEqual({ hasSamples: true, available: true, unseen: false, autoOpen: false })
  })

  it('does not auto-open a workspace that already has a run', () => {
    const d = deriveDemoAvailability(input({ runs: [run({ status: 'passed' })] }))
    expect(d).toEqual({ hasSamples: true, available: true, unseen: true, autoOpen: false })
  })

  it('counts a failed run as an active workspace', () => {
    expect(deriveDemoAvailability(input({ runs: [run({ status: 'failed' })] })).autoOpen).toBe(false)
  })

  it('does not interrupt a workspace that already has boot, benchmark, or verify history', () => {
    const noise = [
      run({ runId: 'b', executionType: 'boot' }),
      run({ runId: 'm', executionType: 'benchmark' }),
      run({ runId: 'v', executionType: 'verify' }),
    ]
    expect(deriveDemoAvailability(input({ runs: noise })).autoOpen).toBe(false)
  })

  it('does not auto-open over work on another suite', () => {
    expect(deriveDemoAvailability(input({ runs: [run({ feature: 'other' })] })).autoOpen).toBe(false)
  })

  it('does not auto-open a workspace that already has a flight', () => {
    expect(deriveDemoAvailability(input({ flights: [flight()] })).autoOpen).toBe(false)
  })

  it('still respects run history after the sample suite is deleted', () => {
    const flightOnly = { ...SAMPLES, sampleSuite: null }
    expect(deriveDemoAvailability(input({ samples: flightOnly, runs: [run()] })).autoOpen).toBe(false)
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
