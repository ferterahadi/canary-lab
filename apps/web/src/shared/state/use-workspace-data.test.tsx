// @vitest-environment happy-dom

import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Feature, RunIndexEntry } from '../api/types'
import type { FlightIndexEntry, FlightManifest, PlanFeaturesTask } from '../api/client'
import type { ConnectWorkspaceEventsOptions, WorkspaceEvent } from '../api/workspace-socket'
import type { InvalidationTopic } from './invalidation-bus'
import type { WorkspaceData, WorkspaceDataDeps } from './use-workspace-data'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The hook's whole job is orchestration: four REST loads, a flights push
// channel, a poll backstop and the /ws/workspace event fan-out. All three of
// those edges are module-level imports rather than injected deps, so they are
// mocked here; the wrappers themselves are covered against the real server
// contract in shared/api/*.test.ts, and `useFlightsStream` in its own suite.
const api = {
  listFeatures: vi.fn<() => Promise<Feature[]>>(),
  listFlights: vi.fn<() => Promise<FlightIndexEntry[]>>(),
  listPlanFeatures: vi.fn<() => Promise<{ tasks: PlanFeaturesTask[] }>>(),
  getVersionStatus: vi.fn(),
}
vi.mock('../api/client', () => api)

// Captures the options the hook connects with, so a test can drive `onEvent` /
// `onReconnect` synchronously instead of racing a real socket. `connectThrows`
// reproduces the no-WebSocket environment the hook's try/catch exists for.
const socket = {
  opts: null as ConnectWorkspaceEventsOptions | null,
  closes: 0,
  connectThrows: false,
}
vi.mock('../api/workspace-socket', () => ({
  connectWorkspaceEvents: (opts: ConnectWorkspaceEventsOptions) => {
    if (socket.connectThrows) throw new Error('no WebSocket in this environment')
    socket.opts = opts
    return { close: () => { socket.closes += 1 } }
  },
}))

const stream = { flights: [] as FlightIndexEntry[], details: {} as Record<string, FlightManifest>, hydrated: false }
vi.mock('@/features/flights', () => ({ useFlightsStream: () => stream }))

const { useWorkspaceData } = await import('./use-workspace-data')

function feature(name: string): Feature {
  return { name, repos: [] } as unknown as Feature
}

function run(runId: string, featureName: string, executionType?: string): RunIndexEntry {
  return { runId, feature: featureName, executionType } as unknown as RunIndexEntry
}

interface Harness {
  data: WorkspaceData
  invalidated: [InvalidationTopic, string | undefined][]
  selectedFeature: (string | null)[]
  selectedRunId: (string | null)[]
  renames: [string, string][]
  featureRef: { current: string | null }
  runIdRef: { current: string | null }
  pendingRef: { current: string | null }
}

let container: HTMLDivElement
let root: Root
let harness: Harness

// Module-level so their identity is stable across renders, exactly like the
// context-provided setters App passes in. An inline arrow here would retear the
// /ws/workspace connect effect on every render — the churn the hook's ref
// indirection exists to prevent — and the socket assertions would measure the
// harness rather than the hook.
const invalidate = (topic: InvalidationTopic, scope?: string): void => { harness.invalidated.push([topic, scope]) }
const setSelectedFeature = (f: string | null): void => { harness.featureRef.current = f; harness.selectedFeature.push(f) }
const setSelectedRunId = (r: string | null): void => { harness.runIdRef.current = r; harness.selectedRunId.push(r) }
const onRenamed = (from: string, to: string): void => { harness.renames.push([from, to]) }

// The two nav mirrors the hook writes through are real refs owned by the probe,
// so a test asserts the same way App observes them.
function Probe({ config }: { config: Partial<WorkspaceDataDeps> & { withRenameHandler?: boolean } }) {
  const featureRef = useRef<string | null>(harness.featureRef.current)
  const runIdRef = useRef<string | null>(harness.runIdRef.current)
  const pendingRef = useRef<string | null>(harness.pendingRef.current)
  harness.featureRef = featureRef
  harness.runIdRef = runIdRef
  harness.pendingRef = pendingRef
  harness.data = useWorkspaceData({
    invalidate,
    allRuns: [],
    initialSelectedFeature: null,
    setSelectedFeature,
    setSelectedRunId,
    selectedFeatureRef: featureRef,
    selectedRunIdRef: runIdRef,
    pendingRunSelectionRef: pendingRef,
    onFeatureRenamed: config.withRenameHandler ? onRenamed : undefined,
    ...config,
  })
  return null
}

async function mount(config: Partial<WorkspaceDataDeps> & { withRenameHandler?: boolean } = {}): Promise<void> {
  await act(async () => { root.render(<Probe config={config} />) })
}

async function fire(event: WorkspaceEvent): Promise<void> {
  await act(async () => { socket.opts?.onEvent(event) })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  harness = {
    data: null as unknown as WorkspaceData,
    invalidated: [], selectedFeature: [], selectedRunId: [], renames: [],
    featureRef: { current: null }, runIdRef: { current: null }, pendingRef: { current: null },
  }
  socket.opts = null
  socket.closes = 0
  socket.connectThrows = false
  stream.flights = []
  stream.details = {}
  stream.hydrated = false
  api.listFeatures.mockReset().mockResolvedValue([])
  api.listFlights.mockReset().mockResolvedValue([])
  api.listPlanFeatures.mockReset().mockResolvedValue({ tasks: [] })
  api.getVersionStatus.mockReset().mockResolvedValue({ current: '1.0.0' })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.useRealTimers()
})

describe('useWorkspaceData — initial loads', () => {
  it('loads features, flights, pre-flights and version on mount', async () => {
    api.listFeatures.mockResolvedValue([feature('checkout')])
    api.listFlights.mockResolvedValue([{ flightId: 'f1' } as FlightIndexEntry])
    api.listPlanFeatures.mockResolvedValue({ tasks: [{ taskId: 't1', status: 'done' } as PlanFeaturesTask] })

    await mount()

    expect(harness.data.features.map((f) => f.name)).toEqual(['checkout'])
    expect(harness.data.flights).toEqual([{ flightId: 'f1' }])
    expect(harness.data.preFlights).toEqual([{ taskId: 't1', status: 'done' }])
    expect(harness.data.versionStatus).toEqual({ current: '1.0.0' })
  })

  it('auto-selects the first feature only when none is hydrated', async () => {
    api.listFeatures.mockResolvedValue([feature('checkout'), feature('search')])

    await mount()

    expect(harness.selectedFeature).toEqual(['checkout'])
  })

  it('leaves the hydrated selection alone', async () => {
    api.listFeatures.mockResolvedValue([feature('checkout'), feature('search')])

    await mount({ initialSelectedFeature: 'search' })

    expect(harness.selectedFeature).toEqual([])
  })

  it('selects nothing when the workspace has no suites', async () => {
    await mount()

    expect(harness.selectedFeature).toEqual([])
    expect(harness.data.features).toEqual([])
  })

  it('survives every initial load rejecting', async () => {
    api.listFeatures.mockRejectedValue(new Error('offline'))
    api.listFlights.mockRejectedValue(new Error('offline'))
    api.listPlanFeatures.mockRejectedValue(new Error('offline'))
    api.getVersionStatus.mockRejectedValue(new Error('offline'))

    await mount()

    expect(harness.data.features).toEqual([])
    expect(harness.data.versionStatus).toBeNull()
  })

  it('drops a features response that lands after unmount', async () => {
    let settle: (value: Feature[]) => void = () => {}
    api.listFeatures.mockReturnValue(new Promise<Feature[]>((resolve) => { settle = resolve }))

    await mount()
    const captured = harness.data
    act(() => { root.unmount() })
    await act(async () => { settle([feature('checkout')]) })

    // The cancelled guard is the point: no setState after unmount, so the
    // snapshot the probe last returned still reads empty.
    expect(captured.features).toEqual([])
    expect(harness.selectedFeature).toEqual([])
  })
})

describe('useWorkspaceData — flights source', () => {
  it('serves the REST list until the push channel hydrates', async () => {
    api.listFlights.mockResolvedValue([{ flightId: 'rest' } as FlightIndexEntry])
    stream.flights = [{ flightId: 'pushed' } as FlightIndexEntry]

    await mount()

    expect(harness.data.flights).toEqual([{ flightId: 'rest' }])
  })

  it('prefers the push channel once hydrated, and exposes its manifests', async () => {
    api.listFlights.mockResolvedValue([{ flightId: 'rest' } as FlightIndexEntry])
    stream.flights = [{ flightId: 'pushed' } as FlightIndexEntry]
    stream.details = { pushed: { flightId: 'pushed' } as FlightManifest }
    stream.hydrated = true

    await mount()

    expect(harness.data.flights).toEqual([{ flightId: 'pushed' }])
    expect(harness.data.flightDetails).toEqual({ pushed: { flightId: 'pushed' } })
    expect(harness.data.flightsRef.current).toEqual([{ flightId: 'pushed' }])
  })
})

describe('useWorkspaceData — refreshFeatures selection', () => {
  it('selects a preferred feature and its latest non-boot run', async () => {
    await mount({
      allRuns: [
        run('boot-1', 'checkout', 'boot'),
        run('bench-1', 'checkout', 'benchmark'),
        run('test-1', 'checkout', 'test'),
      ],
    })
    api.listFeatures.mockResolvedValue([feature('checkout')])
    harness.pendingRef.current = 'stale'

    await act(async () => { harness.data.refreshFeatures('checkout') })

    expect(harness.selectedFeature.at(-1)).toBe('checkout')
    expect(harness.selectedRunId.at(-1)).toBe('test-1')
    expect(harness.pendingRef.current).toBeNull()
  })

  it('falls back to the first feature when the preferred one is gone', async () => {
    await mount({ allRuns: [run('test-9', 'search', 'test')] })
    api.listFeatures.mockResolvedValue([feature('search')])
    harness.featureRef.current = 'deleted'

    await act(async () => { harness.data.refreshFeatures('deleted') })

    expect(harness.selectedFeature.at(-1)).toBe('search')
    expect(harness.selectedRunId.at(-1)).toBe('test-9')
  })

  it('clears the selection when the last suite is deleted', async () => {
    await mount()
    api.listFeatures.mockResolvedValue([])
    harness.featureRef.current = 'deleted'

    await act(async () => { harness.data.refreshFeatures() })

    expect(harness.selectedFeature.at(-1)).toBeNull()
    expect(harness.selectedRunId.at(-1)).toBeNull()
  })

  it('selects a feature with no run of its own as run-less', async () => {
    await mount({ allRuns: [run('test-1', 'other', 'test')] })
    api.listFeatures.mockResolvedValue([feature('checkout')])

    await act(async () => { harness.data.refreshFeatures('checkout') })

    expect(harness.selectedRunId.at(-1)).toBeNull()
  })

  it('keeps a still-present selection untouched', async () => {
    api.listFeatures.mockResolvedValue([feature('checkout'), feature('search')])
    await mount({ initialSelectedFeature: 'search' })
    harness.featureRef.current = 'search'

    await act(async () => { harness.data.refreshFeatures() })

    expect(harness.selectedFeature).toEqual([])
  })

  it('swallows a failed refresh', async () => {
    await mount()
    api.listFeatures.mockRejectedValue(new Error('offline'))

    await act(async () => { harness.data.refreshFeatures('checkout') })

    expect(harness.selectedFeature).toEqual([])
  })
})

describe('useWorkspaceData — refresh helpers', () => {
  it('re-reads flights, pre-flights and version on demand', async () => {
    await mount()
    api.listFlights.mockResolvedValue([{ flightId: 'f2' } as FlightIndexEntry])
    api.listPlanFeatures.mockResolvedValue({ tasks: [{ taskId: 't2' } as PlanFeaturesTask] })
    api.getVersionStatus.mockResolvedValue({ current: '2.0.0' })

    await act(async () => {
      harness.data.refreshFlights()
      harness.data.refreshPreFlights()
      harness.data.refreshVersion()
    })

    expect(harness.data.flights).toEqual([{ flightId: 'f2' }])
    expect(harness.data.preFlights).toEqual([{ taskId: 't2' }])
    expect(harness.data.versionStatus).toEqual({ current: '2.0.0' })
  })

  it('swallows a failed on-demand refresh', async () => {
    await mount()
    api.listFlights.mockRejectedValue(new Error('offline'))
    api.listPlanFeatures.mockRejectedValue(new Error('offline'))
    api.getVersionStatus.mockRejectedValue(new Error('offline'))

    await act(async () => {
      harness.data.refreshFlights()
      harness.data.refreshPreFlights()
      harness.data.refreshVersion()
    })

    expect(harness.data.versionStatus).toEqual({ current: '1.0.0' })
  })
})

describe('useWorkspaceData — running pre-flight poll', () => {
  it('polls only while a plan is running, and stops when it settles', async () => {
    vi.useFakeTimers()
    api.listPlanFeatures.mockResolvedValue({ tasks: [{ taskId: 't1', status: 'running' } as PlanFeaturesTask] })

    await mount()
    const afterMount = api.listPlanFeatures.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
    expect(api.listPlanFeatures.mock.calls.length).toBe(afterMount + 1)

    // Settling the plan must clear the interval, not merely stop reading it.
    api.listPlanFeatures.mockResolvedValue({ tasks: [{ taskId: 't1', status: 'done' } as PlanFeaturesTask] })
    await act(async () => { await vi.advanceTimersByTimeAsync(2500) })
    const afterSettle = api.listPlanFeatures.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })

    expect(api.listPlanFeatures.mock.calls.length).toBe(afterSettle)
  })

  it('does not poll when no plan is running', async () => {
    vi.useFakeTimers()
    api.listPlanFeatures.mockResolvedValue({ tasks: [{ taskId: 't1', status: 'done' } as PlanFeaturesTask] })

    await mount()
    const afterMount = api.listPlanFeatures.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })

    expect(api.listPlanFeatures.mock.calls.length).toBe(afterMount)
  })
})

describe('useWorkspaceData — workspace events', () => {
  it('follows a rename of the selected suite', async () => {
    await mount({ withRenameHandler: true })
    harness.featureRef.current = 'old'
    api.listFeatures.mockResolvedValue([feature('new')])

    await fire({ type: 'feature-renamed', from: 'old', to: 'new' })

    expect(harness.renames).toEqual([['old', 'new']])
    expect(harness.selectedFeature.at(-1)).toBe('new')
    expect(harness.invalidated).toEqual([['flights', undefined], ['repos', undefined]])
  })

  it('keeps the current selection when some other suite is renamed', async () => {
    await mount({ withRenameHandler: true })
    harness.featureRef.current = 'checkout'
    api.listFeatures.mockResolvedValue([feature('checkout'), feature('new')])

    await fire({ type: 'feature-renamed', from: 'old', to: 'new' })

    expect(harness.renames).toEqual([['old', 'new']])
    // Re-asserted rather than moved: the refresh re-selects the same suite.
    expect(harness.selectedFeature).toEqual(['checkout'])
  })

  it('handles a rename with no handler wired', async () => {
    await mount()
    harness.featureRef.current = 'old'
    api.listFeatures.mockResolvedValue([feature('new')])

    await fire({ type: 'feature-renamed', from: 'old', to: 'new' })

    expect(harness.renames).toEqual([])
    expect(harness.selectedFeature.at(-1)).toBe('new')
  })

  it('re-points a rename handler swapped in after mount', async () => {
    await mount()
    await mount({ withRenameHandler: true })
    harness.featureRef.current = 'old'
    api.listFeatures.mockResolvedValue([feature('new')])

    await fire({ type: 'feature-renamed', from: 'old', to: 'new' })

    expect(harness.renames).toEqual([['old', 'new']])
  })

  it('selects a newly created suite', async () => {
    await mount()
    api.listFeatures.mockResolvedValue([feature('fresh')])

    await fire({ type: 'feature-created', feature: 'fresh' })

    expect(harness.selectedFeature.at(-1)).toBe('fresh')
    expect(harness.invalidated).toEqual([])
  })

  it('re-reads features on a delete without preferring one', async () => {
    await mount()
    harness.featureRef.current = 'gone'
    api.listFeatures.mockResolvedValue([feature('remaining')])

    await fire({ type: 'feature-deleted', feature: 'gone' })

    expect(harness.selectedFeature.at(-1)).toBe('remaining')
    expect(harness.invalidated).toEqual([])
  })

  it('invalidates repos on a bulk features change', async () => {
    await mount()

    await fire({ type: 'features-changed' })

    expect(harness.invalidated).toEqual([['repos', undefined]])
  })

  it('invalidates tests only for the selected suite, but always re-reads features', async () => {
    // The suite must stay in the list, or the re-read the first event triggers
    // would clear the selection and the second event could not match it.
    api.listFeatures.mockResolvedValue([feature('checkout')])
    await mount({ initialSelectedFeature: 'checkout' })
    harness.featureRef.current = 'checkout'
    const before = api.listFeatures.mock.calls.length

    await fire({ type: 'tests-changed', feature: 'search' })
    expect(harness.invalidated).toEqual([])

    await fire({ type: 'tests-changed', feature: 'checkout' })
    expect(harness.invalidated).toEqual([['tests', undefined]])
    expect(api.listFeatures.mock.calls.length).toBe(before + 2)
  })

  it('re-reads features on envset and dirty-test changes', async () => {
    await mount()
    const before = api.listFeatures.mock.calls.length

    await fire({ type: 'envsets-changed', feature: 'checkout' })
    await fire({ type: 'tests-dirty-changed', feature: 'checkout' })

    expect(api.listFeatures.mock.calls.length).toBe(before + 2)
    expect(harness.invalidated).toEqual([])
  })

  it('invalidates coverage and re-reads features on a coverage change', async () => {
    await mount()
    const before = api.listFeatures.mock.calls.length

    await fire({ type: 'coverage-changed', feature: 'checkout' })

    expect(harness.invalidated).toEqual([['coverage', undefined]])
    expect(api.listFeatures.mock.calls.length).toBe(before + 1)
  })

  it('invalidates verification only for the selected suite', async () => {
    await mount()
    harness.featureRef.current = 'checkout'

    await fire({ type: 'verification-config-changed', feature: 'search' })
    expect(harness.invalidated).toEqual([])

    await fire({ type: 'verification-config-changed', feature: 'checkout' })
    expect(harness.invalidated).toEqual([['verification', undefined]])
  })

  it('scopes a journal invalidation to its run', async () => {
    await mount()

    await fire({ type: 'journal-changed', runId: 'r1' })

    expect(harness.invalidated).toEqual([['journal', 'r1']])
  })

  it('re-reads the version on a version change', async () => {
    await mount()
    api.getVersionStatus.mockResolvedValue({ current: '9.9.9' })

    await fire({ type: 'version-changed' })

    expect(harness.data.versionStatus).toEqual({ current: '9.9.9' })
  })

  it('nudges the flights topic without refetching the list', async () => {
    await mount()
    const before = api.listFlights.mock.calls.length

    await fire({ type: 'flights-changed' })

    expect(harness.invalidated).toEqual([['flights', undefined]])
    expect(api.listFlights.mock.calls.length).toBe(before)
  })

  it('re-reads pre-flights on a pre-flight change', async () => {
    await mount()
    api.listPlanFeatures.mockResolvedValue({ tasks: [{ taskId: 't3' } as PlanFeaturesTask] })

    await fire({ type: 'pre-flight-changed' })

    expect(harness.data.preFlights).toEqual([{ taskId: 't3' }])
  })

  it('invalidates the project config and onboarding slots', async () => {
    await mount()

    await fire({ type: 'project-config-changed' })
    await fire({ type: 'getting-started-changed' })

    expect(harness.invalidated).toEqual([['project-config', undefined], ['onboarding', undefined]])
  })

  it('ignores an event it does not handle', async () => {
    await mount()
    const before = api.listFeatures.mock.calls.length

    await fire({ type: 'connected' })

    expect(harness.invalidated).toEqual([])
    expect(api.listFeatures.mock.calls.length).toBe(before)
  })
})

describe('useWorkspaceData — reconnect resync', () => {
  it('refetches everything and re-invalidates every topic', async () => {
    await mount()
    harness.featureRef.current = 'checkout'
    harness.runIdRef.current = 'r1'
    api.listFeatures.mockResolvedValue([feature('checkout')])

    await act(async () => { socket.opts?.onReconnect?.() })

    expect(harness.invalidated).toEqual([
      ['repos', undefined], ['tests', undefined], ['coverage', undefined],
      ['verification', undefined], ['journal', 'r1'], ['flights', undefined],
      ['project-config', undefined], ['onboarding', undefined],
    ])
    expect(api.listFlights.mock.calls.length).toBe(2)
    expect(api.getVersionStatus.mock.calls.length).toBe(2)
  })

  it('skips the journal topic when no run is selected', async () => {
    await mount()

    await act(async () => { socket.opts?.onReconnect?.() })

    expect(harness.invalidated.map(([topic]) => topic)).not.toContain('journal')
  })
})

describe('useWorkspaceData — socket lifecycle', () => {
  it('stays usable where no WebSocket exists', async () => {
    socket.connectThrows = true
    api.listFeatures.mockResolvedValue([feature('checkout')])

    await mount()

    expect(harness.data.features.map((f) => f.name)).toEqual(['checkout'])
    expect(socket.opts).toBeNull()
  })

  it('closes the connection on unmount', async () => {
    await mount()

    act(() => { root.unmount() })

    expect(socket.closes).toBe(1)
  })
})
