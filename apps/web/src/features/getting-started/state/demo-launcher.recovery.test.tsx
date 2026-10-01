// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { OnboardingSamples } from '@/shared/api/client'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { useDemoLauncher } from './demo-launcher'

const api = vi.hoisted(() => ({ getOnboardingSamples: vi.fn(), getProjectConfig: vi.fn() }))
vi.mock('@/shared/api/client', async (original) => ({ ...await original<typeof import('@/shared/api/client')>(), ...api }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let element: HTMLDivElement
let invalidate: () => void
function samples(suite: string | null): OnboardingSamples {
  return { sampleSuite: suite, sampleFlightRepo: null, sampleFlightDescription: null, workflows: [], session: { active: null, completed: {} } }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }
function Probe() {
  const value = useDemoLauncher([], [])
  const bus = useInvalidation()
  invalidate = () => bus.invalidate('onboarding')
  return <output>{value.suite ?? 'absent'}</output>
}
const mount = async () => { await act(async () => root.render(<InvalidationProvider><Probe /></InvalidationProvider>)) }
beforeEach(() => {
  vi.useFakeTimers(); vi.resetAllMocks()
  element = document.createElement('div'); document.body.appendChild(element); root = createRoot(element)
  api.getProjectConfig.mockResolvedValue({ showDemo: true })
})
afterEach(() => { act(() => root.unmount()); element.remove(); vi.useRealTimers() })

it('rejects an old poll after deletion and discovers a later creation without an event', async () => {
  const older = deferred<OnboardingSamples>()
  api.getOnboardingSamples.mockResolvedValueOnce(samples('old-suite')).mockReturnValueOnce(older.promise).mockResolvedValue(samples(null))
  await mount()
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  await act(async () => invalidate())
  expect(element.textContent).toBe('absent')
  await act(async () => older.resolve(samples('old-suite')))
  expect(element.textContent).toBe('absent')
  api.getOnboardingSamples.mockResolvedValue(samples('new-suite'))
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(element.textContent).toBe('new-suite')
})
it.each(['failure', 'hang'])('recovers initial %s while staying mounted', async (mode) => {
  const older = deferred<OnboardingSamples>()
  if (mode === 'failure') api.getOnboardingSamples.mockRejectedValueOnce(new Error('offline'))
  else api.getOnboardingSamples.mockReturnValueOnce(older.promise)
  api.getOnboardingSamples.mockResolvedValue(samples('recovered'))
  await mount()
  expect(element.textContent).toBe('absent')
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  expect(element.textContent).toBe('recovered')
  await act(async () => older.resolve(samples('stale')))
  expect(element.textContent).toBe('recovered')
})
it('retains accepted data on reconnect failure, recovers, and clears outstanding work on teardown', async () => {
  api.getOnboardingSamples.mockResolvedValue(samples('current'))
  await mount()
  api.getOnboardingSamples.mockRejectedValueOnce(new Error('offline'))
  await act(async () => invalidate())
  expect(element.textContent).toBe('current')
  const pending = deferred<OnboardingSamples>()
  api.getOnboardingSamples.mockReturnValueOnce(pending.promise)
  await act(async () => vi.advanceTimersByTimeAsync(5000))
  await act(async () => { root.render(null) })
  const count = api.getOnboardingSamples.mock.calls.length
  await act(async () => { pending.resolve(samples('late')); await vi.advanceTimersByTimeAsync(15_000); window.dispatchEvent(new Event('focus')) })
  expect(api.getOnboardingSamples).toHaveBeenCalledTimes(count)
  expect(element.textContent).toBe('')
})
