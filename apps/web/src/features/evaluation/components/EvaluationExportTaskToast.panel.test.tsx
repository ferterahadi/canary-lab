// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EvaluationExportTask } from '../../../shared/api/types'
import { ExternalEvaluationPanel } from './EvaluationExportTaskToast'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The open-client CTA calls api.openAgentApp on click; stub it so the mount is inert.
vi.mock('../../../shared/api/client', async () => {
  const actual = await vi.importActual<typeof import('../../../shared/api/client')>('../../../shared/api/client')
  return { ...actual, openAgentApp: vi.fn(async () => {}) }
})

const BASE_TASK: EvaluationExportTask = {
  taskId: 'task-1',
  runId: '7cvh',
  feature: 'checkout',
  mode: 'localized',
  producer: 'external',
  status: 'running',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  downloadReady: false,
  clientKind: 'claude',
  sessionId: 'abc12345',
  conversationName: 'Export this into evaluation',
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

function render(task: EvaluationExportTask, log = ''): void {
  act(() => {
    root.render(<ExternalEvaluationPanel task={task} log={log} />)
  })
}

describe('ExternalEvaluationPanel', () => {
  it('renders the shared external-agent card (eyebrow + status) with an open-client CTA for a known client', () => {
    render(BASE_TASK)
    expect(container.querySelector('[data-testid="evaluation-external-monitor"]')).toBeTruthy()
    expect(container.textContent).toContain('External evaluation export session')
    expect(container.textContent).toContain('Exporting')
    // Known client → the "go check your Desktop agent" affordance.
    expect(container.textContent).toContain('Open Claude')
  })

  it('shows the tracked log, falling back to a waiting message when empty', () => {
    render(BASE_TASK, '')
    expect(container.querySelector('[data-testid="evaluation-external-log"]')?.textContent).toContain('Waiting for the client')
    render({ ...BASE_TASK }, '[external] author submitted 3 cases')
    expect(container.querySelector('[data-testid="evaluation-external-log"]')?.textContent).toContain('author submitted 3 cases')
  })

  it('an unknown client shows the monitor but no open CTA', () => {
    render({ ...BASE_TASK, clientKind: 'other' })
    expect(container.querySelector('[data-testid="evaluation-external-monitor"]')).toBeTruthy()
    expect(container.textContent).not.toContain('Open Claude')
    expect(container.textContent).not.toContain('Open Codex')
  })

  it('a completed export reads "Ready" and points at the download', () => {
    render({ ...BASE_TASK, status: 'completed', downloadReady: true })
    expect(container.textContent).toContain('Ready')
    expect(container.textContent).toContain('Download it from the list')
  })
})
