// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CoverageStateSummary } from '@/shared/api/coverage'
import type { FlightIndexEntry } from '@/shared/api/client'
import { InvalidationProvider, useInvalidation } from '@/shared/state/invalidation'
import { FLIGHT_STAGE_KEYS } from '@shared/flights/types'
import { FlightsPill } from './FlightsPill'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { listCoverageStates } = vi.hoisted(() => ({ listCoverageStates: vi.fn() }))
vi.mock('@/shared/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/shared/api/client')>()),
  listCoverageStates,
}))

const freshness = (state: 'current' | 'stale'): NonNullable<CoverageStateSummary['freshness']> => ({
  revision: state,
  checkedAt: '2026-09-23T00:00:00Z',
  state,
  reasons: state === 'stale' ? ['Mapping input revisions were not recorded; recheck coverage before relying on it.'] : [],
  changedTests: [],
  latestRunFailed: false,
})
const stateSummary = (state: 'current' | 'stale'): CoverageStateSummary => ({
  feature: 'cns_better_auth',
  headline: state === 'stale' ? 'Stale' : 'Mapped 36%',
  summary: 'fresh',
  coverage: state === 'stale' ? 'stale' : 'fresh',
  coveragePct: state === 'stale' ? null : 35.7,
  freshness: freshness(state),
})

let container: HTMLDivElement
let root: Root
let invalidateCoverage: () => void

function InvalidationTap() {
  const { invalidate } = useInvalidation()
  invalidateCoverage = () => invalidate('coverage')
  return null
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  localStorage.removeItem('cl-flight-groups-open')
  listCoverageStates.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('Flights picker coverage freshness', () => {
  it('updates a completed Tests & coverage cell while the grouped dialog stays open', async () => {
    vi.useFakeTimers()
    let current = stateSummary('current')
    listCoverageStates.mockImplementation(async () => [current])
    const stages = FLIGHT_STAGE_KEYS.map((key) => ({ key, status: key === 'robustness' ? 'pending' as const : 'done' as const }))

    await act(async () => {
      root.render(<InvalidationProvider>
        <InvalidationTap />
        <FlightsPill flights={[]} features={[{ name: 'cns_better_auth', group: 'CNS', stages }]} open onOpenFlight={vi.fn()} />
      </InvalidationProvider>)
    })
    act(() => document.querySelector<HTMLButtonElement>('[data-testid="flight-group-toggle-CNS"]')!.click())
    const row = document.querySelector<HTMLButtonElement>('[data-testid="derived-open-cns_better_auth"]')!
    const cell = () => row.querySelector<HTMLElement>('[data-testid="stage-mini-cell-specs-coverage"]')!
    expect(row.querySelector('[data-testid="flight-status-chip"]')?.textContent).toBe('Idle')
    expect(cell().style.background).toContain('var(--success)')
    expect(cell().getAttribute('aria-label')).toBe('Tests & coverage — done')

    current = stateSummary('stale')
    await act(async () => invalidateCoverage())
    expect(document.querySelector('[data-testid="derived-open-cns_better_auth"]')).toBe(row)
    expect(cell().style.background).toContain('var(--warning)')
    expect(cell().getAttribute('aria-label')).toContain('Tests & coverage — done. Coverage out of date. Mapping input revisions were not recorded')
    act(() => cell().dispatchEvent(new MouseEvent('mouseover', { bubbles: true })))
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Coverage out of date. Mapping input revisions were not recorded')
    act(() => cell().dispatchEvent(new MouseEvent('mouseout', { bubbles: true })))
    expect(row.querySelector('[data-testid="flight-status-chip"]')?.textContent).toBe('Idle')
    expect(document.querySelector('button[aria-pressed="false"]')?.textContent).toContain('Needs input 0')

    // The broadcast can be missed: the same open row recovers on its bounded
    // coverage read, without navigation or a manual refresh.
    current = stateSummary('current')
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(cell().style.background).toContain('var(--success)')
    expect(cell().getAttribute('aria-label')).toBe('Tests & coverage — done')
  })

  it('qualifies a recorded flight without changing its saved status', async () => {
    listCoverageStates.mockResolvedValue([stateSummary('stale')])
    const flight: FlightIndexEntry = {
      id: 'fl_auth', flightId: 'fl_auth', feature: 'cns_better_auth', repoPaths: [],
      createdAt: '2026-09-23T00:00:00Z', updatedAt: '2026-09-23T00:00:00Z',
      status: 'done', currentStage: null,
      stages: FLIGHT_STAGE_KEYS.map((key) => ({ key, status: 'done' })),
    }
    await act(async () => {
      root.render(<InvalidationProvider><FlightsPill flights={[flight]} open onOpenFlight={vi.fn()} /></InvalidationProvider>)
    })
    const row = document.querySelector<HTMLElement>('[data-testid="flight-open-fl_auth"]')!
    const cell = row.querySelector<HTMLElement>('[data-testid="stage-mini-cell-specs-coverage"]')!
    expect(cell.style.background).toContain('var(--warning)')
    expect(cell.getAttribute('aria-label')).toContain('Tests & coverage — done. Coverage out of date.')
    expect(row.querySelector('[data-testid="flight-status-chip"]')?.textContent).toBe('Done')
    expect(flight.stages?.find((stage) => stage.key === 'specs-coverage')?.status).toBe('done')
  })
})
