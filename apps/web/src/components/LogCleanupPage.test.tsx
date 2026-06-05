// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api/client'
import type { CleanupListing } from '../api/types'
import { LogCleanupPage } from './LogCleanupPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client')
  return { ...actual, cleanupRuns: vi.fn(), trimRun: vi.fn(), deleteRun: vi.fn() }
})

const LISTING: CleanupListing = {
  runs: [
    { runId: '2026-05-01T1000-aaaa', feature: 'shop', executionType: 'run', status: 'passed', startedAt: '2026-05-01T10:00:00Z', endedAt: '2026-05-01T10:05:00Z', folderBytes: 900_000_000, artifactBytes: 880_000_000, active: false },
    { runId: '2026-05-02T1000-bbbb', feature: 'shop', executionType: 'run', status: 'running', startedAt: '2026-05-02T10:00:00Z', folderBytes: 1_000_000, artifactBytes: 500_000, active: true },
    { runId: '2026-05-03T1000-cccc', feature: 'auth', executionType: 'boot', status: 'aborted', startedAt: '2026-05-03T10:00:00Z', folderBytes: 4096, artifactBytes: 0, active: false },
  ],
  orphans: [{ runId: '2026-05-04T1000-dddd', folderBytes: 2048 }],
  totals: { totalBytes: 901_006_144, reclaimableTrimBytes: 880_000_000, reclaimableDeleteBytes: 900_006_144 },
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  vi.mocked(api.cleanupRuns).mockResolvedValue(structuredClone(LISTING))
  vi.mocked(api.trimRun).mockResolvedValue({ freedBytes: 880_000_000 })
  vi.mocked(api.deleteRun).mockResolvedValue(undefined)
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.clearAllMocks()
})

async function mount(): Promise<void> {
  await act(async () => { root.render(<LogCleanupPage onClose={() => {}} />) })
  // flush the cleanupRuns().then
  await act(async () => { await Promise.resolve() })
}

function rowCheckbox(runId: string): HTMLInputElement | undefined {
  return container.querySelector<HTMLInputElement>(`input[aria-label="Select ${runId}"]`) ?? undefined
}

function buttonByText(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined
}

describe('LogCleanupPage', () => {
  it('renders runs, orphans, and totals after load', async () => {
    await mount()
    expect(container.textContent).toContain('2026-05-01T1000-aaaa')
    expect(container.textContent).toContain('ORPHAN')
    expect(container.textContent).toContain('839 MB') // 880_000_000 bytes, binary MB
  })

  it('disables the checkbox for an active run', async () => {
    await mount()
    expect(rowCheckbox('2026-05-02T1000-bbbb')?.disabled).toBe(true)
    expect(rowCheckbox('2026-05-01T1000-aaaa')?.disabled).toBe(false)
  })

  it('a preset selects matching rows and excludes active ones', async () => {
    await mount()
    // Presets live behind the "Quick select" dropdown — open it, then pick one.
    await act(async () => { buttonByText('Quick select')?.click() })
    await act(async () => { buttonByText('Orphaned folders')?.click() })
    expect(rowCheckbox('2026-05-04T1000-dddd')?.checked).toBe(true)
    expect(rowCheckbox('2026-05-01T1000-aaaa')?.checked).toBe(false)
  })

  it('trimming a row goes through confirm then calls api.trimRun', async () => {
    await mount()
    // per-row Trim button on the big passed run
    const row = container.querySelector(`input[aria-label="Select 2026-05-01T1000-aaaa"]`)!.closest('tr')!
    const trimBtn = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Trim') as HTMLButtonElement
    await act(async () => { trimBtn.click() })
    // confirm dialog appears
    expect(container.textContent).toContain('Trim artifacts')
    const confirmBtn = [...container.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Trim') as HTMLButtonElement
    await act(async () => { confirmBtn.click() })
    await act(async () => { await Promise.resolve() })
    expect(api.trimRun).toHaveBeenCalledWith('2026-05-01T1000-aaaa')
  })

  it('bulk delete via action bar calls api.deleteRun for each selected', async () => {
    await mount()
    await act(async () => { rowCheckbox('2026-05-03T1000-cccc')?.click() })
    await act(async () => { rowCheckbox('2026-05-04T1000-dddd')?.click() })
    await act(async () => { buttonByText('Delete runs')?.click() })
    const confirmBtn = [...container.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Delete') as HTMLButtonElement
    await act(async () => { confirmBtn.click() })
    await act(async () => { await Promise.resolve() })
    expect(api.deleteRun).toHaveBeenCalledWith('2026-05-03T1000-cccc')
    expect(api.deleteRun).toHaveBeenCalledWith('2026-05-04T1000-dddd')
  })
})
