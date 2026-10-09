import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/api/internal'
import { useCyclePatch } from './use-cycle-patch'

vi.mock(import('@/shared/api/runs'), async (importOriginal) => ({ ...(await importOriginal()), getRunCyclePatch: vi.fn() }))

let seen: ReturnType<typeof useCyclePatch> | undefined
function Probe({ runId, iteration }: { runId: string; iteration: number | null }) {
  seen = useCyclePatch(runId, iteration)
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

it('reads a cycle’s patch by its journal iteration', async () => {
  const runsApi = await import('@/shared/api/runs')
  vi.mocked(runsApi.getRunCyclePatch).mockResolvedValue({ iteration: 3, patchPath: '/p', diff: 'd' })
  const root = await render('patch-run-1', 3)
  expect(runsApi.getRunCyclePatch).toHaveBeenCalledWith('patch-run-1', 3)
  expect(seen?.value).toEqual({ iteration: 3, patchPath: '/p', diff: 'd' })
  act(() => root.unmount())
})

it('reports a patch the run never persisted as missing, and other failures as errors', async () => {
  const runsApi = await import('@/shared/api/runs')
  vi.mocked(runsApi.getRunCyclePatch).mockRejectedValueOnce(new ApiError(404, null))
  const missing = await render('patch-run-2', 1)
  expect(seen?.value).toBe('missing')
  act(() => missing.unmount())
  vi.mocked(runsApi.getRunCyclePatch).mockRejectedValueOnce(new ApiError(500, null, 'boom'))
  const failed = await render('patch-run-3', 1)
  expect(seen?.value).toBeNull()
  expect(seen?.error).toContain('boom')
  act(() => failed.unmount())
})

it('reads nothing without an iteration', async () => {
  const runsApi = await import('@/shared/api/runs')
  const root = await render('patch-run-4', null)
  expect(runsApi.getRunCyclePatch).not.toHaveBeenCalled()
  expect(seen?.value).toBeNull()
  act(() => root.unmount())
})
