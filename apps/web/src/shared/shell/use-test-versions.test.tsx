// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as api from '../api/client'
import { useTestVersions } from './use-test-versions'
import type { TestSourceComparison } from '@shared/test-review'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('../api/client', () => ({ getFeatureTests: vi.fn(async () => []), getTestSourceComparison: vi.fn() }))
let root: Root
let live: ReturnType<typeof useTestVersions>
const empty: TestSourceComparison = { state: 'ready', files: [], differences: [], changes: { added: [], changed: [], removed: [] } }
function Probe() {
  live = useTestVersions({ feature: 'shop', baseline: { runId: 'run', featureDir: '/suite', suiteSnapshot: { kind: 'taken', dir: '/snapshot', digest: 'd', takenAt: 'now' } },
    displayed: null, recordedView: true, revision: 'initial', ready: false, displayFailed: false })
  return null
}
beforeEach(() => { vi.useFakeTimers(); root = createRoot(document.createElement('div')); vi.resetAllMocks() })
afterEach(() => { act(() => root.unmount()); vi.useRealTimers() })
it('updates the Tests comparison after an empty result without a parent revision or event', async () => {
  vi.mocked(api.getTestSourceComparison).mockResolvedValue(empty)
  await act(async () => root.render(<Probe />))
  expect(live.comparison.files).toEqual([])
  const next: TestSourceComparison = { ...empty, files: ['added.spec.ts'] }
  vi.mocked(api.getTestSourceComparison).mockResolvedValue(next)
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
  expect(live.comparison.files).toEqual(['added.spec.ts'])
  expect(api.getTestSourceComparison).toHaveBeenCalledTimes(2)
})
