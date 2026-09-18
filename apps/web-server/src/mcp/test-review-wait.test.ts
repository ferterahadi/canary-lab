import { describe, expect, it, vi } from 'vitest'
import type { RunStore } from '../features/runs/logic/run-store'
import { waitForTestReview } from './test-review-wait'

// What the wait branches on is the manifest it re-reads and whether a store event
// arrives, so the store is a fake that scripts those reads: a real RunStore would
// add a logs directory and a run lifecycle per case and prove nothing extra.
type Decision = { revision: string; decision: 'adopted' | 'approved-for-new-run' | 'restored' }

function fakeStore(reads: Decision[][]) {
  const listeners: Array<(event: unknown) => void> = []
  let read = 0
  const get = vi.fn(() => ({
    manifest: { status: 'healing', specEdits: { reviewDecisions: reads[Math.min(read++, reads.length - 1)] } },
  }))
  const store = {
    get,
    onEvent: (fn: (event: unknown) => void) => { listeners.push(fn) },
    offEvent: (fn: (event: unknown) => void) => {
      const index = listeners.indexOf(fn)
      if (index >= 0) listeners.splice(index, 1)
    },
  } as unknown as RunStore
  return { store, listeners, get }
}

describe('waitForTestReview', () => {
  // The decision is written to the manifest by the route the human's click hits,
  // and the store event that would wake this wait can be missed — a reconnect, or
  // a listener attached after the patch. The timeout is therefore a second read,
  // not just a giving-up path: a receipt it finds there still resolves the wait as
  // a decision rather than as "still waiting".
  it('returns a decision the timeout read finds, when no event ever arrived', async () => {
    const revision = 'a'.repeat(64)
    const { store, listeners, get } = fakeStore([[], [], [{ revision, decision: 'adopted' }]])
    const result = await waitForTestReview(store, 'run1', revision, 1)
    expect(result).toMatchObject({ status: 'adopted', runId: 'run1', review_revision: revision })
    expect(get.mock.calls.length).toBeGreaterThanOrEqual(3)
    // The listener has to come off with the timer, or a long-lived server leaks
    // one per wait.
    expect(listeners).toHaveLength(0)
  })

  // Every run in the workspace publishes onto one store stream, so a wait that
  // re-read on every event would do a read per event of whatever else is running.
  // A run-scoped event still has to wake it, which is why the filter is a match
  // rather than a mute.
  it('ignores an event for another run, and wakes on one for this run', async () => {
    const revision = 'b'.repeat(64)
    const { store, listeners, get } = fakeStore([[], [], [{ revision, decision: 'restored' }]])
    const pending = waitForTestReview(store, 'run1', revision)
    const reads = get.mock.calls.length
    listeners[0]({ runId: 'run2' })
    expect(get.mock.calls.length).toBe(reads)
    listeners[0]({ runId: 'run1' })
    await expect(pending).resolves.toMatchObject({ status: 'restored', runId: 'run1', review_revision: revision })
  })

  it('steers a durable terminal approval to a new run, never to the old wait loop', async () => {
    const revision = 'c'.repeat(64)
    const { store } = fakeStore([[{ revision, decision: 'approved-for-new-run' }]])
    await expect(waitForTestReview(store, 'run1', revision)).resolves.toMatchObject({
      status: 'approved-for-new-run', nextSteps: ['start_run'], next: expect.stringContaining('old result stays immutable'),
    })
  })
})
