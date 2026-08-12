import { describe, expect, it } from 'vitest'
import type { FlightIndexEntry, FlightManifest } from '@/shared/api/client'
import {
  EMPTY_FLIGHTS_STREAM,
  flightIndexEntry,
  flightsStreamReducer,
  parseFlightsFrame,
} from './flights-stream-state'

function manifest(over: Partial<FlightManifest> = {}): FlightManifest {
  return {
    flightId: 'fl_1',
    feature: 'checkout',
    repoPaths: ['/repo/shop'],
    description: 'checkout flow',
    opts: { env: 'local', coverageTarget: 100, yolo: false },
    status: 'running',
    currentStage: 'scout',
    stages: [{ key: 'scout', status: 'running' }],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as FlightManifest
}

const rowOf = (state: { flights: FlightIndexEntry[] }, id: string) =>
  state.flights.find((f) => f.flightId === id)

describe('flightsStreamReducer', () => {
  it('takes the snapshot whole and marks itself hydrated', () => {
    const next = flightsStreamReducer(EMPTY_FLIGHTS_STREAM, {
      type: 'snapshot',
      flights: [flightIndexEntry(manifest())],
      details: { fl_1: manifest() },
    })
    expect(next.flights).toHaveLength(1)
    expect(next.details.fl_1?.status).toBe('running')
    // Until this flips, a consumer keeps showing its REST list rather than
    // blinking to empty while the socket opens.
    expect(next.hydrated).toBe(true)
  })

  it('an update maintains the list without a refetch — the whole point of the channel', () => {
    const start = flightsStreamReducer(EMPTY_FLIGHTS_STREAM, {
      type: 'snapshot',
      flights: [flightIndexEntry(manifest())],
      details: {},
    })
    const next = flightsStreamReducer(start, {
      type: 'update',
      flightId: 'fl_1',
      manifest: manifest({ status: 'done', currentStage: null }),
    })
    expect(next.flights).toHaveLength(1)
    expect(rowOf(next, 'fl_1')?.status).toBe('done')
    expect(next.details.fl_1?.status).toBe('done')
  })

  it('an update for an unseen flight adds it, newest first', () => {
    const start = flightsStreamReducer(EMPTY_FLIGHTS_STREAM, {
      type: 'snapshot',
      flights: [flightIndexEntry(manifest({ flightId: 'fl_old', createdAt: '2026-01-01T00:00:00Z' }))],
      details: {},
    })
    const next = flightsStreamReducer(start, {
      type: 'update',
      flightId: 'fl_new',
      manifest: manifest({ flightId: 'fl_new', createdAt: '2026-02-01T00:00:00Z' }),
    })
    expect(next.flights.map((f) => f.flightId)).toEqual(['fl_new', 'fl_old'])
  })

  it('drops the row and its detail on removal', () => {
    const start = flightsStreamReducer(EMPTY_FLIGHTS_STREAM, {
      type: 'snapshot',
      flights: [flightIndexEntry(manifest())],
      details: { fl_1: manifest() },
    })
    const next = flightsStreamReducer(start, { type: 'removed', flightId: 'fl_1' })
    expect(next.flights).toEqual([])
    expect(next.details.fl_1).toBeUndefined()
  })

  it('rebuilds the row field for field, stage rail included', () => {
    const row = flightIndexEntry(manifest({
      opts: { env: 'local', coverageTarget: 100, yolo: false, group: 'cns' },
      pauseReason: 'user',
      endedAt: '2026-01-02T00:00:00Z',
      stages: [{ key: 'scout', status: 'done' }, { key: 'run', status: 'pending' }],
    } as Partial<FlightManifest>))
    expect(row.id).toBe('fl_1')
    expect(row.group).toBe('cns')
    expect(row.pauseReason).toBe('user')
    expect(row.endedAt).toBe('2026-01-02T00:00:00Z')
    // The pill's mini rail reads `stages`; a row rebuilt without it would blank
    // the rail between the push and the next full list read.
    expect(row.stages).toEqual([
      { key: 'scout', status: 'done' },
      { key: 'run', status: 'pending' },
    ])
  })

  it('clears a stale pauseReason when the flight resumes', () => {
    const start = flightsStreamReducer(EMPTY_FLIGHTS_STREAM, {
      type: 'snapshot',
      flights: [flightIndexEntry(manifest({ status: 'paused', pauseReason: 'stage-failed' } as Partial<FlightManifest>))],
      details: {},
    })
    const next = flightsStreamReducer(start, {
      type: 'update',
      flightId: 'fl_1',
      manifest: manifest({ status: 'running' }),
    })
    // The row is REPLACED, not merged: a resumed flight showing `running` with
    // its old `pauseReason` is exactly the bug the server's index builder warns
    // about, and a shallow merge here would reintroduce it client-side.
    expect(rowOf(next, 'fl_1')?.pauseReason).toBeUndefined()
  })
})

describe('parseFlightsFrame', () => {
  it('parses each frame kind', () => {
    expect(parseFlightsFrame('{"type":"snapshot","flights":[],"details":{}}')?.type).toBe('snapshot')
    expect(parseFlightsFrame('{"type":"removed","flightId":"fl_1"}')?.type).toBe('removed')
  })

  it('drops malformed and unknown frames rather than throwing', () => {
    // One bad payload must not tear the socket down.
    expect(parseFlightsFrame('not json')).toBeNull()
    expect(parseFlightsFrame('{"type":"who-knows"}')).toBeNull()
    expect(parseFlightsFrame('null')).toBeNull()
  })
})
