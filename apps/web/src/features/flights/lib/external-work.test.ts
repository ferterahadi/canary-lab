import { describe, expect, it } from 'vitest'
import type { FlightIndexEntry } from '@/shared/api/client'
import { EXTERNAL_WORK_COPY, externalMutationTooltip, externalWorkChipTitle, flightAwaitsUser, isExternalWorkPark, isExternallyDriven, presentedIndexStages } from './external-work'

const entry = (over: Partial<FlightIndexEntry> = {}): FlightIndexEntry => ({
  id: 'fl_1',
  createdAt: '2026-01-01T00:00:00Z',
  flightId: 'fl_1',
  feature: 'checkout',
  repoPaths: ['/repo/shop'],
  status: 'waiting-for-approval',
  currentStage: 'scout',
  stages: [
    { key: 'similarity', status: 'done' },
    { key: 'scout', status: 'waiting-for-approval' },
    { key: 'scaffold', status: 'pending' },
  ],
  updatedAt: '2026-01-01T00:00:00Z',
  ...over,
})

describe('isExternalWorkPark', () => {
  it('is true only for a waiting flight parked on the external-work kind', () => {
    expect(isExternalWorkPark(entry({ checkpointKind: 'external-work' }))).toBe(true)
    expect(isExternalWorkPark(entry({ checkpointKind: 'missing-env' }))).toBe(false)
    // A question with no kind recorded (a pre-upgrade server) stays a question.
    expect(isExternalWorkPark(entry())).toBe(false)
  })

  it('is false for any status other than waiting-for-approval, and for no flight', () => {
    // The kind lingering on a resumed row must not make a running flight read
    // as a hand-off — the status is what says the stage is parked.
    expect(isExternalWorkPark(entry({ status: 'running', checkpointKind: 'external-work' }))).toBe(false)
    expect(isExternalWorkPark(null)).toBe(false)
    expect(isExternalWorkPark(undefined)).toBe(false)
  })
})

describe('externalWorkChipTitle', () => {
  it('capitalizes the stage verb into the chip tooltip', () => {
    expect(externalWorkChipTitle('scanning')).toBe('Scanning in your agent')
    expect(externalWorkChipTitle('running')).toBe('Running in your agent')
  })
})

describe('presentedIndexStages', () => {
  it('draws the parked stage as running for a hand-off', () => {
    const stages = presentedIndexStages(entry({ checkpointKind: 'external-work' }))
    expect(stages.find((s) => s.key === 'scout')?.status).toBe('running')
    // Nothing else moves.
    expect(stages.find((s) => s.key === 'similarity')?.status).toBe('done')
    expect(stages.find((s) => s.key === 'scaffold')?.status).toBe('pending')
  })

  it('leaves a real checkpoint — and a flight with no stages — alone', () => {
    expect(presentedIndexStages(entry({ checkpointKind: 'missing-env' }))
      .find((s) => s.key === 'scout')?.status).toBe('waiting-for-approval')
    expect(presentedIndexStages(entry({ checkpointKind: 'external-work', stages: undefined }))).toEqual([])
  })

  it('only maps the stage the flight is actually parked on', () => {
    // A stale `waiting-for-approval` on some other row is not this hand-off, so
    // it keeps its own status rather than being swept into "running".
    const stages = presentedIndexStages(entry({
      checkpointKind: 'external-work',
      currentStage: 'scaffold',
      stages: [
        { key: 'scout', status: 'waiting-for-approval' },
        { key: 'scaffold', status: 'waiting-for-approval' },
      ],
    }))
    expect(stages).toEqual([
      { key: 'scout', status: 'waiting-for-approval' },
      { key: 'scaffold', status: 'running' },
    ])
  })
})

describe('EXTERNAL_WORK_COPY', () => {
  it('never says "MCP" — the copy has to read for Claude and Codex alike', () => {
    const copy = JSON.stringify(EXTERNAL_WORK_COPY).toLowerCase()
    expect(copy).not.toContain('mcp')
    expect(copy).not.toContain('approval')
  })
})

describe('isExternallyDriven', () => {
  it('reads the producer off a manifest and off a slim index entry alike', () => {
    expect(isExternallyDriven({ status: 'running', opts: { stageProducer: 'external' } })).toBe(true)
    expect(isExternallyDriven(entry({ status: 'running', stageProducer: 'external' }))).toBe(true)
  })

  it('is true for every live status, false once the flight settles', () => {
    for (const status of ['running', 'waiting-for-approval', 'paused'] as const) {
      expect(isExternallyDriven(entry({ status, stageProducer: 'external' }))).toBe(true)
    }
    for (const status of ['done', 'failed', 'aborted'] as const) {
      expect(isExternallyDriven(entry({ status, stageProducer: 'external' }))).toBe(false)
    }
  })

  it('is false for an internal flight, an undeclared producer, and no flight', () => {
    expect(isExternallyDriven(entry({ stageProducer: 'internal' }))).toBe(false)
    expect(isExternallyDriven(entry())).toBe(false)
    expect(isExternallyDriven(null)).toBe(false)
    expect(isExternallyDriven(undefined)).toBe(false)
  })
})

describe('flightAwaitsUser', () => {
  it('is true only for a park that is a question aimed at this reader', () => {
    expect(flightAwaitsUser(entry({ checkpointKind: 'prd-source' }))).toBe(true)
  })

  // The two exclusions, and the reason the predicate is shared: a hand-off is
  // work in progress, and a flight the user's own agent drives answers its own
  // questions — including the real ones, which the narrower hand-off check let
  // through as "waiting for you".
  it('is false for a hand-off park and for any park on an externally driven flight', () => {
    expect(flightAwaitsUser(entry({ checkpointKind: 'external-work' }))).toBe(false)
    expect(flightAwaitsUser(entry({ checkpointKind: 'prd-source', stageProducer: 'external' }))).toBe(false)
  })

  it('is false for anything that is not parked at all', () => {
    expect(flightAwaitsUser(entry({ status: 'running' }))).toBe(false)
    expect(flightAwaitsUser(entry({ status: 'paused', pauseReason: 'stage-failed' }))).toBe(false)
    expect(flightAwaitsUser(null)).toBe(false)
  })
})

describe('externalMutationTooltip', () => {
  it('names the owner, action, and Claude/Codex destination for both ownership modes', () => {
    expect(externalMutationTooltip('flight', 'pause this work'))
      .toBe('Your agent is driving this flight — pause this work from the Claude/Codex session doing the work.')
    expect(externalMutationTooltip('suite', 'delete this suite'))
      .toBe('Your agent is working on this suite — delete this suite from the Claude/Codex session doing the work.')
  })
})
