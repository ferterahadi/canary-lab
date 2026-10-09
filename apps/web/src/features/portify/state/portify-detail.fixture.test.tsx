import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '@/shared/api/internal'
import type { PortifyManifest } from '@shared/portify-index'
import { detailFixture } from './portify-detail.fixture'

let root: Root
beforeEach(() => { root = createRoot(document.createElement('div')) })
afterEach(() => act(() => root.unmount()))
const manifest = { workflowId: 'ports', feature: 'checkout', status: 'editing' } as PortifyManifest

it('keeps absent identity lazy, reports missing detail, and retries a restored workflow', async () => {
  const read = vi.fn().mockRejectedValueOnce(new ApiError(404, { error: 'removed' })).mockResolvedValue(manifest)
  const useDetail = detailFixture(read)
  let state!: ReturnType<typeof useDetail>
  function Probe({ id }: { id?: string }) { state = useDetail(id); return null }
  await act(async () => root.render(<Probe />))
  act(() => state.retry())
  expect(read).not.toHaveBeenCalled()
  await act(async () => root.render(<Probe id="ports" />))
  expect(state.missing).toBe(true)
  await act(async () => state.retry())
  expect(state.manifest).toBe(manifest)
  expect(state.missing).toBe(false)
})

it('returns a supplied detail without requesting it again', async () => {
  const read = vi.fn()
  const useDetail = detailFixture(read, () => manifest)
  let state!: ReturnType<typeof useDetail>
  function Probe() { state = useDetail('ports'); return null }
  await act(async () => root.render(<Probe />))
  expect(state.manifest).toBe(manifest)
  expect(state.loading).toBe(false)
  expect(read).not.toHaveBeenCalled()
})
