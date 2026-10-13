import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/api/internal'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { cycleReviewFromPatch } from '@shared/test-view/cycle-review'
import { useCycleReview } from './use-cycle-review'

vi.mock(import('@/shared/api/runs'), async (importOriginal) => ({ ...(await importOriginal()), getRunCycleReview: vi.fn() }))

let seen: ReturnType<typeof useCycleReview> | undefined
function Probe({ runId, iteration }: { runId: string; iteration: number | null }) {
  seen = useCycleReview(runId, iteration)
  return null
}

async function render(runId: string, iteration: number | null) {
  const root = createRoot(document.createElement('div'))
  await act(async () => {
    root.render(<Probe runId={runId} iteration={iteration} />)
    await new Promise((r) => setTimeout(r, 0))
  })
  return root
}

afterEach(() => vi.clearAllMocks())

it('reads a cycle’s files by its journal iteration', async () => {
  const runsApi = await import('@/shared/api/runs')
  vi.mocked(runsApi.getRunCycleReview).mockResolvedValue({ iteration: 3, source: 'patch', patchPath: '/p', truncated: false, healMode: 'service', files: [] })
  const root = await render('patch-run-1', 3)
  expect(runsApi.getRunCycleReview).toHaveBeenCalledWith('patch-run-1', 3)
  expect(seen?.value).toEqual({ iteration: 3, source: 'patch', patchPath: '/p', truncated: false, healMode: 'service', files: [] })
  act(() => root.unmount())
})

it('reports a patch the run never persisted as missing, and other failures as errors', async () => {
  const runsApi = await import('@/shared/api/runs')
  vi.mocked(runsApi.getRunCycleReview).mockRejectedValueOnce(new ApiError(404, null))
  const missing = await render('patch-run-2', 1)
  expect(seen?.value).toBe('missing')
  act(() => missing.unmount())
  vi.mocked(runsApi.getRunCycleReview).mockRejectedValueOnce(new ApiError(500, null, 'boom'))
  const failed = await render('patch-run-3', 1)
  expect(seen?.value).toBeNull()
  expect(seen?.error).toContain('boom')
  act(() => failed.unmount())
})

it('reads nothing without an iteration', async () => {
  const runsApi = await import('@/shared/api/runs')
  const root = await render('patch-run-4', null)
  expect(runsApi.getRunCycleReview).not.toHaveBeenCalled()
  expect(seen?.value).toBeNull()
  act(() => root.unmount())
})

it('re-reads the cycle when its run’s journal changes, and not for another run', async () => {
  const runsApi = await import('@/shared/api/runs')
  vi.mocked(runsApi.getRunCycleReview)
    .mockResolvedValueOnce({ iteration: 2, source: 'patch', patchPath: '/p', truncated: false, healMode: 'service', files: [] })
    .mockResolvedValueOnce({ iteration: 2, source: 'patch', patchPath: '/p', truncated: false, healMode: 'service', files: cycleReviewFromPatch('diff --git a/a.ts b/a.ts\n') })
  let invalidate: ReturnType<typeof useInvalidation>['invalidate'] = () => {}
  function Bump() { invalidate = useInvalidation().invalidate; return null }
  const root = createRoot(document.createElement('div'))
  await act(async () => {
    root.render(<InvalidationProvider><Bump /><Probe runId="live-run" iteration={2} /></InvalidationProvider>)
    await new Promise((r) => setTimeout(r, 0))
  })
  expect(seen?.value).toMatchObject({ files: [] })
  await act(async () => { invalidate('journal', 'other-run'); await new Promise((r) => setTimeout(r, 0)) })
  expect(runsApi.getRunCycleReview).toHaveBeenCalledTimes(1)
  // What a `journal-changed` workspace event for this run does.
  await act(async () => { invalidate('journal', 'live-run'); await new Promise((r) => setTimeout(r, 0)) })
  expect(runsApi.getRunCycleReview).toHaveBeenCalledTimes(2)
  expect(seen?.value).toMatchObject({ files: [{ path: 'a.ts' }] })
  act(() => root.unmount())
})
