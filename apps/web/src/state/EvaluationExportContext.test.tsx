// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api/client'
import type { EvaluationExportTask } from '../api/types'
import { EvaluationExportProvider, useEvaluationExports } from './EvaluationExportContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return {
    ...actual,
    startEvaluationExport: vi.fn(),
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

describe('EvaluationExportProvider', () => {
  it('starts an export, streams logs, refreshes on exit, and exposes selection helpers', async () => {
    const captured = renderProbe()
    const running = task({ taskId: 'task-1', runId: 'run-1', mode: 'localized', status: 'running' })
    const completed = task({ ...running, status: 'completed', downloadReady: true })
    vi.mocked(api.startEvaluationExport).mockResolvedValue(running)
    vi.mocked(api.getEvaluationExportTask).mockResolvedValue(completed)

    await act(async () => {
      await captured.value?.startExport('run-1', 'localized')
    })

    expect(api.startEvaluationExport).toHaveBeenCalledWith('run-1', 'localized')
    expect(FakeWebSocket.instances[0].url).toBe('ws://test/ws/evaluation-exports/task-1')
    expect(captured.value?.latestTask?.taskId).toBe('task-1')
    expect(captured.value?.selectedTask?.taskId).toBe('task-1')
    expect(captured.value?.taskForRun('run-1')?.taskId).toBe('task-1')
    expect(captured.value?.taskForRun('missing')).toBeNull()
    expect(captured.value?.logsByTaskId['task-1']).toContain('localized output')

    act(() => {
      FakeWebSocket.instances[0].fire({ type: 'data', chunk: 'chunk\n' })
    })
    expect(captured.value?.logsByTaskId['task-1']).toContain('chunk')

    await act(async () => {
      FakeWebSocket.instances[0].fire({ type: 'exit', code: 0 })
      await Promise.resolve()
    })
    expect(captured.value?.latestTask?.status).toBe('completed')

    act(() => {
      captured.value?.openTask()
    })
    expect(captured.value?.dialogOpen).toBe(true)

    await act(async () => {
      await captured.value?.downloadTask('task-1')
      await captured.value?.downloadTask('unknown-task')
    })
    expect(api.downloadEvaluationExportTask).toHaveBeenCalledWith(completed)

    act(() => {
      captured.value?.closeDialog()
    })
    expect(captured.value?.dialogOpen).toBe(false)
  })

  it('polls running tasks and records refresh failures', async () => {
    vi.useFakeTimers()
    const captured = renderProbe()
    const running = task({ taskId: 'task-2', status: 'running' })
    vi.mocked(api.startEvaluationExport).mockResolvedValue(running)
    vi.mocked(api.getEvaluationExportTask).mockRejectedValue(new Error('offline'))

    await act(async () => {
      await captured.value?.startExport('run-2', 'raw')
    })
    await act(async () => {
      vi.advanceTimersByTime(1500)
      await Promise.resolve()
    })

    expect(api.getEvaluationExportTask).toHaveBeenCalledWith('task-2')
    expect(captured.value?.logsByTaskId['task-2']).toContain('unable to refresh task: offline')
  })

  it('keeps an explicitly selected remaining task when dismissing another task', async () => {
    const captured = renderProbe()
    const older = task({ taskId: 'older-task', runId: 'run-old', createdAt: '2026-01-01T00:00:00.000Z' })
    const newer = task({ taskId: 'newer-task', runId: 'run-new', createdAt: '2026-01-02T00:00:00.000Z' })
    vi.mocked(api.startEvaluationExport)
      .mockResolvedValueOnce(older)
      .mockResolvedValueOnce(newer)
    vi.mocked(api.cancelEvaluationExportTask).mockResolvedValue(undefined)

    await act(async () => {
      await captured.value?.startExport('run-old', 'raw')
      await captured.value?.startExport('run-new', 'raw')
    })
    act(() => {
      captured.value?.openTask('older-task')
    })
    expect(captured.value?.selectedTask?.taskId).toBe('older-task')
    expect(captured.value?.dialogOpen).toBe(true)

    await act(async () => {
      await captured.value?.dismissTask('newer-task')
    })

    expect(captured.value?.tasks.map((item) => item.taskId)).toEqual(['older-task'])
    expect(captured.value?.selectedTask?.taskId).toBe('older-task')
    expect(captured.value?.dialogOpen).toBe(true)
  })

  it('leaves the dialog closed when opening without any known task', () => {
    const captured = renderProbe()

    act(() => {
      captured.value?.openTask()
    })

    expect(captured.value?.selectedTask).toBeNull()
    expect(captured.value?.dialogOpen).toBe(false)
  })

  it('handles duplicate task subscriptions, string failures, and missing selections', async () => {
    vi.useFakeTimers()
    class ThrowingStringWebSocket {
      constructor() {
        throw 'socket string failure'
      }
    }
    const captured = renderProbe(ThrowingStringWebSocket as unknown as typeof WebSocket)
    const running = task({ taskId: 'same-task', status: 'running' })
    vi.mocked(api.startEvaluationExport)
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(running)
    vi.mocked(api.getEvaluationExportTask).mockRejectedValue('refresh string failure')

    await act(async () => {
      await captured.value?.startExport('run-a', 'raw')
      await captured.value?.startExport('run-a', 'raw')
    })
    expect(captured.value?.logsByTaskId['same-task']).toContain('log stream unavailable: socket string failure')

    act(() => {
      captured.value?.openTask('missing-task')
    })
    expect(captured.value?.selectedTask).toBeNull()

    await act(async () => {
      vi.advanceTimersByTime(1500)
      await Promise.resolve()
    })
    expect(captured.value?.logsByTaskId['same-task']).toContain('unable to refresh task: refresh string failure')
  })

  it('handles socket setup failures, stream errors, dismiss, and unmount cleanup', async () => {
    class ThrowingWebSocket {
      constructor() {
        throw new Error('socket unavailable')
      }
    }
    const captured = renderProbe(ThrowingWebSocket as unknown as typeof WebSocket)
    vi.mocked(api.startEvaluationExport).mockResolvedValue(task({ taskId: 'task-3', status: 'running' }))
    vi.mocked(api.cancelEvaluationExportTask).mockRejectedValue(new Error('already gone'))

    await act(async () => {
      await captured.value?.startExport('run-3', 'raw')
    })
    expect(captured.value?.logsByTaskId['task-3']).toContain('log stream unavailable: socket unavailable')

    act(() => {
      captured.value?.openTask('task-3')
    })
    expect(captured.value?.dialogOpen).toBe(true)

    await act(async () => {
      await captured.value?.dismissTask('task-3')
    })
    expect(api.cancelEvaluationExportTask).toHaveBeenCalledWith('task-3')
    expect(captured.value?.tasks).toEqual([])
    expect(captured.value?.selectedTask).toBeNull()
    expect(captured.value?.dialogOpen).toBe(false)
    expect(captured.value?.logsByTaskId['task-3']).toBeUndefined()

    const socketCaptured = renderProbe()
    vi.mocked(api.startEvaluationExport).mockResolvedValue(task({ taskId: 'task-4', status: 'running' }))
    await act(async () => {
      await socketCaptured.value?.startExport('run-4', 'raw')
    })
    act(() => {
      FakeWebSocket.instances[0].fire({ type: 'error' })
    })
    expect(socketCaptured.value?.logsByTaskId['task-4']).toContain('log stream error: unknown error')

    act(() => {
      root.unmount()
    })
    expect(FakeWebSocket.instances[0].closeCalls).toBe(1)
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
