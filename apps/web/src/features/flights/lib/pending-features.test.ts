import { describe, expect, it } from 'vitest'
import { FLIGHT_STAGE_KEYS } from '../../../../../../shared/flights/types'
import type { FlightIndexEntry } from '../../../../../../shared/flights/types'
import type { Feature } from '../../../shared/api/types'
import { derivePendingFeatures } from './pending-features'

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

const feature = (over: Partial<Feature>): Feature => ({
  name: 'checkout',
  repos: [],
  envs: [],
  ...over,
})

describe('derivePendingFeatures', () => {
  it('mints a stub per non-terminal flight whose feature is not on disk yet', () => {
    const stubs = derivePendingFeatures(
      [
        flight({ flightId: 'a', id: 'a', feature: 'login', status: 'running', group: 'Auth' }),
        flight({ flightId: 'b', id: 'b', feature: 'signup', status: 'paused', pauseReason: 'queued', group: 'Auth' }),
      ],
      [],
    )
    expect(stubs.map((s) => s.name)).toEqual(['login', 'signup'])
    expect(stubs.every((s) => s.group === 'Auth')).toBe(true)
    // Carries the flight handle + live state onto the placeholder so the row can
    // open the flight and render its status chip.
    expect(stubs[0].pending).toEqual({ flightId: 'a', status: 'running', currentStage: 'scout' })
    expect(stubs[1].pending).toEqual({ flightId: 'b', status: 'paused', currentStage: 'scout', pauseReason: 'queued' })
    // Stubs are inert: no repos/envs so nothing downstream tries to boot them.
    expect(stubs[0].repos).toEqual([])
    expect(stubs[0].envs).toEqual([])
  })

  it('drops a flight whose feature already exists on disk — the real row wins', () => {
    const stubs = derivePendingFeatures(
      [flight({ feature: 'checkout', status: 'running' })],
      [feature({ name: 'checkout', group: 'Shop' })],
    )
    expect(stubs).toEqual([])
  })

  it('never stubs a terminal flight (done/failed/aborted produced no live feature)', () => {
    const stubs = derivePendingFeatures(
      [
        flight({ flightId: 'a', id: 'a', feature: 'done-f', status: 'done' }),
        flight({ flightId: 'b', id: 'b', feature: 'failed-f', status: 'failed' }),
        flight({ flightId: 'c', id: 'c', feature: 'aborted-f', status: 'aborted' }),
      ],
      [],
    )
    expect(stubs).toEqual([])
  })

  it('collapses duplicate flight records for the same feature to one stub', () => {
    const stubs = derivePendingFeatures(
      [
        flight({ flightId: 'a', id: 'a', feature: 'checkout', status: 'running' }),
        flight({ flightId: 'b', id: 'b', feature: 'checkout', status: 'paused' }),
      ],
      [],
    )
    expect(stubs).toHaveLength(1)
    expect(stubs[0].pending?.flightId).toBe('a')
  })

  it('leaves group undefined when the flight carries none', () => {
    const stubs = derivePendingFeatures([flight({ feature: 'solo', group: undefined })], [])
    expect(stubs[0].group).toBeUndefined()
  })
})
