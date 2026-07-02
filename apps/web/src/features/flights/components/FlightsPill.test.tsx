// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightIndexEntry } from '../../../shared/api/client'
import { FLIGHT_STAGE_KEYS } from '../../../../../../shared/flights/types'
import { FlightsPill } from './FlightsPill'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})

const flight = (over: Partial<FlightIndexEntry>): FlightIndexEntry => ({
  id: 'fl_1',
  createdAt: '2026-01-01T00:00:00Z',
  flightId: 'fl_1',
  feature: 'checkout',
  repoPaths: ['/repo/shop'],
  status: 'running',
  currentStage: 'scout',
  stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'pending' as const })),
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
})

function render(flights: FlightIndexEntry[], onOpenFlight = vi.fn()) {
  act(() => { root.render(<FlightsPill flights={flights} onOpenFlight={onOpenFlight} />) })
  return onOpenFlight
}

describe('FlightsPill', () => {
  it('stays visible when idle and shows the active count while flights run', () => {
    render([])
    expect(container.textContent).toContain('Flights')
    render([flight({}), flight({ flightId: 'fl_2', id: 'fl_2', feature: 'billing' })])
    expect(container.textContent).toContain('Flights · 2 active')
    expect(container.querySelector('[data-testid="flights-pill-count"]')?.textContent).toBe('2')
  })

  it('flags a parked checkpoint as the state that needs the human', () => {
    render([flight({ status: 'waiting-for-approval' })])
    expect(container.textContent).toContain('approval needed')
  })

  it('opens the picker (worst-first) and picking a flight opens the routed view', () => {
    const onOpen = render([
      flight({ flightId: 'fl_done', id: 'fl_done', feature: 'done-f', status: 'done' }),
      flight({ flightId: 'fl_wait', id: 'fl_wait', feature: 'wait-f', status: 'waiting-for-approval' }),
    ])
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    const menu = document.body.querySelector('[data-testid="flights-task-menu"]')
    expect(menu).toBeTruthy()
    // Worst-first: the flight needing approval lists above the done one.
    const rows = [...menu!.querySelectorAll('[data-testid^="flight-open-"]')]
    expect(rows[0]?.getAttribute('data-testid')).toBe('flight-open-fl_wait')
    act(() => { (rows[0] as HTMLButtonElement).click() })
    expect(onOpen).toHaveBeenCalledWith('fl_wait')
  })

  it('offers the fly command as the empty state (never dead-end)', () => {
    render([])
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    expect(document.body.querySelector('[data-testid="flights-task-menu"]')?.textContent).toContain('npx canary-lab fly')
  })

  it('renders one mini-rail cell per stage', () => {
    render([flight({})])
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    const rail = document.body.querySelector('[data-testid="stage-mini-rail"]')
    expect(rail?.children.length).toBe(FLIGHT_STAGE_KEYS.length)
  })
})
