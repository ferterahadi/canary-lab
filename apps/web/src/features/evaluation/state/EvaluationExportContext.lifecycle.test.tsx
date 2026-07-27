// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import type { EvaluationExportTask } from '@/shared/api/types'
import { EvaluationExportProvider, useEvaluationExports } from './EvaluationExportContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    startEvaluationExport: vi.fn(),
    listEvaluationExportTasks: vi.fn(),
    getEvaluationExportTask: vi.fn(),
    downloadEvaluationExportTask: vi.fn(),
    cancelEvaluationExportTask: vi.fn(),
  }
})

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readyState = 0
  onmessage: ((event: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  closeCalls = 0

  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }

  close(): void {
    this.closeCalls += 1
    this.readyState = 3
    this.onclose?.()
  }

  fire(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent)
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
  vi.mocked(api.startEvaluationExport).mockReset()
  vi.mocked(api.listEvaluationExportTasks).mockReset().mockResolvedValue([])
  vi.mocked(api.getEvaluationExportTask).mockReset()
  vi.mocked(api.downloadEvaluationExportTask).mockReset()
  vi.mocked(api.cancelEvaluationExportTask).mockReset()
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.useRealTimers()
})

function renderProbe(WebSocketImpl: typeof WebSocket = FakeWebSocket as unknown as typeof WebSocket) {
  const captured: { value: ReturnType<typeof useEvaluationExports> | null } = { value: null }
  act(() => {
    root.render(
      <EvaluationExportProvider WebSocketImpl={WebSocketImpl} wsBase="ws://test">
        <Probe captured={captured} />
      </EvaluationExportProvider>,
    )
  })
  return captured
}

function exportSockets(): FakeWebSocket[] {
  return FakeWebSocket.instances.filter((item) => item.url.includes('/ws/evaluation-exports/'))
}

function taskSocket(taskId: string): FakeWebSocket {
  const url = `ws://test/ws/evaluation-exports/${taskId}`
  const socket = FakeWebSocket.instances.find((item) => item.url === url)
  if (!socket) throw new Error(`task socket not opened: ${taskId}`)
  return socket
}

function Probe({ captured }: { captured: { value: ReturnType<typeof useEvaluationExports> | null } }) {
  captured.value = useEvaluationExports()
  return null
}

function task(overrides: Partial<EvaluationExportTask> = {}): EvaluationExportTask {
  return {
    taskId: 'task-1',
    runId: 'run-1',
    feature: 'checkout',
    mode: 'raw',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    downloadReady: false,
    ...overrides,
  }
}

describe('EvaluationExportProvider', () => {
  it('ignores periodic discovery results after unmount', async () => {
    vi.useFakeTimers()
    let resolveTasks: (tasks: EvaluationExportTask[]) => void = () => {}
    vi.mocked(api.listEvaluationExportTasks)
      .mockResolvedValueOnce([])
      .mockReturnValueOnce(new Promise<EvaluationExportTask[]>((resolve) => { resolveTasks = resolve }))

    renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    await act(async () => {
      vi.advanceTimersByTime(3000)
      await Promise.resolve()
    })
    act(() => {
      root.unmount()
    })

    await act(async () => {
      resolveTasks([task({ taskId: 'late-periodic-task', runId: 'run-late', status: 'running' })])
      await Promise.resolve()
    })

    expect(exportSockets()).toHaveLength(0)
    root = createRoot(container)
  })

  it('sorts remaining tasks by createdAt after dismissTask', async () => {
    const t1 = task({ taskId: 't1', runId: 'r1', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z' })
    const t2 = task({ taskId: 't2', runId: 'r2', status: 'completed', createdAt: '2026-01-02T00:00:00.000Z' })
    const t3 = task({ taskId: 't3', runId: 'r3', status: 'completed', createdAt: '2026-01-03T00:00:00.000Z' })
    vi.mocked(api.listEvaluationExportTasks).mockResolvedValueOnce([t1, t2, t3])
    vi.mocked(api.cancelEvaluationExportTask).mockResolvedValue(undefined)
    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(captured.value?.tasks.map((t) => t.taskId)).toEqual(['t3', 't2', 't1'])
    await act(async () => {
      await captured.value!.dismissTask('t2')
    })
    expect(captured.value?.tasks.map((t) => t.taskId)).toEqual(['t3', 't1'])
  })

  it('calls refreshTask when a data chunk signals an agent session ref (line 76 true branch)', async () => {
    // The onData handler only calls refreshTask when:
    // 1. the task has no sessionRef yet, AND
    // 2. the chunk matches `[agent:xxx] starting localized rewrite|still running`
    const running = task({ taskId: 'ref-task', runId: 'run-ref', status: 'running' })
    const withRef = { ...running, sessionRef: { agent: 'claude' as const, sessionId: 'sid', logPath: '/tmp/x.jsonl' } }
    vi.mocked(api.startEvaluationExport).mockResolvedValue(running)
    vi.mocked(api.getEvaluationExportTask).mockResolvedValue(withRef)

    const captured = renderProbe()
    await act(async () => {
      await captured.value?.startExport('run-ref', 'localized')
    })

    // Fire a chunk matching the regex (no sessionRef yet → refreshTask fires)
    await act(async () => {
      taskSocket('ref-task').fire({ type: 'data', chunk: '[agent:claude] starting localized rewrite\n' })
      await Promise.resolve()
    })
    expect(api.getEvaluationExportTask).toHaveBeenCalledWith('ref-task')
  })

  it('throws when the hook is used outside the provider', () => {
    function OutsideProviderProbe() {
      useEvaluationExports()
      return null
    }

    expect(() => {
      act(() => {
        root.render(<OutsideProviderProbe />)
      })
    }).toThrow('useEvaluationExports must be used inside EvaluationExportProvider')
  })
})
