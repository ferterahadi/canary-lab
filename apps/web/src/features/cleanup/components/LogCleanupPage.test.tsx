// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as cleanupApi from '@/shared/api/cleanup'
import * as runsApi from '@/shared/api/runs'
import * as portifyApi from '@/shared/api/portify'
import type { CleanupListing } from '@shared/cleanup-listing'
import { LogCleanupPage } from './LogCleanupPage'
import { WorkspaceTestProviders } from '@/test-helpers/workspace-providers'

vi.mock('@/shared/api/cleanup', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/cleanup')>()),
  cleanupRuns: vi.fn(),
  trimRun: vi.fn(),
  cleanupPortify: vi.fn(),
}))
vi.mock('@/shared/api/runs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/runs')>()),
  deleteRun: vi.fn(),
}))
vi.mock('@/shared/api/portify', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/portify')>()),
  removePortify: vi.fn(),
}))

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
  vi.mocked(cleanupApi.cleanupRuns).mockResolvedValue(structuredClone(LISTING))
  vi.mocked(cleanupApi.trimRun).mockResolvedValue({ freedBytes: 880_000_000 })
  vi.mocked(runsApi.deleteRun).mockResolvedValue(undefined)
  vi.mocked(cleanupApi.cleanupPortify).mockResolvedValue({
    workflows: [
      { workflowId: 'portify-2026-05-01T1000-x1', feature: 'shop', status: 'aborted', startedAt: '2026-05-01T10:00:00Z', folderBytes: 4_500_000 },
      { workflowId: 'portify-2026-05-02T1000-x2', feature: 'auth', status: 'saved', startedAt: '2026-05-02T10:00:00Z', folderBytes: 1_200_000 },
    ],
    totalBytes: 5_700_000,
  })
  vi.mocked(portifyApi.removePortify).mockResolvedValue({ workflowId: 'portify-2026-05-01T1000-x1', removed: true })
})

afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
  vi.clearAllMocks()
})

async function mount(
  onNavigateToRun?: (feature: string, runId: string) => void,
  onNavigateToPortify?: (feature: string) => void,
): Promise<void> {
  await act(async () => {
    root.render(
      <WorkspaceTestProviders actions={{ openPortifyStage: onNavigateToPortify }}>
        <LogCleanupPage
          onClose={() => {}}
          onNavigateToRun={onNavigateToRun}
        />
      </WorkspaceTestProviders>,
    )
  })
  // flush the cleanupRuns().then
  await act(async () => { await Promise.resolve() })
}

function runLink(runId: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>('button.cl-run-link')].find((b) => b.textContent === runId)
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
    const totals = buttonByText('Refresh')?.parentElement
    expect(totals?.textContent).toContain('On disk: 859 MB')
    expect(totals?.textContent).toContain('Trimmable: 839 MB')
    expect(totals?.textContent).toContain('Deletable: 858 MB')
    expect(totals?.querySelector('.cl-rubric')).toBeNull()
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
    expect(cleanupApi.trimRun).toHaveBeenCalledWith('2026-05-01T1000-aaaa')
  })

  it('clicking a run id navigates to that run', async () => {
    const onNavigateToRun = vi.fn()
    await mount(onNavigateToRun)
    await act(async () => { runLink('2026-05-01T1000-aaaa')?.click() })
    expect(onNavigateToRun).toHaveBeenCalledWith('shop', '2026-05-01T1000-aaaa')
  })

  it('orphans are not navigable (plain text, no run link)', async () => {
    await mount(() => {})
    expect(container.textContent).toContain('2026-05-04T1000-dddd')
    expect(runLink('2026-05-04T1000-dddd')).toBeUndefined()
  })

  it('run ids stay plain text when onNavigateToRun is absent', async () => {
    await mount()
    expect(runLink('2026-05-01T1000-aaaa')).toBeUndefined()
  })

  it('bulk delete via action bar calls api.deleteRun for each selected', async () => {
    await mount()
    await act(async () => { rowCheckbox('2026-05-03T1000-cccc')?.click() })
    await act(async () => { rowCheckbox('2026-05-04T1000-dddd')?.click() })
    await act(async () => { buttonByText('Delete runs')?.click() })
    const confirmBtn = [...container.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Delete') as HTMLButtonElement
    await act(async () => { confirmBtn.click() })
    await act(async () => { await Promise.resolve() })
    expect(runsApi.deleteRun).toHaveBeenCalledWith('2026-05-03T1000-cccc')
    expect(runsApi.deleteRun).toHaveBeenCalledWith('2026-05-04T1000-dddd')
  })

  it('portify per-row delete goes through the confirm (record-only note) before removing', async () => {
    await mount()
    await act(async () => { buttonByText('Portify')?.click() })
    await act(async () => { await Promise.resolve() })
    const row = container.querySelector('input[aria-label="Select shop"]')!.closest('tr')!
    const deleteBtn = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Delete') as HTMLButtonElement
    await act(async () => { deleteBtn.click() })
    // No API call yet — the confirm dialog with the overlay note must appear first.
    expect(portifyApi.removePortify).not.toHaveBeenCalled()
    const dialog = container.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('saved overlay')
    expect(dialog.textContent).toContain('Delete Portify record')
    const confirmBtn = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Delete') as HTMLButtonElement
    await act(async () => { confirmBtn.click() })
    await act(async () => { await Promise.resolve() })
    expect(portifyApi.removePortify).toHaveBeenCalledWith('portify-2026-05-01T1000-x1')
    expect(portifyApi.removePortify).toHaveBeenCalledTimes(1)
  })

  it('opens Portify history in the feature Flight stage', async () => {
    const onNavigateToPortify = vi.fn()
    await mount(undefined, onNavigateToPortify)
    await act(async () => { buttonByText('Portify')?.click() })
    await act(async () => { await Promise.resolve() })
    const row = container.querySelector('input[aria-label="Select shop"]')!.closest('tr')!
    const open = [...row.querySelectorAll('button')].find((button) => button.textContent === 'Portify') as HTMLButtonElement
    await act(async () => { open.click() })
    expect(onNavigateToPortify).toHaveBeenCalledWith('shop')
  })

  it('portify confirm cancel removes nothing', async () => {
    await mount()
    await act(async () => { buttonByText('Portify')?.click() })
    await act(async () => { await Promise.resolve() })
    const row = container.querySelector('input[aria-label="Select auth"]')!.closest('tr')!
    const deleteBtn = [...row.querySelectorAll('button')].find((b) => b.textContent === 'Delete') as HTMLButtonElement
    await act(async () => { deleteBtn.click() })
    const cancelBtn = [...container.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent === 'Cancel') as HTMLButtonElement
    await act(async () => { cancelBtn.click() })
    expect(portifyApi.removePortify).not.toHaveBeenCalled()
    expect(container.querySelector('[role="dialog"]')).toBeNull()
  })
})
