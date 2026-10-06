// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { FlightIndexEntry } from '@shared/flights/types'
import { FlightsPill } from './FlightsPill'
vi.mock('@/shared/state/use-live-coverage', () => ({ useLiveCoverageStates: () => ({ value: [], confirmed: true }) }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('uses the server assessment for the count and destination, and clears it without closing the picker', async () => {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const onOpenFlight = vi.fn()
  const entry: FlightIndexEntry = {
    id: 'f1', flightId: 'f1', feature: 'shop', repoPaths: [], createdAt: 'now', updatedAt: 'now',
    status: 'paused', pauseReason: 'stage-failed', currentStage: 'specs-coverage',
    attention: { state: 'actionable', stage: 'specs-coverage', title: 'Flight paused', reason: 'Below target', checkedAt: 'now', revision: 'a' },
  }
  const render = async (flight: FlightIndexEntry) => act(async () => root.render(<FlightsPill flights={[flight]} open onOpenFlight={onOpenFlight} />))
  try {
    await render(entry)
    const picker = document.querySelector('[data-testid="flights-task-menu"]')
    expect(picker?.textContent).toContain('Needs attention 1')
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="flight-open-f1"]')!.click())
    expect(onOpenFlight).toHaveBeenCalledWith('f1', 'specs-coverage')
    await render({ ...entry, attention: { ...entry.attention!, state: 'resolved', revision: 'b' } })
    expect(document.querySelector('[data-testid="flights-task-menu"]')).toBe(picker)
    expect(picker?.textContent).toContain('Needs attention 0')
    onOpenFlight.mockClear()
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="flight-open-f1"]')!.click())
    expect(onOpenFlight).toHaveBeenCalledWith('f1')
  } finally { act(() => root.unmount()); container.remove() }
})
