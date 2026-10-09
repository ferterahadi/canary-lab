// @vitest-environment happy-dom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ApiError } from '../api/internal'
import type { FeatureSpecFile } from '../api/types'
import { InvalidationProvider, useInvalidation } from './invalidation'
import { useFeatureTestRoster } from './use-feature-test-roster'
import { deferred } from '../../../../../tools/test-helpers/deferred'
import { mountRoot } from '@/test-helpers/mount-root'
const api = vi.hoisted(() => ({ getFeatureTests: vi.fn() }))
vi.mock('../api/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/config')>()),
  getFeatureTests: api.getFeatureTests,
}))
let root: Root
let value: ReturnType<typeof useFeatureTestRoster>
let invalidate: ReturnType<typeof useInvalidation>['invalidate']
type Options = Parameters<typeof useFeatureTestRoster>[0]
const roster = (file: string): FeatureSpecFile[] => [{ file, tests: [] }]
function Probe(props: Options) { invalidate = useInvalidation().invalidate; value = useFeatureTestRoster(props); return null }
const render = (opts: Partial<Options> = {}) => act(async () => root.render(<InvalidationProvider><Probe feature="checkout" {...opts} /></InvalidationProvider>))
const tick = (ms: number) => act(async () => vi.advanceTimersByTimeAsync(ms))

beforeEach(() => {
  vi.useFakeTimers()
  api.getFeatureTests.mockReset().mockResolvedValue(roster('current.spec.ts'))
})
afterEach(() => { vi.useRealTimers() })
mountRoot({ attach: false, onMount: (mounted) => ({ root } = mounted) })

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

it.each(['suite-removed', 'discovery-failed'])('recovers workspace %s at ten seconds, then reconciles healthy source', async (code) => {
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
  expect(api.getFeatureTests).toHaveBeenCalledTimes(attempts + 7)
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
  await tick(4999)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(2)
  expect(value.specs?.[0].file).toBe('fresh.ts')
  await tick(1)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(3)
})

// `error` is the request's own line: the server's string reason when it sent
// one, else the status, else the fallback for a non-Error rejection.
it.each([
  [new ApiError(500, { error: 'server unavailable' }), 'Server returned HTTP 500. server unavailable', 'server unavailable'],
  [new ApiError(500, { message: 'bad module' }), 'Server returned HTTP 500. bad module', 'HTTP 500'],
  [new ApiError(500, { error: 42 }), 'Server returned HTTP 500.', 'HTTP 500'],
  [new ApiError(500, null), 'Server returned HTTP 500.', 'HTTP 500'],
  ['offline', 'Unable to load tests for this suite.', 'Failed to load test source'],
  [new ApiError(422, { code: 'discovery-failed', error: 42 }), 'Server returned HTTP 422.', 'HTTP 422'],
])('formats malformed or unstructured discovery failures: %s', async (error, message, requestError) => {
  api.getFeatureTests.mockRejectedValue(error)
  await render()
  expect(value.failure?.message).toContain(message)
  expect(value.error).toBe(requestError)
  expect(value.confirmed).toBe(false)
})


it('reconciles a missed nested edit after five seconds and preserves newer responses', async () => {
  await render({ recover: true })
  api.getFeatureTests.mockResolvedValue(roster('e2e/phase/nested.test.js'))
  await tick(4999)
  expect(value.specs?.[0].file).toBe('current.spec.ts')
  await tick(1)
  expect(value.specs?.[0].file).toBe('e2e/phase/nested.test.js')
  const stale = deferred<FeatureSpecFile[]>()
  api.getFeatureTests.mockReturnValueOnce(stale.promise).mockResolvedValue(roster('e2e/phase/newer.test.js'))
  await tick(5000)
  await act(async () => invalidate('tests'))
  await act(async () => stale.resolve(roster('e2e/phase/obsolete.test.js')))
  expect(value.specs?.[0].file).toBe('e2e/phase/newer.test.js')
  await act(async () => root.render(null))
  const calls = api.getFeatureTests.mock.calls.length
  await tick(10000)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(calls)
})

it('starts a fresh error retry burst after healthy reconciliation reads', async () => {
  await render({ recover: true })
  await tick(15000)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(4)
  api.getFeatureTests.mockRejectedValue(new Error('offline'))
  await tick(7000)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(7)
  expect(value.failure?.kind).toBe('request')
  await tick(10000)
  expect(api.getFeatureTests).toHaveBeenCalledTimes(7)
})
