import { act, useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FlightIndexEntry } from '../api/client'
import type { Feature } from '../api/types'
import { useWorkspaceData } from './use-workspace-data'
import { useWorkspaceSelection } from './use-workspace-selection'

const api = vi.hoisted(() => ({ listFeatures: vi.fn(), listFlights: vi.fn(), listPlanFeatures: vi.fn(), getVersionStatus: vi.fn() }))
vi.mock('../api/client', async (importOriginal) => ({ ...await importOriginal<typeof import('../api/client')>(), ...api }))
vi.mock('@/features/runs', () => ({ useRun: () => ({ detail: undefined }) }))

// The data, selection, and Flight stream hooks run together. Only network I/O
// is replaced; deletion frames must update the same mounted workspace.
class Socket {
  static instances: Socket[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  readyState = 1
  closed = false
  constructor(public url: string) {
    Socket.instances.push(this)
    queueMicrotask(() => this.onopen?.())
  }
  close() { this.closed = true }
}

const feature = (name: string): Feature => ({ name, repos: [], envs: [] })
const flight: FlightIndexEntry = { id: 'saved', flightId: 'saved', feature: 'checkout', repoPaths: [], status: 'done', currentStage: null,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }
const noRuns: [] = []
const invalidate = vi.fn()
let root: Root
let container: HTMLDivElement
const latest = (channel: string) => Socket.instances.filter((socket) => socket.url.endsWith(`/ws/${channel}`)).at(-1)!
const frame = async (channel: string, value: unknown) => {
  await act(async () => latest(channel).onmessage?.({ data: JSON.stringify(value) }))
}
const rendered = () => JSON.parse(container.textContent!)

function Workspace() {
  const [selectedFeature, setSelectedFeature] = useState<string | null>('checkout')
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const selectedFeatureRef = useRef(selectedFeature)
  const selectedRunIdRef = useRef(selectedRunId)
  const pendingRunSelectionRef = useRef<string | null>(null)
  useEffect(() => { selectedFeatureRef.current = selectedFeature; selectedRunIdRef.current = selectedRunId }, [selectedFeature, selectedRunId])
  const selection = useWorkspaceSelection({ allRuns: noRuns, selectedFeature, selectedRunId, setSelectedFeature, setSelectedRunId,
    selectedFeatureRef, selectedRunIdRef, pendingRunSelectionRef })
  const data = useWorkspaceData({ invalidate, selectedFeatureRef, selectedRunIdRef,
    onInitialFeatures: selection.onInitialFeatures, onFeaturesRefreshed: selection.onFeaturesRefreshed })
  return <output>{JSON.stringify({ selectedFeature, suites: data.features.map((entry) => entry.name),
    flights: data.flights.map((entry) => entry.flightId) })}</output>
}

beforeEach(async () => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  Socket.instances = []
  vi.stubGlobal('WebSocket', Socket)
  api.listFeatures.mockResolvedValue([feature('checkout'), feature('remaining')])
  api.listFlights.mockResolvedValue([flight])
  api.listPlanFeatures.mockResolvedValue({ tasks: [] })
  api.getVersionStatus.mockResolvedValue(null)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<Workspace />))
  await frame('flights', { type: 'snapshot', flights: [flight], details: {} })
  expect(rendered()).toEqual({ selectedFeature: 'checkout', suites: ['checkout', 'remaining'], flights: ['saved'] })
  api.listFeatures.mockResolvedValue([feature('remaining')])
  api.listFlights.mockResolvedValue([])
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('updates selection and Flight rows in the mounted workspace from deletion events', async () => {
  const connects = Socket.instances.length
  await frame('flights', { type: 'removed', flightId: 'saved' })
  await frame('workspace', { type: 'feature-deleted', feature: 'checkout' })
  expect(rendered()).toEqual({ selectedFeature: 'remaining', suites: ['remaining'], flights: [] })
  expect(Socket.instances).toHaveLength(connects)
})

it('recovers a missed suite deletion on reconnect, with no feature polling while the socket stays open', async () => {
  await frame('flights', { type: 'removed', flightId: 'saved' })
  // Existing limitation: a lost workspace deletion frame leaves the suite list
  // stale until another refresh trigger. Do not add a polling policy in this fix.
  const reads = api.listFeatures.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(api.listFeatures).toHaveBeenCalledTimes(reads)
  expect(rendered().selectedFeature).toBe('checkout')
  await act(async () => { latest('workspace').onclose?.(); latest('flights').onclose?.() })
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  await frame('workspace', { type: 'connected' })
  await frame('flights', { type: 'snapshot', flights: [], details: {} })
  expect(rendered()).toEqual({ selectedFeature: 'remaining', suites: ['remaining'], flights: [] })
})
