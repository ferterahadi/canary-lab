// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightManifest } from '@shared/flights/types'
import { useFlightsStream } from './use-flights-stream'
import { flightIndexEntry } from '@shared/flights/index-entry'
const { listFlights } = vi.hoisted(() => ({ listFlights: vi.fn() }))
vi.mock('@/shared/api/flights', () => ({ listFlights }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Minimal socket stand-in: the test drives `onmessage` / `onclose` directly.
class FakeSocket {
  static last: FakeSocket | null = null
  static opened: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  readyState = 1
  closed = false
  constructor(public url: string) {
    FakeSocket.last = this
    FakeSocket.opened.push(url)
    queueMicrotask(() => this.onopen?.())
  }
  send(): void {}
  close(): void { this.closed = true }
}

function manifest(over: Partial<FlightManifest> = {}): FlightManifest {
  return {
    flightId: 'fl_1',
    feature: 'checkout',
    repoPaths: ['/repo/shop'],
    description: 'checkout flow',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'running',
    currentStage: 'scout',
    stages: [{ key: 'scout', status: 'running' }],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as FlightManifest
}

let container: HTMLDivElement
let root: Root
let seen: ReturnType<typeof useFlightsStream>[] = []

function Probe({ onReconnect }: { onReconnect?: () => void }) {
  const state = useFlightsStream({
    wsBase: 'ws://test',
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    ...(onReconnect ? { onReconnect } : {}),
  })
  seen.push(state)
  return <span data-testid="rows">{state.flights.map((f) => `${f.flightId}:${f.status}`).join(',')}</span>
}

const rows = (): string => container.querySelector('[data-testid="rows"]')?.textContent ?? ''

const push = async (frame: unknown) => {
  await act(async () => { FakeSocket.last?.onmessage?.({ data: JSON.stringify(frame) }) })
}

beforeEach(() => {
  listFlights.mockReset()
  listFlights.mockResolvedValue([])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  seen = []
  FakeSocket.last = null
  FakeSocket.opened = []
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('useFlightsStream', () => {
  it('recovers missed attention pushes and rejects an older read after a newer push', async () => {
    vi.useFakeTimers()
    const paused = manifest({ status: 'paused', pauseReason: 'stage-failed', attention: {
      state: 'actionable', stage: 'scout', title: 'Paused', reason: 'Failed', revision: 'a', checkedAt: 'now',
    } })
    await act(async () => { root.render(<Probe />) })
    await push({ type: 'snapshot', flights: [flightIndexEntry(paused)], details: { fl_1: paused } })
    const resolved = { ...paused, attention: { ...paused.attention!, state: 'resolved' as const, revision: 'b' } }
    listFlights.mockResolvedValue([flightIndexEntry(resolved)])
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(seen.at(-1)?.flights[0].attention?.state).toBe('resolved')
    expect(seen.at(-1)?.details.fl_1.attention?.state).toBe('resolved')
    let finish!: (value: ReturnType<typeof flightIndexEntry>[]) => void
    listFlights.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    await push({ type: 'update', flightId: 'fl_1', manifest: paused })
    await act(async () => finish([flightIndexEntry(resolved)]))
    expect(seen.at(-1)?.flights[0].attention?.state).toBe('actionable')
    listFlights.mockRejectedValue(new Error('offline'))
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(seen.at(-1)?.flights[0].attention?.state).toBe('unavailable')
    listFlights.mockResolvedValue([flightIndexEntry(resolved)])
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(seen.at(-1)?.flights[0].attention?.state).toBe('resolved')
  })

  it('connects to /ws/flights and applies the snapshot', async () => {
    await act(async () => { root.render(<Probe />) })
    expect(FakeSocket.opened).toEqual(['ws://test/ws/flights'])
    expect(seen.at(-1)?.hydrated).toBe(false)

    await push({ type: 'snapshot', flights: [flightIndexEntry(manifest())], details: {} })
    expect(rows()).toBe('fl_1:running')
    expect(seen.at(-1)?.hydrated).toBe(true)
  })

  it('advances the list from a push, with no refetch', async () => {
    await act(async () => { root.render(<Probe />) })
    await push({ type: 'snapshot', flights: [flightIndexEntry(manifest())], details: {} })
    await push({ type: 'update', flightId: 'fl_1', manifest: manifest({ status: 'done', currentStage: null }) })
    // This is what used to require a `flights-changed` nudge plus a
    // `GET /api/flights`, backed by a 5s poll in case the nudge was lost.
    expect(rows()).toBe('fl_1:done')
  })

  it('survives a malformed frame', async () => {
    await act(async () => { root.render(<Probe />) })
    await push({ type: 'snapshot', flights: [flightIndexEntry(manifest())], details: {} })
    await act(async () => { FakeSocket.last?.onmessage?.({ data: 'not json' }) })
    expect(rows()).toBe('fl_1:running')
  })

  it('reports a RE-open, not the first connect — the bus has no replay', async () => {
    const onReconnect = vi.fn()
    await act(async () => { root.render(<Probe onReconnect={onReconnect} />) })
    expect(onReconnect).not.toHaveBeenCalled()

    await act(async () => { FakeSocket.last?.onclose?.() })
    await act(async () => { await new Promise((r) => setTimeout(r, 1600)) })
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('closes the socket on unmount', async () => {
    await act(async () => { root.render(<Probe />) })
    const socket = FakeSocket.last!
    await act(async () => { root.render(<></>) })
    expect(socket.closed).toBe(true)
  })

  it('derives the socket base from the page when none is given', async () => {
    // Production never passes wsBase — the app is served by the same origin as
    // the socket, which is exactly the case every other test here overrides.
    function Bare() {
      useFlightsStream({ WebSocketImpl: FakeSocket as unknown as typeof WebSocket })
      return null
    }
    await act(async () => { root.render(<Bare />) })

    expect(FakeSocket.opened.at(-1)).toBe(`ws://${window.location.host}/ws/flights`)
  })
})

it('reconciles a confirmed detail 404 through the same removal reducer without reconnecting', async () => {
  await act(async () => { root.render(<Probe />) })
  const flight = manifest()
  await push({ type: 'snapshot', flights: [flightIndexEntry(flight)], details: { fl_1: flight } })
  await act(async () => { seen.at(-1)!.forgetFlight('fl_1') })
  expect(rows()).toBe('')
  expect(seen.at(-1)?.details).toEqual({})
  expect(FakeSocket.opened).toEqual(['ws://test/ws/flights'])
})
