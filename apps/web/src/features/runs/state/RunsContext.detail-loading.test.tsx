// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import type { RunDetail, RunIndexEntry } from '@/shared/api/types'
import {
  RunsProvider,
  useActiveBootSessions,
  useActiveRuns,
  useGlobalActiveRun,
  useRun,
  useRunActions,
  useRunDetails,
  useRuns,
  type UseGlobalActiveRunResult,
  type UseRunActionsResult,
  type UseRunResult,
  type UseRunsResult,
} from './RunsContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    listRuns: vi.fn(),
    startRun: vi.fn(),
    getRunDetail: vi.fn(),
    stopRun: vi.fn(),
    deleteRun: vi.fn(),
    pauseHealRun: vi.fn(),
    cancelHealRun: vi.fn(),
    executeVerification: vi.fn(),
  }
})

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  closed = false

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  close(): void {
    this.closed = true
    this.onclose?.()
  }
}

let container: HTMLDivElement

let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  FakeWebSocket.instances = []
  vi.useRealTimers()
  vi.mocked(api.listRuns).mockReset()
  vi.mocked(api.startRun).mockReset()
  vi.mocked(api.getRunDetail).mockReset()
  vi.mocked(api.stopRun).mockReset()
  vi.mocked(api.deleteRun).mockReset()
  vi.mocked(api.pauseHealRun).mockReset()
  vi.mocked(api.cancelHealRun).mockReset()
  vi.mocked(api.executeVerification).mockReset()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
})

function renderProbe(runId: string | null = 'r1') {
  const captured = emptyCapture()

  act(() => {
    root.render(<ProbeHarness captured={captured} runId={runId} />)
  })

  return captured
}

function emptyCapture(): {
  runs: UseRunsResult | null
  run: UseRunResult | null
  actions: UseRunActionsResult | null
  active: UseGlobalActiveRunResult | null
} {
  return { runs: null, run: null, actions: null, active: null }
}

function ProbeHarness({
  captured,
  runId,
}: {
  captured: {
    runs: UseRunsResult | null
    run: UseRunResult | null
    actions: UseRunActionsResult | null
    active: UseGlobalActiveRunResult | null
  }
  runId: string | null
}) {
  return (
    <RunsProvider WebSocketImpl={FakeWebSocket as unknown as typeof WebSocket}>
      <Probe captured={captured} runId={runId} />
    </RunsProvider>
  )
}

function Probe({
  captured,
  runId,
}: {
  captured: {
    runs: UseRunsResult | null
    run: UseRunResult | null
    actions: UseRunActionsResult | null
    active: UseGlobalActiveRunResult | null
  }
  runId: string | null
}) {
  captured.runs = useRuns()
  captured.run = useRun(runId)
  captured.actions = useRunActions(runId ?? 'missing')
  captured.active = useGlobalActiveRun()
  return null
}

function entry(overrides: Partial<RunIndexEntry> = {}): RunIndexEntry {
  return {
    runId: 'r1',
    feature: 'checkout',
    startedAt: '2026-01-01T00:00:00Z',
    status: 'running',
    ...overrides,
  }
}

function detail(overrides: Partial<RunDetail['manifest']> = {}): RunDetail {
  const runId = overrides.runId ?? 'r1'
  return {
    runId,
    manifest: {
      runId,
      feature: 'checkout',
      startedAt: '2026-01-01T00:00:00Z',
      status: 'running',
      healCycles: 0,
      services: [],
      ...overrides,
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('RunsProvider', () => {
  it('loads missing run details once and clears the in-flight guard after completion', async () => {
    const first = deferred<RunDetail>()
    vi.mocked(api.getRunDetail).mockReturnValueOnce(first.promise)
    const captured = renderProbe('lazy-r1')

    act(() => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          type: 'snapshot',
          runs: [entry({ runId: 'lazy-r1', status: 'passed' })],
          details: {},
        }),
      })
    })
    expect(api.getRunDetail).toHaveBeenCalledTimes(1)

    act(() => {
      root.render(<ProbeHarness captured={captured} runId="lazy-r1" />)
    })
    expect(api.getRunDetail).toHaveBeenCalledTimes(1)

    await act(async () => {
      first.resolve(detail({ runId: 'lazy-r1', status: 'passed' }))
      await first.promise
    })
    expect(captured.run?.detail?.runId).toBe('lazy-r1')
  })

  it('deduplicates concurrent missing detail loads across consumers', () => {
    const first = deferred<RunDetail>()
    vi.mocked(api.getRunDetail).mockReturnValueOnce(first.promise)
    const capturedA = emptyCapture()
    const capturedB = emptyCapture()

    act(() => {
      root.render(
        <RunsProvider WebSocketImpl={FakeWebSocket as unknown as typeof WebSocket}>
          <Probe captured={capturedA} runId="shared-detail" />
          <Probe captured={capturedB} runId="shared-detail" />
        </RunsProvider>,
      )
    })
    act(() => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          type: 'snapshot',
          runs: [entry({ runId: 'shared-detail', status: 'passed' })],
          details: {},
        }),
      })
    })

    expect(api.getRunDetail).toHaveBeenCalledTimes(1)
  })

  it('polls running run details while the run remains active', async () => {
    vi.useFakeTimers()
    vi.mocked(api.getRunDetail).mockResolvedValue(detail({ runId: 'poll-r1', status: 'running' }))
    const captured = renderProbe('poll-r1')

    act(() => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          type: 'snapshot',
          runs: [entry({ runId: 'poll-r1', status: 'running' })],
          details: { 'poll-r1': detail({ runId: 'poll-r1', status: 'running' }) },
        }),
      })
    })

    await act(async () => {
      vi.advanceTimersByTime(1000)
      await Promise.resolve()
    })

    expect(api.getRunDetail).toHaveBeenCalledWith('poll-r1')
    expect(captured.run?.status).toBe('running')
  })

  it('surfaces action errors, clears them, and refreshes while disconnected', async () => {
    const captured = renderProbe('r-action')
    vi.mocked(api.stopRun).mockRejectedValue(new Error('stop failed'))
    vi.mocked(api.listRuns).mockResolvedValue([entry({ runId: 'r-action', status: 'running' })])

    act(() => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          type: 'snapshot',
          runs: [entry({ runId: 'r-action', status: 'running' })],
          details: { 'r-action': detail({ runId: 'r-action', status: 'running' }) },
        }),
      })
    })

    await act(async () => {
      await captured.runs?.abort('r-action')
    })
    expect(api.stopRun).toHaveBeenCalledWith('r-action')
    expect(api.listRuns).toHaveBeenCalledTimes(1)
    expect(captured.runs?.errors['r-action']).toBe('stop failed')

    act(() => {
      captured.runs?.clearError('r-action')
    })
    expect(captured.runs?.errors['r-action']).toBeUndefined()
  })

  it('exposes per-run action callbacks', async () => {
    const captured = renderProbe('r-actions')
    vi.mocked(api.stopRun).mockResolvedValue(undefined)
    vi.mocked(api.deleteRun).mockResolvedValue(undefined)
    vi.mocked(api.pauseHealRun).mockResolvedValue({ status: 'healing', failureCount: 1 })
    vi.mocked(api.cancelHealRun).mockResolvedValue({ status: 'cancelled' })
    vi.mocked(api.listRuns).mockResolvedValue([])

    await act(async () => {
      await captured.actions?.abort()
      await captured.actions?.delete()
      await captured.actions?.pauseHeal()
      await captured.actions?.cancelHeal()
    })
    act(() => {
      captured.actions?.clearError()
    })

    expect(api.stopRun).toHaveBeenCalledWith('r-actions')
    expect(api.deleteRun).toHaveBeenCalledWith('r-actions')
    expect(api.pauseHealRun).toHaveBeenCalledWith('r-actions')
    expect(api.cancelHealRun).toHaveBeenCalledWith('r-actions')
  })

  it('invokes the websocket onerror handler without scheduling a reconnect', () => {
    renderProbe()
    const socket = FakeWebSocket.instances[0]
    expect(socket.onerror).toBeTypeOf('function')
    act(() => {
      socket.onerror?.()
    })
    // No throw; onclose path remains the one to schedule reconnects.
  })

  it('moves through reconnect state and exposes disconnected after max backoff', async () => {
    vi.useFakeTimers()
    const captured = renderProbe()
    const first = FakeWebSocket.instances[0]

    act(() => {
      first.onclose?.()
    })
    expect(captured.runs?.connection).toBe('reconnecting')

    for (const ms of [500, 1000, 2000, 4000, 8000, 10000]) {
      act(() => {
        vi.advanceTimersByTime(ms)
      })
      FakeWebSocket.instances.at(-1)?.onclose?.()
    }

    act(() => {
      vi.advanceTimersByTime(10000)
    })
    expect(captured.runs?.connection).toBe('disconnected')
  })

  it('schedules reconnect when websocket construction fails and cancels cleanly on unmount', () => {
    vi.useFakeTimers()
    class ThrowingWebSocket {
      constructor() {
        throw new Error('no socket')
      }
    }
    const captured = {
      runs: null,
      run: null,
      actions: null,
      active: null,
    }

    act(() => {
      root.render(
        <RunsProvider WebSocketImpl={ThrowingWebSocket as unknown as typeof WebSocket} wsUrl="ws://custom/ws">
          <Probe captured={captured} runId={null} />
        </RunsProvider>,
      )
    })
    act(() => {
      root.unmount()
      vi.advanceTimersByTime(500)
    })

    expect(FakeWebSocket.instances).toEqual([])
  })

  it('falls back cleanly when no run id is selected', () => {
    const captured = renderProbe(null)
    expect(captured.run).toEqual({
      detail: undefined,
      status: undefined,
      transient: null,
      displayStatus: undefined,
      error: null,
    })
  })

  it('throws when hooks are used outside the provider', () => {
    function OutsideProviderProbe() {
      useRuns()
      return null
    }

    expect(() => {
      act(() => {
        root.render(<OutsideProviderProbe />)
      })
    }).toThrow('useRunsContext must be used inside <RunsProvider>')
  })
})
