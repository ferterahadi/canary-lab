import { expect, it } from 'vitest'
import { isExternallyDriven } from './ownership'
import type { FlightStatus } from './types'

it.each<FlightStatus>(['running', 'waiting-for-approval', 'paused', 'done', 'failed', 'aborted'])('shares manifest/index ownership for %s', (status) => {
  const expected = ['running', 'waiting-for-approval', 'paused'].includes(status)
  expect(isExternallyDriven({ status, stageProducer: 'external' })).toBe(expected)
  expect(isExternallyDriven({ status, opts: { stageProducer: 'external' } })).toBe(expected)
  expect(isExternallyDriven({ status, opts: { stageProducer: 'internal' }, stageProducer: 'external' })).toBe(false)
  expect(isExternallyDriven({ status })).toBe(false)
})
it('does not invent an owner for a missing flight', () => {
  expect(isExternallyDriven(null)).toBe(false)
  expect(isExternallyDriven(undefined)).toBe(false)
})
