import type { EvaluationExportTask } from '@/shared/api/types'
import { EvaluationExportProvider, useEvaluationExportLogs, useEvaluationExports } from '../EvaluationExportContext'
import { FakeWebSocket } from '../EvaluationExportContext.test'

export function workspaceSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.find((item) => item.url === 'ws://test/ws/workspace')
  if (!socket) throw new Error('workspace socket not opened')
  return socket
}

export function exportSockets(): FakeWebSocket[] {
  return FakeWebSocket.instances.filter((item) => item.url.includes('/ws/evaluation-exports/'))
}

export function taskSocket(taskId: string): FakeWebSocket {
  const url = `ws://test/ws/evaluation-exports/${taskId}`
  const socket = FakeWebSocket.instances.find((item) => item.url === url)
  if (!socket) throw new Error(`task socket not opened: ${taskId}`)
  return socket
}

// Captures BOTH contexts (tasks/actions + the split-out log stream) so the
// provider tests keep asserting logs through one probe.
export function Probe({ captured }: {
  captured: { value: (ReturnType<typeof useEvaluationExports> & { logsByTaskId: Record<string, string> }) | null }
}) {
  captured.value = { ...useEvaluationExports(), logsByTaskId: useEvaluationExportLogs() }
  return null
}

export function task(overrides: Partial<EvaluationExportTask> = {}): EvaluationExportTask {
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
