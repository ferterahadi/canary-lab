import { describe, it, expect, beforeEach } from 'vitest'
import type { FlightEntryOptions, OnboardingSamples } from '@/shared/api/client'
import type { RunIndexEntry } from '@/shared/api/types'
import type { FlightIndexEntry } from '@shared/flights/types'
import {
  DEMO_FLIGHT_STAGE,
  demoFlightLaunch,
  deriveDemoAvailability,
  deriveGettingStartedRunSession,
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
    // 'coverage' is deliberately absent: routing it through specs-coverage
    // authored the missing spec instead of reporting the gap (see App).
    expect(DEMO_FLIGHT_STAGE).toEqual({
      export: 'evaluation-export',
      author: 'specs-coverage',
      portify: 'portify',
    })
  })

  it('starts a fresh Flight directly at the requested stage', () => {
    expect(demoFlightLaunch('portify', 'workflow-workbench', flightEntry())).toEqual({
      kind: 'start',
      body: {
        feature: 'workflow-workbench',
        repoPaths: ['/workspace/workflow-app'],
        description: 'Prepared workflow app',
        env: 'local',
        coverageTarget: 85,
        fromStage: 'portify',
        autopilot: true,
        gettingStartedSource: 'internal',
        gettingStartedWorkflow: 'portify',
      },
    })
  })

  it('resumes a paused Flight instead of jumping — the jump wipe deleted its specs', () => {
    // R78: jump wipes the entry stage and everything after it, which on a
    // paused specs-coverage flight discarded every spec, the shipped one
    // included. A paused record must come back via resume (never wipes).
    const entry = flightEntry({
      canContinue: true,
      flight: { flightId: 'fl_1', status: 'paused', stages: [] },
    })
    expect(demoFlightLaunch('export', 'workflow-workbench', entry)).toEqual({
      kind: 'start',
      body: {
        feature: 'workflow-workbench',
        mode: 'continue',
        autopilot: true,
        gettingStartedSource: 'internal',
        gettingStartedWorkflow: 'export',
      },
    })
  })

  it('jumps a settled Flight to the requested stage — a re-demo redoes real work', () => {
    const entry = flightEntry({
      flight: { flightId: 'fl_1', status: 'completed', stages: [] },
    })
    expect(demoFlightLaunch('export', 'workflow-workbench', entry)).toEqual({
      kind: 'start',
      body: {
        feature: 'workflow-workbench',
        mode: 'jump',
        fromStage: 'evaluation-export',
        autopilot: true,
        gettingStartedSource: 'internal',
        gettingStartedWorkflow: 'export',
      },
    })
  })

  it('opens an active Flight without starting another conductor', () => {
    const entry = flightEntry({
      active: true,
      flight: { flightId: 'fl_1', status: 'running', stages: [] },
    })
    expect(demoFlightLaunch('author', 'workflow-workbench', entry)).toEqual({
      kind: 'open',
      flightId: 'fl_1',
    })
  })
})

describe('Getting Started Run state', () => {
  const workflows = [
    {
      id: 'run',
      internalAction: { kind: 'run', feature: 'storefront-journey' },
    },
    {
      id: 'heal',
      internalAction: { kind: 'heal', feature: 'workflow-workbench' },
    },
    {
      id: 'coverage',
      internalAction: { kind: 'coverage', feature: 'workflow-workbench' },
    },
    {
      id: 'flight',
      internalAction: null,
    },
  ] as OnboardingSamples['workflows']

  it('recovers the latest completed result from the live run index', () => {
    expect(deriveGettingStartedRunSession(
      { active: null, completed: {} },
      workflows,
      [run({ runId: 'r-passed', status: 'passed', endedAt: '2026-08-11T00:01:00.000Z' })],
    )).toEqual({
      active: null,
      completed: {
        run: {
          workflow: 'run',
          owner: 'internal',
          target: { kind: 'run', id: 'r-passed' },
          status: 'passed',
          startedAt: '2026-08-11T00:00:00.000Z',
          endedAt: '2026-08-11T00:01:00.000Z',
        },
      },
    })
  })

  it('shows the newest active catalogued suite and ignores non-run sessions', () => {
    const session = deriveGettingStartedRunSession(
      { active: null, completed: {} },
      workflows,
      [
        run({ runId: 'r-old', status: 'running' }),
        run({ runId: 'r-heal', feature: 'workflow-workbench', status: 'healing', startedAt: '2026-08-11T00:02:00.000Z' }),
        run({ runId: 'r-verify', status: 'running', executionType: 'verify', startedAt: '2026-08-11T00:03:00.000Z' }),
        run({ runId: 'r-boot', status: 'running', executionType: 'boot', startedAt: '2026-08-11T00:03:30.000Z' }),
        run({ runId: 'r-other', feature: 'checkout', status: 'running', startedAt: '2026-08-11T00:04:00.000Z' }),
      ],
    )
    expect(session.active).toMatchObject({
      workflow: 'heal',
      target: { kind: 'run', id: 'r-heal' },
    })
  })

  it('settles a linked active card on the terminal run frame', () => {
    const session = deriveGettingStartedRunSession(
      {
        active: {
          sessionId: 'gs-1',
          workflow: 'run',
          owner: 'external',
          target: { kind: 'run', id: 'r1' },
          startedAt: '2026-08-11T00:00:00.000Z',
          updatedAt: '2026-08-11T00:00:10.000Z',
        },
        completed: {},
      },
      workflows,
      [run({ status: 'passed', endedAt: '2026-08-11T00:01:00.000Z' })],
    )
    expect(session.active).toBeNull()
    expect(session.completed.run).toMatchObject({
      owner: 'external',
      status: 'passed',
      target: { kind: 'run', id: 'r1' },
    })
  })

  it('keeps a linked active card while its run is still non-terminal', () => {
    const active = {
      sessionId: 'gs-1',
      workflow: 'run' as const,
      owner: 'external' as const,
      target: { kind: 'run' as const, id: 'r1' },
      startedAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:10.000Z',
    }
    const session = deriveGettingStartedRunSession(
      { active, completed: {} },
      workflows,
      [run({ status: 'running' })],
    )
    expect(session.active).toBe(active)
    expect(session.completed).toEqual({})
  })

  it('keeps the first active catalogued run when later history is older', () => {
    const session = deriveGettingStartedRunSession(
      { active: null, completed: {} },
      workflows,
      [
        run({ runId: 'r-new', status: 'running', startedAt: '2026-08-11T00:03:00.000Z' }),
        run({ runId: 'r-old', status: 'running', startedAt: '2026-08-11T00:01:00.000Z' }),
      ],
    )
    expect(session.active?.target).toEqual({ kind: 'run', id: 'r-new' })
  })

  it('does not replace newer durable completion evidence with older history', () => {
    const newer = {
      workflow: 'run' as const,
      owner: 'external' as const,
      target: { kind: 'run' as const, id: 'r-newer' },
      status: 'failed',
      startedAt: '2026-08-11T00:05:00.000Z',
      endedAt: '2026-08-11T00:06:00.000Z',
    }
    const session = deriveGettingStartedRunSession(
      { active: null, completed: { run: newer } },
      workflows,
      [run({ status: 'passed', endedAt: '2026-08-11T00:01:00.000Z' })],
    )
    expect(session.completed.run).toBe(newer)
  })

  it('settles an active card without replacing newer durable evidence', () => {
    const newer = {
      workflow: 'run' as const,
      owner: 'external' as const,
      target: { kind: 'run' as const, id: 'r-newer' },
      status: 'passed',
      startedAt: '2026-08-11T00:05:00.000Z',
      endedAt: '2026-08-11T00:06:00.000Z',
    }
    const session = deriveGettingStartedRunSession(
      {
        active: {
          sessionId: 'gs-1', workflow: 'run', owner: 'external', target: { kind: 'run', id: 'r1' },
          startedAt: '2026-08-11T00:00:00.000Z', updatedAt: '2026-08-11T00:00:10.000Z',
        },
        completed: { run: newer },
      },
      workflows,
      [run({ status: 'passed', endedAt: '2026-08-11T00:01:00.000Z' })],
    )
    expect(session.active).toBeNull()
    expect(session.completed.run).toBe(newer)
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

// Mirrors the module-private key; asserted on so a rename cannot leave these
// tests writing a key the code no longer reads.
const SEEN_KEY = 'canary-lab:demo-seen'

/** Makes `window.localStorage` unavailable the way a private-mode browser does —
 *  the property access itself throws.
 *
 *  Patching `window.localStorage.getItem` (or `Storage.prototype.getItem`) does
 *  NOT work here: happy-dom serves the store through an accessor whose methods a
 *  spy never reaches, so an instance- or prototype-level stub is silently
 *  ignored and the assertion below passes against a working, merely-empty store
 *  — proving the default rather than the failure it names. */
function withUnavailableStorage(body: () => void): void {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage')!
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() { throw new Error('storage is denied in private mode') },
  })
  try {
    body()
  } finally {
    Object.defineProperty(window, 'localStorage', original)
  }
}

describe('demo-seen storage', () => {
  beforeEach(() => { window.localStorage.clear() })

  it('round-trips the seen flag', () => {
    expect(readDemoSeen()).toBe(false)
    writeDemoSeen()
    expect(readDemoSeen()).toBe(true)
    expect(window.localStorage.getItem(SEEN_KEY)).toBe('1')
  })

  it('reads false when storage is unavailable', () => {
    // Seeded first, so a stub that failed to take would read `true` and the
    // test would fail loudly instead of passing on the empty-store default.
    window.localStorage.setItem(SEEN_KEY, '1')

    withUnavailableStorage(() => { expect(readDemoSeen()).toBe(false) })

    expect(readDemoSeen()).toBe(true)
  })

  it('swallows a failed write rather than breaking the dialog', () => {
    withUnavailableStorage(() => { expect(() => writeDemoSeen()).not.toThrow() })

    // Nothing was written, so the dot comes back on the next load.
    expect(readDemoSeen()).toBe(false)
  })
})
