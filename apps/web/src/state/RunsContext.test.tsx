// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api/client'
import type { RunDetail, RunIndexEntry } from '../api/types'
import {
  RunsProvider,
  useGlobalActiveRun,
  useRun,
  useRunActions,
  useRuns,
  type UseGlobalActiveRunResult,
  type UseRunActionsResult,
  type UseRunResult,
  type UseRunsResult,
} from './RunsContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    listRuns: vi.fn(),
    startRun: vi.fn(),
    getRunDetail: vi.fn(),
    stopRun: vi.fn(),
    deleteRun: vi.fn(),
    pauseHealRun: vi.fn(),
    cancelHealRun: vi.fn(),
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
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
})

describe('RunsProvider', () => {
  it('opens the run stream, applies frames, and exposes active run state', () => {
    const captured = renderProbe()
    const socket = FakeWebSocket.instances[0]
    expect(socket.url).toBe('ws://localhost:3000/ws/runs')

    act(() => {
      socket.onopen?.()
    })
    expect(captured.runs?.connection).toBe('live')

    act(() => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'snapshot',
          runs: [entry({ runId: 'r1', status: 'running' })],
          details: { r1: detail({ runId: 'r1', status: 'running' }) },
        }),
      })
    })
    expect(captured.runs?.runs.map((run) => run.runId)).toEqual(['r1'])
    expect(captured.run?.status).toBe('running')
    expect(captured.active?.runId).toBe('r1')

    act(() => {
      socket.onmessage?.({ data: 'not json' })
      socket.onmessage?.({ data: { toString: () => JSON.stringify({ type: 'list-changed', runs: [] }) } })
      socket.onmessage?.({
        data: JSON.stringify({
          type: 'update',
          runId: 'r1',
          detail: detail({ runId: 'r1', status: 'passed' }),
        }),
      })
      socket.onmessage?.({ data: JSON.stringify({ type: 'unknown' }) })
    })
    expect(captured.run?.status).toBe('passed')
    expect(captured.active?.runId).toBeNull()

    act(() => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'removed', runId: 'r1' }) })
    })
    expect(captured.runs?.runs).toEqual([])
  })

  it('uses injected websocket URLs and the global websocket constructor fallback', () => {
    const original = globalThis.WebSocket
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    try {
      act(() => {
        root.render(
          <RunsProvider wsUrl="ws://custom/ws">
            <Probe
              captured={{ runs: null, run: null, actions: null, active: null }}
              runId={null}
            />
          </RunsProvider>,
        )
      })
      expect(FakeWebSocket.instances[0].url).toBe('ws://custom/ws')
    } finally {
      globalThis.WebSocket = original
    }
  })

  it('refreshes and starts runs through HTTP fallbacks', async () => {
    const captured = renderProbe()
    vi.mocked(api.listRuns).mockResolvedValue([entry({ runId: 'http-r1', status: 'failed' })])
    vi.mocked(api.startRun).mockResolvedValue({ runId: 'new-run' })

    await act(async () => {
      await captured.runs?.refresh()
    })
    expect(captured.runs?.runs.map((run) => run.runId)).toEqual(['http-r1'])

    await expect(captured.runs?.startRun('checkout', 'local')).resolves.toBe('new-run')
    expect(api.startRun).toHaveBeenCalledWith('checkout', { env: 'local' })
    expect(api.listRuns).toHaveBeenCalledTimes(2)
  })

  it('uses live websocket state to skip HTTP fallbacks for successful mutations', async () => {
    const captured = renderProbe()
    vi.mocked(api.startRun).mockResolvedValue({ runId: 'live-run' })
    vi.mocked(api.stopRun).mockResolvedValue(undefined)
    vi.mocked(api.listRuns).mockResolvedValue([])

    act(() => {
      FakeWebSocket.instances[0].onopen?.()
    })

    await act(async () => {
      await captured.runs?.startRun('checkout')
      await captured.runs?.abort('live-run')
    })

    expect(api.startRun).toHaveBeenCalledWith('checkout', undefined)
    expect(api.stopRun).toHaveBeenCalledWith('live-run')
    expect(api.listRuns).not.toHaveBeenCalled()
  })

  it('swallows refresh and detail-load failures', async () => {
    const captured = renderProbe('missing-detail')
    vi.mocked(api.listRuns).mockRejectedValue(new Error('offline'))
    vi.mocked(api.getRunDetail).mockRejectedValue(new Error('not found'))

    await act(async () => {
      await captured.runs?.refresh()
    })

    act(() => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          type: 'snapshot',
          runs: [entry({ runId: 'missing-detail', status: 'passed' })],
          details: {},
        }),
      })
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(captured.runs?.runs.map((run) => run.runId)).toEqual(['missing-detail'])
    expect(captured.run?.detail).toBeUndefined()
  })

  it('reports an active run even before detail arrives', () => {
    const captured = renderProbe('active-no-detail')

    act(() => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          type: 'snapshot',
          runs: [entry({ runId: 'active-no-detail', status: 'healing' })],
          details: {},
        }),
      })
    })

    expect(captured.active?.runId).toBe('active-no-detail')
    expect(captured.active?.detail).toBeNull()
  })

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
    vi.mocked(api.deleteRun).mockResolvedValue(undefined)
    vi.mocked(api.pauseHealRun).mockResolvedValue({ status: 'healing', failureCount: 1 })
    vi.mocked(api.cancelHealRun).mockResolvedValue({ status: 'cancelled' })
    vi.mocked(api.listRuns).mockResolvedValue([])

    await act(async () => {
      await captured.actions?.delete()
      await captured.actions?.pauseHeal()
      await captured.actions?.cancelHeal()
    })

    expect(api.deleteRun).toHaveBeenCalledWith('r-actions')
    expect(api.pauseHealRun).toHaveBeenCalledWith('r-actions')
    expect(api.cancelHealRun).toHaveBeenCalledWith('r-actions')
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

function renderProbe(runId: string | null = 'r1') {
  const captured: {
    runs: UseRunsResult | null
    run: UseRunResult | null
    actions: UseRunActionsResult | null
    active: UseGlobalActiveRunResult | null
  } = { runs: null, run: null, actions: null, active: null }

  act(() => {
    root.render(<ProbeHarness captured={captured} runId={runId} />)
  })

  return captured
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
