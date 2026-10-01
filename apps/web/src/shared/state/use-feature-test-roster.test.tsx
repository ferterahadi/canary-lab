// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '../api/internal'
import type { FeatureSpecFile } from '../api/types'
import { InvalidationProvider, useInvalidation } from './invalidation'
import { useFeatureTestRoster } from './use-feature-test-roster'
const api = vi.hoisted(() => ({ getFeatureTests: vi.fn() }))
vi.mock('../api/client', async () => ({ ...await vi.importActual('../api/client'), ...api }))
let root: Root
let element: HTMLDivElement
let value: ReturnType<typeof useFeatureTestRoster>
let invalidate: ReturnType<typeof useInvalidation>['invalidate']
type Options = Parameters<typeof useFeatureTestRoster>[0]
const roster = (file: string): FeatureSpecFile[] => [{ file, tests: [] }]
function Probe(props: Options) { invalidate = useInvalidation().invalidate; value = useFeatureTestRoster(props); return null }
const render = (opts: Partial<Options> = {}) => act(async () => root.render(<InvalidationProvider><Probe feature="checkout" {...opts} /></InvalidationProvider>))
const tick = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
beforeEach(() => {
  vi.useFakeTimers()
  api.getFeatureTests.mockReset().mockResolvedValue(roster('current.spec.ts'))
  element = document.createElement('div')
  root = createRoot(element)
})
afterEach(() => { act(() => root.unmount()); vi.useRealTimers() })

it('makes exactly three attempts one second apart for non-removal failures, then stops', async () => {
  api.getFeatureTests.mockRejectedValue(new Error('offline'))
  await render({ recover: true })
  expect(api.getFeatureTests).toHaveBeenCalledTimes(1)
  await tick(999)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(1)
  await tick(1)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(2)
  await tick(1000)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(3)
  await tick(30000)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(3)
  await act(async () => value.refresh())
  await tick(2000)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(6)
})

it.each(['suite-removed', 'discovery-failed'])('recovers workspace %s at ten seconds without broad periodic reads', async (code) => {
  api.getFeatureTests.mockRejectedValue(new ApiError(code === 'suite-removed' ? 404 : 422, { code, error: 'missing config' }))
  await render({ recover: true })
  await tick(2000)
  const attempts = code === 'suite-removed' ? 1 : 3
  expect(api.getFeatureTests).toHaveBeenCalledTimes(attempts)
  await tick(7999)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(attempts)
  api.getFeatureTests.mockResolvedValue(roster('restored.spec.ts'))
  await tick(1)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(attempts + 1)
  expect(value.specs?.[0].file).toBe('restored.spec.ts')
  await tick(30000)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(attempts + 1)
})

it('retains accepted rosters during failure, clears removal, and preserves discovery diagnostics', async () => {
  await render({ recover: true })
  api.getFeatureTests.mockResolvedValue([{ file: 'partial.ts', tests: [], discoveryError: 'discovery failed', discoveryDiagnostics: 'diagnostic detail' }])
  await act(async () => value.refresh())
  expect(value.specs?.[0].file).toBe('current.spec.ts')
  expect(value.incomplete[0].discoveryDiagnostics).toBe('diagnostic detail')
  expect(value.confirmed).toBe(false)
  api.getFeatureTests.mockRejectedValue(new ApiError(404, { code: 'suite-removed', error: 'removed' }))
  await act(async () => invalidate('tests'))
  expect(value.specs).toBeNull()
  expect(value.source).toBeNull()
  expect(value.incomplete).toEqual([])
})

it('accepts parse-error rows without changing their interpretation', async () => {
  const partial = [{ file: 'broken.ts', tests: [], parseError: 'syntax issue' }]
  api.getFeatureTests.mockResolvedValue(partial)
  await render()
  expect(value.source).toEqual(partial)
  expect(value.confirmed).toBe(true)
  expect(value.failure).toBeNull()
})

it('supersedes hung reads on events and manual refresh without background counterpart reads', async () => {
  const old = deferred<FeatureSpecFile[]>()
  api.getFeatureTests.mockReturnValueOnce(old.promise).mockResolvedValue(roster('new.spec.ts'))
  await render({ runId: 'run-1' })
  await tick(30000)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(1)
  await act(async () => invalidate('tests'))
  await act(async () => old.resolve(roster('old.spec.ts')))
  expect(value.specs?.[0].file).toBe('new.spec.ts')
  const hung = deferred<FeatureSpecFile[]>()
  api.getFeatureTests.mockReturnValueOnce(hung.promise).mockResolvedValue(roster('latest.spec.ts'))
  await act(async () => value.refresh())
  expect(value.specs?.[0].file).toBe('new.spec.ts')
  await act(async () => value.refresh())
  await act(async () => hung.resolve(roster('obsolete.spec.ts')))
  expect(value.specs?.[0].file).toBe('latest.spec.ts')
})

it('keeps workspace and recorded retention separate and never polls a missing historical roster', async () => {
  await render({ recover: true })
  api.getFeatureTests.mockRejectedValue(new ApiError(404, { code: 'suite-removed', error: 'gone' }))
  await render({ recover: true, runId: 'history' })
  expect(value.specs).toBeNull()
  await tick(30000)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(2)
  api.getFeatureTests.mockReturnValue(new Promise(() => {}))
  await render({ recover: true })
  expect(value.specs?.[0].file).toBe('current.spec.ts')
})

it('keeps source reads lazy, reacts to caller revisions, and rejects teardown work', async () => {
  await render({ enabled: false })
  await act(async () => invalidate('tests'))
  await tick(30000)
  expect(api.getFeatureTests).not.toHaveBeenCalled()
  await render({ enabled: true, refreshKey: 'coverage-1' })
  expect(api.getFeatureTests).toHaveBeenCalledTimes(1)
  await render({ enabled: true, refreshKey: 'coverage-2' })
  expect(api.getFeatureTests).toHaveBeenCalledTimes(2)
  await tick(30000)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(2)
  api.getFeatureTests.mockRejectedValue(new Error('offline'))
  await render({ recover: true })
  await act(async () => root.render(null))
  await tick(10000)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(3)
})

it('cancels a scheduled retry when an event replaces it', async () => {
  api.getFeatureTests.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(roster('fresh.ts'))
  await render({ recover: true })
  await tick(500)
  await act(async () => invalidate('tests'))
  await tick(5000)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(2)
  expect(value.specs?.[0].file).toBe('fresh.ts')
})
