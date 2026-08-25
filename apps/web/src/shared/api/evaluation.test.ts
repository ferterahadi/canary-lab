import { describe, it, expect, vi } from 'vitest'
import {
  startEvaluationExport,
  getEvaluationExportTask,
  listEvaluationExportTasks,
  cancelEvaluationExportTask,
  downloadEvaluationExportTask,
} from './evaluation'
import { ok } from './__fixtures__/response'

describe('evaluation api', () => {
  it('cancelEvaluationExportTask deletes the task endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    await cancelEvaluationExportTask('task/1', { baseUrl: 'http://x', fetchImpl })
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/evaluation-exports/task%2F1',
      { method: 'DELETE' },
    )
  })

  it('starts and fetches evaluation export tasks', async () => {
    const task = {
      taskId: 'task/1',
      runId: 'run/1',
      feature: 'checkout',
      mode: 'localized',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      downloadReady: false,
    }
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(ok(task, 202))
      .mockResolvedValueOnce(ok({ ...task, status: 'completed', downloadReady: true }))

    await expect(startEvaluationExport('run/1', 'localized', { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(task)
    await expect(getEvaluationExportTask('task/1', { baseUrl: 'http://x', fetchImpl })).resolves.toMatchObject({
      status: 'completed',
      downloadReady: true,
    })

    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'http://x/api/runs/run%2F1/evaluation-export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'localized' }),
    })
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'http://x/api/evaluation-exports/task%2F1', { method: 'GET' })
  })

  it('lists evaluation export tasks with optional run filtering', async () => {
    const tasks = [{ taskId: 'task-1', runId: 'run/1' }]
    const fetchImpl = vi.fn().mockResolvedValue(ok(tasks))

    await expect(listEvaluationExportTasks({ runId: 'run/1' }, { baseUrl: 'http://x', fetchImpl })).resolves.toEqual(tasks)

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/api/evaluation-exports?runId=run%2F1',
      { method: 'GET' },
    )
  })

  it('lists evaluation export tasks without query when no runId', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok([]))
    await expect(listEvaluationExportTasks({}, { baseUrl: 'http://x', fetchImpl })).resolves.toEqual([])
    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/evaluation-exports', { method: 'GET' })
  })

  it('downloads using the ambient document and URL when no overrides are provided', async () => {
    const link = {
      href: '',
      download: '',
      style: { display: '' },
      click: vi.fn(),
      remove: vi.fn(),
    } as unknown as HTMLAnchorElement
    const ambientDoc = {
      body: { appendChild: vi.fn() },
      createElement: vi.fn().mockReturnValue(link),
    }
    const ambientURL = {
      createObjectURL: vi.fn().mockReturnValue('blob:ambient'),
      revokeObjectURL: vi.fn(),
    }
    vi.stubGlobal('document', ambientDoc)
    vi.stubGlobal('URL', ambientURL)
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new Blob(['zip']), { status: 200 }))
    try {
      await downloadEvaluationExportTask(
        {
          taskId: 'task-amb',
          runId: 'run-amb',
          feature: 'ambient',
          mode: 'raw',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
          downloadReady: true,
        },
        { fetchImpl },
      )
    } finally {
      vi.unstubAllGlobals()
    }
    expect(link.click).toHaveBeenCalled()
    expect(ambientURL.createObjectURL).toHaveBeenCalled()
  })

  it('downloads evaluation export zip files with safe filenames', async () => {
    const link = {
      href: '',
      download: '',
      style: { display: '' },
      click: vi.fn(),
      remove: vi.fn(),
    } as unknown as HTMLAnchorElement
    const documentRef = {
      body: { appendChild: vi.fn() },
      createElement: vi.fn().mockReturnValue(link),
    } as unknown as Document
    const urlApi = {
      createObjectURL: vi.fn().mockReturnValue('blob:export'),
      revokeObjectURL: vi.fn(),
    }
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new Blob(['zip']), { status: 200 }))

    await downloadEvaluationExportTask(
      {
        taskId: 'task/1',
        runId: '///',
        feature: 'checkout flow',
        mode: 'raw',
        status: 'completed',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        downloadReady: true,
      },
      { baseUrl: 'http://x', fetchImpl, documentRef, urlApi },
    )

    expect(fetchImpl).toHaveBeenCalledWith('http://x/api/evaluation-exports/task%2F1/download', { method: 'GET' })
    expect(link.href).toBe('blob:export')
    expect(link.download).toBe('canary-lab-evaluation-checkout-flow-run.zip')
    expect(link.click).toHaveBeenCalled()
    expect(link.remove).toHaveBeenCalled()
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:export')
  })
})
