// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '@/shared/api/client'
import type { EvaluationExportTask } from '@/shared/api/types'

const { connectEvaluationExportMock } = vi.hoisted(() => ({ connectEvaluationExportMock: vi.fn() }))

vi.mock('../api/evaluation-export-socket', () => ({
  connectEvaluationExport: connectEvaluationExportMock,
}))

vi.mock('@/shared/api/workspace-socket', () => ({
  connectWorkspaceEvents: () => ({ close: vi.fn() }),
}))

vi.mock('@/shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/shared/api/client')>('../../../shared/api/client')
  return {
    ...actual,
    listEvaluationExportTasks: vi.fn(),
    startEvaluationExport: vi.fn(),
  }
})

import { EvaluationExportProvider, useEvaluationExportLogs, useEvaluationExports } from './EvaluationExportContext'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  connectEvaluationExportMock.mockReset()
  vi.mocked(api.listEvaluationExportTasks).mockReset().mockResolvedValue([])
  vi.mocked(api.startEvaluationExport).mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function task(taskId: string): EvaluationExportTask {
  return {
    taskId,
    runId: `run-${taskId}`,
    feature: 'checkout',
    mode: 'raw',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    downloadReady: false,
  }
}

describe('EvaluationExportProvider subscription failures', () => {
  it('keeps a queued export visible when a custom stream adapter throws either error shape', async () => {
    const captured: {
      exports: ReturnType<typeof useEvaluationExports> | null
      logs: Record<string, string>
    } = { exports: null, logs: {} }
    function Probe() {
      captured.exports = useEvaluationExports()
      captured.logs = useEvaluationExportLogs()
      return null
    }
    act(() => {
      root.render(
        <EvaluationExportProvider>
          <Probe />
        </EvaluationExportProvider>,
      )
    })
    vi.mocked(api.startEvaluationExport).mockResolvedValueOnce(task('error-task')).mockResolvedValueOnce(task('string-task'))
    connectEvaluationExportMock
      .mockImplementationOnce(() => { throw new Error('adapter offline') })
      .mockImplementationOnce(() => { throw 'adapter string failure' })

    await act(async () => {
      await captured.exports?.startExport('run-error', 'raw')
      await captured.exports?.startExport('run-string', 'raw')
    })

    expect(captured.logs['error-task']).toContain('log stream unavailable: adapter offline')
    expect(captured.logs['string-task']).toContain('log stream unavailable: adapter string failure')
    expect(captured.exports?.tasks.map((item) => item.taskId)).toEqual(['error-task', 'string-task'])
  })
})
