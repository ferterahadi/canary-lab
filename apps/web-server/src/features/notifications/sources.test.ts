import { describe, expect, it } from 'vitest'
import { flightNotificationSources, runNotificationSources } from './sources'
import type { FlightIndexEntry } from '../../../../../shared/flights/types'

const flight = (over: Partial<FlightIndexEntry> = {}): FlightIndexEntry => ({ flightId: 'f1', feature: 'shop', status: 'paused', pauseReason: 'stage-failed', currentStage: 'run', ...over } as FlightIndexEntry)

describe('notification sources', () => {
  it('keeps one identity during unchanged attention even if the flight is saved again', () => {
    const [first] = flightNotificationSources([flight({ updatedAt: 't1' })])
    const [second] = flightNotificationSources([flight({ updatedAt: 't2' })])
    expect(first).toEqual(second)
    expect(first.message?.target).toEqual({ kind: 'flight', flightId: 'f1' })
    expect(first.message?.body).toContain('failed')
    expect(flightNotificationSources([flight({ currentStage: 'docs' })])[0].signature).not.toBe(first.signature)
  })
  it('does not demand input for a user pause, queue park, or external agent', () => {
    for (const over of [{ pauseReason: 'user' }, { pauseReason: 'queued' }, { stageProducer: 'external' }, { status: 'waiting-for-approval', checkpointKind: 'external-work' }] as Partial<FlightIndexEntry>[]) {
      expect(flightNotificationSources([flight(over)])[0].message).toBeUndefined()
    }
    expect(flightNotificationSources([flight({ status: 'waiting-for-approval', pauseReason: undefined, checkpointKind: 'config-approval' })])[0].message?.title).toContain('needs input')
    expect(flightNotificationSources([flight({ pauseReason: 'restart' })])[0].message?.body).toContain('interrupted')
  })
  it('links a healing run with pending edits directly to test review, and retires the notification when it resumes', () => {
    const run = { runId: 'r1', feature: 'shop', status: 'healing', pendingSpecEdits: 1 }
    expect(runNotificationSources([run])[0].message).toMatchObject({ body: expect.stringContaining('1 test file changed'), target: { kind: 'test-review', feature: 'shop', runId: 'r1' } })
    expect(runNotificationSources([{ ...run, status: 'passed' }])[0].message).toBeUndefined()
    expect(runNotificationSources([{ ...run, pendingSpecEdits: 0 }])[0].message).toBeUndefined()
  })
})
