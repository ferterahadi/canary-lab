// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FlightIndexEntry } from '../../../shared/api/client'
import { FLIGHT_STAGE_KEYS } from '../../../../../../shared/flights/types'
import type { FeatureActivity } from '../state/feature-activity'
import { FlightsPill, featureChipState } from './FlightsPill'

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

  it('offers the flight command as the empty state (never dead-end)', () => {
    render([])
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    expect(document.body.querySelector('[data-testid="flights-task-menu"]')?.textContent).toContain('npx canary-lab flight')
  })

  it('renders one mini-rail cell per USER-VISIBLE stage (plumbing hidden, pairs merged)', () => {
    render([flight({})])
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    const rail = document.body.querySelector('[data-testid="stage-mini-rail"]')
    // similarity hidden; run+heal, scaffold+env-capture, docs+prd-summary merged (R21/R22/R32/R33).
    expect(rail?.children.length).toBe(FLIGHT_STAGE_KEYS.length - 4)
  })

  // R26 — the pill is the one live indicator for the absorbed surfaces.

  it('lights up from activity alone (a standalone run, zero flights)', () => {
    const activity = new Map<string, FeatureActivity>([['checkout', { kind: 'running', runId: 'r1' }]])
    act(() => { root.render(<FlightsPill flights={[]} activity={activity} onOpenFlight={vi.fn()} />) })
    expect(container.textContent).toContain('Flights · 1 active')
    expect(container.querySelector('[data-testid="flights-pill-count"]')?.textContent).toBe('1')
  })

  it('dedupes a flight and its own stage job to one active feature', () => {
    const activity = new Map<string, FeatureActivity>([['checkout', { kind: 'portifying', workflowId: 'wf1' }]])
    act(() => { root.render(<FlightsPill flights={[flight({})]} activity={activity} onOpenFlight={vi.fn()} />) })
    expect(container.textContent).toContain('Flights · 1 active')
  })

  it("the feature's chip narrates the live activity verb over the flight status", () => {
    const activity = new Map<string, FeatureActivity>([['checkout', { kind: 'authoring', draftId: 'd1' }]])
    act(() => { root.render(<FlightsPill flights={[flight({ status: 'done' })]} activity={activity} onOpenFlight={vi.fn()} />) })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    expect(document.body.querySelector('[data-testid="flight-status-chip"]')?.textContent).toBe('authoring')
  })

  it('with no activity the chip shows the LAST state (done / failed / aborted)', () => {
    act(() => { root.render(<FlightsPill flights={[flight({ status: 'failed' })]} onOpenFlight={vi.fn()} />) })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    expect(document.body.querySelector('[data-testid="flight-status-chip"]')?.textContent).toBe('failed')
  })

  it('a parked checkpoint outranks live activity (the human is the blocker)', () => {
    const chip = featureChipState(
      { status: 'waiting-for-approval', currentStage: 'portify' },
      { kind: 'portifying', workflowId: 'wf1' },
    )
    expect(chip.label).toBe('to approve')
    expect(chip.rank).toBe(0)
  })

  it('activity on a feature with no flight gets a row (progress chip, no "no flight" label) that opens it', () => {
    const onOpenActivity = vi.fn()
    const activity = new Map<string, FeatureActivity>([['pay', { kind: 'portifying', workflowId: 'wf9' }]])
    act(() => { root.render(<FlightsPill flights={[flight({})]} activity={activity} onOpenFlight={vi.fn()} onOpenActivity={onOpenActivity} />) })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    const row = document.body.querySelector<HTMLButtonElement>('[data-testid="activity-open-pay"]')
    expect(row).toBeTruthy()
    // R39: no "no flight" text — the live progress chip carries the state.
    expect(row?.textContent).not.toContain('no flight')
    expect(row?.querySelector('[data-testid="flight-status-chip"]')?.textContent).toBe('portifying')
    act(() => { row?.click() })
    expect(onOpenActivity).toHaveBeenCalledWith('pay', { kind: 'portifying', workflowId: 'wf9' })
  })

  it('live rows sort above resting flights (worst-first)', () => {
    const activity = new Map<string, FeatureActivity>([['live-f', { kind: 'running', runId: 'r1' }]])
    act(() => {
      root.render(
        <FlightsPill
          flights={[
            flight({ flightId: 'fl_done', id: 'fl_done', feature: 'done-f', status: 'done' }),
            flight({ flightId: 'fl_live', id: 'fl_live', feature: 'live-f', status: 'done' }),
          ]}
          activity={activity}
          onOpenFlight={vi.fn()}
        />,
      )
    })
    act(() => { container.querySelector<HTMLButtonElement>('[data-testid="flights-pill"] button')?.click() })
    const rows = [...document.body.querySelectorAll('[data-testid^="flight-open-"]')]
    // The done flight whose feature is running again floats above the resting one.
    expect(rows[0]?.getAttribute('data-testid')).toBe('flight-open-fl_live')
  })
})

describe('FlightsPill — every feature 1:1 (R49)', () => {
  it('lists never-flown features as greyed-rail rows that open the flight launcher', () => {
    const onStartFlight = vi.fn()
    act(() => {
      root.render(
        <FlightsPill
          flights={[flight({ status: 'done', currentStage: null })]}
          features={['checkout', 'menu-management']}
          onOpenFlight={vi.fn()}
          onStartFlight={onStartFlight}
        />,
      )
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Flights"]')!.click()
    })
    const row = document.body.querySelector<HTMLButtonElement>('[data-testid="not-flown-menu-management"]')
    expect(row).toBeTruthy()
    // Same anatomy as a flight row: greyed mini rail squares + the chip (never a dash).
    expect(row!.querySelector('[data-testid="stage-mini-rail"]')).toBeTruthy()
    expect(row!.querySelector('[data-testid="flight-status-chip"]')?.textContent).toBe('not flown')
    act(() => { row!.click() })
    expect(onStartFlight).toHaveBeenCalledWith('menu-management')
  })

  it('never duplicates a feature that already has a flight row, and not-flown rows sink to the bottom', () => {
    act(() => {
      root.render(
        <FlightsPill
          flights={[flight({ feature: 'checkout', status: 'waiting-for-approval' })]}
          features={['checkout', 'aaa-never-flown']}
          onOpenFlight={vi.fn()}
          onStartFlight={vi.fn()}
        />,
      )
    })
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Flights"]')!.click()
    })
    const rows = [...document.body.querySelectorAll('[data-testid^="flight-open-"], [data-testid^="not-flown-"]')]
    expect(rows).toHaveLength(2)
    expect(rows[0]?.getAttribute('data-testid')).toBe('flight-open-fl_1')
    expect(rows[1]?.getAttribute('data-testid')).toBe('not-flown-aaa-never-flown')
    // A never-flown feature does not light the pill.
    expect(container.querySelector('[data-testid="flights-pill-count"]')).toBeTruthy() // the waiting flight does
  })
})
