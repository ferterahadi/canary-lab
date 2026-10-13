// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as evaluationApi from '@/shared/api/evaluation'
import type { EvaluationExportTaskView } from '@shared/evaluation-export-types'
import { mountRoot } from '@/test-helpers/mount-root'

const { connectEvaluationExportMock } = vi.hoisted(() => ({ connectEvaluationExportMock: vi.fn() }))

vi.mock('../api/evaluation-export-socket', () => ({
  connectEvaluationExport: connectEvaluationExportMock,
}))

vi.mock('@/shared/api/workspace-socket', () => ({
  connectWorkspaceEvents: () => ({ close: vi.fn() }),
}))

vi.mock('@/shared/api/evaluation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/evaluation')>()),
  listEvaluationExportTasks: vi.fn(),
  startEvaluationExport: vi.fn(),
}))

import { EvaluationExportProvider, useEvaluationExportLogs, useEvaluationExports } from './EvaluationExportContext'

let root: Root

mountRoot({ attach: true, onMount: (mounted) => ({ root } = mounted) })
beforeEach(() => {
  connectEvaluationExportMock.mockReset()
  vi.mocked(evaluationApi.listEvaluationExportTasks).mockReset().mockResolvedValue([])
  vi.mocked(evaluationApi.startEvaluationExport).mockReset()
})

function task(taskId: string): EvaluationExportTaskView {
  return {
    taskId,
    runId: `run-${taskId}`,
    feature: 'checkout',
    mode: 'raw',
    producer: 'internal',
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
    vi.mocked(evaluationApi.startEvaluationExport).mockResolvedValueOnce(task('error-task')).mockResolvedValueOnce(task('string-task'))
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
