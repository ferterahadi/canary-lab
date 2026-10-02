import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JournalTab } from './JournalTab'
import type { JournalSection } from '@shared/run-detail'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/shared/api/runs', () => ({
  listJournal: vi.fn(),
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
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.listJournal)
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

    expect(runsApi.listJournal).toHaveBeenCalledTimes(2)
    expect(runsApi.listJournal).toHaveBeenLastCalledWith({ feature: 'checkout', run: 'run-1' })
    expect(container.textContent).toContain('second')
  })
})

describe('JournalTab empty state', () => {
  it('reads an empty journal on a run that never healed as "nothing to repair"', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.listJournal).mockResolvedValue([])

    await act(async () => {
      root.render(<JournalTab feature="checkout" runId="run-1" healCycles={0} />)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('Nothing to repair')
    expect(container.textContent).not.toContain('No journal entries for this run')
  })

  it('says the agent wrote nothing when repair cycles did happen', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.listJournal).mockResolvedValue([])

    await act(async () => {
      root.render(<JournalTab feature="checkout" runId="run-1" healCycles={2} />)
      await Promise.resolve()
    })

    expect(container.textContent).toContain('No journal entries were written')
  })

  it('renders entries without a redundant pane title above them', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.listJournal).mockResolvedValue([entry(1, 'first')])

    await act(async () => {
      root.render(<JournalTab feature="checkout" runId="run-1" />)
      await Promise.resolve()
    })

    // The `Journal` tab above already names this pane.
    expect(container.querySelector('.cl-panel-header')).toBeNull()
    expect(container.textContent).toContain('first')
  })
})

describe('JournalTab raw entry', () => {
  it('opens the entry as the agent wrote it in a modal code block, not an inline disclosure', async () => {
    const runsApi = await import('@/shared/api/runs')
    vi.mocked(runsApi.listJournal).mockResolvedValue([entry(3, 'tax line missing')])

    await act(async () => {
      root.render(<JournalTab feature="checkout" runId="run-1" healCycles={1} />)
      await Promise.resolve()
    })

    expect(document.querySelector('[data-testid="journal-raw-modal"]')).toBeNull()
    const open = container.querySelector<HTMLButtonElement>('[data-testid="journal-raw-entry"]')
    act(() => { open?.click() })

    const modal = document.querySelector('[data-testid="journal-raw-modal"]')
    expect(modal?.textContent).toContain('Iteration 3')
    expect(modal?.querySelector('[data-testid="activity-log-code"]')?.textContent).toContain('- hypothesis: tax line missing')
    expect(modal?.querySelector('[data-testid="activity-log-copy"]')).toBeTruthy()
  })
})

function entry(iteration: number, hypothesis: string): JournalSection {
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
