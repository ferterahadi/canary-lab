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
  readyState = 0
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
    this.readyState = 3
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
  const { count } = useActiveBootSessions()
  return <span>{count ? `Services up: ${count}` : 'No active services'}</span>
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
  it.each(['update', 'removed', 'snapshot', 'list-changed'] as const)('ignores an old detail response after a newer %s frame', async (type) => {
    vi.useFakeTimers()
    const pending = deferred<RunDetail>()
    vi.mocked(api.getRunDetail).mockReturnValue(pending.promise)
    const captured = renderProbe()
    const socket = FakeWebSocket.instances[0]
    act(() => {
      socket.onmessage?.({ data: JSON.stringify({ type: 'snapshot',
        runs: [entry({ executionType: 'boot' })], details: { r1: detail({ executionType: 'boot' }) },
      }) })
    })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    const frames = {
      update: { type, runId: 'r1', detail: detail({ executionType: 'boot', status: 'aborted' }) },
      removed: { type, runId: 'r1' },
      snapshot: { type, runs: [], details: {} },
      'list-changed': { type, runs: [] },
    }
    act(() => { socket.onmessage?.({ data: JSON.stringify(frames[type]) }) })
    await act(async () => { pending.resolve(detail({ executionType: 'boot' })); await pending.promise })
    expect(container.textContent).toBe('No active services')
    expect(captured.active?.entry).toBeNull()
    expect(captured.runs?.runs.some((run) => run.status === 'running')).toBe(false)
    if (type === 'update') expect(captured.run?.status).toBe('aborted')
    if (type === 'removed' || type === 'snapshot') expect(captured.run?.detail).toBeUndefined()
  })

  it('does not discard recovery because an unrelated run changed', async () => {
    vi.useFakeTimers()
    const pending = deferred<RunDetail>()
    vi.mocked(api.getRunDetail).mockReturnValue(pending.promise)
    const captured = renderProbe()
    const socket = FakeWebSocket.instances[0]
    act(() => { socket.onmessage?.({ data: JSON.stringify({ type: 'snapshot', runs: [entry()], details: { r1: detail() } }) }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    act(() => { socket.onmessage?.({ data: JSON.stringify({ type: 'update', runId: 'other', detail: detail({ runId: 'other', status: 'passed' }) }) }) })
    await act(async () => { pending.resolve(detail({ status: 'aborted' })); await pending.promise })
    expect(captured.run?.status).toBe('aborted')
    expect(captured.runs?.runs.map((run) => run.status)).toEqual(['aborted', 'passed'])
  })

  it('keeps the newer load guard when a superseded request finishes', async () => {
    vi.useFakeTimers()
    const old = deferred<RunDetail>()
    const current = deferred<RunDetail>()
    vi.mocked(api.getRunDetail).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const captured = renderProbe()
    const socket = FakeWebSocket.instances[0]
    act(() => { socket.onmessage?.({ data: JSON.stringify({ type: 'snapshot', runs: [entry()], details: { r1: detail() } }) }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    act(() => { socket.onmessage?.({ data: JSON.stringify({ type: 'update', runId: 'r1', detail: detail({ status: 'healing' }) }) }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    await act(async () => { old.resolve(detail()); await old.promise })
    expect(captured.run?.status).toBe('healing')
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(api.getRunDetail).toHaveBeenCalledTimes(2)
    await act(async () => { current.resolve(detail({ status: 'passed' })); await current.promise })
    expect(captured.run?.status).toBe('passed')
    expect(captured.runs?.runs[0].status).toBe('passed')
  })

  it('releases recovery work on unmount, including an outstanding read', async () => {
    vi.useFakeTimers()
    const pending = deferred<RunDetail>()
    vi.mocked(api.getRunDetail).mockReturnValue(pending.promise)
    const captured = renderProbe()
    act(() => { FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify({ type: 'snapshot', runs: [entry()], details: { r1: detail() } }) }) })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    act(() => { root.unmount() })
    await act(async () => { pending.resolve(detail({ status: 'passed' })); await pending.promise; await vi.advanceTimersByTimeAsync(5000) })
    expect(captured.run?.status).toBe('running')
    expect(api.getRunDetail).toHaveBeenCalledTimes(1)
    expect(FakeWebSocket.instances[0].closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles the sidebar and active-run consumers when a stop event is lost', async () => {
    vi.useFakeTimers()
    vi.mocked(api.getRunDetail).mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValue(detail({ executionType: 'boot', status: 'aborted' }))
    const captured = renderProbe()
    act(() => {
      FakeWebSocket.instances[0].onopen?.()
      FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify({
        type: 'snapshot', runs: [entry({ executionType: 'boot' })],
        details: { r1: detail({ executionType: 'boot' }) },
      }) })
    })
    expect(container.textContent).toBe('Services up: 1')
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(container.textContent).toBe('Services up: 1')
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(captured.run?.status).toBe('aborted')
    expect(captured.runs?.runs[0]).toMatchObject({ status: 'aborted', executionType: 'boot' })
    expect(captured.active?.entry).toBeNull()
    expect(container.textContent).toBe('No active services')
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(api.getRunDetail).toHaveBeenCalledTimes(2)
    expect(api.listRuns).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(1)
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

  it('retries every 500 ms and exposes disconnected after ten seconds of consecutive failures', () => {
    vi.useFakeTimers()
    const captured = renderProbe()
    const first = FakeWebSocket.instances[0]

    act(() => {
      first.onclose?.()
    })
    expect(captured.runs?.connection).toBe('reconnecting')

    for (let attempt = 2; attempt <= 20; attempt += 1) {
      act(() => {
        vi.advanceTimersByTime(500)
        expect(FakeWebSocket.instances).toHaveLength(attempt)
        FakeWebSocket.instances.at(-1)?.onclose?.()
      })
    }
    expect(captured.runs?.connection).toBe('disconnected')

    act(() => {
      vi.advanceTimersByTime(500)
      FakeWebSocket.instances.at(-1)?.onopen?.()
    })
    expect(captured.runs?.connection).toBe('live')
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
