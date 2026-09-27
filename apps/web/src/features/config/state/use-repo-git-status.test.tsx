import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { getRepoGitStatus, type GitRepoStatus } from '@/shared/api/client'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { useRepoGitStatus } from './use-repo-git-status'

vi.mock('@/shared/api/client', () => ({ getRepoGitStatus: vi.fn() }))
const status = (currentBranch: string): GitRepoStatus => ({ path: '/workspace/app', expectedBranch: null, isGitRepo: true, currentBranch, detached: false, dirty: false, dirtyFiles: [], localBranches: ['main', 'other'], remoteBranches: [] })
let container: HTMLDivElement
let root: Root
let live: ReturnType<typeof useRepoGitStatus>
let invalidate: ReturnType<typeof useInvalidation>['invalidate']
function Reader({ feature = 'checkout', repo = 'app', opts }: { feature?: string; repo?: string; opts?: Parameters<typeof useRepoGitStatus>[2] }) {
  live = useRepoGitStatus(feature, repo, opts)
  invalidate = useInvalidation().invalidate
  return null
}
const render = (props: Parameters<typeof Reader>[0] = {}) => act(async () => { root.render(<InvalidationProvider><Reader {...props} /></InvalidationProvider>) })
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  vi.mocked(getRepoGitStatus).mockResolvedValue(status('main'))
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks() })

it('reads immediately, reconciles every thirty seconds, and does not refetch for unrelated renders', async () => {
  await render()
  expect(live.status?.currentBranch).toBe('main'); expect(live.confirmed).toBe(true)
  const refresh = live.refresh
  await render()
  expect(live.refresh).toBe(refresh); expect(getRepoGitStatus).toHaveBeenCalledTimes(1)
  await advance(29999); expect(getRepoGitStatus).toHaveBeenCalledTimes(1)
  vi.mocked(getRepoGitStatus).mockResolvedValue(status('other'))
  await advance(1); expect(live.status?.currentBranch).toBe('other')
  await act(async () => { live.refresh() }); expect(getRepoGitStatus).toHaveBeenCalledTimes(3)
  await act(async () => { invalidate('repos') }); expect(getRepoGitStatus).toHaveBeenCalledTimes(4)
  await render({ opts: { refreshKey: 1 } }); expect(getRepoGitStatus).toHaveBeenCalledTimes(5)
})

it.each([{ feature: '' }, { repo: '' }, { opts: { enabled: false } }, { opts: { localPath: '' } }])('keeps unresolved or disabled targets idle: %j', async (props) => {
  await render(props); await advance(20000)
  expect(getRepoGitStatus).not.toHaveBeenCalled(); expect(live.status).toBeNull(); expect(live.confirmed).toBe(false)
  expect(vi.getTimerCount()).toBe(0)
})

it('retains failed-read evidence and retries without certifying stale status', async () => {
  await render()
  vi.mocked(getRepoGitStatus).mockRejectedValue(new Error('offline'))
  await advance(30000)
  expect(live.status?.currentBranch).toBe('main'); expect(live.error).toBe('offline'); expect(live.confirmed).toBe(false)
  vi.mocked(getRepoGitStatus).mockResolvedValue(status('other'))
  await advance(30000)
  expect(live.status?.currentBranch).toBe('other'); expect(live.error).toBeNull(); expect(live.confirmed).toBe(true)
})

it('expires freshness when replacement reads hang and recovers after coming online', async () => {
  await render()
  vi.mocked(getRepoGitStatus).mockReturnValue(new Promise(() => {}))
  await advance(45000)
  expect(live.status?.currentBranch).toBe('main'); expect(live.confirmed).toBe(false)
  vi.mocked(getRepoGitStatus).mockResolvedValue(status('other'))
  await act(async () => { window.dispatchEvent(new Event('online')) })
  expect(live.confirmed).toBe(true); expect(live.status?.currentBranch).toBe('other')
  await act(async () => { window.dispatchEvent(new Event('offline')) })
  expect(live.confirmed).toBe(false); expect(live.error).toContain('Connection lost')
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(live.confirmed).toBe(true)
})

it('separates suite, repo and local-path identities and drops late reads from previous targets', async () => {
  await render({ opts: { localPath: '/workspace/old' } })
  let resolveOld!: (value: GitRepoStatus) => void
  vi.mocked(getRepoGitStatus).mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))
  await act(async () => { live.refresh() })
  vi.mocked(getRepoGitStatus).mockReturnValueOnce(new Promise(() => {}))
  await render({ opts: { localPath: '/workspace/new' } })
  expect(live.status).toBeNull(); expect(live.confirmed).toBe(false)
  await act(async () => { resolveOld(status('stale')) })
  expect(live.status).toBeNull()
  vi.mocked(getRepoGitStatus).mockResolvedValue(status('new'))
  await render({ feature: 'billing', repo: 'server', opts: { localPath: '/workspace/new' } })
  expect(getRepoGitStatus).toHaveBeenLastCalledWith('billing', 'server', expect.objectContaining({ readRevision: expect.any(String) }))
  expect(live.status?.currentBranch).toBe('new')
  await render({ opts: { enabled: false } })
  expect(live.status).toBeNull(); expect(vi.getTimerCount()).toBe(0)
})

it('releases timers and lifecycle listeners on unmount and keeps remounts uncached', async () => {
  const removeWindow = vi.spyOn(window, 'removeEventListener')
  const removeDocument = vi.spyOn(document, 'removeEventListener')
  await render()
  await act(async () => { root.render(null) })
  const count = vi.mocked(getRepoGitStatus).mock.calls.length
  await advance(20000)
  expect(getRepoGitStatus).toHaveBeenCalledTimes(count); expect(vi.getTimerCount()).toBe(0)
  for (const event of ['focus', 'online', 'offline']) expect(removeWindow).toHaveBeenCalledWith(event, expect.any(Function))
  expect(removeDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function))
  vi.mocked(getRepoGitStatus).mockReturnValue(new Promise(() => {}))
  await render(); expect(live.status).toBeNull(); expect(live.confirmed).toBe(false)
})

it('isolates repository hints and pauses reads while the document is hidden', async () => {
  await render()
  await act(async () => { invalidate('repos', JSON.stringify(['repo', 'other', 'app'])) })
  expect(getRepoGitStatus).toHaveBeenCalledTimes(1)
  await act(async () => { invalidate('repos', JSON.stringify(['repo', 'checkout', 'app'])) })
  expect(getRepoGitStatus).toHaveBeenCalledTimes(2)
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  await advance(90000)
  expect(getRepoGitStatus).toHaveBeenCalledTimes(2); expect(live.confirmed).toBe(false)
  visibility.mockReturnValue('visible')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  expect(getRepoGitStatus).toHaveBeenCalledTimes(3); expect(live.confirmed).toBe(true)
})

it('keeps an absent repository name idle', async () => {
  function Missing() { live = useRepoGitStatus('checkout', undefined); return null }
  await act(async () => { root.render(<InvalidationProvider><Missing /></InvalidationProvider>) })
  expect(getRepoGitStatus).not.toHaveBeenCalled(); expect(live.status).toBeNull()
})
