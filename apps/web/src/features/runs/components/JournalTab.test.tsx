import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JournalTab } from './JournalTab'
import type { JournalEntry } from '../../../shared/api/types'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../../shared/api/client', () => ({
  listJournal: vi.fn(),
  deleteJournalEntry: vi.fn(),
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  root.unmount()
  container.remove()
  vi.clearAllMocks()
})

describe('JournalTab live refresh', () => {
  it('refetches the selected run journal when refreshKey changes', async () => {
    const api = await import('../../../shared/api/client')
    vi.mocked(api.listJournal)
      .mockResolvedValueOnce([entry(1, 'first')])
      .mockResolvedValueOnce([entry(2, 'second')])

    await act(async () => {
      root.render(<JournalTab feature="checkout" runId="run-1" refreshKey={0} />)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('first')

    await act(async () => {
      root.render(<JournalTab feature="checkout" runId="run-1" refreshKey={1} />)
      await Promise.resolve()
    })

    expect(api.listJournal).toHaveBeenCalledTimes(2)
    expect(api.listJournal).toHaveBeenLastCalledWith({ feature: 'checkout', run: 'run-1' })
    expect(container.textContent).toContain('second')
  })
})

function entry(iteration: number, hypothesis: string): JournalEntry {
  return {
    iteration,
    timestamp: '2026-07-02T10:00:00.000Z',
    feature: 'checkout',
    run: 'run-1',
    outcome: 'pending',
    hypothesis,
    body: `- hypothesis: ${hypothesis}`,
  }
}
