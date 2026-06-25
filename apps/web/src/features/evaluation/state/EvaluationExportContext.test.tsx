// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../../../shared/api/client'
import type { EvaluationExportTask } from '../../../shared/api/types'
import { EvaluationExportProvider, useEvaluationExports } from './EvaluationExportContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/api/client')>('../../../shared/api/client')
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

describe('EvaluationExportProvider', () => {
  it('rehydrates persisted tasks and replays task logs on mount', async () => {
    const running = task({ taskId: 'persisted-running', runId: 'run-persisted', status: 'running' })
    const completed = task({
      taskId: 'persisted-completed',
      runId: 'run-done',
      status: 'completed',
      downloadReady: true,
      createdAt: '2026-01-02T00:00:00.000Z',
    })
    vi.mocked(api.listEvaluationExportTasks).mockResolvedValue([completed, running])

    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    expect(api.listEvaluationExportTasks).toHaveBeenCalledWith()
    expect(captured.value?.tasks.map((item) => item.taskId)).toEqual(['persisted-completed', 'persisted-running'])
    expect(captured.value?.taskForRun('run-persisted')?.taskId).toBe('persisted-running')
    expect(exportSockets().map((socket) => socket.url)).toEqual([
      'ws://test/ws/evaluation-exports/persisted-completed',
      'ws://test/ws/evaluation-exports/persisted-running',
    ])

    act(() => {
      taskSocket('persisted-completed').fire({ type: 'data', chunk: 'completed restored log\n' })
      taskSocket('persisted-running').fire({ type: 'data', chunk: 'running restored log\n' })
    })
    expect(captured.value?.logsByTaskId['persisted-completed']).toContain('completed restored log')
    expect(captured.value?.logsByTaskId['persisted-running']).toContain('running restored log')
  })

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
    expect(taskSocket('task-1').url).toBe('ws://test/ws/evaluation-exports/task-1')
    expect(captured.value?.latestTask?.taskId).toBe('task-1')
    expect(captured.value?.selectedTask?.taskId).toBe('task-1')
    expect(captured.value?.taskForRun('run-1')?.taskId).toBe('task-1')
    expect(captured.value?.taskForRun('missing')).toBeNull()
    expect(captured.value?.logsByTaskId['task-1']).toContain('localized output')

    act(() => {
      taskSocket('task-1').fire({ type: 'data', chunk: 'chunk\n' })
    })
    expect(captured.value?.logsByTaskId['task-1']).toContain('chunk')

    await act(async () => {
      taskSocket('task-1').fire({ type: 'exit', code: 0 })
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

  it('records refresh failures when a task log stream exits before task refresh succeeds', async () => {
    const captured = renderProbe()
    const running = task({ taskId: 'task-2', status: 'running' })
    vi.mocked(api.startEvaluationExport).mockResolvedValue(running)
    vi.mocked(api.getEvaluationExportTask).mockRejectedValue(new Error('offline'))

    await act(async () => {
      await captured.value?.startExport('run-2', 'raw')
    })
    await act(async () => {
      taskSocket('task-2').fire({ type: 'exit', code: 1 })
      await Promise.resolve()
    })

    expect(api.getEvaluationExportTask).toHaveBeenCalledWith('task-2')
    expect(captured.value?.logsByTaskId['task-2']).toContain('unable to refresh task: offline')
  })

  it('records non-error refresh failures from task log streams', async () => {
    const captured = renderProbe()
    const running = task({ taskId: 'task-string-failure', status: 'running' })
    vi.mocked(api.startEvaluationExport).mockResolvedValue(running)
    vi.mocked(api.getEvaluationExportTask).mockRejectedValue('offline string')

    await act(async () => {
      await captured.value?.startExport('run-string-failure', 'raw')
    })
    await act(async () => {
      taskSocket('task-string-failure').fire({ type: 'exit', code: 1 })
      await Promise.resolve()
    })

    expect(captured.value?.logsByTaskId['task-string-failure']).toContain('unable to refresh task: offline string')
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

    await act(async () => {
      await captured.value?.startExport('run-a', 'raw')
      await captured.value?.startExport('run-a', 'raw')
    })
    expect(captured.value?.logsByTaskId['same-task']).toContain('log stream unavailable: socket string failure')

    act(() => {
      captured.value?.openTask('missing-task')
    })
    expect(captured.value?.selectedTask).toBeNull()

    expect(captured.value?.logsByTaskId['same-task']).toContain('queued raw output export')
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
      taskSocket('task-4').fire({ type: 'error' })
    })
    expect(socketCaptured.value?.logsByTaskId['task-4']).toContain('log stream error: unknown error')

    act(() => {
      root.unmount()
    })
    expect(workspaceSocket().closeCalls).toBe(1)
  })

  it('skips re-subscribing a task that already has an active connection', async () => {
    const captured = renderProbe()
    const running = task({ taskId: 'dup-task', runId: 'run-dup', status: 'running' })
    vi.mocked(api.startEvaluationExport).mockResolvedValue(running)

    await act(async () => {
      await captured.value?.startExport('run-dup', 'raw')
    })
    expect(exportSockets()).toHaveLength(1)

    await act(async () => {
      await captured.value?.startExport('run-dup', 'raw')
    })
    // The second startExport reuses the existing connection rather than opening another.
    expect(exportSockets()).toHaveLength(1)
  })

  it('ignores rehydrated tasks when the provider unmounts before tasks resolve', async () => {
    let resolveTasks: (tasks: EvaluationExportTask[]) => void = () => {}
    vi.mocked(api.listEvaluationExportTasks).mockReturnValueOnce(
      new Promise<EvaluationExportTask[]>((resolve) => { resolveTasks = resolve }),
    )
    renderProbe()

    act(() => {
      root.unmount()
    })

    await act(async () => {
      resolveTasks([task({ taskId: 'late-task', runId: 'run-late', status: 'running' })])
      await Promise.resolve()
    })

    // No socket opens because the rehydration short-circuits on the cancelled flag.
    expect(exportSockets()).toHaveLength(0)
  })

  it('keeps an empty task list when listEvaluationExportTasks rejects on startup', async () => {
    vi.mocked(api.listEvaluationExportTasks).mockRejectedValueOnce(new Error('boom'))
    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(captured.value?.tasks).toEqual([])
  })

  it('discovers externally created export tasks without a refresh', async () => {
    const external = task({
      taskId: 'external-task',
      runId: 'run-external',
      producer: 'external',
      status: 'running',
      createdAt: '2026-01-02T00:00:00.000Z',
    })
    vi.mocked(api.listEvaluationExportTasks).mockResolvedValueOnce([])

    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    expect(captured.value?.tasks).toEqual([])

    act(() => {
      workspaceSocket().fire({ type: 'evaluation-export-created', task: external })
    })

    expect(api.listEvaluationExportTasks).toHaveBeenCalledTimes(1)
    expect(captured.value?.latestTask?.taskId).toBe('external-task')
    expect(captured.value?.taskForRun('run-external')?.taskId).toBe('external-task')
    expect(FakeWebSocket.instances.map((socket) => socket.url)).toContain('ws://test/ws/evaluation-exports/external-task')
  })

  it('updates export tasks from workspace events without subscribing completed tasks', async () => {
    const completed = task({ taskId: 'external-completed', runId: 'run-external', status: 'completed' })
    const running = task({ taskId: 'external-running', runId: 'run-external', status: 'running' })
    vi.mocked(api.listEvaluationExportTasks).mockResolvedValueOnce([])

    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    act(() => {
      workspaceSocket().fire({ type: 'evaluation-export-updated', task: completed })
      workspaceSocket().fire({ type: 'evaluation-export-updated', task: running })
      workspaceSocket().fire({ type: 'features-changed' })
    })

    expect(captured.value?.latestTask?.taskId).toBe('external-completed')
    expect(FakeWebSocket.instances.map((socket) => socket.url)).toContain('ws://test/ws/evaluation-exports/external-running')
    expect(FakeWebSocket.instances.map((socket) => socket.url)).not.toContain('ws://test/ws/evaluation-exports/external-completed')
  })

  it('does not resubscribe known completed tasks during startup reconciliation', async () => {
    let resolveTasks: (tasks: EvaluationExportTask[]) => void = () => {}
    const known = task({ taskId: 'known-completed', runId: 'run-known', status: 'completed' })
    vi.mocked(api.listEvaluationExportTasks).mockReturnValueOnce(
      new Promise<EvaluationExportTask[]>((resolve) => { resolveTasks = resolve }),
    )
    vi.mocked(api.startEvaluationExport).mockResolvedValueOnce(task({ ...known, status: 'running' }))
    const captured = renderProbe()

    await act(async () => {
      await captured.value?.startExport('run-known', 'raw')
    })
    expect(exportSockets()).toHaveLength(1)

    await act(async () => {
      resolveTasks([known])
      await Promise.resolve()
    })

    expect(captured.value?.latestTask?.status).toBe('completed')
    expect(exportSockets()).toHaveLength(1)
  })

  it('removes export tasks deleted by workspace events', async () => {
    const existing = task({ taskId: 'delete-me', runId: 'run-delete', status: 'running' })
    vi.mocked(api.listEvaluationExportTasks).mockResolvedValueOnce([existing])
    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    act(() => {
      captured.value?.openTask('delete-me')
    })
    expect(captured.value?.dialogOpen).toBe(true)

    act(() => {
      workspaceSocket().fire({ type: 'evaluation-export-deleted', taskId: 'delete-me' })
    })

    expect(captured.value?.tasks).toEqual([])
    expect(captured.value?.selectedTask).toBeNull()
    expect(captured.value?.dialogOpen).toBe(false)
  })

  it('keeps known tasks when periodic discovery fails', async () => {
    vi.useFakeTimers()
    const completed = task({ taskId: 'known-task', runId: 'run-known', status: 'completed' })
    vi.mocked(api.listEvaluationExportTasks)
      .mockResolvedValueOnce([completed])
      .mockRejectedValueOnce(new Error('offline'))

    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    expect(captured.value?.tasks.map((item) => item.taskId)).toEqual(['known-task'])

    await act(async () => {
      vi.advanceTimersByTime(3000)
      await Promise.resolve()
    })

    expect(captured.value?.tasks.map((item) => item.taskId)).toEqual(['known-task'])
  })

  it('does not re-subscribe unchanged completed tasks during periodic discovery', async () => {
    vi.useFakeTimers()
    const completed = task({ taskId: 'stable-task', runId: 'run-stable', status: 'completed' })
    vi.mocked(api.listEvaluationExportTasks)
      .mockResolvedValueOnce([completed])
      .mockResolvedValueOnce([completed])

    renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    expect(exportSockets()).toHaveLength(1)

    await act(async () => {
      vi.advanceTimersByTime(3000)
      await Promise.resolve()
    })

    expect(exportSockets()).toHaveLength(1)
  })

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

function workspaceSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.find((item) => item.url === 'ws://test/ws/workspace')
  if (!socket) throw new Error('workspace socket not opened')
  return socket
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
