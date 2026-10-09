// @vitest-environment happy-dom

import { act } from 'react'
import type { Root } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useRecordDetail } from './record-index-store'
import { mountRoot } from '@/test-helpers/mount-root'

// The provider-backed path (an id, a hydration with demand) is driven through
// PortifyContext and BenchmarkContext; this pins the no-selection case every
// detail view passes before a record is chosen.

let root: Root
mountRoot({ attach: true, onMount: (mounted) => ({ root } = mounted) })

it('asks nothing of the hydration and reports no detail when no record is selected', () => {
  // One snapshot object, as the real hydration keeps: useSyncExternalStore
  // reads a fresh object on every call as a change and re-renders forever.
  const idle = { status: 'idle' as const, error: null }
  const hydration = {
    subscribe: () => () => {},
    snapshot: () => idle,
    watch: vi.fn(() => () => {}),
    retry: vi.fn(),
  }
  let seen: ReturnType<typeof useRecordDetail<string>> | undefined
  function Probe() {
    seen = useRecordDetail({ only: 'detail' }, hydration, null)
    return null
  }

  act(() => root.render(<Probe />))
  seen?.retry()

  expect(seen).toMatchObject({ manifest: undefined, loading: false, missing: false, error: null })
  expect(hydration.watch).not.toHaveBeenCalled()
  expect(hydration.retry).not.toHaveBeenCalled()
})
