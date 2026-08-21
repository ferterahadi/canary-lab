// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import type { EvaluationExportTask } from '@/shared/api/types'
import { EvaluationExportProvider, useEvaluationExports } from './EvaluationExportContext'
import { Probe, exportSockets, task, taskSocket, workspaceSocket } from './__fixtures__/evaluation-export-context-fixtures'

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

export class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  readyState = 0
  onmessage: ((event: MessageEvent) => void) | null = null
  // Never fired by the constructor: the reconnect handler only runs on a
  // RE-open, so a test has to drive open/close ordering itself.
  onopen: (() => void) | null = null
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
    // Only the live task gets a stream on mount. A finished export's log is
    // historical and is pulled by `watchTask` when a panel surfaces it.
    expect(exportSockets().map((socket) => socket.url)).toEqual([
      'ws://test/ws/evaluation-exports/persisted-running',
    ])

    act(() => {
      taskSocket('persisted-running').fire({ type: 'data', chunk: 'running restored log\n' })
    })
    expect(captured.value?.logsByTaskId['persisted-running']).toContain('running restored log')

    act(() => {
      captured.value?.watchTask('persisted-completed')
    })
    act(() => {
      taskSocket('persisted-completed').fire({ type: 'data', chunk: 'completed restored log\n' })
    })
    expect(captured.value?.logsByTaskId['persisted-completed']).toContain('completed restored log')
  })

  it('starts an export, streams logs, refreshes on exit, and exposes lookup helpers', async () => {
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
    expect(captured.value?.tasks[0]?.taskId).toBe('task-1')
    expect(captured.value?.taskById('task-1')?.taskId).toBe('task-1')
    expect(captured.value?.taskById('missing')).toBeNull()
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
    expect(captured.value?.tasks[0]?.status).toBe('completed')

    // watchTask on a task that already streams is a no-op (one socket).
    act(() => {
      captured.value?.watchTask('task-1')
    })
    expect(exportSockets()).toHaveLength(1)

    await act(async () => {
      await captured.value?.downloadTask('task-1')
      await captured.value?.downloadTask('unknown-task')
    })
    expect(api.downloadEvaluationExportTask).toHaveBeenCalledWith(completed)
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

  it('keeps the remaining task when dismissing another task', async () => {
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

    await act(async () => {
      await captured.value?.dismissTask('newer-task')
    })

    expect(captured.value?.tasks.map((item) => item.taskId)).toEqual(['older-task'])
    expect(captured.value?.taskById('older-task')?.taskId).toBe('older-task')
  })

  it('watchTask attaches a log stream for a task it did not start (R29 panels)', async () => {
    const existing = task({ taskId: 'cold-task', runId: 'run-cold', status: 'completed' })
    vi.mocked(api.listEvaluationExportTasks).mockResolvedValueOnce([existing])
    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    // Mount leaves finished tasks alone, so this is the only path that attaches.
    expect(exportSockets()).toHaveLength(0)
    act(() => {
      captured.value?.watchTask('cold-task')
    })
    expect(exportSockets()).toHaveLength(1)

    // Panels call watchTask from an effect, so repeat calls must not re-attach.
    act(() => {
      captured.value?.watchTask('cold-task')
      captured.value?.watchTask('cold-task')
    })
    expect(exportSockets()).toHaveLength(1)
  })

  it('replays a finished export log once a panel watches it', async () => {
    const done = task({ taskId: 'cold-task', runId: 'run-cold', status: 'completed' })
    vi.mocked(api.listEvaluationExportTasks).mockResolvedValueOnce([done])
    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })

    act(() => {
      captured.value?.watchTask('cold-task')
    })
    act(() => {
      taskSocket('cold-task').fire({ type: 'data', chunk: 'completed restored log\n' })
    })
    expect(captured.value?.logsByTaskId['cold-task']).toContain('completed restored log')
  })

  it('handles duplicate task subscriptions and string failures', async () => {
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

    await act(async () => {
      await captured.value?.dismissTask('task-3')
    })
    expect(api.cancelEvaluationExportTask).toHaveBeenCalledWith('task-3')
    expect(captured.value?.tasks).toEqual([])
    expect(captured.value?.taskById('task-3')).toBeNull()
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
    expect(captured.value?.tasks[0]?.taskId).toBe('external-task')
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

    expect(captured.value?.tasks.map((item) => item.taskId)).toContain('external-completed')
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

    expect(captured.value?.tasks[0]?.status).toBe('completed')
    expect(exportSockets()).toHaveLength(1)
  })

  it('removes export tasks deleted by workspace events', async () => {
    const existing = task({ taskId: 'delete-me', runId: 'run-delete', status: 'running' })
    vi.mocked(api.listEvaluationExportTasks).mockResolvedValueOnce([existing])
    const captured = renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    expect(captured.value?.taskById('delete-me')?.taskId).toBe('delete-me')

    act(() => {
      workspaceSocket().fire({ type: 'evaluation-export-deleted', taskId: 'delete-me' })
    })

    expect(captured.value?.tasks).toEqual([])
    expect(captured.value?.taskById('delete-me')).toBeNull()
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
    // A completed task is never attached on discovery — not on the first pass…
    expect(exportSockets()).toHaveLength(0)

    await act(async () => {
      vi.advanceTimersByTime(3000)
      await Promise.resolve()
    })

    // …and not on a later one either.
    expect(exportSockets()).toHaveLength(0)
  })

  it('re-lists on a workspace reconnect, since the bus has no replay', async () => {
    vi.useFakeTimers()
    const created = task({ taskId: 'missed-task', runId: 'run-missed', status: 'completed' })
    vi.mocked(api.listEvaluationExportTasks)
      .mockResolvedValueOnce([])
      .mockResolvedValue([created])

    const captured = renderProbe()
    await act(async () => { await Promise.resolve() })
    const first = workspaceSocket()
    act(() => { first.onopen?.() })
    expect(captured.value?.tasks).toEqual([])

    // Drop the socket and let it come back. Anything the server published in
    // the gap — this export finishing — was never delivered.
    await act(async () => {
      first.close()
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })
    const reopened = workspaceSocket()
    await act(async () => {
      reopened.onopen?.()
      await Promise.resolve()
    })

    expect(captured.value?.tasks.map((item) => item.taskId)).toEqual(['missed-task'])
  })

  it('survives a re-list that fails on reconnect', async () => {
    vi.useFakeTimers()
    const known = task({ taskId: 'known-task', runId: 'run-known', status: 'completed' })
    vi.mocked(api.listEvaluationExportTasks)
      .mockResolvedValueOnce([known])
      .mockRejectedValue(new Error('offline'))

    const captured = renderProbe()
    await act(async () => { await Promise.resolve() })
    const first = workspaceSocket()
    act(() => { first.onopen?.() })

    await act(async () => {
      first.close()
      vi.advanceTimersByTime(2000)
      await Promise.resolve()
    })
    await act(async () => {
      workspaceSocket().onopen?.()
      await Promise.resolve()
    })

    // A later valid push still recovers state, so the known list stays put.
    expect(captured.value?.tasks.map((item) => item.taskId)).toEqual(['known-task'])
  })
})
