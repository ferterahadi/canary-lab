// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { RunQueueDiagnostics } from '@shared/run-queue'
import type { RunIndexEntry } from '@shared/run-index'
import { QueueNotice, RunQueueBanner, queueExplanation } from './RunQueueBanner'

const mocks = vi.hoisted(() => ({
  getRunQueue: vi.fn(),
  runs: { runs: [] as RunIndexEntry[], connection: 'open' },
}))
vi.mock('@/shared/api/runs', () => ({ getRunQueue: mocks.getRunQueue }))
vi.mock('../state/RunsContext', () => ({ useRuns: () => mocks.runs }))

const diagnostic: RunQueueDiagnostics = {
  checkedAt: '2026-09-08T10:19:00Z', reason: 'memory',
  activeRuns: [{ runId: 'review', feature: 'cns_subject_scope', cost: 2 }],
  candidateCost: 2, usedSlots: 2, slotBudget: 1, maxConcurrentRuns: null, freeMemBytes: 1024,
}

it('shows resource limits and links directly to the active run’s pending test review', () => {
  const host = document.createElement('div'); const root = createRoot(host); const refresh = vi.fn()
  try {
    act(() => root.render(<QueueNotice diagnostics={diagnostic} runs={[{ runId: 'review', feature: 'cns_subject_scope', status: 'healing', startedAt: '', pendingSpecEdits: 1 }]} loading={false} onRefresh={refresh} />))
    expect(host.textContent).toContain('Services and tests have not started')
    expect(host.textContent).toContain('Active runs use 2; this run needs 2 more')
    expect(host.textContent).toContain('Awaiting test review')
    expect(host.querySelector('a')?.getAttribute('href')).toBe('?feature=cns_subject_scope&run=review&dialog=tests-review')
    act(() => host.querySelector('button')!.click())
    expect(refresh).toHaveBeenCalledOnce()
  } finally { act(() => root.unmount()) }
})

it('distinguishes run limits, repository conflicts and available capacity', () => {
  expect(queueExplanation({ ...diagnostic, reason: 'run-limit', maxConcurrentRuns: 1 })).toContain('concurrent run limit is 1')
  expect(queueExplanation({ ...diagnostic, reason: 'repo-collision' })).toContain('same repository')
  expect(queueExplanation({ ...diagnostic, reason: 'cpu' })).toContain('CPU budget')
  expect(queueExplanation({ ...diagnostic, reason: 'ready' })).toContain('still queued')
})

it('keeps the last explanation through a stream-triggered refetch, and an error replaces it', async () => {
  const host = document.createElement('div'); const root = createRoot(host)
  let settle: (value: unknown) => void = () => {}
  let fail: (err: unknown) => void = () => {}
  mocks.getRunQueue.mockReset().mockImplementation(() => new Promise((resolve, reject) => { settle = resolve; fail = reject }))
  mocks.runs = { runs: [], connection: 'open' }
  const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); await Promise.resolve() }) }
  try {
    act(() => root.render(<RunQueueBanner runId="queued-1" />))
    await flush()
    expect(host.textContent).toContain('Checking why this run is waiting…')
    expect(mocks.getRunQueue).toHaveBeenCalledWith('queued-1')
    await act(async () => { settle({ diagnostics: diagnostic }) })
    expect(host.textContent).toContain('Active runs use 2; this run needs 2 more')
    expect(host.querySelector('button')!.textContent).toBe('Refresh queue details')

    // A run status change is the trigger; the previous explanation stays while checking.
    mocks.runs = { runs: [{ runId: 'review', feature: 'cns_subject_scope', status: 'passed', startedAt: '' }], connection: 'open' }
    act(() => root.render(<RunQueueBanner runId="queued-1" />))
    await flush()
    expect(mocks.getRunQueue).toHaveBeenCalledTimes(2)
    expect(host.textContent).toContain('Active runs use 2; this run needs 2 more')
    expect(host.querySelector('button')!.textContent).toBe('Checking…')
    await act(async () => { fail(new Error('queue offline')) })
    expect(host.textContent).toContain('Queue details are unavailable. Refresh to check again.')
    expect(host.textContent).toContain('queue offline')

    // A reconnect alone refetches too, and the manual refresh does the same.
    mocks.runs = { ...mocks.runs, connection: 'reconnecting' }
    act(() => root.render(<RunQueueBanner runId="queued-1" />))
    await flush()
    expect(mocks.getRunQueue).toHaveBeenCalledTimes(3)
    expect(host.textContent).toContain('queue offline')
    await act(async () => { settle({ diagnostics: { ...diagnostic, reason: 'ready' } }) })
    expect(host.textContent).toContain('Capacity is available at this check')
    expect(host.textContent).not.toContain('queue offline')
    act(() => host.querySelector('button')!.click())
    await flush()
    expect(mocks.getRunQueue).toHaveBeenCalledTimes(4)
  } finally { act(() => root.unmount()) }
})
