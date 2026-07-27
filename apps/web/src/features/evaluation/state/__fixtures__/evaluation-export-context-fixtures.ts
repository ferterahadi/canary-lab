import type { EvaluationExportTask } from '@/shared/api/types'
import { EvaluationExportProvider, useEvaluationExports } from '../EvaluationExportContext'
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

export function Probe({ captured }: { captured: { value: ReturnType<typeof useEvaluationExports> | null } }) {
  captured.value = useEvaluationExports()
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
