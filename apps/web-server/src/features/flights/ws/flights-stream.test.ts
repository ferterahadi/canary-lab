import type { FastifyInstance } from 'fastify'
import { expect, it } from 'vitest'
import { flightActivityCases } from '../../../../../../shared/__fixtures__/flight-activity'
import { FlightRunStore } from '../logic/store'
import { flightsStreamRoutes } from './flights-stream'
import type { FlightsStreamFrame } from '../../../../../../shared/flights/index-entry'
import { trackTempDirs } from '../../../../../../tools/test-helpers/temp-dir'

const tmp = trackTempDirs('flight-activity-')
it.each(flightActivityCases)('pushes initial active details for $status', async ({ status, active }) => {
  const store = new FlightRunStore(tmp())
  store.save({ flightId: 'fl-test', feature: 'shop', repoPaths: [], description: '', status,
    currentStage: null, stages: [], opts: { env: 'local', coverageTarget: 100, yolo: false },
    createdAt: 'now', updatedAt: 'now' })
  const frames: FlightsStreamFrame[] = []
  let close: (() => void) | undefined
  const app = { get: (_path: string, _options: unknown, handler: (socket: unknown) => void) => handler({
    send: (raw: string) => frames.push(JSON.parse(raw)),
    on: (_event: string, callback: () => void) => { close = callback },
  }) } as unknown as FastifyInstance
  await flightsStreamRoutes(app, { store })
  expect(frames[0]).toMatchObject({ type: 'snapshot', flights: [expect.objectContaining({ status })] })
  if (frames[0].type !== 'snapshot') throw new Error('expected initial snapshot')
  expect(Object.keys(frames[0].details)).toEqual(active ? ['fl-test'] : [])
  close?.()
})
