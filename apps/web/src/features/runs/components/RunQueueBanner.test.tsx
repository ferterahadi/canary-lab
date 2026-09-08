// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { RunQueueDiagnostics } from '@shared/run-queue'
import { QueueNotice, queueExplanation } from './RunQueueBanner'

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
