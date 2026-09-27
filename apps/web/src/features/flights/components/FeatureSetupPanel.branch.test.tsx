import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getRepoGitStatus, type GitRepoStatus } from '@/shared/api/client'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { BranchRow } from './FeatureSetupPanel'

vi.mock('@/shared/api/client', () => ({ getRepoGitStatus: vi.fn() }))
const status = (currentBranch: string): GitRepoStatus => ({ path: '/workspace/app', expectedBranch: null, isGitRepo: true, currentBranch, detached: false, dirty: false, dirtyFiles: [], localBranches: ['main', 'other'], remoteBranches: [] })
let container: HTMLDivElement
let root: Root
let invalidate: ReturnType<typeof useInvalidation>['invalidate']
const onSave = vi.fn()
function Editor() {
  invalidate = useInvalidation().invalidate
  return <BranchRow feature="checkout" repoName="app" value="my-draft" onSave={onSave} testId="branch" />
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(getRepoGitStatus).mockResolvedValue(status('main'))
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.resetAllMocks() })
it('refreshes Flight suggestions after events and missed events without changing its draft or saving', async () => {
  await act(async () => { root.render(<InvalidationProvider><Editor /></InvalidationProvider>) })
  const input = container.querySelector('input')!
  expect(input.placeholder).toBe('main')
  vi.mocked(getRepoGitStatus).mockResolvedValue(status('other'))
  await act(async () => { invalidate('repos') })
  expect(input.placeholder).toBe('other'); expect(input.value).toBe('my-draft'); expect(onSave).not.toHaveBeenCalled()
  vi.mocked(getRepoGitStatus).mockResolvedValue(status('main'))
  await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
  expect(input.placeholder).toBe('main'); expect(input.value).toBe('my-draft'); expect(onSave).not.toHaveBeenCalled()
})
it('marks retained suggestions stale but still allows pinning configuration, then recovers', async () => {
  await act(async () => { root.render(<InvalidationProvider><Editor /></InvalidationProvider>) })
  vi.mocked(getRepoGitStatus).mockRejectedValue(new Error('offline'))
  await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
  expect(container.textContent).toContain('Git status is stale')
  const input = container.querySelector('input')!
  expect(input.disabled).toBe(false); expect(input.placeholder).toBe('main')
  await act(async () => { input.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
  const main = [...container.querySelectorAll('button')].find((button) => button.textContent === 'main')!
  expect(main).toBeTruthy()
  await act(async () => { main.click() })
  expect(onSave).toHaveBeenCalledWith('main')
  vi.mocked(getRepoGitStatus).mockResolvedValue(status('other'))
  await act(async () => { window.dispatchEvent(new Event('online')) })
  expect(container.textContent).not.toContain('stale')
})
