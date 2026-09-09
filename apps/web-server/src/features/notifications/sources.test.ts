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

describe('test changes in the shared inbox', () => {
  const changes = (verdict: 'weaker' | 'equivalent' = 'weaker') => [{ featureId: 'shop', status: 'dirty' as const, dirtySpecs: [{ strength: { verdict } }] }]

  it('reports weakening outside an active run as an advisory review notification', async () => {
    const { testChangeNotificationSources } = await import('./sources')
    const [source] = testChangeNotificationSources(changes(), [])
    expect(source.message).toMatchObject({ severity: 'danger', target: { kind: 'test-review', feature: 'shop' } })
    expect(source.message?.title).toContain('may have been weakened')
    expect(source.message?.body).toContain('a hint, not a verdict')
  })

  it('uses one active run alert for dirty files that are also pending, and changes identity on escalation', async () => {
    const { testChangeNotificationSources } = await import('./sources')
    const run = { runId: 'r1', feature: 'shop', status: 'healing', pendingSpecEdits: 1 }
    expect(testChangeNotificationSources(changes(), [run])[0].message).toBeUndefined()
    expect(runNotificationSources([run], changes())[0].message).toMatchObject({ severity: 'danger', target: { kind: 'test-review', feature: 'shop', runId: 'r1' } })
    expect(runNotificationSources([run], changes())[0].signature).not.toBe(runNotificationSources([run], changes('equivalent'))[0].signature)
    expect(testChangeNotificationSources(changes(), [{ ...run, status: 'passed' }])[0].message).toBeDefined()
  })

  it('keeps ordinary edits neutral, resolves clean records, and does not use file counts as notification identity', async () => {
    const { testChangeNotificationSources } = await import('./sources')
    const [record] = changes('equivalent')
    const [source] = testChangeNotificationSources([record], [])
    expect(source.message?.severity).toBe('neutral')
    expect(testChangeNotificationSources([{ ...record, dirtySpecs: [...record.dirtySpecs, ...record.dirtySpecs] }], [])[0].signature).toBe(source.signature)
    expect(testChangeNotificationSources([{ ...record, status: 'clean' }], [])[0].message).toBeUndefined()
  })
})
