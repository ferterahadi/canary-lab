// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RunStartRequest } from '@shared/test-review'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'

const api = vi.hoisted(() => ({ getRunStartRequest: vi.fn(), cancelRunStartRequest: vi.fn() }))
vi.mock('@/shared/api/client', () => api)
import { PendingRunStartNotice } from './PendingRunStartNotice'

let container: HTMLDivElement
let root: Root
let request: RunStartRequest
let invalidate: ReturnType<typeof useInvalidation>['invalidate']
const onRunStarted = vi.fn()
const onDismiss = vi.fn()
const onReview = vi.fn()
const pending = { requestId: 'request-1', feature: 'checkout', mode: 'test' as const }
function View() {
  invalidate = useInvalidation().invalidate
  return <PendingRunStartNotice pending={pending} onRunStarted={onRunStarted} onDismiss={onDismiss} onReview={onReview} />
}
const mount = async () => { await act(async () => { root.render(<InvalidationProvider><View /></InvalidationProvider>) }) }
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  vi.useFakeTimers()
  request = { requestId: pending.requestId, feature: pending.feature, owner: { kind: 'internal' }, status: 'awaiting-review', version: 1, createdAt: 'now', updatedAt: 'now', review: { runId: 'source-run', revision: 'revision-1' } }
  api.getRunStartRequest.mockImplementation(async () => ({ ...request }))
  api.cancelRunStartRequest.mockImplementation(async () => { request = { ...request, version: 2, status: 'cancelled' }; return request })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers() })
const button = (text: string) => [...container.querySelectorAll('button')].find((item) => item.textContent === text)!

it('observes an internally resumed request without replaying start or depending on review-close events', async () => {
  await mount()
  await act(async () => button('Review test changes').click())
  expect(onReview).toHaveBeenCalledExactlyOnceWith('checkout', 'source-run')
  request = { ...request, status: 'started', runId: 'new-run', version: 3 }
  await act(async () => { invalidate('tests', 'checkout') })
  expect(onRunStarted).toHaveBeenCalledExactlyOnceWith('new-run')
  expect(onDismiss).toHaveBeenCalledExactlyOnceWith('request-1')
  await act(async () => { invalidate('tests', 'checkout') })
  expect(onRunStarted).toHaveBeenCalledOnce()
})

it('recovers a missed event within five seconds while already open', async () => {
  await mount()
  request = { ...request, status: 'queued', runId: 'queued-run', version: 2 }
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(onRunStarted).toHaveBeenCalledExactlyOnceWith('queued-run')
})

it('shows external ownership after browser approval and never launches an internal replacement', async () => {
  request = { ...request, owner: { kind: 'external', sessionId: 'external-session', clientKind: 'codex' }, status: 'ready' }
  await mount()
  expect(container.textContent).toContain('waiting for your original external client')
  expect(button('Cancel run request')).toBeUndefined()
  await act(async () => { await vi.advanceTimersByTimeAsync(10000) })
  expect(onRunStarted).not.toHaveBeenCalled()
  expect(onDismiss).not.toHaveBeenCalled()
})

it('cancels the pending request through its API without undoing test approval', async () => {
  await mount()
  await act(async () => button('Cancel run request').click())
  expect(api.cancelRunStartRequest).toHaveBeenCalledExactlyOnceWith('request-1')
  expect(container.textContent).toContain('Run request cancelled. Test review decisions are unchanged.')
  expect(onRunStarted).not.toHaveBeenCalled()
})

it('does not let an older snapshot overwrite the latest request version', async () => {
  request = { ...request, status: 'starting', version: 3 }
  await mount()
  request = { ...request, status: 'awaiting-review', version: 1 }
  await act(async () => { invalidate('tests', 'checkout') })
  expect(container.textContent).toContain('starting your requested run')
  expect(container.textContent).not.toContain('Waiting for your test review')
})
