import { describe, expect, it } from 'vitest'
import { flightIndexEntry } from './index-entry'
import type { FlightManifest } from './types'

function manifest(overrides: Partial<FlightManifest> = {}): FlightManifest {
  return {
    flightId: 'flight-checkout',
    feature: 'checkout',
    repoPaths: ['/workspace/shop'],
    description: 'Checkout flow',
    opts: { env: 'local', coverageTarget: 100 },
    status: 'running',
    currentStage: 'scout',
    stages: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T01:00:00Z',
    ...overrides,
  }
}

describe('flightIndexEntry', () => {
  it('preserves the complete index contract without changing the manifest', () => {
    const input = manifest({
      opts: { env: 'local', coverageTarget: 100, group: 'shop', stageProducer: 'external' },
      status: 'paused',
      pauseReason: 'user',
      endedAt: '2026-01-01T02:00:00Z',
      stages: [
        { key: 'scout', status: 'done', startedAt: '2026-01-01T00:00:00Z', evidence: { repos: 1 } },
        { key: 'docs', status: 'waiting-for-approval', checkpoint: { kind: 'external-work', message: 'Collect docs', options: ['submit'] } },
      ],
    })
    const original = structuredClone(input)
    expect(flightIndexEntry(input)).toStrictEqual({
      id: 'flight-checkout',
      createdAt: '2026-01-01T00:00:00Z',
      flightId: 'flight-checkout',
      feature: 'checkout',
      repoPaths: ['/workspace/shop'],
      group: 'shop',
      status: 'paused',
      pauseReason: 'user',
      checkpointKind: 'external-work',
      stageProducer: 'external',
      currentStage: 'scout',
      stages: [
        { key: 'scout', status: 'done', startedAt: '2026-01-01T00:00:00Z', hasEvidence: true },
        { key: 'docs', status: 'waiting-for-approval' },
      ],
      updatedAt: '2026-01-01T01:00:00Z',
      endedAt: '2026-01-01T02:00:00Z',
    })
    expect(input).toStrictEqual(original)
  })

  it('explicitly clears optional index properties on a shallow upsert', () => {
    const row = flightIndexEntry(manifest({ currentStage: null }))
    // An omitted property also reads as undefined, but cannot clear an old row.
    for (const key of ['group', 'pauseReason', 'checkpointKind', 'stageProducer', 'endedAt']) {
      expect(Object.hasOwn(row, key)).toBe(true)
      expect(row[key]).toBeUndefined()
      expect({ [key]: 'stale', ...row }[key]).toBeUndefined()
    }
    expect(row.currentStage).toBeNull()
    expect(row.stages).toEqual([])
  })

  it('takes the checkpoint only from the first waiting stage', () => {
    const stages: FlightManifest['stages'] = [
      { key: 'scout', status: 'done', checkpoint: { kind: 'external-work', message: 'Old checkpoint', options: [] } },
      { key: 'docs', status: 'waiting-for-approval' },
      { key: 'portify', status: 'waiting-for-approval', checkpoint: { kind: 'external-work', message: 'Later checkpoint', options: [] } },
    ]
    expect(flightIndexEntry(manifest({ stages })).checkpointKind).toBeUndefined()
  })

  it('preserves stage order and omits unmeasured evidence and empty timestamps', () => {
    const row = flightIndexEntry(manifest({ stages: [
      { key: 'run', status: 'done', evidence: { passed: 0 }, startedAt: '2026-01-01T01:00:00Z' },
      { key: 'scout', status: 'skipped', evidence: {}, startedAt: '' },
      { key: 'docs', status: 'pending', evidence: null },
      { key: 'heal', status: 'pending', evidence: 'not an evidence block' },
    ] }))
    expect(row.stages).toStrictEqual([
      { key: 'run', status: 'done', hasEvidence: true, startedAt: '2026-01-01T01:00:00Z' },
      { key: 'scout', status: 'skipped' },
      { key: 'docs', status: 'pending' },
      { key: 'heal', status: 'pending' },
    ])
  })
})
