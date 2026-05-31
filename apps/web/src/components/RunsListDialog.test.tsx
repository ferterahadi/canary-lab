// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunIndexEntry } from '../api/types'
import { RunsListDialog } from './RunsListDialog'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const runs: RunIndexEntry[] = [
  { runId: 'r-run', feature: 'app_a', startedAt: '2026-05-31T10:00:00.000Z', status: 'running' },
  { runId: 'r-queue', feature: 'app_a', startedAt: '2026-05-31T10:01:00.000Z', status: 'queued' },
  { runId: 'r-done', feature: 'app_b', startedAt: '2026-05-31T09:00:00.000Z', status: 'passed', endedAt: '2026-05-31T09:05:00.000Z' },
]

const details: Record<string, { manifest: { services: Array<{ allocatedPorts?: Record<string, number> }>; queueReason?: string } }> = {
  'r-run': { manifest: { services: [{ allocatedPorts: { api: 51999 } }] } },
  'r-queue': { manifest: { services: [], queueReason: 'repo-collision' } },
}

vi.mock('../state/RunsContext', () => ({
  useRuns: () => ({ runs }),
  useRunDetails: () => details,
}))

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

describe('RunsListDialog', () => {
  it('groups runs by status and surfaces ports + queue reason', async () => {
    await act(async () => {
      root.render(<RunsListDialog onClose={() => {}} onNavigateToRun={() => {}} />)
    })
    const text = document.body.textContent ?? ''
    expect(text).toContain('Running')
    expect(text).toContain('Queued')
    expect(text).toContain('Finished')
    expect(text).toContain('app_a')
    expect(text).toContain('app_b')
    // Allocated port for the running run.
    expect(text).toContain(':51999')
    // Collision queue note.
    expect(text).toContain('waiting for the same app to finish')
  })

  it('navigates to a run and closes when a row is clicked', async () => {
    const onNavigateToRun = vi.fn()
    const onClose = vi.fn()
    await act(async () => {
      root.render(<RunsListDialog onClose={onClose} onNavigateToRun={onNavigateToRun} />)
    })
    const row = [...container.querySelectorAll('button')]
      .find((b) => b.getAttribute('title') === 'Go to run r-run')
    expect(row).toBeTruthy()
    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onNavigateToRun).toHaveBeenCalledWith('app_a', 'r-run')
    expect(onClose).toHaveBeenCalled()
  })
})
