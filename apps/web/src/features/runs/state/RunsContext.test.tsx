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
  useActiveVerifyRuns,
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

  it('useActiveRuns counts running/healing/queued, and useRunDetails exposes the details map', () => {
    let active: { runs: RunIndexEntry[]; count: number } | null = null
    let details: Record<string, RunDetail> | null = null
    function P(): null {
      active = useActiveRuns()
      details = useRunDetails()
      return null
    }
    act(() => {
      root.render(
        <RunsProvider WebSocketImpl={FakeWebSocket as unknown as typeof WebSocket}>
          <P />
        </RunsProvider>,
      )
    })
    act(() => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          type: 'snapshot',
          runs: [
            entry({ runId: 'r1', status: 'running' }),
            entry({ runId: 'r2', status: 'queued' }),
            entry({ runId: 'r3', status: 'healing' }),
            entry({ runId: 'r4', status: 'passed' }),
          ],
          details: { r1: detail({ runId: 'r1', status: 'running' }) },
        }),
      })
    })
    expect(active!.count).toBe(3)
    expect(active!.runs.map((r) => r.runId).sort()).toEqual(['r1', 'r2', 'r3'])
    expect(Object.keys(details!)).toEqual(['r1'])
  })

  it('useActiveBootSessions returns only live boot-mode runs', () => {
    let boots: { sessions: RunIndexEntry[]; count: number } | null = null
    function P(): null {
      boots = useActiveBootSessions()
      return null
    }
    act(() => {
      root.render(
        <RunsProvider WebSocketImpl={FakeWebSocket as unknown as typeof WebSocket}>
          <P />
        </RunsProvider>,
      )
    })
    act(() => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          type: 'snapshot',
          runs: [
            entry({ runId: 'b1', status: 'running', executionType: 'boot' }),
            entry({ runId: 'b2', status: 'queued', executionType: 'boot' }),
            entry({ runId: 'b3', status: 'aborted', executionType: 'boot' }), // stopped boot → excluded
            entry({ runId: 'r1', status: 'running' }),                        // test run → excluded
          ],
          details: {},
        }),
      })
    })
    expect(boots!.count).toBe(2)
    expect(boots!.sessions.map((r) => r.runId).sort()).toEqual(['b1', 'b2'])
  })

  it('useActiveVerifyRuns returns only live deploy-check runs', () => {
    let verifies: { runs: RunIndexEntry[]; count: number } | null = null
    function P(): null {
      verifies = useActiveVerifyRuns()
      return null
    }
    act(() => {
      root.render(
        <RunsProvider WebSocketImpl={FakeWebSocket as unknown as typeof WebSocket}>
          <P />
        </RunsProvider>,
      )
    })
    act(() => {
      FakeWebSocket.instances[0].onmessage?.({
        data: JSON.stringify({
          type: 'snapshot',
          runs: [
            entry({ runId: 'v1', status: 'running', executionType: 'verify' }),
            entry({ runId: 'v2', status: 'queued', executionType: 'verify' }),
            entry({ runId: 'v3', status: 'passed', executionType: 'verify' }),  // settled → excluded
            entry({ runId: 'b1', status: 'running', executionType: 'boot' }),   // boot → excluded
            entry({ runId: 'r1', status: 'running' }),                          // test run → excluded
          ],
          details: {},
        }),
      })
    })
    expect(verifies!.count).toBe(2)
    expect(verifies!.runs.map((r) => r.runId).sort()).toEqual(['v1', 'v2'])
  })

  it('startRun forwards env + isolation, and omits opts when neither is given', async () => {
    vi.mocked(api.listRuns).mockResolvedValue([])
    vi.mocked(api.startRun).mockResolvedValue({ runId: 'r-x' })
    let runsApi: UseRunsResult | null = null
    function P(): null { runsApi = useRuns(); return null }
    act(() => {
      root.render(
        <RunsProvider WebSocketImpl={FakeWebSocket as unknown as typeof WebSocket}>
          <P />
        </RunsProvider>,
      )
    })
    await act(async () => { await runsApi!.startRun('feat', 'local', 'worktree') })
    expect(api.startRun).toHaveBeenLastCalledWith('feat', { env: 'local', isolation: 'worktree' })
    await act(async () => { await runsApi!.startRun('feat', 'local') })
    expect(api.startRun).toHaveBeenLastCalledWith('feat', { env: 'local' })
    await act(async () => { await runsApi!.startRun('feat', undefined, 'queue') })
    expect(api.startRun).toHaveBeenLastCalledWith('feat', { isolation: 'queue' })
    await act(async () => { await runsApi!.startRun('feat') })
    expect(api.startRun).toHaveBeenLastCalledWith('feat', undefined)
  })

  it('startRun forwards boot mode (and combines with env)', async () => {
    vi.mocked(api.listRuns).mockResolvedValue([])
    vi.mocked(api.startRun).mockResolvedValue({ runId: 'r-boot' })
    let runsApi: UseRunsResult | null = null
    function P(): null { runsApi = useRuns(); return null }
    act(() => {
      root.render(
        <RunsProvider WebSocketImpl={FakeWebSocket as unknown as typeof WebSocket}>
          <P />
        </RunsProvider>,
      )
    })
    await act(async () => { await runsApi!.startRun('feat', 'local', undefined, 'boot') })
    expect(api.startRun).toHaveBeenLastCalledWith('feat', { env: 'local', mode: 'boot' })
    // boot with no env still sends mode so the server boots in boot mode
    await act(async () => { await runsApi!.startRun('feat', undefined, undefined, 'boot') })
    expect(api.startRun).toHaveBeenLastCalledWith('feat', { mode: 'boot' })
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

  it('uses wss for default websocket URLs on https pages', () => {
    const original = globalThis.WebSocket
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
    const protocolSpy = vi.spyOn(window.location, 'protocol', 'get').mockReturnValue('https:')
    const hostSpy = vi.spyOn(window.location, 'host', 'get').mockReturnValue('secure.example')
    try {
      act(() => {
        root.render(
          <RunsProvider>
            <Probe
              captured={{ runs: null, run: null, actions: null, active: null }}
              runId={null}
            />
          </RunsProvider>,
        )
      })
      expect(FakeWebSocket.instances[0].url).toBe('wss://secure.example/ws/runs')
    } finally {
      protocolSpy.mockRestore()
      hostSpy.mockRestore()
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

  it('starts verification runs and refreshes only when websocket state is not live', async () => {
    const captured = renderProbe()
    vi.mocked(api.executeVerification)
      .mockResolvedValueOnce({ runId: 'verify-http', executionType: 'verify' })
      .mockResolvedValueOnce({ runId: 'verify-live', executionType: 'verify' })
    vi.mocked(api.listRuns).mockResolvedValue([])

    await act(async () => {
      await expect(captured.runs?.startVerification('checkout', {
        playwrightEnvsetId: 'production',
        targetUrls: { api: 'https://api.example.com' },
      })).resolves.toBe('verify-http')
    })
    expect(api.executeVerification).toHaveBeenCalledWith('checkout', {
      playwrightEnvsetId: 'production',
      targetUrls: { api: 'https://api.example.com' },
    })
    expect(api.listRuns).toHaveBeenCalledTimes(1)

    act(() => {
      FakeWebSocket.instances[0].onopen?.()
    })
    await act(async () => {
      await expect(captured.runs?.startVerification('checkout', {
        configId: 'config-1',
      })).resolves.toBe('verify-live')
    })

    expect(api.executeVerification).toHaveBeenLastCalledWith('checkout', { configId: 'config-1' })
    expect(api.listRuns).toHaveBeenCalledTimes(1)
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
})
