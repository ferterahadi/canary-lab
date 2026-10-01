// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as cleanupApi from '@/shared/api/cleanup'
import * as runsApi from '@/shared/api/runs'
import * as portifyApi from '@/shared/api/portify'
import type { CleanupListing } from '@shared/cleanup-listing'
import type { InvalidationTopic } from '@/shared/state/invalidation-bus'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { CLEANUP_RECONCILE_MS } from '../state/use-cleanup-inventory'
import { LogCleanupPage } from './LogCleanupPage'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@/shared/api/cleanup', () => ({ cleanupRuns: vi.fn(), cleanupWorktrees: vi.fn(), cleanupPortify: vi.fn(), trimRun: vi.fn(), removeWorktree: vi.fn(), openWorktreePath: vi.fn() }))
vi.mock('@/shared/api/runs', () => ({ deleteRun: vi.fn() }))
vi.mock('@/shared/api/portify', () => ({ removePortify: vi.fn() }))

let container: HTMLDivElement
let root: Root
let invalidate: (topic: InvalidationTopic, scope?: string) => void
let listing: CleanupListing

function Harness() {
  invalidate = useInvalidation().invalidate
  return <LogCleanupPage onClose={() => {}} />
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  listing = {
    runs: ['one', 'two'].map((runId) => ({ runId, feature: runId, executionType: 'run', status: 'passed', startedAt: '2026-01-01T00:00:00Z', folderBytes: 100, artifactBytes: 50, active: false })),
    orphans: [], totals: { totalBytes: 200, reclaimableDeleteBytes: 200, reclaimableTrimBytes: 100 },
  }
  vi.mocked(cleanupApi.cleanupRuns).mockImplementation(async () => structuredClone(listing))
  vi.mocked(cleanupApi.cleanupWorktrees).mockResolvedValue({ worktrees: [
    { path: '/tmp/cleanup-example', sourceRoot: '/tmp/source-example', ref: 'HEAD', ownerKind: 'run', ownerId: 'one', slot: null, bytes: 100, exists: true, ageMs: 100, active: false },
  ] })
  vi.mocked(cleanupApi.cleanupPortify).mockResolvedValue({ workflows: [
    { workflowId: 'p-one', feature: 'first', status: 'saved', startedAt: '2026-01-01T00:00:00Z', folderBytes: 100 },
    { workflowId: 'p-two', feature: 'second', status: 'aborted', startedAt: '2026-01-01T00:00:00Z', folderBytes: 50 },
  ], totalBytes: 150 })
  vi.mocked(runsApi.deleteRun).mockResolvedValue(undefined)
  vi.mocked(portifyApi.removePortify).mockResolvedValue({ removed: true, workflowId: 'p-one' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function mount() {
  await act(async () => root.render(<InvalidationProvider><Harness /></InvalidationProvider>))
}
function checkbox(id: string) { return container.querySelector<HTMLInputElement>(`input[aria-label="Select ${id}"]`) }
function button(label: string, parent: ParentNode = container) {
  const found = [...parent.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent?.trim().startsWith(label))
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}
async function click(element: HTMLElement) { await act(async () => element.click()) }
async function changed(resource = 'runs') { await act(async () => invalidate('cleanup', resource)) }
async function tick() { await act(async () => { await vi.advanceTimersByTimeAsync(CLEANUP_RECONCILE_MS) }) }

it('makes four reconciliation reads per idle visible minute and refreshes on focus', async () => {
  await mount()
  expect(cleanupApi.cleanupRuns).toHaveBeenCalledTimes(1)
  await act(async () => vi.advanceTimersByTimeAsync(60_000))
  expect(cleanupApi.cleanupRuns).toHaveBeenCalledTimes(5)
  expect(cleanupApi.cleanupWorktrees).not.toHaveBeenCalled()
  expect(cleanupApi.cleanupPortify).not.toHaveBeenCalled()
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(cleanupApi.cleanupRuns).toHaveBeenCalledTimes(6)
})

it('updates a mounted inventory and totals while preserving selection, sort and scroll', async () => {
  await mount()
  await click(checkbox('one')!)
  const table = container.querySelector('table')!
  const scroller = table.parentElement!
  scroller.scrollTop = 70
  await click(container.querySelector<HTMLElement>('th[aria-sort]')!)
  const sort = container.querySelector('th[aria-sort="asc"]')?.textContent
  listing.runs[1].folderBytes = 2048
  listing.totals.totalBytes = 2148
  await changed()
  expect(container.querySelector('table')).toBe(table)
  expect(scroller.scrollTop).toBe(70)
  expect(checkbox('one')?.checked).toBe(true)
  expect(container.textContent).toContain('2 KB')
  expect(container.querySelector('th[aria-sort="asc"]')?.textContent).toBe(sort)
})

it('prunes newly active and removed selections and rechecks an open confirmation', async () => {
  await mount()
  await click(checkbox('one')!)
  await click(checkbox('two')!)
  await click(button('Delete runs'))
  listing.runs[0].active = true
  listing.runs.splice(1)
  await changed()
  expect(checkbox('one')?.checked).toBe(false)
  expect(checkbox('one')?.disabled).toBe(true)
  await click(button('Delete', container.querySelector('[role="dialog"]')!))
  expect(runsApi.deleteRun).not.toHaveBeenCalled()
})

it('recovers a missed event within one reconciliation interval and retains rows on errors', async () => {
  await mount()
  listing.runs.splice(1)
  await tick()
  expect(checkbox('two')).toBeNull()
  vi.mocked(cleanupApi.cleanupRuns).mockRejectedValueOnce(new Error('unreachable'))
  await tick()
  expect(checkbox('one')).not.toBeNull()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('outdated: unreachable')
  await tick()
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

it('rejects a late read after a newer inventory arrives', async () => {
  await mount()
  let finish!: (value: CleanupListing) => void
  const old = structuredClone(listing)
  vi.mocked(cleanupApi.cleanupRuns).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await changed()
  listing.runs.splice(1)
  await changed()
  await act(async () => finish(old))
  expect(checkbox('two')).toBeNull()
})

it('only scans the active tab and resumes after visibility returns', async () => {
  await mount()
  const runsReads = vi.mocked(cleanupApi.cleanupRuns).mock.calls.length
  await click(button('Worktrees'))
  expect(checkbox('one')).not.toBeNull()
  await tick()
  expect(cleanupApi.cleanupRuns).toHaveBeenCalledTimes(runsReads)
  expect(cleanupApi.cleanupWorktrees).toHaveBeenCalledTimes(2)
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(vi.getTimerCount()).toBe(0)
  await tick()
  expect(cleanupApi.cleanupWorktrees).toHaveBeenCalledTimes(2)
  visibility.mockReturnValue('visible')
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(cleanupApi.cleanupWorktrees).toHaveBeenCalledTimes(3)
  await act(async () => root.render(null))
  expect(vi.getTimerCount()).toBe(0)
  await tick()
  expect(cleanupApi.cleanupWorktrees).toHaveBeenCalledTimes(3)
})

it('updates worktrees on scoped invalidation and protects a worktree that becomes active', async () => {
  await mount()
  await click(button('Worktrees'))
  await click(button('Remove', checkbox('one')!.closest('tr')!))
  const next = await cleanupApi.cleanupWorktrees()
  next.worktrees[0].active = true
  vi.mocked(cleanupApi.cleanupWorktrees).mockResolvedValue(next)
  await changed('worktrees')
  await click(button('Remove', container.querySelector('[role="dialog"]')!))
  expect(cleanupApi.removeWorktree).not.toHaveBeenCalled()
  expect(checkbox('one')?.disabled).toBe(true)
})

it('preserves an unrelated Portify selection after a single-row removal', async () => {
  await mount()
  await click(button('Portify'))
  await click(checkbox('second')!)
  await click(button('Delete', checkbox('first')!.closest('tr')!))
  await click(button('Delete', container.querySelector('[role="dialog"]')!))
  expect(portifyApi.removePortify).toHaveBeenCalledExactlyOnceWith('p-one')
  expect(checkbox('second')?.checked).toBe(true)
  vi.mocked(cleanupApi.cleanupPortify).mockResolvedValue({ workflows: [], totalBytes: 0 })
  await changed('portify')
  expect(checkbox('second')).toBeNull()
  expect(container.textContent).toContain('No Portify records')
})

it('reports partial failures, clears the bulk selection and refreshes authoritative rows', async () => {
  await mount()
  vi.mocked(runsApi.deleteRun).mockRejectedValueOnce(new Error('active'))
  await click(checkbox('one')!)
  await click(checkbox('two')!)
  await click(button('Delete runs'))
  await click(button('Delete', container.querySelector('[role="dialog"]')!))
  expect(runsApi.deleteRun).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('1 of 2 deletes failed')
  expect(checkbox('one')?.checked).toBe(false)
  expect(cleanupApi.cleanupRuns).toHaveBeenCalledTimes(2)
})
